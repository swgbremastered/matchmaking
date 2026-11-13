// Unranked and weekly queues, friends, direct messages, presence, parties, match history, replays, lobby
// civilisations and settings, FFA placings, a control link that comes back. Over real sockets on 127.0.0.1 only.
// Test accounts: mmtest_* with test-only passwords.
import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { Store } from "../src/store.mjs";
import { loadMapCatalog } from "../src/map-catalog.mjs";
import { Matchmaker } from "../src/matchmaker.mjs";
import { QueueEngine } from "../src/queue.mjs";
import { weekLabel, weeklyQueue } from "../src/weekly.mjs";

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
  // the next message of that type (or an error), optionally one that passes `when`
  next(type, when = () => true, timeout = 3000) {
    const ok = (m) => (m.t === type && when(m)) || m.t === "error";
    const i = this.inbox.findIndex(ok);
    if (i >= 0) return Promise.resolve(this.inbox.splice(i, 1)[0]);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no ${type}; inbox ${this.inbox.map((m) => m.t).join(",")}`)), timeout);
      this.waiters.push((m) => {
        if (!ok(m)) return false;
        clearTimeout(timer);
        this.inbox.splice(this.inbox.indexOf(m), 1);
        resolve(m);
        return true;
      });
    });
  }
  async ask(m, type, when) {
    this.send(m);
    const r = await this.next(type, when);
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

async function user(port, name, how = "register") {
  const c = new Client(port);
  await c.open();
  const a = await c.ask({ t: how, name, password: "test-only-pw" }, "auth");
  c.token = a.token;
  return c;
}

const hidden = (store, name, pool) =>
  store.db.prepare("SELECT r.rating FROM ratings r JOIN players p ON p.id = r.player_id WHERE p.name = ? AND r.pool = ?").get(name, pool).rating;

async function playOut(a, b, queue, extra = {}) {
  await a.ask({ t: "queue_join", queue, groups: ["test"], ...extra }, "queue");
  await pause(10);
  await b.ask({ t: "queue_join", queue, groups: ["test"], ...extra }, "queue");
  const f = await a.next("match_found");
  await b.next("match_found");
  a.send({ t: "accept", match: f.match.id });
  b.send({ t: "accept", match: f.match.id });
  const sa = await a.next("match_start");
  await b.next("match_start");
  return sa.match;
}

test("unranked 1v1: same matching, the shown rating stays, the hidden casual rating moves, history keeps it", async () => {
  const { mm, store } = await service();
  const a = await user(mm.port, "mmtest_ua");
  const b = await user(mm.port, "mmtest_ub");
  // a ranked ticket and an unranked one never meet
  await a.ask({ t: "queue_join", queue: "1v1", groups: ["test"] }, "queue");
  await b.ask({ t: "queue_join", queue: "1v1", ranked: false, groups: ["test"] }, "queue");
  await pause(300);
  assert.equal(a.inbox.some((m) => m.t === "match_found"), false);
  await a.ask({ t: "queue_leave" }, "queue");
  await b.ask({ t: "queue_leave" }, "queue");
  const match = await playOut(a, b, "1v1", { ranked: false });
  assert.equal(match.kind, "unranked");
  assert.equal(match.ranked, false);
  b.send({ t: "result", match: match.id, resigned: 2 });
  a.send({ t: "result", match: match.id, winners: [1] });
  const r = await a.next("result_recorded");
  assert.equal(r.status, "completed");
  assert.equal(r.ranked, false);
  assert.deepEqual(r.ratings.mmtest_ua, { before: 1000, after: 1000, change: 0, outcome: "win" });
  assert.deepEqual(r.ratings.mmtest_ub, { before: 1000, after: 1000, change: 0, outcome: "loss" });
  assert.equal(hidden(store, "mmtest_ua", "casual_solo"), 1016);
  assert.equal(hidden(store, "mmtest_ub", "casual_solo"), 984);
  const p = await a.ask({ t: "profile" }, "profile");
  assert.equal(p.profile.ratings.solo.rating, 1000);
  assert.equal(p.profile.ratings.casual_solo, undefined);  // never shown
  const h = await a.ask({ t: "history" }, "history");
  assert.equal(h.matches.length, 1);
  assert.equal(h.matches[0].ranked, false);
  assert.equal(h.matches[0].outcome, "win");
  assert.deepEqual(h.matches[0].players.map((x) => [x.name, x.outcome]), [["mmtest_ua", "win"], ["mmtest_ub", "loss"]]);
  a.close(), b.close();
  await mm.stop();
});

test("unranked pairs by the hidden rating, not the shown one", () => {
  const catalog = loadMapCatalog(undefined, { includeTest: true });
  const prefs = catalog.normalize({});
  const q = new QueueEngine({ catalog, minQueueMs: 0 });
  q.join({ id: "t1", playerId: 1, name: "x", queueId: "1v1", lane: "unranked", rating: 1000, joinedAt: 0, prefs });
  q.join({ id: "t2", playerId: 2, name: "y", queueId: "1v1", lane: "ranked", rating: 1000, joinedAt: 0, prefs });
  q.join({ id: "t3", playerId: 3, name: "z", queueId: "1v1", lane: "unranked", rating: 1400, joinedAt: 0, prefs });
  assert.equal(q.matchAll(0).length, 0);  // lanes do not mix; 1000 vs 1400 is out of range
  q.join({ id: "t4", playerId: 4, name: "w", queueId: "1v1", lane: "unranked", rating: 1390, joinedAt: 0, prefs });
  const [m] = q.matchAll(0);
  assert.deepEqual(m.participants.map((p) => p.playerId).sort(), [3, 4]);
  assert.equal(m.lane, "unranked");
});

test("weekly queue: this week's format and maps, unranked, the week kept with the match", async () => {
  const rotation = [{ id: "test-duel", name: "Test Duel", queue: "1v1", groups: ["test"] }];
  const { mm, store } = await service({ weeklyRotation: rotation });
  const w = weeklyQueue(Date.now(), rotation);
  assert.equal(w.week, weekLabel(Date.now()));
  assert.match(w.week, /^\d{4}-W\d\d$/);
  assert.equal(weekLabel(Date.UTC(2026, 10, 12)), "2026-W46");
  const a = await user(mm.port, "mmtest_wa");
  const b = await user(mm.port, "mmtest_wb");
  const maps = await a.ask({ t: "maps" }, "maps");
  assert.equal(maps.weekly.id, "test-duel");
  const q = await a.ask({ t: "queue_join", queue: "weekly" }, "queue");
  assert.equal(q.ranked, false);
  assert.equal(q.lane, `weekly:${w.week}`);
  await pause(10);
  await b.ask({ t: "queue_join", queue: "weekly" }, "queue");
  const f = await a.next("match_found");
  assert.equal(f.match.kind, "weekly");
  assert.equal(f.match.week, w.week);
  assert.equal(f.match.map.id, "test-arena");
  a.send({ t: "accept", match: f.match.id });
  b.send({ t: "accept", match: f.match.id });
  await a.next("match_start");
  a.send({ t: "result", match: f.match.id, winners: [2] });
  b.send({ t: "result", match: f.match.id, winners: [2] });
  const r = await a.next("result_recorded");
  assert.equal(r.ratings.mmtest_wb.change, 0);
  assert.equal(hidden(store, "mmtest_wb", "casual_solo"), 1016);
  const h = await b.ask({ t: "history" }, "history");
  assert.equal(h.matches[0].week, w.week);
  a.close(), b.close();
  await mm.stop();
});

test("friends, presence and direct messages (an offline player gets them at log-in)", async () => {
  const { mm } = await service();
  const a = await user(mm.port, "mmtest_fa");
  const b = await user(mm.port, "mmtest_fb");
  b.send({ t: "dm", to: "mmtest_fa", text: "hi" });
  assert.match((await b.next("error")).message, /not your friend/);
  a.send({ t: "friend_add", name: "mmtest_fb" });
  assert.equal((await b.next("friend_request")).from, "mmtest_fa");
  assert.deepEqual((await b.next("friends", (m) => m.friends.length)).friends, [{ name: "mmtest_fa", state: "incoming", presence: "" }]);
  b.send({ t: "friend_accept", name: "mmtest_fa" });
  const fa = await a.next("friends", (m) => m.friends[0]?.state === "friend");
  assert.deepEqual(fa.friends, [{ name: "mmtest_fb", state: "friend", presence: "idle" }]);
  // presence follows the queue
  b.send({ t: "queue_join", queue: "1v1", groups: ["test"] });
  assert.equal((await a.next("presence", (m) => m.name === "mmtest_fb")).presence, "looking");
  b.send({ t: "queue_leave" });
  assert.equal((await a.next("presence", (m) => m.name === "mmtest_fb")).presence, "idle");
  // a direct message both ways, then one kept for an offline player
  b.send({ t: "dm", to: "mmtest_fa", text: "glhf" });
  const got = await a.next("dm");
  assert.deepEqual([got.from, got.to, got.text], ["mmtest_fb", "mmtest_fa", "glhf"]);
  assert.equal((await b.next("dm")).delivered, true);
  a.close();
  assert.equal((await b.next("presence", (m) => m.name === "mmtest_fa")).presence, "offline");
  b.send({ t: "dm", to: "mmtest_fa", text: "while you were away" });
  assert.equal((await b.next("dm")).delivered, false);
  const a2 = await user(mm.port, "mmtest_fa", "login");
  const late = await a2.next("dm");
  assert.deepEqual([late.from, late.text, late.offline], ["mmtest_fb", "while you were away", true]);
  assert.equal((await b.next("presence", (m) => m.name === "mmtest_fa")).presence, "idle");
  const hist = await a2.ask({ t: "dm_history", with: "mmtest_fb" }, "dm_history");
  assert.deepEqual(hist.messages.map((x) => x.text), ["glhf", "while you were away"]);
  a2.close(), b.close();
  await mm.stop();
});

test("a party stays together: invite, chat, queues as one team, a decline keeps it together", async () => {
  const { mm } = await service();
  const a = await user(mm.port, "mmtest_pa");
  const b = await user(mm.port, "mmtest_pb");
  const c = await user(mm.port, "mmtest_pc");
  const d = await user(mm.port, "mmtest_pd");
  a.send({ t: "party_invite", name: "mmtest_pb" });
  const inv = await b.next("party_invite");
  assert.equal(inv.from, "mmtest_pa");
  b.send({ t: "party_accept", party: inv.party });
  const party = await a.next("party", (m) => m.party?.members.length === 2);
  assert.deepEqual(party.party.members.map((x) => [x.name, x.leader]), [["mmtest_pa", true], ["mmtest_pb", false]]);
  b.send({ t: "party_chat", text: "ready when you are" });
  assert.deepEqual(await a.next("party_chat").then((m) => [m.from, m.text]), ["mmtest_pb", "ready when you are"]);
  // only the leader queues; the party is refused in 1v1
  b.send({ t: "queue_join", queue: "team", ranked: false, groups: ["test"] });
  assert.match((await b.next("error")).message, /leader/);
  a.send({ t: "queue_join", queue: "1v1", groups: ["test"] });
  assert.match((await a.next("error")).message, /team games only/);
  // the party and two players queue unranked 2v2: the party is one team
  await a.ask({ t: "queue_join", queue: "team", ranked: false, teamSizes: [2], groups: ["test"] }, "queue");
  assert.equal((await b.next("queue")).party, true);
  await pause(10);
  await c.ask({ t: "queue_join", queue: "team", ranked: false, teamSizes: [2], groups: ["test"] }, "queue");
  await d.ask({ t: "queue_join", queue: "team", ranked: false, teamSizes: [2], groups: ["test"] }, "queue");
  const found = await a.next("match_found");
  await b.next("match_found");
  const team = Object.fromEntries(found.match.players.map((p) => [p.name, p.team]));
  assert.equal(team.mmtest_pa, team.mmtest_pb);
  assert.notEqual(team.mmtest_pa, team.mmtest_pc);
  assert.equal(team.mmtest_pc, team.mmtest_pd);
  assert.equal(found.match.you, 1);  // the leader queued first: it hosts
  // c declines: the party is back in the queue together (d too); c is out
  c.send({ t: "decline", match: found.match.id });
  const ca = await a.next("match_cancelled");
  const cb = await b.next("match_cancelled");
  assert.deepEqual([ca.requeued, cb.requeued], [true, true]);
  const party2 = await a.ask({ t: "party_chat", text: "still here" }, "party_chat");
  assert.equal(party2.from, "mmtest_pa");
  // a member leaving takes the party out of the queue; a party of one is disbanded
  b.send({ t: "party_leave" });
  assert.equal((await a.next("queue", (m) => m.state === "idle")).state, "idle");
  assert.equal((await a.next("party", (m) => m.party === null)).party, null);
  a.close(), b.close(), c.close(), d.close();
  await mm.stop();
});

test("replays: a player uploads in chunks, anyone logged in fetches it, the history says so", async () => {
  const { mm } = await service();
  const a = await user(mm.port, "mmtest_ra");
  const b = await user(mm.port, "mmtest_rb");
  const c = await user(mm.port, "mmtest_rc");
  const match = await playOut(a, b, "1v1");
  const data = Buffer.from(Array.from({ length: 70_000 }, (_, i) => (i * 7) & 0xff));
  c.send({ t: "replay_chunk", match: match.id, offset: 0, data: data.toString("base64"), last: true });
  assert.match((await c.next("error")).message, /not in that match/);
  for (let off = 0; off < data.length; off += 30_000)
    a.send({ t: "replay_chunk", match: match.id, offset: off, data: data.subarray(off, off + 30_000).toString("base64"), last: off + 30_000 >= data.length });
  assert.deepEqual(await a.next("replay_stored").then((m) => [m.size, m.kept]), [70_000, true]);
  a.send({ t: "result", match: match.id, winners: [1] });
  b.send({ t: "result", match: match.id, winners: [1] });
  await a.next("result_recorded");
  c.send({ t: "replay_get", match: match.id });
  const parts = [];
  for (;;) {
    const m = await c.next("replay_chunk");
    assert.equal(m.t, "replay_chunk");
    assert.equal(m.offset, parts.reduce((s, p) => s + p.length, 0));
    parts.push(Buffer.from(m.data, "base64"));
    if (m.last) break;
  }
  assert.ok(Buffer.concat(parts).equals(data));
  const h = await b.ask({ t: "history" }, "history");
  assert.deepEqual([h.matches[0].replay, h.matches[0].replaySize], [true, 70_000]);
  a.close(), b.close(), c.close();
  await mm.stop();
});

test("a control link that comes back: the player is not gone, its report still counts", async () => {
  const s = await service();
  const x = await user(s.mm.port, "mmtest_cx");
  const y = await user(s.mm.port, "mmtest_cy");
  const m2 = await playOut(x, y, "1v1");
  const yid = s.store.playerByName("mmtest_cy").id;
  assert.equal(s.mm.presenceOf(yid), "in_game");
  y.close();
  await pause(50);
  assert.equal(s.mm.presenceOf(yid), "offline");  // y's control link drops in the game and comes back before any report
  await pause(100);
  const y2 = new Client(s.mm.port);
  await y2.open();
  y2.send({ t: "resume", token: y.token });
  assert.equal((await y2.next("match_resumed")).match, m2.id);
  x.send({ t: "result", match: m2.id, winners: [1] });
  await pause(200);
  assert.equal(x.inbox.some((m) => m.t === "result_recorded"), false);  // waits for y's report again
  y2.send({ t: "result", match: m2.id, resigned: 2 });
  const r = await x.next("result_recorded");
  assert.equal(r.ratings.mmtest_cx.change, 16);
  x.close(), y2.close();
  await s.mm.stop();
});

test("lobby: civilisations and the host's settings reach the match", async () => {
  const { mm } = await service();
  const a = await user(mm.port, "mmtest_la");
  const b = await user(mm.port, "mmtest_lb");
  const created = await a.ask({ t: "room_create", name: "Civ room", minElo: 0, maxElo: 9999, map: "test-arena", civ: "rebel",
    settings: { popCap: 200, startAge: 2, reveal: true } }, "room");
  assert.deepEqual(created.room.settings, { popCap: 200, startAge: 2, reveal: true });
  await b.ask({ t: "room_join", room: created.room.id, civ: "WOOKIEES" }, "room");
  await b.ask({ t: "room_set", civ: "gungans" }, "room", (m) => m.room.players[1]?.civ === "GUNGANS");
  b.send({ t: "room_settings", popCap: 25 });
  assert.match((await b.next("error")).message, /host/);
  await a.ask({ t: "room_settings", popCap: 150 }, "room", (m) => m.room.settings.popCap === 150);
  await b.ask({ t: "room_ready", ready: true }, "room", (m) => m.room.players[1]?.ready);
  a.send({ t: "room_start" });
  const s = await b.next("match_start");
  assert.deepEqual(s.match.players.map((p) => p.civ), ["REBEL", "GUNGANS"]);
  assert.deepEqual(s.match.settings, { popCap: 150, startAge: 2, reveal: true });
  a.close(), b.close();
  await mm.stop();
});

test("FFA: the reported placings rate every pair", async () => {
  const { mm } = await service({ ffaPlayers: 3 });
  const cs = [];
  for (const n of ["mmtest_x1", "mmtest_x2", "mmtest_x3"]) cs.push(await user(mm.port, n));
  for (const c of cs) {
    await c.ask({ t: "queue_join", queue: "ffa", groups: ["test"] }, "queue");
    await pause(10);
  }
  const f = await cs[0].next("match_found");
  for (const c of cs) c.send({ t: "accept", match: f.match.id });
  await cs[0].next("match_start");
  const slot = Object.fromEntries(f.match.players.map((p) => [p.name, p.slot]));
  const places = { [slot.mmtest_x2]: 1, [slot.mmtest_x3]: 2, [slot.mmtest_x1]: 3 };
  for (const c of cs) c.send({ t: "result", match: f.match.id, winners: [slot.mmtest_x2], places });
  const r = await cs[0].next("result_recorded");
  assert.equal(r.ratings.mmtest_x2.change, 16);   // beat both: 2 x 16 / 2
  assert.equal(r.ratings.mmtest_x3.change, 0);    // beat one, lost to one
  assert.equal(r.ratings.mmtest_x1.change, -16);
  for (const c of cs) c.close();
  await mm.stop();
});
