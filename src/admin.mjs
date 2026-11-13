#!/usr/bin/env node
// Moderation from the server's own shell, straight on the database (the server may be running: SQLite's WAL lets
// both write; a running server closes a newly banned player's connection within moderation.sweepSeconds). It acts as
// the operator, above every role, and every change goes to the audit log as "operator".
//
//   node src/admin.mjs [--db FILE | --config FILE] COMMAND ...
//     role NAME player|moderator|admin       staff
//     ban NAME [--minutes N] [--address] --reason TEXT      unban NAME
//     ban-address IP [--minutes N] --reason TEXT            unban-address IP
//     mute NAME [--minutes N] [--scope chat|dm|all] --reason TEXT      unmute NAME
//     reports [open|dismissed|actioned|all]   resolve ID dismiss|actioned [--note TEXT]
//     bans    mutes    audit [N]    lookup NAME
// --minutes 0 (or none) is permanent. The database is the config's `db` (SWGB_MM_CONFIG or --config), else --db.
//   docker exec swgb-matchmaking node src/admin.mjs role alice admin
import { existsSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.mjs";
import { Store } from "./store.mjs";
import { Moderation, OPERATOR } from "./moderation.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const USAGE = "usage: node src/admin.mjs [--db FILE | --config FILE] role|staff|ban|unban|ban-address|unban-address|mute|unmute|reports|resolve|bans|mutes|audit|lookup ...";

export function run(argv, env = process.env, out = (line) => console.log(line)) {
  const args = [...argv];
  let dbFile = null, configFile = null;
  const opts = {};
  const words = [];
  while (args.length) {
    const a = args.shift();
    if (a === "--db") dbFile = args.shift();
    else if (a === "--config") configFile = args.shift();
    else if (a === "--address") opts.address = true;
    else if (["--minutes", "--reason", "--scope", "--note"].includes(a)) opts[a.slice(2)] = args.shift();
    else words.push(a);
  }
  const [command, ...rest] = words;
  if (!command) throw new Error(USAGE);
  if (!dbFile) {
    const { config } = loadConfig(configFile ? ["--config", configFile] : [], env);
    dbFile = config.db;
  }
  const db = dbFile === ":memory:" || isAbsolute(dbFile) ? dbFile : resolve(ROOT, dbFile);
  if (db !== ":memory:" && !existsSync(db)) throw new Error(`no database at ${db}`);
  const store = new Store(db);
  try {
    const mod = new Moderation({ store });
    const actor = OPERATOR;
    const name = rest[0];
    const minutes = opts.minutes === undefined ? 0 : Number(opts.minutes);
    let result;
    switch (command) {
      case "role": result = mod.setRole(actor, { name, role: rest[1] }); break;
      case "staff": result = store.mod.staff(); break;
      case "ban": result = mod.ban(actor, { name, minutes, reason: opts.reason, address: opts.address === true }); break;
      case "unban": result = mod.unban(actor, { name }); break;
      case "ban-address": result = mod.banAddress(actor, { ip: name, minutes, reason: opts.reason }); break;
      case "unban-address": result = mod.unbanAddress(actor, { ip: name }); break;
      case "mute": result = mod.mute(actor, { name, minutes, scope: opts.scope ?? "all", reason: opts.reason }); break;
      case "unmute": result = mod.unmute(actor, { name }); break;
      case "reports": result = store.mod.reports({ status: rest[0] ?? "open" }); break;
      case "resolve": result = mod.resolveReport(actor, { id: rest[0], action: rest[1], note: opts.note }); break;
      case "bans": result = store.mod.activeBans(); break;
      case "mutes": result = store.mod.activeMutes(); break;
      case "audit": result = store.mod.auditLog({ limit: Number(rest[0] ?? 50) || 50 }); break;
      case "lookup": result = mod.lookup(actor, { name }); break;
      default: throw new Error(USAGE);
    }
    out(JSON.stringify(result, null, 2));
    return result;
  } finally {
    store.close();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    run(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exit(error.message === USAGE ? 2 : 1);
  }
}
