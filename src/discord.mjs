// Optional Discord notices through a channel webhook (config `discord.webhookUrl`, empty = off), after Empire League's
// discord-notifier.mjs (MIT, see LICENSE.empire-league), which posts with a bot token instead: a post when a player
// waits in the ranked 1v1 queue and when a ranked 1v1 result is confirmed. Only names, ratings, the map and the match
// id; never an address or anything from a report. Posts go one at a time in the background and a failure is only
// logged: a match never waits for Discord.

const MAX_ATTEMPTS = 3;

export const DISCORD_DEFAULTS = Object.freeze({
  webhookUrl: "", queueNotices: true, resultNotices: true, perPlayerPerHour: 6, timeoutMs: 10_000, siteUrl: ""
});

export function escapeMarkdown(value) {
  return String(value ?? "").replace(/([\\`*_{}[\]()<>#+\-.!|~@:])/g, "\\$1").slice(0, 100);
}

export function lookingPayload({ name, rating, queue = "Ranked 1v1" }, at = new Date()) {
  return {
    allowed_mentions: { parse: [] },
    embeds: [{
      title: "Looking for a ranked 1v1",
      description: `**${escapeMarkdown(name)}** is waiting in the queue.`,
      color: 0xc58d45,
      fields: [{ name: "Rating", value: String(rating), inline: true }, { name: "Queue", value: escapeMarkdown(queue), inline: true }],
      timestamp: at.toISOString()
    }]
  };
}

export function resultPayload({ id, map, winner, loser }, siteUrl = "", at = new Date()) {
  const line = (p) => `${p.after} (${p.change >= 0 ? "+" : ""}${p.change})`;
  return {
    allowed_mentions: { parse: [] },
    embeds: [{
      title: "Ranked 1v1 result",
      description: `**${escapeMarkdown(winner.name)}** defeated **${escapeMarkdown(loser.name)}**.`,
      color: 0x4f9f69,
      fields: [
        { name: "Winner", value: line(winner), inline: true },
        { name: "Runner-up", value: line(loser), inline: true },
        { name: "Map", value: escapeMarkdown(map ?? "unknown"), inline: true }
      ],
      ...(siteUrl ? { url: `${siteUrl.replace(/\/+$/, "")}/matches/${encodeURIComponent(id)}` } : {}),
      footer: { text: `Match ${String(id).slice(0, 64)}` },
      timestamp: at.toISOString()
    }]
  };
}

export class DiscordNotifier {
  constructor({ config = {}, fetchImpl = globalThis.fetch, log = null, now = () => Date.now(), wait = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
    this.config = { ...DISCORD_DEFAULTS, ...config };
    this.fetch = fetchImpl;
    this.log = log;
    this.now = now;
    this.wait = wait;
    this.enabled = Boolean(this.config.webhookUrl);
    this.pending = Promise.resolve();
    this.recent = new Map();  // player name -> [post times]
  }

  // A player's posts per hour (a player queueing and leaving over and over must not flood the channel).
  allow(names) {
    const t = this.now();
    const lists = names.map((n) => (this.recent.get(n) ?? []).filter((x) => t - x < 3_600_000));
    if (lists.some((l) => l.length >= this.config.perPlayerPerHour)) return false;
    names.forEach((n, i) => this.recent.set(n, [...lists[i], t]));
    return true;
  }

  async post(payload) {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
      try {
        const res = await this.fetch(this.config.webhookUrl, {
          method: "POST", headers: { "content-type": "application/json", "user-agent": "swgb-matchmaking" },
          body: JSON.stringify(payload), signal: controller.signal
        });
        if (res.ok) return true;
        if (attempt < MAX_ATTEMPTS && (res.status === 429 || res.status >= 500)) {
          const retry = res.status === 429 ? await res.json().catch(() => ({})) : {};
          await this.wait(Math.min(10_000, Math.max(250, Number(retry.retry_after ?? attempt) * 1000)));
          continue;
        }
        throw new Error(`Discord answered ${res.status}`);
      } finally {
        clearTimeout(timer);
      }
    }
    return false;
  }

  enqueue(payload, names) {
    if (!this.enabled || !this.allow(names)) return Promise.resolve(false);
    const job = this.pending.then(() => this.post(payload));
    this.pending = job.catch((error) => this.log?.event("warn", "discord_failed", { error: error.name === "AbortError" ? "timeout" : error.message }));
    return job.catch(() => false);
  }

  playerLooking({ name, rating }) {
    if (!this.config.queueNotices) return Promise.resolve(false);
    return this.enqueue(lookingPayload({ name, rating }, new Date(this.now())), [name]);
  }

  matchCompleted(result) {
    if (!this.config.resultNotices) return Promise.resolve(false);
    return this.enqueue(resultPayload(result, this.config.siteUrl, new Date(this.now())), [result.winner.name, result.loser.name]);
  }

  // waits for every post queued so far (tests, shutdown)
  idle() {
    return this.pending;
  }
}
