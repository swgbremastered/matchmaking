// Roles, bans, mutes, player reports and the moderators' audit log, in the same SQLite file as the accounts. Every
// table is new (no column is added to an existing one), so an older image of the server opens the database and simply
// never looks at them.
//
// Times are milliseconds since the epoch; an ends_at of NULL is permanent. A ban or a mute is active while it is not
// lifted and has not ended; lifting keeps the row (the history stays for the moderators).

export const ROLES = Object.freeze(["player", "moderator", "admin"]);
export const roleRank = (role) => Math.max(0, ROLES.indexOf(role));
export const MUTE_SCOPES = Object.freeze(["chat", "dm", "all"]);

export class ModerationStore {
  constructor(db) {
    this.db = db;
    db.exec(`
      CREATE TABLE IF NOT EXISTS player_roles (
        player_id INTEGER PRIMARY KEY, role TEXT NOT NULL, set_at INTEGER NOT NULL, set_by TEXT);
      CREATE TABLE IF NOT EXISTS player_addresses (
        player_id INTEGER PRIMARY KEY, ip TEXT NOT NULL, at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS bans (
        id INTEGER PRIMARY KEY AUTOINCREMENT, player_id INTEGER, ip TEXT, reason TEXT NOT NULL,
        created_at INTEGER NOT NULL, ends_at INTEGER, by_name TEXT NOT NULL, lifted_at INTEGER, lifted_by TEXT);
      CREATE INDEX IF NOT EXISTS bans_player ON bans (player_id);
      CREATE INDEX IF NOT EXISTS bans_ip ON bans (ip);
      CREATE TABLE IF NOT EXISTS mutes (
        id INTEGER PRIMARY KEY AUTOINCREMENT, player_id INTEGER NOT NULL, scope TEXT NOT NULL, reason TEXT NOT NULL,
        created_at INTEGER NOT NULL, ends_at INTEGER, by_name TEXT NOT NULL, lifted_at INTEGER, lifted_by TEXT);
      CREATE INDEX IF NOT EXISTS mutes_player ON mutes (player_id);
      CREATE TABLE IF NOT EXISTS reports (
        id INTEGER PRIMARY KEY AUTOINCREMENT, reporter_id INTEGER NOT NULL, target_id INTEGER NOT NULL,
        reason TEXT NOT NULL, match_id TEXT, created_at INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'open',
        handled_by TEXT, handled_at INTEGER, note TEXT);
      CREATE INDEX IF NOT EXISTS reports_status ON reports (status, created_at);
      CREATE TABLE IF NOT EXISTS audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, actor_id INTEGER, actor TEXT NOT NULL,
        action TEXT NOT NULL, target_id INTEGER, target TEXT, detail TEXT);
    `);
  }

  // ---- roles ----------------------------------------------------------------------------------------------------
  role(playerId) {
    return this.db.prepare("SELECT role FROM player_roles WHERE player_id = ?").get(playerId)?.role ?? "player";
  }

  setRole(playerId, role, by, now = Date.now()) {
    if (!ROLES.includes(role)) throw new Error(`a role is one of ${ROLES.join(", ")}`);
    if (role === "player") this.db.prepare("DELETE FROM player_roles WHERE player_id = ?").run(playerId);
    else this.db.prepare("INSERT OR REPLACE INTO player_roles (player_id, role, set_at, set_by) VALUES (?, ?, ?, ?)").run(playerId, role, now, by);
  }

  staff() {
    return this.db.prepare(`SELECT p.name, r.role, r.set_at AS setAt, r.set_by AS setBy FROM player_roles r
                            JOIN players p ON p.id = r.player_id ORDER BY r.role, p.name`).all().map((r) => ({ ...r }));
  }

  // ---- addresses (kept for address bans of a player who is offline; shown to admins only) ----------------------
  noteAddress(playerId, ip, now = Date.now()) {
    if (ip) this.db.prepare("INSERT OR REPLACE INTO player_addresses (player_id, ip, at) VALUES (?, ?, ?)").run(playerId, ip, now);
  }

  lastAddress(playerId) {
    return this.db.prepare("SELECT ip FROM player_addresses WHERE player_id = ?").get(playerId)?.ip ?? null;
  }

