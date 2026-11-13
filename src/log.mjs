// Structured logs, one JSON object per line on stdout (Docker keeps them: `docker logs`):
//   {"ts":"2026-11-12T20:00:00.000Z","level":"info","event":"login","player":"bob","ip":"203.0.113.9"}
// A log call is log(text) (free-form messages: {"event":"message","msg":text}) or
// log.event(level, event, fields). Fields whose name says password / token / secret / key are never written, and
// message text is cut at 500 characters.
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const SECRET = /pass(word)?|token|secret|^key$|private/i;

function clean(fields) {
  const out = {};
  for (const [k, v] of Object.entries(fields ?? {})) {
    if (SECRET.test(k) || v === undefined) continue;
    out[k] = typeof v === "string" && v.length > 500 ? `${v.slice(0, 500)}...` : v;
  }
  return out;
}

export function createLogger({ level = "info", write = (line) => process.stdout.write(line), now = () => new Date() } = {}) {
  const min = LEVELS[level] ?? LEVELS.info;
  const event = (lvl, name, fields = {}) => {
    if ((LEVELS[lvl] ?? LEVELS.info) < min) return;
    write(`${JSON.stringify({ ts: now().toISOString(), level: lvl, event: name, ...clean(fields) })}\n`);
  };
  const log = (text, fields) => event("info", "message", { msg: String(text).replace(/^\[matchmaking\] /, ""), ...fields });
  log.event = event;
  return log;
}

// A logger that drops everything (tests); log.event too.
export function quietLogger() {
  const log = () => {};
  log.event = () => {};
  return log;
}

// Wraps a plain function logger (console.log or () => {}) so log.event exists.
export function asLogger(fn) {
  if (typeof fn.event === "function") return fn;
  const log = (text, fields) => fn(text, fields);
  log.event = (lvl, name, fields = {}) => fn(`[matchmaking] ${name} ${JSON.stringify(clean(fields))}`);
  return log;
}
