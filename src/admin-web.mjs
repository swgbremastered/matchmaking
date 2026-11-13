// The admin dashboard: an HTTP listener of its own (config `admin`, off by default, 127.0.0.1 when on), in the spirit
// of Empire League's admin-dashboard.mjs (MIT, see LICENSE.empire-league) but server-rendered with plain forms and no
// scripts. Log-in with an admin account's own name and password (the scrypt check accounts use); the session is a
// random token in an HttpOnly, SameSite=Strict cookie (Secure when the request came over TLS), every form carries the
// session's CSRF token, and every request checks again that the account is still an admin.
//
// Pages: overview (online players, queues, live matches and lobbies, recent results, a broadcast), reports (ban /
// mute / dismiss), bans and mutes (lift them, or ban / mute / kick by name), the audit log.
import http from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { WindowLimiter } from "./limits.mjs";
import { describeUntil } from "./moderation-store.mjs";
import { SECURITY_HEADERS, clientIp, cookies, esc, isHttps, listen, page, readForm, when } from "./web-util.mjs";

export const ADMIN_DEFAULTS = Object.freeze({
  enabled: false, host: "127.0.0.1", port: 4319, secureCookie: "auto", trustProxy: false, sessionHours: 12, loginPerIpPerMinute: 10
});
const COOKIE = "mm_admin";
const LOGIN_COOKIE = "mm_login";

