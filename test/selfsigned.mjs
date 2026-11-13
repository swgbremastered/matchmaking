#!/usr/bin/env node
// Test helper: a self-signed TLS certificate made at test time (an ECDSA P-256 key and an X.509 v3
// certificate written as DER by hand, signed with node:crypto), so no private key is ever committed and the tests need
// neither openssl nor npm packages. The certificate is its own CA (basicConstraints CA:TRUE) and names its hosts in the
// subjectAltName (DNS names; IPv4 addresses with "ip:" in front).
//
//   import { selfSigned } from "./selfsigned.mjs";  selfSigned({ names: ["localhost"] }) -> { cert, key } (PEM)
//   node test/selfsigned.mjs OUT_DIR [NAME ...]      writes OUT_DIR/cert.pem and OUT_DIR/key.pem
import { generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const len = (n) => (n < 0x80 ? Buffer.from([n]) : n < 0x100 ? Buffer.from([0x81, n]) : Buffer.from([0x82, n >> 8, n & 0xff]));
const tlv = (tag, ...parts) => {
  const body = Buffer.concat(parts);
  return Buffer.concat([Buffer.from([tag]), len(body.length), body]);
};
const seq = (...parts) => tlv(0x30, ...parts);
const set = (...parts) => tlv(0x31, ...parts);
const oid = (text) => {
  const n = text.split(".").map(Number);
  const out = [40 * n[0] + n[1]];
  for (const v of n.slice(2)) {
    const bytes = [v & 0x7f];
    for (let x = v >>> 7; x; x >>>= 7) bytes.unshift(0x80 | (x & 0x7f));
    out.push(...bytes);
  }
  return tlv(0x06, Buffer.from(out));
};
const utf8 = (s) => tlv(0x0c, Buffer.from(s, "utf8"));
const time = (d) => {  // UTCTime YYMMDDHHMMSSZ (years 1950..2049)
  const p = (v) => String(v).padStart(2, "0");
  return tlv(0x17, Buffer.from(`${p(d.getUTCFullYear() % 100)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`));
};
const ECDSA_SHA256 = seq(oid("1.2.840.10045.4.3.2"));

export function selfSigned({ names = ["localhost"], cn = names[0] ?? "localhost", days = 2, notBefore = new Date(Date.now() - 3_600_000) } = {}) {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const serial = randomBytes(12);
  serial[0] &= 0x7f;  // positive
  const name = seq(set(seq(oid("2.5.4.3"), utf8(cn))));
  const san = seq(...names.map((n) => (n.startsWith("ip:") ? tlv(0x87, Buffer.from(n.slice(3).split(".").map(Number))) : tlv(0x82, Buffer.from(n, "ascii")))));
  const extensions = tlv(0xa3, seq(
    seq(oid("2.5.29.19"), tlv(0x01, Buffer.from([0xff])), tlv(0x04, seq(tlv(0x01, Buffer.from([0xff]))))),  // CA:TRUE, critical
    seq(oid("2.5.29.15"), tlv(0x01, Buffer.from([0xff])), tlv(0x04, tlv(0x03, Buffer.from([0x01, 0x86])))),  // digitalSignature, keyCertSign, cRLSign
    seq(oid("2.5.29.37"), tlv(0x04, seq(oid("1.3.6.1.5.5.7.3.1")))),  // extKeyUsage serverAuth
    seq(oid("2.5.29.17"), tlv(0x04, san))));
  const tbs = seq(
    tlv(0xa0, tlv(0x02, Buffer.from([2]))),  // v3
    tlv(0x02, serial), ECDSA_SHA256, name,
    seq(time(notBefore), time(new Date(notBefore.getTime() + days * 86_400_000))),
    name, publicKey.export({ type: "spki", format: "der" }), extensions);
  const signature = sign("sha256", tbs, privateKey);  // DER ECDSA-Sig-Value
  const der = seq(tbs, ECDSA_SHA256, tlv(0x03, Buffer.from([0]), signature));
  const pem = (label, body) => `-----BEGIN ${label}-----\n${body.toString("base64").match(/.{1,64}/g).join("\n")}\n-----END ${label}-----\n`;
  return { cert: pem("CERTIFICATE", der), key: privateKey.export({ type: "pkcs8", format: "pem" }), der };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [dir, ...names] = process.argv.slice(2);
  if (!dir) {
    console.error("usage: node test/selfsigned.mjs OUT_DIR [NAME ...]");
    process.exit(2);
  }
  mkdirSync(dir, { recursive: true });
  const { cert, key } = selfSigned({ names: names.length ? names : ["localhost"] });
  writeFileSync(join(dir, "cert.pem"), cert);
  writeFileSync(join(dir, "key.pem"), key, { mode: 0o600 });
  console.log(join(dir, "cert.pem"));
}
