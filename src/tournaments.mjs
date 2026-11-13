// Single-elimination 1v1 tournaments, after Empire League's tournaments (tournament-*.mjs, database 017-021; MIT, see
// LICENSE.empire-league): a moderator or admin creates one with a registration window, an optional password and an
// optional maximum rating; at the window's end (or when staff start it early) the players are seeded by their 1v1
// rating into a bracket (byes to the top seeds), and each round's matches are made by the server on that round's map.
// A match is offered as any other (match_found, accept, match_start) when both players are online and free; its
// result comes from the usual result flow. A player who does not turn up within the no-show time loses by walkover.
// Tournament games change no rating. Tournament chat goes to the registered players.
//
// Tables are new ones (an older image ignores them). Live state (offers, who accepted) is in memory; after a restart a
// match that was being played is offered again.
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { roleRank } from "./moderation-store.mjs";

export const TOURNAMENT_DEFAULTS = Object.freeze({ maxPlayers: 64, retrySeconds: 30, defaultNoShowMinutes: 10, maxOpen: 20 });
const PASSWORD_MAX = 64;
const hashPassword = (password, salt) => scryptSync(password, salt, 32);
const text = (value, max) => String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max);

// The bracket positions of seeds 1..size, so that seed 1 meets seed 2 only in the final: [1, 8, 4, 5, 2, 7, 3, 6].
export function seedOrder(size) {
  let order = [1];
  while (order.length < size) {
    const n = order.length * 2;
    order = order.flatMap((s) => [s, n + 1 - s]);
  }
  return order;
}

export const bracketSize = (players) => 2 ** Math.ceil(Math.log2(Math.max(2, players)));

export class TournamentStore {
  constructor(db) {
    this.db = db;
    db.exec(`
      CREATE TABLE IF NOT EXISTS tournaments (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, format TEXT NOT NULL, status TEXT NOT NULL, created_by TEXT NOT NULL,
        created_at INTEGER NOT NULL, registration_ends_at INTEGER NOT NULL, max_players INTEGER NOT NULL, max_rating INTEGER,
        pw_salt BLOB, pw_hash BLOB, maps TEXT NOT NULL, no_show_ms INTEGER NOT NULL, winner_id INTEGER,
        started_at INTEGER, completed_at INTEGER);
      CREATE TABLE IF NOT EXISTS tournament_players (
        tournament_id TEXT NOT NULL, player_id INTEGER NOT NULL, rating INTEGER NOT NULL, seed INTEGER,
        registered_at INTEGER NOT NULL, PRIMARY KEY (tournament_id, player_id));
      CREATE TABLE IF NOT EXISTS tournament_matches (
        tournament_id TEXT NOT NULL, round INTEGER NOT NULL, position INTEGER NOT NULL, player1_id INTEGER, player2_id INTEGER,
        winner_id INTEGER, match_id TEXT, status TEXT NOT NULL, map_id TEXT, ready_at INTEGER,
        PRIMARY KEY (tournament_id, round, position));
    `);
  }

  get(id) {
    return this.db.prepare("SELECT * FROM tournaments WHERE id = ?").get(String(id ?? "")) ?? null;
  }

  all(limit = 50) {
    return this.db.prepare("SELECT * FROM tournaments ORDER BY created_at DESC LIMIT ?").all(limit);
  }

  byStatus(...statuses) {
    return this.db.prepare(`SELECT * FROM tournaments WHERE status IN (${statuses.map(() => "?").join(",")})`).all(...statuses);
  }

  players(id) {
    return this.db.prepare(`SELECT tp.*, p.name FROM tournament_players tp JOIN players p ON p.id = tp.player_id
      WHERE tp.tournament_id = ? ORDER BY tp.seed IS NULL, tp.seed, tp.registered_at`).all(id);
  }

  isPlayer(id, playerId) {
    return Boolean(this.db.prepare("SELECT 1 FROM tournament_players WHERE tournament_id = ? AND player_id = ?").get(id, playerId));
  }

