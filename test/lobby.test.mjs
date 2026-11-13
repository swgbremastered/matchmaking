// Lobby passwords, search and filters, the host's kick / slot / team / computer-player controls, host transfer.
// Over real sockets on 127.0.0.1 only. Test accounts: mmtest_* with test-only passwords.
import test from "node:test";
import assert from "node:assert/strict";
import { pause, service, user } from "./helpers.mjs";

test("password lobby: hashed, never echoed, a locked flag in rooms; join needs it; wrong tries are rate-limited", async () => {
  const { mm } = await service({ limits: { roomPasswordPerIpPerMinute: 3 } });
  const host = await user(mm.port, "mmtest_lh");
  const g = await user(mm.port, "mmtest_lg");
  const created = await host.ask({ t: "room_create", name: "secret game", password: "test-only-room" }, "room");
  assert.equal(created.room.locked, true);
  assert.ok(!JSON.stringify(created).includes("test-only-room"));
  const list = await g.ask({ t: "rooms" }, "rooms");
  assert.equal(list.rooms[0].locked, true);
  assert.equal(list.filtered, undefined);  // the plain list as before
  assert.ok(!JSON.stringify(list).includes("test-only-room"));
  const id = created.room.id;
  assert.match((await g.refused({ t: "room_join", room: id })).message, /wrong lobby password/);
  assert.match((await g.refused({ t: "room_join", room: id, password: "nope" })).message, /wrong lobby password/);
  const joined = await g.ask({ t: "room_join", room: id, password: "test-only-room" }, "room", (m) => m.room?.players.length === 2);
  assert.equal(joined.room.players.length, 2);
  await g.ask({ t: "room_leave" }, "room");
  // the fourth try in a minute from this address is refused before the password is looked at
  assert.match((await g.refused({ t: "room_join", room: id, password: "test-only-room" })).message, /too many lobby password attempts/);
  assert.match((await g.refused({ t: "room_create", password: "x".repeat(65) })).message, /lobby password/);
  host.close(), g.close();
  await mm.stop();
});

test("rooms search: text, full, locked, ranked, map, pool, size and rating window; pushes stay unfiltered", async () => {
  const { mm, store } = await service();
  const a = await user(mm.port, "mmtest_sa");
  const b = await user(mm.port, "mmtest_sb");
  const c = await user(mm.port, "mmtest_sc");
  const seeker = await user(mm.port, "mmtest_seek");
  seeker.fresh = true;
  await a.ask({ t: "room_create", name: "Naboo night", maxPlayers: 2, ranked: true }, "room");
  await b.ask({ t: "room_create", name: "chill ffa", pool: "ffa", maxPlayers: 4, password: "test-only-x", map: "tundra" }, "room");
  store.db.prepare("UPDATE ratings SET rating = 1500 WHERE player_id = ? AND pool = 'solo'").run(c.auth.player.id);
  await c.ask({ t: "room_create", name: "high only", minElo: 1400, maxElo: 2000 }, "room");
  await pause(50);  // the pushed room lists reach the seeker first
  const names = async (q) => (await seeker.ask({ t: "rooms", ...q }, "rooms")).rooms.map((r) => r.name).sort();
  assert.deepEqual(await names({ query: "naboo" }), ["Naboo night"]);
  assert.deepEqual(await names({ query: "MMTEST_SB" }), ["chill ffa"]);  // the host's name
  assert.deepEqual(await names({ hideLocked: true }), ["Naboo night", "high only"]);
  assert.deepEqual(await names({ ranked: true }), ["Naboo night"]);
  assert.deepEqual(await names({ ranked: false }), ["chill ffa", "high only"]);
  assert.deepEqual(await names({ pool: "ffa" }), ["chill ffa"]);
  assert.deepEqual(await names({ map: "tundra" }), ["chill ffa"]);
  assert.deepEqual(await names({ maxPlayers: 2 }), ["Naboo night", "high only"]);
  assert.deepEqual(await names({ fitsMe: true }), ["Naboo night", "chill ffa"]);  // 1000 is outside 1400..2000
  await seeker.ask({ t: "room_join", room: (await seeker.ask({ t: "rooms", query: "naboo" }, "rooms")).rooms[0].id }, "room");
  const d = await user(mm.port, "mmtest_sd");
  d.fresh = true;
  await pause(50);
  assert.deepEqual((await d.ask({ t: "rooms", hideFull: true }, "rooms")).rooms.map((r) => r.name).sort(), ["chill ffa", "high only"]);
  assert.equal((await d.ask({ t: "rooms" }, "rooms")).rooms.length, 3);
  for (const x of [a, b, c, seeker, d]) x.close();
  await mm.stop();
});

