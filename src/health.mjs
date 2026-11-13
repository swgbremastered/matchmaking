// The health check, a tiny HTTP listener on its own port (127.0.0.1:4318 by default: inside the
// container, for Docker's HEALTHCHECK; never forwarded to the internet). GET /health answers the service's status as
// JSON: 200 when it is fine, 503 when not (the database does not answer, the listeners are down, or the TLS
// certificate has expired). Anything else is 404.
import http from "node:http";

export class HealthServer {
  constructor({ host = "127.0.0.1", port = 4318, status }) {
    this.host = host;
    this.port = port;
    this.status = status;  // () => { ok, ... }
  }

  async start() {
    this.server = http.createServer((req, res) => {
      if (req.method !== "GET" || (req.url !== "/health" && req.url !== "/healthz")) {
        res.writeHead(404, { "content-type": "application/json" }).end('{"error":"not found"}\n');
        return;
      }
      let body;
      try {
        body = this.status();
      } catch (error) {
        body = { ok: false, error: error.message };
      }
      res.writeHead(body.ok ? 200 : 503, { "content-type": "application/json", "cache-control": "no-store" })
        .end(`${JSON.stringify(body)}\n`);
    });
    this.server.headersTimeout = 5000;
    this.server.requestTimeout = 5000;
    await new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.port, this.host, resolve);
    });
    this.port = this.server.address().port;
    return this;
  }

  async stop() {
    if (this.server) await new Promise((resolve) => this.server.close(resolve));
  }
}
