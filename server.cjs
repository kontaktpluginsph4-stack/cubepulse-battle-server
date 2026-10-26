// CubePulse battle server (rooms of up to 20 players).
// No dependencies: only Node's built-in http module. Rooms live in memory, so
// they are cleared whenever the server restarts or goes to sleep.

const http = require("http");

const PORT = process.env.PORT || 3000;
const MAX_PLAYERS = 20;
// Every round (every new scramble) has this much time. Anyone who has not solved
// when it runs out is kicked from the room. (Set ROUND_TIME_MS on Render to change it.)
const ROUND_TIME_MS = Number(process.env.ROUND_TIME_MS) || 2 * 60_000;
// When every player has finished, the next scramble starts by itself after this short pause
// (so everyone can see the final times). Set NEXT_ROUND_DELAY_MS on Render to change it; 0 = instant.
const NEXT_ROUND_DELAY_MS = process.env.NEXT_ROUND_DELAY_MS !== undefined && process.env.NEXT_ROUND_DELAY_MS !== ""
  ? Math.max(0, Number(process.env.NEXT_ROUND_DELAY_MS) || 0)
  : 3000;
const KICK_MEMORY_MS = 10 * 60_000; // how long we remember a kick so the player can be told why
const PLAYER_TIMEOUT_MS = Number(process.env.PLAYER_TIMEOUT_MS) || 90_000; // no polling for 90s -> removed from the room. Short wifi drops / app switches stay in the room.
const OFFLINE_AFTER_MS = 8_000;          // no polling for 8s -> shown as RECONNECTING to the others (not removed yet)
const ROOM_TIMEOUT_MS = 30 * 60_000;   // idle rooms are deleted after 30 min
// Chat + emoji reactions
const CHAT_KEEP = 60;                 // last N chat messages kept per room
const CHAT_MAX_LEN = 200;             // max characters per message
const CHAT_GAP_MS = 400;              // min time between two messages from the same player (anti-spam)
const REACTION_EMOJIS = ["🔥", "😭", "👏"];
const REACTION_GAP_MS = 150;          // min time between two reactions from the same player
const REACTION_KEEP_MS = 10_000;      // reactions are short-lived: only the last 10s are kept
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I

const rooms = new Map();
const kickedPlayers = new Map(); // playerId -> expires at

// ---------- helpers ----------
function makeCode() {
  let code;
  do {
    code = Array.from({ length: 5 }, () => CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)]).join("");
  } while (rooms.has(code));
  return code;
}

function makeScramble(len = 20) {
  const faces = ["U", "D", "L", "R", "F", "B"];
  const axis = { U: 0, D: 0, L: 1, R: 1, F: 2, B: 2 };
  const mods = ["", "'", "2"];
  const out = [];
  while (out.length < len) {
    const f = faces[Math.floor(Math.random() * 6)];
    const last = out[out.length - 1];
    const prev = out[out.length - 2];
    if (last && last.f === f) continue;
    if (last && prev && axis[last.f] === axis[f] && axis[prev.f] === axis[f]) continue;
    out.push({ f, m: mods[Math.floor(Math.random() * 3)] });
  }
  return out.map((x) => x.f + x.m).join(" ");
}

function cleanName(n) {
  return String(n || "Player").trim().slice(0, 20) || "Player";
}

function newPlayer(id, username) {
  return { id, username: cleanName(username), inRound: false, status: "idle", timeMs: null, dnf: false, rawMs: null, penalty: "none", counted: false, lastMs: null, lastDnf: false, wins: 0, solves: [], lastSeen: Date.now(), lastChatAt: 0, lastReactAt: 0, streak: 0, prevStreak: 0 };
}

// opts.chatSince / opts.reactSince = the last chat / reaction id the client already has.
// Only newer items are sent (so polling stays tiny). Left out = nothing is sent for that part.
function publicRoom(room, opts = {}) {
  const now = Date.now();
  const chatSince = Number.isFinite(opts.chatSince) ? opts.chatSince : null;
  const reactSince = Number.isFinite(opts.reactSince) ? opts.reactSince : null;
  return {
    id: room.id,
    hostId: room.hostId,
    maxPlayers: MAX_PLAYERS,
    phase: room.phase,
    round: room.round,
    scramble: room.scramble,
    roundWinnerId: room.roundWinnerId,
    roundEndsAt: room.roundEndsAt,   // epoch ms, null when no round is running
    nextRoundAt: room.nextRoundAt,   // epoch ms of the automatic next scramble, null if the host has to start it
    roundMs: ROUND_TIME_MS,
    serverNow: now,                  // lets the app line its countdown up with the server clock
    chatSeq: room.chatSeq,           // id of the newest chat message / reaction (0 = none yet)
    reactSeq: room.reactSeq,
    chat: chatSince === null ? [] : room.chat.filter((m) => m.id > chatSince),
    reactions: reactSince === null ? [] : room.reactions.filter((x) => x.id > reactSince && now - x.at < REACTION_KEEP_MS),
    players: room.players.map(({ lastSeen, solves, counted, lastChatAt, lastReactAt, prevStreak, ...p }) => ({
      ...p,
      offline: now - lastSeen > OFFLINE_AFTER_MS,
      solveCount: solves.length,
      avgMs: solves.length ? Math.round(solves.reduce((a, b) => a + b, 0) / solves.length) : null,
    })),
  };
}

