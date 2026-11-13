// The admin dashboard over real HTTP on 127.0.0.1 only. Test accounts: mmtest_* with test-only passwords.
import test from "node:test";
import assert from "node:assert/strict";
import { AdminServer } from "../src/admin-web.mjs";
import { service, user } from "./helpers.mjs";

const csrfOf = (html) => html.match(/name="csrf" value="([^"]+)"/)[1];
const cookieOf = (res, name) => (res.headers.getSetCookie().find((c) => c.startsWith(`${name}=`)) ?? "");

async function setup(config = {}) {
  const { mm, store } = await service();
  const web = await new AdminServer({ mm, config: { enabled: true, port: 0, ...config } }).start();
  const base = `http://127.0.0.1:${web.port}`;
  const get = (path, cookie = "", headers = {}) => fetch(base + path, { redirect: "manual", headers: { cookie, ...headers } });
  const post = (path, cookie, form, headers = {}) => fetch(base + path, { method: "POST", redirect: "manual",
    headers: { cookie, "content-type": "application/x-www-form-urlencoded", ...headers }, body: new URLSearchParams(form).toString() });
  // logs in as `name`; returns the session cookie and the page's CSRF token
  const login = async (name, password = "test-only-pw") => {
    const page = await get("/admin/login");
    const pre = cookieOf(page, "mm_login").split(";")[0];
    const r = await post("/admin/login", pre, { csrf: csrfOf(await page.text()), name, password });
    const session = cookieOf(r, "mm_admin").split(";")[0];
    if (r.status !== 303) return { status: r.status, text: await r.text() };
    const home = await get("/admin", session);
    return { status: r.status, session, setCookie: cookieOf(r, "mm_admin"), csrf: csrfOf(await home.text()) };
  };
  return { mm, store, web, get, post, login, stop: async () => { await web.stop(); await mm.stop(); } };
}

test("admin dashboard log-in: admins only, CSRF on the form, HttpOnly SameSite=Strict cookie, Secure behind TLS", async () => {
  const t = await setup({ trustProxy: true });
  const admin = await user(t.mm.port, "mmtest_wa");
  t.store.mod.setRole(admin.auth.player.id, "admin", "test");
  const plain = await user(t.mm.port, "mmtest_wp");
  t.store.mod.setRole(plain.auth.player.id, "moderator", "test");
  assert.equal((await t.get("/admin")).headers.get("location"), "/admin/login");
  // the log-in form without its cookie's token is refused
  assert.equal((await t.post("/admin/login", "", { csrf: "x", name: "mmtest_wa", password: "test-only-pw" })).status, 403);
  assert.equal((await t.login("mmtest_wa", "wrong-pw-here")).status, 401);
  assert.equal((await t.login("mmtest_wp")).status, 401);  // a moderator is not an admin
  const s = await t.login("mmtest_wa");
  assert.equal(s.status, 303);
  assert.match(s.setCookie, /HttpOnly/);
  assert.match(s.setCookie, /SameSite=Strict/);
  assert.doesNotMatch(s.setCookie, /Secure/);
  const page = await t.get("/admin/login", "", { "x-forwarded-proto": "https" });
  assert.match(cookieOf(page, "mm_login"), /; Secure/);
  const home = await t.get("/admin", s.session);
  assert.equal(home.status, 200);
  assert.match(home.headers.get("content-security-policy"), /default-src 'none'/);
  assert.equal(home.headers.get("cache-control"), "no-store");
  const html = await home.text();
  assert.match(html, /mmtest_wp/);  // online
  assert.ok(!html.includes("test-only-pw"));
  // a demoted admin's session ends
  t.store.mod.setRole(admin.auth.player.id, "player", "test");
  assert.equal((await t.get("/admin", s.session)).status, 303);
  admin.close(), plain.close();
  await t.stop();
});

