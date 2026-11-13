// Shared by the newer tests: a line client over a real socket on 127.0.0.1, and a service on a free port.
// Test accounts: mmtest_* with test-only passwords.
import net from "node:net";
import { Store } from "../src/store.mjs";
import { loadMapCatalog } from "../src/map-catalog.mjs";
import { Matchmaker } from "../src/matchmaker.mjs";

export class Client {
  constructor(port) {
    this.port = port;
    this.inbox = [];
    this.waiters = [];
  }
  open() {
    return new Promise((resolve, reject) => {
      this.socket = net.connect(this.port, "127.0.0.1", resolve);
      this.socket.on("error", reject);
      this.closed = new Promise((done) => this.socket.once("close", done));
      let buffer = "";
      this.socket.on("data", (chunk) => {
        buffer += chunk;
        for (let nl; (nl = buffer.indexOf("\n")) >= 0;) {
          const m = JSON.parse(buffer.slice(0, nl));
          buffer = buffer.slice(nl + 1);
          this.inbox.push(m);
          this.waiters = this.waiters.filter((w) => !w(m));
        }
      });
    });
  }
  send(m) {
    this.socket.write(`${JSON.stringify(m)}\n`);
  }
  // the next message of that type (or an error), optionally one that passes `when`
  next(type, when = () => true, timeout = 3000) {
    const ok = (m) => (m.t === type && when(m)) || m.t === "error";
    const i = this.inbox.findIndex(ok);
    if (i >= 0) return Promise.resolve(this.inbox.splice(i, 1)[0]);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no ${type}; inbox ${this.inbox.map((m) => m.t).join(",")}`)), timeout);
      this.waiters.push((m) => {
        if (!ok(m)) return false;
        clearTimeout(timer);
        this.inbox.splice(this.inbox.indexOf(m), 1);
        resolve(m);
        return true;
      });
    });
  }
  async ask(m, type, when) {
    this.send(m);
    const r = await this.next(type, when);
    if (r.t === "error") throw Object.assign(new Error(r.message), { reply: r });
    return r;
  }
  // the error answer to a request that should be refused
  async refused(m) {
    this.send(m);
    const r = await this.next("error");
    if (r.t !== "error") throw new Error(`expected a refusal of ${m.t}, got ${r.t}`);
    return r;
  }
  close() {
    this.socket.destroy();
  }
}

export const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// A clock the test moves: clock.now(), clock.advance(ms)
export function testClock(start = Date.now()) {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

export async function service(options = {}, storeFile = ":memory:") {
  const store = options.store ?? new Store(storeFile);
  const mm = new Matchmaker({ store, catalog: loadMapCatalog(undefined, { includeTest: true }), port: 0, minQueueMs: 0,
    log: () => {}, ...options });
  await mm.start();
  return { mm, store };
}

export async function user(port, name, password = "test-only-pw") {
  const c = new Client(port);
  await c.open();
  c.auth = await c.ask({ t: "register", name, password }, "auth");
  return c;
}

export async function login(port, name, password = "test-only-pw") {
  const c = new Client(port);
  await c.open();
  c.send({ t: "login", name, password });
  c.auth = await c.next("auth");
  return c;
}

// Two players through a ranked 1v1 to a started match; returns the match_start messages.
export async function playRanked(a, b, extra = {}) {
  a.send({ t: "queue_join", queue: "1v1", groups: ["test"], maps: ["test-arena"], ...extra });
  b.send({ t: "queue_join", queue: "1v1", groups: ["test"], maps: ["test-arena"], ...extra });
  const fa = await a.next("match_found");
  await b.next("match_found");
  a.send({ t: "accept", match: fa.match.id });
  b.send({ t: "accept", match: fa.match.id });
  const sa = await a.next("match_start");
  const sb = await b.next("match_start");
  return { id: fa.match.id, sa, sb };
}