// auto = true: the next scramble starts by itself after NEXT_ROUND_DELAY_MS.
// auto = false (host pressed END ROUND): wait for the host to press NEXT ROUND.
function finishRound(room, auto = true) {
  room.phase = "results";
  room.roundEndsAt = null;
  room.nextRoundAt = auto ? Date.now() + NEXT_ROUND_DELAY_MS : null;
  for (const p of room.players) if (p.inRound && p.timeMs == null) { p.dnf = true; p.lastMs = null; p.lastDnf = true; }
  awardWinner(room);
}

// Gives the round win to the fastest valid time. Safe to call again when a penalty changes the result.
function awardWinner(room) {
  if (room.roundWinnerId) {
    const prev = room.players.find((p) => p.id === room.roundWinnerId);
    if (prev && prev.wins > 0) prev.wins -= 1;
  }
  const solved = room.players.filter((p) => p.timeMs != null).sort((a, b) => a.timeMs - b.timeMs);
  if (solved[0]) {
    solved[0].wins += 1;
    room.roundWinnerId = solved[0].id;
  } else {
    room.roundWinnerId = null;
  }
  // Win streak = rounds won in a row. Everyone who played this round and did not win goes back to 0.
  // prevStreak is the streak from before this round, so changing a penalty (re-awarding) never counts twice.
  for (const p of room.players) if (p.inRound) p.streak = p.id === room.roundWinnerId ? p.prevStreak + 1 : 0;
}

function startRound(room) {
  room.round += 1;
  room.phase = "round";
  room.scramble = makeScramble();
  room.roundWinnerId = null;
  room.roundEndsAt = null; // no round time limit anymore: nobody is kicked for being slow
  room.nextRoundAt = null;
  // Everyone starts as "idle" (shown as STAY) until they hold the timer (INSPECTING) or start solving (SOLVING).
  for (const p of room.players) { p.prevStreak = p.streak; p.inRound = true; p.status = "idle"; p.timeMs = null; p.dnf = false; p.rawMs = null; p.penalty = "none"; p.counted = false; }
}

// Everyone finished and the short pause is over: new scramble, same room.
function advanceRound(room) {
  if (room.phase !== "results" || !room.nextRoundAt || Date.now() < room.nextRoundAt) return;
  if (room.players.length === 0) return;
  startRound(room);
}

function checkAllDone(room) {
  if (room.phase !== "round") return;
  const active = room.players.filter((p) => p.inRound);
  if (active.length > 0 && active.every((p) => p.timeMs != null || p.dnf)) finishRound(room);
}

function removePlayer(room, playerId) {
  room.players = room.players.filter((p) => p.id !== playerId);
  if (room.players.length === 0) { rooms.delete(room.id); return; }
  if (room.hostId === playerId) room.hostId = room.players[0].id; // pass host to the next player
  checkAllDone(room);
}

// The 2-minute "kick if you do nothing" rule was removed on purpose.
// Players who disconnect are still removed by pruneRoom (no polling for PLAYER_TIMEOUT_MS),
// and the host can always press END ROUND.
function expireRound(_room) {}

function pruneRoom(room) {
  const now = Date.now();
  for (const p of [...room.players]) {
    if (now - p.lastSeen > PLAYER_TIMEOUT_MS) removePlayer(room, p.id);
  }
}

class HttpError extends Error {
  constructor(status, message, code) { super(message); this.status = status; this.code = code; }
}

function throwIfKicked(playerId) {
  const until = kickedPlayers.get(playerId);
  if (until && until > Date.now()) {
    throw new HttpError(403, "You were removed from the room: you did not finish the solve within 2 minutes.", "KICKED_TIMEOUT");
  }
}

function getRoom(source) {
  const id = String(source.roomId || "").toUpperCase();
  const room = rooms.get(id);
  if (room) expireRound(room); // enforce the time limit on every request
  if (room && rooms.has(id)) advanceRound(room);
  if (!room || !rooms.has(id)) {
    throwIfKicked(source.playerId);
    throw new HttpError(404, "Room not found.");
  }
  room.lastActive = Date.now();
  return room;
}

