// Single-elimination tournaments: bracket seeding, offers, results, walkovers, disputes, chat, the public bracket.
// Over real sockets on 127.0.0.1 only. Test accounts: mmtest_* with test-only passwords.
import test from "node:test";
import assert from "node:assert/strict";
import { bracketSize, seedOrder } from "../src/tournaments.mjs";
import { PublicWeb } from "../src/public-web.mjs";
import { pause, service, testClock, user } from "./helpers.mjs";

const setRating = (store, c, rating) => store.db.prepare("UPDATE ratings SET rating = ? WHERE player_id = ? AND pool = 'solo'").run(rating, c.auth.player.id);

// both players accept the offer; returns the match_start of the first
async function play(x, y) {
  const fx = await x.next("match_found");
  await y.next("match_found");
  x.send({ t: "accept", match: fx.match.id });
  y.send({ t: "accept", match: fx.match.id });
  const s = await x.next("match_start");
  await y.next("match_start");
  return s.match;
}

test("bracket: seed order keeps the top seeds apart; the size is the next power of two", () => {
  assert.deepEqual(seedOrder(2), [1, 2]);
  assert.deepEqual(seedOrder(4), [1, 4, 2, 3]);
  assert.deepEqual(seedOrder(8), [1, 8, 4, 5, 2, 7, 3, 6]);
  assert.deepEqual([2, 3, 4, 5, 8, 9].map(bracketSize), [2, 4, 4, 8, 8, 16]);
});

