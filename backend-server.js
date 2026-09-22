/* ==========================================================================
   GOHRATOR — BACKEND SERVER
   A small, dependency-free Node.js server that gives the game a real
   GLOBAL leaderboard (scores from every player, on every device, stored
   in one place — instead of just localStorage on one browser).

   Why no Express / no database software?
   - Zero npm install needed. `node server.js` just works, anywhere.
   - Data is stored in a plain JSON file (leaderboard.json) next to this
     file. That's plenty for a leaderboard of a few thousand scores.
   - If you outgrow this later, swap saveDB()/loadDB() for a real
     database (Postgres, MongoDB, etc.) — everything else stays the same.

   WHAT THIS SERVER DOES
   - GET  /api/leaderboard          -> top scores (global)
   - POST /api/leaderboard          -> submit a new score
   - GET  /api/health               -> simple "is it alive" check
   - Serves nothing else — this is an API only. Your game's HTML/CSS/JS
     files are hosted separately (e.g. on Netlify, Vercel, GitHub Pages,
     or the same server — see README.md for both options).
   ========================================================================== */

const http = require('http');
const fs = require('fs');
const path = require('path');

// ---------- CONFIG ----------
const PORT = process.env.PORT || 3000;
const DB_FILE = path.join(__dirname, 'leaderboard.json');
const ACCOUNTS_FILE = path.join(__dirname, 'accounts.json');
const MAX_ENTRIES = 100;          // how many scores we keep, globally
const MAX_NAME_LENGTH = 16;
const MAX_REASONABLE_SCORE = 10_000_000; // sanity ceiling to reject obviously fake submissions
const RATE_LIMIT_WINDOW_MS = 10_000;     // one score submission per IP per 10 seconds
const LOGIN_RATE_LIMIT_WINDOW_MS = 2_000; // one login/register attempt per IP per 2 seconds
// Comma-separated list of allowed origins, e.g. "https://gohrator.com,https://www.gohrator.com"
// Leave as "*" during development; lock it down before a public launch.
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';

// ---------- TINY "DATABASE" (plain JSON files on disk) ----------
function loadDB() {
  try {
    if (!fs.existsSync(DB_FILE)) return [];
    const raw = fs.readFileSync(DB_FILE, 'utf8');
    const data = JSON.parse(raw);
    return Array.isArray(data) ? data : [];
  } catch (err) {
    console.error('Failed to read leaderboard.json, starting empty.', err);
    return [];
  }
}

function saveDB(entries) {
  fs.writeFileSync(DB_FILE, JSON.stringify(entries, null, 2), 'utf8');
}

// Accounts are stored as { "4821": { name, profile, updatedAt }, ... }
function loadAccounts() {
  try {
    if (!fs.existsSync(ACCOUNTS_FILE)) return {};
    const raw = fs.readFileSync(ACCOUNTS_FILE, 'utf8');
    const data = JSON.parse(raw);
    return (data && typeof data === 'object') ? data : {};
  } catch (err) {
    console.error('Failed to read accounts.json, starting empty.', err);
    return {};
  }
}

function saveAccounts(accounts) {
  fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(accounts, null, 2), 'utf8');
}

// ---------- BASIC RATE LIMITING (per IP, in-memory) ----------
// A single generic limiter keyed by "ip:action" so different endpoints can
// have different cooldowns without duplicating logic.
const rateLimitMap = new Map();
function isRateLimited(key, windowMs) {
  const now = Date.now();
  const last = rateLimitMap.get(key);
  if (last && now - last < windowMs) return true;
  rateLimitMap.set(key, now);
  return false;
}
// Periodically clear old rate-limit entries so the Map doesn't grow forever
setInterval(() => {
  const cutoff = Date.now() - 10 * 60_000;
  for (const [key, ts] of rateLimitMap) {
    if (ts < cutoff) rateLimitMap.delete(key);
  }
}, 60_000).unref();

// ---------- VALIDATION ----------
function sanitizeName(name) {
  if (typeof name !== 'string') return 'Pilot';
  const cleaned = name.replace(/[<>]/g, '').trim().slice(0, MAX_NAME_LENGTH);
  return cleaned || 'Pilot';
}

function validateSubmission(body) {
  if (!body || typeof body !== 'object') return 'Invalid submission body.';
  const { name, score, distance, level } = body;
  if (typeof score !== 'number' || !Number.isFinite(score) || score < 0) return 'Invalid score.';
  if (score > MAX_REASONABLE_SCORE) return 'Score exceeds the reasonable maximum.';
  if (distance !== undefined && (typeof distance !== 'number' || distance < 0)) return 'Invalid distance.';
  if (level !== undefined && (typeof level !== 'number' || level < 1 || level > 5)) return 'Invalid level.';
  if (name !== undefined && typeof name !== 'string') return 'Invalid name.';
  return null; // no error
}

