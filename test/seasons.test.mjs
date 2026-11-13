// Seasons: calendar quarters, kept records, the soft reset; over the protocol and the public pages (127.0.0.1 only).
// Test accounts: mmtest_* with test-only passwords.
import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store.mjs";
import { Seasons, seasonBounds, seasonOf, softReset } from "../src/seasons.mjs";
import { PublicWeb } from "../src/public-web.mjs";
import { service, testClock, user } from "./helpers.mjs";

test("seasons: quarters in UTC, the soft reset", () => {
  assert.equal(seasonOf(Date.UTC(2026, 10, 12)), "2026-Q4");
  assert.equal(seasonOf(Date.UTC(2027, 0, 1)), "2027-Q1");
  assert.deepEqual(seasonBounds("2026-Q4"), { start: Date.UTC(2026, 9, 1), end: Date.UTC(2027, 0, 1) });
  assert.throws(() => seasonBounds("2026-Q5"), /YEAR-Q1/);
  assert.equal(softReset(1400, 0.5), 1200);
  assert.equal(softReset(800, 0.5), 900);
  assert.equal(softReset(1400, 0), 1000);
});

test("seasons: off by default; at a quarter's end the played ratings are kept, then reset; casual ratings stay", () => {
  const store = new Store(":memory:");
  const a = store.register("mmtest_sa", "test-only-pw").player;
  const b = store.register("mmtest_sb", "test-only-pw").player;
  store.register("mmtest_sc", "test-only-pw");  // never played: no record
  const set = (id, pool, rating, wins, losses) => store.db.prepare("UPDATE ratings SET rating = ?, peak = ?, wins = ?, losses = ? WHERE player_id = ? AND pool = ?")
    .run(rating, rating + 10, wins, losses, id, pool);
  set(a.id, "solo", 1400, 10, 2), set(b.id, "solo", 1100, 3, 5), set(a.id, "casual_solo", 1300, 1, 0);
  assert.equal(new Seasons({ store }).check(Date.UTC(2026, 11, 1)), null);
  assert.equal(new Seasons({ store }).current(), null);  // disabled: nothing opened
  const clock = testClock(Date.UTC(2026, 11, 1));
  const s = new Seasons({ store, config: { enabled: true }, now: clock.now });
  s.check();
  assert.equal(s.current(), "2026-Q4");
  clock.advance(31 * 86_400_000);  // into 2027-Q1
  assert.equal(s.check(), "2026-Q4");
  assert.equal(s.current(), "2027-Q1");
  assert.deepEqual(s.standings("2026-Q4", "solo").map((r) => [r.rank, r.name, r.rating, r.wins]), [[1, "mmtest_sa", 1400, 10], [2, "mmtest_sb", 1100, 3]]);
  assert.equal(store.rating(a.id, "solo"), 1200);
  assert.equal(store.rating(b.id, "solo"), 1050);
  assert.equal(store.ratings(a.id).solo.wins, 0);
  assert.equal(store.rating(a.id, "casual_solo"), 1300);
  assert.equal(s.records(a.id)[0].season, "2026-Q4");
  assert.equal(s.check(), null);  // once per season
  store.close();
});

test("seasons over the protocol and the public pages", async () => {
  const clock = testClock(Date.UTC(2026, 11, 30));
  const { mm, store } = await service({ now: clock.now, seasons: { enabled: true } });
  const web = await new PublicWeb({ store, mm, config: { enabled: true, port: 0 } }).start();
  const a = await user(mm.port, "mmtest_sp");
  store.db.prepare("UPDATE ratings SET rating = 1300, wins = 4 WHERE player_id = ? AND pool = 'solo'").run(a.auth.player.id);
  mm.seasons.check();
  clock.advance(3 * 86_400_000);
  mm.seasons.check();
  assert.equal((await a.ask({ t: "seasons" }, "seasons")).current, "2027-Q1");
  const final = await a.ask({ t: "season", season: "2026-Q4", pool: "solo" }, "season");
  assert.deepEqual(final.rows.map((r) => [r.name, r.rating]), [["mmtest_sp", 1300]]);
  assert.equal((await a.ask({ t: "season_records" }, "season_records")).records[0].rating, 1300);
  const pub = await (await fetch(`http://127.0.0.1:${web.port}/api/seasons/2026-Q4/solo`)).json();
  assert.equal(pub.rows[0].name, "mmtest_sp");
  const profile = await (await fetch(`http://127.0.0.1:${web.port}/api/players/mmtest_sp`)).json();
  assert.equal(profile.seasons[0].season, "2026-Q4");
  assert.equal(profile.ratings.solo.rating, 1150);
  assert.equal((await fetch(`http://127.0.0.1:${web.port}/api/seasons/1999-Q1/solo`)).status, 404);
  a.close();
  await web.stop();
  await mm.stop();
});
