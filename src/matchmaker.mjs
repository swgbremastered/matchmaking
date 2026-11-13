// The matchmaking service: accounts, profiles and leaderboards, the ranked queues, the open-game lobbies with their
// chat, the match's start, connection brokering and the result. Structure after empire-league's src/matchmaker.mjs
// (tickets -> match_found -> accept -> session; custom lobbies; result reports with corroboration; MIT, see
// LICENSE.empire-league), without Steam, AoE2 lobby automation, tournaments, Discord or Twitch.
//
// Also: unranked queues beside the ranked ones (the same matching and map pool, a hidden casual rating for pairing,
// no change to the shown rating), the weekly unranked queue, friends, direct messages, presence (offline / idle /
// looking / in_lobby / in_game), parties that stay together and queue as one (team queue) with party chat, the match
// history with the games' replays (the game client uploads its replay; anyone logged in can fetch it), civilisation
// choice (queue and lobby) and lobby settings, FFA placings, and a control link that comes back (resume: a player in a
// running match is no longer counted as gone).
//
// Transport: one TCP port for everything the game says (newline-delimited JSON, see README.md), the same port number
// on UDP for the hole-punch rendezvous, and relay connections on the TCP port (a connection whose first line is
// {"t":"relay",...} becomes a byte pipe to its partner).
//
// With `tls` the control link is TLS (a connection whose first byte is a TLS
// handshake record is wrapped; any other connection may only open a relay, whose bytes are the game's own lockstep
// frames, which direct and punched links carry in the clear as well), and the abuse limits (`limits`, see config.mjs):
// connection caps, a line size cap, a log-in deadline, a message rate per connection, log-in / registration rates per
// address, a lock-out per account name after failed log-ins, a chat rate per player, a datagram rate per address; the
// replay size cap and retention (`replays`); structured logs (log.mjs); status() for the health check.
import net from "node:net";
import tls from "node:tls";
import dgram from "node:dgram";
import { randomBytes, randomInt, scryptSync, timingSafeEqual } from "node:crypto";
import { QueueEngine, spreadFor } from "./queue.mjs";
import { casualPoolForQueue, ratingPoolForQueue } from "./rating-pool.mjs";
import { WEEKLY_ROTATION, weeklyQueue } from "./weekly.mjs";
import { TokenBucket, WindowLimiter } from "./limits.mjs";
import { asLogger } from "./log.mjs";
import { Moderation } from "./moderation.mjs";

const REPLAY_CHUNK = 24 * 1024;          // raw bytes per replay chunk (base64 keeps a line under maxLineBytes)
const REPLAY_MAX = 32 * 1024 * 1024;     // the largest replay kept (without a `replays` option)
const RELAY_PENDING_MAX = 1024 * 1024;   // bytes a relay end may send before its partner arrives
const RELAY_WAIT_MS = 120_000;           // an unpaired relay token / punch is forgotten after this
// A Matchmaker made without `limits` (the tests) limits nothing but the line size (1 MiB; config.mjs: 64 KiB).
const NO_LIMITS = Object.freeze({ maxConnections: 0, maxConnectionsPerIp: 0, maxLineBytes: 1024 * 1024, authTimeoutMs: 0,
  messagesPerSecond: 0, loginPerIpPerMinute: 0, registerPerIpPerHour: 0, loginFailuresPerAccount: 0, loginLockoutMinutes: 15,
  chatPerMinute: 0, chatBurst: 0, udpPerIpPerSecond: 0, maxRelays: 0, roomPasswordPerIpPerMinute: 0 });
const ipOf = (socket) => String(socket.remoteAddress ?? "").replace(/^::ffff:/, "");
// The civilisations by the genie name the game client takes; "" = the game's default.
export const CIVS = Object.freeze(["EMPIRE", "GUNGANS", "REBEL", "NABOO", "FEDERATION", "WOOKIEES", "REPUBLIC", "CONFEDERACY"]);
const civOf = (value) => (CIVS.includes(String(value ?? "").toUpperCase()) ? String(value).toUpperCase() : "");
// The game's computer-player difficulties, easiest first.
export const AI_DIFFICULTIES = Object.freeze(["easiest", "easy", "moderate", "hard", "hardest"]);
const ROOM_PASSWORD_MAX = 64;
const hashRoomPassword = (password, salt) => scryptSync(password, salt, 32);
// Lobby settings the host sets (the game client applies them to every peer alike): population limit, start tech level,
// Reveal Map.
const roomSettings = (s = {}, base = { popCap: 75, startAge: 1, reveal: false }) => ({
  popCap: [25, 50, 75, 100, 125, 150, 175, 200].includes(Number(s.popCap)) ? Number(s.popCap) : base.popCap,
  startAge: [1, 2, 3, 4].includes(Number(s.startAge)) ? Number(s.startAge) : base.startAge,
  reveal: s.reveal === undefined ? base.reveal : s.reveal === true
});

export class Matchmaker {
  constructor({ store, catalog, host = "127.0.0.1", port = 4317, minQueueMs = 15_000, ffaPlayers = 4, acceptMs = 30_000,
    corroborationMs = 60_000, weeklyRotation = WEEKLY_ROTATION, now = () => Date.now(), log = console.log,
    tls: tlsSource = null, limits = {}, replays = {}, messages = {}, moderation = {} } = {}) {
    this.store = store;
    this.catalog = catalog;
    this.host = host;
    this.port = port;
    this.acceptMs = acceptMs;
    this.corroborationMs = corroborationMs;
    this.log = asLogger(log);
    this.tls = tlsSource;          // { context, info?, handshakeMs? } (a CertWatcher): TLS control links; null: plain
    this.limits = { ...NO_LIMITS, ...limits };
    this.replayMax = replays.maxBytes ?? REPLAY_MAX;
    this.retentionDays = replays.retentionDays ?? 0;
    this.sweepMinutes = replays.sweepMinutes ?? 60;
    this.chatMax = messages.chatMax ?? 200;
    this.dmMax = messages.dmMax ?? 300;
    const L = this.limits;
    this.loginIpLimit = new WindowLimiter({ limit: L.loginPerIpPerMinute, windowMs: 60_000, now });
    this.registerIpLimit = new WindowLimiter({ limit: L.registerPerIpPerHour, windowMs: 3_600_000, now });
    this.loginFailures = new WindowLimiter({ limit: L.loginFailuresPerAccount, windowMs: L.loginLockoutMinutes * 60_000, now });
    this.messageRate = new TokenBucket({ rate: L.messagesPerSecond, burst: L.messagesPerSecond * 2, now });
    this.chatRate = new TokenBucket({ rate: L.chatPerMinute / 60, burst: Math.max(1, L.chatBurst), now });
    this.udpRate = new TokenBucket({ rate: L.udpPerIpPerSecond, burst: L.udpPerIpPerSecond * 2, now });
    this.roomPasswordLimit = new WindowLimiter({ limit: L.roomPasswordPerIpPerMinute, windowMs: 60_000, now });
    this.sockets = new Set();      // every open TCP connection (the caps, stop())
    this.perIp = new Map();        // address -> open TCP connections
    this.connSeq = 0;
    this.startedAt = now();
    this.sweepTimer = null;
    this.queue = new QueueEngine({ catalog, minQueueMs, ffaPlayers });
    this.online = new Map();       // playerId -> conn
    this.matches = new Map();      // matchId -> match
    this.rooms = new Map();        // roomId -> room
    this.punches = new Map();      // token -> { match, endpoints: Map slot -> {address, port} }
    this.relays = new Map();       // token -> { waiting: socket | null, slots }
    this.declined = new Map();     // "a|b" -> until (empire-league's declined pair cooldown)
    this.timer = null;
    this.weeklyRotation = weeklyRotation;
    this.now = now;
    this.parties = new Map();      // partyId -> { id, leaderId, members: [playerId], invites: Set, messages }
    this.presence = new Map();     // playerId -> the last presence told to friends and party
    this.uploads = new Map();      // "match|player" -> [Buffer]
    this.moderation = new Moderation({ store, mm: this, now, log: this.log, config: moderation });
    this.banCheckAt = now();       // bans made elsewhere (the command line) since then are enforced on the next check
    this.extensions = [this.moderation];  // more request handlers: handle(conn, m) -> true when it was theirs
  }

