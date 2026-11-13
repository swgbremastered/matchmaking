#!/usr/bin/env node
// Test helper for the game client's TLS code: a TLS line server on 127.0.0.1 with
// a self-signed certificate for "localhost" made now (selfsigned.mjs; the key lives in a temporary folder that is
// removed at exit). Prints one line, "port N ca FILE", then answers each JSON line {"t":"echo",...} with
// {"t":"echoed","n":<bytes of the line>,"text":...}; {"t":"bye"} makes the server end the session (close_notify);
// {"t":"quit"} (or 60 s) stops it.
import tls from "node:tls";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { selfSigned } from "./selfsigned.mjs";

const dir = mkdtempSync(join(tmpdir(), "swgb-tls-echo-"));
const { cert, key } = selfSigned({ names: ["localhost"] });
writeFileSync(join(dir, "ca.pem"), cert);
const cleanup = () => rmSync(dir, { recursive: true, force: true });
const server = tls.createServer({ cert, key, minVersion: "TLSv1.2" }, (socket) => {
  let buffer = "";
  socket.on("error", () => {});
  socket.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    for (let nl; (nl = buffer.indexOf("\n")) >= 0;) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      const m = JSON.parse(line);
      if (m.t === "echo") socket.write(`${JSON.stringify({ t: "echoed", n: Buffer.byteLength(line), text: m.text })}\n`);
      else if (m.t === "bye") socket.end(`${JSON.stringify({ t: "bye" })}\n`);
      else if (m.t === "quit") {
        socket.end();
        server.close();
        cleanup();
        setTimeout(() => process.exit(0), 50);
      }
    }
  });
});
server.listen(0, "127.0.0.1", () => {
  process.stdout.write(`port ${server.address().port} ca ${join(dir, "ca.pem")}\n`);
});
setTimeout(() => {
  cleanup();
  process.exit(0);
}, 60_000).unref();
