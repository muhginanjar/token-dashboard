// Token usage dashboard — zero dependencies, Node >= 20.
//
// Two data sources, both pushed to the browser over Server-Sent Events:
//   1. Poller: asks OpenRouter's /key endpoint for the key's spend every POLL_MS.
//   2. Proxy:  /proxy/* forwards OpenAI-compatible requests to UPSTREAM_BASE and
//              records token counts per request, so any provider can be tracked live.

import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
try { process.loadEnvFile(path.join(ROOT, '.env')); } catch {}

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '127.0.0.1';
const API_KEY = process.env.API_KEY || process.env.OPENROUTER_API_KEY || '';
const PROVIDER = (process.env.PROVIDER || 'openrouter').toLowerCase();
const POLL_MS = Math.max(2000, Number(process.env.POLL_MS || 5000));
const UPSTREAM_BASE = (process.env.UPSTREAM_BASE || 'https://openrouter.ai/api').replace(/\/$/, '');
// Basic auth is on whenever AUTH_PASSWORD is set.
const AUTH_USER = process.env.AUTH_USER || 'admin';
const AUTH_PASSWORD = process.env.AUTH_PASSWORD || '';
const DATA_FILE = path.join(ROOT, 'data', 'history.json');
const MAX_SNAPSHOTS = 2000;
const MAX_REQUESTS = 500;

// ---------- auth ----------

// Hash first so timingSafeEqual gets equal-length buffers and length isn't leaked.
function safeEqual(a, b) {
  const h = (s) => crypto.createHash('sha256').update(s).digest();
  return crypto.timingSafeEqual(h(a), h(b));
}

function basicAuthOk(header) {
  const m = /^Basic\s+(\S+)$/i.exec(header || '');
  if (!m) return false;
  const decoded = Buffer.from(m[1], 'base64').toString();
  const i = decoded.indexOf(':');
  if (i < 0) return false;
  // Bitwise & so both comparisons always run.
  return Boolean(safeEqual(decoded.slice(0, i), AUTH_USER) & safeEqual(decoded.slice(i + 1), AUTH_PASSWORD));
}

// Proxy clients are SDKs that only know how to send an API key, so they may
// authenticate with the password as their key (Bearer or x-api-key) as well.
function proxyAuthOk(headers) {
  if (basicAuthOk(headers.authorization)) return true;
  const bearer = /^Bearer\s+(.+)$/i.exec(headers.authorization || '')?.[1];
  const key = bearer ?? headers['x-api-key'];
  return key != null && safeEqual(key, AUTH_PASSWORD);
}

// ---------- state ----------

const state = {
  provider: PROVIDER,
  pollMs: POLL_MS,
  key: null,          // latest key info from the provider
  error: null,
  lastPoll: null,
  snapshots: [],      // [{t, usage}] — only appended when usage changes
  requests: [],       // [{t, model, prompt, completion, total, cost, ms, status}]
};

try {
  const saved = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  state.snapshots = saved.snapshots || [];
  state.requests = saved.requests || [];
} catch {}

let saveTimer = null;
function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    fs.writeFile(DATA_FILE, JSON.stringify({ snapshots: state.snapshots, requests: state.requests }), () => {});
  }, 2000);
}

function pushCapped(arr, item, max) {
  arr.push(item);
  if (arr.length > max) arr.splice(0, arr.length - max);
}

// ---------- SSE ----------

const clients = new Set();

function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) res.write(msg);
}

setInterval(() => { for (const res of clients) res.write(': ping\n\n'); }, 25000);

// ---------- provider poller ----------