  // With port 0 (tests) the UDP port is picked first and the TCP port takes the same number: a TCP pick
  // followed by the UDP bind failed with EACCES whenever it fell in one of Windows' excluded UDP ranges. A number TCP
  // cannot take is tried again (a few times).
  async start() {
    const wanted = this.port;
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.startOnce();
      } catch (error) {
        if (wanted !== 0 || attempt >= 10 || !["EACCES", "EADDRINUSE"].includes(error?.code)) throw error;
        try { this.udp.close(); } catch { /* not bound */ }
        this.port = 0;
      }
    }
  }

  async startOnce() {
    this.udp = dgram.createSocket("udp4");
    this.udp.on("message", (message, remote) => this.rendezvous(message, remote));
    await new Promise((resolve, reject) => {
      this.udp.once("error", reject);
      this.udp.bind(this.port, this.host, resolve);
    });
    this.port = this.udp.address().port;
    this.tcp = net.createServer((socket) => this.accept(socket));
    await new Promise((resolve, reject) => {
      this.tcp.once("error", reject);
      this.tcp.listen(this.port, this.host, resolve);
    });
    this.timer = setInterval(() => this.tick(), 250);
    this.log.event("info", "listening", { host: this.host, port: this.port, tls: Boolean(this.tls) });
    // Replay retention, expired sessions, idle limiter keys: once now, then every sweepMinutes
    this.sweep();
    if (this.sweepMinutes > 0) this.sweepTimer = setInterval(() => this.sweep(), this.sweepMinutes * 60_000);
    return this;
  }

  async stop() {
    clearInterval(this.timer);
    clearInterval(this.sweepTimer);
    for (const match of this.matches.values()) clearTimeout(match.timer);
    for (const s of this.sockets) s.destroy();
    for (const c of this.online.values()) c.socket.destroy();
    await new Promise((resolve) => this.tcp.close(resolve));
    await new Promise((resolve) => this.udp.close(resolve));
  }

  // ---- retention and status ----------------------------------------------------------------------------------------
  sweep() {
    const t = this.now();
    if (this.retentionDays > 0) {
      const deleted = this.store.deleteReplaysBefore(t - this.retentionDays * 86_400_000);
      if (deleted) this.log.event("info", "replays_deleted", { count: deleted, olderThanDays: this.retentionDays });
    }
    this.store.deleteExpiredSessions(t);
    for (const l of [this.loginIpLimit, this.registerIpLimit, this.loginFailures, this.messageRate, this.chatRate, this.udpRate,
      this.roomPasswordLimit]) l.sweep();
    for (const [token, r] of this.relays) {
      if (t - r.created < RELAY_WAIT_MS) continue;
      r.waiting?.socket.destroy();
      this.relays.delete(token);
    }
    for (const [token, p] of this.punches) if (t - p.created >= RELAY_WAIT_MS) this.punches.delete(token);
  }

  // The health check's answer (health.mjs): ok unless the database, the listeners or the certificate are not fine.
  status() {
    let db = false;
    try {
      db = this.store.ping();
    } catch { /* not ok */ }
    const listening = Boolean(this.tcp?.listening);
    const cert = this.tls?.info ?? null;
    const certOk = !this.tls || (cert && Date.parse(cert.validTo) > Date.now());
    let replays = null;
    try {
      replays = this.store.replayStats();
    } catch { /* the database said no above */ }
    return {
      ok: db && listening && Boolean(certOk), service: "swgb-matchmaking", protocol: 1,
      uptimeS: Math.round((this.now() - this.startedAt) / 1000), port: this.port, listening, db,
      tls: this.tls ? { enabled: true, validTo: cert?.validTo ?? null, subject: cert?.subject?.replace(/\n/g, ", ") ?? null } : { enabled: false },
      connections: this.sockets.size, online: this.online.size, matches: this.matches.size, rooms: this.rooms.size,
      parties: this.parties.size, replays
    };
  }

  // ---- connections -------------------------------------------------------------------------------------------------
  accept(socket) {
    const ip = ipOf(socket);
    const L = this.limits;
    const n = this.perIp.get(ip) ?? 0;
    const why = L.maxConnections && this.sockets.size >= L.maxConnections ? "server full"
      : L.maxConnectionsPerIp && n >= L.maxConnectionsPerIp ? "too many connections from this address" : "";
    socket.on("error", () => {});
    if (why) {
      this.log.event("warn", "connection_refused", { ip, reason: why });
      socket.destroy();
      return;
    }
    this.sockets.add(socket);
    this.perIp.set(ip, n + 1);
    socket.once("close", () => {
      this.sockets.delete(socket);
      const left = (this.perIp.get(ip) ?? 1) - 1;
      if (left > 0) this.perIp.set(ip, left);
      else this.perIp.delete(ip);
    });
    socket.setNoDelay(true);
    socket.setKeepAlive(true, 60_000);
    if (!this.tls) return this.attach(socket, ip, false);
    // TLS: the first byte tells a TLS handshake record (0x16) from a plain line (a relay's)
    const hello = setTimeout(() => socket.destroy(), this.tls.handshakeMs ?? 10_000);
    socket.once("data", (first) => {
      socket.pause();
      socket.unshift(first);
      if (first[0] !== 0x16) {
        clearTimeout(hello);
        this.attach(socket, ip, false);
        socket.resume();
        return;
      }
      const secure = new tls.TLSSocket(socket, { isServer: true, secureContext: this.tls.context });
      secure.on("error", (error) => this.log.event("debug", "tls_error", { ip, error: error.code ?? error.message }));
      secure.once("secure", () => clearTimeout(hello));
      secure.once("close", () => socket.destroy());
      this.attach(secure, ip, true);
    });
  }

  attach(socket, ip, secure) {
    const conn = { socket, buffer: "", player: null, mode: "control", ip, secure, id: ++this.connSeq, refused: 0 };
    socket.on("data", (chunk) => this.onData(conn, chunk));
    socket.on("error", () => {});
    socket.on("close", () => {
      clearTimeout(conn.authTimer);
      this.messageRate.forget(conn.id);
      this.onClose(conn);
    });
    // A control connection logs in (or opens a relay) within authTimeoutMs
    if (this.limits.authTimeoutMs)
      conn.authTimer = setTimeout(() => {
        if (!conn.player && conn.mode === "control") socket.destroy();
      }, this.limits.authTimeoutMs);
    return conn;
  }

  onData(conn, chunk) {
    if (conn.mode === "relay") return this.relayData(conn, chunk);
    conn.buffer += chunk.toString("latin1");
    const max = this.limits.maxLineBytes;
    for (let nl; (nl = conn.buffer.indexOf("\n")) >= 0;) {
      if (nl > max) {
        this.log.event("warn", "line_too_long", { ip: conn.ip, player: conn.player?.name, bytes: nl });
        return conn.socket.destroy();
      }
      const line = conn.buffer.slice(0, nl).trim();
      conn.buffer = conn.buffer.slice(nl + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(Buffer.from(line, "latin1").toString("utf8"));
      } catch {
        this.send(conn, { t: "error", message: "bad json" });
        continue;
      }
      if (message === null || typeof message !== "object" || Array.isArray(message)) {
        this.send(conn, { t: "error", message: "bad message" });
        continue;
      }
      if (message.t === "relay") {  // the rest of this connection is a pipe
        conn.mode = "relay";
        clearTimeout(conn.authTimer);
        const rest = Buffer.from(conn.buffer, "latin1");
        conn.buffer = "";
        this.relayOpen(conn, message, rest);
        return;
      }
      // A TLS server takes no plain control messages (a password must never cross in the clear)
      if (this.tls && !conn.secure) {
        this.log.event("warn", "plain_refused", { ip: conn.ip, request: String(message.t).slice(0, 32) });
        this.send(conn, { t: "error", re: message.t, message: "this server needs TLS" });
        return conn.socket.end();
      }
      if (!this.messageRate.take(conn.id)) {
        conn.refused += 1;
        if (conn.refused > 100) {
          this.log.event("warn", "flood_closed", { ip: conn.ip, player: conn.player?.name });
          return conn.socket.destroy();
        }
        this.send(conn, { t: "error", re: message.t, message: "too many messages; slow down" });
        continue;
      }
      try {
        this.handle(conn, message);
      } catch (error) {
        const text = error instanceof Error ? error.message : String(error);
        this.log(`[matchmaking] ${conn.player?.name ?? "(not logged in)"}: ${message.t} refused: ${text}`);
        this.send(conn, { t: "error", re: message.t, message: text, ...(error?.extra ?? {}) });
      }
      this.refreshPresence();  // a request may change a presence (queue, lobby, match)
    }
    if (conn.buffer.length > max) {
      this.log.event("warn", "line_too_long", { ip: conn.ip, player: conn.player?.name, bytes: conn.buffer.length });
      conn.socket.destroy();
    }
  }

  send(conn, message) {
    if (conn && !conn.socket.destroyed) conn.socket.write(`${JSON.stringify(message)}\n`);
  }

  sendTo(playerId, message) {
    this.send(this.online.get(playerId), message);
  }

  onClose(conn) {
    if (conn.mode === "relay") return this.relayClose(conn);
    const id = conn.player?.id;
    if (!id || this.online.get(id) !== conn) return;
    this.online.delete(id);
    this.leaveQueue(id, `${conn.player.name} went offline`);
    for (const key of [...this.uploads.keys()]) if (key.endsWith(`|${id}`)) this.uploads.delete(key);
    const room = this.roomOf(id);
    if (room && room.status === "open") this.leaveRoom(id);
    for (const match of this.matches.values()) {
      if (!match.participants.some((p) => p.playerId === id)) continue;
      if (match.state === "accept") this.cancelMatch(match, `${conn.player.name} disconnected`);
      else if (match.state === "playing") {
        match.gone.add(id);
        this.maybeResolve(match);
      }
    }
    // A party keeps an offline member (its control link may come back); presence says offline
    this.refreshPresence();
  }

  requirePlayer(conn) {
    if (!conn.player) throw new Error("log in first");
    return conn.player;
  }

  // ---- requests ----------------------------------------------------------------------------------------------------
  handle(conn, m) {
    switch (m.t) {
      case "hello":
        return this.send(conn, { t: "welcome", server: "swgb-matchmaking", protocol: 1 });
      case "register":
      case "login":
      case "resume": {
        if (m.t === "register") this.moderation.checkAddress(conn.ip);
        const auth = this.authenticate(conn, m);
        this.moderation.checkLogin(auth.player.id, conn.ip);
        this.store.mod.noteAddress(auth.player.id, conn.ip, this.now());
        const previous = this.online.get(auth.player.id);
        if (previous && previous !== conn) {
          this.online.delete(auth.player.id);  // the newer connection takes over (the game after the menu)
          previous.player = null;
        }
        conn.player = auth.player;
        this.online.set(auth.player.id, conn);
        clearTimeout(conn.authTimer);
        this.log.event("info", m.t, { player: auth.player.name, ip: conn.ip, tls: conn.secure });
        this.send(conn, { t: "auth", token: auth.token, player: auth.player, role: this.store.mod.role(auth.player.id) });
        return this.afterAuth(conn);
      }
      case "profile": {
        const target = m.name ? this.store.playerByName(m.name) : this.requirePlayer(conn);
        if (!target) throw new Error("no such player");
        return this.send(conn, { t: "profile", profile: this.store.profile(target.id) });
      }
      case "leaderboard":
        return this.send(conn, { t: "leaderboard", pool: m.pool ?? "solo", rows: this.store.leaderboard(m.pool ?? "solo", Number(m.limit ?? 20)) });
      case "maps":
        return this.send(conn, { t: "maps", catalog: this.catalog.public(), weekly: this.weekly(), civs: CIVS });
      case "weekly":
        return this.send(conn, { t: "weekly", weekly: this.weekly() });
      case "queue_join":
        return this.joinQueue(conn, m);
      case "queue_leave": {
        const player = this.requirePlayer(conn);
        if (!this.leaveQueue(player.id, `${player.name} left the queue`)) this.send(conn, { t: "queue", state: "idle" });
        return undefined;
      }
      case "friends":
        return this.sendFriends(this.requirePlayer(conn).id);
      case "friend_add":
        return this.friendAdd(conn, m);
      case "friend_accept":
        return this.friendAccept(conn, m);
      case "friend_remove":
        return this.friendRemove(conn, m);
      case "dm":
        return this.directMessage(conn, m);
      case "dm_history": {
        const player = this.requirePlayer(conn);
        const other = this.store.playerByName(m.with);
        if (!other) throw new Error("no such player");
        return this.send(conn, { t: "dm_history", with: other.name, messages: this.store.directMessages(player.id, other.id) });
      }
      case "presence": {
        const other = this.store.playerByName(m.name);
        if (!other) throw new Error("no such player");
        return this.send(conn, { t: "presence", name: other.name, presence: this.presenceOf(other.id) });
      }
      case "party_invite":
        return this.partyInvite(conn, m);
      case "party_accept":
        return this.partyAccept(conn, m);
      case "party_decline":
        return this.partyDecline(conn, m);
      case "party_leave":
        this.partyLeave(this.requirePlayer(conn).id);
        return this.send(conn, { t: "party", party: null });
      case "party_chat":
        return this.partyChat(conn, m);
      case "party_set": {  // a member's civilisation for the party's games
        const player = this.requirePlayer(conn);
        const party = this.partyOf(player.id);
        if (!party) throw new Error("not in a party");
        party.civs.set(player.id, civOf(m.civ));
        return this.broadcastParty(party);
      }
      case "history": {
        const target = m.name ? this.store.playerByName(m.name) : this.requirePlayer(conn);
        if (!target) throw new Error("no such player");
        return this.send(conn, { t: "history", name: target.name, matches: this.store.history(target.id, Math.min(100, Number(m.limit ?? 20) || 20)) });
      }
      case "replay_chunk":
        return this.replayUpload(conn, m);
      case "replay_get":
        return this.replayGet(conn, m);
      case "room_set":
        return this.roomSet(conn, m);
      case "room_settings":
        return this.roomSettings(conn, m);
      case "accept":
      case "decline":
        return this.answerMatch(conn, m);
      case "rooms":
        return this.send(conn, this.roomSearch(conn, m));
      case "room_kick":
        return this.roomKick(conn, m);
      case "room_move":
        return this.roomMove(conn, m);
      case "room_slot":
        return this.roomSlot(conn, m);
      case "room_host":
        return this.roomHost(conn, m);
      case "room_create":
        return this.createRoom(conn, m);
      case "room_join":
        return this.joinRoom(conn, m);
      case "room_leave":
        this.leaveRoom(this.requirePlayer(conn).id);
        return this.send(conn, { t: "room", room: null });
      case "room_chat":
        return this.roomChat(conn, m);
      case "room_ready":
        return this.roomReady(conn, m);
      case "room_start":
        return this.roomStart(conn);
      case "host_addr":
        return this.hostAddr(conn, m);
      case "punch_request":
        return this.punchRequest(conn, m);
      case "relay_request":
        return this.relayRequest(conn, m);
      case "link":
        this.log(`[matchmaking] ${m.match}: ${this.requirePlayer(conn).name} link to slot ${m.peer}: ${m.method} ${m.ok ? "up" : "failed"}`);
        return undefined;
      case "result":
        return this.report(conn, m);
      default:
        if (this.extensions.some((x) => x.handle(conn, m))) return undefined;
        throw new Error(`unknown request ${m.t}`);
    }
  }

  // Register / login / resume under the limits: attempts per address (log-in and resume per minute,
  // registrations per hour) and failed log-ins per account name (then that name is refused for the lock-out time,
  // whoever asks). Logged without the password or the token.
  authenticate(conn, m) {
    const name = String(m.name ?? "").slice(0, 64);
    const refuse = (reason, text) => {
      this.log.event("warn", "auth_refused", { request: m.t, name: name || undefined, ip: conn.ip, reason });
      throw new Error(text);
    };
    if (m.t === "register") {
      if (!this.registerIpLimit.take(conn.ip)) refuse("register_rate", "too many new accounts from your address; try again later");
      return this.store.register(m.name, m.password);
    }
    if (!this.loginIpLimit.take(conn.ip)) refuse("login_rate", "too many log-in attempts; try again in a minute");
    if (m.t === "resume") {
      try {
        return this.store.resume(m.token);
      } catch (error) {
        refuse("bad_session", error.message);
      }
    }
    const key = name.toLowerCase();
    if (this.loginFailures.blocked(key)) refuse("account_locked", "too many failed log-ins for that name; try again later");
    try {
      const auth = this.store.login(m.name, m.password);
      this.loginFailures.clear(key);
      return auth;
    } catch (error) {
      this.loginFailures.add(key);
      return refuse("bad_password", error.message);
    }
  }

  // ---- ranked queues -----------------------------------------------------------------------------------------------
  // { queue: 1v1 | team | ffa | weekly, ranked (default true; weekly is always unranked), groups, maps,
  // favorites, teamSizes, civ }. Unranked tickets pair by the hidden casual rating in a lane of their own; a party's
  // leader queues the whole party (team queue).
  joinQueue(conn, m) {
    const player = this.requirePlayer(conn);
    const party = this.partyOf(player.id);
    if (party && party.leaderId !== player.id) throw new Error("only the party's leader queues");
    const memberIds = party ? party.members : [player.id];
    for (const id of memberIds) {
      const name = this.store.player(id)?.name;
      if (!this.online.has(id)) throw new Error(`${name} is offline`);
      if (this.roomOf(id)) throw new Error(id === player.id ? "leave your lobby first" : `${name} is in a lobby`);
      if (this.activeMatch(id)) throw new Error(id === player.id ? "you are in a match" : `${name} is in a match`);
    }
    this.leaveQueue(player.id, null);
    let queueId = String(m.queue ?? "1v1");
    let ranked = m.ranked !== false;
    let lane = ranked ? "ranked" : "unranked";
    let mapPrefs = { groups: m.groups, maps: m.maps, favorites: m.favorites };
    let teamSizes = m.teamSizes;
    let week = null;
    if (queueId === "weekly") {  // this week's format and map pool; unranked
      const w = this.weekly();
      queueId = w.queue, ranked = false, lane = `weekly:${w.week}`, week = w.week;
      mapPrefs = { groups: w.groups, maps: w.maps };
      teamSizes = w.teamSizes ?? teamSizes;
    }
    const pool = ranked ? ratingPoolForQueue(queueId) : casualPoolForQueue(queueId);
    const prefs = this.catalog.normalize(mapPrefs);
    const civ = civOf(m.civ);
    const members = memberIds.map((id) => ({ playerId: id, name: this.store.player(id).name, rating: this.store.rating(id, pool),
      civ: id === player.id ? civ : civOf(party?.civs?.get(id)) }));
    const ticket = this.queue.join({
      id: `ticket-${randomBytes(4).toString("hex")}`, playerId: player.id, name: player.name, queueId, lane, ranked, week,
      rating: Math.round(members.reduce((sum, p) => sum + p.rating, 0) / members.length), joinedAt: this.now(), prefs,
      teamSizes, findAnyone: m.findAnyone === true, members: party ? members : undefined, civ
    });
    const spread = spreadFor(ticket, this.now());
    this.log(`[matchmaking] ${party ? `party of ${members.length} (${members.map((p) => p.name).join(", ")})` : player.name} queues `
      + `${lane} ${queueId} at ${ticket.rating} (${prefs.maps.length} maps)`);
    // the shown rating: an unranked queue does not show the hidden one
    const shown = (id) => this.store.rating(id, ratingPoolForQueue(queueId));
    for (const id of memberIds)
      this.sendTo(id, { t: "queue", state: "searching", queue: queueId, ranked, lane, week, party: Boolean(party),
        rating: ranked ? ticket.rating : shown(id), minRating: ranked ? ticket.rating - spread : 0, maxRating: ranked ? ticket.rating + spread : 0,
        maps: prefs.maps, ignored: prefs.ignored });
    this.tick();
  }

  // Takes a player's ticket (and its party's) out of the queue; tells the others on it. Returns whether one was there.
  leaveQueue(playerId, reason) {
    const ticket = this.queue.ticketOf(playerId);
    if (!ticket) return false;
    this.queue.leave(playerId);
    for (const id of (ticket.members ?? [{ playerId: ticket.playerId }]).map((p) => p.playerId))
      this.sendTo(id, { t: "queue", state: "idle", reason: reason ?? undefined });
    return true;
  }

  weekly() {
    return weeklyQueue(this.now(), this.weeklyRotation);
  }

  tick() {
    const now = this.now();
    for (const [key, until] of this.declined) if (until <= now) this.declined.delete(key);
    for (const proposal of this.queue.matchAll(now)) {
      const ids = proposal.participants.map((p) => p.playerId);
      const cooled = ids.some((a) => ids.some((b) => a !== b && this.declined.has(`${Math.min(a, b)}|${Math.max(a, b)}`)));
      if (cooled) {
        for (const p of proposal.participants) p.matchId = null;
        continue;
      }
      this.proposeMatch(proposal);
    }
    for (const match of this.matches.values())
      if (match.state === "playing" && match.firstReportAt && now - match.firstReportAt > this.corroborationMs) this.resolve(match, true);
    if (now - this.banCheckAt >= this.moderation.config.sweepSeconds * 1000) this.checkNewBans(now);
  }

  // ---- moderation: bans that close connections, kicks, broadcasts ------------------------------------------------
  // Bans written by another process (src/admin.mjs on the same database) reach online players here.
  checkNewBans(now = this.now()) {
    const since = this.banCheckAt;
    this.banCheckAt = now;
    for (const ban of this.store.mod.bansSince(since - 1, now)) this.enforceBan(ban);
  }

  enforceBan(ban) {
    const message = { t: "banned", until: ban.until, reason: ban.reason };
    if (ban.playerId && this.online.has(ban.playerId)) this.disconnect(ban.playerId, message);
    if (ban.ip)
      for (const conn of [...this.online.values()])
        if (conn.ip === ban.ip && this.store.mod.role(conn.player.id) === "player") this.disconnect(conn.player.id, message);
  }

  // Tells the player why, then closes the control link (onClose takes them out of queues and lobbies).
  disconnect(playerId, message) {
    const conn = this.online.get(playerId);
    if (!conn) return;
    this.send(conn, message);
    this.log.event("info", message.t, { player: conn.player?.name, ip: conn.ip });
    conn.socket.end();
    this.onClose(conn);
  }

  broadcast(text, from) {
    const message = { t: "broadcast", from, text, at: this.now() };
    for (const conn of this.online.values()) this.send(conn, message);
    return this.online.size;
  }

  // New reports reach the moderators and admins who are online.
  notifyStaff(message) {
    for (const [id, conn] of this.online) if (this.store.mod.role(id) !== "player") this.send(conn, message);
  }

  proposeMatch(proposal) {
    const id = `match-${randomBytes(4).toString("hex")}`;
    const participants = [];
    // A party ticket brings all its members to one team; each player's civilisation comes along
    const ranked = (proposal.lane ?? "ranked") === "ranked";
    const shownPool = ratingPoolForQueue(proposal.queueId);
    proposal.teams.forEach((team, t) => team.forEach((ticket) => {
      for (const member of ticket.members ?? [{ playerId: ticket.playerId, name: ticket.name, rating: ticket.rating, civ: ticket.civ }])
        participants.push({ playerId: member.playerId, name: member.name, rating: member.rating, team: t + 1, civ: member.civ ?? "",
          shown: ranked ? member.rating : this.store.rating(member.playerId, shownPool), party: ticket.members ? ticket.id : null });
    }));
    // slots: the host is 1, then the rest in team order (team one first)
    participants.sort((a, b) => (b.playerId === proposal.host.playerId) - (a.playerId === proposal.host.playerId) || a.team - b.team);
    participants.forEach((p, i) => { p.slot = i + 1; });
    const week = proposal.lane?.startsWith("weekly:") ? proposal.lane.slice(7) : null;
    const match = {
      id, kind: week ? "weekly" : ranked ? "ranked" : "unranked", ranked, queueId: proposal.queueId, pool: shownPool,
      casualPool: ranked ? null : casualPoolForQueue(proposal.queueId), week,
      map: proposal.map, seed: randomInt(1, 0x7fffffff), participants, hostPlayerId: proposal.host.playerId,
      settings: roomSettings(), accepted: new Set(), state: "accept", reports: new Map(), gone: new Set(), firstReportAt: 0
    };
    this.matches.set(id, match);
    match.timer = setTimeout(() => this.cancelMatch(match, "the accept time ran out"), this.acceptMs);
    this.log(`[matchmaking] ${id}: ${proposal.queueId} on ${proposal.map.name}: ${participants.map((p) => `${p.name} (${p.rating})`).join(", ")}`);
    for (const p of participants) this.sendTo(p.playerId, { t: "match_found", match: this.publicMatch(match, p.playerId), acceptMs: this.acceptMs });
  }

  answerMatch(conn, m) {
    const player = this.requirePlayer(conn);
    const match = this.matches.get(m.match);
    if (!match || match.state !== "accept" || !match.participants.some((p) => p.playerId === player.id)) throw new Error("no such match to answer");
    if (m.t === "decline") {
      const mine = match.participants.find((p) => p.playerId === player.id);
      for (const p of match.participants)  // not with the decliner's own party
        if (p.playerId !== player.id && (!mine.party || p.party !== mine.party))
          this.declined.set(`${Math.min(p.playerId, player.id)}|${Math.max(p.playerId, player.id)}`, this.now() + 30_000);
      this.leaveQueue(player.id, `${player.name} declined`);
      return this.cancelMatch(match, `${player.name} declined`);
    }
    match.accepted.add(player.id);
    for (const p of match.participants) this.sendTo(p.playerId, { t: "match_accepted", match: match.id, accepted: match.accepted.size, of: match.participants.length });
    if (match.accepted.size === match.participants.length) {
      clearTimeout(match.timer);
      for (const p of match.participants) this.queue.leave(p.playerId);
      this.startMatch(match);
    }
  }

  cancelMatch(match, reason) {
    if (!this.matches.has(match.id) || match.state !== "accept") return;
    clearTimeout(match.timer);
    this.matches.delete(match.id);
    this.log(`[matchmaking] ${match.id} cancelled: ${reason}`);
    for (const p of match.participants) {
      const ticket = this.queue.ticketOf(p.playerId);
      if (ticket) ticket.matchId = null;  // back to searching (a decliner was taken out)
      this.sendTo(p.playerId, { t: "match_cancelled", match: match.id, reason, requeued: Boolean(ticket) });
    }
  }

  activeMatch(playerId) {
    for (const match of this.matches.values())
      if (match.state !== "done" && match.participants.some((p) => p.playerId === playerId)) return match;
    return null;
  }

  publicMatch(match, playerId) {
    const me = match.participants.find((p) => p.playerId === playerId);
    return {
      id: match.id, kind: match.kind, ranked: match.ranked, queue: match.queueId, pool: match.pool, week: match.week ?? undefined,
      map: { id: match.map.id, name: match.map.name, randomMap: match.map.randomMap ?? 0, testStart: match.map.testStart === true },
      seed: match.seed, host: 1, you: me?.slot ?? 0, settings: match.settings ?? roomSettings(),
      // the shown rating (an unranked match pairs by the hidden casual one, never sent)
      players: [...match.participants.map((p) => ({ name: p.name, slot: p.slot, team: p.team, rating: p.shown ?? p.rating, civ: p.civ ?? "" })),
        ...(match.ai ?? []).map((a) => ({ name: a.name, slot: a.slot, team: a.team, rating: null, civ: a.civ, ai: true, difficulty: a.difficulty }))]
    };
  }

  startMatch(match) {
    match.state = "playing";
    this.store.createMatch({ id: match.id, kind: match.kind, queueId: match.queueId, pool: match.pool, mapId: match.map.id,
      ranked: match.ranked, casualPool: match.casualPool, week: match.week,
      players: match.participants.map((p) => ({ playerId: p.playerId, slot: p.slot, team: p.team })) });
    this.log(`[matchmaking] ${match.id} starts (seed ${match.seed})`);
    for (const p of match.participants) this.sendTo(p.playerId, { t: "match_start", match: this.publicMatch(match, p.playerId) });
  }

  // ---- connection brokering ----------------------------------------------------------------------------------------
  // 1. the host listens and names its addresses; each guest gets them and connects directly;
  // 2. a guest that cannot asks for a hole punch: both sides register a UDP socket with the rendezvous here, each learns
  //    the other's address as this server saw it, and they send to each other until both hear;
  // 3. failing that, a relay: both open a TCP connection here with the same token and the server pipes the bytes.
  // The game's own messages (the MP lockstep frames) run unchanged over whichever link came up.
  matchOf(conn, id) {
    const player = this.requirePlayer(conn);
    const match = this.matches.get(id);
    const me = match?.participants.find((p) => p.playerId === player.id);
    if (!match || !me) throw new Error("not in that match");
    return { match, me };
  }

  hostAddr(conn, m) {
    const { match, me } = this.matchOf(conn, m.match);
    if (me.slot !== 1) throw new Error("only the host names its addresses");
    match.hostAddrs = (m.addrs ?? []).map(String).slice(0, 8);
    for (const p of match.participants)
      if (p.slot !== 1) this.sendTo(p.playerId, { t: "connect", match: match.id, addrs: match.hostAddrs });
  }

  punchRequest(conn, m) {
    const { match, me } = this.matchOf(conn, m.match);
    const token = randomBytes(12).toString("hex");
    this.punches.set(token, { match: match.id, slots: [1, me.slot], endpoints: new Map(), created: Date.now() });
    const host = match.participants.find((p) => p.slot === 1);
    this.sendTo(host.playerId, { t: "punch", match: match.id, peer: me.slot, token, udpPort: this.port });
    this.send(conn, { t: "punch", match: match.id, peer: 1, token, udpPort: this.port });
  }

  rendezvous(message, remote) {
    if (message.length > 512 || !this.udpRate.take(remote.address)) return;  // datagrams per address
    let m;
    try {
      m = JSON.parse(message.toString("utf8"));
    } catch {
      return;
    }
    const punch = m && m.t === "reg" ? this.punches.get(m.token) : null;
    if (!punch || !punch.slots.includes(m.slot)) return;
    punch.endpoints.set(m.slot, { address: remote.address, port: remote.port });
    if (punch.endpoints.size < 2) {
      this.udp.send(JSON.stringify({ t: "wait" }), remote.port, remote.address);
      return;
    }
    for (const [slot, endpoint] of punch.endpoints) {
      const other = [...punch.endpoints].find(([s]) => s !== slot)[1];
      this.udp.send(JSON.stringify({ t: "peer", ip: other.address, port: other.port }), endpoint.port, endpoint.address);
    }
  }

  relayRequest(conn, m) {
    const { match, me } = this.matchOf(conn, m.match);
    if (this.limits.maxRelays && this.relays.size >= this.limits.maxRelays) throw new Error("the relay is busy; try again later");
    const token = randomBytes(12).toString("hex");
    this.relays.set(token, { match: match.id, waiting: null, created: Date.now() });
    const host = match.participants.find((p) => p.slot === 1);
    this.sendTo(host.playerId, { t: "relay", match: match.id, peer: me.slot, token });
    this.send(conn, { t: "relay", match: match.id, peer: 1, token });
    this.log(`[matchmaking] ${match.id}: relay for slot ${me.slot}`);
  }

  relayOpen(conn, m, rest) {
    const relay = this.relays.get(m.token);
    if (!relay) return conn.socket.destroy();
    conn.pending = rest.length ? [rest] : [];
    if (!relay.waiting) {
      relay.waiting = conn;
      return undefined;
    }
    const other = relay.waiting;
    this.relays.delete(m.token);
    conn.partner = other, other.partner = conn;
    for (const chunk of other.pending) conn.socket.write(chunk);
    for (const chunk of conn.pending) other.socket.write(chunk);
    other.pending = conn.pending = null;
    return undefined;
  }

  relayData(conn, chunk) {
    if (conn.partner) return conn.partner.socket.write(chunk);
    if (!conn.pending) return undefined;
    conn.pendingBytes = (conn.pendingBytes ?? 0) + chunk.length;
    if (conn.pendingBytes > RELAY_PENDING_MAX) return conn.socket.destroy();  // no partner, no storage
    conn.pending.push(Buffer.from(chunk));
    return undefined;
  }

  relayClose(conn) {
    if (conn.partner) return conn.partner.socket.end();
    for (const relay of this.relays.values()) if (relay.waiting === conn) relay.waiting = null;  // a later partner waits anew
    return undefined;
  }

  // ---- results -----------------------------------------------------------------------------------------------------
  // Each peer reports what its game said: { winners: [slots] } at the game's end, or { resigned: slot } when it left.
  // Agreeing reports from every player (or every player still connected) settle the match; otherwise the first report
  // is trusted after the corroboration time (empire-league: MATCH_REPORT_CORROBORATION_TIMEOUT_MS). Reports that
  // disagree make the match contested: no rating change.
  report(conn, m) {
    const { match, me } = this.matchOf(conn, m.match);
    if (match.state !== "playing") throw new Error("that match is over");
    match.reports.set(me.slot, {
      winners: Array.isArray(m.winners) ? m.winners.map(Number) : null,
      resigned: m.resigned ? Number(m.resigned) : null,
      places: m.places && typeof m.places === "object" ? m.places : null
    });
    if (!match.firstReportAt) match.firstReportAt = this.now();
    this.log(`[matchmaking] ${match.id}: slot ${me.slot} reports ${JSON.stringify(match.reports.get(me.slot))}`);
    this.maybeResolve(match);
  }

  maybeResolve(match) {
    if (match.state !== "playing") return;
    const outstanding = match.participants.filter((p) => !match.reports.has(p.slot) && !match.gone.has(p.playerId));
    if (match.reports.size && !outstanding.length) this.resolve(match, false);
  }

  resolve(match, timedOut) {
    const reports = [...match.reports.values()];
    const resigned = new Set(reports.map((r) => r.resigned).filter(Boolean));
    const verdicts = reports.filter((r) => r.winners && r.winners.length).map((r) => [...r.winners].sort().join(","));
    const teamOf = (slot) => match.participants.find((p) => p.slot === slot)?.team;
    let winners = null;
    let contested = new Set(verdicts).size > 1;
    if (verdicts.length) winners = verdicts[0].split(",").map(Number);
    else if (resigned.size && match.queueId !== "ffa") {  // every player of all but one team resigned
      const teams = new Set(match.participants.map((p) => p.team));
      const standing = [...teams].filter((t) => match.participants.some((p) => p.team === t && !resigned.has(p.slot)));
      if (standing.length === 1) winners = match.participants.filter((p) => p.team === standing[0]).map((p) => p.slot);
    }
    if (winners && [...resigned].some((slot) => winners.map(teamOf).includes(teamOf(slot)) && match.queueId === "1v1")) contested = true;
    let places = null;
    if (match.queueId === "ffa" && winners) {
      places = Object.fromEntries(match.participants.map((p) => [p.slot, winners.includes(p.slot) ? 1 : 2]));
      const order = reports.map((r) => r.places).find(Boolean);
      if (order) places = order;
    }
    match.state = "done";
    let status = contested || !winners ? "contested" : "completed";
    // With computer players the result names human winners and losers only when humans played each other
    if (status === "completed" && match.ai?.length) {
      const won = new Set(winners.map(teamOf).filter(Boolean));
      const humansWon = match.participants.some((p) => won.has(p.team));
      const humansLost = match.participants.some((p) => !won.has(p.team));
      if (!humansWon || !humansLost) status = "vs_ai";
    }
    const ratings = this.store.recordResult(match.id, { winnerSlots: winners ?? [], places, status,
      detail: { reports: Object.fromEntries(match.reports), timedOut, winners, ai: match.ai?.length ? match.ai : undefined } });
    const named = {};
    for (const p of match.participants) named[p.name] = ratings[p.playerId];
    this.log(`[matchmaking] ${match.id} ${status}${timedOut ? " (corroboration timeout)" : ""}: ${JSON.stringify(named)}`);
    for (const p of match.participants)
      this.sendTo(p.playerId, { t: "result_recorded", match: match.id, status, winners, ranked: match.ranked, places, ratings: named });
    this.matches.delete(match.id);
    this.refreshPresence();
  }

  // ---- open-game lobbies -------------------------------------------------------------------------------------------
  // empire-league's custom lobbies (create / join / leave / chat / ready / start) plus a rating window per room.
  roomOf(playerId) {
    for (const room of this.rooms.values()) if (room.players.some((p) => p.playerId === playerId)) return room;
    return null;
  }

  publicRooms() {
    return [...this.rooms.values()].filter((r) => r.status === "open").map((r) => this.publicRoom(r));
  }

  publicRoom(room) {
    return {
      id: room.id, name: room.name, host: room.players.find((p) => p.playerId === room.hostId)?.name, minElo: room.minElo,
      maxElo: room.maxElo, maxPlayers: room.maxPlayers, pool: room.pool, ranked: room.ranked,
      map: { id: room.map.id, name: room.map.name }, status: room.status, settings: room.settings,
      players: room.players.map((p) => ({ name: p.name, slot: p.slot, team: p.team, rating: p.rating, ready: p.ready,
        host: p.playerId === room.hostId, civ: p.civ ?? "" })),
      messages: room.messages.slice(-30),
      locked: Boolean(room.password), capacity: this.roomCapacity(room), slots: this.roomSlots(room)
    };
  }

  // Every slot: open, closed, a player's or a computer player's.
  roomSlots(room) {
    return Array.from({ length: room.maxPlayers }, (_, i) => {
      const slot = i + 1;
      const p = room.players.find((x) => x.slot === slot);
      if (p) return { slot, state: "player", name: p.name, team: p.team };
      const ai = room.ai.get(slot);
      if (ai) return { slot, state: "ai", difficulty: ai.difficulty, civ: ai.civ, team: ai.team };
      return { slot, state: room.closed.has(slot) ? "closed" : "open" };
    });
  }

  // the places players can take: every slot not closed and not a computer player's
  roomCapacity(room) {
    return room.maxPlayers - room.closed.size - room.ai.size;
  }

  freeSlot(room) {
    const used = new Set(room.players.map((p) => p.slot));
    return Array.from({ length: room.maxPlayers }, (_, i) => i + 1).find((s) => !used.has(s) && !room.closed.has(s) && !room.ai.has(s));
  }

  // `rooms` with any of these fields filters on the server: query (in the room's or the host's name), hideFull,
  // hideLocked, ranked (true / false), map, pool, maxPlayers (at most), fitsMe (the caller's rating is inside the
  // room's window; needs a log-in). Without them the answer is the plain list.
  roomSearch(conn, m) {
    const keys = ["query", "hideFull", "hideLocked", "ranked", "map", "pool", "maxPlayers", "fitsMe"];
    if (!keys.some((k) => m[k] !== undefined)) return { t: "rooms", rooms: this.publicRooms() };
    const query = String(m.query ?? "").trim().toLowerCase().slice(0, 40);
    const me = m.fitsMe === true ? this.requirePlayer(conn) : null;
    const rooms = [...this.rooms.values()].filter((r) => r.status === "open").filter((r) => {
      const host = r.players.find((p) => p.playerId === r.hostId)?.name ?? "";
      if (query && !r.name.toLowerCase().includes(query) && !host.toLowerCase().includes(query)) return false;
      if (m.hideFull === true && r.players.length >= this.roomCapacity(r)) return false;
      if (m.hideLocked === true && r.password) return false;
      if (typeof m.ranked === "boolean" && r.ranked !== m.ranked) return false;
      if (m.map !== undefined && r.map.id !== String(m.map)) return false;
      if (m.pool !== undefined && r.pool !== String(m.pool)) return false;
      if (m.maxPlayers !== undefined && r.maxPlayers > Number(m.maxPlayers)) return false;
      if (me) {
        const rating = this.store.rating(me.id, r.pool);
        if (rating < r.minElo || rating > r.maxElo) return false;
      }
      return true;
    });
    return { t: "rooms", rooms: rooms.map((r) => this.publicRoom(r)), filtered: true };
  }

  broadcastRoom(room) {
    const view = this.publicRoom(room);
    for (const p of room.players) this.sendTo(p.playerId, { t: "room", room: view });
    const rooms = this.publicRooms();
    for (const conn of this.online.values()) if (conn.player && !this.roomOf(conn.player.id)) this.send(conn, { t: "rooms", rooms });
  }

  addRoomMessage(room, from, text) {
    room.messages.push({ from, text: String(text).slice(0, Math.max(200, this.chatMax)), at: Date.now() });
    if (room.messages.length > 100) room.messages.shift();
  }

  createRoom(conn, m) {
    const player = this.requirePlayer(conn);
    if (this.roomOf(player.id)) throw new Error("leave your current lobby first");
    if (this.queue.ticketOf(player.id)) throw new Error("leave the queue first");
    const pool = ["solo", "team", "ffa"].includes(m.pool) ? m.pool : "solo";
    const rating = this.store.rating(player.id, pool);
    const minElo = Number.isFinite(Number(m.minElo)) ? Number(m.minElo) : 0;
    const maxElo = Number.isFinite(Number(m.maxElo)) && Number(m.maxElo) > 0 ? Number(m.maxElo) : 9999;
    if (minElo > maxElo) throw new Error("the minimum rating is above the maximum");
    if (rating < minElo || rating > maxElo) throw new Error(`your ${pool} rating ${rating} is outside ${minElo}..${maxElo}`);
    const maxPlayers = Math.min(8, Math.max(2, Number(m.maxPlayers ?? 2) || 2));
    const map = this.catalog.get(String(m.map ?? "")) ?? this.catalog.maps[0];
    const name = String(m.name ?? "").trim().slice(0, 40) || `${player.name}'s game`;
    let password = null;
    if (m.password !== undefined && m.password !== null && m.password !== "") {
      if (typeof m.password !== "string" || m.password.length > ROOM_PASSWORD_MAX) throw new Error(`a lobby password is 1 to ${ROOM_PASSWORD_MAX} characters`);
      const salt = randomBytes(16);
      password = { salt, hash: hashRoomPassword(m.password, salt) };
    }
    const room = {
      password, kicked: new Set(), closed: new Set(), ai: new Map(),
      id: `room-${randomBytes(4).toString("hex")}`, name, hostId: player.id, minElo, maxElo, maxPlayers, pool,
      ranked: m.ranked === true, map, status: "open", messages: [], settings: roomSettings(m.settings ?? {}),
      players: [{ playerId: player.id, name: player.name, slot: 1, team: 1, rating, ready: true, civ: civOf(m.civ) }]
    };
    this.addRoomMessage(room, "", `${player.name} created the lobby.`);
    this.rooms.set(room.id, room);
    this.log(`[matchmaking] ${player.name} opens ${room.id} "${name}" (${minElo}..${maxElo}, ${map.name})`);
    this.broadcastRoom(room);
  }

  joinRoom(conn, m) {
    const player = this.requirePlayer(conn);
    const room = this.rooms.get(m.room);
    if (!room || room.status !== "open") throw new Error("that lobby is no longer open");
    if (this.roomOf(player.id) && this.roomOf(player.id) !== room) throw new Error("leave your current lobby first");
    if (this.queue.ticketOf(player.id)) throw new Error("leave the queue first");
    if (room.players.some((p) => p.playerId === player.id)) return this.broadcastRoom(room);
    if (room.kicked.has(player.id)) throw new Error("the host removed you from that lobby");
    if (room.password) {
      if (!this.roomPasswordLimit.take(conn.ip)) throw new Error("too many lobby password attempts; try again in a minute");
      const given = typeof m.password === "string" && m.password.length <= ROOM_PASSWORD_MAX ? m.password : "";
      if (!timingSafeEqual(hashRoomPassword(given, room.password.salt), room.password.hash)) throw new Error("wrong lobby password");
    }
    const slot = this.freeSlot(room);
    if (!slot) throw new Error("that lobby is full");
    const rating = this.store.rating(player.id, room.pool);
    if (rating < room.minElo || rating > room.maxElo) throw new Error(`your rating ${rating} is outside ${room.minElo}..${room.maxElo}`);
    room.players.push({ playerId: player.id, name: player.name, slot, team: slot % 2 ? 1 : 2, rating, ready: false, civ: civOf(m.civ) });
    this.addRoomMessage(room, "", `${player.name} joined the lobby.`);
    this.broadcastRoom(room);
  }

  leaveRoom(playerId) {
    const room = this.roomOf(playerId);
    if (!room) return;
    const leaving = room.players.find((p) => p.playerId === playerId);
    room.players = room.players.filter((p) => p.playerId !== playerId);
    if (!room.players.length) {
      this.rooms.delete(room.id);
      const rooms = this.publicRooms();
      for (const conn of this.online.values()) if (conn.player && !this.roomOf(conn.player.id)) this.send(conn, { t: "rooms", rooms });
      return;
    }
    this.addRoomMessage(room, "", `${leaving.name} left the lobby.`);
    if (room.hostId === playerId) {  // the next player hosts
      room.hostId = room.players[0].playerId;
      room.players[0].ready = true;
      this.addRoomMessage(room, "", `${room.players[0].name} is now the host.`);
    }
    this.broadcastRoom(room);
  }

  // Lobby chat, party chat and direct messages share one rate per player (config limits.chatPerMinute, chatBurst).
  chatAllowed(player) {
    if (!this.chatRate.take(player.id)) throw new Error("you are sending messages too fast");
  }

  roomChat(conn, m) {
    const player = this.requirePlayer(conn);
    const room = this.roomOf(player.id);
    if (!room) throw new Error("not in a lobby");
    this.moderation.checkChat(player.id, "chat");
    this.chatAllowed(player);
    const text = String(m.text ?? "").slice(0, this.chatMax);
    this.addRoomMessage(room, player.name, text);
    for (const p of room.players) this.sendTo(p.playerId, { t: "chat", room: room.id, from: player.name, text });
  }

  roomReady(conn, m) {
    const player = this.requirePlayer(conn);
    const room = this.roomOf(player.id);
    if (!room) throw new Error("not in a lobby");
    room.players.find((p) => p.playerId === player.id).ready = m.ready !== false;
    this.broadcastRoom(room);
  }

  roomStart(conn) {
    const player = this.requirePlayer(conn);
    const room = this.roomOf(player.id);
    if (!room || room.hostId !== player.id) throw new Error("only the lobby's host starts the game");
    if (room.players.length + room.ai.size < 2) throw new Error("a game needs two players");
    if (room.players.some((p) => !p.ready && p.playerId !== room.hostId)) throw new Error("not every player is ready");
    room.status = "started";
    const players = [...room.players].sort((a, b) => (b.playerId === room.hostId) - (a.playerId === room.hostId) || a.slot - b.slot);
    const participants = players.map((p, i) => ({ playerId: p.playerId, name: p.name, rating: p.rating, slot: i + 1,
      team: room.pool === "ffa" ? i + 1 : p.team, civ: p.civ ?? "" }));
    // computer players take the slots after the humans; the host's game runs them
    const ai = [...room.ai.entries()].sort((a, b) => a[0] - b[0]).map(([, a], i) => ({ name: `Computer (${a.difficulty})`,
      slot: participants.length + i + 1, team: room.pool === "ffa" ? participants.length + i + 1 : a.team, civ: a.civ, difficulty: a.difficulty }));
    const match = {
      ai,
      id: `match-${randomBytes(4).toString("hex")}`, kind: "lobby", ranked: room.ranked, settings: room.settings,
      queueId: room.pool === "solo" ? "1v1" : room.pool, pool: room.pool, map: room.map, seed: randomInt(1, 0x7fffffff),
      participants, hostPlayerId: room.hostId, accepted: new Set(), state: "accept", reports: new Map(), gone: new Set(), firstReportAt: 0
    };
    this.matches.set(match.id, match);
    this.broadcastRoom(room);
    this.rooms.delete(room.id);
    this.startMatch(match);
  }

  // A lobby player's own choices: { civ, team } (team only in team lobbies).
  roomSet(conn, m) {
    const player = this.requirePlayer(conn);
    const room = this.roomOf(player.id);
    if (!room || room.status !== "open") throw new Error("not in a lobby");
    const me = room.players.find((p) => p.playerId === player.id);
    if (m.civ !== undefined) me.civ = civOf(m.civ);
    if (m.team !== undefined && room.pool === "team") me.team = Number(m.team) === 2 ? 2 : 1;
    if (me.playerId !== room.hostId) me.ready = false;  // a change takes the ready mark back
    this.broadcastRoom(room);
  }

  // The host's lobby settings: { map, popCap, startAge, reveal }.
  roomSettings(conn, m) {
    const player = this.requirePlayer(conn);
    const room = this.roomOf(player.id);
    if (!room || room.status !== "open" || room.hostId !== player.id) throw new Error("only the lobby's host sets the game");
    if (m.map !== undefined) {
      const map = this.catalog.get(String(m.map));
      if (!map) throw new Error("no such map");
      room.map = map;
    }
    room.settings = roomSettings(m, room.settings);
    for (const p of room.players) if (p.playerId !== room.hostId) p.ready = false;
    this.addRoomMessage(room, "", `${player.name} changed the game settings.`);
    this.broadcastRoom(room);
  }

  hostRoom(conn) {
    const player = this.requirePlayer(conn);
    const room = this.roomOf(player.id);
    if (!room || room.status !== "open" || room.hostId !== player.id) throw new Error("only the lobby's host does that");
    return { player, room };
  }

  // The host removes a player; that player cannot come back to this lobby.
  roomKick(conn, m) {
    const { player, room } = this.hostRoom(conn);
    const target = room.players.find((p) => p.name.toLowerCase() === String(m.name ?? "").toLowerCase());
    if (!target) throw new Error("no such player in your lobby");
    if (target.playerId === player.id) throw new Error("you cannot remove yourself; leave instead");
    room.kicked.add(target.playerId);
    room.players = room.players.filter((p) => p.playerId !== target.playerId);
    this.addRoomMessage(room, "", `${target.name} was removed from the lobby.`);
    this.sendTo(target.playerId, { t: "room_kicked", room: room.id, by: player.name });
    this.sendTo(target.playerId, { t: "room", room: null });
    this.broadcastRoom(room);
  }

  // The host moves a player to another slot (swapping with a player there) and / or team.
  roomMove(conn, m) {
    const { room } = this.hostRoom(conn);
    const target = room.players.find((p) => p.name.toLowerCase() === String(m.name ?? "").toLowerCase());
    if (!target) throw new Error("no such player in your lobby");
    if (m.slot !== undefined) {
      const slot = Number(m.slot);
      if (!Number.isInteger(slot) || slot < 1 || slot > room.maxPlayers) throw new Error(`a slot is 1 to ${room.maxPlayers}`);
      if (room.closed.has(slot) || room.ai.has(slot)) throw new Error("that slot is not free");
      const other = room.players.find((p) => p.slot === slot);
      if (other) other.slot = target.slot;
      target.slot = slot;
    }
    if (m.team !== undefined) {
      if (room.pool !== "team") throw new Error("teams are set in team lobbies");
      const team = Number(m.team);
      if (!Number.isInteger(team) || team < 1 || team > 4) throw new Error("a team is 1 to 4");
      target.team = team;
    }
    if (target.playerId !== room.hostId) target.ready = false;
    this.broadcastRoom(room);
  }

  // The host opens or closes a slot, or puts a computer player in it: { slot, state: open | closed | ai,
  // difficulty?, civ?, team? }. Computer players only in unranked lobbies.
  roomSlot(conn, m) {
    const { room } = this.hostRoom(conn);
    const slot = Number(m.slot);
    if (!Number.isInteger(slot) || slot < 1 || slot > room.maxPlayers) throw new Error(`a slot is 1 to ${room.maxPlayers}`);
    if (room.players.some((p) => p.slot === slot)) throw new Error("a player is in that slot");
    room.closed.delete(slot);
    room.ai.delete(slot);
    if (m.state === "closed") room.closed.add(slot);
    else if (m.state === "ai") {
      if (room.ranked) throw new Error("no computer players in a ranked lobby");
      const difficulty = AI_DIFFICULTIES.includes(m.difficulty) ? m.difficulty : "moderate";
      const team = room.pool === "team" && [1, 2, 3, 4].includes(Number(m.team)) ? Number(m.team) : slot % 2 ? 1 : 2;
      room.ai.set(slot, { difficulty, civ: civOf(m.civ), team });
    } else if (m.state !== "open") throw new Error("a slot is open, closed or ai");
    this.broadcastRoom(room);
  }

  // The host hands the lobby to another player in it.
  roomHost(conn, m) {
    const { room } = this.hostRoom(conn);
    const target = room.players.find((p) => p.name.toLowerCase() === String(m.name ?? "").toLowerCase());
    if (!target) throw new Error("no such player in your lobby");
    room.hostId = target.playerId;
    target.ready = true;
    this.addRoomMessage(room, "", `${target.name} is now the host.`);
    this.broadcastRoom(room);
  }

  // ---- log-in follow-ups, presence, friends, direct messages ----------------------------------------------------
  afterAuth(conn) {
    const id = conn.player.id;
    // a control link that came back during a running match: the player is no longer gone
    for (const match of this.matches.values())
      if (match.state === "playing" && match.gone.has(id) && match.participants.some((p) => p.playerId === id)) {
        match.gone.delete(id);
        this.log(`[matchmaking] ${match.id}: ${conn.player.name} is back`);
        this.send(conn, { t: "match_resumed", match: match.id });
      }
    this.sendFriends(id);
    const waiting = this.store.undelivered(id);
    for (const d of waiting) this.send(conn, { t: "dm", from: d.sender, to: conn.player.name, text: d.text, at: d.at, offline: true });
    this.store.markDelivered(waiting.map((d) => d.id));
    const party = this.partyOf(id);
    if (party) this.broadcastParty(party);
    for (const p of this.parties.values())
      if (p.invites.has(id)) this.send(conn, { t: "party_invite", party: p.id, from: this.store.player(p.leaderId)?.name });
    this.refreshPresence();
  }

  // offline | in_game | looking | in_lobby | idle
  presenceOf(playerId) {
    if (!this.online.has(playerId)) return "offline";
    for (const match of this.matches.values())
      if (match.state === "playing" && !match.gone.has(playerId) && match.participants.some((p) => p.playerId === playerId)) return "in_game";
    if (this.queue.ticketOf(playerId) || [...this.matches.values()].some((mt) => mt.state === "accept" && mt.participants.some((p) => p.playerId === playerId)))
      return "looking";
    if (this.roomOf(playerId)) return "in_lobby";
    return "idle";
  }

  // Tells friends and party members every presence that changed since they were last told.
  refreshPresence() {
    const ids = new Set([...this.presence.keys(), ...this.online.keys()]);
    for (const id of ids) {
      const now = this.presenceOf(id);
      if (this.presence.get(id) === now) continue;
      this.presence.set(id, now);
      const name = this.store.player(id)?.name;
      const told = new Set();
      for (const f of this.store.friends(id)) if (f.state === "friend") told.add(f.id);
      const party = this.partyOf(id);
      if (party) for (const pid of party.members) if (pid !== id) told.add(pid);
      for (const to of told) this.sendTo(to, { t: "presence", name, presence: now });
      if (now === "offline") this.presence.delete(id);
    }
  }

  sendFriends(playerId) {
    const friends = this.store.friends(playerId).map((f) => ({ name: f.name, state: f.state, presence: f.state === "friend" ? this.presenceOf(f.id) : "" }));
    this.sendTo(playerId, { t: "friends", friends });
  }

  friendAdd(conn, m) {
    const player = this.requirePlayer(conn);
    const other = this.store.playerByName(m.name);
    if (!other) throw new Error("no such player");
    const state = this.store.friendRequest(player.id, other.id);
    this.log(`[matchmaking] ${player.name} -> ${other.name}: friend ${state}`);
    if (state === "pending") this.sendTo(other.id, { t: "friend_request", from: player.name });
    this.sendFriends(player.id), this.sendFriends(other.id);
  }

  friendAccept(conn, m) {
    const player = this.requirePlayer(conn);
    const other = this.store.playerByName(m.name);
    if (!other) throw new Error("no such player");
    this.store.friendAccept(player.id, other.id);
    this.log(`[matchmaking] ${player.name} and ${other.name} are friends`);
    this.sendFriends(player.id), this.sendFriends(other.id);
  }

  friendRemove(conn, m) {
    const player = this.requirePlayer(conn);
    const other = this.store.playerByName(m.name);
    if (!other) throw new Error("no such player");
    this.store.friendRemove(player.id, other.id);
    this.sendFriends(player.id), this.sendFriends(other.id);
  }

  // A direct message: to a friend or a party member (a stranger's would be spam); kept for an offline player.
  directMessage(conn, m) {
    const player = this.requirePlayer(conn);
    const other = this.store.playerByName(m.to);
    if (!other) throw new Error("no such player");
    const party = this.partyOf(player.id);
    if (!this.store.areFriends(player.id, other.id) && !(party && party.members.includes(other.id)))
      throw new Error(`${other.name} is not your friend`);
    const text = String(m.text ?? "").slice(0, this.dmMax);
    if (!text) throw new Error("an empty message");
    this.moderation.checkChat(player.id, "dm");
    this.chatAllowed(player);
    const { id, at } = this.store.addDirectMessage(player.id, other.id, text);
    const message = { t: "dm", from: player.name, to: other.name, text, at };
    if (this.online.has(other.id)) {
      this.sendTo(other.id, message);
      this.store.markDelivered([id]);
    }
    this.send(conn, { ...message, delivered: this.online.has(other.id) });
  }

  // ---- parties ---------------------------------------------------------------------------------------------------
  // A party stays together across games: its leader queues it as one ticket (team queue), its members land on one
  // team. Members who go offline stay in it (their control link may come back); the leader's leaving passes the lead on.
  partyOf(playerId) {
    for (const party of this.parties.values()) if (party.members.includes(playerId)) return party;
    return null;
  }

  publicParty(party) {
    return {
      id: party.id, leader: this.store.player(party.leaderId)?.name,
      members: party.members.map((id) => ({ name: this.store.player(id)?.name, presence: this.presenceOf(id), leader: id === party.leaderId,
        civ: party.civs.get(id) ?? "" })),
      invited: [...party.invites].map((id) => this.store.player(id)?.name), messages: party.messages.slice(-30)
    };
  }

  broadcastParty(party) {
    const view = this.publicParty(party);
    for (const id of party.members) this.sendTo(id, { t: "party", party: view });
  }

  partyInvite(conn, m) {
    const player = this.requirePlayer(conn);
    const other = this.store.playerByName(m.name);
    if (!other) throw new Error("no such player");
    if (other.id === player.id) throw new Error("you are in your own party");
    if (!this.online.has(other.id)) throw new Error(`${other.name} is offline`);
    let party = this.partyOf(player.id);
    if (party && party.leaderId !== player.id) throw new Error("only the party's leader invites");
    if (party?.members.includes(other.id)) throw new Error(`${other.name} is in your party`);
    if (!party) {
      if (this.queue.ticketOf(player.id)) throw new Error("leave the queue first");
      party = { id: `party-${randomBytes(4).toString("hex")}`, leaderId: player.id, members: [player.id], invites: new Set(), messages: [], civs: new Map() };
      this.parties.set(party.id, party);
    }
    party.invites.add(other.id);
    this.log(`[matchmaking] ${player.name} invites ${other.name} to ${party.id}`);
    this.sendTo(other.id, { t: "party_invite", party: party.id, from: player.name });
    this.broadcastParty(party);
  }

  partyAccept(conn, m) {
    const player = this.requirePlayer(conn);
    const party = this.parties.get(m.party);
    if (!party || !party.invites.has(player.id)) throw new Error("no such party invitation");
    if (party.members.length >= 4) throw new Error("that party is full");
    if (this.activeMatch(player.id)) throw new Error("you are in a match");
    if (this.partyOf(player.id)) this.partyLeave(player.id);
    this.leaveQueue(player.id, `${player.name} joined a party`);
    this.leaveQueue(party.leaderId, `${player.name} joined the party`);  // the party's ticket no longer fits
    party.invites.delete(player.id);
    party.members.push(player.id);
    party.messages.push({ from: "", text: `${player.name} joined the party.`, at: this.now() });
    this.log(`[matchmaking] ${player.name} joins ${party.id}`);
    this.broadcastParty(party);
  }

  partyDecline(conn, m) {
    const player = this.requirePlayer(conn);
    const party = this.parties.get(m.party);
    if (!party || !party.invites.delete(player.id)) throw new Error("no such party invitation");
    this.broadcastParty(party);
    this.send(conn, { t: "party_invite_closed", party: party.id });
  }

  partyLeave(playerId) {
    const party = this.partyOf(playerId);
    if (!party) return;
    this.leaveQueue(playerId, `${this.store.player(playerId)?.name} left the party`);
    party.members = party.members.filter((id) => id !== playerId);
    if (party.leaderId === playerId && party.members.length) party.leaderId = party.members[0];
    if (party.members.length <= 1) {  // a party of one is no party
      this.parties.delete(party.id);
      for (const id of party.members) this.sendTo(id, { t: "party", party: null });
      return;
    }
    party.messages.push({ from: "", text: `${this.store.player(playerId)?.name} left the party.`, at: this.now() });
    this.broadcastParty(party);
  }

  partyChat(conn, m) {
    const player = this.requirePlayer(conn);
    const party = this.partyOf(player.id);
    if (!party) throw new Error("not in a party");
    this.moderation.checkChat(player.id, "chat");
    this.chatAllowed(player);
    const text = String(m.text ?? "").slice(0, this.chatMax);
    party.messages.push({ from: player.name, text, at: this.now() });
    if (party.messages.length > 100) party.messages.shift();
    for (const id of party.members) this.sendTo(id, { t: "party_chat", party: party.id, from: player.name, text });
  }

  // ---- replays (the game client's own; kept with the match for its history) ---------------------------------------
  // { match, offset, data (base64), last }: every player of the match sends its replay in chunks; the longest is kept.
  replayUpload(conn, m) {
    const player = this.requirePlayer(conn);
    const matchId = String(m.match ?? "");
    if (!this.store.inMatch(matchId, player.id)) throw new Error("not in that match");
    const key = `${matchId}|${player.id}`;
    const chunk = Buffer.from(String(m.data ?? ""), "base64");
    const parts = Number(m.offset) === 0 ? [] : this.uploads.get(key);
    if (!parts) throw new Error("replay chunks out of order");
    const size = parts.reduce((sum, b) => sum + b.length, 0);
    if (size !== Number(m.offset)) throw new Error("replay chunks out of order");
    if (size + chunk.length > this.replayMax) {
      this.uploads.delete(key);
      throw new Error("the replay is too large");
    }
    parts.push(chunk);
    this.uploads.set(key, parts);
    if (!m.last) return undefined;
    this.uploads.delete(key);
    const data = Buffer.concat(parts);
    // the longest one is kept: a player who left early recorded less of the game
    const kept = (this.store.replay(matchId)?.size ?? -1) < data.length;
    if (kept) this.store.putReplay(matchId, player.id, data);
    this.log(`[matchmaking] ${matchId}: replay from ${player.name}, ${data.length} bytes${kept ? "" : " (a longer one is kept)"}`);
    return this.send(conn, { t: "replay_stored", match: matchId, size: data.length, kept });
  }

  replayGet(conn, m) {
    this.requirePlayer(conn);
    const replay = this.store.replay(String(m.match ?? ""));
    if (!replay) throw new Error("no replay for that match");
    const { data } = replay;
    for (let offset = 0; offset < data.length || offset === 0; offset += REPLAY_CHUNK) {
      const part = data.subarray(offset, offset + REPLAY_CHUNK);
      this.send(conn, { t: "replay_chunk", match: m.match, offset, size: data.length, data: part.toString("base64"),
        last: offset + REPLAY_CHUNK >= data.length });
      if (!data.length) break;
    }
  }
}
