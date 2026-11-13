// The public pages and JSON API over real HTTP on 127.0.0.1 only. Test accounts: mmtest_* with test-only passwords.
import test from "node:test";
import assert from "node:assert/strict";
import { PublicWeb } from "../src/public-web.mjs";
import { playRanked, service, user } from "./helpers.mjs";

async function setup(config = {}) {
  const { mm, store } = await service();
  const web = await new PublicWeb({ store, mm, config: { enabled: true, port: 0, ...config } }).start();
  const get = (path) => fetch(`http://127.0.0.1:${web.port}${path}`);
  return { mm, store, web, get, stop: async () => { await web.stop(); await mm.stop(); } };
}

async function playedMatch(t) {
  const a = await user(t.mm.port, "mmtest_pa");
  const b = await user(t.mm.port, "mmtest_pb");
  const { id } = await playRanked(a, b);
  a.send({ t: "result", match: id, winners: [1] });
  b.send({ t: "result", match: id, winners: [1] });
  await a.next("result_recorded");
  return { a, b, id };
}

test("public API: leaderboard, profile and match as JSON; no account ids, addresses or reports", async () => {
  const t = await setup();
  const { a, b, id } = await playedMatch(t);
  a.send({ t: "report_player", name: "mmtest_pb", reason: "secret-report-text" });
  await a.next("report_filed");
  const lb = await t.get("/api/leaderboard/solo");
  assert.equal(lb.status, 200);
  assert.match(lb.headers.get("cache-control"), /public, max-age=30/);
  assert.equal(lb.headers.get("access-control-allow-origin"), "*");
  const board = await lb.json();
  assert.equal(board.rows[0].rating, 1016);
  const profile = await (await t.get("/api/players/MMTEST_PA")).json();  // names are case-insensitive
  assert.equal(profile.name, "mmtest_pa");
  assert.equal(profile.ratings.solo.wins, 1);
  assert.equal(profile.recent[0].id, id);
  assert.equal(profile.recent[0].replay, false);
  const match = await (await t.get(`/api/matches/${id}`)).json();
  assert.deepEqual(match.players.map((p) => [p.name, p.outcome]), [["mmtest_pa", "win"], ["mmtest_pb", "loss"]]);
  const everything = JSON.stringify([board, profile, match]);
  for (const secret of ["127.0.0.1", "playerId", "\"id\":1,", "secret-report-text", "casual_", "pw_"]) assert.ok(!everything.includes(secret), secret);
  assert.equal((await t.get("/api/leaderboard/casual_solo")).status, 404);
  assert.equal((await t.get("/api/players/nobody_here")).status, 404);
  assert.equal((await t.get("/api/matches/match-none")).status, 404);
  assert.equal((await fetch(`http://127.0.0.1:${t.web.port}/api/leaderboard/solo`, { method: "POST" })).status, 405);
  a.close(), b.close();
  await t.stop();
});

test("public pages: minimal HTML, escaped; replays only when the config makes them public", async () => {
  const t = await setup({ replays: true });
  const { a, b, id } = await playedMatch(t);
  const html = await (await t.get("/leaderboard/solo")).text();
  assert.match(html, /<a href="\/players\/mmtest_pa">mmtest_pa<\/a>/);
  assert.match((await t.get("/leaderboard/solo")).headers.get("content-type"), /text\/html/);
  assert.match(await (await t.get(`/players/mmtest_pb`)).text(), /Recent matches/);
  // a replay: the match page links it, the link downloads it
  t.store.putReplay(id, a.auth.player.id, Buffer.from("replay-bytes"));
  const page = await (await t.get(`/matches/${id}`)).text();
  assert.match(page, /Download the replay/);
  const replay = await t.get(`/matches/${id}/replay`);
  assert.equal(replay.headers.get("content-type"), "application/octet-stream");
  assert.match(replay.headers.get("content-disposition"), /attachment/);
  assert.equal(Buffer.from(await replay.arrayBuffer()).toString(), "replay-bytes");
  assert.equal((await (await t.get(`/api/matches/${id}`)).json()).replayUrl, `/matches/${id}/replay`);
  a.close(), b.close();
  await t.stop();
  // off by default
  const t2 = await setup();
  const c = await playedMatch(t2);
  t2.store.putReplay(c.id, c.a.auth.player.id, Buffer.from("x"));
  assert.equal((await t2.get(`/matches/${c.id}/replay`)).status, 404);
  assert.equal((await (await t2.get(`/api/matches/${c.id}`)).json()).replay, false);
  c.a.close(), c.b.close();
  await t2.stop();
});

test("public API: requests per address are limited", async () => {
  const t = await setup({ requestsPerMinute: 3 });
  const codes = [];
  for (let i = 0; i < 4; i += 1) codes.push((await t.get("/api/leaderboard/team")).status);
  assert.deepEqual(codes, [200, 200, 200, 429]);
  const r = await t.get("/api/leaderboard/team");
  assert.equal(r.headers.get("retry-after"), "60");
  assert.equal(r.headers.get("cache-control"), "no-store");
  await t.stop();
});
