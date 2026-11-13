#!/usr/bin/env node
// node src/server.mjs [--config FILE] [--host 127.0.0.1] [--port 4317] [--db data/matchmaking.db] [--min-queue-ms 15000]
//                     [--ffa-players 4] [--accept-ms 30000] [--corroboration-ms 60000] [--test-maps]
//                     [--tls-cert FILE --tls-key FILE] [--no-health] [--health-host H] [--health-port N]
// Every option is in the config file too (src/config.mjs, config.example.json; SWGB_MM_CONFIG names the file); the
// command line wins. Binds 127.0.0.1 unless told otherwise, so nothing faces the internet unless the operator asks.
import { mkdirSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Store } from "./store.mjs";
import { loadMapCatalog } from "./map-catalog.mjs";
import { Matchmaker } from "./matchmaker.mjs";
import { loadConfig } from "./config.mjs";
import { createLogger } from "./log.mjs";
import { CertWatcher } from "./tls.mjs";
import { HealthServer } from "./health.mjs";
import { grantConfigAdmins } from "./moderation.mjs";
import { AdminServer } from "./admin-web.mjs";
import { PublicWeb } from "./public-web.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { config: c, file } = loadConfig(process.argv.slice(2));
const log = createLogger({ level: c.log.level });
// relative paths: the database from the package folder, the certificate files from the working directory
const db = c.db === ":memory:" || isAbsolute(c.db) ? c.db : resolve(ROOT, c.db);
if (db !== ":memory:") mkdirSync(dirname(db), { recursive: true });
log.event("info", "starting", { config: file || null, db, host: c.host, port: c.port, tls: c.tls.enabled, health: c.health.enabled ? `${c.health.host}:${c.health.port}` : null });

const store = new Store(db, { accounts: c.accounts });
grantConfigAdmins(store, c.moderation.admins, log);
const catalog = loadMapCatalog(undefined, { includeTest: c.testMaps });
let certs = null;
if (c.tls.enabled) {
  certs = new CertWatcher({ cert: c.tls.cert, key: c.tls.key, reloadSeconds: c.tls.reloadSeconds, minVersion: c.tls.minVersion, log });
  certs.handshakeMs = c.tls.handshakeMs;
  certs.start();
}
const mm = new Matchmaker({ store, catalog, host: c.host, port: c.port, minQueueMs: c.minQueueMs, ffaPlayers: c.ffaPlayers,
  acceptMs: c.acceptMs, corroborationMs: c.corroborationMs, log, tls: certs, limits: c.limits, replays: c.replays, messages: c.messages, moderation: c.moderation });
await mm.start();
let health = null;
if (c.health.enabled) {
  try {  // a health port in use is no reason to stop the service (Docker then says "unhealthy")
    health = await new HealthServer({ host: c.health.host, port: c.health.port, status: () => mm.status() }).start();
    log.event("info", "health_listening", { host: c.health.host, port: health.port });
  } catch (error) {
    health = null;
    log.event("error", "health_failed", { host: c.health.host, port: c.health.port, error: error.code ?? error.message });
  }
}
let admin = null;
if (c.admin.enabled) {
  try {  // like the health port: a busy admin port leaves the game service running
    admin = await new AdminServer({ mm, config: c.admin, log }).start();
    log.event("info", "admin_listening", { host: c.admin.host, port: admin.port });
  } catch (error) {
    admin = null;
    log.event("error", "admin_failed", { host: c.admin.host, port: c.admin.port, error: error.code ?? error.message });
  }
}
let web = null;
if (c.web.enabled) {
  try {
    web = await new PublicWeb({ store, mm, config: c.web, log }).start();
    log.event("info", "web_listening", { host: c.web.host, port: web.port });
  } catch (error) {
    web = null;
    log.event("error", "web_failed", { host: c.web.host, port: c.web.port, error: error.code ?? error.message });
  }
}
let stopping = false;
const stop = async (signal) => {
  if (stopping) return;
  stopping = true;
  log.event("info", "stopping", { signal });
  certs?.stop();
  await health?.stop();
  await admin?.stop();
  await web?.stop();
  await mm.stop();
  store.close();
  process.exit(0);
};
process.on("SIGINT", () => stop("SIGINT"));
process.on("SIGTERM", () => stop("SIGTERM"));
