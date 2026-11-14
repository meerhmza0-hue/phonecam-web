'use strict';
// PhoneCam server: lets an iPhone (Safari) send its camera to OBS over WebRTC.
//
// The server never touches video. It only relays the short WebRTC setup
// messages ("signaling") between the phone page and the OBS viewer page.
// Video then flows directly phone -> PC over your local network (encrypted by WebRTC).
//
//   HTTPS  0.0.0.0:8443   -> phone page (needs pairing code)
//   HTTP   127.0.0.1:8080 -> OBS viewer page (only reachable from this PC)
//
// Uses only Node.js built-in modules. No npm packages.

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { ensureCert } = require('./lib/cert');

const PHONE_PORT = Number(process.env.PHONECAM_PORT) || 8443;
const VIEW_PORT = Number(process.env.PHONECAM_VIEW_PORT) || 8080;
const PUBLIC_DIR = path.join(__dirname, 'public');
const PAIR_CODE = /^\d{6}$/.test(process.env.PHONECAM_CODE || '')
  ? process.env.PHONECAM_CODE
  : String(crypto.randomInt(0, 1000000)).padStart(6, '0');

const MAX_BODY = 256 * 1024;          // SDP messages are a few KB
const MAX_FAILS = 5;                  // wrong pairing codes allowed...
const LOCKOUT_MS = 60 * 1000;         // ...per minute, per IP

// Only these files are served. Nothing else on disk is reachable.
const PHONE_FILES = {
  '/': ['phone.html', 'text/html; charset=utf-8'],
  '/phone.js': ['phone.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
};
const VIEW_FILES = {
  '/view': ['view.html', 'text/html; charset=utf-8'],
  '/view.js': ['view.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
};

const SECURITY_HEADERS = {
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; " +
    "img-src 'self' data:; media-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Cache-Control': 'no-store',
};

// ---- State ----
const tokens = new Set();             // paired phone sessions
const failures = new Map();           // ip -> { count, until }
const peers = { sender: null, viewer: null };  // current SSE connections

function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family === 'IPv4' && !a.internal) out.push(a.address);
    }
  }
  return out;
}

function log(...args) {
  console.log(new Date().toLocaleTimeString(), ...args);
}

function send(res, status, body, type = 'application/json; charset=utf-8', extra = {}) {
  res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': type, ...extra });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

function serveFile(res, files, pathname) {
  const entry = files[pathname];
  if (!entry) return send(res, 404, { error: 'not found' });
  const [file, type] = entry;
  fs.readFile(path.join(PUBLIC_DIR, file), (err, data) => {
    if (err) return send(res, 500, { error: 'read error' });
    const extra = file === 'phone.html' ? { 'Permissions-Policy': 'camera=(self), microphone=()' } : {};
    send(res, 200, data, type, extra);
  });
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new Error('bad json')); }
    });
    req.on('error', reject);
  });
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function pushEvent(role, msg) {
  const p = peers[role];
  if (p) p.res.write(`data: ${JSON.stringify(msg)}\n\n`);
}

const other = (role) => (role === 'sender' ? 'viewer' : 'sender');

function openEventStream(req, res, role) {
  res.writeHead(200, {
    ...SECURITY_HEADERS,
    'Content-Type': 'text/event-stream; charset=utf-8',
    Connection: 'keep-alive',
  });
  res.write('retry: 2000\n\n');

  // Only one phone and one viewer at a time; a new one replaces the old.
  if (peers[role]) {
    pushEvent(role, { type: 'replaced' });
    peers[role].res.end();
  }
  const me = { res, id: crypto.randomUUID() };
  peers[role] = me;
  log(`${role} connected`);

  pushEvent(role, { type: 'peer', present: !!peers[other(role)] });
  pushEvent(other(role), { type: 'peer', present: true });

  const keepAlive = setInterval(() => res.write(': ping\n\n'), 15000);
  req.on('close', () => {
    clearInterval(keepAlive);
    if (peers[role] === me) {
      peers[role] = null;
      log(`${role} disconnected`);
      pushEvent(other(role), { type: 'peer', present: false });
    }
  });
}

