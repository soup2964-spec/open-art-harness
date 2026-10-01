// ---------------------------------------------------------------------------------------------
// ATTRIBUTION. Copied from the proven sealed-replay tooling that produced
// research/11_sealed_replay_verification.md (OpenArt tag verification, 2026-09-29):
//   openart_2026-09-29/crawl/sealed_evidence/tools/gatekeeper_proxy.cjs
//   original SHA-256 6a7c5b4ffc2a1fd8777c9a674d5d5b6debbcc72f0dc88caf74a4a2323f14b72f
// Every change made for the watchdog is marked "[watchdog]". Behaviour without the new
// options is byte-for-byte the original behaviour.
//   [watchdog] 1. startProxy(opts) accepts opts.allowConnect(host, port) -> boolean. In OPEN mode a
//                 host the predicate rejects is refused with 403 WITHOUT opening an upstream socket
//                 ("refused-policy"). This is the out-of-process layer of the watchdog's
//                 *collection seal*: only hosts needed to render openart.ai are ever tunnelled.
//   [watchdog] 2. OPEN-mode entries get an explicit action while connecting and on upstream error
//                 (the original left action undefined in those two cases).
//   [watchdog] 3. summary() additionally reports refusedByPolicy and the set of tunnelled hosts.
// ---------------------------------------------------------------------------------------------
// Gatekeeper proxy: an independent, out-of-browser network backstop for the sealed replay.
// Chrome is launched with --proxy-server pointing here, so every HTTP(S)/WS request the
// browser makes (from any target, including browser-process-initiated ones) must pass
// through this process.
//
// Two modes:
//   OPEN   : relays CONNECT tunnels / plain HTTP (used only for the ordinary anonymous page load)
//   SEALED : refuses every new CONNECT / HTTP request (403) WITHOUT ever opening an upstream
//            socket, and at the moment of sealing destroys every tunnel that is still open.
//            Bytes that arrive on a tunnel after the seal are counted and dropped, never written.
//
// Every connection attempt is logged with a timestamp and the mode it met, so the log is a
// complete, independent record of what the browser tried to reach after sealing.
'use strict';
const http = require('http');
const net = require('net');