function getMember(source) {
  const room = getRoom(source);
  const player = room.players.find((p) => p.id === source.playerId);
  if (!player) {
    throwIfKicked(source.playerId);
    throw new HttpError(403, "You are not in this room.");
  }
  player.lastSeen = Date.now();
  return { room, player };
}

// ---------- routes ----------
const routes = {
  "POST /api/rooms/create": (body) => {
    if (!body.playerId) throw new HttpError(400, "playerId is required.");
    kickedPlayers.delete(body.playerId);
    const room = {
      id: makeCode(),
      hostId: body.playerId,
      phase: "lobby",
      round: 0,
      scramble: null,
      roundWinnerId: null,
      roundEndsAt: null,
      nextRoundAt: null,
      players: [newPlayer(body.playerId, body.username)],
      chat: [], chatSeq: 0,
      reactions: [], reactSeq: 0,
      lastActive: Date.now(),
    };
    rooms.set(room.id, room);
    return publicRoom(room, { chatSince: 0 });
  },

  "POST /api/rooms/join": (body) => {
    if (!body.playerId) throw new HttpError(400, "playerId is required.");
    kickedPlayers.delete(body.playerId);
    const room = getRoom(body);
    pruneRoom(room);
    if (!rooms.has(room.id)) throw new HttpError(404, "Room not found.");

    const existing = room.players.find((p) => p.id === body.playerId);
    if (existing) {
      existing.lastSeen = Date.now();
      existing.username = cleanName(body.username);
      return publicRoom(room, { chatSince: Number(body.chatSince) || 0, reactSince: Number(body.reactSince) || room.reactSeq });
    }
    if (room.players.length >= MAX_PLAYERS) throw new HttpError(409, `Room is full (${MAX_PLAYERS}/${MAX_PLAYERS}).`);
    room.players.push(newPlayer(body.playerId, body.username)); // joins mid-round -> spectates until next round
    return publicRoom(room, { chatSince: 0 }); // a new player gets the recent chat history
  },

  "GET /api/rooms/state": (_body, query) => {
    const { room } = getMember(query);
    pruneRoom(room);
    if (!rooms.has(room.id)) throw new HttpError(404, "Room not found.");
    // chatSince / reactSince are optional: old app versions that do not send them just get no chat / reactions.
    return publicRoom(room, {
      chatSince: query.chatSince !== undefined ? Number(query.chatSince) : undefined,
      reactSince: query.reactSince !== undefined ? Number(query.reactSince) : undefined,
    });
  },

  "POST /api/rooms/start": (body) => {
    const { room } = getMember(body);
    if (room.hostId !== body.playerId) throw new HttpError(403, "Only the host can start a round.");
    if (room.phase === "round") throw new HttpError(409, "A round is already running.");
    startRound(room);
    return publicRoom(room);
  },

  // A player tells the room they started solving (the timer is running).
  "POST /api/rooms/status": (body) => {
    const { room, player } = getMember(body);
    if (room.phase !== "round" || !player.inRound || player.timeMs != null || player.dnf) return publicRoom(room);
    // idle = doing nothing (STAY), inspecting = holding the timer, solving = timer running
    if (body.state === "solving" || body.state === "inspecting" || body.state === "idle") {
      // Never go back from "solving" to inspecting / idle by a late request.
      if (player.status === "solving" && body.state !== "solving") return publicRoom(room);
      player.status = body.state;
    }
    return publicRoom(room);
  },

  "POST /api/rooms/submit": (body) => {
    const { room, player } = getMember(body);
    if (room.phase !== "round") throw new HttpError(409, "No round is running.");
    if (!player.inRound) throw new HttpError(409, "You are spectating this round.");
    if (player.timeMs != null || player.dnf) throw new HttpError(409, "Time already submitted.");
    const ms = Math.round(Number(body.timeMs));
    if (!Number.isFinite(ms) || ms < 1 || ms > 60 * 60_000) throw new HttpError(400, "Invalid time.");
    player.timeMs = ms;
    player.rawMs = ms;       // the time on the timer, before any +2
    player.penalty = "none";
    player.lastMs = ms;      // shown above "STAY" in the players panel during the next round
    player.lastDnf = false;
    player.status = "done";
    player.solves.push(ms);
    player.counted = true;
    checkAllDone(room);
    return publicRoom(room);
  },

  // +2 / DNF on your own solve of the current round. penalty: "+2" | "dnf" | "none" (tapping it again removes it).
  "POST /api/rooms/penalty": (body) => {
    const { room, player } = getMember(body);
    if (room.phase !== "round" && room.phase !== "results") throw new HttpError(409, "No solve to change.");
    if (!player.inRound || player.rawMs == null) throw new HttpError(409, "No solve to change.");
    const pen = body.penalty === "+2" || body.penalty === "dnf" ? body.penalty : "none";
    if (player.counted) { player.solves.pop(); player.counted = false; } // the average uses the corrected time
    player.penalty = pen;
    if (pen === "dnf") {
      player.timeMs = null;
      player.dnf = true;
      player.lastMs = null;
      player.lastDnf = true;
    } else {
      const ms = player.rawMs + (pen === "+2" ? 2000 : 0);
      player.timeMs = ms;
      player.dnf = false;
      player.lastMs = ms;
      player.lastDnf = false;
      player.solves.push(ms);
      player.counted = true;
    }
    player.status = "done";
    if (room.phase === "results") awardWinner(room); else checkAllDone(room);
    return publicRoom(room);
  },

  "POST /api/rooms/end": (body) => {
    const { room } = getMember(body);
    if (room.hostId !== body.playerId) throw new HttpError(403, "Only the host can end the round.");
    if (room.phase === "round") finishRound(room, false); // host ended it: the host starts the next one
    return publicRoom(room);
  },

  // Emoji reaction: flies over the row of `targetId` on everyone's screen.
  "POST /api/rooms/react": (body) => {
    const { room, player } = getMember(body);
    const view = () => publicRoom(room, { chatSince: Number(body.chatSince), reactSince: Number(body.reactSince) });
    if (!REACTION_EMOJIS.includes(body.emoji)) throw new HttpError(400, "Invalid emoji.");
    if (!room.players.some((p) => p.id === body.targetId)) throw new HttpError(404, "That player is not in the room.");
    const now = Date.now();
    if (now - player.lastReactAt < REACTION_GAP_MS) return view(); // too fast: silently ignored
    player.lastReactAt = now;
    room.reactions.push({ id: ++room.reactSeq, fromId: player.id, targetId: body.targetId, emoji: body.emoji, at: now });
    room.reactions = room.reactions.filter((x) => now - x.at < REACTION_KEEP_MS).slice(-100);
    return view();
  },

  // Chat message (text only, max 200 chars, last 60 kept).
  "POST /api/rooms/chat": (body) => {
    const { room, player } = getMember(body);
    const view = () => publicRoom(room, { chatSince: Number(body.chatSince), reactSince: Number(body.reactSince) });
    const text = String(body.text ?? "").replace(/[\u0000-\u001F\u007F]+/g, " ").replace(/\s+/g, " ").trim().slice(0, CHAT_MAX_LEN);
    if (!text) return view();
    const now = Date.now();
    if (now - player.lastChatAt < CHAT_GAP_MS) return view(); // too fast: silently ignored
    player.lastChatAt = now;
    room.chat.push({ id: ++room.chatSeq, playerId: player.id, username: player.username, text, at: now });
    if (room.chat.length > CHAT_KEEP) room.chat = room.chat.slice(-CHAT_KEEP);
    return view();
  },

  "POST /api/rooms/leave": (body) => {
    const room = rooms.get(String(body.roomId || "").toUpperCase());
    if (room) removePlayer(room, body.playerId);
    return { ok: true };
  },

  "GET /": () => ({ ok: true, service: "cubepulse-battle-server", rooms: rooms.size, features: ["chat", "reactions", "streak"] }),
  "GET /health": () => ({ ok: true }),
};