test("admin dashboard: overview, broadcast, reports with ban / dismiss, bans and mutes, audit log; forms need the CSRF token", async () => {
  const t = await setup();
  const admin = await user(t.mm.port, "mmtest_xa");
  t.store.mod.setRole(admin.auth.player.id, "admin", "test");
  const a = await user(t.mm.port, "mmtest_xb");
  const b = await user(t.mm.port, "mmtest_xc");
  const s = await t.login("mmtest_xa");
  // no token, no action
  assert.equal((await t.post("/admin/action", s.session, { op: "broadcast", text: "hi" })).status, 403);
  assert.equal((await t.post("/admin/action", "", { op: "broadcast", text: "hi", csrf: s.csrf })).status, 401);
  const sent = await t.post("/admin/action", s.session, { op: "broadcast", text: "maintenance soon", csrf: s.csrf });
  assert.match(decodeURIComponent(sent.headers.get("location")), /Sent to 3 players/);
  assert.equal((await a.next("broadcast")).text, "maintenance soon");
  // reports: ban from the queue resolves the report
  const r1 = await a.ask({ t: "report_player", name: "mmtest_xc", reason: "abusive chat" }, "report_filed");
  const r2 = await b.ask({ t: "report_player", name: "mmtest_xb", reason: "nothing really" }, "report_filed");
  const reports = await (await t.get("/admin/reports", s.session)).text();
  assert.match(reports, /abusive chat/);
  const banned = await t.post("/admin/action", s.session, { op: "ban", name: "mmtest_xc", minutes: "60", reason: "abuse", report: String(r1.id), csrf: s.csrf });
  assert.match(decodeURIComponent(banned.headers.get("location")), /^\/admin\/reports\?note=mmtest_xc banned until/);
  assert.equal((await b.next("banned")).reason, "abuse");
  assert.equal(t.store.mod.report(r1.id).status, "actioned");
  await t.post("/admin/action", s.session, { op: "dismiss", report: String(r2.id), note: "no evidence", csrf: s.csrf });
  assert.equal(t.store.mod.report(r2.id).status, "dismissed");
  // a mute by name, listed, then lifted
  await t.post("/admin/action", s.session, { op: "mute", name: "mmtest_xb", minutes: "30", scope: "chat", reason: "caps", csrf: s.csrf });
  let sanctions = await (await t.get("/admin/sanctions", s.session)).text();
  assert.match(sanctions, /caps/);
  assert.match(sanctions, /abuse/);
  await t.post("/admin/action", s.session, { op: "unmute", name: "mmtest_xb", csrf: s.csrf });
  await t.post("/admin/action", s.session, { op: "unban", name: "mmtest_xc", csrf: s.csrf });
  sanctions = await (await t.get("/admin/sanctions", s.session)).text();
  assert.match(sanctions, /No bans/);
  assert.match(sanctions, /No mutes/);
  // a refusal comes back as a note
  const no = await t.post("/admin/action", s.session, { op: "ban", name: "mmtest_xa", reason: "x", csrf: s.csrf });
  assert.match(decodeURIComponent(no.headers.get("location")), /Not done: not on your own account/);
  const audit = await (await t.get("/admin/audit", s.session)).text();
  for (const action of ["broadcast", "ban", "report_actioned", "report_dismissed", "mute", "unmute", "unban"]) assert.match(audit, new RegExp(`<td>${action}</td>`));
  const api = await (await t.get("/admin/api/overview", s.session)).json();
  assert.deepEqual(api.online.map((p) => p.name), ["mmtest_xa", "mmtest_xb"]);
  assert.equal(api.openReports, 0);
  // log out ends the session
  await t.post("/admin/logout", s.session, { csrf: s.csrf });
  assert.equal((await t.get("/admin", s.session)).status, 303);
  admin.close(), a.close(), b.close();
  await t.stop();
});

test("admin dashboard: log-in attempts per address are limited; HTML in names is escaped", async () => {
  const t = await setup({ loginPerIpPerMinute: 2 });
  const admin = await user(t.mm.port, "mmtest_ya");
  t.store.mod.setRole(admin.auth.player.id, "admin", "test");
  await t.login("mmtest_ya", "wrong-pw-1");
  await t.login("mmtest_ya", "wrong-pw-2");
  const third = await t.login("mmtest_ya");
  assert.equal(third.status, 429);
  t.web.loginLimit.clear("127.0.0.1");
  const s = await t.login("mmtest_ya");
  const c = await user(t.mm.port, "mmtest_yb");
  await c.ask({ t: "room_create", name: "<script>alert(1)</script>" }, "room");
  const html = await (await t.get("/admin", s.session)).text();
  assert.ok(!html.includes("<script>alert"));
  assert.match(html, /&lt;script&gt;/);
  admin.close(), c.close();
  await t.stop();
});
