#!/usr/bin/env node
// A consistent copy of the database while the service runs (SQLite VACUUM INTO: one transaction, so the
// copy is whole even with the WAL in use; it is also compacted). The copy holds the accounts' password hashes and the
// session-token hashes: keep it as private as the database.
//   node src/backup.mjs [DB] OUT_FILE        DB default /data/matchmaking.db (the container's)
//   docker exec swgb-matchmaking node src/backup.mjs /data/backups/matchmaking-$(date +%F).db
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { dirname } from "node:path";

const args = process.argv.slice(2);
if (!args.length || args.length > 2) {
  console.error("usage: node src/backup.mjs [DB] OUT_FILE");
  process.exit(2);
}
const [db, out] = args.length === 2 ? args : ["/data/matchmaking.db", args[0]];
if (!existsSync(db)) {
  console.error(`no database at ${db}`);
  process.exit(1);
}
if (existsSync(out)) {
  console.error(`${out} exists; pick another name`);
  process.exit(1);
}
mkdirSync(dirname(out), { recursive: true });
const source = new DatabaseSync(db, { readOnly: true });
source.prepare("VACUUM INTO ?").run(out);
source.close();
const check = new DatabaseSync(out, { readOnly: true });
const ok = check.prepare("PRAGMA integrity_check").get();
const players = check.prepare("SELECT COUNT(*) AS n FROM players").get().n;
check.close();
console.log(JSON.stringify({ ts: new Date().toISOString(), event: "backup", out, bytes: statSync(out).size, players,
  integrity: Object.values(ok)[0] }));
