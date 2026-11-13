// The TLS certificate of the control link. The PEM certificate (chain) and key are read from the files
// the config names and checked again every reloadSeconds (by size and modification time, which works on bind mounts
// where file events do not arrive); a changed pair becomes the secure context of every new connection, so a renewed
// Let's Encrypt certificate needs no restart. A pair that does not load (a half-written renewal) keeps the old one
// and is tried again at the next check.
import { readFileSync, statSync } from "node:fs";
import { X509Certificate, createPrivateKey } from "node:crypto";
import tls from "node:tls";

export class CertWatcher {
  constructor({ cert, key, reloadSeconds = 60, minVersion = "TLSv1.2", log = () => {} }) {
    this.certFile = cert;
    this.keyFile = key;
    this.reloadSeconds = reloadSeconds;
    this.minVersion = minVersion;
    this.log = log;
    this.context = null;
    this.stamp = "";
    this.info = null;  // { subject, issuer, validTo, fingerprint256, loadedAt }
    this.timer = null;
  }

  stampOf() {
    const a = statSync(this.certFile), b = statSync(this.keyFile);
    return `${a.size}:${a.mtimeMs}|${b.size}:${b.mtimeMs}`;
  }

  // Loads the pair; throws on the first load, logs (and keeps the old pair) on a later one.
  load() {
    const stamp = this.stampOf();
    const cert = readFileSync(this.certFile), key = readFileSync(this.keyFile);
    createPrivateKey(key);  // a key that does not parse is refused before it replaces anything
    const context = tls.createSecureContext({ cert, key, minVersion: this.minVersion });
    const x = new X509Certificate(cert);
    if (!x.checkPrivateKey(createPrivateKey(key))) throw new Error("the TLS key does not belong to the certificate");
    this.context = context;
    this.stamp = stamp;
    this.info = { subject: x.subject, issuer: x.issuer, validTo: new Date(x.validTo).toISOString(), fingerprint256: x.fingerprint256,
      loadedAt: new Date().toISOString() };
    this.log.event?.("info", "tls_loaded", { subject: x.subject.replace(/\n/g, ", "), validTo: this.info.validTo,
      fingerprint256: x.fingerprint256 });
    return this;
  }

  // Loads again when the files changed. Returns true when a new pair is in use.
  check() {
    let stamp;
    try {
      stamp = this.stampOf();
    } catch (error) {
      this.log.event?.("warn", "tls_reload_failed", { error: error.message });
      return false;
    }
    if (stamp === this.stamp) return false;
    try {
      this.load();
      return true;
    } catch (error) {
      this.log.event?.("warn", "tls_reload_failed", { error: error.message });
      return false;
    }
  }

  start() {
    this.load();
    if (this.reloadSeconds > 0) {
      this.timer = setInterval(() => this.check(), this.reloadSeconds * 1000);
      this.timer.unref();
    }
    return this;
  }

  stop() {
    clearInterval(this.timer);
  }
}