function isValidPilotId(id) {
  return typeof id === 'string' && /^\d{4}$/.test(id);
}

// Generates a 4-digit account ID (1000-9999) not already in use.
function generateUniqueAccountId(accounts) {
  let id, attempts = 0;
  do {
    id = String(Math.floor(1000 + Math.random() * 9000));
    attempts++;
    if (attempts > 200) return null; // extremely unlikely with 9000 possible IDs
  } while (accounts[id]);
  return id;
}

function defaultAccountProfile(name, id) {
  return {
    pilotId: id,
    pilotName: name,
    highScore: 0,
    energyCoins: 0,
    totalFlights: 0,
    totalDistance: 0,
    highestCombo: 0,
    highestLevel: 1,
    achievements: {}
  };
}

// Only accept the specific fields we expect in a profile sync — never
// blindly trust/store an arbitrary object a client sends us.
function sanitizeIncomingProfile(name, id, profile) {
  const p = profile && typeof profile === 'object' ? profile : {};
  const clean = defaultAccountProfile(sanitizeName(name), id);
  if (typeof p.highScore === 'number' && p.highScore >= 0) clean.highScore = Math.min(Math.floor(p.highScore), MAX_REASONABLE_SCORE);
  if (typeof p.energyCoins === 'number' && p.energyCoins >= 0) clean.energyCoins = Math.floor(p.energyCoins);
  if (typeof p.totalFlights === 'number' && p.totalFlights >= 0) clean.totalFlights = Math.floor(p.totalFlights);
  if (typeof p.totalDistance === 'number' && p.totalDistance >= 0) clean.totalDistance = Math.floor(p.totalDistance);
  if (typeof p.highestCombo === 'number' && p.highestCombo >= 0) clean.highestCombo = Math.floor(p.highestCombo);
  if (typeof p.highestLevel === 'number' && p.highestLevel >= 1 && p.highestLevel <= 5) clean.highestLevel = Math.floor(p.highestLevel);
  if (p.achievements && typeof p.achievements === 'object' && !Array.isArray(p.achievements)) {
    clean.achievements = {};
    for (const key of Object.keys(p.achievements)) {
      if (p.achievements[key] === true) clean.achievements[key] = true;
    }
  }
  return clean;
}

// ---------- HTTP HELPERS ----------
function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  });
  res.end(body);
}

function readRequestBody(req, maxBytes = 10_000) {
  return new Promise((resolve, reject) => {
    let data = '';
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error('Request body too large.'));
        req.destroy();
        return;
      }
      data += chunk;
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); }
      catch (err) { reject(new Error('Malformed JSON.')); }
    });
    req.on('error', reject);
  });
}

function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) return forwarded.split(',')[0].trim();
  return req.socket.remoteAddress || 'unknown';
}

// ---------- ROUTE HANDLERS ----------
function handleGetLeaderboard(req, res) {
  const entries = loadDB();
  const sorted = [...entries].sort((a, b) => b.score - a.score).slice(0, 10);
  sendJson(res, 200, { leaderboard: sorted });
}

async function handlePostLeaderboard(req, res) {
  const ip = getClientIp(req);
  if (isRateLimited(`${ip}:score`, RATE_LIMIT_WINDOW_MS)) {
    return sendJson(res, 429, { error: 'Too many submissions — please wait a few seconds.' });
  }

  let body;
  try {
    body = await readRequestBody(req);
  } catch (err) {
    return sendJson(res, 400, { error: err.message });
  }

  const validationError = validateSubmission(body);
  if (validationError) {
    return sendJson(res, 400, { error: validationError });
  }

  const entry = {
    name: sanitizeName(body.name),
    score: Math.floor(body.score),
    distance: Math.floor(body.distance || 0),
    level: Math.floor(body.level || 1),
    date: new Date().toISOString()
  };

  const entries = loadDB();
  entries.push(entry);
  entries.sort((a, b) => b.score - a.score);
  const trimmed = entries.slice(0, MAX_ENTRIES);
  saveDB(trimmed);

  const rank = trimmed.findIndex(e => e === entry) + 1;
  sendJson(res, 201, { ok: true, entry, globalRank: rank > 0 ? rank : null });
}

function handleHealth(req, res) {
  sendJson(res, 200, { status: 'ok', service: 'GOHRATOR backend', time: new Date().toISOString() });
}

// ---------- ACCOUNT ROUTE HANDLERS (Pilot ID login system) ----------

