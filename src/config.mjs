// Every option of the service, from a JSON config file (--config FILE or SWGB_MM_CONFIG), then the command line on
// top. config.example.json is the container's config (TLS on, everything listed).
// A config file may give any subset: objects merge key by key with the defaults.
import { readFileSync } from "node:fs";

export const DEFAULTS = Object.freeze({
  host: "127.0.0.1",               // the TCP + UDP address (0.0.0.0 in the container)
  port: 4317,                      // TCP control + relay, and the same number on UDP (the hole-punch rendezvous)
  db: "data/matchmaking.db",       // a relative path is taken from the package folder
  minQueueMs: 15_000,
  ffaPlayers: 4,
  acceptMs: 30_000,
  corroborationMs: 60_000,
  testMaps: false,
  tls: {
    enabled: false,                // true: the control link is TLS only (plain connections may only open a relay)
    cert: "",                      // PEM certificate chain (fullchain.pem)
    key: "",                       // PEM private key (privkey.pem)
    reloadSeconds: 60,             // how often the files are checked; a changed certificate is used by new connections
    minVersion: "TLSv1.2",
    handshakeMs: 10_000
  },
  health: {
    enabled: true,
    host: "127.0.0.1",             // the health listener (HTTP GET /health); not for the internet
    port: 4318
  },
  limits: {
    maxConnections: 2000,          // open TCP connections in all (control + relay)
    maxConnectionsPerIp: 16,       // a household behind one address: a few players, each a control link and relays
    maxLineBytes: 64 * 1024,       // one JSON message (a replay chunk is 32 KiB of base64)
    authTimeoutMs: 30_000,         // a control connection that has not logged in by then is closed
    messagesPerSecond: 40,         // per connection, a token bucket (burst = 2 s worth)
    loginPerIpPerMinute: 20,       // log-in and resume attempts per address
    registerPerIpPerHour: 10,      // new accounts per address
    loginFailuresPerAccount: 8,    // failed log-ins per account name in loginLockoutMinutes, then refused for that long
    loginLockoutMinutes: 15,
    chatPerMinute: 30,             // lobby chat, party chat and direct messages per player
    chatBurst: 8,
    udpPerIpPerSecond: 50,         // rendezvous datagrams per address
    maxRelays: 500,                // relay tokens waiting at once
    roomPasswordPerIpPerMinute: 10 // wrong-or-right lobby password tries per address
  },
  accounts: {
    maxAccounts: 50_000,           // registrations stop at this many accounts
    nameMin: 3,
    nameMax: 24,
    passwordMin: 8,
    passwordMax: 128,
    reservedNames: ["admin", "administrator", "root", "system", "server", "moderator", "mod", "support", "swgb",
      "matchmaking", "official", "staff", "null", "undefined"]
  },
  replays: {
    maxBytes: 16 * 1024 * 1024,    // the largest replay kept
    retentionDays: 30,             // replays older than this are deleted (0 = keep forever)
    sweepMinutes: 60               // how often old replays are looked for (and once at start)
  },
  messages: {
    chatMax: 200,                  // characters in a lobby / party chat line
    dmMax: 300                     // characters in a direct message
  },
  log: {
    level: "info"                  // debug | info | warn | error; JSON lines on stdout
  },
  moderation: {
    admins: [],                    // account names made admins at start (existing accounts only; see README.md)
    reportsPerHour: 5,             // player reports per reporter
    reportMax: 300,                // characters in a report's reason
    reasonMax: 300,                // characters in a ban's or a mute's reason
    moderatorMaxBanDays: 30,       // the longest ban a moderator gives (admins: any, or permanent)
    moderatorMaxMuteDays: 30,
    sweepSeconds: 15               // how often bans made by src/admin.mjs are looked for (online players are closed)
  },
  admin: {
    enabled: false,                // the admin dashboard (HTTP); see HOSTING.md before opening it to anything
    host: "127.0.0.1",
    port: 4319,
    secureCookie: "auto",          // "auto": Secure when the request came over TLS (trustProxy: X-Forwarded-Proto); true; false
    trustProxy: false,             // behind a reverse proxy on the same host: take X-Forwarded-For / -Proto from it
    sessionHours: 12,
    loginPerIpPerMinute: 10
  },
  web: {
    enabled: false,                // the public read-only pages and JSON API (leaderboards, profiles, matches, tournaments)
    host: "127.0.0.1",
    port: 4320,
    trustProxy: false,             // behind a reverse proxy: the rate limit takes the address from X-Forwarded-For
    requestsPerMinute: 60,         // per address
    cacheSeconds: 30,              // Cache-Control max-age
    replays: false                 // true: /matches/<id>/replay downloads the stored replay
  },
  discord: {
    webhookUrl: "",                // a channel webhook (https://discord.com/api/webhooks/...); empty: no posts
    queueNotices: true,            // a post when a player waits in the ranked 1v1 queue
    resultNotices: true,           // a post when a ranked 1v1 result is confirmed
    perPlayerPerHour: 6,           // posts naming one player per hour, at most
    timeoutMs: 10_000,
    siteUrl: ""                    // the public pages' address (https://stats.example.com): results link to the match
  }
});

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

