import test from "node:test";
import assert from "node:assert/strict";
import { divisionForRating, expectedScore, ffaRatingChanges, teamRatingChange } from "../src/elo.mjs";
import { Store } from "../src/store.mjs";

test("expected score is symmetric and 0.5 for equal ratings", () => {
  assert.equal(expectedScore(1000, 1000), 0.5);
  assert.ok(Math.abs(expectedScore(1200, 1000) + expectedScore(1000, 1200) - 1) < 1e-12);
  assert.ok(Math.abs(expectedScore(1400, 1000) - 1 / (1 + 10 ** -1)) < 1e-12);
});

test("1v1: equal ratings move 16 each way (K = 32)", () => {
  assert.equal(teamRatingChange([1000], [1000]), 16);
});

test("1v1: the favourite gains less, the underdog more", () => {
  assert.equal(teamRatingChange([1200], [1000]), Math.round(32 * (1 - expectedScore(1200, 1000))));  // 8
  assert.equal(teamRatingChange([1200], [1000]), 8);
  assert.equal(teamRatingChange([1000], [1200]), 24);
});

test("team games use each side's average (empire-league's rule)", () => {
  assert.equal(teamRatingChange([1100, 900], [1000, 1000]), 16);
  assert.equal(teamRatingChange([1300, 1100], [1000, 1000]), teamRatingChange([1200], [1000]));
});

test("FFA: pairwise by place, zero sum for equal ratings", () => {
  const changes = ffaRatingChanges([
    { id: "a", rating: 1000, place: 1 }, { id: "b", rating: 1000, place: 2 },
    { id: "c", rating: 1000, place: 3 }, { id: "d", rating: 1000, place: 4 }
  ]);
  assert.deepEqual([...changes.values()], [16, 5, -5, -16]);
  assert.equal([...changes.values()].reduce((s, v) => s + v, 0), 0);
});

test("divisions follow empire-league's thresholds", () => {
  assert.equal(divisionForRating(1000), "Gold");
  assert.equal(divisionForRating(999), "Silver");
  assert.equal(divisionForRating(2200), "Grandmaster");
});

test("store: a ranked 1v1 result updates both ratings, wins, losses and streaks", () => {
  const store = new Store(":memory:");
  const a = store.register("mmtest_alice", "test-only-1").player;
  const b = store.register("mmtest_bob", "test-only-2").player;
  store.createMatch({ id: "m1", kind: "ranked", queueId: "1v1", pool: "solo", mapId: "desert", ranked: true,
    players: [{ playerId: a.id, slot: 1, team: 1 }, { playerId: b.id, slot: 2, team: 2 }] });
  const r = store.recordResult("m1", { winnerSlots: [1] });
  assert.deepEqual(r[a.id], { before: 1000, after: 1016, change: 16, outcome: "win" });
  assert.deepEqual(r[b.id], { before: 1000, after: 984, change: -16, outcome: "loss" });
  const pa = store.profile(a.id);
  assert.equal(pa.ratings.solo.rating, 1016);
  assert.equal(pa.ratings.solo.peak, 1016);
  assert.equal(pa.ratings.solo.wins, 1);
  assert.equal(pa.ratings.solo.streak, 1);
  assert.equal(pa.ratings.solo.rank, 1);
  assert.equal(pa.ratings.team.rating, 1000);  // other pools untouched
  assert.equal(store.profile(b.id).ratings.solo.streak, -1);
  assert.equal(pa.recent[0].outcome, "win");
  assert.throws(() => store.recordResult("m1", { winnerSlots: [2] }), /already/);
  assert.deepEqual(store.leaderboard("solo").map((row) => row.name), ["mmtest_alice", "mmtest_bob"]);
});

test("store: unranked and contested matches leave ratings alone", () => {
  const store = new Store(":memory:");
  const a = store.register("mmtest_carol", "test-only-3").player;
  const b = store.register("mmtest_dave", "test-only-4").player;
  const players = [{ playerId: a.id, slot: 1, team: 1 }, { playerId: b.id, slot: 2, team: 2 }];
  store.createMatch({ id: "u", kind: "lobby", queueId: "1v1", pool: "solo", ranked: false, players });
  store.recordResult("u", { winnerSlots: [1] });
  store.createMatch({ id: "c", kind: "ranked", queueId: "1v1", pool: "solo", ranked: true, players });
  store.recordResult("c", { status: "contested" });
  assert.equal(store.rating(a.id, "solo"), 1000);
  assert.equal(store.rating(b.id, "solo"), 1000);
});

test("store: accounts", () => {
  const store = new Store(":memory:");
  store.register("mmtest_erin", "test-only-5");
  assert.throws(() => store.register("MMTEST_ERIN", "x2345"), /taken/);
  assert.throws(() => store.login("mmtest_erin", "wrong"), /wrong name or password/);
  const { token } = store.login("mmtest_erin", "test-only-5");
  assert.equal(store.resume(token).player.name, "mmtest_erin");
  assert.throws(() => store.resume("nope"), /expired/);
  assert.throws(() => store.register("a b", "test-only"), /names/);
});
