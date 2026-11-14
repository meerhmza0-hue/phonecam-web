'use strict';
// OBS side: receives the phone's video and shows it full-window.
// Add ?debug to the URL to see connection status on screen.

const video = document.getElementById('video');
const info = document.getElementById('info');
const debug = new URLSearchParams(location.search).has('debug');
let pc = null;

function show(text) {
  if (!debug) return;
  info.classList.remove('hidden');
  info.textContent = text;
}

function waitForIce(conn) {
  return new Promise((resolve) => {
    if (conn.iceGatheringState === 'complete') return resolve();
    const done = () => { if (conn.iceGatheringState === 'complete') { conn.removeEventListener('icegatheringstatechange', done); resolve(); } };
    conn.addEventListener('icegatheringstatechange', done);
    setTimeout(resolve, 2000);
  });
}

function close() {
  if (pc) { pc.close(); pc = null; }
  video.srcObject = null;
}

async function answer(sdp) {
  close();
  const conn = new RTCPeerConnection({ iceServers: [] });
  pc = conn;

  conn.ontrack = (ev) => {
    // Ask for the smallest possible buffer = lowest latency.
    try { ev.receiver.jitterBufferTarget = 0; } catch {}
    try { ev.receiver.playoutDelayHint = 0; } catch {}
    video.srcObject = ev.streams[0] || new MediaStream([ev.track]);
    video.play().catch(() => {});
  };
  conn.onconnectionstatechange = () => show('connection: ' + conn.connectionState);

  await conn.setRemoteDescription({ type: 'offer', sdp });
  await conn.setLocalDescription(await conn.createAnswer());
  await waitForIce(conn);
  if (pc !== conn) return;
  await fetch('/api/signal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'answer', sdp: conn.localDescription.sdp }),
  });
}

const events = new EventSource('/api/events');
events.onopen = () => show('waiting for phone…');
events.onerror = () => show('server not running — retrying…');
events.onmessage = async (e) => {
  const msg = JSON.parse(e.data);
  if (msg.type === 'offer') {
    try { await answer(msg.sdp); } catch (err) { show('error: ' + err.message); }
  } else if (msg.type === 'bye' || (msg.type === 'peer' && !msg.present)) {
    close();
    show('waiting for phone…');
  }
};
