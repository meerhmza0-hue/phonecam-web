'use strict';
// Generates a self-signed TLS certificate using only Node's built-in crypto.
// iOS Safari only allows camera access on HTTPS pages, so the phone page needs TLS.
// No third-party packages and no external tools (openssl/PowerShell) are needed.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// ---- Minimal ASN.1 DER encoder (only what an X.509 certificate needs) ----
function derLength(n) {
  if (n < 128) return Buffer.from([n]);
  const bytes = [];
  while (n > 0) { bytes.unshift(n & 0xff); n >>= 8; }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}
function tlv(tag, ...parts) {
  const body = Buffer.concat(parts);
  return Buffer.concat([Buffer.from([tag]), derLength(body.length), body]);
}
const seq = (...p) => tlv(0x30, ...p);
const set = (...p) => tlv(0x31, ...p);
const nullValue = Buffer.from([0x05, 0x00]);
const utf8 = (s) => tlv(0x0c, Buffer.from(s, 'utf8'));
const octet = (b) => tlv(0x04, b);
const bitString = (b) => tlv(0x03, Buffer.concat([Buffer.from([0]), b]));
const ctx = (n, constructed, ...p) => tlv((constructed ? 0xa0 : 0x80) | n, ...p);

function integer(buf) {
  if (buf[0] & 0x80) buf = Buffer.concat([Buffer.from([0]), buf]);
  return tlv(0x02, buf);
}
function oid(str) {
  const a = str.split('.').map(Number);
  const out = [40 * a[0] + a[1]];
  for (const v of a.slice(2)) {
    const t = [v & 0x7f];
    let x = Math.floor(v / 128);
    while (x > 0) { t.unshift((x & 0x7f) | 0x80); x = Math.floor(x / 128); }
    out.push(...t);
  }
  return tlv(0x06, Buffer.from(out));
}
function utcTime(d) {
  // YYMMDDHHMMSSZ (valid for years < 2050)
  const s = d.toISOString().replace(/[-:T]/g, '').slice(2, 14) + 'Z';
  return tlv(0x17, Buffer.from(s, 'ascii'));
}

function buildCertificate(ipAddresses) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });

  const sha256WithRSA = seq(oid('1.2.840.113549.1.1.11'), nullValue);
  const name = seq(set(seq(oid('2.5.4.3'), utf8('PhoneCam local'))));
  const now = Date.now();
  const validity = seq(utcTime(new Date(now - 24 * 3600 * 1000)),
                       utcTime(new Date(now + 365 * 24 * 3600 * 1000)));
  const serial = crypto.randomBytes(16);
  serial[0] &= 0x7f;

  const sanEntries = [ctx(2, false, Buffer.from('localhost'))];
  for (const ip of ipAddresses) {
    sanEntries.push(ctx(7, false, Buffer.from(ip.split('.').map(Number))));
  }

  const extensions = seq(
    seq(oid('2.5.29.19'), octet(seq())),                                   // basicConstraints: not a CA
    seq(oid('2.5.29.15'), tlv(0x01, Buffer.from([0xff])),                 // keyUsage (critical)
        octet(tlv(0x03, Buffer.from([0x05, 0xa0])))),                     //   digitalSignature, keyEncipherment
    seq(oid('2.5.29.37'), octet(seq(oid('1.3.6.1.5.5.7.3.1')))),          // extKeyUsage: serverAuth
    seq(oid('2.5.29.17'), octet(seq(...sanEntries)))                      // subjectAltName
  );

  const tbs = seq(
    ctx(0, true, integer(Buffer.from([2]))),  // X.509 v3
    integer(serial),
    sha256WithRSA,
    name,
    validity,
    name,
    publicKey.export({ type: 'spki', format: 'der' }),
    ctx(3, true, extensions)
  );

  const signature = crypto.sign('sha256', tbs, privateKey);
  const certDer = seq(tbs, sha256WithRSA, bitString(signature));
  const certPem = '-----BEGIN CERTIFICATE-----\n' +
    certDer.toString('base64').match(/.{1,64}/g).join('\n') +
    '\n-----END CERTIFICATE-----\n';
  const keyPem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  return { certPem, keyPem };
}

// Reuse the saved certificate if it is still valid, so Safari only warns once.
function ensureCert(dir, ipAddresses) {
  const certFile = path.join(dir, 'cert.pem');
  const keyFile = path.join(dir, 'key.pem');
  if (fs.existsSync(certFile) && fs.existsSync(keyFile)) {
    try {
      const x = new crypto.X509Certificate(fs.readFileSync(certFile));
      if (new Date(x.validTo).getTime() > Date.now() + 7 * 24 * 3600 * 1000) {
        return { cert: fs.readFileSync(certFile), key: fs.readFileSync(keyFile), created: false };
      }
    } catch { /* fall through and regenerate */ }
  }
  fs.mkdirSync(dir, { recursive: true });
  const { certPem, keyPem } = buildCertificate(ipAddresses);
  fs.writeFileSync(certFile, certPem);
  fs.writeFileSync(keyFile, keyPem, { mode: 0o600 });
  return { cert: Buffer.from(certPem), key: Buffer.from(keyPem), created: true };
}

module.exports = { ensureCert };