async function handleSignal(req, res, role) {
  let msg;
  try { msg = await readJson(req); } catch (e) { return send(res, 400, { error: e.message }); }
  const allowed = role === 'sender' ? ['offer', 'bye'] : ['answer'];
  if (!msg || !allowed.includes(msg.type)) return send(res, 400, { error: 'bad message type' });
  if (msg.type !== 'bye' && (typeof msg.sdp !== 'string' || msg.sdp.length > MAX_BODY)) {
    return send(res, 400, { error: 'bad sdp' });
  }
  pushEvent(other(role), msg.type === 'bye' ? { type: 'bye' } : { type: msg.type, sdp: msg.sdp });
  send(res, 200, { ok: true });
}

async function handlePair(req, res) {
  const ip = req.socket.remoteAddress;
  const f = failures.get(ip);
  if (f && f.until > Date.now()) return send(res, 429, { error: 'too many attempts' });

  let body;
  try { body = await readJson(req); } catch (e) { return send(res, 400, { error: e.message }); }

  if (!safeEqual(body && body.code, PAIR_CODE)) {
    const now = Date.now();
    const recent = f && now - f.first < LOCKOUT_MS;   // count failures within a 1-minute window
    const count = (recent ? f.count : 0) + 1;
    failures.set(ip, { count, first: recent ? f.first : now, until: count >= MAX_FAILS ? now + LOCKOUT_MS : 0 });
    log(`wrong pairing code from ${ip} (${count}/${MAX_FAILS})`);
    return send(res, 401, { error: 'wrong code' });
  }
  failures.delete(ip);
  const token = crypto.randomBytes(32).toString('hex');
  tokens.add(token);
  log(`phone paired from ${ip}`);
  send(res, 200, { token });
}

// ---- Phone server (HTTPS, reachable on your network) ----
function phoneHandler(req, res) {
  const url = new URL(req.url, 'https://local');
  const token = url.searchParams.get('token') || req.headers['x-phonecam-token'];
  const authed = token && tokens.has(token);

  if (req.method === 'POST' && url.pathname === '/api/pair') return handlePair(req, res);
  if (req.method === 'GET' && url.pathname === '/api/events') {
    if (!authed) return send(res, 401, { error: 'not paired' });
    return openEventStream(req, res, 'sender');
  }
  if (req.method === 'POST' && url.pathname === '/api/signal') {
    if (!authed) return send(res, 401, { error: 'not paired' });
    return handleSignal(req, res, 'sender');
  }
  if (req.method === 'GET') return serveFile(res, PHONE_FILES, url.pathname);
  send(res, 405, { error: 'method not allowed' });
}

// ---- Viewer server (HTTP, bound to 127.0.0.1 so only OBS on this PC can use it) ----
function viewHandler(req, res) {
  const url = new URL(req.url, 'http://local');
  if (req.method === 'GET' && url.pathname === '/api/events') return openEventStream(req, res, 'viewer');
  if (req.method === 'POST' && url.pathname === '/api/signal') return handleSignal(req, res, 'viewer');
  if (req.method === 'GET') return serveFile(res, VIEW_FILES, url.pathname);
  send(res, 405, { error: 'method not allowed' });
}

// ---- Start ----
const ips = lanAddresses();
const tls = ensureCert(path.join(__dirname, 'certs'), ips);

https.createServer({ cert: tls.cert, key: tls.key }, phoneHandler)
  .listen(PHONE_PORT, '0.0.0.0', () => {
    http.createServer(viewHandler).listen(VIEW_PORT, '127.0.0.1', () => {
      console.log('\n================ PhoneCam ================');
      if (tls.created) console.log('Created a new self-signed certificate in ./certs');
      console.log('\nOn your iPhone, open Safari and go to:');
      for (const ip of ips) console.log(`   https://${ip}:${PHONE_PORT}`);
      if (!ips.length) console.log('   (no network address found - connect Wi-Fi or the USB hotspot)');
      console.log(`\nPairing code:  ${PAIR_CODE}`);
      console.log(`\nIn OBS, add a Browser Source with URL:\n   http://127.0.0.1:${VIEW_PORT}/view`);
      console.log('\nPress Ctrl+C to stop.\n==========================================\n');
    });
  })
  .on('error', (e) => {
    console.error(`Could not start on port ${PHONE_PORT}: ${e.message}`);
    process.exit(1);
  });
