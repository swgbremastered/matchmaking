// Moderation: who may do what, and the actions themselves (ban, mute, kick, roles, reports, broadcasts), shared by
// the game protocol (a logged-in moderator), the admin dashboard and the command line (src/admin.mjs). Every action
// lands in the audit log with who did it.
//
// Roles: player < moderator < admin. Nobody acts on an account of their own rank or above (an admin's ban of another
// admin goes through the command line, which acts as the operator). Moderators give timed bans and mutes up to a limit;
// permanent bans, address bans and roles are for admins.
import { WindowLimiter } from "./limits.mjs";
import { MUTE_SCOPES, ROLES, describeUntil, roleRank } from "./moderation-store.mjs";

export const MODERATION_DEFAULTS = Object.freeze({
  admins: [],
  reportsPerHour: 5,
  reportMax: 300,
  reasonMax: 300,
  moderatorMaxBanDays: 30,
  moderatorMaxMuteDays: 30,
  sweepSeconds: 15
});

// An error whose extra fields go along in the protocol's error message (a ban's end time, a mute's).
export function refusal(message, extra) {
  const error = new Error(message);
  error.extra = extra;
  return error;
}

// The operator at the command line or the server itself: above every role.
export const OPERATOR = Object.freeze({ id: null, name: "operator", role: "operator", rank: ROLES.length });

const text = (value, max) => String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max);

export class Moderation {
  constructor({ store, mm = null, now = () => Date.now(), log = null, config = {} }) {
    this.store = store;
    this.db = store.mod;
    this.mm = mm;
    this.now = now;
    this.log = log;
    this.config = { ...MODERATION_DEFAULTS, ...config };
    this.reportRate = new WindowLimiter({ limit: this.config.reportsPerHour, windowMs: 3_600_000, now });
  }

  actorFor(player) {
    const role = this.db.role(player.id);
    return { id: player.id, name: player.name, role, rank: roleRank(role) };
  }

  need(actor, role) {
    if (actor.rank < roleRank(role)) throw new Error(role === "admin" ? "only an admin may do that" : "only a moderator may do that");
  }

  target(actor, name) {
    const player = this.store.playerByName(name);
    if (!player) throw new Error("no such player");
    const role = this.db.role(player.id);
    if (actor.id !== null && player.id === actor.id) throw new Error("not on your own account");
    if (roleRank(role) >= actor.rank) throw new Error(`${player.name} is a ${role}; ask an admin at the server`);
    return { id: player.id, name: player.name, role };
  }

  audit(actor, action, target, detail) {
    this.db.audit({ actorId: actor.id, actor: actor.name, action, targetId: target?.id ?? null, target: target?.name ?? target?.ip ?? null,
      detail, now: this.now() });
    this.log?.event("info", "moderation", { actor: actor.name, action, target: target?.name ?? undefined });
  }

  // minutes: a positive number, or 0 / absent for permanent (admins only)
  endsAt(actor, minutes, maxDays, what) {
    const m = Number(minutes ?? 0);
    if (!Number.isFinite(m) || m < 0) throw new Error("minutes must be a number >= 0");
    if (m === 0) {
      if (actor.rank < roleRank("admin")) throw new Error(`a moderator's ${what} needs a length in minutes`);
      return null;
    }
    if (actor.rank < roleRank("admin") && m > maxDays * 1440) throw new Error(`a moderator's ${what} is at most ${maxDays} days`);
    return this.now() + Math.round(m * 60_000);
  }

  // ---- the checks the server makes --------------------------------------------------------------------------
  checkAddress(ip) {
    const ban = ip ? this.db.activeBan({ ip }, this.now()) : null;
    if (ban) throw banRefusal(ban);
  }

  // An address ban keeps out every account from that address but the staff's (who may share it).
  checkLogin(playerId, ip) {
    const ban = this.db.activeBan({ playerId }, this.now())
      ?? (this.db.role(playerId) === "player" && ip ? this.db.activeBan({ ip }, this.now()) : null);
    if (ban) throw banRefusal(ban);
  }