// ---------- http server ----------
function send(res, status, data) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  });
  res.end(JSON.stringify(data));
}

const server = http.createServer((req, res) => {
  if (req.method === "OPTIONS") return send(res, 204, {});

  const url = new URL(req.url, "http://localhost");
  const handler = routes[`${req.method} ${url.pathname}`];
  if (!handler) return send(res, 404, { error: "Not found." });

  let raw = "";
  req.on("data", (chunk) => {
    raw += chunk;
    if (raw.length > 100_000) req.destroy(); // tiny bodies only
  });
  req.on("end", () => {
    try {
      const body = raw ? JSON.parse(raw) : {};
      const query = Object.fromEntries(url.searchParams);
      send(res, 200, handler(body, query));
    } catch (e) {
      if (e instanceof HttpError) return send(res, e.status, { error: e.message, code: e.code });
      if (e instanceof SyntaxError) return send(res, 400, { error: "Invalid JSON." });
      console.error(e);
      send(res, 500, { error: "Server error." });
    }
  });
});

// enforce the round time limit every second
setInterval(() => {
  for (const room of [...rooms.values()]) {
    expireRound(room);
    if (rooms.has(room.id)) advanceRound(room);
  }
}, 1000).unref();

// clean up dead players / rooms
setInterval(() => {
  const now = Date.now();
  for (const room of [...rooms.values()]) {
    pruneRoom(room);
    if (rooms.has(room.id) && now - room.lastActive > ROOM_TIMEOUT_MS) rooms.delete(room.id);
  }
  for (const [id, until] of kickedPlayers) if (until < now) kickedPlayers.delete(id);
}, 10_000).unref();

server.listen(PORT, () => console.log(`CubePulse battle server listening on ${PORT}`));