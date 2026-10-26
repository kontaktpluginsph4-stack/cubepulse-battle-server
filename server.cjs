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
const JOIN_REQUEST_TTL_MS = 20_000;  // a join request disappears if the player stops waiting (no status polling)
const DECLINE_MEMORY_MS = 15_000;    // how long a decline is remembered so the player can be told
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

// Every round scramble is a TNoodle-style random-state scramble (see the TNOODLE section at the bottom of this file).
function makeScramble() {
  return tnScramble();
}

function cleanName(n) {
  return String(n || "Player").trim().slice(0, 20) || "Player";
}

function newPlayer(id, username) {
  return { id, username: cleanName(username), inRound: false, status: "idle", timeMs: null, dnf: false, rawMs: null, penalty: "none", counted: false, lastMs: null, lastDnf: false, wins: 0, solves: [], lastSeen: Date.now(), lastChatAt: 0, lastReactAt: 0, streak: 0, prevStreak: 0 };
}

// Join answers: { pending: true } means "still waiting for the host". The full room view also has a
// "pending" LIST (the host's join requests), which older app builds mistake for "still waiting".
// A joiner who is already in is never the one answering requests here, so drop the list from these answers.
function joinedView(room, playerId, opts) {
  const view = publicRoom(room, opts);
  if (room.hostId !== playerId) delete view.pending;
  return view;
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
    pending: (room.pending || []).map(({ id, username }) => ({ id, username })), // join requests waiting for the host
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
  if (room.pending) room.pending = room.pending.filter((q) => now - q.lastSeen < JOIN_REQUEST_TTL_MS);
  if (room.declined) for (const [id, until] of room.declined) if (until < now) room.declined.delete(id);
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

// Host kicks are remembered per room, so a kicked player cannot simply rejoin.
function wasKickedFromRoom(room, playerId) {
  if (!room.kicked) return false;
  const until = room.kicked.get(playerId);
  if (!until) return false;
  if (until < Date.now()) { room.kicked.delete(playerId); return false; }
  return true;
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
    if (wasKickedFromRoom(room, source.playerId)) throw new HttpError(403, "The host removed you from the room.", "KICKED");
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
      approved: new Set([body.playerId]), // everyone who was let in once can come back after a wifi drop without asking again
      pending: [],                         // join requests waiting for the host
      declined: new Map(),
      kicked: new Map(),
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

    if (wasKickedFromRoom(room, body.playerId)) throw new HttpError(403, "The host removed you from this room.", "KICKED");
    const existing = room.players.find((p) => p.id === body.playerId);
    if (existing) {
      existing.lastSeen = Date.now();
      existing.username = cleanName(body.username);
      return joinedView(room, body.playerId, { chatSince: Number(body.chatSince) || 0, reactSince: Number(body.reactSince) || room.reactSeq });
    }
    if (room.players.length >= MAX_PLAYERS) throw new HttpError(409, `Room is full (${MAX_PLAYERS}/${MAX_PLAYERS}).`);

    // New people must be approved by the host first (people who were already let in once come straight back).
    if (!room.approved.has(body.playerId)) {
      room.declined.delete(body.playerId); // asking again after a decline is allowed
      const name = cleanName(body.username);
      const q = room.pending.find((x) => x.id === body.playerId);
      if (q) { q.lastSeen = Date.now(); q.username = name; }
      else room.pending.push({ id: body.playerId, username: name, lastSeen: Date.now() });
      return { pending: true, roomId: room.id };
    }
    room.players.push(newPlayer(body.playerId, body.username)); // joins mid-round -> spectates until next round
    return joinedView(room, body.playerId, { chatSince: 0 }); // a new player gets the recent chat history
  },

  // The player who asked to join polls this: still waiting / approved (full room) / declined (403 DECLINED).
  "GET /api/rooms/join-status": (_body, query) => {
    const room = getRoom(query);
    pruneRoom(room);
    if (!rooms.has(room.id)) throw new HttpError(404, "Room not found.");
    if (wasKickedFromRoom(room, query.playerId)) throw new HttpError(403, "The host removed you from this room.", "KICKED");
    if (room.players.some((p) => p.id === query.playerId)) {
      const me = room.players.find((p) => p.id === query.playerId);
      me.lastSeen = Date.now();
      return joinedView(room, query.playerId, { chatSince: 0 });
    }
    const q = room.pending.find((x) => x.id === query.playerId);
    if (q) { q.lastSeen = Date.now(); return { pending: true, roomId: room.id }; }
    if (room.declined.has(query.playerId)) throw new HttpError(403, "The host declined your request to join.", "DECLINED");
    throw new HttpError(404, "Your request expired. Try joining again.", "EXPIRED");
  },

  // Host only: approve or decline a join request.
  "POST /api/rooms/respond": (body) => {
    const { room } = getMember(body);
    if (room.hostId !== body.playerId) throw new HttpError(403, "Only the host can answer join requests.");
    const view = () => publicRoom(room, { chatSince: Number(body.chatSince) || 0, reactSince: Number(body.reactSince) || room.reactSeq });
    const q = room.pending.find((x) => x.id === body.targetId);
    if (!q) return view(); // already answered or expired
    room.pending = room.pending.filter((x) => x.id !== body.targetId);
    if (body.approve) {
      if (room.players.length >= MAX_PLAYERS) throw new HttpError(409, `Room is full (${MAX_PLAYERS}/${MAX_PLAYERS}).`);
      room.approved.add(q.id);
      room.players.push(newPlayer(q.id, q.username)); // joins mid-round -> spectates until next round
    } else {
      room.declined.set(q.id, Date.now() + DECLINE_MEMORY_MS);
    }
    return view();
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

  // Host only: removes a player. That player gets 403 with code "KICKED" on their next poll.
  "POST /api/rooms/kick": (body) => {
    const { room } = getMember(body);
    if (room.hostId !== body.playerId) throw new HttpError(403, "Only the host can kick players.");
    if (!body.targetId || body.targetId === body.playerId) throw new HttpError(400, "You cannot kick yourself.");
    if (!room.players.some((p) => p.id === body.targetId)) throw new HttpError(404, "That player is not in the room.");
    if (!room.kicked) room.kicked = new Map();
    room.kicked.set(body.targetId, Date.now() + KICK_MEMORY_MS);
    removePlayer(room, body.targetId);
    return publicRoom(room, { chatSince: Number(body.chatSince) || 0, reactSince: Number(body.reactSince) || room.reactSeq });
  },

  "POST /api/rooms/leave": (body) => {
    const room = rooms.get(String(body.roomId || "").toUpperCase());
    if (room) removePlayer(room, body.playerId);
    return { ok: true };
  },

  "GET /": () => ({ ok: true, service: "cubepulse-battle-server", rooms: rooms.size, features: ["chat", "reactions", "streak", "tnoodle"] }),
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

server.listen(PORT, () => {
  console.log(`CubePulse battle server listening on ${PORT}`);
  // Build the scramble tables in the background (about a second). Until they are ready, rounds use random-move scrambles.
  tnPrepare(() => console.log("TNoodle-style scrambler ready"));
});

// =====================================================================================================
// ---------------------------------------------------------------------------
// TNOODLE-STYLE 3x3 SCRAMBLER
// Same idea as WCA's TNoodle: pick a UNIFORMLY RANDOM cube state, solve it with
// Kociemba's two-phase algorithm and use the inverse of the solution as the
// scramble (so every scramble is ~19-21 moves and every state is equally likely).
// The lookup tables are built once in small slices (tnPrepare), so the app never
// freezes. Until they are ready, tnScramble() falls back to a random-move scramble.
// ---------------------------------------------------------------------------
var TN_FACES = "URFDLB";
var TN_URF = 0, TN_UFL = 1, TN_ULB = 2, TN_UBR = 3, TN_DFR = 4, TN_DLF = 5, TN_DBL = 6, TN_DRB = 7;
var TN_UR = 0, TN_UF = 1, TN_UL = 2, TN_UB = 3, TN_DR = 4, TN_DF = 5, TN_DL = 6, TN_DB = 7, TN_FR = 8, TN_FL = 9, TN_BL = 10, TN_BR = 11;
var TN_Z12 = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
var TN_Z8 = [0, 0, 0, 0, 0, 0, 0, 0];

// the six basic clockwise face turns, order U R F D L B
var TN_BASE = [
  { cp: [TN_UBR, TN_URF, TN_UFL, TN_ULB, TN_DFR, TN_DLF, TN_DBL, TN_DRB], co: TN_Z8,
    ep: [TN_UB, TN_UR, TN_UF, TN_UL, TN_DR, TN_DF, TN_DL, TN_DB, TN_FR, TN_FL, TN_BL, TN_BR], eo: TN_Z12 },
  { cp: [TN_DFR, TN_UFL, TN_ULB, TN_URF, TN_DRB, TN_DLF, TN_DBL, TN_UBR], co: [2, 0, 0, 1, 1, 0, 0, 2],
    ep: [TN_FR, TN_UF, TN_UL, TN_UB, TN_BR, TN_DF, TN_DL, TN_DB, TN_DR, TN_FL, TN_BL, TN_UR], eo: TN_Z12 },
  { cp: [TN_UFL, TN_DLF, TN_ULB, TN_UBR, TN_URF, TN_DFR, TN_DBL, TN_DRB], co: [1, 2, 0, 0, 2, 1, 0, 0],
    ep: [TN_UR, TN_FL, TN_UL, TN_UB, TN_DR, TN_FR, TN_DL, TN_DB, TN_UF, TN_DF, TN_BL, TN_BR], eo: [0, 1, 0, 0, 0, 1, 0, 0, 1, 1, 0, 0] },
  { cp: [TN_URF, TN_UFL, TN_ULB, TN_UBR, TN_DLF, TN_DBL, TN_DRB, TN_DFR], co: TN_Z8,
    ep: [TN_UR, TN_UF, TN_UL, TN_UB, TN_DF, TN_DL, TN_DB, TN_DR, TN_FR, TN_FL, TN_BL, TN_BR], eo: TN_Z12 },
  { cp: [TN_URF, TN_ULB, TN_DBL, TN_UBR, TN_DFR, TN_UFL, TN_DLF, TN_DRB], co: [0, 1, 2, 0, 0, 2, 1, 0],
    ep: [TN_UR, TN_UF, TN_BL, TN_UB, TN_DR, TN_DF, TN_FL, TN_DB, TN_FR, TN_UL, TN_DL, TN_BR], eo: TN_Z12 },
  { cp: [TN_URF, TN_UFL, TN_UBR, TN_DRB, TN_DFR, TN_DLF, TN_ULB, TN_DBL], co: [0, 0, 1, 2, 0, 0, 2, 1],
    ep: [TN_UR, TN_UF, TN_UL, TN_BR, TN_DR, TN_DF, TN_DL, TN_BL, TN_FR, TN_FL, TN_UB, TN_DB], eo: [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 1, 1] },
];

function tnNewCube() {
  return { cp: [0, 1, 2, 3, 4, 5, 6, 7], co: [0, 0, 0, 0, 0, 0, 0, 0], ep: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], eo: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0] };
}
// out = a, then b   (out must not be a or b)
function tnMul(a, b, out) {
  for (var c = 0; c < 8; c++) {
    var bc = b.cp[c];
    out.cp[c] = a.cp[bc];
    out.co[c] = (a.co[bc] + b.co[c]) % 3;
  }
  for (var e = 0; e < 12; e++) {
    var be = b.ep[e];
    out.ep[e] = a.ep[be];
    out.eo[e] = (a.eo[be] + b.eo[e]) & 1;
  }
}
function tnCopy(a, out) {
  for (var i = 0; i < 8; i++) { out.cp[i] = a.cp[i]; out.co[i] = a.co[i]; }
  for (var j = 0; j < 12; j++) { out.ep[j] = a.ep[j]; out.eo[j] = a.eo[j]; }
}

