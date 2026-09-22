/* ==========================================================================
   GOHRATOR — script.js
   Everything the game does lives in this one file, organized into clear
   sections. Read the section headers (the big "====" comment blocks) to
   find your way around. Every function has a short comment explaining
   what it does, written for someone with zero coding background.
   ========================================================================== */


/* ==========================================================================
   SECTION 1: STORAGE & ACCOUNT SYSTEM
   GOHRATOR now has a real login system: each pilot gets a unique 4-digit
   Pilot ID when they first create a profile. To log back in later (on this
   device, or on any device once the backend is deployed), they enter their
   Pilot Name + that ID. Get the ID wrong (or lose it) and there's no way
   back into that profile — a brand new one has to start from zero. That's
   the trade-off of a lightweight ID system with no email/password recovery.

   Data has two layers:
   - DEVICE DATA: things that belong to this device/browser, not to any one
     pilot — sound/music settings, and the "This Device" local leaderboard.
   - PROFILE DATA: things that belong to one specific pilot account — score,
     coins, achievements, stats. Stored per Pilot ID inside deviceData.accounts.

   The rest of the file just uses a single `saveData` variable which always
   points at the ACTIVE profile, with `.settings` and `.leaderboard` attached
   to it by reference — so nearly all existing game code (saveData.highScore,
   saveData.settings.sound, etc.) keeps working unchanged.
   ========================================================================== */

const STORAGE_KEY = 'gohrator_save_v2';
const LEGACY_STORAGE_KEY = 'gohrator_save_v1'; // for migrating pre-account saves

/* ==========================================================================
   BACKEND CONFIG
   Point this at your deployed backend (see /backend/README.md) to turn on
   a real global leaderboard AND cross-device Pilot ID login. Leave it as an
   empty string to run fully offline — Pilot IDs still work, but only on
   this one device/browser, and the global leaderboard tab won't have data.
   Example once deployed: 'https://gohrator-backend.onrender.com'
   ========================================================================== */
const API_BASE_URL = '';

// Small wrapper around fetch() with a timeout, so a slow/unreachable
// backend never freezes the game — it just falls back to local-only mode.
async function apiRequest(pathAndQuery, options = {}, timeoutMs = 6000) {
  if (!API_BASE_URL) throw new Error('No backend configured.');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(API_BASE_URL + pathAndQuery, { ...options, signal: controller.signal });
    clearTimeout(timer);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

function getDefaultDeviceData() {
  return {
    activeId: null,   // the currently logged-in Pilot ID, or null if logged out
    accounts: {},     // { "4821": <profile object>, ... } — every profile ever created on this device
    leaderboard: [],  // device-wide "This Device" leaderboard: [{ name, score, distance, level, date }]
    settings: {
      sound: true,
      music: true,
      vibration: true,
      controlStyle: 'arrows',
      graphics: 'medium'
    }
  };
}

function getDefaultProfile(name, id) {
  return {
    pilotId: id,
    pilotName: name,
    backendLinked: false, // true once this profile has been created/verified against the backend
    highScore: 0,
    energyCoins: 0,
    totalFlights: 0,
    totalDistance: 0,
    highestCombo: 0,
    highestLevel: 1,
    achievements: {} // { achievementId: true }
  };
}

let deviceData = loadDeviceData();
let saveData = null; // set to the active profile once a pilot logs in (see attachActiveProfile)

// Reads saved data from localStorage, migrating an old pre-account save if found.
function loadDeviceData() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      const merged = Object.assign(getDefaultDeviceData(), parsed, {
        settings: Object.assign(getDefaultDeviceData().settings, parsed.settings || {}),
        accounts: parsed.accounts || {}
      });
      return merged;
    }

    // No v2 save yet — check for a legacy (pre-account) save to migrate.
    const legacyRaw = localStorage.getItem(LEGACY_STORAGE_KEY);
    if (legacyRaw) {
      const legacy = JSON.parse(legacyRaw);
      if (legacy && legacy.pilotName) {
        const fresh = getDefaultDeviceData();
        const id = generateLocalId(fresh);
        const profile = Object.assign(getDefaultProfile(legacy.pilotName, id), {
          highScore: legacy.highScore || 0,
          energyCoins: legacy.energyCoins || 0,
          totalFlights: legacy.totalFlights || 0,
          totalDistance: legacy.totalDistance || 0,
          highestCombo: legacy.highestCombo || 0,
          highestLevel: legacy.highestLevel || 1,
          achievements: legacy.achievements || {}
        });
        fresh.accounts[id] = profile;
        fresh.activeId = legacy.isLoggedIn ? id : null;
        fresh.leaderboard = legacy.leaderboard || [];
        fresh.settings = Object.assign(fresh.settings, legacy.settings || {});
        return fresh;
      }
    }

    return getDefaultDeviceData();
  } catch (err) {
    console.warn('Save data was corrupted, starting fresh.', err);
    return getDefaultDeviceData();
  }
}

// Writes deviceData (which contains every account) to localStorage as text.
function saveGame() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(deviceData));
  } catch (err) {
    console.warn('Could not save game data.', err);
  }
  scheduleBackendSync();
}

// Points `saveData` at the given profile, with device-wide settings/leaderboard
// attached by reference so existing code (saveData.settings.sound, etc.) works
// unchanged. Pass null to log out (no active profile).
function attachActiveProfile(profile) {
  if (!profile) { saveData = null; return; }
  profile.settings = deviceData.settings;
  profile.leaderboard = deviceData.leaderboard;
  saveData = profile;
}

// Generates a 4-digit Pilot ID (1000-9999) that isn't already used on this device.
function generateLocalId(targetDeviceData) {
  const dd = targetDeviceData || deviceData;
  let id;
  let attempts = 0;
  do {
    id = String(Math.floor(1000 + Math.random() * 9000));
    attempts++;
  } while (dd.accounts[id] && attempts < 50);
  return id;
}


/* ==========================================================================
   BACKEND SYNC (best-effort, debounced)
   If a profile is backend-linked, we periodically push its latest stats up
   to the server so the same Pilot ID can be used to log in from another
   device. This never blocks gameplay — it's fire-and-forget.
   ========================================================================== */

let backendSyncTimer = null;

function scheduleBackendSync() {
  if (!API_BASE_URL || !saveData || !saveData.backendLinked) return;
  clearTimeout(backendSyncTimer);
  backendSyncTimer = setTimeout(() => syncProfileToBackend(), 2500);
}

async function syncProfileToBackend() {
  if (!API_BASE_URL || !saveData || !saveData.backendLinked) return;
  try {
    await apiRequest('/api/account/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: saveData.pilotId, name: saveData.pilotName, profile: exportProfileForSync() })
    });
  } catch (err) {
    console.warn('Background profile sync failed (will retry next save):', err.message);
  }
}

// Sends the sync on tab close too, using sendBeacon so it fires reliably
// even as the page is unloading (a normal fetch could get cancelled).
window.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden' && API_BASE_URL && saveData && saveData.backendLinked) {
    try {
      const payload = JSON.stringify({ id: saveData.pilotId, name: saveData.pilotName, profile: exportProfileForSync() });
      navigator.sendBeacon(API_BASE_URL + '/api/account/sync', new Blob([payload], { type: 'application/json' }));
    } catch (err) { /* best-effort only */ }
  }
});

// Strips out the settings/leaderboard references before sending a profile
// to the backend — those are device-local, not part of the account.
function exportProfileForSync() {
  const { settings, leaderboard, ...profileOnly } = saveData;
  return profileOnly;
}


/* ==========================================================================
   SECTION 2: SOUND SYSTEM (Web Audio API)
   We generate all sound effects with code (oscillators + synthesized noise)
   instead of loading audio files, so the game needs zero external assets
   and still works perfectly if audio is blocked by the browser.
   ========================================================================== */

let audioCtx = null;
let cachedNoiseBuffer = null; // one shared white-noise buffer, reused for every noise-based effect

// Browsers require a user interaction before audio can play, so we create
// the AudioContext lazily, the first time the player interacts.
function ensureAudioContext() {
  if (!audioCtx) {
    try {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    } catch (err) {
      console.warn('Web Audio API not available.', err);
    }
  }
  if (audioCtx && audioCtx.state === 'suspended') {
    audioCtx.resume();
  }
}

