// TechnoLounge 2026 — booth timer server.
// Local:  node server.js  (or start.bat) — saves to data.json, open on any device on the same Wi-Fi.
// Online: set DATABASE_URL (Postgres) and ACCESS_CODE — see render.yaml / README.md.
process.env.TZ = process.env.TZ || 'Asia/Manila'; // booth times are Philippine time, even on UTC servers

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data.json');
const INDEX_FILE = path.join(__dirname, 'public', 'index.html');
const DATABASE_URL = process.env.DATABASE_URL;
const ACCESS_CODE = (process.env.ACCESS_CODE || '').trim(); // empty = no lock (local Wi-Fi use)
const PASSES = { KB: 15, MB: 30, GB: 60 }; // minutes
const PRICES = { KB: 20, MB: 30, GB: 40, VR: 15 }; // pesos (VR = VR Roller Coaster add-on)

// ---------- Storage: Postgres when DATABASE_URL is set, otherwise data.json ----------
let db = null;
let sessions = [];

async function loadData() {
  if (DATABASE_URL) {
    const { Pool } = require('pg');
    // Render's external URLs need SSL; its internal URLs (same region) don't.
    db = new Pool({ connectionString: DATABASE_URL, ssl: /\.render\.com/.test(DATABASE_URL) ? { rejectUnauthorized: false } : undefined });
    await db.query('CREATE TABLE IF NOT EXISTS app_state (id INT PRIMARY KEY, data JSONB NOT NULL)');
    const r = await db.query('SELECT data FROM app_state WHERE id = 1');
    return (r.rows[0] && r.rows[0].data) || [];
  }
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch { return []; }
}

let saveChain = Promise.resolve(); // writes run one at a time, in order
function save() {
  const snapshot = JSON.stringify(sessions, null, db ? 0 : 2);
  const run = saveChain.then(() => (db
    ? db.query('INSERT INTO app_state (id, data) VALUES (1, $1::jsonb) ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data', [snapshot])
    : fs.promises.writeFile(DATA_FILE, snapshot)));
  saveChain = run.catch(() => {});
  return run;
}

const toRides = (n) => Math.max(0, Math.min(99, Math.floor(Number(n) || 0)));
function migrate(list) {
  for (const s of list) { // old yes/no VR field -> ride count
    if ('vr' in s) { s.vrRides = s.vr ? 1 : 0; delete s.vr; }
    s.vrRides = s.vrRides || 0;
  }
  return list;
}

// ---------- Access code ----------
const hash = (v) => crypto.createHash('sha256').update('technolounge:' + v).digest('hex');
const TOKEN = ACCESS_CODE ? hash(ACCESS_CODE) : null;
const COOKIE = 'tl_auth';
const failures = new Map(); // ip -> { count, since }