  matches(id) {
    return this.db.prepare("SELECT * FROM tournament_matches WHERE tournament_id = ? ORDER BY round, position").all(id);
  }

  match(id, round, position) {
    return this.db.prepare("SELECT * FROM tournament_matches WHERE tournament_id = ? AND round = ? AND position = ?").get(id, round, position) ?? null;
  }

  setMatch(id, round, position, fields) {
    const keys = Object.keys(fields);
    this.db.prepare(`UPDATE tournament_matches SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE tournament_id = ? AND round = ? AND position = ?`)
      .run(...keys.map((k) => fields[k]), id, round, position);
  }

  set(id, fields) {
    const keys = Object.keys(fields);
    this.db.prepare(`UPDATE tournaments SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`).run(...keys.map((k) => fields[k]), id);
  }
}

export class Tournaments {
  constructor({ mm, config = {} }) {
    this.mm = mm;
    this.store = mm.store;
    this.db = new TournamentStore(mm.store.db);
    this.config = { ...TOURNAMENT_DEFAULTS, ...config };
    this.live = new Map();    // "id|round|position" -> { accepted: Set, missed: Set, nextTryAt }
    this.chats = new Map();   // tournament id -> [{ from, text, at }]
    this.lastTick = 0;
    // a match that was offered or played before a restart is offered again
    for (const t of this.db.byStatus("running"))
      for (const m of this.db.matches(t.id))
        if (m.status === "playing") this.db.setMatch(t.id, m.round, m.position, { status: "ready", match_id: null, ready_at: mm.now() });
  }

  get now() {
    return this.mm.now();
  }

  key(t, round, position) {
    return `${t}|${round}|${position}`;
  }

  liveOf(t, round, position) {
    const k = this.key(t, round, position);
    if (!this.live.has(k)) this.live.set(k, { accepted: new Set(), missed: new Set(), nextTryAt: 0 });
    return this.live.get(k);
  }

  name(playerId) {
    return playerId ? this.store.player(playerId)?.name ?? null : null;
  }

  // ---- views --------------------------------------------------------------------------------------------------
  summary(t) {
    const players = this.db.players(t.id).length;
    return { id: t.id, name: t.name, format: t.format, status: t.status, players, maxPlayers: t.max_players, maxRating: t.max_rating ?? null,
      locked: Boolean(t.pw_hash), registrationEndsAt: t.registration_ends_at, startedAt: t.started_at ?? null, completedAt: t.completed_at ?? null,
      winner: this.name(t.winner_id), createdBy: t.created_by };
  }

  list() {
    return this.db.all().map((t) => this.summary(t));
  }

  // The tournament with its players and bracket (public); with the chat for a registered player or staff.
  view(id, viewer = null) {
    const t = this.db.get(id);
    if (!t) return null;
    const maps = JSON.parse(t.maps);
    const out = {
      ...this.summary(t), maps: maps.map((m) => this.mm.catalog.get(m)?.name ?? m),
      noShowMinutes: Math.round(t.no_show_ms / 60_000),
      players: this.db.players(t.id).map((p) => ({ name: p.name, rating: p.rating, seed: p.seed ?? null })),
      bracket: this.db.matches(t.id).map((m) => ({ round: m.round, position: m.position, player1: this.name(m.player1_id), player2: this.name(m.player2_id),
        winner: this.name(m.winner_id), status: m.status, match: m.match_id ?? null, map: this.mm.catalog.get(m.map_id)?.name ?? m.map_id ?? null,
        readyAt: m.ready_at ?? null }))
    };
    if (viewer && (this.db.isPlayer(t.id, viewer.id) || this.isStaff(viewer.id))) out.chat = (this.chats.get(t.id) ?? []).slice(-50);
    return out;
  }

  isStaff(playerId) {
    return roleRank(this.store.mod.role(playerId)) >= roleRank("moderator");
  }