// Builds (once) a 2-second buffer of white noise that every noise-based
// sound effect (rocket rumble, crash debris) can slice from.
function getNoiseBuffer() {
  if (cachedNoiseBuffer || !audioCtx) return cachedNoiseBuffer;
  const length = audioCtx.sampleRate * 2;
  const buffer = audioCtx.createBuffer(1, length, audioCtx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
  cachedNoiseBuffer = buffer;
  return buffer;
}

// Plays a short beep/tone — a plain oscillator with an exponential fade-out.
// This is the basic building block for most UI and pickup sound effects.
function playTone(frequency, duration, type = 'sine', volume = 0.15, delay = 0) {
  if (!deviceData.settings.sound || !audioCtx) return;
  try {
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = type;
    osc.frequency.value = frequency;
    gain.gain.value = volume;
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    const startTime = audioCtx.currentTime + delay;
    gain.gain.setValueAtTime(volume, startTime);
    gain.gain.exponentialRampToValueAtTime(0.001, startTime + duration);
    osc.start(startTime);
    osc.stop(startTime + duration);
  } catch (err) { /* silently ignore audio errors */ }
}

// A tone that slides from one pitch to another — used for whooshes (rising
// pitch, like a rocket taking off) and falling "power-down" style effects.
function playSweep(startFreq, endFreq, duration, volume = 0.12, delay = 0, type = 'sine') {
  if (!deviceData.settings.sound || !audioCtx) return;
  try {
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = type;
    const startTime = audioCtx.currentTime + delay;
    osc.frequency.setValueAtTime(Math.max(1, startFreq), startTime);
    osc.frequency.exponentialRampToValueAtTime(Math.max(1, endFreq), startTime + duration);
    gain.gain.setValueAtTime(volume, startTime);
    gain.gain.exponentialRampToValueAtTime(0.001, startTime + duration);
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.start(startTime);
    osc.stop(startTime + duration);
  } catch (err) { /* silently ignore audio errors */ }
}

// A burst of filtered white noise — this is what makes the rocket launch
// sound like real rumble/thrust, and collisions sound like an actual
// crash/debris impact instead of just a musical "beep".
function playNoiseBurst({ duration = 0.3, volume = 0.2, filterType = 'lowpass', filterFreq = 800, filterQ = 1, delay = 0 } = {}) {
  if (!deviceData.settings.sound || !audioCtx) return;
  const buffer = getNoiseBuffer();
  if (!buffer) return;
  try {
    const noise = audioCtx.createBufferSource();
    noise.buffer = buffer;
    // Start at a random offset each time so repeated bursts don't sound identical
    noise.loop = false;

    const filter = audioCtx.createBiquadFilter();
    filter.type = filterType;
    filter.frequency.value = filterFreq;
    filter.Q.value = filterQ;

    const gain = audioCtx.createGain();
    const startTime = audioCtx.currentTime + delay;
    gain.gain.setValueAtTime(volume, startTime);
    gain.gain.exponentialRampToValueAtTime(0.001, startTime + duration);

    noise.connect(filter);
    filter.connect(gain);
    gain.connect(audioCtx.destination);

    const offset = Math.random() * 1.5;
    noise.start(startTime, offset, duration);
  } catch (err) { /* silently ignore audio errors */ }
}

const Sound = {
  click: () => playTone(600, 0.08, 'square', 0.08),

  // Rocket launch: low ignition rumble (noise) + engine tone + rising whoosh
  launch: () => {
    playNoiseBurst({ duration: 0.55, volume: 0.22, filterType: 'lowpass', filterFreq: 350, filterQ: 0.7 });
    playTone(55, 0.55, 'sawtooth', 0.18);
    playTone(80, 0.45, 'sawtooth', 0.12, 0.04);
    playSweep(140, 820, 0.5, 0.13, 0.08, 'sawtooth');
    playSweep(90, 480, 0.6, 0.08, 0.15, 'triangle');
  },

  coin: () => { playTone(880, 0.08, 'square', 0.1); playTone(1320, 0.1, 'square', 0.1, 0.06); },
  powerup: () => { playTone(440, 0.1, 'triangle', 0.12); playTone(660, 0.12, 'triangle', 0.12, 0.08); playTone(880, 0.15, 'triangle', 0.12, 0.16); },

  // Collision: sharp noise crack + deep thud + falling pitch, layered for impact
  collision: () => {
    playNoiseBurst({ duration: 0.18, volume: 0.3, filterType: 'bandpass', filterFreq: 1800, filterQ: 0.8 });
    playNoiseBurst({ duration: 0.4, volume: 0.22, filterType: 'lowpass', filterFreq: 280, filterQ: 0.6, delay: 0.02 });
    playTone(90, 0.28, 'square', 0.16);
    playSweep(260, 40, 0.35, 0.14, 0.02, 'sawtooth');
  },

  // Game over: bigger explosion — layered noise "boom" plus a descending tone collapse
  gameOver: () => {
    playNoiseBurst({ duration: 0.6, volume: 0.32, filterType: 'lowpass', filterFreq: 1000, filterQ: 0.6 });
    playNoiseBurst({ duration: 0.9, volume: 0.22, filterType: 'lowpass', filterFreq: 220, filterQ: 0.5, delay: 0.06 });
    playTone(220, 0.2, 'sawtooth', 0.15);
    playTone(150, 0.28, 'sawtooth', 0.15, 0.18);
    playTone(90, 0.45, 'sawtooth', 0.15, 0.34);
    playSweep(400, 60, 0.7, 0.1, 0.05, 'sawtooth');
  },

  achievement: () => { playTone(523, 0.12, 'triangle', 0.13); playTone(659, 0.12, 'triangle', 0.13, 0.1); playTone(784, 0.2, 'triangle', 0.13, 0.2); },
  boost: () => { playNoiseBurst({ duration: 0.3, volume: 0.12, filterType: 'highpass', filterFreq: 600 }); playSweep(220, 900, 0.35, 0.13, 0, 'sawtooth'); }
};

// Small helper for phone vibration on mobile, if the device/setting supports it.
function vibrate(pattern) {
  if (deviceData.settings.vibration && navigator.vibrate) {
    navigator.vibrate(pattern);
  }
}



/* ==========================================================================
   SECTION 3: TOAST NOTIFICATIONS
   Small messages that slide in from the top and disappear automatically.
   ========================================================================== */

function showToast(message) {
  const container = document.getElementById('toastContainer');
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.textContent = message;
  container.appendChild(toast);
  // Remove the toast element after its animation finishes (2.5s total)
  setTimeout(() => toast.remove(), 2600);
}


/* ==========================================================================
   SECTION 4: ACHIEVEMENTS
   Defines every achievement, and the logic to check/unlock them.
   ========================================================================== */

const ACHIEVEMENTS = [
  { id: 'first_flight',  icon: '🚀', name: 'First Flight',   desc: 'Play your first game.' },
  { id: 'sky_explorer',  icon: '🌟', name: 'Sky Explorer',   desc: 'Travel 1,000 meters in a single flight.' },
  { id: 'coin_collector', icon: '💰', name: 'Coin Collector', desc: 'Collect 100 total energy coins.' },
  { id: 'on_fire',       icon: '🔥', name: 'On Fire',        desc: 'Reach a 10x combo.' },
  { id: 'speed_demon',   icon: '⚡', name: 'Speed Demon',    desc: 'Use a speed boost successfully.' },
  { id: 'galaxy_master', icon: '👑', name: 'Galaxy Master',  desc: 'Reach the highest level (Lv.5).' },
  { id: 'survivor',      icon: '🛡️', name: 'Survivor',       desc: 'Survive 60 seconds in one flight.' },
  { id: 'high_scorer',   icon: '🏆', name: 'High Scorer',    desc: 'Score 5,000 points in one flight.' },
  { id: 'shielded',      icon: '🛡️', name: 'Well Protected', desc: 'Collect a shield power-up.' },
  { id: 'magnetic',      icon: '🧲', name: 'Magnetic',       desc: 'Collect a magnet power-up.' },
  { id: 'dedicated',     icon: '🎮', name: 'Dedicated Pilot', desc: 'Play 10 total flights.' },
  { id: 'marathon',      icon: '📏', name: 'Marathoner',     desc: 'Travel 10,000 total meters (lifetime).' }
];

// Unlocks an achievement if not already unlocked, saves progress, and
// shows the unlock popup + sound.
function unlockAchievement(id) {
  if (saveData.achievements[id]) return; // already unlocked
  saveData.achievements[id] = true;
  saveGame();
  Sound.achievement();
  vibrate([40, 30, 60]);

  const def = ACHIEVEMENTS.find(a => a.id === id);
  if (def) {
    document.getElementById('apIcon').textContent = def.icon;
    document.getElementById('apName').textContent = def.name;
    const popup = document.getElementById('achievementPopup');
    popup.classList.remove('hidden');
    // Restart the CSS animation each time by cloning the element trick
    popup.style.animation = 'none';
    void popup.offsetWidth; // force reflow
    popup.style.animation = '';
    setTimeout(() => popup.classList.add('hidden'), 3000);
  }
  renderAchievementsPage();
  updateHeaderStats();
}

// Checks all "stat based" achievements against current saveData/session stats.
// Called after every game over, and at a few points during gameplay.
function checkStatAchievements(session) {
  if (saveData.totalFlights >= 1) unlockAchievement('first_flight');
  if (session.distance >= 1000) unlockAchievement('sky_explorer');
  if (saveData.energyCoins >= 100) unlockAchievement('coin_collector');
  if (session.maxCombo >= 10) unlockAchievement('on_fire');
  if (saveData.highestLevel >= 5) unlockAchievement('galaxy_master');
  if (session.elapsedSeconds >= 60) unlockAchievement('survivor');
  if (session.score >= 5000) unlockAchievement('high_scorer');
  if (saveData.totalFlights >= 10) unlockAchievement('dedicated');
  if (saveData.totalDistance >= 10000) unlockAchievement('marathon');
}

function renderAchievementsPage() {
  const grid = document.getElementById('achievementsGrid');
  grid.innerHTML = '';
  let unlockedCount = 0;

  ACHIEVEMENTS.forEach(a => {
    const unlocked = !!saveData.achievements[a.id];
    if (unlocked) unlockedCount++;
    const card = document.createElement('div');
    card.className = 'achievement-card' + (unlocked ? ' unlocked' : '');
    card.innerHTML = `
      <span class="ach-icon">${a.icon}</span>
      <div>
        <div class="ach-name">${a.name}</div>
        <div class="ach-desc">${a.desc}</div>
      </div>
      ${unlocked ? '<span class="ach-check">✓</span>' : ''}
    `;
    grid.appendChild(card);
  });

  document.getElementById('achievementsProgress').textContent = `${unlockedCount} of ${ACHIEVEMENTS.length} unlocked`;
  document.getElementById('homeAchievements').textContent = `${unlockedCount}/${ACHIEVEMENTS.length}`;
}


/* ==========================================================================
   SECTION 5: LEADERBOARD
   ========================================================================== */

function addToLeaderboard(entry) {
  saveData.leaderboard.push(entry);
  saveData.leaderboard.sort((a, b) => b.score - a.score);
  saveData.leaderboard = saveData.leaderboard.slice(0, 10); // keep top 10
  saveGame();
}

// Sends a finished run's score to the global backend, if one is configured.
// This is entirely best-effort: if there's no backend, no internet, or the
// request fails, the game just stays in local-only mode — nothing breaks.
async function submitScoreToGlobal(entry) {
  if (!API_BASE_URL) return;
  try {
    await apiRequest('/api/leaderboard', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(entry)
    });
  } catch (err) {
    console.warn('Global score submission failed (playing in local-only mode):', err.message);
  }
}

