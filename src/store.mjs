// Accounts, ratings, matches. empire-league keeps these in MySQL / MariaDB behind Steam sign-in; here they are a local
// SQLite file (node:sqlite, built into Node 22.13+, so no database server and no npm packages) with plain local
// accounts: a name and a scrypt password hash. Session tokens are stored as SHA-256 hashes (as upstream's
// auth_sessions.token_hash).
import { DatabaseSync } from "node:sqlite";
import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { CASUAL_POOLS, POOLS, isCasualPool } from "./rating-pool.mjs";
import { START_RATING, divisionForRating, ffaRatingChanges, teamRatingChange } from "./elo.mjs";

const SESSION_MS = 30 * 24 * 60 * 60 * 1000;
// The account rules (config "accounts"); a Store made without them keeps these.
const ACCOUNT_RULES = Object.freeze({ maxAccounts: 0, nameMin: 3, nameMax: 24, passwordMin: 8, passwordMax: 128, reservedNames: [] });
const NAME_CHARS = /^[A-Za-z0-9_.-]+$/;

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const hashPassword = (password, salt) => scryptSync(password, salt, 32).toString("hex");

export class Store {
  constructor(file = ":memory:", { accounts = {} } = {}) {
    this.rules = { ...ACCOUNT_RULES, ...accounts };
    this.reserved = new Set(this.rules.reservedNames.map((n) => String(n).toLowerCase()));
    this.db = new DatabaseSync(file);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS players (
        id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE COLLATE NOCASE,
        pw_salt TEXT NOT NULL, pw_hash TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS ratings (
        player_id INTEGER NOT NULL, pool TEXT NOT NULL, rating INTEGER NOT NULL, peak INTEGER NOT NULL,
        wins INTEGER NOT NULL DEFAULT 0, losses INTEGER NOT NULL DEFAULT 0, streak INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (player_id, pool));
      CREATE TABLE IF NOT EXISTS sessions (
        token_hash TEXT PRIMARY KEY, player_id INTEGER NOT NULL, expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS matches (
        id TEXT PRIMARY KEY, kind TEXT NOT NULL, queue TEXT, pool TEXT, map_id TEXT, ranked INTEGER NOT NULL,
        status TEXT NOT NULL, created_at INTEGER NOT NULL, completed_at INTEGER, detail TEXT);
      CREATE TABLE IF NOT EXISTS match_players (
        match_id TEXT NOT NULL, player_id INTEGER NOT NULL, slot INTEGER NOT NULL, team INTEGER NOT NULL,
        rating_before INTEGER, rating_after INTEGER, outcome TEXT, PRIMARY KEY (match_id, player_id));
      CREATE TABLE IF NOT EXISTS friends (
        player_id INTEGER NOT NULL, friend_id INTEGER NOT NULL, state TEXT NOT NULL, created_at INTEGER NOT NULL,
        PRIMARY KEY (player_id, friend_id));
      CREATE TABLE IF NOT EXISTS direct_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT, from_id INTEGER NOT NULL, to_id INTEGER NOT NULL, text TEXT NOT NULL,
        at INTEGER NOT NULL, delivered INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS replays (
        match_id TEXT PRIMARY KEY, uploader_id INTEGER NOT NULL, size INTEGER NOT NULL, data BLOB NOT NULL, at INTEGER NOT NULL);
    `);
    // An unranked match's hidden casual pool and a weekly match's week (columns added to older databases)
    const columns = new Set(this.db.prepare("PRAGMA table_info(matches)").all().map((c) => c.name));
    if (!columns.has("casual_pool")) this.db.exec("ALTER TABLE matches ADD COLUMN casual_pool TEXT");
    if (!columns.has("week")) this.db.exec("ALTER TABLE matches ADD COLUMN week TEXT");
  }

  close() {
    this.db.close();
  }

  // The name rules (length, letters / digits / _ . -, starting with a letter or digit, not reserved),
  // the password's length (a very long one would make scrypt the attacker's tool) and the account cap.
  checkName(name) {
    const { nameMin, nameMax } = this.rules;
    const n = String(name ?? "");
    if (n.length < nameMin || n.length > nameMax || !NAME_CHARS.test(n) || !/^[A-Za-z0-9]/.test(n))
      throw new Error(`names are ${nameMin} to ${nameMax} letters, digits, _ . - (starting with a letter or digit)`);
    if (this.reserved.has(n.toLowerCase())) throw new Error("that name is reserved");
    return n;
  }

  checkPassword(password) {
    const { passwordMin, passwordMax } = this.rules;
    if (typeof password !== "string" || password.length < passwordMin) throw new Error(`the password needs at least ${passwordMin} characters`);
    if (password.length > passwordMax) throw new Error(`the password may have at most ${passwordMax} characters`);
  }

  accountCount() {
    return this.db.prepare("SELECT COUNT(*) AS n FROM players").get().n;
  }

  register(name, password) {
    this.checkName(name);
    if (this.db.prepare("SELECT 1 FROM players WHERE name = ?").get(name)) throw new Error("that name is taken");
    this.checkPassword(password);
    if (this.rules.maxAccounts && this.accountCount() >= this.rules.maxAccounts) throw new Error("the service takes no new accounts at the moment");
    const salt = randomBytes(16).toString("hex");
    const { lastInsertRowid } = this.db.prepare("INSERT INTO players (name, pw_salt, pw_hash, created_at) VALUES (?, ?, ?, ?)")
      .run(name, salt, hashPassword(password, salt), Date.now());
    const id = Number(lastInsertRowid);
    for (const pool of [...POOLS, ...CASUAL_POOLS]) this.ensureRating(id, pool);
    return this.openSession(id);
  }

  login(name, password) {
    if (typeof password !== "string" || password.length > this.rules.passwordMax) throw new Error("wrong name or password");
    const row = this.db.prepare("SELECT id, pw_salt, pw_hash FROM players WHERE name = ?").get(String(name ?? ""));
    const given = Buffer.from(hashPassword(String(password ?? ""), row?.pw_salt ?? "x"), "hex");
    if (!row || !timingSafeEqual(given, Buffer.from(row.pw_hash, "hex"))) throw new Error("wrong name or password");
    return this.openSession(row.id);
  }

  openSession(playerId) {
    const token = randomBytes(32).toString("base64url");
    this.db.prepare("INSERT INTO sessions (token_hash, player_id, expires_at) VALUES (?, ?, ?)").run(sha256(token), playerId, Date.now() + SESSION_MS);
    return { token, player: this.player(playerId) };
  }

  resume(token) {
    const row = this.db.prepare("SELECT player_id FROM sessions WHERE token_hash = ? AND expires_at > ?").get(sha256(String(token ?? "")), Date.now());
    if (!row) throw new Error("the session expired; log in again");
    return { token, player: this.player(row.player_id) };
  }

  player(id) {
    const row = this.db.prepare("SELECT id, name FROM players WHERE id = ?").get(id);
    if (!row) return null;
    return { id: row.id, name: row.name, ratings: this.ratings(row.id) };
  }

  playerByName(name) {
    const row = this.db.prepare("SELECT id FROM players WHERE name = ?").get(String(name ?? ""));
    return row ? this.player(row.id) : null;
  }

  // The shown ratings (the hidden casual pools are left out).
  ratings(playerId) {
    const out = {};
    for (const r of this.db.prepare("SELECT * FROM ratings WHERE player_id = ?").all(playerId)) {
      if (isCasualPool(r.pool)) continue;
      const rank = this.db.prepare("SELECT COUNT(*) + 1 AS n FROM ratings WHERE pool = ? AND rating > ?").get(r.pool, r.rating).n;
      out[r.pool] = { rating: r.rating, peak: r.peak, wins: r.wins, losses: r.losses, streak: r.streak,
        division: divisionForRating(r.rating), rank: Number(rank) };
    }
    return out;
  }

  ensureRating(playerId, pool) {
    this.db.prepare("INSERT OR IGNORE INTO ratings (player_id, pool, rating, peak) VALUES (?, ?, ?, ?)").run(playerId, pool, START_RATING, START_RATING);
  }

  rating(playerId, pool) {
    return this.db.prepare("SELECT rating FROM ratings WHERE player_id = ? AND pool = ?").get(playerId, pool)?.rating ?? START_RATING;
  }

  // A profile: the player, every pool's rating, the last matches.
  profile(playerId, recent = 10) {
    const player = this.player(playerId);
    if (!player) return null;
    player.recent = this.db.prepare(`
      SELECT m.id, m.kind, m.queue, m.map_id AS map, m.ranked, m.week, m.status, m.completed_at AS completedAt,
             mp.outcome, mp.rating_before AS ratingBefore, mp.rating_after AS ratingAfter
      FROM match_players mp JOIN matches m ON m.id = mp.match_id
      WHERE mp.player_id = ? ORDER BY m.created_at DESC LIMIT ?`).all(playerId, recent).map((r) => ({ ...r }));
    return player;
  }

  leaderboard(pool = "solo", limit = 20) {
    if (isCasualPool(pool)) throw new Error("no such leaderboard");
    return this.db.prepare(`
      SELECT p.name, r.rating, r.wins, r.losses, r.streak FROM ratings r JOIN players p ON p.id = r.player_id
      WHERE r.pool = ? ORDER BY r.rating DESC, p.name LIMIT ?`).all(pool, limit)
      .map((r, i) => ({ rank: i + 1, ...r, division: divisionForRating(r.rating) }));
  }

  // match: { id, kind, queueId, pool, mapId, ranked, casualPool?, week?, players: [{ playerId, slot, team }] }
  // pool is the shown pool (rating_before / after show it; an unranked match leaves it as it was), casualPool the hidden
  // one an unranked match updates.
  createMatch(match) {
    this.db.prepare("INSERT INTO matches (id, kind, queue, pool, map_id, ranked, status, created_at, casual_pool, week) VALUES (?, ?, ?, ?, ?, ?, 'playing', ?, ?, ?)")
      .run(match.id, match.kind, match.queueId ?? null, match.pool ?? null, match.mapId ?? null, match.ranked ? 1 : 0, Date.now(),
        match.casualPool ?? null, match.week ?? null);
    for (const p of match.players) {
      this.db.prepare("INSERT INTO match_players (match_id, player_id, slot, team, rating_before) VALUES (?, ?, ?, ?, ?)")
        .run(match.id, p.playerId, p.slot, p.team, match.pool ? this.rating(p.playerId, match.pool) : null);
    }
  }

  // The verified result: winners = the winning team's slots (team games, 1v1) or places by slot (FFA: {slot: place}).
  // Applies the Elo change when the match is ranked; returns { playerId: { before, after, change, outcome } }.
  recordResult(matchId, { winnerSlots = [], places = null, status = "completed", detail = null } = {}) {
    const match = this.db.prepare("SELECT * FROM matches WHERE id = ?").get(matchId);
    if (!match) throw new Error(`no match ${matchId}`);
    if (match.status !== "playing") throw new Error(`match ${matchId} is already ${match.status}`);
    const players = this.db.prepare("SELECT * FROM match_players WHERE match_id = ?").all(matchId);
    const pool = match.pool;
    // The pool the result moves: the shown one (ranked) or the hidden casual one (unranked)
    const ratePool = match.ranked ? pool : match.casual_pool;
    if (ratePool) for (const p of players) this.ensureRating(p.player_id, ratePool);
    const out = {};
    this.db.exec("BEGIN");
    try {
      let changes = new Map();
      const outcome = new Map();
      if (status === "completed" && places) {
        const list = players.map((p) => ({ id: p.player_id, rating: this.rating(p.player_id, ratePool ?? pool), place: Number(places[p.slot] ?? players.length) }));
        changes = ffaRatingChanges(list);
        for (const p of list) outcome.set(p.id, p.place === 1 ? "win" : "loss");
      } else if (status === "completed") {
        const winningTeams = new Set(players.filter((p) => winnerSlots.includes(p.slot)).map((p) => p.team));
        const winners = players.filter((p) => winningTeams.has(p.team));
        const losers = players.filter((p) => !winningTeams.has(p.team));
        if (!winners.length || !losers.length) throw new Error("the result must name a winning and a losing side");
        const delta = teamRatingChange(winners.map((p) => this.rating(p.player_id, ratePool ?? pool)), losers.map((p) => this.rating(p.player_id, ratePool ?? pool)));
        for (const p of winners) changes.set(p.player_id, delta), outcome.set(p.player_id, "win");
        for (const p of losers) changes.set(p.player_id, -delta), outcome.set(p.player_id, "loss");
      }
      for (const p of players) {
        const before = pool ? this.rating(p.player_id, pool) : null;
        const result = outcome.get(p.player_id) ?? status;
        const change = match.ranked && status === "completed" ? changes.get(p.player_id) ?? 0 : 0;
        const after = before === null ? null : before + change;
        if (!match.ranked && ratePool && status === "completed") {  // the hidden casual rating (never shown)
          const r = this.rating(p.player_id, ratePool) + (changes.get(p.player_id) ?? 0);
          this.db.prepare("UPDATE ratings SET rating = ?, peak = MAX(peak, ?), wins = wins + ?, losses = losses + ? WHERE player_id = ? AND pool = ?")
            .run(r, r, result === "win" ? 1 : 0, result === "win" ? 0 : 1, p.player_id, ratePool);
        }
        if (match.ranked && status === "completed" && pool) {
          const won = result === "win";
          this.db.prepare(`UPDATE ratings SET rating = ?, peak = MAX(peak, ?), wins = wins + ?, losses = losses + ?,
                           streak = CASE WHEN ? THEN (CASE WHEN streak >= 0 THEN streak + 1 ELSE 1 END)
                                         ELSE (CASE WHEN streak <= 0 THEN streak - 1 ELSE -1 END) END
                           WHERE player_id = ? AND pool = ?`)
            .run(after, after, won ? 1 : 0, won ? 0 : 1, won ? 1 : 0, p.player_id, pool);
        }
        this.db.prepare("UPDATE match_players SET rating_after = ?, outcome = ? WHERE match_id = ? AND player_id = ?").run(after, result, matchId, p.player_id);
        out[p.player_id] = { before, after, change, outcome: result };
      }
      this.db.prepare("UPDATE matches SET status = ?, completed_at = ?, detail = ? WHERE id = ?").run(status, Date.now(), detail ? JSON.stringify(detail) : null, matchId);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return out;
  }

  // ---- match history, friends, direct messages, replays -------------------------------------------------------
  // A player's matches, newest first, with every player's slot, team, outcome and shown rating, and whether a replay is
  // kept.
  history(playerId, limit = 20) {
    const rows = this.db.prepare(`
      SELECT m.id, m.kind, m.queue, m.pool, m.map_id AS map, m.ranked, m.week, m.status, m.created_at AS createdAt,
             m.completed_at AS completedAt, mp.outcome, mp.slot, mp.rating_before AS ratingBefore, mp.rating_after AS ratingAfter,
             (SELECT size FROM replays r WHERE r.match_id = m.id) AS replaySize
      FROM match_players mp JOIN matches m ON m.id = mp.match_id
      WHERE mp.player_id = ? ORDER BY m.created_at DESC, m.id LIMIT ?`).all(playerId, limit);
    return rows.map((r) => ({
      ...r, ranked: Boolean(r.ranked), replay: r.replaySize !== null, replaySize: r.replaySize ?? 0,
      players: this.db.prepare(`SELECT p.name, mp.slot, mp.team, mp.outcome, mp.rating_before AS ratingBefore, mp.rating_after AS ratingAfter
                                FROM match_players mp JOIN players p ON p.id = mp.player_id WHERE mp.match_id = ? ORDER BY mp.slot`)
        .all(r.id).map((x) => ({ ...x }))
    }));
  }

  inMatch(matchId, playerId) {
    return Boolean(this.db.prepare("SELECT 1 FROM match_players WHERE match_id = ? AND player_id = ?").get(matchId, playerId));
  }

  // Friends: one row per direction; "pending" from the asker's side until the other accepts, then both rows "accepted".
  friendRequest(fromId, toId) {
    if (fromId === toId) throw new Error("you cannot befriend yourself");
    const back = this.db.prepare("SELECT state FROM friends WHERE player_id = ? AND friend_id = ?").get(toId, fromId);
    if (back) return this.friendAccept(fromId, toId);  // they asked first: this accepts
    this.db.prepare("INSERT OR IGNORE INTO friends (player_id, friend_id, state, created_at) VALUES (?, ?, 'pending', ?)").run(fromId, toId, Date.now());
    return "pending";
  }

  friendAccept(playerId, askerId) {
    const asked = this.db.prepare("SELECT state FROM friends WHERE player_id = ? AND friend_id = ?").get(askerId, playerId);
    if (!asked) throw new Error("no friend request from that player");
    this.db.prepare("UPDATE friends SET state = 'accepted' WHERE player_id = ? AND friend_id = ?").run(askerId, playerId);
    this.db.prepare("INSERT OR REPLACE INTO friends (player_id, friend_id, state, created_at) VALUES (?, ?, 'accepted', ?)").run(playerId, askerId, Date.now());
    return "accepted";
  }

  friendRemove(playerId, otherId) {
    this.db.prepare("DELETE FROM friends WHERE (player_id = ? AND friend_id = ?) OR (player_id = ? AND friend_id = ?)").run(playerId, otherId, otherId, playerId);
  }

  // [{ id, name, state: friend | outgoing | incoming }]
  friends(playerId) {
    const out = this.db.prepare("SELECT p.id, p.name, f.state FROM friends f JOIN players p ON p.id = f.friend_id WHERE f.player_id = ?").all(playerId)
      .map((r) => ({ id: r.id, name: r.name, state: r.state === "accepted" ? "friend" : "outgoing" }));
    const incoming = this.db.prepare(`SELECT p.id, p.name FROM friends f JOIN players p ON p.id = f.player_id
                                      WHERE f.friend_id = ? AND f.state = 'pending'`).all(playerId);
    for (const r of incoming) if (!out.some((o) => o.id === r.id)) out.push({ id: r.id, name: r.name, state: "incoming" });
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  areFriends(a, b) {
    return this.db.prepare("SELECT state FROM friends WHERE player_id = ? AND friend_id = ?").get(a, b)?.state === "accepted";
  }

  addDirectMessage(fromId, toId, text) {
    const at = Date.now();
    const { lastInsertRowid } = this.db.prepare("INSERT INTO direct_messages (from_id, to_id, text, at) VALUES (?, ?, ?, ?)").run(fromId, toId, text, at);
    return { id: Number(lastInsertRowid), at };
  }

  markDelivered(ids) {
    for (const id of ids) this.db.prepare("UPDATE direct_messages SET delivered = 1 WHERE id = ?").run(id);
  }

  // The messages waiting for a player who was offline.
  undelivered(toId) {
    return this.db.prepare(`SELECT d.id, p.name AS sender, d.text, d.at FROM direct_messages d JOIN players p ON p.id = d.from_id
                            WHERE d.to_id = ? AND d.delivered = 0 ORDER BY d.id`).all(toId).map((r) => ({ ...r }));
  }

  directMessages(a, b, limit = 50) {
    return this.db.prepare(`SELECT pf.name AS sender, pt.name AS recipient, d.text, d.at FROM direct_messages d
                            JOIN players pf ON pf.id = d.from_id JOIN players pt ON pt.id = d.to_id
                            WHERE (d.from_id = ? AND d.to_id = ?) OR (d.from_id = ? AND d.to_id = ?) ORDER BY d.id DESC LIMIT ?`)
      .all(a, b, b, a, limit).reverse().map((r) => ({ ...r }));
  }

  putReplay(matchId, uploaderId, data) {
    this.db.prepare("INSERT OR REPLACE INTO replays (match_id, uploader_id, size, data, at) VALUES (?, ?, ?, ?, ?)").run(matchId, uploaderId, data.length, data, Date.now());
  }

  hasReplay(matchId) {
    return Boolean(this.db.prepare("SELECT 1 FROM replays WHERE match_id = ?").get(matchId));
  }

  // Replay retention: deletes the replays stored before `before` (ms); returns how many.
  deleteReplaysBefore(before) {
    return Number(this.db.prepare("DELETE FROM replays WHERE at < ?").run(before).changes);
  }

  replayStats() {
    const r = this.db.prepare("SELECT COUNT(*) AS count, COALESCE(SUM(size), 0) AS bytes FROM replays").get();
    return { count: r.count, bytes: r.bytes };
  }

  // Expired sessions go at the retention sweep
  deleteExpiredSessions(now = Date.now()) {
    return Number(this.db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(now).changes);
  }

  // the health check: the database answers
  ping() {
    return this.db.prepare("SELECT 1 AS ok").get().ok === 1;
  }

  replay(matchId) {
    const r = this.db.prepare("SELECT data, size, uploader_id AS uploader FROM replays WHERE match_id = ?").get(matchId);
    return r ? { data: Buffer.from(r.data), size: r.size, uploader: r.uploader } : null;
  }
}
