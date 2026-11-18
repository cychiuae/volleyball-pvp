// Cute Beach Volley server: serves the built game (dist/) and runs authoritative online rooms
// over WebSocket on NET.wsPath (docs/NETWORK.md).
//   npm run build && npm start          (PORT env, default NET.defaultPort)
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import { NET } from '../src/config.js';
import { parseMessage } from './protocol.js';
import { createLobby } from './rooms.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.resolve(HERE, '..', 'dist');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.webmanifest': 'application/manifest+json',
};

const SERVER_LIMITS = {
  maxConnections: 1000,
  maxConnectionsPerIp: 16,
  hardMaxPayload: 64 * 1024, // frames above this close the socket; 4 KB..64 KB get a badMsg reply
  maxBufferedBytes: 1 << 20, // a client this far behind on reads is dropped
  heartbeatMs: 2000,
};

/** Resolve a URL pathname inside `root`, or null if it escapes / is malformed. */
export function resolveStaticPath(root, urlPath) {
  let p;
  try { p = decodeURIComponent(urlPath.split('?')[0].split('#')[0]); } catch { return null; }
  if (p.includes('\0')) return null;
  const full = path.resolve(root, '.' + path.posix.normalize('/' + p));
  if (full !== root && !full.startsWith(root + path.sep)) return null;
  return full;
}

async function fileInfo(p) {
  try { const s = await stat(p); return s.isFile() ? s : null; } catch { return null; }
}

function createStaticHandler(root) {
  return async function serveStatic(req, res) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD', 'Content-Type': 'text/plain' });
      res.end('Method Not Allowed');
      return;
    }
    const url = req.url || '/';
    if (url === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
      res.end('ok');
      return;
    }
    let file = resolveStaticPath(root, url);
    if (!file) { res.writeHead(400, { 'Content-Type': 'text/plain' }); res.end('Bad Request'); return; }
    let info = await fileInfo(file);
    if (!info) {
      const dirIndex = path.join(file, 'index.html');
      info = await fileInfo(dirIndex);
      if (info) file = dirIndex;
    }
    if (!info) {
      // SPA fallback: unknown paths without a file extension get the app shell.
      const ext = path.extname(url.split('?')[0]);
      if (ext && ext !== '.html') { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Not Found'); return; }
      file = path.join(root, 'index.html');
      info = await fileInfo(file);
      if (!info) {
        res.writeHead(503, { 'Content-Type': 'text/plain' });
        res.end('Game not built yet: run `npm run build`, then restart the server.');
        return;
      }
    }
    const ext = path.extname(file).toLowerCase();
    const headers = {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': info.size,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': file.includes(`${path.sep}assets${path.sep}`) ? 'public, max-age=31536000, immutable' : 'no-cache',
    };
    res.writeHead(200, headers);
    if (req.method === 'HEAD') { res.end(); return; }
    const stream = createReadStream(file);
    stream.on('error', () => res.destroy());
    stream.pipe(res);
  };
}

/**
 * Start the HTTP + WebSocket server.
 * @param {{ port?: number, host?: string, root?: string, timeScale?: number, tickHz?: number, log?: Function }} [opts]
 *   timeScale: sim speed multiplier (tests); tickHz: room loop rate (default 60).
 * @returns {Promise<{ port: number, close(): Promise<void>, lobby: object }>}
 */
export async function startServer({
  port = Number(process.env.PORT) || NET.defaultPort, host, root = DEFAULT_ROOT,
  timeScale = 1, tickHz = 60, log = () => {},
} = {}) {
  const rootAbs = path.resolve(root);
  const lobby = createLobby({ timeScale, log });
  const http = createServer(createStaticHandler(rootAbs));
  const wss = new WebSocketServer({ noServer: true, maxPayload: SERVER_LIMITS.hardMaxPayload, perMessageDeflate: false });
  const perIp = new Map();
  const clients = new Set();

  http.on('upgrade', (req, socket, head) => {
    const pathname = (req.url || '').split('?')[0];
    const ip = req.socket.remoteAddress || '?';
    if (pathname !== NET.wsPath || wss.clients.size >= SERVER_LIMITS.maxConnections ||
        (perIp.get(ip) || 0) >= SERVER_LIMITS.maxConnectionsPerIp) {
      socket.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req, ip));
  });

  wss.on('connection', (ws, req, ip) => {
    perIp.set(ip, (perIp.get(ip) || 0) + 1);
    let closed = false;
    const client = lobby.connect((str) => {
      if (ws.readyState !== WebSocket.OPEN) return;
      if (ws.bufferedAmount > SERVER_LIMITS.maxBufferedBytes) { ws.terminate(); return; }
      ws.send(str);
    }, { onKick: (why) => { log(`kick ${client.id}: ${why}`); ws.close(1008, why); } });
    let alive = true;
    let pingSentAt = 0;
    ws.on('pong', () => {
      alive = true;
      if (pingSentAt) lobby.notePing(client, Date.now() - pingSentAt);
    });
    client.heartbeat = () => {
      if (!alive) { ws.terminate(); return; }
      alive = false;
      pingSentAt = Date.now();
      try { ws.ping(); } catch { /* closing */ }
    };
    ws.on('message', (data, isBinary) => {
      if (closed || !lobby.allow(client)) return;
      let msg;
      try { msg = parseMessage(data, isBinary); } catch { msg = { error: 'badMsg', msg: 'unreadable message' }; }
      try { lobby.handle(client, msg); } catch (err) { log('handler error', err); }
    });
    const onGone = () => {
      if (closed) return;
      closed = true;
      const n = (perIp.get(ip) || 1) - 1;
      if (n <= 0) perIp.delete(ip); else perIp.set(ip, n);
      clients.delete(client);
      try { lobby.disconnect(client); } catch (err) { log('disconnect error', err); }
    };
    ws.on('close', onGone);
    ws.on('error', onGone);
    clients.add(client);
  });

  // Fixed-rate room loop, stepped with real elapsed time (the game substeps internally).
  let last = performance.now();
  const loop = setInterval(() => {
    const t = performance.now();
    const dt = (t - last) / 1000;
    last = t;
    lobby.tick(dt);
  }, 1000 / tickHz);
  const heartbeat = setInterval(() => { for (const c of clients) c.heartbeat(); }, SERVER_LIMITS.heartbeatMs);

  await new Promise((resolve, reject) => {
    http.once('error', reject);
    http.listen(port, host, () => { http.off('error', reject); resolve(); });
  });
  const actualPort = http.address().port;
  log(`Cute Beach Volley server on http://localhost:${actualPort}  (ws path ${NET.wsPath})`);

  return {
    port: actualPort,
    lobby,
    async close() {
      clearInterval(loop);
      clearInterval(heartbeat);
      lobby.close();
      for (const ws of wss.clients) ws.terminate();
      await new Promise((r) => wss.close(() => r()));
      await new Promise((r) => { http.close(() => r()); http.closeAllConnections?.(); });
    },
  };
}

// Run directly: `node server/index.js`.
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const srv = await startServer({ log: (...a) => console.log('[server]', ...a) });
  const stop = () => { srv.close().finally(() => process.exit(0)); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