let currentLeaderboardScope = 'local';

function renderLeaderboardRows(entries) {
  const list = document.getElementById('leaderboardList');
  list.innerHTML = '';

  if (!entries || entries.length === 0) {
    list.innerHTML = '<div class="lb-empty">No flights yet. Play a game to set the first record! 🚀</div>';
    return;
  }

  const medals = ['🥇', '🥈', '🥉'];
  entries.forEach((entry, i) => {
    const row = document.createElement('div');
    row.className = 'lb-row' + (i < 3 ? ` rank-${i + 1}` : '');
    row.innerHTML = `
      <div class="lb-rank">${medals[i] || (i + 1)}</div>
      <div class="lb-info">
        <div class="lb-name">${escapeHtml(entry.name)}</div>
        <div class="lb-meta">${entry.distance || 0}m • Level ${entry.level || 1}</div>
      </div>
      <div class="lb-score">${entry.score.toLocaleString()}</div>
    `;
    list.appendChild(row);
  });
}

async function renderLeaderboardPage(scope) {
  const activeScope = scope || currentLeaderboardScope;
  currentLeaderboardScope = activeScope;

  document.getElementById('lbTabLocal').classList.toggle('active', activeScope === 'local');
  document.getElementById('lbTabGlobal').classList.toggle('active', activeScope === 'global');
  document.getElementById('leaderboardSub').textContent =
    activeScope === 'local' ? 'Top pilots on this device.' : 'Top pilots across every device, worldwide.';

  if (activeScope === 'local') {
    renderLeaderboardRows(saveData.leaderboard);
    return;
  }

  // Global scope
  const list = document.getElementById('leaderboardList');
  if (!API_BASE_URL) {
    list.innerHTML = '<div class="lb-status">🌍 Global leaderboard isn\'t connected yet. See backend/README.md to enable it.</div>';
    return;
  }

  list.innerHTML = '<div class="lb-status">Loading global scores…</div>';
  try {
    const data = await apiRequest('/api/leaderboard');
    renderLeaderboardRows(data.leaderboard || []);
  } catch (err) {
    list.innerHTML = `<div class="lb-status lb-error">⚠️ Couldn't reach the global leaderboard. Check your connection and try again.</div>`;
  }
}

document.getElementById('lbTabLocal').addEventListener('click', () => { Sound.click(); renderLeaderboardPage('local'); });
document.getElementById('lbTabGlobal').addEventListener('click', () => { Sound.click(); renderLeaderboardPage('global'); });

// Prevents player-entered names from breaking the page (basic HTML escaping).
function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}


/* ==========================================================================
   SECTION 6: NAVIGATION BETWEEN SCREENS & PAGES
   ========================================================================== */

function goToScreen(screenId) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(screenId).classList.add('active');
}

function goToPage(pageName) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));

  document.getElementById('page-' + pageName).classList.add('active');
  document.querySelector(`.nav-btn[data-page="${pageName}"]`).classList.add('active');

  // Refresh page content each time it's opened
  if (pageName === 'leaderboard') renderLeaderboardPage();
  if (pageName === 'achievements') renderAchievementsPage();
  if (pageName === 'profile') renderProfilePage();
  if (pageName === 'home') renderHomePage();
  if (pageName === 'game') resetPreGameUI();
}

document.querySelectorAll('.nav-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    Sound.click();
    goToPage(btn.dataset.page);
  });
});


/* ==========================================================================
   SECTION 7: HEADER / HOME / PROFILE RENDERING
   Keeps all the on-screen stats in sync with saveData.
   ========================================================================== */

function updateHeaderStats() {
  document.getElementById('headerPilotName').textContent = saveData.pilotName || 'Pilot';
  document.getElementById('headerHighScore').textContent = saveData.highScore.toLocaleString();
  document.getElementById('headerCoins').textContent = saveData.energyCoins.toLocaleString();
  document.getElementById('headerLevel').textContent = saveData.highestLevel;
}

function renderHomePage() {
  document.getElementById('homePilotName').textContent = saveData.pilotName || 'Pilot';
  document.getElementById('homeHighScore').textContent = saveData.highScore.toLocaleString();
  document.getElementById('homeTotalDistance').textContent = Math.floor(saveData.totalDistance).toLocaleString() + 'm';
  document.getElementById('homeTotalFlights').textContent = saveData.totalFlights;
  const unlockedCount = Object.keys(saveData.achievements).length;
  document.getElementById('homeAchievements').textContent = `${unlockedCount}/${ACHIEVEMENTS.length}`;
}

function renderProfilePage() {
  document.getElementById('profilePilotName').textContent = saveData.pilotName || 'Pilot';
  document.getElementById('profilePilotId').textContent = saveData.pilotId || '----';
  document.getElementById('profileHighScore').textContent = saveData.highScore.toLocaleString();
  document.getElementById('profileFlights').textContent = saveData.totalFlights;
  document.getElementById('profileDistance').textContent = Math.floor(saveData.totalDistance).toLocaleString() + 'm';
  document.getElementById('profileCoins').textContent = saveData.energyCoins.toLocaleString();
  document.getElementById('profileCombo').textContent = saveData.highestCombo;
  document.getElementById('profileLevel').textContent = saveData.highestLevel;
}


/* ==========================================================================
   SECTION 8: SPLASH SCREEN LOADING ANIMATION
   ========================================================================== */

function runSplashScreen() {
  const fill = document.getElementById('loadingBarFill');
  const percentLabel = document.getElementById('loadingPercent');
  let progress = 0;

  const interval = setInterval(() => {
    // Randomized increments make the loading bar feel more natural/dynamic
    progress += Math.random() * 12 + 6;
    if (progress >= 100) {
      progress = 100;
      clearInterval(interval);
      setTimeout(() => {
        const splash = document.getElementById('screen-splash');
        splash.classList.add('fading-out');
        setTimeout(() => {
          splash.classList.remove('active', 'fading-out');
          // Skip login if a pilot is already logged in on this device
          const existingProfile = deviceData.activeId ? deviceData.accounts[deviceData.activeId] : null;
          if (existingProfile) {
            attachActiveProfile(existingProfile);
            enterApp();
          } else {
            goToScreen('screen-login');
          }
        }, 600);
      }, 400);
    }
    fill.style.width = progress + '%';
    percentLabel.textContent = Math.floor(progress) + '%';
  }, 180);
}


/* ==========================================================================
   SECTION 9: LOGIN LOGIC (real Pilot ID account system)
   ========================================================================== */

function showLoginError(message) {
  const el = document.getElementById('loginError');
  el.textContent = message;
  el.style.display = 'block';
}
function clearLoginError() {
  document.getElementById('loginError').style.display = 'none';
}

// Main "ENTER GAME" button — decides whether this is a new pilot (create)
// or a returning pilot (login) based on whether the ID field was filled in.
async function handleLogin() {
  ensureAudioContext();
  clearLoginError();

  const name = document.getElementById('usernameInput').value.trim();
  const idRaw = document.getElementById('pilotIdInput').value.trim();

  if (!name) {
    flashFieldError('usernameInput');
    return;
  }

  Sound.click();
  const loginBtn = document.getElementById('loginBtn');
  loginBtn.disabled = true;

  try {
    if (!idRaw) {
      await registerNewPilot(name);
    } else {
      if (!/^\d{4}$/.test(idRaw)) {
        showLoginError('Pilot ID must be exactly 4 digits.');
        return;
      }
      await loginExistingPilot(name, idRaw);
    }
  } finally {
    loginBtn.disabled = false;
  }
}

function flashFieldError(fieldId) {
  const field = document.getElementById(fieldId);
  field.focus();
  field.style.borderColor = 'var(--danger)';
  setTimeout(() => { field.style.borderColor = ''; }, 800);
}

// Creates a brand-new pilot profile with a freshly generated 4-digit ID.
// Tries the backend first (so the ID works across devices); if that's not
// configured or unreachable, falls back to a device-only local profile.
async function registerNewPilot(name) {
  let id, profile;

  if (API_BASE_URL) {
    try {
      const data = await apiRequest('/api/account/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name })
      });
      id = data.id;
      profile = Object.assign(getDefaultProfile(data.name, id), data.profile, { backendLinked: true });
    } catch (err) {
      showToast('⚠️ Could not reach the server — creating a local-only profile.');
    }
  }

  if (!profile) {
    id = generateLocalId();
    profile = getDefaultProfile(name, id);
  }

  deviceData.accounts[id] = profile;
  deviceData.activeId = id;
  saveGame();

  showPilotIdModal(id);
}

// Logs an existing pilot back in by Name + ID. Tries the backend first
// (so IDs work across devices); falls back to checking this device's local
// account list if the backend is unreachable or not configured.
async function loginExistingPilot(name, id) {
  if (API_BASE_URL) {
    try {
      const data = await apiRequest('/api/account/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, id })
      });
      const profile = Object.assign(getDefaultProfile(data.name, id), data.profile, { backendLinked: true });
      deviceData.accounts[id] = profile;
      deviceData.activeId = id;
      saveGame();
      attachActiveProfile(profile);
      showToast(`👋 Welcome back, ${profile.pilotName}!`);
      enterApp();
      return;
    } catch (err) {
      // Fall through to local-only lookup below (e.g. offline, or server down)
      console.warn('Backend login failed, checking local device instead:', err.message);
    }
  }

  const localProfile = deviceData.accounts[id];
  if (localProfile && localProfile.pilotName.toLowerCase() === name.toLowerCase()) {
    deviceData.activeId = id;
    saveGame();
    attachActiveProfile(localProfile);
    showToast(`👋 Welcome back, ${localProfile.pilotName}!`);
    enterApp();
  } else {
    showLoginError('Incorrect name or ID, or this pilot isn\'t saved on this device.');
  }
}

