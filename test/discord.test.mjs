// Discord webhook notices, against a local HTTP server standing in for Discord (127.0.0.1 only). No real webhook.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { DiscordNotifier, escapeMarkdown, lookingPayload } from "../src/discord.mjs";
import { loadConfig } from "../src/config.mjs";
import { pause, playRanked, service, user } from "./helpers.mjs";

async function fakeDiscord(answer = () => 204) {
  const posts = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      posts.push(JSON.parse(body));
      const status = answer(posts.length);
      res.writeHead(status, { "content-type": "application/json" }).end(status === 429 ? '{"retry_after":0.01}' : "");
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { posts, url: `http://127.0.0.1:${server.address().port}/api/webhooks/test`, close: () => new Promise((r) => server.close(r)) };
}

test("discord: a ranked 1v1 waiting player and a confirmed ranked 1v1 result are posted; nothing private", async () => {
  const fake = await fakeDiscord();
  const discord = new DiscordNotifier({ config: { webhookUrl: fake.url, siteUrl: "https://stats.example.com" } });
  const { mm } = await service({ discord });
  const a = await user(mm.port, "mmtest_da");
  const b = await user(mm.port, "mmtest_db");
  const { id } = await playRanked(a, b);
  a.send({ t: "result", match: id, winners: [1] });
  b.send({ t: "result", match: id, winners: [1] });
  await a.next("result_recorded");
  await pause(20);
  await discord.idle();
  assert.equal(fake.posts.length, 3);  // two waiting players, one result
  assert.match(fake.posts[0].embeds[0].description, /mmtest\\_da/);
  const result = fake.posts[2].embeds[0];
  assert.equal(result.title, "Ranked 1v1 result");
  assert.match(result.description, /\*\*mmtest\\_da\*\* defeated \*\*mmtest\\_db\*\*/);
  assert.equal(result.url, `https://stats.example.com/matches/${id}`);
  assert.deepEqual(fake.posts[2].allowed_mentions, { parse: [] });
  assert.ok(!JSON.stringify(fake.posts).includes("127.0.0.1"));
  // an unranked game posts nothing
  const before = fake.posts.length;
  a.send({ t: "queue_join", queue: "1v1", ranked: false, groups: ["test"] });
  await a.next("queue");
  await pause(20);
  assert.equal(fake.posts.length, before);
  a.close(), b.close();
  await mm.stop();
  await fake.close();
});

test("discord: retries a 429, gives up quietly on failure, limits posts per player; a dead webhook never stops a match", async () => {
  const fake = await fakeDiscord((n) => (n === 1 ? 429 : 204));
  const n = new DiscordNotifier({ config: { webhookUrl: fake.url, perPlayerPerHour: 2 } });
  assert.equal(await n.playerLooking({ name: "mmtest_x", rating: 1000 }), true);
  assert.equal(fake.posts.length, 2);  // the retry
  assert.equal(await n.playerLooking({ name: "mmtest_x", rating: 1000 }), true);
  assert.equal(await n.playerLooking({ name: "mmtest_x", rating: 1000 }), false);  // the third in an hour
  await fake.close();
  // nothing listening at all
  const logged = [];
  const dead = new DiscordNotifier({ config: { webhookUrl: "http://127.0.0.1:1/x", timeoutMs: 500 }, log: { event: (l, e) => logged.push(e) } });
  const { mm } = await service({ discord: dead });
  const a = await user(mm.port, "mmtest_dc");
  const b = await user(mm.port, "mmtest_dd");
  const { id } = await playRanked(a, b);
  a.send({ t: "result", match: id, winners: [2] });
  b.send({ t: "result", match: id, winners: [2] });
  assert.equal((await a.next("result_recorded")).status, "completed");
  await dead.idle();
  assert.ok(logged.includes("discord_failed"));
  a.close(), b.close();
  await mm.stop();
});

test("discord: markdown and mentions are escaped; the config wants https and is off by default", () => {
  assert.equal(escapeMarkdown("@everyone *bold*"), "\\@everyone \\*bold\\*");
  assert.deepEqual(lookingPayload({ name: "a", rating: 1 }).allowed_mentions, { parse: [] });
  assert.equal(loadConfig([], {}).config.discord.webhookUrl, "");
  assert.equal(new DiscordNotifier().enabled, false);
});