// 18 moves: index = face * 3 + k   (k: 0 = X, 1 = X2, 2 = X')
var TN_MOVE = [];
(function () {
  for (var f = 0; f < 6; f++) {
    var cur = TN_BASE[f];
    for (var k = 0; k < 3; k++) {
      TN_MOVE.push(cur);
      var nxt = tnNewCube();
      tnMul(cur, TN_BASE[f], nxt);
      cur = nxt;
    }
  }
})();
// phase 2 only turns U, D freely and R, L, F, B by half turns
var TN_P2 = [0, 1, 2, 9, 10, 11, 4, 13, 7, 16]; // U U2 U-prime, D D2 D-prime, R2 L2 F2 B2
var TN_IS_P2 = (function () { var a = []; for (var i = 0; i < 18; i++) a.push(false); for (var j = 0; j < TN_P2.length; j++) a[TN_P2[j]] = true; return a; })();

// ---- coordinates ----
function tnRank(a, n, off) {
  var r = 0;
  for (var i = 0; i < n - 1; i++) {
    var c = 0;
    for (var j = i + 1; j < n; j++) if (a[off + j] < a[off + i]) c++;
    r = r * (n - i) + c;
  }
  return r;
}
function tnUnrank(r, n, out, off, add) {
  var c = [];
  for (var i = n - 2; i >= 0; i--) { var base = n - i; c[i] = r % base; r = (r / base) | 0; }
  var avail = [];
  for (var k = 0; k < n; k++) avail.push(k);
  for (var m = 0; m < n - 1; m++) out[off + m] = avail.splice(c[m], 1)[0] + add;
  out[off + n - 1] = avail[0] + add;
}
var TN_SLICE_N = 495;
var TN_SLICE_SETS = []; // slice index -> the 4 positions the slice edges sit in
var TN_MASK_TO_SLICE = new Int16Array(4096).fill(-1);
(function () {
  // the solved set (positions 8..11) is index 0
  TN_SLICE_SETS.push([8, 9, 10, 11]);
  TN_MASK_TO_SLICE[0xF00] = 0;
  for (var a = 0; a < 12; a++) for (var b = a + 1; b < 12; b++) for (var c = b + 1; c < 12; c++) for (var d = c + 1; d < 12; d++) {
    var mask = (1 << a) | (1 << b) | (1 << c) | (1 << d);
    if (mask === 0xF00) continue;
    TN_MASK_TO_SLICE[mask] = TN_SLICE_SETS.length;
    TN_SLICE_SETS.push([a, b, c, d]);
  }
})();
function tnGetTwist(c) { var t = 0; for (var i = 0; i < 7; i++) t = t * 3 + c.co[i]; return t; }
function tnGetFlip(c) { var f = 0; for (var i = 0; i < 11; i++) f = f * 2 + c.eo[i]; return f; }
function tnGetSlice(c) { var m = 0; for (var i = 0; i < 12; i++) if (c.ep[i] >= 8) m |= 1 << i; return TN_MASK_TO_SLICE[m]; }
function tnSetTwist(c, t) { var s = 0; for (var i = 6; i >= 0; i--) { c.co[i] = t % 3; s += c.co[i]; t = (t / 3) | 0; } c.co[7] = (3 - (s % 3)) % 3; }
function tnSetFlip(c, f) { var s = 0; for (var i = 10; i >= 0; i--) { c.eo[i] = f & 1; s += c.eo[i]; f >>= 1; } c.eo[11] = s & 1; }
function tnSetSlice(c, idx) {
  var set = TN_SLICE_SETS[idx], inSet = [], i, nextSlice = 8, nextOther = 0;
  for (i = 0; i < 12; i++) inSet.push(false);
  for (i = 0; i < 4; i++) inSet[set[i]] = true;
  for (i = 0; i < 12; i++) c.ep[i] = inSet[i] ? nextSlice++ : nextOther++;
}