  // kind: chat (lobby, party, tournament) | dm
  checkChat(playerId, kind) {
    const mute = this.db.activeMute(playerId, kind, this.now());
    if (mute) throw refusal(`you are muted ${describeUntil(mute.until)}${mute.reason ? `: ${mute.reason}` : ""}`, { muted: { scope: mute.scope, until: mute.until, reason: mute.reason } });
  }

  // ---- actions ------------------------------------------------------------------------------------------------
  ban(actor, { name, minutes, reason, address = false }) {
    this.need(actor, "moderator");
    const target = this.target(actor, name);
    const why = text(reason, this.config.reasonMax);
    if (!why) throw new Error("a ban needs a reason");
    let ip = null;
    if (address) {
      this.need(actor, "admin");
      ip = this.mm?.online.get(target.id)?.ip ?? this.db.lastAddress(target.id);
      if (!ip) throw new Error(`no address known for ${target.name}`);
    }
    const until = this.endsAt(actor, minutes, this.config.moderatorMaxBanDays, "ban");
    const id = this.db.addBan({ playerId: target.id, ip, reason: why, endsAt: until, by: actor.name, now: this.now() });
    this.audit(actor, address ? "ban_account_and_address" : "ban", target, { ban: id, until, reason: why });
    this.mm?.enforceBan({ id, playerId: target.id, ip, reason: why, until });
    return { id, name: target.name, until, address: Boolean(ip) };
  }

  banAddress(actor, { ip, minutes, reason }) {
    this.need(actor, "admin");
    const addr = text(ip, 64);
    if (!addr) throw new Error("no address given");
    const why = text(reason, this.config.reasonMax);
    if (!why) throw new Error("a ban needs a reason");
    const until = this.endsAt(actor, minutes, this.config.moderatorMaxBanDays, "ban");
    const id = this.db.addBan({ ip: addr, reason: why, endsAt: until, by: actor.name, now: this.now() });
    this.audit(actor, "ban_address", { ip: addr }, { ban: id, until, reason: why });
    this.mm?.enforceBan({ id, playerId: null, ip: addr, reason: why, until });
    return { id, ip: addr, until };
  }

  unban(actor, { name }) {
    this.need(actor, "moderator");
    const target = this.target(actor, name);
    const lifted = this.db.liftBans(target.id, actor.name, this.now());
    if (!lifted) throw new Error(`${target.name} is not banned`);
    this.audit(actor, "unban", target, { lifted });
    return { name: target.name, lifted };
  }

  unbanAddress(actor, { ip }) {
    this.need(actor, "admin");
    const lifted = this.db.liftAddressBans(text(ip, 64), actor.name, this.now());
    if (!lifted) throw new Error("that address is not banned");
    this.audit(actor, "unban_address", { ip: text(ip, 64) }, { lifted });
    return { ip: text(ip, 64), lifted };
  }

  mute(actor, { name, minutes, scope = "all", reason }) {
    this.need(actor, "moderator");
    const target = this.target(actor, name);
    if (!MUTE_SCOPES.includes(scope)) throw new Error(`a mute's scope is one of ${MUTE_SCOPES.join(", ")}`);
    const why = text(reason, this.config.reasonMax);
    if (!why) throw new Error("a mute needs a reason");
    const until = this.endsAt(actor, minutes, this.config.moderatorMaxMuteDays, "mute");
    const id = this.db.addMute({ playerId: target.id, scope, reason: why, endsAt: until, by: actor.name, now: this.now() });
    this.audit(actor, "mute", target, { mute: id, scope, until, reason: why });
    this.mm?.sendTo(target.id, { t: "muted", scope, until, reason: why });
    return { id, name: target.name, scope, until };
  }

