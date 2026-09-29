// TechnoLounge 2026 — tiny LAN server (no dependencies).
// Run: node server.js   then open the printed URL on any device on the same Wi-Fi.
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data.json');
const INDEX_FILE = path.join(__dirname, 'public', 'index.html');
const PASSES = { KB: 15, MB: 30, GB: 60 }; // minutes
const PRICES = { KB: 20, MB: 30, GB: 40, VR: 15 }; // pesos (VR = VR Roller Coaster add-on)

let sessions = [];
try { sessions = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch { sessions = []; }
for (const s of sessions) { // migrate old yes/no VR field to a ride count
  if ('vr' in s) { s.vrRides = s.vr ? 1 : 0; delete s.vr; }
  s.vrRides = s.vrRides || 0;
}
const toRides = (n) => Math.max(0, Math.min(99, Math.floor(Number(n) || 0)));
const save = () => fs.writeFileSync(DATA_FILE, JSON.stringify(sessions, null, 2));

function send(res, code, body, type = 'application/json') {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(type === 'application/json' ? JSON.stringify(body) : body);
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => { raw += c; if (raw.length > 1e5) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(raw || '{}')); } catch { resolve({}); } });
  });
}

const list = () => ({ now: Date.now(), passes: PASSES, prices: PRICES, sessions });

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const parts = url.pathname.split('/').filter(Boolean); // ['api','sessions',id,action]

  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    return send(res, 200, fs.readFileSync(INDEX_FILE), 'text/html; charset=utf-8');
  }
  if (parts[0] !== 'api' || parts[1] !== 'sessions') return send(res, 404, { error: 'Not found' });

  if (req.method === 'GET' && parts.length === 2) return send(res, 200, list());

  // Create a new entry
  if (req.method === 'POST' && parts.length === 2) {
    const { name, date, timeIn, pass, vrRides } = await readBody(req);
    if (!name || !String(name).trim()) return send(res, 400, { error: 'Name is required' });
    if (!PASSES[pass]) return send(res, 400, { error: 'Invalid package' });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '') || !/^\d{2}:\d{2}$/.test(timeIn || '')) {
      return send(res, 400, { error: 'Invalid date or time' });
    }
    const startAt = new Date(`${date}T${timeIn}:00`).getTime(); // server local time
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
    sessions.push(s); save();
    return send(res, 201, list());
  }

  const s = sessions.find((x) => x.id === parts[2]);
  if (!s) return send(res, 404, { error: 'Entry not found' });

  if (req.method === 'DELETE' && parts.length === 3) {
    sessions = sessions.filter((x) => x !== s); save();
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
    save();
    return send(res, 200, list());
  }

  send(res, 405, { error: 'Method not allowed' });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('\n  TechnoLounge 2026 is running!\n');
  console.log(`  This computer:   http://localhost:${PORT}`);
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family === 'IPv4' && !a.internal) console.log(`  Other devices:   http://${a.address}:${PORT}`);
    }
  }
  console.log('\n  (Devices must be on the same Wi-Fi / hotspot. Press Ctrl+C to stop.)\n');
});