function handleGuestLogin() {
  ensureAudioContext();
  Sound.click();
  registerNewPilot('Guest Pilot');
}

function showPilotIdModal(id) {
  document.getElementById('pilotIdDisplay').textContent = id;
  document.getElementById('pilotIdModal').classList.remove('hidden');
}

document.getElementById('pilotIdGotItBtn').addEventListener('click', () => {
  Sound.click();
  document.getElementById('pilotIdModal').classList.add('hidden');
  const profile = deviceData.accounts[deviceData.activeId];
  attachActiveProfile(profile);
  enterApp();
});

// Transitions from login screen into the main app shell (dashboard).
function enterApp() {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById('appShell').classList.add('active');
  applySettingsToUI();
  updateHeaderStats();
  renderAchievementsPage();
  goToPage('home');
}


/* ==========================================================================
   SECTION 10: SETTINGS MODAL
   ========================================================================== */

function applySettingsToUI() {
  document.getElementById('settingSound').checked = saveData.settings.sound;
  document.getElementById('settingMusic').checked = saveData.settings.music;
  document.getElementById('settingVibration').checked = saveData.settings.vibration;
  document.getElementById('settingControlStyle').value = saveData.settings.controlStyle;
  document.getElementById('settingGraphics').value = saveData.settings.graphics;
  document.getElementById('soundToggleBtn').textContent = saveData.settings.sound ? '🔊' : '🔇';
}

document.getElementById('settingsBtn').addEventListener('click', () => {
  Sound.click();
  document.getElementById('settingsModal').classList.remove('hidden');
});
document.getElementById('closeSettingsBtn').addEventListener('click', () => {
  document.getElementById('settingsModal').classList.add('hidden');
});
document.getElementById('settingsModal').addEventListener('click', (e) => {
  if (e.target.id === 'settingsModal') document.getElementById('settingsModal').classList.add('hidden');
});

document.getElementById('settingSound').addEventListener('change', (e) => {
  saveData.settings.sound = e.target.checked;
  saveGame();
  document.getElementById('soundToggleBtn').textContent = e.target.checked ? '🔊' : '🔇';
});
document.getElementById('settingMusic').addEventListener('change', (e) => {
  saveData.settings.music = e.target.checked;
  saveGame();
  if (e.target.checked) startMusic(); else stopMusic();
});
document.getElementById('settingVibration').addEventListener('change', (e) => {
  saveData.settings.vibration = e.target.checked;
  saveGame();
});
document.getElementById('settingControlStyle').addEventListener('change', (e) => {
  saveData.settings.controlStyle = e.target.value;
  saveGame();
  document.getElementById('touchControls').style.display = e.target.value === 'touch' ? 'flex' : '';
});
document.getElementById('settingGraphics').addEventListener('change', (e) => {
  saveData.settings.graphics = e.target.value;
  saveGame();
});

document.getElementById('soundToggleBtn').addEventListener('click', () => {
  saveData.settings.sound = !saveData.settings.sound;
  saveGame();
  applySettingsToUI();
  Sound.click();
});


/* ==========================================================================
   SECTION 11: RESET DATA MODAL
   ========================================================================== */

document.getElementById('resetDataBtn').addEventListener('click', () => {
  Sound.click();
  document.getElementById('resetModal').classList.remove('hidden');
});
document.getElementById('cancelResetBtn').addEventListener('click', () => {
  Sound.click();
  document.getElementById('resetModal').classList.add('hidden');
});
document.getElementById('confirmResetBtn').addEventListener('click', () => {
  // Reset this profile's stats back to zero, but keep its Pilot ID and name
  // intact — the same ID still logs back into this (now-fresh) account.
  const id = saveData.pilotId;
  const name = saveData.pilotName;
  const backendLinked = saveData.backendLinked;
  const fresh = getDefaultProfile(name, id);
  fresh.backendLinked = backendLinked;

  deviceData.accounts[id] = fresh;
  attachActiveProfile(fresh);
  saveGame();

  document.getElementById('resetModal').classList.add('hidden');
  showToast('🗑️ Game data has been reset.');
  updateHeaderStats();
  renderHomePage();
  renderProfilePage();
  renderAchievementsPage();
  renderLeaderboardPage();
});


/* ==========================================================================
   SECTION 12: CHANGE NAME MODAL
   ========================================================================== */

document.getElementById('changeNameBtn').addEventListener('click', () => {
  Sound.click();
  document.getElementById('newNameInput').value = saveData.pilotName;
  document.getElementById('changeNameModal').classList.remove('hidden');
});
document.getElementById('closeChangeNameBtn').addEventListener('click', () => {
  document.getElementById('changeNameModal').classList.add('hidden');
});
document.getElementById('cancelChangeNameBtn').addEventListener('click', () => {
  document.getElementById('changeNameModal').classList.add('hidden');
});
document.getElementById('confirmChangeNameBtn').addEventListener('click', () => {
  const newName = document.getElementById('newNameInput').value.trim();
  if (!newName) return;
  saveData.pilotName = newName;
  saveGame();
  document.getElementById('changeNameModal').classList.add('hidden');
  updateHeaderStats();
  renderHomePage();
  renderProfilePage();
  showToast('✅ Pilot name updated.');
});

document.getElementById('logoutBtn').addEventListener('click', () => {
  Sound.click();
  syncProfileToBackend(); // final best-effort push before leaving
  deviceData.activeId = null;
  saveGame();
  saveData = null;
  document.getElementById('appShell').classList.remove('active');
  document.getElementById('usernameInput').value = '';
  document.getElementById('pilotIdInput').value = '';
  clearLoginError();
  goToScreen('screen-login');
});


/* ==========================================================================
   SECTION 13: BACKGROUND MUSIC (generative ambient loop)
   A slow 4-chord progression (Am–F–G–C — a common moody/epic progression)
   with a sustained pad, a pulsing bass note on every beat, and the
   occasional plucked arpeggio note for sparkle. Everything is synthesized
   on the fly with oscillators, so there's no audio file to load.

   This is deliberately decoupled from the sound-effects volume: it checks
   saveData.settings.music, not saveData.settings.sound, so turning off
   effects doesn't silence the music and vice versa.
   ========================================================================== */

const MUSIC_PROGRESSION = [
  { pad: [110.00, 130.81, 164.81], bass: 55.00, arp: [220.00, 261.63, 329.63, 392.00] }, // A minor
  { pad: [87.31, 110.00, 130.81], bass: 43.65, arp: [174.61, 220.00, 261.63, 349.23] },  // F major
  { pad: [98.00, 123.47, 146.83], bass: 49.00, arp: [196.00, 246.94, 293.66, 392.00] },  // G major
  { pad: [130.81, 164.81, 196.00], bass: 65.41, arp: [261.63, 329.63, 392.00, 523.25] }  // C major
];

// A quiet tone gated by the MUSIC setting rather than the SOUND setting,
// so the two toggle independently — otherwise identical to playTone().
function playMusicTone(frequency, duration, type = 'sine', volume = 0.05, delay = 0) {
  if (!deviceData.settings.music || !audioCtx) return;
  try {
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = type;
    osc.frequency.value = frequency;
    const startTime = audioCtx.currentTime + delay;
    // Gentle fade-in avoids audible "clicks" on long sustained pad notes
    gain.gain.setValueAtTime(0.0001, startTime);
    gain.gain.exponentialRampToValueAtTime(volume, startTime + 0.4);
    gain.gain.exponentialRampToValueAtTime(0.0001, startTime + duration);
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.start(startTime);
    osc.stop(startTime + duration);
  } catch (err) { /* silently ignore audio errors */ }
}

let musicInterval = null;
let musicBeat = 0;        // 0-3, four beats make one bar/chord
let musicChordIndex = 0;
const MUSIC_BEAT_MS = 1100; // slow, ambient tempo

function startMusic() {
  if (!deviceData.settings.music || musicInterval) return;
  ensureAudioContext();
  if (!audioCtx) return;
  musicBeat = 0;
  musicChordIndex = 0;
  playMusicBeat();
  musicInterval = setInterval(playMusicBeat, MUSIC_BEAT_MS);
}

function playMusicBeat() {
  if (!deviceData.settings.music) return;
  const chord = MUSIC_PROGRESSION[musicChordIndex];

  if (musicBeat === 0) {
    // Start of a new bar: sustain the full pad chord across all 4 beats
    const barDuration = (MUSIC_BEAT_MS / 1000) * 4 + 0.4;
    chord.pad.forEach((freq, i) => playMusicTone(freq, barDuration, 'sine', 0.022, i * 0.03));
  }

  // A soft bass pulse on every beat keeps the loop feeling alive
  playMusicTone(chord.bass, 0.6, 'triangle', 0.045);

  // Occasional plucked arpeggio note for texture/sparkle
  if (Math.random() < 0.4) {
    const note = chord.arp[Math.floor(Math.random() * chord.arp.length)];
    playMusicTone(note, 0.35, 'sine', 0.028, 0.15);
  }

  musicBeat = (musicBeat + 1) % 4;
  if (musicBeat === 0) {
    musicChordIndex = (musicChordIndex + 1) % MUSIC_PROGRESSION.length;
  }
}

function stopMusic() {
  clearInterval(musicInterval);
  musicInterval = null;
  musicBeat = 0;
  musicChordIndex = 0;
}


/* ==========================================================================
   SECTION 14: THE GAME ENGINE
   Everything below runs the actual GOHRATOR gameplay on the HTML canvas.
   ========================================================================== */

const canvas = document.getElementById('gameCanvas');
const ctx = canvas.getContext('2d');