// Creates a brand-new pilot account with a freshly generated 4-digit ID.
async function handleAccountRegister(req, res) {
  const ip = getClientIp(req);
  if (isRateLimited(`${ip}:register`, LOGIN_RATE_LIMIT_WINDOW_MS)) {
    return sendJson(res, 429, { error: 'Please wait a moment before trying again.' });
  }

  let body;
  try {
    body = await readRequestBody(req);
  } catch (err) {
    return sendJson(res, 400, { error: err.message });
  }

  if (!body.name || typeof body.name !== 'string' || !body.name.trim()) {
    return sendJson(res, 400, { error: 'A pilot name is required.' });
  }

  const accounts = loadAccounts();
  const id = generateUniqueAccountId(accounts);
  if (!id) {
    return sendJson(res, 507, { error: 'No Pilot IDs available right now — please try again shortly.' });
  }

  const name = sanitizeName(body.name);
  const profile = defaultAccountProfile(name, id);

  accounts[id] = { name, profile, updatedAt: new Date().toISOString() };
  saveAccounts(accounts);

  sendJson(res, 201, { id, name, profile });
}

// Logs an existing pilot in by Name + 4-digit ID.
async function handleAccountLogin(req, res) {
  const ip = getClientIp(req);
  if (isRateLimited(`${ip}:login`, LOGIN_RATE_LIMIT_WINDOW_MS)) {
    return sendJson(res, 429, { error: 'Please wait a moment before trying again.' });
  }

  let body;
  try {
    body = await readRequestBody(req);
  } catch (err) {
    return sendJson(res, 400, { error: err.message });
  }

  const { name, id } = body || {};
  if (!isValidPilotId(id) || !name || typeof name !== 'string') {
    return sendJson(res, 400, { error: 'Incorrect name or ID.' });
  }

  const accounts = loadAccounts();
  const account = accounts[id];

  // Deliberately generic error message for both "ID doesn't exist" and
  // "name doesn't match" — don't help an attacker tell the two apart.
  if (!account || account.name.trim().toLowerCase() !== name.trim().toLowerCase()) {
    return sendJson(res, 401, { error: 'Incorrect name or ID.' });
  }

  sendJson(res, 200, { id, name: account.name, profile: account.profile });
}

// Pushes a client's latest profile stats (score, coins, achievements, etc.)
// up to the backend, so the same Pilot ID reflects current progress when
// logged into from another device. Requires the correct name for that ID,
// same as login — this is the account's only form of authentication.
async function handleAccountSync(req, res) {
  const ip = getClientIp(req);
  if (isRateLimited(`${ip}:sync`, 1_000)) {
    return sendJson(res, 429, { error: 'Too many sync requests — please slow down.' });
  }

  let body;
  try {
    body = await readRequestBody(req, 20_000);
  } catch (err) {
    return sendJson(res, 400, { error: err.message });
  }

  const { name, id, profile } = body || {};
  if (!isValidPilotId(id) || !name || typeof name !== 'string') {
    return sendJson(res, 400, { error: 'Invalid sync request.' });
  }

  const accounts = loadAccounts();
  const account = accounts[id];
  if (!account || account.name.trim().toLowerCase() !== name.trim().toLowerCase()) {
    return sendJson(res, 401, { error: 'Incorrect name or ID.' });
  }

  const cleanProfile = sanitizeIncomingProfile(name, id, profile);
  accounts[id] = { name: account.name, profile: cleanProfile, updatedAt: new Date().toISOString() };
  saveAccounts(accounts);

  sendJson(res, 200, { ok: true });
}

// ---------- SERVER ----------
const server = http.createServer(async (req, res) => {
  // Handle CORS preflight requests
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    });
    return res.end();
  }

  const url = new URL(req.url, `http://${req.headers.host}`);

  try {
    if (url.pathname === '/api/leaderboard' && req.method === 'GET') {
      return handleGetLeaderboard(req, res);
    }
    if (url.pathname === '/api/leaderboard' && req.method === 'POST') {
      return await handlePostLeaderboard(req, res);
    }
    if (url.pathname === '/api/account/register' && req.method === 'POST') {
      return await handleAccountRegister(req, res);
    }
    if (url.pathname === '/api/account/login' && req.method === 'POST') {
      return await handleAccountLogin(req, res);
    }
    if (url.pathname === '/api/account/sync' && req.method === 'POST') {
      return await handleAccountSync(req, res);
    }
    if (url.pathname === '/api/health' && req.method === 'GET') {
      return handleHealth(req, res);
    }
    return sendJson(res, 404, { error: 'Not found.' });
  } catch (err) {
    console.error('Unhandled server error:', err);
    return sendJson(res, 500, { error: 'Internal server error.' });
  }
});

server.listen(PORT, () => {
  console.log(`🚀 GOHRATOR backend running at http://localhost:${PORT}`);
  console.log(`   GET  /api/leaderboard`);
  console.log(`   POST /api/leaderboard`);
  console.log(`   POST /api/account/register`);
  console.log(`   POST /api/account/login`);
  console.log(`   POST /api/account/sync`);
  console.log(`   GET  /api/health`);
});