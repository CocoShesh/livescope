import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

function loadDotEnv() {
  const file = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.env');
  try {
    const text = fs.readFileSync(file, 'utf8');
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const idx = line.indexOf('=');
      if (idx < 1) continue;
      const key = line.slice(0, idx).trim();
      let value = line.slice(idx + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
      if (!(key in process.env)) process.env[key] = value;
    }
  } catch {}
}
loadDotEnv();

const app = express();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, '..', 'public');
const port = Number(process.env.PORT || 8787);

app.use(express.json({ limit: '32kb' }));
app.get('/', (_req, res) => res.sendFile(path.join(publicDir, 'home.html')));
app.get('/monitor', (_req, res) => res.sendFile(path.join(publicDir, 'index.html')));
app.use(express.static(publicDir));

function cleanUsername(input) {
  let value = String(input || '').trim();
  value = value.replace(/^https?:\/\//i, '').replace(/^www\./i, '');
  value = value.split('?')[0].split('#')[0];
  if (value.includes('tiktok.com/@')) value = value.split('tiktok.com/@')[1];
  value = value.replace(/^@/, '').split('/')[0];
  if (!/^[A-Za-z0-9._-]{1,50}$/.test(value)) return null;
  return value;
}

function proxyUrlFor(sourceUrl) { return `/api/hls?url=${encodeURIComponent(sourceUrl)}`; }
function allowedStreamHost(hostname) {
  const host = String(hostname || '').toLowerCase();
  return [/(^|\.)tiktokcdn\.com$/,/(^|\.)tiktokv\.com$/,/(^|\.)ibytedtos\.com$/,/(^|\.)ttlivecdn\.com$/,/(^|\.)bytecdn\.com$/].some(re => re.test(host));
}
function rewriteM3u8(body, sourceUrl) {
  const base = new URL(sourceUrl);
  const absolutize = value => { try { return new URL(value, base).toString(); } catch { return value; } };
  const proxy = value => {
    const absolute = absolutize(value);
    try { if (!allowedStreamHost(new URL(absolute).hostname)) return absolute; } catch {}
    return proxyUrlFor(absolute);
  };
  let out = body.replace(/URI="([^"]+)"/g, (_m, uri) => `URI="${proxy(uri)}"`);
  return out.split(/\r?\n/).map(line => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return line;
    return proxy(trimmed);
  }).join('\n');
}

const TIKTOK_HEADERS = {
  'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36',
  'accept-language': 'en-US,en;q=0.9',
  'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'referer': 'https://www.tiktok.com/'
};