// Resizes the drawing surface to match how big the canvas appears on screen,
// accounting for device pixel ratio so it looks sharp on retina screens.
function resizeCanvas() {
  const rect = canvas.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  GAME.width = rect.width;
  GAME.height = rect.height;
}
window.addEventListener('resize', resizeCanvas);

// -------------------- GAME STATE --------------------
const GAME = {
  width: 0,
  height: 0,
  running: false,
  paused: false,
  lastTime: 0,

  // Player rocket
  player: { x: 0, y: 0, w: 34, h: 58, vx: 0, vy: 0, invincible: 0 },

  keys: {}, // currently held keyboard keys

  lives: 3,
  score: 0,
  displayScore: 0, // animates toward `score` for a smooth counting effect
  multiplier: 1.0,
  combo: 0,
  comboTimer: 0,
  distance: 0,
  coinsThisRun: 0,
  level: 1,
  elapsedSeconds: 0,

  obstacles: [],
  coins: [],
  powerups: [],
  particles: [],
  stars: [],

  obstacleTimer: 0,
  coinTimer: 0,
  powerupTimer: 0,

  baseSpeed: 160, // pixels per second, scales up with level
  speedMultiplier: 1,
  difficultyRamp: 0, // continuous 0+ value that grows the longer you survive

  activeEffects: { shield: 0, magnet: 0, speedBoost: 0, scoreBoost: 0 },

  shakeTime: 0
};

const LEVEL_NAMES = ['', 'Rookie Pilot', 'Sky Explorer', 'Space Ranger', 'Rocket Commander', 'Galaxy Master'];

// -------------------- SETUP / RESET --------------------
function resetPreGameUI() {
  document.getElementById('preGameOverlay').classList.remove('hidden');
  document.getElementById('pauseOverlay').classList.add('hidden');
  document.getElementById('gameOverOverlay').classList.add('hidden');
  resizeCanvas();
  drawIdleFrame();
  document.getElementById('touchControls').style.display =
    saveData.settings.controlStyle === 'touch' ? 'flex' : '';
}

function initGameState() {
  resizeCanvas();
  GAME.player.x = GAME.width / 2 - GAME.player.w / 2;
  GAME.player.y = GAME.height - 120;
  GAME.player.vx = 0;
  GAME.player.vy = 0;
  GAME.player.invincible = 1.5;

  GAME.lives = 3;
  GAME.score = 0;
  GAME.displayScore = 0;
  GAME.multiplier = 1.0;
  GAME.combo = 0;
  GAME.comboTimer = 0;
  GAME.distance = 0;
  GAME.coinsThisRun = 0;
  GAME.level = 1;
  GAME.elapsedSeconds = 0;

  GAME.obstacles = [];
  GAME.coins = [];
  GAME.powerups = [];
  GAME.particles = [];

  GAME.obstacleTimer = 0;
  GAME.coinTimer = 0;
  GAME.powerupTimer = 0;
  GAME.speedMultiplier = 1;
  GAME.difficultyRamp = 0;
  GAME.activeEffects = { shield: 0, magnet: 0, speedBoost: 0, scoreBoost: 0 };

  // Generate a starfield for the parallax scrolling background
  GAME.stars = [];
  const starCount = saveData.settings.graphics === 'low' ? 40 : saveData.settings.graphics === 'high' ? 120 : 75;
  for (let i = 0; i < starCount; i++) {
    GAME.stars.push({
      x: Math.random() * GAME.width,
      y: Math.random() * GAME.height,
      size: Math.random() * 2 + 0.5,
      speed: Math.random() * 60 + 30
    });
  }

  updateLivesUI();
  updateActivePowerupsUI();
}

// Draws a single static frame so the canvas isn't blank before the player presses Start.
function drawIdleFrame() {
  ctx.clearRect(0, 0, GAME.width, GAME.height);
  const grad = ctx.createLinearGradient(0, 0, 0, GAME.height);
  grad.addColorStop(0, '#060815');
  grad.addColorStop(1, '#0a0e22');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, GAME.width, GAME.height);
}

// -------------------- START / PAUSE / RESUME / QUIT --------------------
function startGame() {
  ensureAudioContext();
  Sound.launch();
  initGameState();
  document.getElementById('preGameOverlay').classList.add('hidden');
  GAME.running = true;
  GAME.paused = false;
  GAME.lastTime = performance.now();
  requestAnimationFrame(gameLoop);
}

function pauseGame() {
  if (!GAME.running) return;
  GAME.paused = true;
  document.getElementById('pauseOverlay').classList.remove('hidden');
}

function resumeGame() {
  GAME.paused = false;
  document.getElementById('pauseOverlay').classList.add('hidden');
  GAME.lastTime = performance.now();
  requestAnimationFrame(gameLoop);
}

function quitGame() {
  GAME.running = false;
  GAME.paused = false;
  document.getElementById('pauseOverlay').classList.add('hidden');
  goToPage('home');
}

// -------------------- MAIN GAME LOOP --------------------
function gameLoop(now) {
  if (!GAME.running || GAME.paused) return;
  const dt = Math.min((now - GAME.lastTime) / 1000, 0.05); // clamp to avoid big jumps
  GAME.lastTime = now;

  update(dt);
  render();

  if (GAME.running && !GAME.paused) {
    requestAnimationFrame(gameLoop);
  }
}

// -------------------- UPDATE LOGIC --------------------
function update(dt) {
  GAME.elapsedSeconds += dt;

  updateDifficulty();
  updatePlayerMovement(dt);
  updateStars(dt);
  updateObstacles(dt);
  updateCoins(dt);
  updatePowerups(dt);
  updateParticles(dt);
  updateEffects(dt);
  updateScoreAndDistance(dt);
  updateComboDecay(dt);
  animateDisplayScore();
}

// Levels up over time / distance, making the game progressively harder.
// Speed now ramps CONTINUOUSLY the longer you survive (Subway Surfers style)
// instead of jumping only at level milestones — it creeps up every single
// frame so the game always feels like it's quietly accelerating under you.
function updateDifficulty() {
  const newLevel = Math.min(5, 1 + Math.floor(GAME.distance / 800));
  if (newLevel !== GAME.level) {
    GAME.level = newLevel;
    saveData.highestLevel = Math.max(saveData.highestLevel, GAME.level);
    showToast(`🔥 Level Up: ${LEVEL_NAMES[GAME.level]}!`);
  }

  // Continuous time-based ramp: grows every second you stay alive, with
  // diminishing returns so it never becomes literally unplayable.
  // At 0s -> +0.00 | at 30s -> +0.42 | at 60s -> +0.72 | at 120s -> +1.15 | caps near +1.8
  const timeRamp = 1.8 * (1 - Math.exp(-GAME.elapsedSeconds / 55));

  // Small extra kick per level so level-ups still feel meaningfully different,
  // stacked on top of the smooth ramp rather than replacing it.
  const levelKick = (GAME.level - 1) * 0.18;

  const boostKick = GAME.activeEffects.speedBoost > 0 ? 0.6 : 0;

  GAME.speedMultiplier = 1 + timeRamp + levelKick + boostKick;

  // Obstacle/coin/powerup spawn rates also quietly tighten with the same
  // continuous ramp via GAME.difficultyRamp, used elsewhere for spawn timing.
  GAME.difficultyRamp = timeRamp;
}

function updatePlayerMovement(dt) {
  const p = GAME.player;
  const accel = 900;
  const maxSpeed = 340 * (GAME.activeEffects.speedBoost > 0 ? 1.3 : 1);
  const friction = 0.86;

  let ax = 0, ay = 0;
  if (GAME.keys['left'])  ax -= 1;
  if (GAME.keys['right']) ax += 1;
  if (GAME.keys['up'])    ay -= 1;
  if (GAME.keys['down'])  ay += 1;

  p.vx += ax * accel * dt;
  p.vy += ay * accel * dt;
  p.vx *= friction;
  p.vy *= friction;

  p.vx = Math.max(-maxSpeed, Math.min(maxSpeed, p.vx));
  p.vy = Math.max(-maxSpeed, Math.min(maxSpeed, p.vy));

  p.x += p.vx * dt;
  p.y += p.vy * dt;

  // Keep rocket inside the canvas bounds
  p.x = Math.max(4, Math.min(GAME.width - p.w - 4, p.x));
  p.y = Math.max(4, Math.min(GAME.height - p.h - 4, p.y));

  if (p.invincible > 0) p.invincible -= dt;

  // Rocket flame trail particles while flying
  if (Math.random() < 0.6) {
    GAME.particles.push({
      x: p.x + p.w / 2 + (Math.random() - 0.5) * 8,
      y: p.y + p.h - 4,
      vx: (Math.random() - 0.5) * 20 - p.vx * 0.05,
      vy: 90 + Math.random() * 60,
      life: 0.4,
      maxLife: 0.4,
      size: Math.random() * 4 + 2,
      color: Math.random() < 0.5 ? '#ff8a3d' : '#ffd166',
      type: 'flame'
    });
  }
}

function updateStars(dt) {
  GAME.stars.forEach(s => {
    s.y += s.speed * GAME.speedMultiplier * dt;
    if (s.y > GAME.height) {
      s.y = -4;
      s.x = Math.random() * GAME.width;
    }
  });
}

// Spawns and moves obstacles (asteroids, debris, energy storms, planet fragments)
function updateObstacles(dt) {
  GAME.obstacleTimer -= dt;
  if (GAME.obstacleTimer <= 0) {
    spawnObstacle();
    // Spawn interval shrinks with both level AND the continuous time ramp,
    // so obstacles come thicker and faster the longer the flight goes on.
    const baseInterval = 1.3 - (GAME.level - 1) * 0.15 - (GAME.difficultyRamp || 0) * 0.25;
    GAME.obstacleTimer = Math.max(0.32, baseInterval) + Math.random() * 0.4;
  }

  const speed = GAME.baseSpeed * GAME.speedMultiplier;
  for (let i = GAME.obstacles.length - 1; i >= 0; i--) {
    const o = GAME.obstacles[i];
    o.y += speed * dt * o.speedFactor;
    o.rotation += o.rotSpeed * dt;

    if (o.y > GAME.height + 60) {
      GAME.obstacles.splice(i, 1);
      continue;
    }
    checkObstacleCollision(o, i);
  }
}