test("host controls: kick (no rejoin), move slot and team, close a slot, hand the host on; leaving passes it on", async () => {
  const { mm } = await service();
  const h = await user(mm.port, "mmtest_kh");
  h.fresh = true;  // each answer is the one to this request, not an earlier push
  const p = await user(mm.port, "mmtest_kp");
  const q = await user(mm.port, "mmtest_kq");
  const room = (await h.ask({ t: "room_create", name: "team game", pool: "team", maxPlayers: 4 }, "room")).room;
  await p.ask({ t: "room_join", room: room.id }, "room");
  await q.ask({ t: "room_join", room: room.id }, "room");
  assert.match((await p.refused({ t: "room_kick", name: "mmtest_kq" })).message, /only the lobby's host/);
  await h.ask({ t: "room_kick", name: "mmtest_kq" }, "room", (m) => m.room.players.length === 2);
  assert.equal((await q.next("room_kicked")).by, "mmtest_kh");
  assert.equal((await q.next("room", (m) => m.room === null)).room, null);
  assert.match((await q.refused({ t: "room_join", room: room.id })).message, /removed you/);
  // slots: p moves to 4 and team 1; slot 3 closed: the capacity is 3
  let view = (await h.ask({ t: "room_move", name: "mmtest_kp", slot: 4, team: 1 }, "room")).room;
  assert.deepEqual(view.players.map((x) => [x.name, x.slot, x.team]), [["mmtest_kh", 1, 1], ["mmtest_kp", 4, 1]]);
  view = (await h.ask({ t: "room_slot", slot: 3, state: "closed" }, "room")).room;
  assert.equal(view.capacity, 3);
  assert.deepEqual(view.slots.map((s) => s.state), ["player", "open", "closed", "player"]);
  assert.match((await h.refused({ t: "room_move", name: "mmtest_kp", slot: 3 })).message, /not free/);
  assert.match((await h.refused({ t: "room_slot", slot: 4, state: "closed" })).message, /a player is in that slot/);
  // swapping with the host's slot
  view = (await h.ask({ t: "room_move", name: "mmtest_kp", slot: 1 }, "room")).room;
  assert.deepEqual(view.players.map((x) => [x.name, x.slot]).sort(), [["mmtest_kh", 4], ["mmtest_kp", 1]]);
  view = (await h.ask({ t: "room_host", name: "mmtest_kp" }, "room")).room;
  assert.equal(view.players.find((x) => x.host).name, "mmtest_kp");
  assert.match((await h.refused({ t: "room_kick", name: "mmtest_kp" })).message, /only the lobby's host/);
  // the host leaves before the start: the next player hosts
  await p.ask({ t: "room_leave" }, "room");
  view = (await h.next("room", (m) => m.room?.players.length === 1)).room;
  assert.equal(view.host, "mmtest_kh");
  assert.ok(view.messages.some((x) => x.text === "mmtest_kh is now the host."));
  for (const x of [h, p, q]) x.close();
  await mm.stop();
});

test("computer players: an AI slot with a difficulty goes into match_start's players; a loss to it is vs_ai", async () => {
  const { mm, store } = await service();
  const h = await user(mm.port, "mmtest_aih");
  h.fresh = true;  // each answer is the one to this request, not an earlier push
  const g = await user(mm.port, "mmtest_aig");
  const room = (await h.ask({ t: "room_create", name: "vs computer", pool: "team", maxPlayers: 4 }, "room")).room;
  await g.ask({ t: "room_join", room: room.id }, "room");
  await h.ask({ t: "room_move", name: "mmtest_aig", team: 1 }, "room");
  let view = (await h.ask({ t: "room_slot", slot: 3, state: "ai", difficulty: "hardest", civ: "empire", team: 2 }, "room")).room;
  assert.deepEqual(view.slots[2], { slot: 3, state: "ai", difficulty: "hardest", civ: "EMPIRE", team: 2 });
  assert.equal(view.capacity, 3);
  view = (await h.ask({ t: "room_slot", slot: 4, state: "ai", team: 2 }, "room")).room;
  assert.equal(view.slots[3].difficulty, "moderate");
  assert.equal(view.players.length, 2);  // computer players are in slots, not in players
  await g.ask({ t: "room_ready" }, "room");
  h.send({ t: "room_start" });
  const s = await h.next("match_start");
  assert.deepEqual(s.match.players.map((x) => [x.slot, x.team, x.ai ?? false, x.difficulty ?? ""]),
    [[1, 1, false, ""], [2, 1, false, ""], [3, 2, true, "hardest"], [4, 2, true, "moderate"]]);
  await g.next("match_start");
  h.send({ t: "result", match: s.match.id, winners: [3, 4] });
  g.send({ t: "result", match: s.match.id, winners: [3, 4] });
  const r = await h.next("result_recorded");
  assert.equal(r.status, "vs_ai");
  assert.equal(store.history(h.auth.player.id)[0].status, "vs_ai");
  // no computer players in a ranked lobby
  const r2 = (await h.ask({ t: "room_create", name: "ranked", ranked: true }, "room")).room;
  assert.match((await h.refused({ t: "room_slot", slot: 2, state: "ai" })).message, /ranked/);
  assert.equal(r2.locked, false);
  h.close(), g.close();
  await mm.stop();
});