// ---- tables (built in slices by tnPrepare) ----
var TN_READY = false;
var TN_STARTED = false;
var tnTwistMove, tnFlipMove, tnSliceMove, tnCpMove, tnEpMove, tnSpMove;
var tnPruneTS, tnPruneFS, tnPruneCS, tnPruneES;

function tnMoveTable(n, moveList, setter, getter) {
  var table = new Uint16Array(n * 18);
  var base = tnNewCube(), out = tnNewCube();
  for (var i = 0; i < n; i++) {
    base = tnNewCube();
    setter(base, i);
    for (var mi = 0; mi < moveList.length; mi++) {
      var m = moveList[mi];
      tnMul(base, TN_MOVE[m], out);
      table[i * 18 + m] = getter(out);
    }
  }
  return table;
}
var TN_ALL = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17];

// breadth-first pruning table over (coordA, coordB), one depth level per call; true when finished
function tnPruneJob(sizeA, sizeB, moveA, moveB, moves, assign) {
  var total = sizeA * sizeB;
  var table = new Uint8Array(total).fill(255);
  table[0] = 0;
  var filled = 1, depth = 0;
  assign(table);
  return function () {
    var nm = moves.length;
    for (var idx = 0; idx < total; idx++) {
      if (table[idx] !== depth) continue;
      var a = (idx / sizeB) | 0, b = idx - a * sizeB;
      for (var mi = 0; mi < nm; mi++) {
        var m = moves[mi];
        var ni = moveA[a * 18 + m] * sizeB + moveB[b * 18 + m];
        if (table[ni] === 255) { table[ni] = depth + 1; filled++; }
      }
    }
    depth++;
    return filled >= total;
  };
}

