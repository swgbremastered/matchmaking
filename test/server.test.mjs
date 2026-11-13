// The service over real sockets, on 127.0.0.1 only. Test accounts: mmtest_* with test-only passwords.
import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import dgram from "node:dgram";
import { Store } from "../src/store.mjs";
import { loadMapCatalog } from "../src/map-catalog.mjs";
import { Matchmaker } from "../src/matchmaker.mjs";

class Client {
  constructor(port) {
    this.port = port;
    this.inbox = [];
    this.waiters = [];
  }
  open() {
    return new Promise((resolve, reject) => {
      this.socket = net.connect(this.port, "127.0.0.1", resolve);
      this.socket.on("error", reject);
      let buffer = "";
      this.socket.on("data", (chunk) => {
        buffer += chunk;
        for (let nl; (nl = buffer.indexOf("\n")) >= 0;) {
          const m = JSON.parse(buffer.slice(0, nl));
          buffer = buffer.slice(nl + 1);
          this.inbox.push(m);
          this.waiters = this.waiters.filter((w) => !w(m));
        }
      });
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
    const r = await this.next(type);
    if (r.t === "error") throw new Error(r.message);
    return r;
  }
  close() {
    this.socket.destroy();
  }
}

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function service(options = {}) {
  const store = new Store(":memory:");
  const mm = new Matchmaker({ store, catalog: loadMapCatalog(undefined, { includeTest: true }), port: 0, minQueueMs: 0,
    log: () => {}, ...options });
  await mm.start();
  return { mm, store };
}

async function user(port, name) {
  const c = new Client(port);
  await c.open();
  await c.ask({ t: "register", name, password: "test-only-pw" }, "auth");
  return c;
}

test("ranked 1v1: queue, match, accept, start, brokering messages, result and ratings", async () => {
  const { mm } = await service();
  const a = await user(mm.port, "mmtest_alice");
  const b = await user(mm.port, "mmtest_bob");
  await a.ask({ t: "queue_join", queue: "1v1", groups: ["test"] }, "queue");
  await pause(10);  // a queued first: a hosts (slot 1)
  await b.ask({ t: "queue_join", queue: "1v1", maps: ["test-arena", "desert"] }, "queue");
  const fa = await a.next("match_found");
  const fb = await b.next("match_found");
  assert.equal(fa.match.id, fb.match.id);
  assert.equal(fa.match.map.id, "test-arena");  // the only shared map
  assert.equal(fa.match.you, 1);
  assert.equal(fb.match.you, 2);
  a.send({ t: "accept", match: fa.match.id });
  b.send({ t: "accept", match: fa.match.id });
  const sa = await a.next("match_start");
  const sb = await b.next("match_start");
  assert.equal(sa.match.seed, sb.match.seed);
  assert.equal(sa.match.map.testStart, true);
  // the host names its address; the guest is told
  a.send({ t: "host_addr", match: sa.match.id, addrs: ["127.0.0.1:50000"] });
  assert.deepEqual((await b.next("connect")).addrs, ["127.0.0.1:50000"]);
  // results: the guest resigns, the host's game says it won
  b.send({ t: "result", match: sa.match.id, resigned: 2 });
  a.send({ t: "result", match: sa.match.id, winners: [1] });
  const ra = await a.next("result_recorded");
  assert.equal(ra.status, "completed");
  assert.deepEqual(ra.ratings.mmtest_alice, { before: 1000, after: 1016, change: 16, outcome: "win" });
  assert.deepEqual(ra.ratings.mmtest_bob, { before: 1000, after: 984, change: -16, outcome: "loss" });
  const p = await a.ask({ t: "profile", name: "mmtest_bob" }, "profile");
  assert.equal(p.profile.ratings.solo.rating, 984);
  assert.equal(p.profile.ratings.solo.losses, 1);
  a.close(), b.close();
  await mm.stop();
});

test("decline cancels the match and the pair cools down", async () => {
  const { mm } = await service();
  const a = await user(mm.port, "mmtest_a1");
  const b = await user(mm.port, "mmtest_b1");
  await a.ask({ t: "queue_join", queue: "1v1" }, "queue");
  await pause(10);  // a queued first: a hosts (slot 1)
  await b.ask({ t: "queue_join", queue: "1v1" }, "queue");
  const f = await a.next("match_found");
  await b.next("match_found");
  b.send({ t: "decline", match: f.match.id });
  const c = await a.next("match_cancelled");
  assert.equal(c.requeued, true);
  a.close(), b.close();
  await mm.stop();
});

test("conflicting reports make the match contested; no rating change", async () => {
  const { mm } = await service();
  const a = await user(mm.port, "mmtest_a2");
  const b = await user(mm.port, "mmtest_b2");
  await a.ask({ t: "queue_join", queue: "1v1" }, "queue");
  await pause(10);  // a queued first: a hosts (slot 1)
  await b.ask({ t: "queue_join", queue: "1v1" }, "queue");
  const f = await a.next("match_found");
  a.send({ t: "accept", match: f.match.id });
  b.send({ t: "accept", match: f.match.id });
  await a.next("match_start");
  a.send({ t: "result", match: f.match.id, winners: [1] });
  b.send({ t: "result", match: f.match.id, winners: [2] });
  const r = await a.next("result_recorded");
  assert.equal(r.status, "contested");
  assert.equal(r.ratings.mmtest_a2.after, 1000);
  a.close(), b.close();
  await mm.stop();
});

test("hole punch rendezvous: each side learns the other's UDP address", async () => {
  const { mm } = await service();
  const a = await user(mm.port, "mmtest_a3");
  const b = await user(mm.port, "mmtest_b3");
  await a.ask({ t: "queue_join", queue: "1v1" }, "queue");
  await pause(10);  // a queued first: a hosts (slot 1)
  await b.ask({ t: "queue_join", queue: "1v1" }, "queue");
  const f = await a.next("match_found");
  a.send({ t: "accept", match: f.match.id });
  b.send({ t: "accept", match: f.match.id });
  await a.next("match_start");
  b.send({ t: "punch_request", match: f.match.id });
  const pa = await a.next("punch");
  const pb = await b.next("punch");
  assert.equal(pa.token, pb.token);
  const ua = dgram.createSocket("udp4");
  const ub = dgram.createSocket("udp4");
  await new Promise((r) => ua.bind(0, "127.0.0.1", r));
  await new Promise((r) => ub.bind(0, "127.0.0.1", r));
  const peerOf = (sock) => new Promise((resolve) => sock.on("message", (msg) => {
    const m = JSON.parse(msg);
    if (m.t === "peer") resolve(m);
  }));
  const wa = peerOf(ua);
  const wb = peerOf(ub);
  ua.send(JSON.stringify({ t: "reg", token: pa.token, slot: 1 }), pa.udpPort, "127.0.0.1");
  ub.send(JSON.stringify({ t: "reg", token: pb.token, slot: 2 }), pb.udpPort, "127.0.0.1");
  const [ra, rb] = await Promise.all([wa, wb]);
  assert.equal(ra.port, ub.address().port);
  assert.equal(rb.port, ua.address().port);
  ua.close(), ub.close(), a.close(), b.close();
  await mm.stop();
});

test("relay: two connections with one token are piped both ways", async () => {
  const { mm } = await service();
  const a = await user(mm.port, "mmtest_a4");
  const b = await user(mm.port, "mmtest_b4");
  await a.ask({ t: "queue_join", queue: "1v1" }, "queue");
  await pause(10);  // a queued first: a hosts (slot 1)
  await b.ask({ t: "queue_join", queue: "1v1" }, "queue");
  const f = await a.next("match_found");
  a.send({ t: "accept", match: f.match.id });
  b.send({ t: "accept", match: f.match.id });
  await a.next("match_start");
  b.send({ t: "relay_request", match: f.match.id });
  const token = (await a.next("relay")).token;
  assert.equal((await b.next("relay")).token, token);
  const pipe = (slot, early) => new Promise((resolve) => {
    const s = net.connect(mm.port, "127.0.0.1", () => {
      s.write(`${JSON.stringify({ t: "relay", token, slot })}\n${early}`);
      resolve(s);
    });
  });
  const ra = await pipe(1, "from-host-early|");
  const got = new Promise((resolve) => {
    let text = "";
    ra.on("data", (d) => {
      text += d;
      if (text.includes("guest-2")) resolve(text);
    });
  });
  const rb = await pipe(2, "");
  const gotB = new Promise((resolve) => {
    let text = "";
    rb.on("data", (d) => {
      text += d;
      if (text.includes("host-2")) resolve(text);
    });
  });
  rb.write("guest-1|guest-2");
  ra.write("host-2");
  assert.equal(await got, "guest-1|guest-2");
  assert.equal(await gotB, "from-host-early|host-2");
  ra.destroy(), rb.destroy(), a.close(), b.close();
  await mm.stop();
});

test("lobby browser: rating window, chat, ready, start", async () => {
  const { mm, store } = await service();
  const a = await user(mm.port, "mmtest_host");
  const b = await user(mm.port, "mmtest_guest");
  const c = await user(mm.port, "mmtest_strong");
  store.db.prepare("UPDATE ratings SET rating = 1500 WHERE player_id = (SELECT id FROM players WHERE name = 'mmtest_strong')").run();
  const created = await a.ask({ t: "room_create", name: "Test room", minElo: 900, maxElo: 1100, maxPlayers: 2, map: "arena" }, "room");
  const id = created.room.id;
  const list = await b.ask({ t: "rooms" }, "rooms");
  assert.deepEqual(list.rooms.map((r) => [r.name, r.minElo, r.maxElo, r.map.name]), [["Test room", 900, 1100, "Arena"]]);
  c.send({ t: "room_join", room: id });
  assert.match((await c.next("room")).message, /outside 900..1100/);
  const joined = await b.ask({ t: "room_join", room: id }, "room");
  assert.equal(joined.room.players.length, 2);
  b.send({ t: "room_chat", text: "glhf" });
  assert.deepEqual(await a.next("chat").then((m) => [m.from, m.text]), ["mmtest_guest", "glhf"]);
  a.send({ t: "room_start" });
  assert.match((await a.next("error")).message, /not every player is ready/);
  b.send({ t: "room_ready", ready: true });
  await b.next("room");
  a.send({ t: "room_start" });
  const sa = await a.next("match_start");
  const sb = await b.next("match_start");
  assert.equal(sa.match.kind, "lobby");
  assert.equal(sa.match.ranked, false);
  assert.equal(sa.match.map.id, "arena");
  assert.deepEqual([sa.match.you, sb.match.you], [1, 2]);
  a.close(), b.close(), c.close();
  await mm.stop();
});