  // ---- bans -----------------------------------------------------------------------------------------------------
  addBan({ playerId = null, ip = null, reason, endsAt = null, by, now = Date.now() }) {
    const { lastInsertRowid } = this.db.prepare("INSERT INTO bans (player_id, ip, reason, created_at, ends_at, by_name) VALUES (?, ?, ?, ?, ?, ?)")
      .run(playerId, ip, reason, now, endsAt, by);
    return Number(lastInsertRowid);
  }

  // The active ban that keeps this account or this address out, the longest first.
  activeBan({ playerId = null, ip = null }, now = Date.now()) {
    const row = this.db.prepare(`SELECT b.*, p.name FROM bans b LEFT JOIN players p ON p.id = b.player_id
      WHERE b.lifted_at IS NULL AND (b.ends_at IS NULL OR b.ends_at > ?)
        AND ((? IS NOT NULL AND b.player_id = ?) OR (? IS NOT NULL AND b.ip = ?))
      ORDER BY b.ends_at IS NULL DESC, b.ends_at DESC LIMIT 1`).get(now, playerId, playerId, ip, ip);
    return row ? banView(row) : null;
  }

  // Lifts every active ban on the account (and the address bans made with it); returns how many.
  liftBans(playerId, by, now = Date.now()) {
    return Number(this.db.prepare(`UPDATE bans SET lifted_at = ?, lifted_by = ?
      WHERE player_id = ? AND lifted_at IS NULL AND (ends_at IS NULL OR ends_at > ?)`).run(now, by, playerId, now).changes);
  }

  liftAddressBans(ip, by, now = Date.now()) {
    return Number(this.db.prepare(`UPDATE bans SET lifted_at = ?, lifted_by = ?
      WHERE ip = ? AND lifted_at IS NULL AND (ends_at IS NULL OR ends_at > ?)`).run(now, by, ip, now).changes);
  }

  activeBans(now = Date.now(), limit = 200) {
    return this.db.prepare(`SELECT b.*, p.name FROM bans b LEFT JOIN players p ON p.id = b.player_id
      WHERE b.lifted_at IS NULL AND (b.ends_at IS NULL OR b.ends_at > ?) ORDER BY b.created_at DESC LIMIT ?`).all(now, limit).map(banView);
  }

  // Account bans made since `since` that are still active (the server closes those players' connections).
  bansSince(since, now = Date.now()) {
    return this.db.prepare(`SELECT b.*, p.name FROM bans b LEFT JOIN players p ON p.id = b.player_id
      WHERE b.created_at > ? AND b.lifted_at IS NULL AND (b.ends_at IS NULL OR b.ends_at > ?)`).all(since, now).map(banView);
  }

  playerBans(playerId, limit = 20) {
    return this.db.prepare(`SELECT b.*, p.name FROM bans b LEFT JOIN players p ON p.id = b.player_id
      WHERE b.player_id = ? ORDER BY b.created_at DESC LIMIT ?`).all(playerId, limit).map(banView);
  }

  // ---- mutes ----------------------------------------------------------------------------------------------------
  addMute({ playerId, scope = "all", reason, endsAt = null, by, now = Date.now() }) {
    if (!MUTE_SCOPES.includes(scope)) throw new Error(`a mute's scope is one of ${MUTE_SCOPES.join(", ")}`);
    const { lastInsertRowid } = this.db.prepare("INSERT INTO mutes (player_id, scope, reason, created_at, ends_at, by_name) VALUES (?, ?, ?, ?, ?, ?)")
      .run(playerId, scope, reason, now, endsAt, by);
    return Number(lastInsertRowid);
  }

  // The active mute covering `kind` (chat: lobby, party and tournament chat; dm: direct messages).
  activeMute(playerId, kind, now = Date.now()) {
    const row = this.db.prepare(`SELECT m.*, p.name FROM mutes m JOIN players p ON p.id = m.player_id
      WHERE m.player_id = ? AND (m.scope = ? OR m.scope = 'all') AND m.lifted_at IS NULL AND (m.ends_at IS NULL OR m.ends_at > ?)
      ORDER BY m.ends_at IS NULL DESC, m.ends_at DESC LIMIT 1`).get(playerId, kind, now);
    return row ? muteView(row) : null;
  }

  liftMutes(playerId, by, now = Date.now()) {
    return Number(this.db.prepare(`UPDATE mutes SET lifted_at = ?, lifted_by = ?
      WHERE player_id = ? AND lifted_at IS NULL AND (ends_at IS NULL OR ends_at > ?)`).run(now, by, playerId, now).changes);
  }

