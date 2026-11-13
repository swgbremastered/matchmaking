// Roles, bans, mutes, reports, the audit log; over the protocol and from the command line (src/admin.mjs).
// Over real sockets on 127.0.0.1 only. Test accounts: mmtest_* with test-only passwords.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.mjs";
import { Moderation, OPERATOR, grantConfigAdmins } from "../src/moderation.mjs";
import { describeUntil } from "../src/moderation-store.mjs";
import { run as adminCli } from "../src/admin.mjs";
import { Client, login, pause, playRanked, service, testClock, user } from "./helpers.mjs";

const HOUR = 3_600_000;

test("moderation store: roles, timed and permanent bans, address bans, mutes by scope, reports, audit", () => {
  const store = new Store(":memory:");
  const a = store.register("mmtest_ma", "test-only-pw").player;
  const b = store.register("mmtest_mb", "test-only-pw").player;
  const mod = store.mod;
  assert.equal(mod.role(a.id), "player");
  mod.setRole(a.id, "moderator", "test");
  assert.equal(mod.role(a.id), "moderator");
  assert.throws(() => mod.setRole(a.id, "king", "test"), /role is one of/);
  mod.setRole(a.id, "player", "test");
  assert.equal(mod.role(a.id), "player");

  const t = 1_000_000;
  mod.addBan({ playerId: b.id, reason: "griefing", endsAt: t + HOUR, by: "test", now: t });
  assert.equal(mod.activeBan({ playerId: b.id }, t + 1).reason, "griefing");
  assert.equal(mod.activeBan({ playerId: b.id }, t + HOUR + 1), null);  // over
  mod.addBan({ ip: "203.0.113.7", reason: "spam", by: "test", now: t });
  assert.equal(mod.activeBan({ ip: "203.0.113.7" }, t + 100 * HOUR).until, null);  // permanent
  assert.equal(mod.liftAddressBans("203.0.113.7", "test", t + 2), 1);
  assert.equal(mod.activeBan({ ip: "203.0.113.7" }, t + 3), null);
  assert.equal(mod.activeBan({}, t), null);  // neither given: never a match

  mod.addMute({ playerId: b.id, scope: "dm", reason: "insults", endsAt: t + HOUR, by: "test", now: t });
  assert.equal(mod.activeMute(b.id, "dm", t + 1).scope, "dm");
  assert.equal(mod.activeMute(b.id, "chat", t + 1), null);
  mod.addMute({ playerId: b.id, scope: "all", reason: "flood", endsAt: t + HOUR, by: "test", now: t });
  assert.equal(mod.activeMute(b.id, "chat", t + 1).reason, "flood");
  assert.equal(mod.liftMutes(b.id, "test", t + 2), 2);

  const r = mod.addReport({ reporterId: a.id, targetId: b.id, reason: "afk", now: t });
  assert.equal(mod.openReportCount(), 1);
  mod.resolveReport(r, "dismissed", "test", "no proof", t + 5);
  assert.throws(() => mod.resolveReport(r, "dismissed", "test"), /no open report/);
  assert.equal(mod.reports({ status: "dismissed" })[0].note, "no proof");
  mod.audit({ actor: "test", action: "ban", targetId: b.id, target: b.name, detail: { x: 1 } });
  assert.deepEqual(mod.auditLog()[0].detail, { x: 1 });
  assert.equal(describeUntil(null), "permanently");
  assert.equal(describeUntil(Date.UTC(2026, 10, 20, 18, 0)), "until 2026-11-20 18:00 UTC");
  store.close();
});

test("config admins: existing accounts become admins; a missing name is only logged, never reserved", () => {
  const store = new Store(":memory:");
  store.register("mmtest_boss", "test-only-pw");
  const events = [];
  grantConfigAdmins(store, ["mmtest_boss", "mmtest_later"], { event: (lvl, name, f) => events.push([name, f.name]) });
  assert.equal(store.mod.role(store.playerByName("mmtest_boss").id), "admin");
  assert.deepEqual(events, [["admin_granted", "mmtest_boss"], ["admin_missing", "mmtest_later"]]);
  const later = store.register("mmtest_later", "test-only-pw").player;
  assert.equal(store.mod.role(later.id), "player");
  assert.equal(store.mod.auditLog()[0].actor, "config");
  store.close();
});