export function merge(base, over) {
  if (!isObject(over)) return structuredClone(base);
  const out = structuredClone(base);
  for (const [k, v] of Object.entries(over)) {
    if (!(k in base)) throw new Error(`unknown config option ${k}`);
    out[k] = isObject(base[k]) ? merge(base[k], v) : v;
  }
  return out;
}

const flags = {
  "--host": ["host", String], "--port": ["port", Number], "--db": ["db", String],
  "--min-queue-ms": ["minQueueMs", Number], "--ffa-players": ["ffaPlayers", Number], "--accept-ms": ["acceptMs", Number],
  "--corroboration-ms": ["corroborationMs", Number], "--tls-cert": ["tls.cert", String], "--tls-key": ["tls.key", String],
  "--health-host": ["health.host", String], "--health-port": ["health.port", Number]
};
const setPath = (o, path, value) => {
  const keys = path.split(".");
  let at = o;
  for (const k of keys.slice(0, -1)) at = at[k];
  at[keys.at(-1)] = value;
};

// A --tls-* option turns TLS on.
export function loadConfig(argv, env = process.env) {
  let file = env.SWGB_MM_CONFIG || "";
  const rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--config") file = argv[++i];
    else rest.push(argv[i]);
  }
  const config = merge(DEFAULTS, file ? JSON.parse(readFileSync(file, "utf8")) : {});
  for (let i = 0; i < rest.length; i += 1) {
    const a = rest[i];
    if (a === "--test-maps") config.testMaps = true;
    else if (a === "--no-health") config.health.enabled = false;
    else if (flags[a]) {
      const [path, type] = flags[a];
      if (i + 1 >= rest.length) throw new Error(`${a} needs a value`);
      setPath(config, path, type(rest[++i]));
      if (path.startsWith("tls.")) config.tls.enabled = true;
    } else throw new Error(`unknown option ${a}`);
  }
  validate(config);
  return { config, file };
}

export function validate(c) {
  const posInt = (v, name) => {
    if (!Number.isInteger(v) || v < 0) throw new Error(`${name} must be a whole number >= 0`);
  };
  posInt(c.port, "port");
  if (c.port > 65535) throw new Error("port must be at most 65535");
  if (c.tls.enabled && (!c.tls.cert || !c.tls.key)) throw new Error("tls.enabled needs tls.cert and tls.key");
  for (const [k, v] of Object.entries(c.limits)) posInt(v, `limits.${k}`);
  for (const k of ["maxBytes", "retentionDays", "sweepMinutes"]) posInt(c.replays[k], `replays.${k}`);
  if (c.limits.maxLineBytes < 48 * 1024) throw new Error("limits.maxLineBytes must be at least 49152 (a replay chunk)");
  if (c.accounts.nameMin < 1 || c.accounts.nameMax < c.accounts.nameMin) throw new Error("accounts.nameMin / nameMax");
  if (c.accounts.passwordMin < 1 || c.accounts.passwordMax < c.accounts.passwordMin) throw new Error("accounts.passwordMin / passwordMax");
  if (!Array.isArray(c.accounts.reservedNames)) throw new Error("accounts.reservedNames must be a list");
  if (!Array.isArray(c.moderation.admins) || c.moderation.admins.some((n) => typeof n !== "string")) throw new Error("moderation.admins must be a list of names");
  for (const k of ["reportsPerHour", "reportMax", "reasonMax", "moderatorMaxBanDays", "moderatorMaxMuteDays", "sweepSeconds"]) posInt(c.moderation[k], `moderation.${k}`);
  if (c.moderation.sweepSeconds < 1) throw new Error("moderation.sweepSeconds must be at least 1");
  posInt(c.admin.port, "admin.port");
  if (!["auto", true, false].includes(c.admin.secureCookie)) throw new Error('admin.secureCookie: "auto" | true | false');
  if (!(c.admin.sessionHours > 0)) throw new Error("admin.sessionHours must be above 0");
  posInt(c.admin.loginPerIpPerMinute, "admin.loginPerIpPerMinute");
  for (const k of ["port", "requestsPerMinute", "cacheSeconds"]) posInt(c.web[k], `web.${k}`);
  if (c.discord.webhookUrl && !/^https:\/\//.test(c.discord.webhookUrl)) throw new Error("discord.webhookUrl must be an https:// address");
  for (const k of ["perPlayerPerHour", "timeoutMs"]) posInt(c.discord[k], `discord.${k}`);
  if (!["debug", "info", "warn", "error"].includes(c.log.level)) throw new Error("log.level: debug | info | warn | error");
}
