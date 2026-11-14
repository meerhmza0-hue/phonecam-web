'use strict';
// Phone side: captures the camera and sends it to the OBS viewer over WebRTC.

const $ = (id) => document.getElementById(id);

let token = null;
let events = null;
let stream = null;
let pc = null;
let peerPresent = false;
let live = false;
let wakeLock = null;
let statsTimer = null;
let retryTimer = null;

// ---------- small helpers ----------
function setStatus(text, cls = '') {
  const el = $('status');
  el.textContent = text;
  el.className = 'status ' + cls;
}

function store(key, value) { try { localStorage.setItem('phonecam.' + key, value); } catch {} }
function load(key) { try { return localStorage.getItem('phonecam.' + key); } catch { return null; } }

function settings() {
  const [w, h] = $('resolution').value.split('x').map(Number);
  return { deviceId: $('camera').value, width: w, height: h,
           fps: Number($('fps').value), kbps: Number($('bitrate').value) };
}

async function post(path, body) {
  return fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-PhoneCam-Token': token || '' },
    body: JSON.stringify(body),
  });
}

function waitForIce(conn) {
  // We send the full SDP once candidates are gathered (no STUN/TURN: local network only).
  return new Promise((resolve) => {
    if (conn.iceGatheringState === 'complete') return resolve();
    const done = () => { if (conn.iceGatheringState === 'complete') { conn.removeEventListener('icegatheringstatechange', done); resolve(); } };
    conn.addEventListener('icegatheringstatechange', done);
    setTimeout(resolve, 2000);
  });
}

// ---------- pairing ----------
async function pair() {
  const code = $('code').value.trim();
  if (!/^\d{6}$/.test(code)) return setStatus('Enter the 6-digit code', 'bad');
  setStatus('Pairing…');
  let res;
  try { res = await post('/api/pair', { code }); }
  catch { return setStatus('Cannot reach PC', 'bad'); }
  if (res.status === 429) return setStatus('Too many tries, wait 1 min', 'bad');
  if (!res.ok) return setStatus('Wrong code', 'bad');
  token = (await res.json()).token;
  try { sessionStorage.setItem('phonecam.token', token); } catch {}
  await enterCameraView();
}

function resetToPairing(message) {
  stopLive();
  if (events) { events.close(); events = null; }
  token = null;
  try { sessionStorage.removeItem('phonecam.token'); } catch {}
  $('camView').classList.add('hidden');
  $('pairView').classList.remove('hidden');
  setStatus(message, 'bad');
}

// ---------- signaling ----------
function openEvents() {
  events = new EventSource('/api/events?token=' + encodeURIComponent(token));
  events.onmessage = (e) => handleMessage(JSON.parse(e.data));
  events.onerror = () => {
    if (events.readyState === EventSource.CLOSED) {
      resetToPairing('PC restarted — pair again');
    } else {
      setStatus('Reconnecting to PC…', 'warn');
    }
  };
}

async function handleMessage(msg) {
  if (msg.type === 'peer') {
    peerPresent = msg.present;
    if (!peerPresent) { closePc(); updateIdleStatus(); }
    else if (live) negotiate();
    else updateIdleStatus();
  } else if (msg.type === 'answer' && pc) {
    try { await pc.setRemoteDescription({ type: 'answer', sdp: msg.sdp }); }
    catch (e) { console.error(e); scheduleRetry(); }
  } else if (msg.type === 'replaced') {
    resetToPairing('Another phone connected');
  }
}

function updateIdleStatus() {
  if (live) setStatus(peerPresent ? 'Connecting…' : 'Waiting for OBS…', 'warn');
  else setStatus(peerPresent ? 'Ready (OBS found)' : 'Ready (OBS not open)', '');
}

// ---------- camera ----------
async function startCamera() {
  const s = settings();
  const video = {
    width: { ideal: s.width }, height: { ideal: s.height },
    frameRate: { ideal: s.fps },
  };
  if (s.deviceId) video.deviceId = { exact: s.deviceId };
  else video.facingMode = 'environment';

  if (stream) stream.getTracks().forEach((t) => t.stop());
  stream = await navigator.mediaDevices.getUserMedia({ video, audio: false });
  $('preview').srcObject = stream;

  const track = stream.getVideoTracks()[0];
  track.contentHint = 'motion';
  track.onended = () => { if (document.visibilityState === 'visible') restartCamera(); };

  // Swap the live track without renegotiating.
  if (pc) {
    const sender = pc.getSenders().find((x) => x.track && x.track.kind === 'video') || pc.getSenders()[0];
    if (sender) { await sender.replaceTrack(track); applyEncoding(); }
  }
}

async function fillCameraList() {
  const devices = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput');
  const select = $('camera');
  const saved = load('camera');
  select.innerHTML = '';
  for (const d of devices) {
    const opt = document.createElement('option');
    opt.value = d.deviceId;
    opt.textContent = d.label || 'Camera';
    select.appendChild(opt);
  }
  const current = stream && stream.getVideoTracks()[0].getSettings().deviceId;
  const pick = devices.find((d) => d.deviceId === saved) || devices.find((d) => d.deviceId === current);
  if (pick) select.value = pick.deviceId;
}

async function restartCamera() {
  try { await startCamera(); }
  catch (e) { console.error(e); setStatus('Camera error: ' + e.name, 'bad'); }
}