test("ban: the player is closed with the end time, cannot log in until it ends, then can", async () => {
  const clock = testClock();
  const { mm, store } = await service({ now: clock.now });
  grantConfigAdmins(store, [], null);
  const admin = await user(mm.port, "mmtest_admin");
  store.mod.setRole(admin.auth.player.id, "admin", "test");
  const p = await user(mm.port, "mmtest_banme");
  assert.equal(p.auth.role, "player");
  const done = await admin.ask({ t: "mod_ban", name: "mmtest_banme", minutes: 60, reason: "cheating" }, "mod_done");
  assert.equal(done.until, clock.now() + HOUR);
  const banned = await p.next("banned");
  assert.equal(banned.reason, "cheating");
  assert.equal(banned.until, clock.now() + HOUR);
  await p.closed;
  assert.equal(mm.online.has(p.auth.player.id), false);
  const again = new Client(mm.port);
  await again.open();
  const r = await again.refused({ t: "login", name: "mmtest_banme", password: "test-only-pw" });
  assert.match(r.message, /banned until .* UTC: cheating/);
  assert.equal(r.banned.until, clock.now() + HOUR);
  // a wrong password says nothing about the ban
  const wrong = await again.refused({ t: "login", name: "mmtest_banme", password: "not-the-pw" });
  assert.match(wrong.message, /wrong name or password/);
  clock.advance(HOUR + 1);
  const back = await login(mm.port, "mmtest_banme");
  assert.equal(back.auth.t, "auth");
  // the audit log has it
  const audit = await admin.ask({ t: "mod_audit" }, "mod_audit");
  assert.deepEqual(audit.entries.map((e) => [e.actor, e.action, e.target]), [["mmtest_admin", "ban", "mmtest_banme"]]);
  for (const c of [admin, again, back]) c.close();
  await mm.stop();
});

test("roles: players may not moderate; moderators give timed bans only, never to staff; admins set roles", async () => {
  const { mm, store } = await service();
  const admin = await user(mm.port, "mmtest_ad");
  store.mod.setRole(admin.auth.player.id, "admin", "test");
  const m = await user(mm.port, "mmtest_md");
  const p = await user(mm.port, "mmtest_pl");
  assert.match((await p.refused({ t: "mod_ban", name: "mmtest_md", minutes: 5, reason: "x" })).message, /only a moderator/);
  assert.match((await p.refused({ t: "mod_reports" })).message, /only a moderator/);
  await admin.ask({ t: "mod_role", name: "mmtest_md", role: "moderator" }, "mod_done");
  assert.match((await m.refused({ t: "mod_role", name: "mmtest_pl", role: "moderator" })).message, /only an admin/);
  assert.match((await m.refused({ t: "mod_ban", name: "mmtest_pl", reason: "x" })).message, /needs a length/);
  assert.match((await m.refused({ t: "mod_ban", name: "mmtest_pl", minutes: 31 * 1440, reason: "x" })).message, /at most 30 days/);
  assert.match((await m.refused({ t: "mod_ban", name: "mmtest_pl", minutes: 5, reason: "x", address: true })).message, /only an admin/);
  assert.match((await m.refused({ t: "mod_ban", name: "mmtest_ad", minutes: 5, reason: "x" })).message, /is a admin/);
  assert.match((await m.refused({ t: "mod_ban", name: "mmtest_pl", minutes: 5 })).message, /needs a reason/);
  assert.match((await admin.refused({ t: "mod_role", name: "mmtest_pl", role: "admin" })).message, /at the server/);
  assert.match((await admin.refused({ t: "mod_ban", name: "mmtest_ad", reason: "x" })).message, /own account/);
  // a kick: closed with the reason, may come back
  await m.ask({ t: "mod_kick", name: "mmtest_pl", reason: "cool off" }, "mod_done");
  assert.equal((await p.next("kicked")).reason, "cool off");
  await p.closed;
  assert.match((await m.refused({ t: "mod_kick", name: "mmtest_pl" })).message, /not online/);
  const back = await login(mm.port, "mmtest_pl");
  assert.equal(back.auth.t, "auth");
  // an admin's permanent account-and-address ban keeps a new account from that address out as well
  await admin.ask({ t: "mod_ban", name: "mmtest_pl", reason: "ban evasion", address: true }, "mod_done");
  assert.equal((await back.next("banned")).until, null);
  const fresh = new Client(mm.port);
  await fresh.open();
  assert.match((await fresh.refused({ t: "register", name: "mmtest_pl2", password: "test-only-pw" })).message, /banned permanently: ban evasion/);
  // the moderator sees that the ban covers an address, not the address
  const bans = await m.ask({ t: "mod_bans" }, "mod_bans");
  assert.equal(bans.bans[0].ip, "(hidden)");
  const adminBans = await admin.ask({ t: "mod_bans" }, "mod_bans");
  assert.equal(adminBans.bans[0].ip, "127.0.0.1");
  // staff on that address stay (the moderator and the admin share 127.0.0.1 here)
  assert.equal(mm.online.has(m.auth.player.id), true);
  for (const c of [admin, m, back, fresh]) c.close();
  await mm.stop();
});