  // Tells the registered players who are online (and staff watching it) the tournament as it is now.
  push(id) {
    for (const p of this.db.players(id)) {
      const conn = this.mm.online.get(p.player_id);
      if (conn) this.mm.send(conn, { t: "tournament", tournament: this.view(id, conn.player) });
    }
  }

  // ---- staff actions ------------------------------------------------------------------------------------------
  staff(conn) {
    const player = this.mm.requirePlayer(conn);
    const actor = this.mm.moderation.actorFor(player);
    this.mm.moderation.need(actor, "moderator");
    return actor;
  }

  create(actor, m) {
    const name = text(m.name, 60);
    if (!name) throw new Error("a tournament needs a name");
    if (this.db.byStatus("registration", "running").length >= this.config.maxOpen) throw new Error("too many tournaments are open");
    const maxPlayers = Number(m.maxPlayers ?? 16);
    if (!Number.isInteger(maxPlayers) || maxPlayers < 2 || maxPlayers > this.config.maxPlayers) throw new Error(`maxPlayers is 2 to ${this.config.maxPlayers}`);
    const minutes = Number(m.registrationMinutes ?? 60);
    if (!Number.isFinite(minutes) || minutes < 1 || minutes > 14 * 1440) throw new Error("registrationMinutes is 1 to 20160");
    const noShow = Number(m.noShowMinutes ?? this.config.defaultNoShowMinutes);
    if (!Number.isFinite(noShow) || noShow < 1 || noShow > 120) throw new Error("noShowMinutes is 1 to 120");
    const maxRating = m.maxRating === undefined || m.maxRating === null ? null : Number(m.maxRating);
    if (maxRating !== null && (!Number.isInteger(maxRating) || maxRating < 1)) throw new Error("maxRating must be a whole number");
    const rounds = Math.log2(bracketSize(maxPlayers));
    const given = Array.isArray(m.maps) ? m.maps.map(String) : m.map ? [String(m.map)] : [];
    for (const id of given) if (!this.mm.catalog.get(id)) throw new Error(`no such map ${id}`);
    const maps = given.length ? given : [this.mm.catalog.maps[0].id];
    while (maps.length < rounds) maps.push(maps.at(-1));  // the last given map for the remaining rounds
    let salt = null, hash = null;
    if (m.password !== undefined && m.password !== null && m.password !== "") {
      if (typeof m.password !== "string" || m.password.length > PASSWORD_MAX) throw new Error(`a tournament password is 1 to ${PASSWORD_MAX} characters`);
      salt = randomBytes(16);
      hash = hashPassword(m.password, salt);
    }
    const id = `tour-${randomBytes(4).toString("hex")}`;
    this.store.db.prepare(`INSERT INTO tournaments (id, name, format, status, created_by, created_at, registration_ends_at, max_players, max_rating,
      pw_salt, pw_hash, maps, no_show_ms, winner_id) VALUES (?, ?, '1v1', 'registration', ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`)
      .run(id, name, actor.name, this.now, this.now + Math.round(minutes * 60_000), maxPlayers, maxRating, salt, hash, JSON.stringify(maps.slice(0, rounds)),
        Math.round(noShow * 60_000));
    this.mm.moderation.audit(actor, "tournament_create", null, { tournament: id, name });
    return id;
  }