  unmute(actor, { name }) {
    this.need(actor, "moderator");
    const target = this.target(actor, name);
    const lifted = this.db.liftMutes(target.id, actor.name, this.now());
    if (!lifted) throw new Error(`${target.name} is not muted`);
    this.audit(actor, "unmute", target, { lifted });
    this.mm?.sendTo(target.id, { t: "unmuted" });
    return { name: target.name, lifted };
  }

  kick(actor, { name, reason }) {
    this.need(actor, "moderator");
    const target = this.target(actor, name);
    const why = text(reason, this.config.reasonMax) || "removed by a moderator";
    if (!this.mm?.online.has(target.id)) throw new Error(`${target.name} is not online`);
    this.audit(actor, "kick", target, { reason: why });
    this.mm.disconnect(target.id, { t: "kicked", reason: why });
    return { name: target.name };
  }

  setRole(actor, { name, role }) {
    this.need(actor, "admin");
    if (!ROLES.includes(role)) throw new Error(`a role is one of ${ROLES.join(", ")}`);
    const player = this.store.playerByName(name);
    if (!player) throw new Error("no such player");
    if (actor.id !== null) {
      if (player.id === actor.id) throw new Error("not on your own account");
      if (this.db.role(player.id) === "admin" || role === "admin") throw new Error("admins are made and unmade at the server (src/admin.mjs)");
    }
    const before = this.db.role(player.id);
    this.db.setRole(player.id, role, actor.name, this.now());
    this.audit(actor, "role", player, { from: before, to: role });
    return { name: player.name, role };
  }

  resolveReport(actor, { id, action, note }) {
    this.need(actor, "moderator");
    const status = action === "dismiss" || action === "dismissed" ? "dismissed" : action === "actioned" || action === "action" ? "actioned" : null;
    if (!status) throw new Error("a report is dismissed or actioned");
    const report = this.db.report(Number(id));
    if (!report) throw new Error("no such report");
    this.db.resolveReport(report.id, status, actor.name, text(note, this.config.reasonMax) || null, this.now());
    this.audit(actor, `report_${status}`, { id: report.targetId, name: report.target }, { report: report.id });
    return { id: report.id, status };
  }

  broadcast(actor, message) {
    this.need(actor, "moderator");
    const body = text(message, 500);
    if (!body) throw new Error("an empty message");
    const delivered = this.mm ? this.mm.broadcast(body, actor.name) : 0;
    this.audit(actor, "broadcast", null, { text: body, delivered });
    return { delivered };
  }

  lookup(actor, { name }) {
    this.need(actor, "moderator");
    const player = this.store.playerByName(name);
    if (!player) throw new Error("no such player");
    return {
      name: player.name, role: this.db.role(player.id), online: Boolean(this.mm?.online.has(player.id)),
      ban: this.db.activeBan({ playerId: player.id }, this.now()), bans: this.db.playerBans(player.id),
      mutes: this.db.playerMutes(player.id), reports: this.db.reports({ targetId: player.id, limit: 20 }),
      address: actor.rank >= roleRank("admin") ? this.db.lastAddress(player.id) : undefined
    };
  }

  // A player's report of another: rate-limited per reporter; a match id, when given, must be one they played.
  fileReport(player, { name, reason, match }) {
    const target = this.store.playerByName(name);
    if (!target) throw new Error("no such player");
    if (target.id === player.id) throw new Error("you cannot report yourself");
    const why = text(reason, this.config.reportMax);
    if (!why) throw new Error("a report needs a reason");
    const matchId = match ? text(match, 64) : null;
    if (matchId && !this.store.inMatch(matchId, player.id)) throw new Error("you were not in that match");
    if (!this.reportRate.take(player.id)) throw new Error("you have sent too many reports; try again later");
    const id = this.db.addReport({ reporterId: player.id, targetId: target.id, reason: why, matchId, now: this.now() });
    this.log?.event("info", "player_report", { report: id, reporter: player.name, target: target.name });
    this.mm?.notifyStaff({ t: "mod_report", report: this.db.report(id) });
    return { id };
  }