function findRoomId(html) {
  const text = String(html || '');
  const patterns = [
    /["']roomId["']\s*:\s*["'](\d{10,})["']/g,
    /["']room_id["']\s*:\s*["']?(\d{10,})["']?/g,
    /snssdk\d*:\/\/live\?room_id=(\d{10,})/g,
    /room_id=(\d{10,})/g
  ];
  for (const re of patterns) {
    const match = re.exec(text);
    if (match?.[1]) return match[1];
  }
  return '';
}
function firstUrl(...values) { for (const value of values) if (typeof value === 'string' && /^https?:\/\//i.test(value)) return value; return ''; }
function pickHls(data) {
  return firstUrl(data?.stream_url?.hls_pull_url, data?.stream_url?.hls_pull_url?.ORIGION, data?.stream_url?.hls_pull_url_params, data?.liveUrl);
}
async function getLiveInfo(username) {
  const livePage = `https://www.tiktok.com/@${encodeURIComponent(username)}/live`;
  const pageResponse = await fetch(livePage, { headers: TIKTOK_HEADERS, redirect: 'follow' });
  const html = await pageResponse.text();
  if (!pageResponse.ok) throw new Error(`TikTok page request failed: ${pageResponse.status}`);
  const roomId = findRoomId(html);
  if (!roomId) return { username, live: false, status: 'NO_ROOM_ID', roomId: '', streamUrl: '', viewerCount: 0, title: '', note: 'TikTok page did not expose a live room ID to this server.' };
  const apiUrl = new URL('https://webcast.tiktok.com/webcast/room/info');
  apiUrl.searchParams.set('aid', '1988'); apiUrl.searchParams.set('room_id', roomId);
  const apiResponse = await fetch(apiUrl, { headers: { ...TIKTOK_HEADERS, accept: 'application/json,text/plain,*/*', referer: livePage }, redirect: 'follow' });
  const payload = await apiResponse.json().catch(() => ({}));
  if (!apiResponse.ok) throw new Error(`TikTok room-info request failed: ${apiResponse.status}`);
  const data = payload?.data || {};
  const streamUrl = pickHls(data);
  const viewerCount = Number(data?.user_count ?? data?.liveRoomStats?.userCount ?? 0) || 0;
  const title = String(data?.title || '');
  const statusValue = Number(data?.status);
  // Treat a LIVE as playable only when TikTok exposes a current playback URL.
  // A stale room/status flag without a stream URL must not leave the tile stuck on LIVE.
  const live = Boolean(streamUrl);
  return { username, live, status: live ? 'LIVE' : 'OFFLINE', roomId, streamUrl, viewerCount, title, rawStatus: Number.isFinite(statusValue) ? statusValue : null };
}

// HLS proxy used by the browser player.
app.get('/api/hls', async (req, res) => {
  try {
    const raw = String(req.query.url || '');
    const u = new URL(raw);
    if (!allowedStreamHost(u.hostname)) return res.status(403).send('Stream host not allowed');
    const upstream = await fetch(u, { headers: { ...TIKTOK_HEADERS, accept: '*/*' } });
    const ct = upstream.headers.get('content-type') || '';
    if (!upstream.ok) return res.status(upstream.status).send(`Upstream stream failed: ${upstream.status}`);
    if (/mpegurl/i.test(ct) || /\.m3u8(?:$|\?)/i.test(u.pathname)) {
      const body = await upstream.text();
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      res.setHeader('Cache-Control', 'no-store');
      return res.send(rewriteM3u8(body, raw));
    }
    res.setHeader('Content-Type', ct || 'application/octet-stream');
    res.setHeader('Cache-Control', 'no-store');
    return res.send(Buffer.from(await upstream.arrayBuffer()));
  } catch (error) {
    return res.status(400).send(String(error?.message || error));
  }
});

app.post('/api/live/resolve', async (req, res) => {
  const username = cleanUsername(req.body?.username);
  if (!username) return res.status(400).json({ error: 'Invalid username.' });
  try { return res.json(await getLiveInfo(username)); }
  catch (error) { return res.status(502).json({ error: String(error?.message || error), username }); }
});

// ---------------- Euler Stream realtime All Chat bridge ----------------
// The API key stays server-side in EULERSTREAM_API_KEY (or .env).
const eulerConnections = new Map();
const chatClients = new Set();
const CHAT_RECONNECT_MS = 5000;

function chatBroadcast(event) {
  const payload = { ...event, timestamp: event.timestamp || Date.now() };
  const line = `data: ${JSON.stringify(payload)}\n\n`;
  for (const res of chatClients) {
    try { res.write(line); } catch { chatClients.delete(res); }
  }
}
function nested(obj, path) { let cur = obj; for (const p of path) { if (cur == null) return undefined; cur = cur[p]; } return cur; }
function firstDefined(obj, paths, fallback = '') { for (const p of paths) { const v = nested(obj, p); if (v !== undefined && v !== null && v !== '') return v; } return fallback; }
function classifyMessage(msg) {
  const kind = String(firstDefined(msg, [['type'], ['eventType'], ['event'], ['kind']], '')).toLowerCase();
  if (kind.includes('gift')) return 'gift';
  if (kind.includes('like')) return 'like';
  if (kind.includes('join') || kind.includes('member')) return 'join';
  if (kind.includes('follow') || kind.includes('share') || kind.includes('social')) return 'social';
  if (kind.includes('chat') || kind.includes('comment')) return 'chat';
  const comment = firstDefined(msg, [['comment'], ['text'], ['message'], ['data','comment']], '');
  return comment ? 'chat' : (kind || 'system');
}
function scalarText(value) {
  if (value == null) return '';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value === 'object') {
    for (const key of ['text','content','message','comment','name','value']) {
      if (value[key] != null && (typeof value[key] === 'string' || typeof value[key] === 'number')) return String(value[key]);
    }
    return '';
  }
  return '';
}
function firstText(obj, paths, fallback = '') {
  for (const p of paths) { const value = scalarText(nested(obj, p)); if (value) return value; }
  return fallback;
}
function normalizeEulerMessage(source, msg) {
  const data = msg?.data && typeof msg.data === 'object' ? msg.data : msg;
  const type = classifyMessage(data);
  const user = firstText(data, [['uniqueId'], ['unique_id'], ['user','uniqueId'], ['user','unique_id'], ['user','username']], 'viewer');
  const nickname = firstText(data, [['nickname'], ['user','nickname'], ['user','displayName'], ['user','display_name']], '');
  let comment = firstText(data, [['comment','text'], ['comment','content'], ['comment'], ['text'], ['message'], ['content'], ['user','comment','text'], ['user','comment']], '');
  if (type === 'chat' && !comment) return null;
  if (!comment && type === 'gift') comment = `${firstText(data,[['giftName'],['gift','name']], 'Gift')} ×${firstText(data,[['repeatCount'],['count']], '1')}`;
  if (!comment && type === 'like') comment = `liked ×${firstText(data,[['count'],['likeCount']], '1')}`;
  if (!comment && type === 'join') comment = 'joined the LIVE';
  if (!comment && type === 'social') comment = firstText(data,[['action'],['event']], 'social event');
  return { type, source, user, nickname, comment, rawType: firstText(data,[['type'],['eventType'],['event']], '') };
}
function handleEulerPayload(source, payload) {
  const messages = Array.isArray(payload?.messages) ? payload.messages : (payload?.message ? [payload.message] : []);
  if (!messages.length && payload?.type && (payload.comment || payload.text || payload.data)) messages.push(payload);
  for (const msg of messages) { const normalized = normalizeEulerMessage(source, msg); if (normalized) chatBroadcast(normalized); }
}
function openEuler(username) {
  const key = username.toLowerCase();
  if (eulerConnections.has(key)) return;
  const apiKey = String(process.env.EULERSTREAM_API_KEY || '').trim();
  if (!apiKey) {
    chatBroadcast({ type: 'system', source: username, comment: 'All Chat needs EULERSTREAM_API_KEY on the server.' });
    return;
  }
  let stopped = false;
  let reconnectTimer = null;
  const connect = () => {
    if (stopped) return;
    const url = new URL('wss://ws.eulerstream.com/');
    url.searchParams.set('uniqueId', username);
    url.searchParams.set('apiKey', apiKey);
    url.searchParams.set('schemaVersion', 'v1');
    url.searchParams.set('features.bundleEvents', 'true');
    url.searchParams.set('features.rawMessages', 'false');
    url.searchParams.set('features.normalizeUniqueId', 'true');
    url.searchParams.set('features.syntheticPresence', 'true');
    let ws;
    try { ws = new WebSocket(url); }
    catch (error) { chatBroadcast({ type:'system', source:username, comment:`Euler WebSocket error: ${error.message}` }); return; }
    const rec = eulerConnections.get(key) || { ws:null, stopped:false };
    rec.ws = ws; eulerConnections.set(key, rec);
    ws.onopen = () => chatBroadcast({ type:'status', source:username, status:'connected', comment:'Euler chat connected' });
    ws.onmessage = event => {
      try { handleEulerPayload(username, JSON.parse(String(event.data))); }
      catch (error) { chatBroadcast({ type:'system', source:username, comment:`Invalid Euler message: ${error.message}` }); }
    };
    ws.onerror = () => chatBroadcast({ type:'status', source:username, status:'error', comment:'Euler chat connection error' });
    ws.onclose = () => {
      chatBroadcast({ type:'status', source:username, status:'disconnected', comment:'Euler chat disconnected' });
      if (!stopped) reconnectTimer = setTimeout(connect, CHAT_RECONNECT_MS);
    };
  };
  const rec = { ws:null, stopped:false, close:()=>{stopped=true; if(reconnectTimer)clearTimeout(reconnectTimer); try{rec.ws?.close()}catch{} eulerConnections.delete(key); } };
  eulerConnections.set(key, rec);
  connect();
}
function closeEuler(username) { const key = username.toLowerCase(); const rec = eulerConnections.get(key); if (rec) rec.close(); }

app.get('/api/chat/events', (req, res) => {
  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();
  res.write(`retry: 3000\n\n`);
  chatClients.add(res);
  req.on('close', () => chatClients.delete(res));
});
app.post('/api/chat/connect', (req, res) => {
  const username = cleanUsername(req.body?.username);
  if (!username) return res.status(400).json({ error:'Invalid username.' });
  if (!process.env.EULERSTREAM_API_KEY) return res.status(503).json({ error:'EULERSTREAM_API_KEY is not configured on the server.' });
  openEuler(username);
  return res.json({ ok:true, username, transport:'euler-websocket' });
});
app.post('/api/chat/disconnect', (req, res) => {
  const username = cleanUsername(req.body?.username);
  if (username) closeEuler(username);
  res.json({ ok:true });
});

app.get('/api/tools', (_req,res)=>res.json({service:'livescope',liveResolver:'ready',chat:true,chatTransport:'euler-websocket',chatConfigured:Boolean(process.env.EULERSTREAM_API_KEY)}));
app.get('/health', (_req,res)=>res.json({ok:true,service:'livescope',version:'1.8.0',liveResolver:'ready',chat:true,chatTransport:'euler-websocket',chatConfigured:Boolean(process.env.EULERSTREAM_API_KEY)}));

if (!process.env.VERCEL) {
  app.listen(port, () => console.log(`LiveScope v1.8 running at http://localhost:${port}`));
}

export default app;
