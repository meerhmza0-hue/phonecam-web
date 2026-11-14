# PhoneCam

Use your iPhone as a camera in OBS on Windows. No app to install on the phone,
nothing to sideload — the phone uses Safari, the PC runs one small Node.js server.

```
iPhone Safari (camera)  ──WebRTC, encrypted──▶  OBS Browser Source
          │                                             │
          └──── setup messages ──▶ server.js ◀──────────┘
                (pairing + WebRTC signaling only, never sees video)
```

- Up to 1080p at 30/60 fps, typically 100–200 ms latency on a local network
- Works over Wi-Fi **or over the USB cable** (via Personal Hotspot)
- Zero third-party dependencies — only Node.js built-in modules

## 1. Install (once)

1. Install **Node.js LTS** from <https://nodejs.org> (version 18 or newer).
2. Download/clone this folder, e.g. to `C:\PhoneCam`.

## 2. Start the server

Open PowerShell in the folder and run:

```powershell
node server.js
```

The window shows:
- the address to open on your iPhone, e.g. `https://192.168.1.20:8443`
- a 6-digit **pairing code** (new every time the server starts)
- the OBS URL: `http://127.0.0.1:8080/view`

**Windows Firewall** will ask whether Node.js may accept connections.
Tick **Private networks** only and click Allow.

## 3. Set up OBS (once)

1. In your scene: **Sources → + → Browser**.
2. URL: `http://127.0.0.1:8080/view`
3. Width `1920`, Height `1080` (match the resolution you stream).
4. Untick **Shutdown source when not visible**.
5. Click OK. The source stays empty until the phone starts streaming.

Tip: use `http://127.0.0.1:8080/view?debug` while testing to see the connection status.

## 4. Connect the iPhone

1. iPhone and PC on the same Wi-Fi (or see USB below).
2. Open **Safari** and go to the `https://…:8443` address shown by the server.
3. Safari warns *"This Connection Is Not Private"* — expected, because the
   certificate is self-made on your PC. Tap **Show Details → visit this website → Visit Website**.
   (You only need to do this once; the certificate is reused.)
4. Enter the pairing code → **Connect** → allow camera access.
5. Choose camera (Back / Ultra Wide / Telephoto / Front), resolution, fps, bitrate.
6. Tap **Start streaming**. The status turns red **LIVE** and the video appears in OBS.

Keep Safari in front with the screen on. If you switch apps, iOS pauses the
camera; it resumes when you come back.

## Using the cable instead of Wi-Fi

More stable, no Wi-Fi interference:

1. Install Apple's **Apple Devices** app (or iTunes) on Windows — it provides the USB driver.
2. On the iPhone: **Settings → Personal Hotspot → Allow Others to Join** (on).
3. Plug in the cable and tap **Trust** on the phone if asked.
4. Restart `node server.js` — it now also lists an address like `https://172.20.10.x:8443`.
   Use that one in Safari.

If Windows starts using the phone's mobile data for internet, keep Wi-Fi/Ethernet
connected for internet; Windows normally prefers it.

## Settings

| Environment variable | Default | Purpose |
|---|---|---|
| `PHONECAM_PORT` | `8443` | HTTPS port for the phone page |
| `PHONECAM_VIEW_PORT` | `8080` | Local port for the OBS page |
| `PHONECAM_CODE` | random | Fixed 6-digit pairing code |

Example: `$env:PHONECAM_CODE="482913"; node server.js`

## Troubleshooting

| Problem | Fix |
|---|---|
| Safari can't open the page | Same network? Firewall allowed on Private networks? Try the other listed IP. Guest/corporate Wi-Fi often blocks device-to-device traffic. |
| "Wrong code" / "Too many tries" | Code changes on each server start. After 5 wrong tries, wait 1 minute. |
| Status stuck on "Waiting for OBS…" | The OBS Browser Source isn't loaded — check its URL, right-click it → Refresh. |
| Stuck on "Connecting…" | Network blocks UDP between devices; try the USB cable method. |
| Video choppy | Lower bitrate to 4 Mbps or use 720p; use 5 GHz Wi-Fi or the cable. |
| Black in OBS after PC sleep | Right-click the source → **Refresh cache of current page**. |

## Files

```
server.js         HTTPS/HTTP server, pairing, signaling relay
lib/cert.js       makes the self-signed certificate (Node crypto only)
public/phone.html phone page
public/phone.js   camera capture + WebRTC sender
public/view.html  OBS page
public/view.js    WebRTC receiver
public/style.css  styles
```

See [SECURITY.md](SECURITY.md) for the security design.
