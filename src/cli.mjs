#!/usr/bin/env node
// A small client for looking at a running server:
//   node src/cli.mjs [--server 127.0.0.1:4317] [--tls [--ca FILE]] profile NAME
//   node src/cli.mjs [--server 127.0.0.1:4317] [--tls [--ca FILE]] leaderboard [solo|team|ffa]
//   node src/cli.mjs [--server 127.0.0.1:4317] [--tls [--ca FILE]] rooms | maps
// --tls speaks TLS, verifying the certificate against the system roots, or against
// --ca FILE (a test certificate); the host name is checked (for 127.0.0.1 the name "localhost" is asked for).
import net from "node:net";
import tls from "node:tls";
import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
let server = "127.0.0.1:4317", secure = false, ca;
for (;;) {
  if (args[0] === "--server") server = args.splice(0, 2)[1];
  else if (args[0] === "--tls") secure = Boolean(args.shift());
  else if (args[0] === "--ca") ca = readFileSync(args.splice(0, 2)[1]);
  else break;
}
const [command, value] = args;
const request = command === "profile" ? { t: "profile", name: value }
  : command === "leaderboard" ? { t: "leaderboard", pool: value ?? "solo" }
    : command === "rooms" ? { t: "rooms" } : command === "maps" ? { t: "maps" } : null;
if (!request) {
  console.error("usage: cli.mjs [--server HOST:PORT] [--tls [--ca FILE]] profile NAME | leaderboard [POOL] | rooms | maps");
  process.exit(2);
}
const colon = server.lastIndexOf(":");
const host = server.slice(0, colon), port = Number(server.slice(colon + 1));
const send = () => socket.write(`${JSON.stringify(request)}\n`);
const socket = secure
  ? tls.connect({ port, host, servername: /^[\d.]+$/.test(host) ? "localhost" : host, ca }, send)
  : net.connect(port, host, send);
let buffer = "";
socket.on("data", (chunk) => {
  buffer += chunk;
  const nl = buffer.indexOf("\n");
  if (nl < 0) return;
  console.log(JSON.stringify(JSON.parse(buffer.slice(0, nl)), null, 2));
  socket.end();
});
socket.on("error", (error) => {
  console.error(error.message);
  process.exit(1);
});