function spawnObstacle() {
  const types = ['asteroid_small', 'asteroid_medium', 'asteroid_large', 'debris', 'storm', 'fragment'];
  // Weight toward smaller/common obstacles early, bigger ones at higher levels
  const weights = GAME.level <= 2
    ? [0.35, 0.25, 0.05, 0.2, 0.1, 0.05]
    : [0.2, 0.25, 0.2, 0.15, 0.12, 0.08];

  let r = Math.random(), type = types[0], acc = 0;
  for (let i = 0; i < types.length; i++) { acc += weights[i]; if (r <= acc) { type = types[i]; break; } }

  const sizeMap = {
    asteroid_small: 26, asteroid_medium: 40, asteroid_large: 62,
    debris: 34, storm: 70, fragment: 50
  };
  const size = sizeMap[type];

  GAME.obstacles.push({
    x: Math.random() * (GAME.width - size),
    y: -size,
    size,
    type,
    rotation: 0,
    rotSpeed: (Math.random() - 0.5) * 3,
    speedFactor: 0.85 + Math.random() * 0.4
  });
}

function checkObstacleCollision(o, index) {
  const p = GAME.player;
  if (p.invincible > 0) return;

  const dx = (p.x + p.w / 2) - (o.x + o.size / 2);
  const dy = (p.y + p.h / 2) - (o.y + o.size / 2);
  const dist = Math.sqrt(dx * dx + dy * dy);
  const collisionDist = (p.w / 2) + (o.size / 2) * 0.75;

  if (dist < collisionDist) {
    GAME.obstacles.splice(index, 1);
    handleCollision();
  } else if (dist < collisionDist + 40) {
    // "close call" — rewards skillful near-misses with combo points
    if (!o.grazed) {
      o.grazed = true;
      GAME.combo++;
      GAME.comboTimer = 2.5;
      saveData.highestCombo = Math.max(saveData.highestCombo, GAME.combo);
    }
  }
}

function handleCollision() {
  const p = GAME.player;

  if (GAME.activeEffects.shield > 0) {
    // Shield absorbs the hit instead of losing a life
    GAME.activeEffects.shield = 0;
    updateActivePowerupsUI();
    showToast('🛡️ Shield absorbed the hit!');
    spawnExplosionParticles(p.x + p.w / 2, p.y + p.h / 2, 12, '#4dd6ff');
    Sound.collision();
    return;
  }

  GAME.lives--;
  GAME.combo = 0;
  p.invincible = 1.8;
  updateLivesUI();
  Sound.collision();
  vibrate([50, 30, 50]);
  triggerScreenShake();
  spawnExplosionParticles(p.x + p.w / 2, p.y + p.h / 2, 18, '#ff4d4d');

  if (GAME.lives <= 0) {
    endGame();
  }
}

function triggerScreenShake() {
  const wrap = document.querySelector('.canvas-wrap');
  wrap.classList.remove('shake');
  void wrap.offsetWidth;
  wrap.classList.add('shake');
}

function updateLivesUI() {
  const lifeIcons = document.querySelectorAll('#hudLives .life-icon');
  lifeIcons.forEach((icon, i) => {
    icon.classList.toggle('lost', i >= GAME.lives);
  });
}

// -------------------- COINS --------------------
function updateCoins(dt) {
  GAME.coinTimer -= dt;
  if (GAME.coinTimer <= 0) {
    spawnCoin();
    GAME.coinTimer = 0.6 + Math.random() * 0.6;
  }

  const speed = GAME.baseSpeed * GAME.speedMultiplier;
  for (let i = GAME.coins.length - 1; i >= 0; i--) {
    const c = GAME.coins[i];

    // Magnet effect pulls nearby coins toward the player
    if (GAME.activeEffects.magnet > 0) {
      const dx = (GAME.player.x + GAME.player.w / 2) - c.x;
      const dy = (GAME.player.y + GAME.player.h / 2) - c.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < 200) {
        c.x += (dx / dist) * 340 * dt;
        c.y += (dy / dist) * 340 * dt;
      } else {
        c.y += speed * dt;
      }
    } else {
      c.y += speed * dt;
    }
    c.bob += dt * 4;

    if (c.y > GAME.height + 30) { GAME.coins.splice(i, 1); continue; }

    const dx = (GAME.player.x + GAME.player.w / 2) - c.x;
    const dy = (GAME.player.y + GAME.player.h / 2) - c.y;
    if (Math.sqrt(dx * dx + dy * dy) < 26) {
      GAME.coins.splice(i, 1);
      collectCoin(c);
    }
  }
}

function spawnCoin() {
  GAME.coins.push({
    x: Math.random() * (GAME.width - 20) + 10,
    y: -20,
    bob: Math.random() * 10
  });
}

function collectCoin(c) {
  saveData.energyCoins++;
  GAME.coinsThisRun++;
  GAME.score += 25 * GAME.multiplier;
  Sound.coin();
  spawnExplosionParticles(c.x, c.y, 6, '#ffd166');
  saveGame();
}

// -------------------- POWER-UPS --------------------
const POWERUP_TYPES = [
  { id: 'shield', icon: '🛡️', color: '#4dd6ff', duration: 8 },
  { id: 'magnet', icon: '🧲', color: '#9b6bff', duration: 7 },
  { id: 'speedBoost', icon: '⚡', color: '#ffd166', duration: 5 },
  { id: 'scoreBoost', icon: '✖️', color: '#ff8a3d', duration: 6 }
];

function updatePowerups(dt) {
  GAME.powerupTimer -= dt;
  if (GAME.powerupTimer <= 0) {
    spawnPowerup();
    GAME.powerupTimer = 7 + Math.random() * 6;
  }

  const speed = GAME.baseSpeed * GAME.speedMultiplier;
  for (let i = GAME.powerups.length - 1; i >= 0; i--) {
    const pu = GAME.powerups[i];
    pu.y += speed * dt * 0.9;
    pu.rotation += dt * 2;

    if (pu.y > GAME.height + 30) { GAME.powerups.splice(i, 1); continue; }

    const dx = (GAME.player.x + GAME.player.w / 2) - pu.x;
    const dy = (GAME.player.y + GAME.player.h / 2) - pu.y;
    if (Math.sqrt(dx * dx + dy * dy) < 30) {
      GAME.powerups.splice(i, 1);
      collectPowerup(pu);
    }
  }
}

function spawnPowerup() {
  const def = POWERUP_TYPES[Math.floor(Math.random() * POWERUP_TYPES.length)];
  GAME.powerups.push({
    x: Math.random() * (GAME.width - 30) + 15,
    y: -30,
    rotation: 0,
    ...def
  });
}

function collectPowerup(pu) {
  GAME.activeEffects[pu.id] = pu.duration;
  if (pu.id === 'speedBoost') Sound.boost(); else Sound.powerup();
  vibrate([20, 20, 20]);
  spawnExplosionParticles(pu.x, pu.y, 10, pu.color);
  updateActivePowerupsUI();

  const labelMap = { shield: 'Shield', magnet: 'Magnet', speedBoost: 'Speed Boost', scoreBoost: 'Score Boost x2' };
  showToast(`${pu.icon} ${labelMap[pu.id]} Activated!`);

  if (pu.id === 'shield') unlockAchievement('shielded');
  if (pu.id === 'magnet') unlockAchievement('magnetic');
  if (pu.id === 'speedBoost') unlockAchievement('speed_demon');
}

function updateEffects(dt) {
  for (const key in GAME.activeEffects) {
    if (GAME.activeEffects[key] > 0) {
      GAME.activeEffects[key] -= dt;
      if (GAME.activeEffects[key] <= 0) {
        GAME.activeEffects[key] = 0;
      }
    }
  }
  updateActivePowerupsUI();
}

function updateActivePowerupsUI() {
  const container = document.getElementById('activePowerups');
  container.innerHTML = '';
  const labelMap = { shield: '🛡️', magnet: '🧲', speedBoost: '⚡', scoreBoost: '✖️' };
  for (const key in GAME.activeEffects) {
    if (GAME.activeEffects[key] > 0) {
      const badge = document.createElement('div');
      badge.className = 'powerup-badge';
      badge.innerHTML = `${labelMap[key]} <span class="pu-timer">${GAME.activeEffects[key].toFixed(1)}s</span>`;
      container.appendChild(badge);
    }
  }
}

// -------------------- SCORE / DISTANCE / MULTIPLIER / COMBO --------------------
function updateScoreAndDistance(dt) {
  const distGain = GAME.baseSpeed * GAME.speedMultiplier * dt * 0.12;
  GAME.distance += distGain;

  // Multiplier grows gradually the longer the player survives (SCORE ONLY — never money)
  GAME.multiplier = Math.min(3.0, 1.0 + GAME.elapsedSeconds * 0.02);

  const scoreBoostMult = GAME.activeEffects.scoreBoost > 0 ? 2 : 1;
  GAME.score += distGain * GAME.multiplier * scoreBoostMult * 0.5;

  document.getElementById('hudDistance').textContent = Math.floor(GAME.distance);
  document.getElementById('hudMultiplier').textContent = GAME.multiplier.toFixed(1);
  document.getElementById('hudLevel').textContent = GAME.level;
  document.getElementById('hudCoins').textContent = GAME.coinsThisRun;
}