const providers = {
  // https://openrouter.ai/docs/api-reference/api-keys/get-current-key
  async openrouter() {
    const r = await fetch((process.env.OPENROUTER_BASE || 'https://openrouter.ai/api') + '/v1/key', {
      headers: { Authorization: `Bearer ${API_KEY}` },
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) throw new Error(`OpenRouter ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const d = (await r.json()).data || {};
    return {
      label: d.label,
      usage: d.usage ?? 0,
      daily: d.usage_daily ?? null,
      weekly: d.usage_weekly ?? null,
      monthly: d.usage_monthly ?? null,
      limit: d.limit ?? null,
      remaining: d.limit_remaining ?? null,
      limitReset: d.limit_reset ?? null,
      freeTier: !!d.is_free_tier,
    };
  },
  // No balance API: dashboard runs purely off the proxy.
  async none() { return null; },
};

async function poll() {
  const fn = providers[PROVIDER];
  if (!fn) { state.error = `Unknown PROVIDER "${PROVIDER}"`; return; }
  if (PROVIDER !== 'none' && !API_KEY) { state.error = 'API_KEY is not set (see .env.example)'; broadcast('status', status()); return; }
  try {
    const key = await fn();
    state.key = key;
    state.error = null;
    state.lastPoll = Date.now();
    if (key) {
      const last = state.snapshots.at(-1);
      if (!last || last.usage !== key.usage) {
        const snap = { t: state.lastPoll, usage: key.usage };
        pushCapped(state.snapshots, snap, MAX_SNAPSHOTS);
        broadcast('snapshot', snap);
        scheduleSave();
      }
    }
  } catch (e) {
    state.error = e.message;
  }
  broadcast('status', status());
}

function status() {
  return { provider: state.provider, pollMs: state.pollMs, key: state.key, error: state.error, lastPoll: state.lastPoll };
}

// Only poll while someone is watching — keeps it light.
let pollTimer = null;
function startPolling() {
  if (pollTimer) return;
  poll();
  pollTimer = setInterval(poll, POLL_MS);
}
function stopPolling() {
  clearInterval(pollTimer);
  pollTimer = null;
}

// ---------- proxy ----------

function extractUsage(u) {
  if (!u) return null;
  const prompt = u.prompt_tokens ?? u.input_tokens ?? 0;
  const completion = u.completion_tokens ?? u.output_tokens ?? 0;
  return { prompt, completion, total: u.total_tokens ?? prompt + completion, cost: u.cost ?? null };
}

async function proxy(req, res, upstreamPath) {
  const started = Date.now();
  const chunks = [];
  for await (const c of req) chunks.push(c);
  let body = Buffer.concat(chunks);

  let model = null;
  if (body.length && (req.headers['content-type'] || '').includes('json')) {
    try {
      const json = JSON.parse(body);
      model = json.model ?? null;
      // Ask OpenAI-compatible upstreams to include usage in the final stream chunk.
      if (json.stream && !json.stream_options && upstreamPath.includes('/chat/completions')) {
        json.stream_options = { include_usage: true };
        body = Buffer.from(JSON.stringify(json));
      }
    } catch {}
  }

  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (!['host', 'connection', 'content-length', 'accept-encoding'].includes(k)) headers[k] = v;
  }
  if (AUTH_PASSWORD) {
    // The client's credential was the dashboard password — never forward it upstream.
    delete headers.authorization;
    delete headers['x-api-key'];
    if (API_KEY) headers.authorization = `Bearer ${API_KEY}`;
  } else if (!headers.authorization && !headers['x-api-key'] && API_KEY) {
    // Inject the dashboard's key unless the client brought its own.
    headers.authorization = `Bearer ${API_KEY}`;
  }

  let upstream;
  try {
    upstream = await fetch(UPSTREAM_BASE + upstreamPath, {
      method: req.method,
      headers,
      body: ['GET', 'HEAD'].includes(req.method) ? undefined : body,
    });
  } catch (e) {
    res.writeHead(502, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ error: { message: `Upstream error: ${e.message}` } }));
  }

  const outHeaders = {};
  upstream.headers.forEach((v, k) => {
    if (!['content-encoding', 'content-length', 'transfer-encoding', 'connection'].includes(k)) outHeaders[k] = v;
  });
  res.writeHead(upstream.status, outHeaders);

  // Stream through while keeping a rolling view of the text to find `usage`.
  const isSSE = (upstream.headers.get('content-type') || '').includes('event-stream');
  const decoder = new TextDecoder();
  let usage = null, tail = '', full = '';
  if (upstream.body) {
    for await (const chunk of upstream.body) {
      res.write(chunk);
      const text = decoder.decode(chunk, { stream: true });
      if (isSSE) {
        tail += text;
        const lines = tail.split('\n');
        tail = lines.pop();
        for (const line of lines) {
          if (!line.startsWith('data:') || !line.includes('"usage"')) continue;
          try {
            const ev = JSON.parse(line.slice(5));
            const u = ev.usage || ev.message?.usage;
            if (u) usage = { ...usage, ...u };
            if (!model && ev.model) model = ev.model;
          } catch {}
        }
      } else if (full.length < 5_000_000) {
        full += text;
      }
    }
  }
  res.end();

  if (!isSSE && full) {
    try {
      const json = JSON.parse(full);
      usage = json.usage;
      model = json.model || model;
    } catch {}
  }

  const u = extractUsage(usage);
  if (!u) return; // e.g. /models — nothing to record
  const record = { t: Date.now(), model, ...u, ms: Date.now() - started, status: upstream.status };
  pushCapped(state.requests, record, MAX_REQUESTS);
  broadcast('request', record);
  scheduleSave();
  // Spend changed — refresh balance right away instead of waiting for the next tick.
  if (pollTimer) setTimeout(poll, 1500);
}

// ---------- http ----------

const indexHtml = () => fs.readFileSync(path.join(ROOT, 'public', 'index.html'));

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');

  if (url.pathname.startsWith('/proxy/')) {
    if (AUTH_PASSWORD && !proxyAuthOk(req.headers)) {
      res.writeHead(401, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: 'Unauthorized: use the dashboard password as your API key' } }));
    }
    return proxy(req, res, url.pathname.slice('/proxy'.length) + url.search);
  }

  if (AUTH_PASSWORD && !basicAuthOk(req.headers.authorization)) {
    res.writeHead(401, { 'www-authenticate': 'Basic realm="Token Dashboard", charset="UTF-8"' });
    return res.end('Unauthorized');
  }

  if (url.pathname === '/events') {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    res.write(`event: init\ndata: ${JSON.stringify({ ...status(), snapshots: state.snapshots, requests: state.requests })}\n\n`);
    clients.add(res);
    startPolling();
    req.on('close', () => {
      clients.delete(res);
      if (clients.size === 0) stopPolling();
    });
    return;
  }

  if (url.pathname === '/api/reset' && req.method === 'POST') {
    state.snapshots = state.key ? [{ t: Date.now(), usage: state.key.usage }] : [];
    state.requests = [];
    scheduleSave();
    broadcast('init', { ...status(), snapshots: state.snapshots, requests: state.requests });
    res.writeHead(204);
    return res.end();
  }

  if (url.pathname === '/' || url.pathname === '/index.html') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(indexHtml());
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, HOST, () => {
  console.log(`Dashboard  → http://${HOST}:${PORT}`);
  console.log(`Proxy      → http://${HOST}:${PORT}/proxy  (upstream ${UPSTREAM_BASE})`);
  console.log(`Provider   → ${PROVIDER}, polling every ${POLL_MS / 1000}s${API_KEY ? '' : '  ⚠ API_KEY is empty'}`);
  console.log(`Auth       → ${AUTH_PASSWORD ? `basic auth on (user "${AUTH_USER}")` : 'off'}`);
  if (!AUTH_PASSWORD && !['127.0.0.1', 'localhost', '::1'].includes(HOST)) {
    console.warn('⚠ Listening on a non-local address without AUTH_PASSWORD — anyone on the network can use your key through the proxy.');
  }
});
