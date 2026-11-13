// The hosting features over real sockets on 127.0.0.1: TLS on the control link (a self-signed
// certificate made at test time, never a committed key), the certificate reload, plain connections refused but for a
// relay, the abuse limits, replay retention, the health check, the config file and the logs. Test accounts: mmtest_*.
import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import tls from "node:tls";
import http from "node:http";
import { mkdtempSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { X509Certificate } from "node:crypto";
import { spawnSync } from "node:child_process";
import { Store } from "../src/store.mjs";
import { loadMapCatalog } from "../src/map-catalog.mjs";
import { Matchmaker } from "../src/matchmaker.mjs";
import { CertWatcher } from "../src/tls.mjs";
import { HealthServer } from "../src/health.mjs";
import { DEFAULTS, loadConfig, merge } from "../src/config.mjs";
import { createLogger } from "../src/log.mjs";
import { TokenBucket, WindowLimiter } from "../src/limits.mjs";
import { selfSigned } from "./selfsigned.mjs";

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// A line client over a plain or TLS socket.
class Client {
  constructor(socket) {
    this.socket = socket;
    this.inbox = [];
    this.waiters = [];
    this.closed = new Promise((resolve) => socket.on("close", resolve));
    let buffer = "";
    socket.on("error", () => {});
    socket.on("data", (chunk) => {
      buffer += chunk;
      for (let nl; (nl = buffer.indexOf("\n")) >= 0;) {
        const m = JSON.parse(buffer.slice(0, nl));
        buffer = buffer.slice(nl + 1);
        this.inbox.push(m);
        this.waiters = this.waiters.filter((w) => !w(m));
      }
    });
  }
  static plain(port) {
    return new Promise((resolve, reject) => {
      const s = net.connect(port, "127.0.0.1", () => resolve(new Client(s)));
      s.once("error", reject);
    });
  }
  static secure(port, ca, servername = "localhost") {
    return new Promise((resolve, reject) => {
      const s = tls.connect({ port, host: "127.0.0.1", servername, ca }, () => resolve(new Client(s)));
      s.once("error", reject);
    });
  }
  send(m) {
    this.socket.write(`${JSON.stringify(m)}\n`);
  }
  next(type, timeout = 3000) {
    const i = this.inbox.findIndex((m) => m.t === type || m.t === "error");
    if (i >= 0) return Promise.resolve(this.inbox.splice(i, 1)[0]);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no ${type}; inbox ${this.inbox.map((m) => m.t).join(",")}`)), timeout);
      this.waiters.push((m) => {
        if (m.t !== type && m.t !== "error") return false;
        clearTimeout(timer);
        this.inbox.splice(this.inbox.indexOf(m), 1);
        resolve(m);
        return true;
      });
    });
  }
  async ask(m, type) {
    this.send(m);
    return this.next(type);
  }
  close() {
    this.socket.destroy();
  }
}

const tmp = () => mkdtempSync(join(tmpdir(), "swgb-mm-host-"));
const service = async (options = {}, storeOptions = {}) => {
  const store = new Store(":memory:", storeOptions);
  const lines = [];
  const log = createLogger({ level: "debug", write: (l) => lines.push(l) });
  const mm = new Matchmaker({ store, catalog: loadMapCatalog(undefined, { includeTest: true }), port: 0, minQueueMs: 0, log, ...options });
  await mm.start();
  return { mm, store, lines };
};
const certFiles = (names = ["localhost"]) => {
  const dir = tmp();
  const pair = selfSigned({ names });
  writeFileSync(join(dir, "cert.pem"), pair.cert);
  writeFileSync(join(dir, "key.pem"), pair.key);
  return { dir, cert: join(dir, "cert.pem"), key: join(dir, "key.pem"), pem: pair.cert };
};

test("TLS: log in over TLS with the certificate verified; plain log-in refused; a relay still opens in plain", async () => {
  const f = certFiles();
  const certs = new CertWatcher({ cert: f.cert, key: f.key, reloadSeconds: 0 }).start();
  const { mm, lines } = await service({ tls: certs });
  const a = await Client.secure(mm.port, f.pem);
  assert.equal(a.socket.authorized, true);
  const auth = await a.ask({ t: "register", name: "mmtest_tls", password: "test-only-tls" }, "auth");
  assert.equal(auth.t, "auth");
  // a client that trusts nothing but the system roots refuses the self-signed certificate
  await assert.rejects(Client.secure(mm.port, undefined), /self.signed|unable to verify|certificate/i);
  // the wrong name is refused (the certificate names localhost)
  await assert.rejects(Client.secure(mm.port, f.pem, "swgb.example.org"), /altnames|Hostname|does not match/i);
  // a plain log-in: refused, the connection closed, the password never handled
  const p = await Client.plain(mm.port);
  const r = await p.ask({ t: "login", name: "mmtest_tls", password: "test-only-tls" }, "auth");
  assert.equal(r.t, "error");
  assert.match(r.message, /needs TLS/);
  await p.closed;
  // a relay over plain connections still pipes (the game's own frames)
  const token = "feedfacefeedfacefeedface";
  mm.relays.set(token, { match: "m", waiting: null, created: Date.now() });
  const r1 = await Client.plain(mm.port), r2 = await Client.plain(mm.port);
  let got = "";
  r2.socket.removeAllListeners("data");
  r2.socket.on("data", (d) => { got += d; });
  r1.send({ t: "relay", token, slot: 1 });
  await pause(20);
  r2.send({ t: "relay", token, slot: 2 });
  await pause(20);
  r1.socket.write("frame-bytes");
  await pause(50);
  assert.equal(got, "frame-bytes");
  // the logs: JSON lines, the log-in there, no password anywhere
  const parsed = lines.map((l) => JSON.parse(l));
  assert.ok(parsed.some((e) => e.event === "register" && e.player === "mmtest_tls" && e.tls === true));
  assert.ok(parsed.some((e) => e.event === "plain_refused"));
  assert.ok(!lines.join("").includes("test-only-tls"));
  assert.ok(!lines.join("").includes(auth.token));
  for (const c of [a, r1, r2]) c.close();
  await mm.stop();
  rmSync(f.dir, { recursive: true, force: true });
});

test("TLS: a renewed certificate is used by new connections without a restart; a broken one keeps the old", async () => {
  const f = certFiles();
  const lines = [];
  const certs = new CertWatcher({ cert: f.cert, key: f.key, reloadSeconds: 0, log: createLogger({ write: (l) => lines.push(l) }) }).start();
  const { mm } = await service({ tls: certs });
  const first = await Client.secure(mm.port, f.pem);
  const fp1 = first.socket.getPeerX509Certificate().fingerprint256;
  // renewal: new files in place (as a certificate renewal would write them)
  const renewed = selfSigned({ names: ["localhost"] });
  writeFileSync(f.cert, renewed.cert);
  writeFileSync(f.key, renewed.key);
  const later = new Date(Date.now() + 5000);
  utimesSync(f.cert, later, later), utimesSync(f.key, later, later);
  assert.equal(certs.check(), true);
  const second = await Client.secure(mm.port, renewed.cert);
  const fp2 = second.socket.getPeerX509Certificate().fingerprint256;
  assert.notEqual(fp1, fp2);
  assert.equal(fp2, new X509Certificate(renewed.cert).fingerprint256);
  assert.equal(first.socket.destroyed, false);  // the open connection stays
  // a half-written renewal (the key of another certificate): refused, the renewed pair stays in use
  writeFileSync(f.key, selfSigned().key);
  const later2 = new Date(Date.now() + 10_000);
  utimesSync(f.key, later2, later2);
  assert.equal(certs.check(), false);
  assert.ok(lines.some((l) => JSON.parse(l).event === "tls_reload_failed"));
  const third = await Client.secure(mm.port, renewed.cert);
  assert.equal(third.socket.getPeerX509Certificate().fingerprint256, fp2);
  for (const c of [first, second, third]) c.close();
  await mm.stop();
  rmSync(f.dir, { recursive: true, force: true });
});

test("limits: log-in attempts per address, failed log-ins per account, registrations per address", async () => {
  const limits = { ...DEFAULTS.limits, loginPerIpPerMinute: 5, loginFailuresPerAccount: 3, registerPerIpPerHour: 2 };
  const { mm, lines } = await service({ limits });
  const c = await Client.plain(mm.port);
  assert.equal((await c.ask({ t: "register", name: "mmtest_l1", password: "test-only-l1" }, "auth")).t, "auth");
  assert.equal((await c.ask({ t: "register", name: "mmtest_l2", password: "test-only-l2" }, "auth")).t, "auth");
  assert.match((await c.ask({ t: "register", name: "mmtest_l3", password: "test-only-l3" }, "auth")).message, /too many new accounts/);
  // three wrong passwords lock the name, even with the right one after
  for (let i = 0; i < 3; i += 1) assert.match((await c.ask({ t: "login", name: "mmtest_l1", password: "wrong-pass" }, "auth")).message, /wrong name or password/);
  assert.match((await c.ask({ t: "login", name: "mmtest_l1", password: "test-only-l1" }, "auth")).message, /too many failed log-ins/);
  // another name still logs in, then the address is over its 5 attempts a minute
  assert.equal((await c.ask({ t: "login", name: "mmtest_l2", password: "test-only-l2" }, "auth")).t, "auth");
  assert.match((await c.ask({ t: "login", name: "mmtest_l2", password: "test-only-l2" }, "auth")).message, /too many log-in attempts/);
  const events = lines.map((l) => JSON.parse(l)).filter((e) => e.event === "auth_refused").map((e) => e.reason);
  assert.deepEqual([...new Set(events)].sort(), ["account_locked", "bad_password", "login_rate", "register_rate"]);
  assert.ok(!lines.join("").includes("test-only-l"));
  c.close();
  await mm.stop();
});

test("limits: lock-out and rates expire with time (injected clock)", () => {
  let t = 0;
  const w = new WindowLimiter({ limit: 2, windowMs: 1000, now: () => t });
  assert.equal(w.take("a"), true);
  assert.equal(w.take("a"), true);
  assert.equal(w.take("a"), false);
  t = 1001;
  assert.equal(w.take("a"), true);
  const b = new TokenBucket({ rate: 1, burst: 2, now: () => t });
  assert.deepEqual([b.take("x"), b.take("x"), b.take("x")], [true, true, false]);
  t += 1000;
  assert.equal(b.take("x"), true);
  assert.equal(new WindowLimiter({ limit: 0, windowMs: 1 }).take("z"), true);  // 0 = no limit
});

test("limits: account names and passwords, the account cap", () => {
  const store = new Store(":memory:", { accounts: { ...DEFAULTS.accounts, maxAccounts: 2 } });
  assert.throws(() => store.register("Admin", "test-only-pw"), /reserved/);
  assert.throws(() => store.register("_mmtest", "test-only-pw"), /starting with a letter or digit/);
  assert.throws(() => store.register("mm", "test-only-pw"), /3 to 24/);
  assert.throws(() => store.register("mmtest_".padEnd(25, "x"), "test-only-pw"), /3 to 24/);
  assert.throws(() => store.register("mmtest_short", "short"), /at least 8/);
  assert.throws(() => store.register("mmtest_long", "x".repeat(129)), /at most 128/);
  assert.throws(() => store.login("mmtest_long", "x".repeat(10_000)), /wrong name or password/);  // no scrypt on that
  store.register("mmtest_c1", "test-only-pw");
  store.register("mmtest_c2", "test-only-pw");
  assert.throws(() => store.register("mmtest_c3", "test-only-pw"), /no new accounts/);
});

test("limits: chat rate per player, message size, message rate per connection, connections per address", async () => {
  const limits = { ...DEFAULTS.limits, chatPerMinute: 60, chatBurst: 3, messagesPerSecond: 10, maxConnectionsPerIp: 3 };
  const { mm, lines } = await service({ limits, messages: { chatMax: 10, dmMax: 20 } });
  const a = await Client.plain(mm.port);
  await a.ask({ t: "register", name: "mmtest_ch", password: "test-only-ch" }, "auth");
  await a.next("friends");
  await a.ask({ t: "room_create", name: "chat room" }, "room");
  const said = [];
  for (let i = 0; i < 5; i += 1) said.push(await a.ask({ t: "room_chat", text: `hello there ${i}` }, "chat"));
  assert.deepEqual(said.map((m) => m.t), ["chat", "chat", "chat", "error", "error"]);
  assert.equal(said[0].text, "hello ther");  // cut at chatMax
  assert.match(said[3].message, /too fast/);
  // the message rate: 10 a second, a burst of 20; past it, refused (the connection stays)
  for (let i = 0; i < 40; i += 1) a.send({ t: "hello" });
  await pause(100);
  const refused = a.inbox.filter((m) => m.t === "error" && /slow down/.test(m.message)).length;
  assert.ok(refused >= 15, `refused ${refused}`);
  // connections per address: 3 (a is one)
  const b = await Client.plain(mm.port), c = await Client.plain(mm.port);
  const d = await Client.plain(mm.port);
  await d.closed;
  assert.ok(lines.some((l) => JSON.parse(l).event === "connection_refused"));
  // a line over maxLineBytes closes the connection
  b.socket.write(`{"t":"hello","x":"${"y".repeat(limits.maxLineBytes + 10)}"}\n`);
  await b.closed;
  assert.ok(lines.some((l) => JSON.parse(l).event === "line_too_long"));
  for (const x of [a, c]) x.close();
  await mm.stop();
});

test("limits: a connection that does not log in is closed at authTimeoutMs", async () => {
  const { mm } = await service({ limits: { ...DEFAULTS.limits, authTimeoutMs: 150 } });
  const a = await Client.plain(mm.port);
  const b = await Client.plain(mm.port);
  await b.ask({ t: "register", name: "mmtest_to", password: "test-only-to" }, "auth");
  await a.closed;
  await pause(100);
  assert.equal(b.socket.destroyed, false);
  b.close();
  await mm.stop();
});

test("replays: size cap and retention (older than N days deleted at the sweep)", async () => {
  let t = Date.parse("2026-11-01T00:00:00Z");
  const { mm, store, lines } = await service({ replays: { maxBytes: 1000, retentionDays: 7, sweepMinutes: 0 }, now: () => t });
  const a = await Client.plain(mm.port);
  const auth = await a.ask({ t: "register", name: "mmtest_rp", password: "test-only-rp" }, "auth");
  store.createMatch({ id: "m-old", kind: "ranked", queueId: "1v1", pool: "solo", ranked: true,
    players: [{ playerId: auth.player.id, slot: 1, team: 1, rating: 1000 }] });
  a.send({ t: "replay_chunk", match: "m-old", offset: 0, data: Buffer.alloc(1001).toString("base64"), last: true });
  assert.match((await a.next("replay_stored")).message, /too large/);
  a.send({ t: "replay_chunk", match: "m-old", offset: 0, data: Buffer.alloc(900).toString("base64"), last: true });
  assert.equal((await a.next("replay_stored")).size, 900);
  // stored "now"; eight days later the sweep deletes it, a fresh one stays
  store.db.prepare("UPDATE replays SET at = ? WHERE match_id = ?").run(t - 8 * 86_400_000, "m-old");
  store.createMatch({ id: "m-new", kind: "ranked", queueId: "1v1", pool: "solo", ranked: true,
    players: [{ playerId: auth.player.id, slot: 1, team: 1, rating: 1000 }] });
  store.putReplay("m-new", auth.player.id, Buffer.alloc(10));
  store.db.prepare("UPDATE replays SET at = ? WHERE match_id = ?").run(t - 6 * 86_400_000, "m-new");
  mm.sweep();
  assert.equal(store.replay("m-old"), null);
  assert.ok(store.replay("m-new"));
  assert.ok(lines.some((l) => { const e = JSON.parse(l); return e.event === "replays_deleted" && e.count === 1; }));
  t += 2 * 86_400_000;  // two days on, the other is past 7 days
  mm.sweep();
  assert.equal(store.replay("m-new"), null);
  a.close();
  await mm.stop();
});

test("health: GET /health answers the status as JSON (503 when the database is gone)", async () => {
  const f = certFiles();
  const certs = new CertWatcher({ cert: f.cert, key: f.key, reloadSeconds: 0 }).start();
  const { mm, store } = await service({ tls: certs });
  const health = await new HealthServer({ host: "127.0.0.1", port: 0, status: () => mm.status() }).start();
  const get = (path) => new Promise((resolve, reject) => {
    http.get({ host: "127.0.0.1", port: health.port, path }, (res) => {
      let body = "";
      res.on("data", (d) => { body += d; });
      res.on("end", () => resolve({ code: res.statusCode, body }));
    }).on("error", reject);
  });
  const ok = await get("/health");
  assert.equal(ok.code, 200);
  const s = JSON.parse(ok.body);
  assert.equal(s.ok, true);
  assert.equal(s.db, true);
  assert.equal(s.tls.enabled, true);
  assert.ok(Date.parse(s.tls.validTo) > Date.now());
  assert.equal(s.service, "swgb-matchmaking");
  assert.equal((await get("/other")).code, 404);
  store.close();
  const bad = await get("/health");
  assert.equal(bad.code, 503);
  assert.equal(JSON.parse(bad.body).ok, false);
  await health.stop();
  await mm.stop();
  rmSync(f.dir, { recursive: true, force: true });
});

test("config: the file merges with the defaults, the command line wins, unknown keys are refused", () => {
  const dir = tmp();
  const file = join(dir, "config.json");
  writeFileSync(file, JSON.stringify({ port: 5000, limits: { chatPerMinute: 5 }, replays: { retentionDays: 3 } }));
  const { config } = loadConfig(["--config", file, "--port", "5001", "--test-maps"], {});
  assert.equal(config.port, 5001);
  assert.equal(config.testMaps, true);
  assert.equal(config.limits.chatPerMinute, 5);
  assert.equal(config.limits.loginPerIpPerMinute, DEFAULTS.limits.loginPerIpPerMinute);
  assert.equal(config.replays.retentionDays, 3);
  assert.equal(loadConfig([], { SWGB_MM_CONFIG: file }).config.port, 5000);
  assert.throws(() => merge(DEFAULTS, { limits: { chatPerMinut: 5 } }), /unknown config option chatPerMinut/);
  writeFileSync(file, JSON.stringify({ tls: { enabled: true } }));
  assert.throws(() => loadConfig(["--config", file], {}), /needs tls.cert and tls.key/);
  // config.example.json is the defaults (kept in step)
  const example = loadConfig(["--config", new URL("../config.example.json", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")], {}).config;
  assert.deepEqual({ ...example, host: DEFAULTS.host, db: DEFAULTS.db, tls: { ...example.tls, enabled: false, cert: "", key: "" }, health: { ...example.health, host: DEFAULTS.health.host } },
    structuredClone(DEFAULTS));
  rmSync(dir, { recursive: true, force: true });
});

test("backup: a whole copy of the database while it is open (VACUUM INTO)", () => {
  const dir = tmp();
  const db = join(dir, "mm.db"), out = join(dir, "backups", "copy.db");
  const store = new Store(db);
  store.register("mmtest_bk", "test-only-bk");
  const r = spawnSync(process.execPath, [new URL("../src/backup.mjs", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"), db, out], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const report = JSON.parse(r.stdout.trim().split("\n").at(-1));
  assert.equal(report.players, 1);
  assert.equal(report.integrity, "ok");
  const copy = new Store(out);
  assert.equal(copy.playerByName("mmtest_bk").name, "mmtest_bk");
  copy.close(), store.close();
  assert.equal(spawnSync(process.execPath, [new URL("../src/backup.mjs", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"), db, out]).status, 1);  // never over a file
  rmSync(dir, { recursive: true, force: true });
});

test("logs: JSON lines; password, token and key fields are never written", () => {
  const lines = [];
  const log = createLogger({ write: (l) => lines.push(l), now: () => new Date(0) });
  log.event("info", "login", { player: "mmtest_x", password: "test-only-secret", token: "abc123", ip: "127.0.0.1" });
  log("[matchmaking] plain text");
  log.event("debug", "hidden", {});
  assert.deepEqual(lines.map((l) => JSON.parse(l)), [
    { ts: "1970-01-01T00:00:00.000Z", level: "info", event: "login", player: "mmtest_x", ip: "127.0.0.1" },
    { ts: "1970-01-01T00:00:00.000Z", level: "info", event: "message", msg: "plain text" }
  ]);
});