const sameHex = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
function isAuthed(req) {
  if (!TOKEN) return true;
  const m = (req.headers.cookie || '').match(new RegExp(`(?:^|;\\s*)${COOKIE}=([a-f0-9]{64})`));
  return !!m && sameHex(m[1], TOKEN);
}
const clientIp = (req) => String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
function cookie(req, value, maxAge) {
  const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
  return `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

// ---------- HTTP ----------
function send(res, code, body, type = 'application/json', headers = {}) {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', ...headers });
  res.end(type === 'application/json' ? JSON.stringify(body) : body);
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => { raw += c; if (raw.length > 1e5) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(raw || '{}')); } catch { resolve({}); } });
  });
}

const list = () => ({ now: Date.now(), passes: PASSES, prices: PRICES, authRequired: !!TOKEN, sessions });

async function handle(req, res) {
  const url = new URL(req.url, 'http://x');
  const parts = url.pathname.split('/').filter(Boolean); // ['api','sessions',id,action]

  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    return send(res, 200, fs.readFileSync(INDEX_FILE), 'text/html; charset=utf-8');
  }
  if (url.pathname === '/healthz') return send(res, 200, 'ok', 'text/plain');

  if (req.method === 'POST' && url.pathname === '/api/login') {
    const ip = clientIp(req), f = failures.get(ip);
    if (f && Date.now() - f.since > 15 * 60000) failures.delete(ip);
    if (f && f.count >= 10 && failures.has(ip)) return send(res, 429, { error: 'Too many wrong tries. Wait 15 minutes.' });
    const { code } = await readBody(req);
    if (!TOKEN || sameHex(hash(String(code || '').trim()), TOKEN)) {
      failures.delete(ip);
      return send(res, 200, { ok: true }, 'application/json', { 'Set-Cookie': cookie(req, TOKEN || '', 30 * 86400) });
    }
    const cur = failures.get(ip) || { count: 0, since: Date.now() };
    cur.count++; failures.set(ip, cur);
    return send(res, 401, { error: 'Wrong access code' });
  }
  if (req.method === 'POST' && url.pathname === '/api/logout') {
    return send(res, 200, { ok: true }, 'application/json', { 'Set-Cookie': cookie(req, '', 0) });
  }

  if (parts[0] !== 'api' || parts[1] !== 'sessions') return send(res, 404, { error: 'Not found' });
  if (!isAuthed(req)) return send(res, 401, { error: 'locked' });

  if (req.method === 'GET' && parts.length === 2) return send(res, 200, list());

  // Create a new entry
  if (req.method === 'POST' && parts.length === 2) {
    const { name, date, timeIn, pass, vrRides } = await readBody(req);
    if (!name || !String(name).trim()) return send(res, 400, { error: 'Name is required' });
    if (!PASSES[pass]) return send(res, 400, { error: 'Invalid package' });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '') || !/^\d{2}:\d{2}$/.test(timeIn || '')) {
      return send(res, 400, { error: 'Invalid date or time' });
    }
    const startAt = new Date(`${date}T${timeIn}:00`).getTime(); // Philippine time (TZ above)
    if (Number.isNaN(startAt)) return send(res, 400, { error: 'Invalid date or time' });
    const s = {
      id: crypto.randomUUID(),
      name: String(name).trim().slice(0, 80),
      date, timeIn, pass,
      startAt,
      endAt: startAt + PASSES[pass] * 60000,
      extensions: [],
      vrRides: toRides(vrRides), // number of VR Roller Coaster add-on rides
      closed: false,
      outcome: null,        // 'left' | 'ended-early'
      bandReturned: null,   // true | false
      closedAt: null,
      createdAt: Date.now(),
    };
    sessions.push(s); await save();
    return send(res, 201, list());
  }

  const s = sessions.find((x) => x.id === parts[2]);
  if (!s) return send(res, 404, { error: 'Entry not found' });

  if (req.method === 'DELETE' && parts.length === 3) {
    sessions = sessions.filter((x) => x !== s); await save();
    return send(res, 200, list());
  }

  if (req.method === 'POST' && parts.length === 4) {
    const body = await readBody(req);
    const now = Date.now();
    switch (parts[3]) {
      case 'extend': { // add another pass, starting now (or from current end if still running)
        if (!PASSES[body.pass]) return send(res, 400, { error: 'Invalid package' });
        const from = Math.max(now, s.endAt);
        s.endAt = from + PASSES[body.pass] * 60000;
        s.extensions.push({ pass: body.pass, at: now });
        s.closed = false; s.outcome = null; s.bandReturned = null; s.closedAt = null;
        break;
      }
      case 'leave': // person leaves the lounge (at time-up or early)
        s.closed = true;
        s.outcome = now < s.endAt ? 'ended-early' : 'left';
        s.bandReturned = !!body.bandReturned;
        s.closedAt = now;
        break;
      case 'vr': // add (+1) or remove (-1) a VR Roller Coaster ride
        s.vrRides = toRides(s.vrRides + (Number(body.delta) || 0));
        break;
      case 'band-returned':
        s.bandReturned = true;
        break;
      default:
        return send(res, 404, { error: 'Unknown action' });
    }
    await save();
    return send(res, 200, list());
  }

  send(res, 405, { error: 'Method not allowed' });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    console.error(err);
    if (!res.headersSent) send(res, 500, { error: 'Server error — the change may not have been saved.' });
  });
});

loadData().then((data) => {
  sessions = migrate(Array.isArray(data) ? data : []);
  server.listen(PORT, '0.0.0.0', () => {
    console.log('\n  TechnoLounge 2026 is running!\n');
    console.log(`  Storage:         ${db ? 'Postgres database' : 'data.json'}   Access code: ${TOKEN ? 'ON' : 'off'}`);
    console.log(`  This computer:   http://localhost:${PORT}`);
    for (const addrs of Object.values(os.networkInterfaces())) {
      for (const a of addrs || []) {
        if (a.family === 'IPv4' && !a.internal) console.log(`  Other devices:   http://${a.address}:${PORT}`);
      }
    }
    console.log('\n  (Devices must be on the same Wi-Fi / hotspot. Press Ctrl+C to stop.)\n');
  });
}).catch((err) => {
  console.error('Could not load saved data:', err);
  process.exit(1);
});