function tnBuildJobs() {
  var jobs = [];
  var P2 = TN_P2;
  jobs.push(function () { tnTwistMove = tnMoveTable(2187, TN_ALL, tnSetTwist, tnGetTwist); return true; });
  jobs.push(function () { tnFlipMove = tnMoveTable(2048, TN_ALL, tnSetFlip, tnGetFlip); return true; });
  jobs.push(function () { tnSliceMove = tnMoveTable(TN_SLICE_N, TN_ALL, tnSetSlice, tnGetSlice); return true; });
  jobs.push(function () {
    tnCpMove = tnMoveTable(40320, P2, function (c, r) { tnUnrank(r, 8, c.cp, 0, 0); }, function (c) { return tnRank(c.cp, 8, 0); });
    return true;
  });
  jobs.push(function () {
    tnEpMove = tnMoveTable(40320, P2, function (c, r) { tnUnrank(r, 8, c.ep, 0, 0); }, function (c) { return tnRank(c.ep, 8, 0); });
    return true;
  });
  jobs.push(function () {
    tnSpMove = tnMoveTable(24, P2, function (c, r) { tnUnrank(r, 4, c.ep, 8, 8); }, function (c) { return tnRank(c.ep, 4, 8); });
    return true;
  });
  var made = {};
  function lazyJob(key, make) {
    jobs.push(function () {
      if (!made[key]) made[key] = make();
      return made[key]();
    });
  }
  // phase 1: (twist, slice) and (flip, slice).  Goal = (0, slice 0).
  lazyJob("ts", function () { return tnPruneJob(2187, TN_SLICE_N, tnTwistMove, tnSliceMove, TN_ALL, function (t) { tnPruneTS = t; }); });
  lazyJob("fs", function () { return tnPruneJob(2048, TN_SLICE_N, tnFlipMove, tnSliceMove, TN_ALL, function (t) { tnPruneFS = t; }); });
  // phase 2: (corner perm, slice perm) and (UD edge perm, slice perm).  Goal = (0, 0).
  lazyJob("cs", function () { return tnPruneJob(40320, 24, tnCpMove, tnSpMove, P2, function (t) { tnPruneCS = t; }); });
  lazyJob("es", function () { return tnPruneJob(40320, 24, tnEpMove, tnSpMove, P2, function (t) { tnPruneES = t; }); });
  return jobs;
}

