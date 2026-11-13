// Seasons (config `seasons`, off by default): three months each, a calendar quarter in UTC (2026-Q4). When a season
// ends, every shown rating of a player who played in it is kept as that season's record (rating, peak, wins, losses,
// rank, division), then the rating is soft-reset towards the start rating (softReset 0.5: halfway) and the season's
// counts (peak, wins, losses, streak) start again. Hidden casual ratings are left alone.
//
// Tables `seasons` and `season_records` are new; an older image ignores them (and sees the reset ratings as ratings).
import { START_RATING, divisionForRating } from "./elo.mjs";
import { POOLS } from "./rating-pool.mjs";

export const SEASON_DEFAULTS = Object.freeze({ enabled: false, softReset: 0.5, checkMinutes: 10 });

export function seasonOf(ms) {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-Q${Math.floor(d.getUTCMonth() / 3) + 1}`;
}

export function seasonBounds(id) {
  const [, y, q] = /^(\d{4})-Q([1-4])$/.exec(id) ?? [];
  if (!y) throw new Error("a season is YEAR-Q1 to Q4");
  return { start: Date.UTC(Number(y), (Number(q) - 1) * 3, 1), end: Date.UTC(Number(y), Number(q) * 3, 1) };
}

export const softReset = (rating, factor) => Math.round(START_RATING + (rating - START_RATING) * factor);

export class Seasons {
  constructor({ store, config = {}, now = () => Date.now(), log = null }) {
    this.store = store;
    this.db = store.db;
    this.config = { ...SEASON_DEFAULTS, ...config };
    this.now = now;
    this.log = log;
    this.checkedAt = 0;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS seasons (id TEXT PRIMARY KEY, started_at INTEGER NOT NULL, closed_at INTEGER);
      CREATE TABLE IF NOT EXISTS season_records (
        season TEXT NOT NULL, player_id INTEGER NOT NULL, pool TEXT NOT NULL, rating INTEGER NOT NULL, peak INTEGER NOT NULL,
        wins INTEGER NOT NULL, losses INTEGER NOT NULL, rank INTEGER NOT NULL, PRIMARY KEY (season, player_id, pool));
    `);
  }

  current() {
    return this.db.prepare("SELECT id FROM seasons WHERE closed_at IS NULL ORDER BY started_at DESC LIMIT 1").get()?.id ?? null;
  }

  // Opens the first season, or closes the one that has ended and opens this quarter's. Returns the closed id or null.
  check(now = this.now()) {
    if (!this.config.enabled) return null;
    this.checkedAt = now;
    const want = seasonOf(now);
    const open = this.current();
    if (open === want) return null;
    if (!open) {
      this.db.prepare("INSERT OR IGNORE INTO seasons (id, started_at) VALUES (?, ?)").run(want, now);
      this.log?.event("info", "season_opened", { season: want });
      return null;
    }
    this.close(open, now);
    this.db.prepare("INSERT OR IGNORE INTO seasons (id, started_at) VALUES (?, ?)").run(want, now);
    this.log?.event("info", "season_opened", { season: want });
    return open;
  }

  close(id, now = this.now()) {
    const db = this.db;
    db.exec("BEGIN");
    try {
      for (const pool of POOLS) {
        const rows = db.prepare("SELECT * FROM ratings WHERE pool = ? AND wins + losses > 0 ORDER BY rating DESC, player_id").all(pool);
        rows.forEach((r, i) => db.prepare(`INSERT OR REPLACE INTO season_records (season, player_id, pool, rating, peak, wins, losses, rank)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(id, r.player_id, pool, r.rating, r.peak, r.wins, r.losses, i + 1));
        for (const r of db.prepare("SELECT player_id, rating FROM ratings WHERE pool = ?").all(pool)) {
          const next = softReset(r.rating, this.config.softReset);
          db.prepare("UPDATE ratings SET rating = ?, peak = ?, wins = 0, losses = 0, streak = 0 WHERE player_id = ? AND pool = ?").run(next, next, r.player_id, pool);
        }
      }
      db.prepare("UPDATE seasons SET closed_at = ? WHERE id = ?").run(now, id);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    this.log?.event("info", "season_closed", { season: id });
  }

  // called often; looks at the calendar every checkMinutes
  tick(now = this.now()) {
    if (this.config.enabled && now - this.checkedAt >= this.config.checkMinutes * 60_000) this.check(now);
  }

  list() {
    return this.db.prepare("SELECT id, started_at AS startedAt, closed_at AS closedAt FROM seasons ORDER BY started_at DESC").all().map((r) => ({ ...r }));
  }

  standings(season, pool = "solo", limit = 50) {
    return this.db.prepare(`SELECT s.rank, p.name, s.rating, s.peak, s.wins, s.losses FROM season_records s JOIN players p ON p.id = s.player_id
      WHERE s.season = ? AND s.pool = ? ORDER BY s.rank LIMIT ?`).all(String(season), String(pool), limit)
      .map((r) => ({ ...r, division: divisionForRating(r.rating) }));
  }

  records(playerId) {
    return this.db.prepare(`SELECT season, pool, rating, peak, wins, losses, rank FROM season_records WHERE player_id = ?
      ORDER BY season DESC, pool`).all(playerId).map((r) => ({ ...r, division: divisionForRating(r.rating) }));
  }

  // the game protocol: seasons, season {season, pool} (final standings), season_records {name?}
  handle(mm, conn, m) {
    if (m.t === "seasons") return mm.send(conn, { t: "seasons", enabled: this.config.enabled, current: this.current(), seasons: this.list() }), true;
    if (m.t === "season") {
      const pool = POOLS.includes(m.pool) ? m.pool : "solo";
      return mm.send(conn, { t: "season", season: String(m.season ?? ""), pool, rows: this.standings(m.season, pool, Math.min(100, Number(m.limit) || 50)) }), true;
    }
    if (m.t === "season_records") {
      const target = m.name ? this.store.playerByName(m.name) : mm.requirePlayer(conn);
      if (!target) throw new Error("no such player");
      return mm.send(conn, { t: "season_records", name: target.name, records: this.records(target.id) }), true;
    }
    return false;
  }
}
