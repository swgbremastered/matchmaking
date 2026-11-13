// The public, read-only web pages and JSON API (config `web`, off by default), like Empire League's /leaderboard,
// /players/lookup and /matches/history routes (MIT, see LICENSE.empire-league):
//   /leaderboard/<solo|team|ffa>   /players/<name>   /matches/<id>   /matches/<id>/replay (with web.replays)
//   /tournaments   /tournaments/<id>
// Each as minimal HTML, and as JSON under /api (/api/leaderboard/solo, ...). Only what the game already shows any
// logged-in player: names, ratings, results, maps. Never an address, an account id, a session, a report or a
// moderation record. Rate-limited per address, with cache headers.
import http from "node:http";
import { WindowLimiter } from "./limits.mjs";
import { POOLS } from "./rating-pool.mjs";
import { SECURITY_HEADERS, clientIp, esc, listen, page, when } from "./web-util.mjs";

export const WEB_DEFAULTS = Object.freeze({
  enabled: false, host: "127.0.0.1", port: 4320, trustProxy: false, requestsPerMinute: 60, cacheSeconds: 30, replays: false
});

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export class PublicWeb {
  constructor({ store, mm = null, config = {}, now = () => Date.now(), log = null }) {
    this.store = store;
    this.mm = mm;
    this.config = { ...WEB_DEFAULTS, ...config };
    this.log = log;
    this.limit = new WindowLimiter({ limit: this.config.requestsPerMinute, windowMs: 60_000, now });
    this.sweepTimer = null;
  }

  async start() {
    this.server = http.createServer((req, res) => this.serve(req, res));
    this.server.headersTimeout = 10_000;
    this.server.requestTimeout = 15_000;
    this.port = await listen(this.server, this.config.port, this.config.host);
    this.sweepTimer = setInterval(() => this.limit.sweep(), 60_000);
    this.sweepTimer.unref();
    return this;
  }

  async stop() {
    clearInterval(this.sweepTimer);
    if (this.server) await new Promise((resolve) => this.server.close(resolve));
  }

  serve(req, res) {
    const json = req.url.startsWith("/api/") || req.url === "/api";
    const send = (status, body, headers = {}) => {
      const type = json ? "application/json" : "text/html; charset=utf-8";
      const text = json ? `${JSON.stringify(body)}\n` : body;
      res.writeHead(status, { ...SECURITY_HEADERS, "content-type": type, ...(json ? { "access-control-allow-origin": "*" } : {}), ...headers });
      res.end(req.method === "HEAD" ? undefined : text);
    };
    try {
      if (req.method !== "GET" && req.method !== "HEAD") throw new HttpError(405, "only GET");
      if (!this.limit.take(clientIp(req, this.config.trustProxy))) {
        return send(429, json ? { error: "too many requests" } : page("Slow down", "<p>Too many requests; wait a minute.</p>"), { "retry-after": "60", "cache-control": "no-store" });
      }
      const url = new URL(req.url, "http://web.invalid");
      const parts = url.pathname.replace(/^\/api(?=\/|$)/, "").split("/").filter(Boolean).map((p) => decodeURIComponent(p));
      const result = this.route(parts, url, json);
      if (result.raw) {  // a replay
        res.writeHead(200, { ...SECURITY_HEADERS, "content-type": "application/octet-stream", "content-length": result.raw.length,
          "content-disposition": `attachment; filename="${result.filename}"`, "cache-control": `public, max-age=${this.config.cacheSeconds}` });
        return res.end(req.method === "HEAD" ? undefined : result.raw);
      }
      return send(200, json ? result.data : page(result.title, `${this.nav()}${result.html}`), { "cache-control": `public, max-age=${this.config.cacheSeconds}` });
    } catch (error) {
      const status = error.status ?? 500;
      if (status === 500) this.log?.event("error", "web_error", { error: error.message });
      const message = status === 500 ? "something went wrong" : error.message;
      return send(status, json ? { error: message } : page("Not found", `${this.nav()}<p>${esc(message)}</p>`), { "cache-control": "no-store" });
    }
  }

  nav() {
    return `<p><a href="/leaderboard/solo">1v1</a> | <a href="/leaderboard/team">Team</a> | <a href="/leaderboard/ffa">FFA</a> | <a href="/tournaments">Tournaments</a></p>`;
  }

  route(parts, url, json) {
    const [head, id, tail] = parts;
    if (!head) return this.index();
    if (head === "leaderboard") return this.leaderboard(id ?? "solo", Number(url.searchParams.get("limit") ?? 50));
    if (head === "players" && id && !tail) return this.player(id);
    if (head === "matches" && id && !tail) return this.match(id);
    if (head === "matches" && id && tail === "replay" && !json) return this.replay(id);
    if (head === "tournaments" && this.mm?.tournaments) return id ? this.tournament(id) : this.tournamentList();
    throw new HttpError(404, "not found");
  }

  index() {
    return { title: "SWGB matchmaking", data: { leaderboards: POOLS.map((p) => `/api/leaderboard/${p}`), players: "/api/players/<name>",
      matches: "/api/matches/<id>", tournaments: "/api/tournaments" },
    html: "<h1>SWGB matchmaking</h1><p>Leaderboards, player profiles, match results and tournaments.</p>" };
  }

  leaderboard(pool, limit) {
    if (!POOLS.includes(pool)) throw new HttpError(404, "no such leaderboard");
    const rows = this.store.leaderboard(pool, Math.min(100, Math.max(1, limit || 50)));
    return {
      title: `Leaderboard: ${pool}`, data: { pool, rows },
      html: `<h1>Leaderboard: ${esc(pool)}</h1><table><tr><th>#</th><th>Player</th><th>Rating</th><th>Division</th><th>W</th><th>L</th><th>Streak</th></tr>
${rows.map((r) => `<tr><td>${r.rank}</td><td><a href="/players/${encodeURIComponent(r.name)}">${esc(r.name)}</a></td><td>${r.rating}</td><td>${esc(r.division)}</td><td>${r.wins}</td><td>${r.losses}</td><td>${r.streak}</td></tr>`).join("")}</table>`
    };
  }

  player(name) {
    const found = this.store.playerByName(name);
    if (!found) throw new HttpError(404, "no such player");
    const ratings = found.ratings;
    const recent = this.store.history(found.id, 20).map((m) => this.publicMatch(m));
    const data = { name: found.name, ratings, recent };
    return {
      title: found.name, data,
      html: `<h1>${esc(found.name)}</h1><table><tr><th>Pool</th><th>Rating</th><th>Peak</th><th>Division</th><th>Rank</th><th>W</th><th>L</th></tr>
${Object.entries(ratings).map(([pool, r]) => `<tr><td>${esc(pool)}</td><td>${r.rating}</td><td>${r.peak}</td><td>${esc(r.division)}</td><td>${r.rank}</td><td>${r.wins}</td><td>${r.losses}</td></tr>`).join("")}</table>
<h2>Recent matches</h2>${this.matchTable(recent)}`
    };
  }

  // the fields a match shows the public
  publicMatch(m) {
    return { id: m.id, kind: m.kind, queue: m.queue, pool: m.pool, map: m.map, ranked: m.ranked, week: m.week ?? null, status: m.status,
      createdAt: m.createdAt, completedAt: m.completedAt, replay: Boolean(m.replay && this.config.replays),
      players: m.players.map((p) => ({ name: p.name, slot: p.slot, team: p.team, outcome: p.outcome ?? null, ratingBefore: p.ratingBefore ?? null,
        ratingAfter: p.ratingAfter ?? null })) };
  }

  matchTable(list) {
    if (!list.length) return "<p>No matches yet.</p>";
    return `<table><tr><th>Finished</th><th>Match</th><th>Kind</th><th>Map</th><th>Result</th></tr>${list.map((m) => `<tr><td>${when(m.completedAt)}</td>
<td><a href="/matches/${encodeURIComponent(m.id)}">${esc(m.id)}</a></td><td>${esc(m.kind)}</td><td>${esc(m.map ?? "")}</td>
<td>${m.players.map((p) => `${esc(p.name)} ${p.outcome === "win" ? "(won)" : ""}`).join(", ")}</td></tr>`).join("")}</table>`;
  }

  match(id) {
    const m = this.store.matchDetail(id);
    if (!m) throw new HttpError(404, "no such match");
    const data = this.publicMatch(m);
    if (data.replay) data.replayUrl = `/matches/${encodeURIComponent(m.id)}/replay`;
    return {
      title: `Match ${m.id}`, data,
      html: `<h1>Match ${esc(m.id)}</h1><p>${esc(m.kind)} ${esc(m.queue ?? "")} on ${esc(m.map ?? "")}: ${esc(m.status)}${m.completedAt ? `, ${when(m.completedAt)} UTC` : ""}</p>
<table><tr><th>Slot</th><th>Team</th><th>Player</th><th>Result</th><th>Rating</th></tr>${data.players.map((p) => `<tr><td>${p.slot}</td><td>${p.team}</td>
<td><a href="/players/${encodeURIComponent(p.name)}">${esc(p.name)}</a></td><td>${esc(p.outcome ?? "")}</td><td>${p.ratingBefore ?? ""}${p.ratingAfter !== null && p.ratingAfter !== p.ratingBefore ? ` -> ${p.ratingAfter}` : ""}</td></tr>`).join("")}</table>
${data.replay ? `<p><a href="${esc(data.replayUrl)}">Download the replay</a> (${m.replaySize} bytes)</p>` : ""}`
    };
  }

  replay(id) {
    if (!this.config.replays) throw new HttpError(404, "replays are not public here");
    const r = this.store.replay(id);
    if (!r) throw new HttpError(404, "no replay for that match");
    return { raw: r.data, filename: `${String(id).replace(/[^A-Za-z0-9_.-]/g, "_")}.mgx` };
  }

  tournamentList() {
    const list = this.mm.tournaments.list();
    return {
      title: "Tournaments", data: { tournaments: list },
      html: `<h1>Tournaments</h1>${list.length ? `<table><tr><th>Name</th><th>Status</th><th>Players</th><th>Starts</th></tr>${list.map((t) => `<tr>
<td><a href="/tournaments/${encodeURIComponent(t.id)}">${esc(t.name)}</a></td><td>${esc(t.status)}</td><td>${t.players} / ${t.maxPlayers}</td><td>${when(t.registrationEndsAt)}</td></tr>`).join("")}</table>` : "<p>None yet.</p>"}`
    };
  }

  tournament(id) {
    const t = this.mm.tournaments.view(id);
    if (!t) throw new HttpError(404, "no such tournament");
    const rounds = [];
    for (const m of t.bracket) (rounds[m.round - 1] ??= []).push(m);
    return {
      title: t.name, data: t,
      html: `<h1>${esc(t.name)}</h1><p>${esc(t.status)}${t.winner ? `: won by <b>${esc(t.winner)}</b>` : ""}. ${t.players.length} / ${t.maxPlayers} players${t.maxRating ? `, rating at most ${t.maxRating}` : ""}${t.locked ? ", password" : ""}.</p>
${rounds.map((list, i) => `<h2>Round ${i + 1}${list[0]?.map ? ` <span class="muted">${esc(list[0].map)}</span>` : ""}</h2><table><tr><th>#</th><th>Player 1</th><th>Player 2</th><th>Winner</th><th>Status</th></tr>
${list.map((m) => `<tr><td>${m.position}</td><td>${esc(m.player1 ?? "-")}</td><td>${esc(m.player2 ?? "-")}</td><td>${esc(m.winner ?? "")}</td><td>${esc(m.status)}${m.match ? ` <a href="/matches/${encodeURIComponent(m.match)}">match</a>` : ""}</td></tr>`).join("")}</table>`).join("")}
<h2>Players</h2><table><tr><th>Seed</th><th>Player</th><th>Rating</th></tr>${t.players.map((p) => `<tr><td>${p.seed ?? ""}</td><td>${esc(p.name)}</td><td>${p.rating}</td></tr>`).join("")}</table>`
    };
  }
}