function updateComboDecay(dt) {
  if (GAME.comboTimer > 0) {
    GAME.comboTimer -= dt;
    if (GAME.comboTimer <= 0) GAME.combo = 0;
  }
  const comboEl = document.getElementById('hudCombo');
  if (GAME.combo >= 2) {
    comboEl.style.display = '';
    document.getElementById('hudComboValue').textContent = GAME.combo;
    GAME.score += GAME.combo * 1.5 * GAME.multiplier * dt * 6;
  } else {
    comboEl.style.display = 'none';
  }
}

// Makes the HUD score count up smoothly instead of jumping instantly.
function animateDisplayScore() {
  const diff = GAME.score - GAME.displayScore;
  GAME.displayScore += diff * 0.18;
  document.getElementById('hudScore').textContent = Math.floor(GAME.displayScore).toLocaleString();
}

// -------------------- PARTICLES --------------------
function spawnExplosionParticles(x, y, count, color) {
  for (let i = 0; i < count; i++) {
    const angle = (Math.PI * 2 * i) / count + Math.random() * 0.5;
    const speed = Math.random() * 120 + 60;
    GAME.particles.push({
      x, y,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      life: 0.5 + Math.random() * 0.3,
      maxLife: 0.8,
      size: Math.random() * 3 + 2,
      color,
      type: 'burst'
    });
  }
}

function updateParticles(dt) {
  for (let i = GAME.particles.length - 1; i >= 0; i--) {
    const p = GAME.particles[i];
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.life -= dt;
    if (p.type === 'burst') p.vx *= 0.94, p.vy *= 0.94;
    if (p.life <= 0) GAME.particles.splice(i, 1);
  }
}

// -------------------- RENDERING --------------------
function render() {
  ctx.clearRect(0, 0, GAME.width, GAME.height);

  // Background gradient (deep space)
  const grad = ctx.createLinearGradient(0, 0, 0, GAME.height);
  grad.addColorStop(0, '#060815');
  grad.addColorStop(0.5, '#0b1030');
  grad.addColorStop(1, '#0a0e22');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, GAME.width, GAME.height);

  drawStars();
  drawParticles('flame');
  drawCoins();
  drawPowerups();
  drawObstacles();
  drawPlayer();
  drawParticles('burst');
}

function drawStars() {
  ctx.save();
  GAME.stars.forEach(s => {
    ctx.globalAlpha = 0.6 + Math.sin(s.x) * 0.2;
    ctx.fillStyle = '#cfe0ff';
    ctx.beginPath();
    ctx.arc(s.x, s.y, s.size, 0, Math.PI * 2);
    ctx.fill();
  });
  ctx.restore();
}

function drawPlayer() {
  const p = GAME.player;
  const speedFactor = GAME.speedMultiplier || 1; // rocket "strains" more visually the faster it goes
  ctx.save();
  ctx.translate(p.x + p.w / 2, p.y + p.h / 2);

  // Slight bank/tilt in the direction of travel — sells the sense of speed
  const tilt = Math.max(-0.28, Math.min(0.28, (p.vx || 0) / 260));
  ctx.rotate(tilt);

  // Flicker while invincible (post-collision) to give visual feedback
  if (p.invincible > 0 && Math.floor(p.invincible * 10) % 2 === 0) {
    ctx.globalAlpha = 0.4;
  }

  // Shield glow ring
  if (GAME.activeEffects.shield > 0) {
    ctx.strokeStyle = 'rgba(77,214,255,0.7)';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(0, 0, p.w / 2 + 14, 0, Math.PI * 2);
    ctx.stroke();
    ctx.strokeStyle = 'rgba(77,214,255,0.25)';
    ctx.lineWidth = 6;
    ctx.stroke();
  }

  drawEngineFlame(p, speedFactor);
  drawRocketFins(p);
  drawRocketHull(p);
  drawRocketDetails(p);

  ctx.restore();
}

// ---- Engine flame: layered, multi-nozzle, reacts to speed & boost ----
function drawEngineFlame(p, speedFactor) {
  const boosting = GAME.activeEffects.speedBoost > 0;
  const flameScale = (boosting ? 1.55 : 1) * Math.min(1.4, 0.9 + speedFactor * 0.12);
  const flicker = 0.85 + Math.random() * 0.3;
  const nozzleY = p.h / 2 - 6;

  // Two side booster nozzles + one central main engine, like a real multi-engine rocket
  const nozzles = [
    { ox: -p.w / 3.1, scale: 0.55 },
    { ox: p.w / 3.1, scale: 0.55 },
    { ox: 0, scale: 1 }
  ];

  nozzles.forEach(nz => {
    const s = flameScale * nz.scale;
    ctx.save();
    ctx.translate(nz.ox, nozzleY);

    // outer soft glow
    const grad = ctx.createRadialGradient(0, 6 * s, 1, 0, 10 * s, 16 * s);
    grad.addColorStop(0, 'rgba(255,209,102,0.9)');
    grad.addColorStop(0.5, 'rgba(255,138,61,0.5)');
    grad.addColorStop(1, 'rgba(255,77,77,0)');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(0, 10 * s, 16 * s, 0, Math.PI * 2);
    ctx.fill();

    // outer flame (orange)
    ctx.fillStyle = '#ff8a3d';
    ctx.beginPath();
    ctx.moveTo(-5 * s, 0);
    ctx.quadraticCurveTo(0, 20 * s * flicker, 5 * s, 0);
    ctx.closePath();
    ctx.fill();

    // inner flame (gold/white hot core)
    ctx.fillStyle = '#ffe9a8';
    ctx.beginPath();
    ctx.moveTo(-2.2 * s, 0);
    ctx.quadraticCurveTo(0, 11 * s * flicker, 2.2 * s, 0);
    ctx.closePath();
    ctx.fill();

    ctx.restore();
  });
}

// ---- Fins: three angular stabilizer fins, drawn behind the hull ----
function drawRocketFins(p) {
  const finGrad = ctx.createLinearGradient(0, 0, 0, p.h / 2);
  finGrad.addColorStop(0, '#7d86c4');
  finGrad.addColorStop(1, '#4a5190');

  // Left fin
  ctx.fillStyle = finGrad;
  ctx.beginPath();
  ctx.moveTo(-p.w * 0.22, p.h * 0.14);
  ctx.lineTo(-p.w * 0.62, p.h * 0.5);
  ctx.lineTo(-p.w * 0.62, p.h * 0.36);
  ctx.lineTo(-p.w * 0.24, p.h * 0.30);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,138,61,0.55)';
  ctx.lineWidth = 1;
  ctx.stroke();

  // Right fin (mirror)
  ctx.beginPath();
  ctx.moveTo(p.w * 0.22, p.h * 0.14);
  ctx.lineTo(p.w * 0.62, p.h * 0.5);
  ctx.lineTo(p.w * 0.62, p.h * 0.36);
  ctx.lineTo(p.w * 0.24, p.h * 0.30);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
}

// ---- Hull: nose cone + tapered body with a real capsule silhouette ----
function drawRocketHull(p) {
  const w = p.w, h = p.h;

  ctx.beginPath();
  ctx.moveTo(0, -h / 2);                              // nose tip
  ctx.quadraticCurveTo(w * 0.34, -h * 0.30, w * 0.30, -h * 0.05); // nose shoulder (right)
  ctx.lineTo(w * 0.32, h * 0.28);                      // body straight edge (right)
  ctx.quadraticCurveTo(w * 0.30, h * 0.42, w * 0.16, h * 0.46);   // tail taper (right)
  ctx.lineTo(-w * 0.16, h * 0.46);                     // base
  ctx.quadraticCurveTo(-w * 0.30, h * 0.42, -w * 0.32, h * 0.28); // tail taper (left)
  ctx.lineTo(-w * 0.30, -h * 0.05);                    // body straight edge (left)
  ctx.quadraticCurveTo(-w * 0.34, -h * 0.30, 0, -h / 2); // nose shoulder (left)
  ctx.closePath();

  const bodyGrad = ctx.createLinearGradient(-w / 2, 0, w / 2, 0);
  bodyGrad.addColorStop(0, '#5b628f');
  bodyGrad.addColorStop(0.42, '#eef1ff');
  bodyGrad.addColorStop(0.5, '#c7cdf2');
  bodyGrad.addColorStop(1, '#4a5190');
  ctx.fillStyle = bodyGrad;
  ctx.fill();

  ctx.strokeStyle = 'rgba(20,22,50,0.5)';
  ctx.lineWidth = 1;
  ctx.stroke();

  // Nose cone accent cap (orange tip, like a real rocket's radome)
  ctx.beginPath();
  ctx.moveTo(0, -h / 2);
  ctx.quadraticCurveTo(w * 0.2, -h * 0.36, w * 0.17, -h * 0.24);
  ctx.lineTo(-w * 0.17, -h * 0.24);
  ctx.quadraticCurveTo(-w * 0.2, -h * 0.36, 0, -h / 2);
  ctx.closePath();
  ctx.fillStyle = '#ff8a3d';
  ctx.fill();
}

