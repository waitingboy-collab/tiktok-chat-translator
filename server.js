// TikTok LIVE Chat Translator — local server.
// Reads the chat of any public TikTok LIVE (by @username) and serves a web page
// that shows every comment translated into the language you pick.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import os from 'node:os';

const DIR = path.dirname(fileURLToPath(import.meta.url));
loadEnv(path.join(DIR, '.env'));

const PORT = Number(process.env.PORT) || 3030;
const HOST = process.env.HOST || '127.0.0.1';
const MOCK_TIKTOK = process.env.MOCK_TIKTOK === '1';
const MOCK_TRANSLATE = process.env.MOCK_TRANSLATE === '1';
const IDLE_CLOSE_MS = 15_000;        // disconnect from TikTok this long after the last page closes
const RECENT_KEEP = 30;              // comments replayed to a page that opens mid-stream

/* ───────────────────────────── helpers ───────────────────────────── */

function loadEnv(file) {
  try {
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch { /* no .env — that's fine */ }
}

function normalizeUser(input) {
  let s = String(input || '').trim();
  const m = s.match(/tiktok\.com\/@([A-Za-z0-9._]+)/i);
  if (m) return m[1].toLowerCase();
  s = s.replace(/^@+/, '').trim();
  return /^[A-Za-z0-9._]{2,24}$/.test(s) ? s.toLowerCase() : null;
}

const shortMsg = (e) => String(e?.message || e || 'unknown error').split('\n')[0].slice(0, 300);

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

/* ───────────────────────────── translation ───────────────────────────── */
// Free, no API key. Tries several public Google endpoints, then MyMemory.
// The endpoint that worked last is tried first.

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const enc = encodeURIComponent;

const ENDPOINTS = [
  {
    name: 'Google',
    url: (q, tl) => `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${enc(tl)}&dt=t&q=${enc(q)}`,
    parse: parseGoogleSingle,
  },
  {
    name: 'Google (clients5)',
    url: (q, tl) => `https://clients5.google.com/translate_a/t?client=dict-chrome-ex&sl=auto&tl=${enc(tl)}&q=${enc(q)}`,
    parse: parseGoogleDict,
  },
  {
    name: 'Google (translate.google.com)',
    url: (q, tl) => `https://translate.google.com/translate_a/single?client=gtx&sl=auto&tl=${enc(tl)}&dt=t&q=${enc(q)}`,
    parse: parseGoogleSingle,
  },
  {
    name: 'MyMemory',
    url: (q, tl) => `https://api.mymemory.translated.net/get?q=${enc(q)}&langpair=Autodetect|${enc(tl)}`,
    parse: parseMyMemory,
  },
];
const badUntil = new Array(ENDPOINTS.length).fill(0);
let preferred = 0;

const cache = new Map();
const CACHE_MAX = 1000;

export function parseGoogleSingle(body) {
  const d = JSON.parse(body);
  if (!Array.isArray(d) || !Array.isArray(d[0])) throw new Error('unexpected response');
  const text = d[0].map(s => (Array.isArray(s) && typeof s[0] === 'string') ? s[0] : '').join('').trim();
  if (!text) throw new Error('empty translation');
  return { text, src: typeof d[2] === 'string' ? d[2] : null };
}

export function parseGoogleDict(body) {
  const d = JSON.parse(body);
  let text = null, src = null;
  if (typeof d === 'string') text = d;
  else if (Array.isArray(d) && d.length) {
    if (typeof d[0] === 'string') text = d[0];
    else if (Array.isArray(d[0]) && typeof d[0][0] === 'string') { text = d[0][0]; if (typeof d[0][1] === 'string') src = d[0][1]; }
  } else if (d && Array.isArray(d.sentences)) {
    text = d.sentences.map(s => s.trans || '').join('');
    src = d.src || null;
  }
  if (!text || !text.trim()) throw new Error('empty translation');
  return { text: decodeEntities(text).trim(), src };
}

export function parseMyMemory(body) {
  const d = JSON.parse(body);
  const status = Number(d?.responseStatus ?? 200);
  if (status !== 200) throw new Error(`MyMemory ${status} ${d?.responseDetails || ''}`.trim());
  const text = decodeEntities(String(d?.responseData?.translatedText || '')).trim();
  if (!text) throw new Error('empty translation');
  if (/^(MYMEMORY WARNING|PLEASE SELECT)/i.test(text)) throw new Error('MyMemory: ' + text.slice(0, 120));
  return { text, src: d?.responseData?.detectedLanguage || null };
}

function decodeEntities(s) {
  return s.replace(/&(#x?[0-9a-f]+|amp|lt|gt|quot|apos|#39);/gi, (m, e) => {
    const k = e.toLowerCase();
    if (k === 'amp') return '&'; if (k === 'lt') return '<'; if (k === 'gt') return '>';
    if (k === 'quot') return '"'; if (k === 'apos' || k === '#39') return "'";
    if (k.startsWith('#x')) return String.fromCodePoint(parseInt(k.slice(2), 16));
    if (k.startsWith('#')) return String.fromCodePoint(parseInt(k.slice(1), 10));
    return m;
  });
}

async function translate(q, tl) {
  q = q.slice(0, 500);
  const key = tl + '\u0001' + q;
  if (cache.has(key)) return cache.get(key);

  if (MOCK_TRANSLATE) {
    const r = { text: `[${tl}] ${q}`, src: /[а-я]/i.test(q) ? 'ru' : 'en', engine: 'Mock' };
    cache.set(key, r);
    return r;
  }

  const now = Date.now();
  const order = ENDPOINTS.map((_, i) => (preferred + i) % ENDPOINTS.length)
    .sort((a, b) => (badUntil[a] > now) - (badUntil[b] > now));
  const errors = [];

  for (const i of order) {
    const ep = ENDPOINTS[i];
    try {
      const resp = await fetch(ep.url(q, tl), {
        headers: { 'User-Agent': UA, Accept: '*/*' },
        signal: AbortSignal.timeout(7000),
      });
      const body = await resp.text();
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const r = { ...ep.parse(body), engine: ep.name };
      preferred = i;
      badUntil[i] = 0;
      if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
      cache.set(key, r);
      return r;
    } catch (e) {
      badUntil[i] = Date.now() + 60_000;
      const why = e?.name === 'TimeoutError' ? 'timeout' : (shortMsg(e) + (e?.cause ? ' → ' + shortMsg(e.cause) : ''));
      errors.push(`${ep.name}: ${why}`);
    }
  }
  const err = new Error(errors.join(' | '));
  console.warn('  [translate] failed —', err.message);
  throw err;
}

/* ───────────────────────────── TikTok rooms ───────────────────────────── */
// One TikTok connection per username, shared by every open page watching it.

let TikTokLiveConnection, WebcastEvent, ControlEvent;
async function loadConnector() {
  if (TikTokLiveConnection || MOCK_TIKTOK) return;
  ({ TikTokLiveConnection, WebcastEvent, ControlEvent } = await import('tiktok-live-connector'));
}

const rooms = new Map();
let msgSeq = 0;

function classifyError(e) {
  const name = e?.constructor?.name || e?.name || '';
  const msg = shortMsg(e);
  if (/UserOffline/i.test(name) || /offline|not live|isn't live|LIVE has ended/i.test(msg)) return 'offline';
  if (/RateLimit/i.test(name) || /rate limit|too many/i.test(msg)) return 'rate_limit';
  if (/room ?id/i.test(msg)) return 'no_room';
  if (/InvalidUniqueId/i.test(name) || /user.*not.*found|unique.?id/i.test(msg)) return 'not_found';
  if (/PremiumFeature|Authenticated/i.test(name) || /age|restricted|18\+|login/i.test(msg)) return 'restricted';
  if (/ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|network|socket hang up|timeout/i.test(msg)) return 'network';
  return 'error';
}

class Room {
  constructor(user) {
    this.user = user;
    this.clients = new Set();
    this.recent = [];
    this.status = { state: 'connecting' };
    this.conn = null;
    this.closing = false;
    this.retry = 0;
    this.retryTimer = null;
    this.idleTimer = null;
  }

  broadcast(msg) {
    const line = `data: ${JSON.stringify(msg)}\n\n`;
    for (const res of this.clients) res.write(line);
  }

  setStatus(status) {
    this.status = status;
    this.broadcast({ type: 'status', ...status });
    console.log(`  [@${this.user}] ${status.state}${status.detail ? ' — ' + status.detail : ''}`);
  }

  pushChat(c) {
    const msg = { type: 'chat', id: ++msgSeq, ts: Date.now(), ...c };
    this.recent.push(msg);
    if (this.recent.length > RECENT_KEEP) this.recent.shift();
    this.broadcast(msg);
  }

  addClient(res) {
    clearTimeout(this.idleTimer);
    this.clients.add(res);
    res.write(`data: ${JSON.stringify({ type: 'status', ...this.status })}\n\n`);
    for (const m of this.recent) res.write(`data: ${JSON.stringify({ ...m, replay: true })}\n\n`);
  }

  removeClient(res) {
    this.clients.delete(res);
    if (this.clients.size === 0) {
      this.idleTimer = setTimeout(() => this.close(), IDLE_CLOSE_MS);
    }
  }

  async start() {
    if (this.closing) return;
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.setStatus({ state: this.retry ? 'reconnecting' : 'connecting' });
    if (MOCK_TIKTOK) return this.startMock();

    try {
      await loadConnector();
      const conn = new TikTokLiveConnection(this.user, {
        processInitialData: false,
        enableExtendedGiftInfo: false,
        ...(process.env.SIGN_API_KEY ? { signApiKey: process.env.SIGN_API_KEY } : {}),
      });
      this.conn = conn;

      conn.on(WebcastEvent.CHAT, (d) => {
        const text = String(d?.comment || '').trim();
        if (!text) return;
        this.pushChat({
          user: d?.user?.uniqueId || d?.user?.displayId || '',
          nick: d?.user?.nickname || '',
          text: text.slice(0, 500),
          lang: d?.contentLanguage || '',
        });
      });
      conn.on(WebcastEvent.STREAM_END, () => {
        this.setStatus({ state: 'ended' });
        this.stopConn();
      });
      conn.on(ControlEvent.DISCONNECTED, (info) => {
        if (this.closing || this.conn !== conn || this.status.state === 'ended') return;
        this.conn = null;
        this.scheduleRetry(`connection lost${info?.reason ? ' (' + info.reason + ')' : ''}`);
      });
      conn.on(ControlEvent.ERROR, (e) => {
        console.warn(`  [@${this.user}] error:`, shortMsg(e?.exception || e?.info || e));
      });

      const state = await conn.connect();
      if (this.closing) { this.stopConn(); return; }
      this.retry = 0;
      const title = state?.roomInfo?.title || state?.roomInfo?.data?.title || '';
      this.setStatus({ state: 'live', roomId: state?.roomId || '', title });
    } catch (e) {
      this.conn = null;
      const code = classifyError(e);
      const detail = shortMsg(e);
      if (code === 'offline' || code === 'not_found' || code === 'restricted') {
        this.setStatus({ state: 'error', code, detail });
        // Check again later — the streamer may go live while the page is open.
        if (code === 'offline') this.scheduleRetry(null, 30_000);
      } else {
        this.setStatus({ state: 'error', code, detail });
        this.scheduleRetry(null);
      }
    }
  }

  scheduleRetry(reason, fixedDelay) {
    if (this.closing || this.clients.size === 0) return;
    clearTimeout(this.retryTimer);
    const delay = fixedDelay ?? Math.min(60_000, 5_000 * 2 ** this.retry);
    this.retry++;
    if (reason) this.setStatus({ state: 'reconnecting', detail: reason });
    this.retryTimer = setTimeout(() => this.start(), delay);
  }

  stopConn() {
    const c = this.conn;
    this.conn = null;
    clearInterval(this.mockTimer);
    if (c) c.disconnect().catch(() => {});
  }

  close() {
    if (this.clients.size) return;
    this.closing = true;
    clearTimeout(this.retryTimer);
    this.stopConn();
    rooms.delete(this.user);
    console.log(`  [@${this.user}] closed (no open pages)`);
  }

  // Fake live for testing (MOCK_TIKTOK=1).
  startMock() {
    if (this.user === 'offline_user') {
      this.setStatus({ state: 'error', code: 'offline', detail: 'The requested user isn\'t online :(' });
      return;
    }
    this.retry = 0;
    this.setStatus({ state: 'live', roomId: '7400000000000000000', title: 'Mock live' });
    const lines = [
      ['maria.k', 'Maria', 'Привет! Откуда ты?'],
      ['john_doe', 'John', 'Hello from London, love the stream!'],
      ['ahmet34', 'Ahmet', 'Merhaba, nasılsın?'],
      ['lena.de', 'Lena', 'Wie heißt dieses Lied?'],
      ['emoji_fan', 'Emoji fan', '😂😂🔥'],
      ['ivan.bg', 'Иван', 'Здравей от Крумовград!'],
    ];
    let i = 0;
    this.mockTimer = setInterval(() => {
      const [user, nick, text] = lines[i++ % lines.length];
      this.pushChat({ user, nick, text, lang: '' });
    }, Number(process.env.MOCK_INTERVAL) || 1500);
  }
}

/* ───────────────────────────── HTTP ───────────────────────────── */

const PUBLIC = path.join(DIR, 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  const file = path.normalize(path.join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const q = url.searchParams;

    if (url.pathname === '/events') {
      const user = normalizeUser(q.get('user'));
      if (!user) return json(res, 400, { ok: false, code: 'bad_user' });

      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-store',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.write('retry: 3000\n\n');

      let room = rooms.get(user);
      const isNew = !room;
      if (isNew) { room = new Room(user); rooms.set(user, room); }
      room.addClient(res);
      if (isNew) room.start();
      else if (room.status.state === 'error' && !room.retryTimer) room.start();

      const ping = setInterval(() => res.write(': ping\n\n'), 15_000);
      req.on('close', () => { clearInterval(ping); room.removeClient(res); });
      return;
    }

    if (url.pathname === '/translate') {
      const text = (q.get('q') || '').trim();
      const tl = (q.get('tl') || 'en').slice(0, 10);
      if (!text) return json(res, 400, { ok: false, error: 'empty text' });
      try {
        const r = await translate(text, tl);
        return json(res, 200, { ok: true, ...r });
      } catch (e) {
        return json(res, 200, { ok: false, error: shortMsg(e) });
      }
    }

    if (url.pathname === '/health') return json(res, 200, { ok: true, rooms: [...rooms.keys()], mock: MOCK_TIKTOK });

    if (req.method === 'GET') return serveStatic(req, res, url.pathname);
    res.writeHead(405); res.end();
  } catch (e) {
    if (!res.headersSent) json(res, 500, { ok: false, error: shortMsg(e) });
    else res.end();
  }
});

process.on('unhandledRejection', (e) => console.warn('  [warn]', shortMsg(e)));
process.on('uncaughtException', (e) => console.warn('  [warn]', shortMsg(e)));

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`\n  Port ${PORT} is already in use. Close the other window running the translator,`);
    console.error(`  or set a different PORT in the .env file.\n`);
    process.exit(1);
  }
  throw e;
});

server.listen(PORT, HOST, () => {
  const url = `http://localhost:${PORT}`;
  console.log(`\n  TikTok LIVE Chat Translator is running → ${url}`);
  console.log('  Keep this window open while you use the page.\n');
  if (HOST === '0.0.0.0' || HOST === '::') {
    const lan = Object.values(os.networkInterfaces()).flat()
      .filter(i => i && i.family === 'IPv4' && !i.internal).map(i => `http://${i.address}:${PORT}`);
    if (lan.length) console.log('  On your phone (same Wi-Fi) open: ' + lan.join('  or  ') + '\n');
  }
  if (MOCK_TIKTOK) console.log('  (MOCK_TIKTOK=1 — fake chat for testing)\n');
  if (process.env.OPEN_BROWSER === '1') {
    const cmd = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
      : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
    try { spawn(cmd[0], cmd[1], { detached: true, stdio: 'ignore', windowsHide: true }).on('error', () => {}).unref(); } catch { }
  }
});