test("mutes: lobby, party chat and direct messages are refused with the reason; unmute lifts it", async () => {
  const { mm, store } = await service();
  const admin = await user(mm.port, "mmtest_mad");
  store.mod.setRole(admin.auth.player.id, "moderator", "test");
  const a = await user(mm.port, "mmtest_mua");
  const b = await user(mm.port, "mmtest_mub");
  await a.ask({ t: "friend_add", name: "mmtest_mub" }, "friends");
  await b.ask({ t: "friend_accept", name: "mmtest_mua" }, "friends", (m) => m.friends.some((f) => f.state === "friend"));
  await admin.ask({ t: "mod_mute", name: "mmtest_mua", minutes: 10, scope: "dm", reason: "insults" }, "mod_done");
  assert.equal((await a.next("muted")).scope, "dm");
  const dm = await a.refused({ t: "dm", to: "mmtest_mub", text: "hey" });
  assert.match(dm.message, /muted until .*: insults/);
  assert.equal(dm.muted.scope, "dm");
  await a.ask({ t: "room_create", name: "r" }, "room");
  await a.ask({ t: "room_chat", text: "lobby is fine" }, "chat");  // a dm mute leaves lobby chat alone
  await admin.ask({ t: "mod_mute", name: "mmtest_mua", minutes: 10, scope: "chat", reason: "spam" }, "mod_done");
  assert.match((await a.refused({ t: "room_chat", text: "spam" })).message, /muted .*: spam/);
  await a.ask({ t: "room_leave" }, "room");
  await a.ask({ t: "party_invite", name: "mmtest_mub" }, "party");
  const inv = await b.next("party_invite");
  await b.ask({ t: "party_accept", party: inv.party }, "party");
  assert.match((await a.refused({ t: "party_chat", text: "x" })).message, /muted/);
  const list = await admin.ask({ t: "mod_mutes" }, "mod_mutes");
  assert.equal(list.mutes.length, 2);
  await admin.ask({ t: "mod_unmute", name: "mmtest_mua" }, "mod_done");
  await a.next("unmuted");
  await a.ask({ t: "dm", to: "mmtest_mub", text: "sorry" }, "dm");
  assert.match((await admin.refused({ t: "mod_unmute", name: "mmtest_mua" })).message, /not muted/);
  for (const c of [admin, a, b]) c.close();
  await mm.stop();
});

