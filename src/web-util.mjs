// Small pieces the HTTP listeners share (the admin dashboard, the public pages): HTML escaping, a page frame, form
// bodies, cookies, the client's address.

export const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

export const when = (ms) => (ms ? new Date(ms).toISOString().slice(0, 16).replace("T", " ") : "");

// No scripts at all; inline styles only; forms post back to the same origin.
export const SECURITY_HEADERS = Object.freeze({
  "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer"
});

const STYLE = `:root{color-scheme:light dark;--bg:#f6f5f2;--fg:#1d1c1a;--muted:#6b665e;--line:#d8d3ca;--panel:#fff;--accent:#8a5a1c;--bad:#a33}
@media (prefers-color-scheme:dark){:root{--bg:#161513;--fg:#e2dbcf;--muted:#a59d90;--line:#3a352f;--panel:#201e1b;--accent:#d7a45c;--bad:#e27b7b}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.45 system-ui,sans-serif}
header{display:flex;flex-wrap:wrap;gap:12px;align-items:center;justify-content:space-between;padding:12px 16px;border-bottom:1px solid var(--line)}
header a{color:var(--fg);margin-right:12px;text-decoration:none}header a:hover{text-decoration:underline}h1{font-size:18px;margin:0}
main{max-width:1100px;margin:0 auto;padding:16px}section{background:var(--panel);border:1px solid var(--line);border-radius:6px;padding:12px 14px;margin-bottom:16px;overflow-x:auto}
h2{font-size:15px;margin:0 0 8px}table{border-collapse:collapse;width:100%}th,td{text-align:left;padding:6px 8px;border-top:1px solid var(--line);vertical-align:top}
th{color:var(--muted);font-weight:600;font-size:12px}.muted{color:var(--muted)}.bad{color:var(--bad)}.stats{display:flex;flex-wrap:wrap;gap:16px}.stats b{font-size:22px;display:block}
form.inline{display:inline-flex;flex-wrap:wrap;gap:4px;margin:2px 0}input,select,textarea,button{font:inherit;padding:4px 6px;border:1px solid var(--line);border-radius:4px;background:var(--bg);color:var(--fg)}
button{cursor:pointer;background:var(--accent);color:#fff;border-color:var(--accent)}a{color:var(--accent)}.login{max-width:340px;margin:12vh auto}.login form{display:grid;gap:8px}`;

export function page(title, body, { nav = "" } = {}) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><style>${STYLE}</style></head><body>${nav}<main>${body}</main></body></html>`;
}

export function readForm(req, max = 16 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const parts = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > max) {
        reject(Object.assign(new Error("too large"), { status: 413 }));
        req.destroy();
        return;
      }
      parts.push(chunk);
    });
    req.on("end", () => resolve(Object.fromEntries(new URLSearchParams(Buffer.concat(parts).toString("utf8")))));
    req.on("error", reject);
  });
}

export function cookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

// The client's address: the socket's, or with trustProxy the last X-Forwarded-For entry (the one the proxy added).
export function clientIp(req, trustProxy = false) {
  const forwarded = trustProxy ? String(req.headers["x-forwarded-for"] ?? "").split(",").map((s) => s.trim()).filter(Boolean).at(-1) : "";
  return (forwarded || String(req.socket.remoteAddress ?? "")).replace(/^::ffff:/, "");
}

export function isHttps(req, trustProxy = false) {
  return Boolean(req.socket.encrypted) || (trustProxy && String(req.headers["x-forwarded-proto"] ?? "").split(",")[0].trim() === "https");
}

export function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve(server.address().port));
  });
}
