import test from "node:test";
import assert from "node:assert/strict";
import { loadMapCatalog } from "../src/map-catalog.mjs";
import { QueueEngine, balancedTeams, ratingsInRange, spreadFor } from "../src/queue.mjs";

const catalog = loadMapCatalog(undefined, { includeTest: true });
const all = catalog.normalize({});
let seq = 0;
const ticket = (queueId, rating, joinedAt = 0, prefs = all, extra = {}) => ({
  id: `t${++seq}`, playerId: seq, name: `p${seq}`, queueId, rating, joinedAt, prefs, ...extra
});

test("map pool: groups and per-map toggles", () => {
  const land = catalog.normalize({ groups: ["land-open"] });
  assert.ok(land.maps.includes("desert") && !land.maps.includes("arena"));
  const two = catalog.normalize({ groups: ["land-open", "water"], maps: ["desert", "sea", "unknown"] });
  assert.deepEqual(two.maps, ["desert", "sea"]);
  assert.deepEqual(two.ignored, ["unknown"]);
  assert.throws(() => catalog.normalize({ groups: ["water"], maps: ["desert"] }), /enabled groups/);
  assert.throws(() => catalog.normalize({ groups: ["nope"] }), /invalid/);
  assert.throws(() => catalog.normalize({ maps: [] }), /at least one/);
  assert.equal(loadMapCatalog().get("test-arena"), undefined);  // test map only with --test-maps
});

test("map pick: shared pool, mutual favourite first", () => {
  const a = catalog.normalize({ maps: ["desert", "arena", "sea"], favorites: { "land-closed": "arena" } });
  const b = catalog.normalize({ maps: ["arena", "sea"], favorites: { "land-closed": "arena" } });
  assert.deepEqual(catalog.shared([a, b]), ["arena", "sea"]);
  for (let i = 0; i < 20; i += 1) assert.equal(catalog.select([a, b], Math.random).id, "arena");
  const c = catalog.normalize({ maps: ["tundra"] });
  assert.equal(catalog.select([a, c]), undefined);
});

test("rating range widens with time in the queue (1v1: 50 -> 250)", () => {
  const t = ticket("1v1", 1000, 0);
  assert.equal(spreadFor(t, 0), 50);
  assert.equal(spreadFor(t, 20_000), 75);
  assert.equal(spreadFor(t, 95_000), 250);
  const u = ticket("1v1", 1120, 0);
  assert.equal(ratingsInRange(t, u, 0), false);
  assert.equal(ratingsInRange(t, u, 60_000), true);
});

test("1v1: closest rating is matched, the earliest joined hosts", () => {
  const q = new QueueEngine({ catalog, minQueueMs: 0 });
  const a = q.join(ticket("1v1", 1000, 100));
  q.join(ticket("1v1", 1040, 200));
  const c = q.join(ticket("1v1", 1010, 300));
  const [m, ...rest] = q.matchAll(1000);
  assert.equal(rest.length, 0);
  assert.deepEqual(m.participants.map((p) => p.playerId).sort(), [a.playerId, c.playerId].sort());
  assert.equal(m.host.playerId, a.playerId);
  assert.ok(m.map);
});

test("1v1: out of range waits, then matches once the range widened", () => {
  const q = new QueueEngine({ catalog, minQueueMs: 0 });
  q.join(ticket("1v1", 1000, 0));
  q.join(ticket("1v1", 1200, 0));
  assert.equal(q.matchAll(1000).length, 0);
  assert.equal(q.matchAll(91_000).length, 1);
});

test("1v1: minimum queue time and disjoint map pools hold a match back", () => {
  const q = new QueueEngine({ catalog, minQueueMs: 15_000 });
  q.join(ticket("1v1", 1000, 0));
  q.join(ticket("1v1", 1000, 0, catalog.normalize({ maps: ["desert"] })));
  assert.equal(q.matchAll(10_000).length, 0);
  assert.equal(q.matchAll(15_000).length, 1);
  const r = new QueueEngine({ catalog, minQueueMs: 0 });
  r.join(ticket("1v1", 1000, 0, catalog.normalize({ maps: ["desert"] })));
  r.join(ticket("1v1", 1000, 0, catalog.normalize({ maps: ["sea"] })));
  assert.equal(r.matchAll(0).length, 0);
});

test("queues do not mix", () => {
  const q = new QueueEngine({ catalog, minQueueMs: 0 });
  q.join(ticket("1v1", 1000, 0));
  q.join(ticket("team", 1000, 0, all, { teamSizes: [2] }));
  assert.equal(q.matchAll(0).length, 0);
});

test("team: four players make the most even 2v2, host on team one", () => {
  const q = new QueueEngine({ catalog, minQueueMs: 0 });
  const ratings = [1100, 1000, 1050, 1060];
  const ts = ratings.map((r, i) => q.join(ticket("team", r, i, all, { teamSizes: [2] })));
  const [m] = q.matchAll(10);
  assert.equal(m.teamSize, 2);
  assert.equal(m.host.playerId, ts[0].playerId);
  const sum = (team) => team.reduce((s, p) => s + p.rating, 0);
  assert.equal(Math.abs(sum(m.teams[0]) - sum(m.teams[1])), 10);  // 1100+1000 vs 1060+1050
  assert.ok(m.teams[0].includes(m.host));
});

test("team: the largest size the tickets allow is tried first", () => {
  const q = new QueueEngine({ catalog, minQueueMs: 0 });
  for (let i = 0; i < 6; i += 1) q.join(ticket("team", 1000 + i, i, all, { teamSizes: [2, 3] }));
  const [m] = q.matchAll(10);
  assert.equal(m.teamSize, 3);
  assert.equal(m.participants.length, 6);
});

test("balancedTeams with a lone host", () => {
  const ps = [{ id: "a", rating: 1000 }, { id: "b", rating: 1200 }];
  assert.deepEqual(balancedTeams(ps, ps[0], 1).map((t) => t.map((p) => p.id)), [["a"], ["b"]]);
});

test("FFA: groups ffaPlayers players with pairwise ratings in range", () => {
  const q = new QueueEngine({ catalog, minQueueMs: 0, ffaPlayers: 3 });
  q.join(ticket("ffa", 1000, 0));
  q.join(ticket("ffa", 1100, 1));
  assert.equal(q.matchAll(0).length, 0);
  q.join(ticket("ffa", 1300, 2));  // 300 from the first: outside the FFA's 200 at first
  assert.equal(q.matchAll(0).length, 0);
  q.join(ticket("ffa", 1150, 3));
  const [m] = q.matchAll(10);
  assert.equal(m.participants.length, 3);
  assert.equal(m.teams.length, 3);
});