  // Seeds the registered players and makes the bracket; fewer than two players cancel it.
  start(id, actor = null) {
    const t = this.db.get(id);
    if (!t || t.status !== "registration") throw new Error("that tournament is not open for registration");
    const players = this.db.players(id).map((p) => ({ ...p, rating: this.store.rating(p.player_id, "solo") }))
      .sort((a, b) => b.rating - a.rating || a.registered_at - b.registered_at);
    if (actor) this.mm.moderation.audit(actor, "tournament_start", null, { tournament: id });
    if (players.length < 2) {
      this.db.set(id, { status: "cancelled", completed_at: this.now });
      this.push(id);
      return;
    }
    const size = bracketSize(players.length);
    const order = seedOrder(size);
    const maps = JSON.parse(t.maps);
    const db = this.store.db;
    db.exec("BEGIN");
    try {
      players.forEach((p, i) => db.prepare("UPDATE tournament_players SET seed = ?, rating = ? WHERE tournament_id = ? AND player_id = ?").run(i + 1, p.rating, id, p.player_id));
      const bySeed = (s) => players[s - 1]?.player_id ?? null;
      for (let round = 1, count = size / 2; count >= 1; round += 1, count /= 2)
        for (let position = 1; position <= count; position += 1) {
          const p1 = round === 1 ? bySeed(order[(position - 1) * 2]) : null;
          const p2 = round === 1 ? bySeed(order[(position - 1) * 2 + 1]) : null;
          db.prepare(`INSERT INTO tournament_matches (tournament_id, round, position, player1_id, player2_id, status, map_id)
            VALUES (?, ?, ?, ?, ?, 'waiting', ?)`).run(id, round, position, p1, p2, maps[round - 1] ?? maps.at(-1));
        }
      this.db.set(id, { status: "running", started_at: this.now });
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    for (const m of this.db.matches(id).filter((x) => x.round === 1)) {
      if (m.player1_id && m.player2_id) this.db.setMatch(id, 1, m.position, { status: "ready", ready_at: this.now });
      else this.finish(id, 1, m.position, m.player1_id ?? m.player2_id, "bye");
    }
    this.mm.log.event("info", "tournament_started", { tournament: id, players: players.length });
    this.push(id);
  }

  // A match is decided: the winner moves on; the final ends the tournament.
  finish(id, round, position, winnerId, status = "done") {
    this.db.setMatch(id, round, position, { winner_id: winnerId, status });
    this.live.delete(this.key(id, round, position));
    const rounds = Math.max(...this.db.matches(id).map((m) => m.round));
    if (round === rounds) {
      this.db.set(id, { status: "completed", winner_id: winnerId, completed_at: this.now });
      this.mm.log.event("info", "tournament_completed", { tournament: id, winner: this.name(winnerId) });
      return;
    }
    const next = Math.ceil(position / 2);
    this.db.setMatch(id, round + 1, next, position % 2 ? { player1_id: winnerId } : { player2_id: winnerId });
    const m = this.db.match(id, round + 1, next);
    if (m.player1_id && m.player2_id) this.db.setMatch(id, round + 1, next, { status: "ready", ready_at: this.now });
  }

  cancel(actor, id) {
    const t = this.db.get(id);
    if (!t || !["registration", "running"].includes(t.status)) throw new Error("that tournament is over");
    this.db.set(id, { status: "cancelled", completed_at: this.now });
    for (const match of this.mm.matches.values()) if (match.tournament?.id === id && match.state === "accept") this.mm.cancelMatch(match, "the tournament was cancelled");
    this.mm.moderation.audit(actor, "tournament_cancel", null, { tournament: id });
    this.push(id);
  }

  // Staff settle a disputed (or any undecided) match: { id, round, position, winner (name) }.
  setWinner(actor, m) {
    const t = this.db.get(m.id);
    if (!t || t.status !== "running") throw new Error("that tournament is not running");
    const tm = this.db.match(t.id, Number(m.round), Number(m.position));
    if (!tm || ["done", "walkover", "bye"].includes(tm.status)) throw new Error("no undecided match there");
    const winner = this.store.playerByName(m.winner);
    if (!winner || ![tm.player1_id, tm.player2_id].includes(winner.id)) throw new Error("the winner must be one of the match's players");
    if (tm.status === "playing") throw new Error("that match is being played");
    this.finish(t.id, tm.round, tm.position, winner.id, "done");
    this.mm.moderation.audit(actor, "tournament_set_winner", { id: winner.id, name: winner.name }, { tournament: t.id, round: tm.round, position: tm.position });
    this.push(t.id);
  }

  // ---- players ------------------------------------------------------------------------------------------------
  join(conn, m) {
    const player = this.mm.requirePlayer(conn);
    const t = this.db.get(m.id);
    if (!t || t.status !== "registration") throw new Error("that tournament is not open for registration");
    if (this.db.isPlayer(t.id, player.id)) return;
    if (this.db.players(t.id).length >= t.max_players) throw new Error("that tournament is full");
    const rating = this.store.rating(player.id, "solo");
    if (t.max_rating !== null && rating > t.max_rating) throw new Error(`your 1v1 rating ${rating} is above this tournament's ${t.max_rating}`);
    if (t.pw_hash) {
      if (!this.mm.roomPasswordLimit.take(conn.ip)) throw new Error("too many password attempts; try again in a minute");
      const given = typeof m.password === "string" && m.password.length <= PASSWORD_MAX ? m.password : "";
      if (!timingSafeEqual(hashPassword(given, Buffer.from(t.pw_salt)), Buffer.from(t.pw_hash))) throw new Error("wrong tournament password");
    }
    this.store.db.prepare("INSERT INTO tournament_players (tournament_id, player_id, rating, registered_at) VALUES (?, ?, ?, ?)").run(t.id, player.id, rating, this.now);
    this.push(t.id);
  }

  leave(conn, m) {
    const player = this.mm.requirePlayer(conn);
    const t = this.db.get(m.id);
    if (!t || t.status !== "registration") throw new Error("only during registration");
    this.store.db.prepare("DELETE FROM tournament_players WHERE tournament_id = ? AND player_id = ?").run(t.id, player.id);
    this.mm.send(conn, { t: "tournament", tournament: this.view(t.id, player) });
    this.push(t.id);
  }

  chat(conn, m) {
    const player = this.mm.requirePlayer(conn);
    const t = this.db.get(m.id);
    if (!t) throw new Error("no such tournament");
    if (!this.db.isPlayer(t.id, player.id) && !this.isStaff(player.id)) throw new Error("not in that tournament");
    this.mm.moderation.checkChat(player.id, "chat");
    this.mm.chatAllowed(player);
    const body = text(m.text, this.mm.chatMax);
    if (!body) throw new Error("an empty message");
    const message = { from: player.name, text: body, at: this.now };
    const list = this.chats.get(t.id) ?? [];
    list.push(message);
    if (list.length > 100) list.shift();
    this.chats.set(t.id, list);
    const to = new Set(this.db.players(t.id).map((p) => p.player_id));
    to.add(player.id);
    for (const id of to) this.mm.sendTo(id, { t: "tournament_chat", id: t.id, ...message });
  }

  // ---- the server's side: start at the window's end, offer ready matches, walkovers ------------------------------
  tick(now) {
    if (now - this.lastTick < 1000) return;
    this.lastTick = now;
    for (const t of this.db.byStatus("registration")) if (t.registration_ends_at <= now) this.start(t.id);
    for (const t of this.db.byStatus("running")) {
      let changed = false;
      for (const m of this.db.matches(t.id)) {
        if (m.status !== "ready") continue;
        if (now - m.ready_at >= t.no_show_ms) {
          this.finish(t.id, m.round, m.position, this.walkoverWinner(t, m), "walkover");
          changed = true;
          continue;
        }
        if (this.offer(t, m, now)) changed = true;
      }
      if (changed) this.push(t.id);
    }
  }

  // Who goes on when the no-show time is up: a player who turned up (accepted an offer, or is online and free now)
  // against one who did not; if both or neither did, the one who accepted, then the higher seed.
  walkoverWinner(t, m) {
    const live = this.liveOf(t.id, m.round, m.position);
    const seedOf = (id) => this.db.players(t.id).find((p) => p.player_id === id)?.seed ?? 999;
    const here = (id) => live.accepted.has(id) || (this.mm.online.has(id) && !this.mm.activeMatch(id));
    const [a, b] = [m.player1_id, m.player2_id];
    if (here(a) !== here(b)) return here(a) ? a : b;
    if (live.accepted.has(a) !== live.accepted.has(b)) return live.accepted.has(a) ? a : b;
    if (live.missed.has(a) !== live.missed.has(b)) return live.missed.has(a) ? b : a;
    return seedOf(a) <= seedOf(b) ? a : b;
  }

  offer(t, m, now) {
    const live = this.liveOf(t.id, m.round, m.position);
    if (now < live.nextTryAt) return false;
    const ids = [m.player1_id, m.player2_id];
    for (const id of ids) if (!this.mm.online.has(id) || this.mm.activeMatch(id)) return false;
    for (const id of ids) {
      this.mm.leaveQueue(id, "your tournament match is ready");
      const room = this.mm.roomOf(id);
      if (room?.status === "open") this.mm.leaveRoom(id);
    }
    const map = this.mm.catalog.get(m.map_id) ?? this.mm.catalog.maps[0];
    const matchId = this.mm.offerMatch({ ids, map, kind: "tournament", tournament: { id: t.id, name: t.name, round: m.round, position: m.position } });
    this.db.setMatch(t.id, m.round, m.position, { status: "playing", match_id: matchId });
    return true;
  }

  // The offer was not taken up (declined, the accept time ran out, someone went offline): offered again later.
  onCancelled(match) {
    const { id, round, position } = match.tournament;
    const tm = this.db.match(id, round, position);
    if (!tm || tm.match_id !== match.id) return;
    const live = this.liveOf(id, round, position);
    for (const p of match.participants) (match.accepted.has(p.playerId) ? live.accepted : live.missed).add(p.playerId);
    live.nextTryAt = this.now + this.config.retrySeconds * 1000;
    const t = this.db.get(id);
    this.db.setMatch(id, round, position, { status: t?.status === "running" ? "ready" : "cancelled", match_id: null });
    this.push(id);
  }

  // The result flow settled the match: a clear winner moves on; a contested one waits for staff.
  onResult(match, status, winners) {
    const { id, round, position } = match.tournament;
    const tm = this.db.match(id, round, position);
    if (!tm || tm.match_id !== match.id) return;
    const winner = status === "completed" ? match.participants.find((p) => winners?.includes(p.slot)) : null;
    if (winner) this.finish(id, round, position, winner.playerId, "done");
    else {
      this.db.setMatch(id, round, position, { status: "disputed" });
      this.mm.notifyStaff({ t: "tournament_disputed", id, round, position, match: match.id });
    }
    this.push(id);
  }

  // ---- the game protocol ------------------------------------------------------------------------------------
  handle(conn, m) {
    if (m.t !== "tournaments" && !String(m.t).startsWith("tournament_")) return false;
    const mm = this.mm;
    const viewer = conn.player;
    const answer = (id) => mm.send(conn, { t: "tournament", tournament: this.view(id, viewer) });
    switch (m.t) {
      case "tournaments": mm.send(conn, { t: "tournaments", tournaments: this.list() }); break;
      case "tournament_get": {
        const v = this.view(m.id, viewer);
        if (!v) throw new Error("no such tournament");
        mm.send(conn, { t: "tournament", tournament: v });
        break;
      }
      case "tournament_create": answer(this.create(this.staff(conn), m)); break;
      case "tournament_start": this.start(String(m.id ?? ""), this.staff(conn)); answer(m.id); break;
      case "tournament_cancel": this.cancel(this.staff(conn), String(m.id ?? "")); answer(m.id); break;
      case "tournament_set_winner": this.setWinner(this.staff(conn), m); answer(m.id); break;
      case "tournament_join": this.join(conn, m); answer(m.id); break;
      case "tournament_leave": this.leave(conn, m); break;
      case "tournament_chat": this.chat(conn, m); break;
      default: throw new Error(`unknown request ${m.t}`);
    }
    return true;
  }
}
