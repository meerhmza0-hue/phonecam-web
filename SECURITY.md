# Security

## Design

- **No third-party code.** The server uses only Node.js built-in modules
  (`https`, `http`, `crypto`, `fs`, `os`, `path`). There is no `node_modules`,
  no install step, no install/postinstall scripts, and no binaries in the repo.
- **No outbound connections.** The server only listens. The pages load nothing
  from the internet (no CDNs, fonts, analytics or STUN/TURN servers).
- **Video never touches the server.** It goes directly from the phone to the
  OBS page over WebRTC, which is always encrypted (DTLS-SRTP).
- **Phone page (`0.0.0.0:8443`)** is HTTPS with a self-signed certificate
  generated locally on first run (`certs/`, git-ignored, key file `0600`).
- **Pairing:** a random 6-digit code is printed on each start. A correct code
  returns a random 256-bit session token required for all phone API calls.
  Codes are compared in constant time. 5 wrong codes from one IP within a
  minute → that IP is locked out for 1 minute.
- **OBS page (`127.0.0.1:8080`)** is bound to loopback, so it cannot be reached
  from the network.
- **Strict allow-lists:** only the five page files in `public/` are served; anything else is 404
  (no directory listing or path traversal). Each side may only send its own
  message types (phone: offer/bye, viewer: answer). Request bodies are capped at 256 KB.
- **Browser hardening headers:** strict Content-Security-Policy (no inline or
  remote scripts), `nosniff`, `no-referrer`, `X-Frame-Options: DENY`,
  `Permissions-Policy` allowing only the camera on the phone page.
- Audio is never requested.

## Known limits

- The pairing code is 6 digits; the lockout makes guessing impractical on a home
  network, but run the server only on networks you trust and stop it (Ctrl+C) when not in use.
- The certificate is self-signed, so Safari shows a warning the first time.
  Check the address matches your PC before accepting.
- Anything running on the PC itself can open the loopback OBS page.

## Reporting

Please open a GitHub issue (or a private security advisory) for any problem.