const same = (a, b) => typeof a === "string" && typeof b === "string" && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export class AdminServer {
  constructor({ mm, config = {}, now = () => Date.now(), log = null }) {
    this.mm = mm;
    this.store = mm.store;
    this.moderation = mm.moderation;
    this.config = { ...ADMIN_DEFAULTS, ...config };
    this.now = now;
    this.log = log;
    this.sessions = new Map();  // token -> { playerId, csrf, expires }
    this.loginLimit = new WindowLimiter({ limit: this.config.loginPerIpPerMinute, windowMs: 60_000, now });
  }

  async start() {
    this.server = http.createServer((req, res) => {
      this.route(req, res).catch((error) => {
        if (!res.headersSent) this.html(res, error.status ?? 500, page("Error", `<p class="bad">${esc(error.status ? error.message : "something went wrong")}</p>`));
        if (!error.status) this.log?.event("error", "admin_error", { error: error.message });
      });
    });
    this.server.headersTimeout = 10_000;
    this.server.requestTimeout = 15_000;
    this.port = await listen(this.server, this.config.port, this.config.host);
    return this;
  }

  async stop() {
    if (this.server) await new Promise((resolve) => this.server.close(resolve));
  }

  html(res, status, body, headers = {}) {
    res.writeHead(status, { ...SECURITY_HEADERS, "content-type": "text/html; charset=utf-8", "cache-control": "no-store", ...headers }).end(body);
  }

  redirect(res, to, headers = {}) {
    res.writeHead(303, { ...SECURITY_HEADERS, location: to, "cache-control": "no-store", ...headers }).end();
  }

  cookie(req, name, value, maxAgeS) {
    const secure = this.config.secureCookie === true || (this.config.secureCookie === "auto" && isHttps(req, this.config.trustProxy));
    return `${name}=${encodeURIComponent(value)}; Path=/admin; HttpOnly; SameSite=Strict; Max-Age=${maxAgeS}${secure ? "; Secure" : ""}`;
  }

  // The admin behind this request, or null (no session, expired, or no longer an admin).
  session(req) {
    const token = cookies(req)[COOKIE];
    const s = token ? this.sessions.get(token) : null;
    if (!s) return null;
    if (s.expires <= this.now()) {
      this.sessions.delete(token);
      return null;
    }
    const player = this.store.player(s.playerId);
    if (!player || this.store.mod.role(player.id) !== "admin") {
      this.sessions.delete(token);
      return null;
    }
    return { ...s, token, player, actor: this.moderation.actorFor(player) };
  }

  async route(req, res) {
    const url = new URL(req.url, "http://admin.invalid");
    const path = url.pathname.replace(/\/+$/, "") || "/";
    if (path === "/") return this.redirect(res, "/admin");
    if (!path.startsWith("/admin")) return this.html(res, 404, page("Not found", "<p>Not found.</p>"));
    if (path === "/admin/login") return req.method === "POST" ? this.login(req, res) : this.loginPage(req, res);
    const s = this.session(req);
    if (!s) return req.method === "GET" ? this.redirect(res, "/admin/login") : this.html(res, 401, page("Log in", "<p>Log in again.</p>"));
    if (req.method === "POST") {
      const form = await readForm(req);
      if (!same(form.csrf, s.csrf)) return this.html(res, 403, page("Refused", "<p class=\"bad\">The form expired; go back and reload.</p>"));
      if (path === "/admin/logout") {
        this.sessions.delete(s.token);
        return this.redirect(res, "/admin/login", { "set-cookie": this.cookie(req, COOKIE, "", 0) });
      }
      if (path === "/admin/action") return this.action(req, res, s, form);
      return this.html(res, 404, page("Not found", "<p>Not found.</p>"));
    }
    if (req.method !== "GET") return this.html(res, 405, page("Method", "<p>Not allowed.</p>"));
    const note = url.searchParams.get("note") ?? "";
    switch (path) {
      case "/admin": return this.html(res, 200, this.frame(s, "Overview", this.overviewBody(s), note));
      case "/admin/reports": return this.html(res, 200, this.frame(s, "Reports", this.reportsBody(s, url.searchParams.get("status") ?? "open"), note));
      case "/admin/sanctions": return this.html(res, 200, this.frame(s, "Bans and mutes", this.sanctionsBody(s), note));
      case "/admin/audit": return this.html(res, 200, this.frame(s, "Audit log", this.auditBody(url.searchParams.get("before")), note));
      case "/admin/api/overview":
        res.writeHead(200, { ...SECURITY_HEADERS, "content-type": "application/json", "cache-control": "no-store" });
        return res.end(JSON.stringify(this.mm.overview()));
      default:
        return this.html(res, 404, page("Not found", "<p>Not found.</p>"));
    }
  }

  // ---- log-in ---------------------------------------------------------------------------------------------------
  loginPage(req, res, error = "", status = 200) {
    const csrf = randomBytes(18).toString("base64url");
    this.html(res, status, page("Admin log-in", `<div class="login"><h1>Matchmaking admin</h1>${error ? `<p class="bad">${esc(error)}</p>` : ""}
<form method="post" action="/admin/login"><input type="hidden" name="csrf" value="${csrf}">
<label>Account name<br><input name="name" autocomplete="username" required></label>
<label>Password<br><input name="password" type="password" autocomplete="current-password" required></label>
<button>Log in</button></form></div>`), { "set-cookie": this.cookie(req, LOGIN_COOKIE, csrf, 600) });
  }

  async login(req, res) {
    const form = await readForm(req);
    const ip = clientIp(req, this.config.trustProxy);
    if (!same(form.csrf, cookies(req)[LOGIN_COOKIE])) return this.loginPage(req, res, "The form expired; try again.", 403);
    if (!this.loginLimit.take(ip)) return this.loginPage(req, res, "Too many log-in attempts; wait a minute.", 429);
    const name = String(form.name ?? "").slice(0, 64);
    const key = `admin:${name.toLowerCase()}`;
    if (this.mm.loginFailures.blocked(key)) return this.loginPage(req, res, "Too many failed log-ins for that name; try again later.", 429);
    let playerId;
    try {
      playerId = this.store.verifyPassword(name, form.password);
    } catch {
      this.mm.loginFailures.add(key);
      this.log?.event("warn", "admin_login_refused", { name, ip, reason: "bad_password" });
      return this.loginPage(req, res, "Wrong name or password, or not an admin.", 401);
    }
    if (this.store.mod.role(playerId) !== "admin") {
      this.log?.event("warn", "admin_login_refused", { name, ip, reason: "not_admin" });
      return this.loginPage(req, res, "Wrong name or password, or not an admin.", 401);
    }
    this.mm.loginFailures.clear(key);
    const token = randomBytes(32).toString("base64url");
    const maxAge = Math.round(this.config.sessionHours * 3600);
    this.sessions.set(token, { playerId, csrf: randomBytes(18).toString("base64url"), expires: this.now() + maxAge * 1000 });
    this.log?.event("info", "admin_login", { name, ip });
    this.redirect(res, "/admin", { "set-cookie": [this.cookie(req, COOKIE, token, maxAge), this.cookie(req, LOGIN_COOKIE, "", 0)] });
  }

  // ---- pages ----------------------------------------------------------------------------------------------------
  frame(s, title, body, note) {
    const nav = `<header><h1>Matchmaking admin</h1><nav><a href="/admin">Overview</a><a href="/admin/reports">Reports (${this.store.mod.openReportCount()})</a>
<a href="/admin/sanctions">Bans and mutes</a><a href="/admin/audit">Audit log</a></nav>
<form class="inline" method="post" action="/admin/logout">${this.csrf(s)}<span class="muted">${esc(s.player.name)}</span> <button>Log out</button></form></header>`;
    return page(`${title} - matchmaking admin`, `${note ? `<section><p>${esc(note)}</p></section>` : ""}${body}`, { nav });
  }

  csrf(s) {
    return `<input type="hidden" name="csrf" value="${esc(s.csrf)}">`;
  }

  form(s, op, fields, label, extra = "") {
    return `<form class="inline" method="post" action="/admin/action">${this.csrf(s)}<input type="hidden" name="op" value="${op}">${extra}${fields}<button>${label}</button></form>`;
  }

  hidden(name, value) {
    return `<input type="hidden" name="${name}" value="${esc(value)}">`;
  }

  sanctionFields(kind) {
    const reason = `<input name="reason" placeholder="reason" required maxlength="300">`;
    const minutes = `<input name="minutes" type="number" min="0" value="${kind === "ban" ? 1440 : 60}" style="width:7em" title="minutes (0 = permanent)">`;
    const scope = kind === "mute" ? `<select name="scope"><option>all</option><option>chat</option><option>dm</option></select>` : "";
    const address = kind === "ban" ? `<label><input type="checkbox" name="address" value="1"> address</label>` : "";
    return `${minutes}${scope}${reason}${address}`;
  }

  overviewBody(s) {
    const o = this.mm.overview();
    const rows = (list, cols, empty) => (list.length ? list.map((r) => `<tr>${cols.map((c) => `<td>${c(r)}</td>`).join("")}</tr>`).join("") : `<tr><td class="muted" colspan="${cols.length}">${empty}</td></tr>`);
    return `<section class="stats"><div><b>${o.online.length}</b>online</div><div><b>${o.queues.reduce((n, q) => n + q.players, 0)}</b>in queues</div>
<div><b>${o.matches.filter((m) => m.state === "playing").length}</b>live matches</div><div><b>${o.rooms.length}</b>lobbies</div>
<div><b>${o.openReports}</b>open reports</div><div><b>${Math.floor(o.uptimeS / 3600)}h ${Math.floor((o.uptimeS % 3600) / 60)}m</b>up</div></section>
<section><h2>Broadcast to everyone online</h2>${this.form(s, "broadcast", `<input name="text" maxlength="500" size="60" required placeholder="The server restarts in 10 minutes.">`, "Send")}</section>
<section><h2>Queues</h2><table><tr><th>Lane</th><th>Queue</th><th>Players</th><th>Longest wait</th></tr>
${rows(o.queues, [(q) => esc(q.lane), (q) => esc(q.queue), (q) => q.players, (q) => `${q.longestWaitS} s`], "Nobody is queued.")}</table></section>
<section><h2>Live matches</h2><table><tr><th>Match</th><th>Kind</th><th>Map</th><th>State</th><th>Players</th></tr>
${rows(o.matches, [(m) => esc(m.id), (m) => esc(m.kind), (m) => esc(m.map), (m) => esc(m.state), (m) => esc(m.players.join(", ")) + (m.ai ? ` + ${m.ai} computer` : "")], "No matches.")}</table></section>
<section><h2>Lobbies</h2><table><tr><th>Name</th><th>Players</th><th></th></tr>
${rows(o.rooms, [(r) => esc(r.name), (r) => `${r.players} / ${r.capacity}`, (r) => (r.locked ? "password" : "")], "No lobbies.")}</table></section>
<section><h2>Tournaments</h2><table><tr><th>Name</th><th>Status</th><th>Players</th><th>Registration ends</th></tr>
${rows(o.tournaments, [(t) => esc(t.name), (t) => esc(t.status), (t) => `${t.players} / ${t.maxPlayers}`, (t) => when(t.registrationEndsAt)], "No open tournaments.")}</table></section>
<section><h2>Online players</h2><table><tr><th>Name</th><th>Presence</th><th>Role</th><th></th></tr>
${rows(o.online, [(p) => esc(p.name), (p) => esc(p.presence), (p) => esc(p.role),
    (p) => (p.role === "admin" ? "" : this.form(s, "kick", `${this.hidden("name", p.name)}<input name="reason" placeholder="reason" maxlength="300">`, "Kick"))], "Nobody is online.")}</table></section>
<section><h2>Recent results</h2><table><tr><th>Finished</th><th>Match</th><th>Kind</th><th>Map</th><th>Status</th><th>Players</th></tr>
${rows(o.recent, [(m) => when(m.completedAt), (m) => esc(m.id), (m) => esc(m.kind), (m) => esc(m.map), (m) => esc(m.status),
    (m) => m.players.map((p) => `${esc(p.name)} <span class="muted">${esc(p.outcome ?? "")}</span>`).join(", ")], "No results yet.")}</table></section>`;
  }

  reportsBody(s, status) {
    const list = this.store.mod.reports({ status: ["open", "dismissed", "actioned", "all"].includes(status) ? status : "open", limit: 100 });
    const tabs = ["open", "actioned", "dismissed", "all"].map((x) => (x === status ? `<b>${x}</b>` : `<a href="/admin/reports?status=${x}">${x}</a>`)).join(" | ");
    const body = list.map((r) => `<tr><td>${r.id}</td><td>${when(r.createdAt)}</td><td>${esc(r.reporter)}</td><td><b>${esc(r.target)}</b></td>
<td>${esc(r.reason)}${r.match ? `<br><span class="muted">match ${esc(r.match)}</span>` : ""}</td><td>${esc(r.status)}${r.handledBy ? `<br><span class="muted">${esc(r.handledBy)}${r.note ? `: ${esc(r.note)}` : ""}</span>` : ""}</td>
<td>${r.status !== "open" ? "" : [
      this.form(s, "ban", this.sanctionFields("ban"), "Ban", this.hidden("name", r.target) + this.hidden("report", r.id)),
      this.form(s, "mute", this.sanctionFields("mute"), "Mute", this.hidden("name", r.target) + this.hidden("report", r.id)),
      this.form(s, "dismiss", `<input name="note" placeholder="note" maxlength="300">`, "Dismiss", this.hidden("report", r.id))].join("<br>")}</td></tr>`).join("");
    return `<section><h2>Reports</h2><p>${tabs}</p><table><tr><th>#</th><th>Filed</th><th>By</th><th>Player</th><th>Reason</th><th>Status</th><th>Action</th></tr>
${body || `<tr><td colspan="7" class="muted">No reports.</td></tr>`}</table></section>`;
  }

  sanctionsBody(s) {
    const bans = this.store.mod.activeBans(this.now());
    const mutes = this.store.mod.activeMutes(this.now());
    return `<section><h2>Ban, mute or set a role by name</h2>
${this.form(s, "ban", `<input name="name" placeholder="account" required>${this.sanctionFields("ban")}`, "Ban")}<br>
${this.form(s, "mute", `<input name="name" placeholder="account" required>${this.sanctionFields("mute")}`, "Mute")}<br>
${this.form(s, "role", `<input name="name" placeholder="account" required><select name="role"><option>moderator</option><option>player</option></select>`, "Set role")}
<p class="muted">Minutes 0 is permanent. Admins are made at the server (src/admin.mjs).</p></section>
<section><h2>Active bans</h2><table><tr><th>Account</th><th>Address</th><th>Ends</th><th>Reason</th><th>By</th><th></th></tr>
${bans.map((b) => `<tr><td>${esc(b.name ?? "")}</td><td>${esc(b.ip ?? "")}</td><td>${esc(describeUntil(b.until))}</td><td>${esc(b.reason)}</td><td>${esc(b.by)}</td>
<td>${b.name ? this.form(s, "unban", this.hidden("name", b.name), "Lift") : this.form(s, "unban_address", this.hidden("ip", b.ip), "Lift")}</td></tr>`).join("") || `<tr><td colspan="6" class="muted">No bans.</td></tr>`}</table></section>
<section><h2>Active mutes</h2><table><tr><th>Account</th><th>Scope</th><th>Ends</th><th>Reason</th><th>By</th><th></th></tr>
${mutes.map((m) => `<tr><td>${esc(m.name)}</td><td>${esc(m.scope)}</td><td>${esc(describeUntil(m.until))}</td><td>${esc(m.reason)}</td><td>${esc(m.by)}</td>
<td>${this.form(s, "unmute", this.hidden("name", m.name), "Lift")}</td></tr>`).join("") || `<tr><td colspan="6" class="muted">No mutes.</td></tr>`}</table></section>
<section><h2>Staff</h2><table><tr><th>Account</th><th>Role</th><th>Since</th><th>By</th></tr>
${this.store.mod.staff().map((x) => `<tr><td>${esc(x.name)}</td><td>${esc(x.role)}</td><td>${when(x.setAt)}</td><td>${esc(x.setBy ?? "")}</td></tr>`).join("")}</table></section>`;
  }

  auditBody(before) {
    const list = this.store.mod.auditLog({ limit: 100, before: before ? Number(before) : null });
    const more = list.length === 100 ? `<p><a href="/admin/audit?before=${list.at(-1).id}">Older</a></p>` : "";
    return `<section><h2>Audit log</h2><table><tr><th>When</th><th>Who</th><th>Action</th><th>Target</th><th>Detail</th></tr>
${list.map((e) => `<tr><td>${when(e.at)}</td><td>${esc(e.actor)}</td><td>${esc(e.action)}</td><td>${esc(e.target ?? "")}</td><td class="muted">${esc(e.detail ? JSON.stringify(e.detail) : "")}</td></tr>`).join("") || `<tr><td colspan="5" class="muted">Nothing yet.</td></tr>`}</table>${more}</section>`;
  }

  // ---- actions --------------------------------------------------------------------------------------------------
  action(req, res, s, f) {
    const actor = s.actor;
    const m = this.moderation;
    const back = (to, note) => this.redirect(res, `${to}?note=${encodeURIComponent(note)}`);
    const from = f.report ? "/admin/reports" : ["broadcast", "kick"].includes(f.op) ? "/admin" : "/admin/sanctions";
    try {
      let note;
      switch (f.op) {
        case "ban": {
          const r = m.ban(actor, { name: f.name, minutes: Number(f.minutes || 0), reason: f.reason, address: f.address === "1" });
          note = `${r.name} banned ${describeUntil(r.until)}${r.address ? " (and the address)" : ""}.`;
          break;
        }
        case "mute": {
          const r = m.mute(actor, { name: f.name, minutes: Number(f.minutes || 0), scope: f.scope || "all", reason: f.reason });
          note = `${r.name} muted (${r.scope}) ${describeUntil(r.until)}.`;
          break;
        }
        case "unban": note = `${m.unban(actor, { name: f.name }).name}: ban lifted.`; break;
        case "unban_address": m.unbanAddress(actor, { ip: f.ip }); note = "Address ban lifted."; break;
        case "unmute": note = `${m.unmute(actor, { name: f.name }).name}: mute lifted.`; break;
        case "kick": note = `${m.kick(actor, { name: f.name, reason: f.reason }).name} kicked.`; break;
        case "role": { const r = m.setRole(actor, { name: f.name, role: f.role }); note = `${r.name} is now ${r.role}.`; break; }
        case "broadcast": note = `Sent to ${m.broadcast(actor, f.text).delivered} players.`; break;
        case "dismiss": m.resolveReport(actor, { id: f.report, action: "dismiss", note: f.note }); note = `Report ${f.report} dismissed.`; break;
        default: throw new Error("unknown action");
      }
      if (f.report && (f.op === "ban" || f.op === "mute")) m.resolveReport(actor, { id: f.report, action: "actioned", note: f.op });
      return back(from, note);
    } catch (error) {
      return back(from, `Not done: ${error.message}`);
    }
  }
}