async function enterCameraView() {
  $('pairView').classList.add('hidden');
  $('camView').classList.remove('hidden');
  for (const id of ['resolution', 'fps', 'bitrate']) {
    const v = load(id);
    if (v && [...$(id).options].some((o) => o.value === v)) $(id).value = v;
  }
  try {
    await startCamera();
    await fillCameraList();
    if ($('camera').value && $('camera').value !== stream.getVideoTracks()[0].getSettings().deviceId) {
      await startCamera();
    }
  } catch (e) {
    console.error(e);
    return setStatus(e.name === 'NotAllowedError' ? 'Camera permission denied' : 'Camera error: ' + e.name, 'bad');
  }
  openEvents();
  updateIdleStatus();
}

// ---------- WebRTC ----------
function preferH264(transceiver) {
  // Hardware H.264 keeps the iPhone cool; fall back to whatever both sides support.
  if (!transceiver.setCodecPreferences || !RTCRtpSender.getCapabilities) return;
  const codecs = RTCRtpSender.getCapabilities('video').codecs;
  const h264 = codecs.filter((c) => c.mimeType.toLowerCase() === 'video/h264');
  const rest = codecs.filter((c) => c.mimeType.toLowerCase() !== 'video/h264');
  try { transceiver.setCodecPreferences([...h264, ...rest]); } catch {}
}

async function applyEncoding() {
  if (!pc) return;
  const sender = pc.getSenders()[0];
  if (!sender) return;
  const s = settings();
  try {
    const p = sender.getParameters();
    if (!p.encodings || !p.encodings.length) p.encodings = [{}];
    p.encodings[0].maxBitrate = s.kbps * 1000;
    p.encodings[0].maxFramerate = s.fps;
    p.degradationPreference = 'maintain-resolution';
    await sender.setParameters(p);
  } catch (e) { console.warn('setParameters failed', e); }
}

function closePc() {
  clearTimeout(retryTimer);
  if (pc) { pc.close(); pc = null; }
  stopStats();
}

function scheduleRetry() {
  closePc();
  if (live && peerPresent) {
    setStatus('Connection lost — retrying…', 'warn');
    retryTimer = setTimeout(negotiate, 2000);
  }
}

async function negotiate() {
  closePc();
  if (!stream) return;
  setStatus('Connecting…', 'warn');
  const conn = new RTCPeerConnection({ iceServers: [] });
  pc = conn;
  const tx = conn.addTransceiver(stream.getVideoTracks()[0], { direction: 'sendonly', streams: [stream] });
  preferH264(tx);

  conn.onconnectionstatechange = () => {
    if (pc !== conn) return;
    if (conn.connectionState === 'connected') {
      setStatus('LIVE', 'live');
      applyEncoding();
      startStats();
    } else if (conn.connectionState === 'failed' || conn.connectionState === 'disconnected') {
      scheduleRetry();
    }
  };

  try {
    await conn.setLocalDescription(await conn.createOffer());
    await waitForIce(conn);
    if (pc !== conn) return;
    const res = await post('/api/signal', { type: 'offer', sdp: conn.localDescription.sdp });
    if (res.status === 401) resetToPairing('Session expired — pair again');
  } catch (e) {
    console.error(e);
    scheduleRetry();
  }
}

// ---------- stats ----------
function startStats() {
  stopStats();
  let lastBytes = 0, lastTime = 0;
  statsTimer = setInterval(async () => {
    if (!pc) return;
    const report = await pc.getStats();
    report.forEach((r) => {
      if (r.type === 'outbound-rtp' && r.kind === 'video') {
        const kbps = lastTime ? Math.round(((r.bytesSent - lastBytes) * 8) / (r.timestamp - lastTime)) : 0;
        lastBytes = r.bytesSent; lastTime = r.timestamp;
        const res = r.frameWidth ? `${r.frameWidth}×${r.frameHeight}` : '';
        const fps = r.framesPerSecond ? `${Math.round(r.framesPerSecond)} fps` : '';
        $('stats').textContent = [res, fps, kbps ? `${(kbps / 1000).toFixed(1)} Mbps` : ''].filter(Boolean).join(' · ');
      }
    });
  }, 1000);
}
function stopStats() {
  clearInterval(statsTimer);
  statsTimer = null;
  $('stats').textContent = '';
}

// ---------- live on/off ----------
async function startLive() {
  live = true;
  $('liveBtn').textContent = 'Stop streaming';
  $('liveBtn').classList.add('stop');
  try { if ('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen'); } catch {}
  if (peerPresent) negotiate(); else updateIdleStatus();
}

function stopLive() {
  if (live && token) post('/api/signal', { type: 'bye' }).catch(() => {});
  live = false;
  closePc();
  $('liveBtn').textContent = 'Start streaming';
  $('liveBtn').classList.remove('stop');
  if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
  if (token) updateIdleStatus();
}

// ---------- wiring ----------
$('pairBtn').addEventListener('click', pair);
$('code').addEventListener('keydown', (e) => { if (e.key === 'Enter') pair(); });
$('liveBtn').addEventListener('click', () => (live ? stopLive() : startLive()));

for (const id of ['camera', 'resolution', 'fps', 'bitrate']) {
  $(id).addEventListener('change', async () => {
    store(id, $(id).value);
    if (id === 'bitrate') applyEncoding(); else restartCamera();
  });
}

document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState !== 'visible' || !token) return;
  // iOS stops the camera when Safari is in the background; bring it back.
  const track = stream && stream.getVideoTracks()[0];
  if (!track || track.readyState === 'ended') await restartCamera();
  if (live) {
    try { if ('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen'); } catch {}
  }
});

// Resume a session after a page reload.
try { token = sessionStorage.getItem('phonecam.token'); } catch {}
if (token) enterCameraView();