  activeMutes(now = Date.now(), limit = 200) {
    return this.db.prepare(`SELECT m.*, p.name FROM mutes m JOIN players p ON p.id = m.player_id
      WHERE m.lifted_at IS NULL AND (m.ends_at IS NULL OR m.ends_at > ?) ORDER BY m.created_at DESC LIMIT ?`).all(now, limit).map(muteView);
  }

  playerMutes(playerId, limit = 20) {
    return this.db.prepare(`SELECT m.*, p.name FROM mutes m JOIN players p ON p.id = m.player_id
      WHERE m.player_id = ? ORDER BY m.created_at DESC LIMIT ?`).all(playerId, limit).map(muteView);
  }

  // ---- reports --------------------------------------------------------------------------------------------------
  addReport({ reporterId, targetId, reason, matchId = null, now = Date.now() }) {
    const { lastInsertRowid } = this.db.prepare("INSERT INTO reports (reporter_id, target_id, reason, match_id, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(reporterId, targetId, reason, matchId, now);
    return Number(lastInsertRowid);
  }

  report(id) {
    const row = this.db.prepare(`${REPORT_SELECT} WHERE r.id = ?`).get(id);
    return row ? reportView(row) : null;
  }

  reports({ status = "open", limit = 100, targetId = null } = {}) {
    const rows = targetId === null
      ? this.db.prepare(`${REPORT_SELECT} WHERE (? = 'all' OR r.status = ?) ORDER BY r.created_at DESC LIMIT ?`).all(status, status, limit)
      : this.db.prepare(`${REPORT_SELECT} WHERE r.target_id = ? ORDER BY r.created_at DESC LIMIT ?`).all(targetId, limit);
    return rows.map(reportView);
  }

  openReportCount() {
    return this.db.prepare("SELECT COUNT(*) AS n FROM reports WHERE status = 'open'").get().n;
  }

  resolveReport(id, status, by, note = null, now = Date.now()) {
    if (!["dismissed", "actioned"].includes(status)) throw new Error("a report is dismissed or actioned");
    const changed = Number(this.db.prepare("UPDATE reports SET status = ?, handled_by = ?, handled_at = ?, note = ? WHERE id = ? AND status = 'open'")
      .run(status, by, now, note, id).changes);
    if (!changed) throw new Error("no open report with that number");
  }

  // ---- audit log ------------------------------------------------------------------------------------------------
  audit({ actorId = null, actor, action, targetId = null, target = null, detail = null, now = Date.now() }) {
    this.db.prepare("INSERT INTO audit_log (at, actor_id, actor, action, target_id, target, detail) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(now, actorId, actor, action, targetId, target, detail ? JSON.stringify(detail) : null);
  }

  auditLog({ limit = 100, before = null } = {}) {
    return this.db.prepare(`SELECT id, at, actor, action, target, detail FROM audit_log
      WHERE (? IS NULL OR id < ?) ORDER BY id DESC LIMIT ?`).all(before, before, limit)
      .map((r) => ({ ...r, detail: r.detail ? JSON.parse(r.detail) : null }));
  }
}

const REPORT_SELECT = `SELECT r.*, pr.name AS reporter, pt.name AS target FROM reports r
  JOIN players pr ON pr.id = r.reporter_id JOIN players pt ON pt.id = r.target_id`;

const banView = (r) => ({ id: r.id, name: r.name ?? null, playerId: r.player_id ?? null, ip: r.ip ?? null, reason: r.reason,
  createdAt: r.created_at, until: r.ends_at ?? null, by: r.by_name, liftedAt: r.lifted_at ?? null, liftedBy: r.lifted_by ?? null });
const muteView = (r) => ({ id: r.id, name: r.name, playerId: r.player_id, scope: r.scope, reason: r.reason, createdAt: r.created_at,
  until: r.ends_at ?? null, by: r.by_name, liftedAt: r.lifted_at ?? null, liftedBy: r.lifted_by ?? null });
const reportView = (r) => ({ id: r.id, reporter: r.reporter, target: r.target, targetId: r.target_id, reason: r.reason,
  match: r.match_id ?? null, createdAt: r.created_at, status: r.status, handledBy: r.handled_by ?? null, handledAt: r.handled_at ?? null,
  note: r.note ?? null });

// "until 2026-11-20 18:00 UTC" or "permanently"
export function describeUntil(until) {
  if (until === null || until === undefined) return "permanently";
  return `until ${new Date(until).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}