// ---- Panel lines, cockpit window, and the GOHAR body callsign ----
function drawRocketDetails(p) {
  const w = p.w, h = p.h;

  // Horizontal panel seam lines for a "built from segments" look
  ctx.strokeStyle = 'rgba(20,22,50,0.28)';
  ctx.lineWidth = 1;
  [-h * 0.02, h * 0.20].forEach(y => {
    ctx.beginPath();
    ctx.moveTo(-w * 0.29, y);
    ctx.lineTo(w * 0.29, y);
    ctx.stroke();
  });

  // Cockpit window with a bright specular highlight
  const winY = -h * 0.12;
  const winGrad = ctx.createRadialGradient(-2, winY - 2, 0.5, 0, winY, 7);
  winGrad.addColorStop(0, '#eaffff');
  winGrad.addColorStop(0.4, '#4dd6ff');
  winGrad.addColorStop(1, '#1e6f96');
  ctx.fillStyle = winGrad;
  ctx.beginPath();
  ctx.arc(0, winY, 6.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = '#dfe6ff';
  ctx.lineWidth = 1.2;
  ctx.stroke();

  // "GOHAR" callsign printed vertically down the main body
  ctx.save();
  ctx.rotate(Math.PI / 2);
  ctx.fillStyle = '#3d3580';
  ctx.font = 'bold 7px Arial, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('GOHAR', 0, -h * 0.12 + 1);
  ctx.restore();

  // Small national-flag-style stripe near the base for a "real launch vehicle" touch
  ctx.fillStyle = '#ff8a3d';
  ctx.fillRect(-w * 0.29, h * 0.30, w * 0.58, 2.5);
  ctx.fillStyle = '#4dd6ff';
  ctx.fillRect(-w * 0.29, h * 0.35, w * 0.58, 2.5);
}

function drawObstacles() {
  GAME.obstacles.forEach(o => {
    ctx.save();
    ctx.translate(o.x + o.size / 2, o.y + o.size / 2);
    ctx.rotate(o.rotation);

    if (o.type === 'storm') {
      const grad = ctx.createRadialGradient(0, 0, 0, 0, 0, o.size / 2);
      grad.addColorStop(0, 'rgba(155,107,255,0.9)');
      grad.addColorStop(1, 'rgba(155,107,255,0)');
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(0, 0, o.size / 2, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#9b6bff';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(0, 0, o.size / 3, 0, Math.PI * 1.5);
      ctx.stroke();
    } else if (o.type === 'debris') {
      ctx.fillStyle = '#8a93b8';
      ctx.fillRect(-o.size / 2, -o.size / 4, o.size, o.size / 2);
      ctx.strokeStyle = '#ff8a3d';
      ctx.lineWidth = 1.5;
      ctx.strokeRect(-o.size / 2, -o.size / 4, o.size, o.size / 2);
    } else {
      // asteroid variants + fragment share a rocky look
      const rockGrad = ctx.createRadialGradient(-o.size / 4, -o.size / 4, 2, 0, 0, o.size / 2);
      rockGrad.addColorStop(0, '#7d7a94');
      rockGrad.addColorStop(1, '#3d3a56');
      ctx.fillStyle = rockGrad;
      ctx.beginPath();
      const points = 8;
      for (let i = 0; i < points; i++) {
        const angle = (Math.PI * 2 * i) / points;
        const r = (o.size / 2) * (0.8 + Math.sin(i * 7.3) * 0.2);
        const x = Math.cos(angle) * r, y = Math.sin(angle) * r;
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();
  });
}

function drawCoins() {
  GAME.coins.forEach(c => {
    const bobOffset = Math.sin(c.bob) * 3;
    ctx.save();
    ctx.translate(c.x, c.y + bobOffset);
    const scale = Math.abs(Math.cos(c.bob * 0.7)) * 0.4 + 0.6; // spin illusion
    ctx.scale(scale, 1);

    const grad = ctx.createRadialGradient(-3, -3, 1, 0, 0, 12);
    grad.addColorStop(0, '#fff4d6');
    grad.addColorStop(1, '#ffd166');
    ctx.fillStyle = grad;
    ctx.shadowColor = '#ffd166';
    ctx.shadowBlur = 12;
    ctx.beginPath();
    ctx.arc(0, 0, 11, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  });
}

function drawPowerups() {
  GAME.powerups.forEach(pu => {
    ctx.save();
    ctx.translate(pu.x, pu.y);
    ctx.rotate(pu.rotation);
    ctx.shadowColor = pu.color;
    ctx.shadowBlur = 16;
    ctx.fillStyle = pu.color + '33';
    ctx.beginPath();
    ctx.arc(0, 0, 16, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = pu.color;
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.shadowBlur = 0;
    ctx.font = '16px Arial';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.rotate(-pu.rotation);
    ctx.fillText(pu.icon, 0, 1);
    ctx.restore();
  });
}

function drawParticles(filterType) {
  GAME.particles.filter(p => p.type === filterType).forEach(p => {
    ctx.save();
    ctx.globalAlpha = Math.max(0, p.life / p.maxLife);
    ctx.fillStyle = p.color;
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  });
}

// -------------------- GAME OVER --------------------
function endGame() {
  GAME.running = false;
  Sound.gameOver();

  const session = {
    score: Math.floor(GAME.score),
    distance: Math.floor(GAME.distance),
    coins: GAME.coinsThisRun,
    level: GAME.level,
    maxCombo: saveData.highestCombo,
    elapsedSeconds: GAME.elapsedSeconds
  };

  saveData.totalFlights++;
  saveData.totalDistance += session.distance;
  const isNewRecord = session.score > saveData.highScore;
  if (isNewRecord) saveData.highScore = session.score;
  saveData.highestLevel = Math.max(saveData.highestLevel, session.level);

  const leaderboardEntry = {
    name: saveData.pilotName || 'Pilot',
    score: session.score,
    distance: session.distance,
    level: session.level,
    date: new Date().toISOString()
  };
  addToLeaderboard(leaderboardEntry);
  submitScoreToGlobal(leaderboardEntry); // best-effort, never blocks the UI

  saveGame();
  checkStatAchievements(session);
  updateHeaderStats();

  document.getElementById('goScore').textContent = session.score.toLocaleString();
  document.getElementById('goDistance').textContent = session.distance + 'm';
  document.getElementById('goCoins').textContent = session.coins;
  document.getElementById('goLevel').textContent = session.level;
  document.getElementById('newRecordBadge').style.display = isNewRecord ? '' : 'none';
  if (isNewRecord) showToast('🏆 New High Score!');

  setTimeout(() => {
    document.getElementById('gameOverOverlay').classList.remove('hidden');
  }, 400);
}


/* ==========================================================================
   SECTION 15: INPUT HANDLING (Keyboard + Touch)
   ========================================================================== */

const KEY_MAP = {
  ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down',
  a: 'left', d: 'right', w: 'up', s: 'down',
  A: 'left', D: 'right', W: 'up', S: 'down'
};

window.addEventListener('keydown', (e) => {
  const dir = KEY_MAP[e.key];
  if (dir) { GAME.keys[dir] = true; e.preventDefault(); }
  if (e.key === 'Escape' && GAME.running) {
    GAME.paused ? resumeGame() : pauseGame();
  }
});
window.addEventListener('keyup', (e) => {
  const dir = KEY_MAP[e.key];
  if (dir) { GAME.keys[dir] = false; }
});

// Touch controls: press-and-hold buttons set the same GAME.keys flags used by keyboard
function bindTouchButton(id, dir) {
  const el = document.getElementById(id);
  const start = (e) => { e.preventDefault(); GAME.keys[dir] = true; };
  const end = (e) => { e.preventDefault(); GAME.keys[dir] = false; };
  el.addEventListener('touchstart', start, { passive: false });
  el.addEventListener('touchend', end, { passive: false });
  el.addEventListener('touchcancel', end, { passive: false });
  el.addEventListener('mousedown', start);
  el.addEventListener('mouseup', end);
  el.addEventListener('mouseleave', end);
}
bindTouchButton('touchUp', 'up');
bindTouchButton('touchDown', 'down');
bindTouchButton('touchLeft', 'left');
bindTouchButton('touchRight', 'right');

// Swipe/drag-to-move directly on the canvas as an alternative control scheme
let dragActive = false, lastDragX = 0, lastDragY = 0;
canvas.addEventListener('touchstart', (e) => {
  if (!GAME.running) return;
  dragActive = true;
  const t = e.touches[0];
  lastDragX = t.clientX; lastDragY = t.clientY;
}, { passive: true });
canvas.addEventListener('touchmove', (e) => {
  if (!dragActive || !GAME.running) return;
  const t = e.touches[0];
  const dx = t.clientX - lastDragX, dy = t.clientY - lastDragY;
  GAME.player.x += dx;
  GAME.player.y += dy;
  lastDragX = t.clientX; lastDragY = t.clientY;
}, { passive: true });
canvas.addEventListener('touchend', () => { dragActive = false; }, { passive: true });


/* ==========================================================================
   SECTION 16: BUTTON EVENT WIRING
   ========================================================================== */

document.getElementById('loginBtn').addEventListener('click', handleLogin);
document.getElementById('usernameInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') handleLogin(); });
document.getElementById('guestBtn').addEventListener('click', handleGuestLogin);

document.getElementById('playFromHomeBtn').addEventListener('click', () => { Sound.click(); goToPage('game'); });
document.getElementById('startGameBtn').addEventListener('click', startGame);
document.getElementById('pauseBtn').addEventListener('click', () => { Sound.click(); pauseGame(); });
document.getElementById('resumeBtn').addEventListener('click', () => { Sound.click(); resumeGame(); });
document.getElementById('quitBtn').addEventListener('click', () => { Sound.click(); quitGame(); });
document.getElementById('playAgainBtn').addEventListener('click', () => {
  Sound.click();
  document.getElementById('gameOverOverlay').classList.add('hidden');
  startGame();
});
document.getElementById('returnHomeBtn').addEventListener('click', () => {
  Sound.click();
  document.getElementById('gameOverOverlay').classList.add('hidden');
  goToPage('home');
});


/* ==========================================================================
   SECTION 17: BOOTSTRAP — RUNS ONCE WHEN THE PAGE LOADS
   ========================================================================== */

function init() {
  runSplashScreen();

  // Start music the first time the user interacts with the page (browser
  // autoplay policies require a gesture before audio can begin).
  const startMusicOnce = () => {
    ensureAudioContext();
    startMusic();
    window.removeEventListener('click', startMusicOnce);
    window.removeEventListener('touchstart', startMusicOnce);
  };
  window.addEventListener('click', startMusicOnce);
  window.addEventListener('touchstart', startMusicOnce);
}

init();