var tnJobs = null;
function tnStep() {
  if (TN_READY) return true;
  if (!tnJobs) tnJobs = tnBuildJobs();
  if (tnJobs[0]()) tnJobs.shift();
  if (tnJobs.length === 0) { TN_READY = true; return true; }
  return false;
}
// Build every table right now (server start-up, tests).
function tnPrepareSync() { while (!tnStep()) { /* keep going */ } }
// Build the tables in small slices so the UI never freezes. onReady is optional.
function tnPrepare(onReady) {
  if (TN_READY) { if (onReady) onReady(); return; }
  if (TN_STARTED) { if (onReady) tnWaiters.push(onReady); return; }
  TN_STARTED = true;
  if (onReady) tnWaiters.push(onReady);
  var tick = function () {
    var t0 = Date.now(), done = false;
    while (!done && Date.now() - t0 < 12) done = tnStep();
    if (done) { tnPrefill(3); var w = tnWaiters; tnWaiters = []; for (var i = 0; i < w.length; i++) { try { w[i](); } catch (e) { /* ignore */ } } }
    else setTimeout(tick, 0);
  };
  setTimeout(tick, 0);
}
var tnWaiters = [];
function tnIsReady() { return TN_READY; }

// ---- the solver ----
function tnSolve(cube, maxTotal, targetLen, budgetMs, nodeCap) {
  var t0 = tnGetTwist(cube), f0 = tnGetFlip(cube), s0 = tnGetSlice(cube);
  var path = new Int8Array(48), path2 = new Int8Array(48);
  var best = null, aborted = false, nodes = 0;
  var deadline = Date.now() + budgetMs;
  var scratchA = tnNewCube(), scratchB = tnNewCube();

  function p2(c, e, s, rem, lastFace, depth) {
    if (rem === 0) return c === 0 && e === 0 && s === 0;
    var h = tnPruneCS[c * 24 + s], h2 = tnPruneES[e * 24 + s];
    if (h2 > h) h = h2;
    if (h > rem) return false;
    for (var i = 0; i < 10; i++) {
      var m = TN_P2[i], face = (m / 3) | 0;
      if (lastFace >= 0 && (face === lastFace || (face % 3 === lastFace % 3 && face < lastFace))) continue;
      path2[depth] = m;
      if (p2(tnCpMove[c * 18 + m], tnEpMove[e * 18 + m], tnSpMove[s * 18 + m], rem - 1, face, depth + 1)) return true;
    }
    return false;
  }

  function tryP2(d1) {
    // apply the phase-1 moves to get the phase-2 coordinates
    tnCopy(cube, scratchA);
    for (var i = 0; i < d1; i++) { tnMul(scratchA, TN_MOVE[path[i]], scratchB); var t = scratchA; scratchA = scratchB; scratchB = t; }
    var c = tnRank(scratchA.cp, 8, 0), e = tnRank(scratchA.ep, 8, 0), s = tnRank(scratchA.ep, 4, 8);
    var r2 = maxTotal - d1;
    if (r2 < 0) return false;
    var h = tnPruneCS[c * 24 + s], h2 = tnPruneES[e * 24 + s];
    if (h2 > h) h = h2;
    if (h > r2) return false;
    var lastFace = d1 > 0 ? ((path[d1 - 1] / 3) | 0) : -1;
    for (var lim = h; lim <= r2; lim++) {
      if (p2(c, e, s, lim, lastFace, 0)) {
        var sol = [];
        for (var a = 0; a < d1; a++) sol.push(path[a]);
        for (var b = 0; b < lim; b++) sol.push(path2[b]);
        best = sol;
        maxTotal = sol.length - 1;
        return sol.length <= targetLen;
      }
    }
    return false;
  }

  function p1(t, f, s, rem, last, depth) {
    if (rem === 0) {
      if (t === 0 && f === 0 && s === 0) {
        if (last >= 0 && TN_IS_P2[last]) return false;
        return tryP2(depth);
      }
      return false;
    }
    if (((++nodes) & 8191) === 0) {
      if (best && Date.now() > deadline) { aborted = true; return true; }
      if (nodeCap && nodes > nodeCap) { aborted = true; return true; }
    }
    var h = tnPruneTS[t * TN_SLICE_N + s], h2 = tnPruneFS[f * TN_SLICE_N + s];
    if (h2 > h) h = h2;
    if (h > rem) return false;
    var lf = last >= 0 ? ((last / 3) | 0) : -1;
    for (var m = 0; m < 18; m++) {
      var face = (m / 3) | 0;
      if (lf >= 0 && (face === lf || (face % 3 === lf % 3 && face < lf))) continue;
      path[depth] = m;
      if (p1(tnTwistMove[t * 18 + m], tnFlipMove[f * 18 + m], tnSliceMove[s * 18 + m], rem - 1, m, depth + 1)) return true;
      if (aborted) return true;
    }
    return false;
  }

  for (var d1 = 0; d1 <= maxTotal; d1++) {
    if (p1(t0, f0, s0, d1, -1, 0)) break;
  }
  return best;
}