test("reports: filed with a match, rate-limited, shown to staff online, resolved, audited", async () => {
  const { mm, store } = await service({ moderation: { reportsPerHour: 2 } });
  const staff = await user(mm.port, "mmtest_rs");
  store.mod.setRole(staff.auth.player.id, "moderator", "test");
  const a = await user(mm.port, "mmtest_ra");
  const b = await user(mm.port, "mmtest_rb");
  const { id } = await playRanked(a, b);
  const filed = await a.ask({ t: "report_player", name: "mmtest_rb", reason: "map hack", match: id }, "report_filed");
  const seen = await staff.next("mod_report");
  assert.equal(seen.report.id, filed.id);
  assert.equal(seen.report.match, id);
  assert.match((await a.refused({ t: "report_player", name: "mmtest_ra", reason: "x" })).message, /yourself/);
  assert.match((await a.refused({ t: "report_player", name: "mmtest_rb", reason: "" })).message, /needs a reason/);
  assert.match((await staff.refused({ t: "report_player", name: "mmtest_rb", reason: "x", match: id })).message, /not in that match/);
  await a.ask({ t: "report_player", name: "mmtest_rb", reason: "rude" }, "report_filed");
  assert.match((await a.refused({ t: "report_player", name: "mmtest_rb", reason: "again" })).message, /too many reports/);
  const open = await staff.ask({ t: "mod_reports" }, "mod_reports");
  assert.equal(open.reports.length, 2);
  await staff.ask({ t: "mod_report_resolve", id: filed.id, action: "dismiss", note: "replay shows nothing" }, "mod_done");
  const after = await staff.ask({ t: "mod_reports" }, "mod_reports");
  assert.equal(after.reports.length, 1);
  const look = await staff.ask({ t: "mod_lookup", name: "mmtest_rb" }, "mod_lookup");
  assert.equal(look.player.reports.length, 2);
  assert.equal(look.player.address, undefined);  // moderators see no addresses
  assert.equal((await staff.ask({ t: "mod_audit" }, "mod_audit")).entries[0].action, "report_dismissed");
  for (const c of [staff, a, b]) c.close();
  await mm.stop();
});

test("broadcast reaches every online player; the command line acts as the operator and its bans reach a running server", async () => {
  const dir = mkdtempSync(join(tmpdir(), "swgb-mm-mod-"));
  const file = join(dir, "mm.db");
  const { mm, store } = await service({ moderation: { sweepSeconds: 1 } }, file);
  const admin = await user(mm.port, "mmtest_cad");
  const p = await user(mm.port, "mmtest_cpl");
  const quiet = () => {};
  adminCli(["--db", file, "role", "mmtest_cad", "admin"], {}, quiet);
  assert.equal(store.mod.role(admin.auth.player.id), "admin");
  const sent = await admin.ask({ t: "mod_broadcast", text: "restart in 5 minutes" }, "mod_done");
  assert.equal(sent.delivered, 2);
  assert.equal((await p.next("broadcast")).text, "restart in 5 minutes");
  // a ban written by another process closes the player within sweepSeconds
  const result = adminCli(["--db", file, "ban", "mmtest_cpl", "--minutes", "30", "--reason", "toxic"], {}, quiet);
  assert.equal(result.name, "mmtest_cpl");
  assert.equal((await p.next("banned", () => true, 4000)).reason, "toxic");
  assert.equal(adminCli(["--db", file, "bans"], {}, quiet).length, 1);
  adminCli(["--db", file, "unban", "mmtest_cpl"], {}, quiet);
  assert.equal(adminCli(["--db", file, "audit"], {}, quiet)[0].actor, "operator");
  assert.throws(() => adminCli(["--db", file, "frobnicate"], {}, quiet), /usage/);
  assert.throws(() => adminCli(["--db", join(dir, "none.db"), "bans"], {}, quiet), /no database/);
  // the operator may act on an admin
  const op = new Moderation({ store });
  assert.equal(op.setRole(OPERATOR, { name: "mmtest_cad", role: "player" }).role, "player");
  admin.close(), p.close();
  await mm.stop();
  await pause(50);
  store.close();
  rmSync(dir, { recursive: true, force: true });
});