test("tournament: created by staff, password and rating cap at registration, seeded, a bye, matches offered and played to a winner", async () => {
  const { mm, store } = await service();
  const web = await new PublicWeb({ store, mm, config: { enabled: true, port: 0 } }).start();
  const staff = await user(mm.port, "mmtest_to");
  store.mod.setRole(staff.auth.player.id, "moderator", "test");
  const [a, b, c, d] = await Promise.all(["mmtest_t1", "mmtest_t2", "mmtest_t3", "mmtest_t4"].map((n) => user(mm.port, n)));
  setRating(store, a, 1300), setRating(store, b, 1200), setRating(store, c, 1100), setRating(store, d, 1600);
  assert.match((await a.refused({ t: "tournament_create", name: "x" })).message, /only a moderator/);
  const made = await staff.ask({ t: "tournament_create", name: "Friday Cup", maxPlayers: 4, registrationMinutes: 60, password: "test-only-cup",
    maxRating: 1500, maps: ["test-arena"] }, "tournament");
  const id = made.tournament.id;
  assert.equal(made.tournament.locked, true);
  assert.ok(!JSON.stringify(made).includes("test-only-cup"));
  assert.match((await a.refused({ t: "tournament_join", id, password: "wrong" })).message, /wrong tournament password/);
  assert.match((await d.refused({ t: "tournament_join", id, password: "test-only-cup" })).message, /above this tournament's 1500/);
  for (const p of [a, b, c]) await p.ask({ t: "tournament_join", id, password: "test-only-cup" }, "tournament", (m) => m.tournament.players.some((x) => x.name === p.auth.player.name));
  const list = await d.ask({ t: "tournaments" }, "tournaments");
  assert.equal(list.tournaments[0].players, 3);
  // started early by staff: seeds by rating 1 = t1, 2 = t2, 3 = t3; t1 has a bye to the final
  const started = await staff.ask({ t: "tournament_start", id }, "tournament");
  assert.deepEqual(started.tournament.players.map((p) => [p.name, p.seed]), [["mmtest_t1", 1], ["mmtest_t2", 2], ["mmtest_t3", 3]]);
  assert.deepEqual(started.tournament.bracket.map((m) => [m.round, m.position, m.player1, m.player2, m.status]),
    [[1, 1, "mmtest_t1", null, "bye"], [1, 2, "mmtest_t2", "mmtest_t3", "ready"], [2, 1, "mmtest_t1", null, "waiting"]]);
  // the semi-final is offered by the server within a second
  const semi = await play(b, c);
  assert.equal(semi.kind, "tournament");
  assert.deepEqual(semi.tournament, { id, name: "Friday Cup", round: 1, position: 2 });
  assert.equal(semi.ranked, false);
  b.send({ t: "result", match: semi.id, winners: [2] });
  c.send({ t: "result", match: semi.id, winners: [2] });
  assert.equal((await b.next("result_recorded")).ratings.mmtest_t2.change, 0);  // no rating change
  // the final: t1 against t3
  const final = await play(a, c);
  assert.deepEqual(final.players.map((p) => p.name), ["mmtest_t1", "mmtest_t3"]);
  a.send({ t: "result", match: final.id, winners: [1] });
  c.send({ t: "result", match: final.id, winners: [1] });
  await a.next("result_recorded");
  await pause(20);
  const done = mm.tournaments.view(id);
  assert.equal(done.status, "completed");
  assert.equal(done.winner, "mmtest_t1");
  // the public bracket, without the chat
  const pub = await (await fetch(`http://127.0.0.1:${web.port}/api/tournaments/${id}`)).json();
  assert.equal(pub.winner, "mmtest_t1");
  assert.equal(pub.bracket[1].winner, "mmtest_t3");
  assert.equal(pub.chat, undefined);
  assert.match(await (await fetch(`http://127.0.0.1:${web.port}/tournaments/${id}`)).text(), /won by <b>mmtest_t1<\/b>/);
  assert.equal((await (await fetch(`http://127.0.0.1:${web.port}/api/tournaments`)).json()).tournaments.length, 1);
  for (const x of [staff, a, b, c, d]) x.close();
  await web.stop();
  await mm.stop();
});

test("tournament: registration closes on time; a no-show loses by walkover; a decline is offered again; a dispute waits for staff", async () => {
  const clock = testClock();
  const { mm, store } = await service({ now: clock.now, tournaments: { retrySeconds: 5 } });
  const step = () => { mm.tournaments.lastTick = 0; mm.tick(); };
  const staff = await user(mm.port, "mmtest_wo");
  store.mod.setRole(staff.auth.player.id, "admin", "test");
  const [a, b, c, d] = await Promise.all(["mmtest_w1", "mmtest_w2", "mmtest_w3", "mmtest_w4"].map((n) => user(mm.port, n)));
  setRating(store, a, 1400), setRating(store, b, 1300), setRating(store, c, 1200), setRating(store, d, 1100);
  const id = (await staff.ask({ t: "tournament_create", name: "Walkover Cup", maxPlayers: 4, registrationMinutes: 10, noShowMinutes: 5 }, "tournament")).tournament.id;
  for (const p of [a, b, c, d]) await p.ask({ t: "tournament_join", id }, "tournament", (m) => m.tournament.players.some((x) => x.name === p.auth.player.name));
  d.close();  // seed 4 goes away: their semi-final against seed 1 cannot be offered
  await pause(30);
  clock.advance(10 * 60_000);
  step();  // the registration window ends: the bracket is made
  assert.equal(mm.tournaments.view(id).status, "running");
  // seed 2 against seed 3 is offered; seed 3 declines; offered again after retrySeconds
  const offer = await b.next("match_found");
  await c.next("match_found");
  c.send({ t: "decline", match: offer.match.id });
  await b.next("match_cancelled");
  step();
  assert.equal(mm.tournaments.view(id).bracket[1].status, "ready");
  clock.advance(5000);
  step();
  const again = await b.next("match_found");
  await c.next("match_found");
  b.send({ t: "accept", match: again.match.id });
  c.send({ t: "accept", match: again.match.id });
  await b.next("match_start");
  // the players disagree: disputed, staff are told and settle it
  b.send({ t: "result", match: again.match.id, winners: [1] });
  c.send({ t: "result", match: again.match.id, winners: [2] });
  assert.equal((await b.next("result_recorded")).status, "contested");
  const disputed = await staff.next("tournament_disputed");
  assert.deepEqual([disputed.round, disputed.position], [1, 2]);
  assert.match((await staff.refused({ t: "tournament_set_winner", id, round: 1, position: 2, winner: "mmtest_w1" })).message, /one of the match's players/);
  await staff.ask({ t: "tournament_set_winner", id, round: 1, position: 2, winner: "mmtest_w2" }, "tournament");
  // seed 1's opponent never came: after the no-show time seed 1 goes on by walkover
  clock.advance(5 * 60_000);
  step();
  const v = mm.tournaments.view(id);
  assert.deepEqual(v.bracket.map((m) => [m.round, m.position, m.winner, m.status]).slice(0, 2), [[1, 1, "mmtest_w1", "walkover"], [1, 2, "mmtest_w2", "done"]]);
  assert.equal(v.bracket[2].status, "ready");
  // the final is offered at once (both online)
  step();
  await a.next("match_found");
  await b.next("match_found");
  // staff cancel: the offer goes, the tournament is cancelled
  await staff.ask({ t: "tournament_cancel", id }, "tournament");
  await a.next("match_cancelled");
  assert.equal(mm.tournaments.view(id).status, "cancelled");
  const audit = store.mod.auditLog().map((e) => e.action);
  for (const action of ["tournament_create", "tournament_set_winner", "tournament_cancel"]) assert.ok(audit.includes(action), action);
  for (const x of [staff, a, b, c]) x.close();
  await mm.stop();
});

test("tournament chat: registered players and staff; muted players refused; fewer than two players cancel it", async () => {
  const { mm, store } = await service();
  const staff = await user(mm.port, "mmtest_co");
  store.mod.setRole(staff.auth.player.id, "moderator", "test");
  const a = await user(mm.port, "mmtest_c1");
  const b = await user(mm.port, "mmtest_c2");
  const outsider = await user(mm.port, "mmtest_c3");
  const id = (await staff.ask({ t: "tournament_create", name: "Chat Cup", maxPlayers: 2 }, "tournament")).tournament.id;
  await a.ask({ t: "tournament_join", id }, "tournament");
  await b.ask({ t: "tournament_join", id }, "tournament", (m) => m.tournament.players.length === 2);
  assert.match((await outsider.refused({ t: "tournament_join", id })).message, /full/);
  assert.match((await outsider.refused({ t: "tournament_chat", id, text: "hi" })).message, /not in that tournament/);
  a.send({ t: "tournament_chat", id, text: "good luck" });
  assert.equal((await b.next("tournament_chat")).text, "good luck");
  const view = await b.ask({ t: "tournament_get", id }, "tournament", (m) => m.tournament.chat?.length);
  assert.equal(view.tournament.chat.at(-1).from, "mmtest_c1");
  await staff.ask({ t: "mod_mute", name: "mmtest_c1", minutes: 5, scope: "chat", reason: "spam" }, "mod_done");
  assert.match((await a.refused({ t: "tournament_chat", id, text: "x" })).message, /muted/);
  await b.ask({ t: "tournament_leave", id }, "tournament");
  await staff.ask({ t: "tournament_start", id }, "tournament");
  assert.equal(mm.tournaments.view(id).status, "cancelled");
  for (const x of [staff, a, b, outsider]) x.close();
  await mm.stop();
});