  // ---- the game protocol -------------------------------------------------------------------------------------
  // Returns false for a request that is not one of these.
  handle(conn, m) {
    const mm = this.mm;
    if (!String(m.t).startsWith("mod_") && m.t !== "report_player") return false;
    const player = mm.requirePlayer(conn);
    if (m.t === "report_player") {
      mm.send(conn, { t: "report_filed", ...this.fileReport(player, m) });
      return true;
    }
    const actor = this.actorFor(player);
    this.need(actor, "moderator");
    const done = (action, result) => mm.send(conn, { t: "mod_done", action, ...result });
    switch (m.t) {
      case "mod_ban": done("ban", this.ban(actor, m)); break;
      case "mod_unban": done("unban", this.unban(actor, m)); break;
      case "mod_mute": done("mute", this.mute(actor, m)); break;
      case "mod_unmute": done("unmute", this.unmute(actor, m)); break;
      case "mod_kick": done("kick", this.kick(actor, m)); break;
      case "mod_role": done("role", this.setRole(actor, m)); break;
      case "mod_broadcast": done("broadcast", this.broadcast(actor, m.text)); break;
      case "mod_report_resolve": done("report_resolve", this.resolveReport(actor, m)); break;
      case "mod_reports":
        mm.send(conn, { t: "mod_reports", status: m.status ?? "open",
          reports: this.db.reports({ status: ["open", "dismissed", "actioned", "all"].includes(m.status) ? m.status : "open", limit: clamp(m.limit, 100) }) });
        break;
      case "mod_bans": mm.send(conn, { t: "mod_bans", bans: this.db.activeBans(this.now(), clamp(m.limit, 200)).map((b) => hideAddress(actor, b)) }); break;
      case "mod_mutes": mm.send(conn, { t: "mod_mutes", mutes: this.db.activeMutes(this.now(), clamp(m.limit, 200)) }); break;
      case "mod_audit": mm.send(conn, { t: "mod_audit", entries: this.db.auditLog({ limit: clamp(m.limit, 100), before: m.before ? Number(m.before) : null }) }); break;
      case "mod_lookup": {
        const look = this.lookup(actor, m);
        look.bans = look.bans.map((b) => hideAddress(actor, b));
        if (look.ban) look.ban = hideAddress(actor, look.ban);
        mm.send(conn, { t: "mod_lookup", player: look });
        break;
      }
      default: throw new Error(`unknown request ${m.t}`);
    }
    return true;
  }
}

const clamp = (v, max) => Math.min(max, Math.max(1, Number(v) || max));
// moderators see that a ban also covers an address, not the address itself
const hideAddress = (actor, ban) => (actor.rank >= roleRank("admin") ? ban : { ...ban, ip: ban.ip ? "(hidden)" : null });

function banRefusal(ban) {
  return refusal(`you are banned ${describeUntil(ban.until)}${ban.reason ? `: ${ban.reason}` : ""}`, { banned: { until: ban.until, reason: ban.reason } });
}

// The config's `moderation.admins`: existing accounts become admins at start. A name that has no account yet is only
// logged, never reserved: otherwise whoever registered it first would be an admin.
export function grantConfigAdmins(store, names, log) {
  for (const name of names ?? []) {
    const player = store.playerByName(name);
    if (!player) {
      log?.event("warn", "admin_missing", { name, hint: "register the account, then restart or use src/admin.mjs" });
      continue;
    }
    if (store.mod.role(player.id) !== "admin") {
      store.mod.setRole(player.id, "admin", "config");
      store.mod.audit({ actor: "config", action: "role", targetId: player.id, target: player.name, detail: { to: "admin" } });
      log?.event("info", "admin_granted", { name: player.name, by: "config" });
    }
  }
}