// ---- random state + scramble text ----
function tnRand(n) {
  try {
    if (typeof crypto !== "undefined" && crypto.getRandomValues) {
      var buf = new Uint32Array(1);
      crypto.getRandomValues(buf);
      return buf[0] % n;
    }
  } catch (e) { /* use Math.random */ }
  return Math.floor(Math.random() * n);
}
function tnShuffle(n) {
  var a = [], i;
  for (i = 0; i < n; i++) a.push(i);
  for (i = n - 1; i > 0; i--) { var j = tnRand(i + 1), t = a[i]; a[i] = a[j]; a[j] = t; }
  return a;
}
function tnParity(a) { var p = 0; for (var i = 0; i < a.length; i++) for (var j = i + 1; j < a.length; j++) if (a[i] > a[j]) p ^= 1; return p; }
function tnRandomCube() {
  var c = tnNewCube(), i, s;
  c.cp = tnShuffle(8);
  c.ep = tnShuffle(12);
  if (tnParity(c.cp) !== tnParity(c.ep)) { var t = c.ep[0]; c.ep[0] = c.ep[1]; c.ep[1] = t; }
  s = 0;
  for (i = 0; i < 7; i++) { c.co[i] = tnRand(3); s += c.co[i]; }
  c.co[7] = (3 - (s % 3)) % 3;
  s = 0;
  for (i = 0; i < 11; i++) { c.eo[i] = tnRand(2); s += c.eo[i]; }
  c.eo[11] = s & 1;
  return c;
}
// the scramble is the inverse of the solution
function tnMovesToScramble(sol) {
  var out = [];
  for (var i = sol.length - 1; i >= 0; i--) {
    var face = (sol[i] / 3) | 0, k = sol[i] % 3;
    out.push(TN_FACES[face] + (k === 0 ? "'" : k === 1 ? "2" : ""));
  }
  return out.join(" ");
}
// old style random-move scramble, only used while the tables are still being built
function tnFallbackScramble(len) {
  len = len || 20;
  var axis = [0, 1, 2, 0, 1, 2], mods = ["", "'", "2"], out = [], last = -1, prev = -1;
  while (out.length < len) {
    var f = tnRand(6);
    if (f === last) continue;
    if (last >= 0 && prev >= 0 && axis[last] === axis[f] && axis[prev] === axis[f]) continue;
    out.push(TN_FACES[f] + mods[tnRand(3)]);
    prev = last; last = f;
  }
  return out.join(" ");
}
// inverse of a cube state: solving the inverse gives a sequence that, applied to a solved cube, makes the state itself
function tnInvert(c) {
  var r = tnNewCube(), i;
  for (i = 0; i < 8; i++) { r.cp[c.cp[i]] = i; r.co[c.cp[i]] = (3 - c.co[i]) % 3; }
  for (i = 0; i < 12; i++) { r.ep[c.ep[i]] = i; r.eo[c.ep[i]] = c.eo[i]; }
  return r;
}
function tnMovesToText(sol) {
  var out = [];
  for (var i = 0; i < sol.length; i++) out.push(TN_FACES[(sol[i] / 3) | 0] + ["", "2", "'"][sol[i] % 3]);
  return out.join(" ");
}
// Staged search: first try for 21 moves or less (on the cube and on its inverse), then 22, 23 ...
// (like TNoodle, almost always 19-21 moves). Returns the scramble text.
function tnScrambleForCube(cube) {
  var inv = tnInvert(cube), stages = [[21, 250000], [22, 400000], [23, 800000]];
  for (var i = 0; i < stages.length; i++) {
    var sol = tnSolve(cube, stages[i][0], stages[i][0], 1e9, stages[i][1]);
    if (sol) return { text: tnMovesToScramble(sol), len: sol.length };
    sol = tnSolve(inv, stages[i][0], stages[i][0], 1e9, stages[i][1]);
    if (sol) return { text: tnMovesToText(sol), len: sol.length };
  }
  var last = tnSolve(cube, 30, 30, 1e9, 0); // always finds something
  return { text: tnMovesToScramble(last), len: last.length };
}
function tnScrambleNow() {
  for (var tries = 0; tries < 5; tries++) {
    var r = tnScrambleForCube(tnRandomCube());
    if (r.len >= 5) return r.text;
  }
  return tnFallbackScramble(20);
}
// A few scrambles are made ahead of time (one at a time, between other work), so asking for one is instant.
var tnPool = [], tnPoolTimer = null;
function tnPrefill(n) {
  if (!TN_READY || tnPool.length >= n || tnPoolTimer) return;
  tnPoolTimer = setTimeout(function () {
    tnPoolTimer = null;
    if (tnPool.length < n) tnPool.push(tnScrambleNow());
    tnPrefill(n);
  }, 60);
}
// A WCA / TNoodle style 3x3 scramble. Falls back to random moves only until the tables are ready.
function tnScramble() {
  if (!TN_READY) { tnPrepare(); return tnFallbackScramble(20); }
  var s = tnPool.length ? tnPool.shift() : tnScrambleNow();
  tnPrefill(3);
  return s;
}