function startProxy(opts) {
  opts = opts || {}; // [watchdog]
  const allowConnect = typeof opts.allowConnect === 'function' ? opts.allowConnect : null; // [watchdog]
  const state = {
    sealed: false,
    sealedAt: null,
    log: [],          // one entry per CONNECT / HTTP request received
    tunnels: new Set(),
    droppedUpAfterSeal: 0,   // bytes the browser tried to push on a tunnel after seal (dropped)
    droppedDownAfterSeal: 0,
    destroyedAtSeal: 0,
  };

  const server = http.createServer((req, res) => {
    const entry = { t: Date.now(), iso: new Date().toISOString(), kind: 'HTTP', method: req.method, target: req.url, mode: state.sealed ? 'SEALED' : 'OPEN' };
    state.log.push(entry);
    if (state.sealed) {
      entry.action = 'refused-403';
      res.writeHead(403, { 'content-type': 'text/plain', connection: 'close' });
      res.end('sealed');
      return;
    }
    // OPEN mode: plain-HTTP forward (rare; almost everything is HTTPS via CONNECT)
    let u;
    try { u = new URL(req.url); } catch (e) { entry.action = 'bad-url'; res.writeHead(400); res.end(); return; }
    // [watchdog] collection-seal host filter (no upstream socket for a refused host)
    if (allowConnect && !allowConnect(u.hostname, Number(u.port || 80))) {
      entry.action = 'refused-policy';
      res.writeHead(403, { 'content-type': 'text/plain', connection: 'close' });
      res.end('host not allowlisted by the watchdog collection seal');
      return;
    }
    entry.action = 'forwarded';
    const up = http.request({ host: u.hostname, port: u.port || 80, method: req.method, path: u.pathname + u.search, headers: req.headers }, (ur) => {
      if (state.sealed) { entry.action = 'aborted-at-seal'; ur.destroy(); res.destroy(); return; }
      res.writeHead(ur.statusCode, ur.headers);
      ur.pipe(res);
    });
    up.on('error', () => { try { res.destroy(); } catch (e) {} });
    req.pipe(up);
  });

  server.on('connect', (req, clientSocket, head) => {
    const entry = { t: Date.now(), iso: new Date().toISOString(), kind: 'CONNECT', target: req.url, mode: state.sealed ? 'SEALED' : 'OPEN', up: 0, down: 0 };
    state.log.push(entry);
    clientSocket.on('error', () => {});
    if (state.sealed) {
      // Never open an upstream socket once sealed.
      entry.action = 'refused-403';
      try { clientSocket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); } catch (e) {}
      return;
    }
    const [host, portStr] = req.url.split(':');
    const port = parseInt(portStr || '443', 10);
    // [watchdog] collection-seal host filter: refuse BEFORE any upstream socket exists.
    if (allowConnect && !allowConnect(host, port)) {
      entry.action = 'refused-policy';
      try { clientSocket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); } catch (e) {}
      return;
    }
    entry.action = 'connecting'; // [watchdog]
    const upstream = net.connect(port, host);
    const tunnel = { entry, clientSocket, upstream };
    state.tunnels.add(tunnel);
    upstream.on('error', () => { if (entry.action === 'connecting') entry.action = 'upstream-error'; try { clientSocket.destroy(); } catch (e) {} }); // [watchdog] action
    upstream.on('connect', () => {
      if (state.sealed) { // race: sealed while the upstream TCP connect was in progress
        entry.action = 'aborted-at-seal';
        upstream.destroy(); clientSocket.destroy(); state.tunnels.delete(tunnel);
        return;
      }
      entry.action = 'tunnel';
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head && head.length) { entry.up += head.length; upstream.write(head); }
      // Manual relay (instead of .pipe) so every chunk is checked against the seal flag.
      clientSocket.on('data', (chunk) => {
        if (state.sealed) { state.droppedUpAfterSeal += chunk.length; entry.droppedUpAfterSeal = (entry.droppedUpAfterSeal || 0) + chunk.length; return; }
        entry.up += chunk.length; upstream.write(chunk);
      });
      upstream.on('data', (chunk) => {
        if (state.sealed) { state.droppedDownAfterSeal += chunk.length; return; }
        entry.down += chunk.length; clientSocket.write(chunk);
      });
    });
    const cleanup = () => { state.tunnels.delete(tunnel); try { upstream.destroy(); } catch (e) {} try { clientSocket.destroy(); } catch (e) {} };
    clientSocket.on('close', cleanup);
    upstream.on('close', cleanup);
  });

  // Upgrade (ws:// through an HTTP proxy) – refuse when sealed, otherwise not supported in OPEN mode either.
  server.on('upgrade', (req, socket) => {
    state.log.push({ t: Date.now(), iso: new Date().toISOString(), kind: 'UPGRADE', target: req.url, mode: state.sealed ? 'SEALED' : 'OPEN', action: 'refused-403' });
    try { socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'); } catch (e) {}
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({
        port,
        state,
        seal() {
          state.sealed = true;
          state.sealedAt = Date.now();
          let n = 0;
          for (const tn of Array.from(state.tunnels)) {
            n++;
            tn.entry.destroyedAtSeal = true;
            try { tn.upstream.destroy(); } catch (e) {}
            try { tn.clientSocket.destroy(); } catch (e) {}
            state.tunnels.delete(tn);
          }
          state.destroyedAtSeal = n;
          return n;
        },
        summary() {
          const post = state.log.filter((e) => state.sealedAt && e.t >= state.sealedAt);
          const pre = state.log.filter((e) => !state.sealedAt || e.t < state.sealedAt); // [watchdog]
          return {
            port,
            sealedAt: state.sealedAt ? new Date(state.sealedAt).toISOString() : null,
            totalAttempts: state.log.length,
            preSealAttempts: pre.length,
            postSealAttempts: post.length,
            postSealAllowed: post.filter((e) => e.action !== 'refused-403').length,
            postSealRefused: post.filter((e) => e.action === 'refused-403').map((e) => ({ iso: e.iso, kind: e.kind, target: e.target })),
            tunnelsDestroyedAtSeal: state.destroyedAtSeal,
            bytesDroppedUpstreamAfterSeal: state.droppedUpAfterSeal,
            bytesDroppedDownstreamAfterSeal: state.droppedDownAfterSeal,
            // [watchdog] collection-seal accounting
            refusedByPolicy: pre.filter((e) => e.action === 'refused-policy').map((e) => ({ iso: e.iso, kind: e.kind, target: e.target })),
            tunnelledHosts: Array.from(new Set(pre.filter((e) => e.action === 'tunnel' || e.action === 'forwarded' || e.action === 'aborted-at-seal').map((e) => {
              const t = String(e.target);
              if (/^https?:\/\//.test(t)) { try { return new URL(t).hostname; } catch (err) { return t; } } // HTTP forward: absolute URL
              return t.split(':')[0]; // CONNECT: host:port
            }))).sort(),
          };
        },
        close() { return new Promise((r) => server.close(() => r())); },
      });
    });
  });
}

module.exports = { startProxy };
