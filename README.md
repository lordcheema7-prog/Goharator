# 🚀 GOHRATOR
### **FLY. SURVIVE. CONQUER THE SKY.**

An original, premium-quality futuristic browser arcade survival game built using **pure HTML5, CSS3, and Vanilla JavaScript**.

Control the high-tech **GOHAR** rocket, navigate dense asteroid fields, dodge hazardous space debris, survive cosmic plasma storms, collect glowing energy coins, activate powerful upgrades, and climb the local pilot leaderboard!

---

## 🌟 Key Features

* 🚀 **Custom Futuristic "GOHAR" Rocket**:
  * Procedurally rendered with crisp vector details and the callsign **"GOHAR"** visibly engraved on the hull.
  * Dynamic animated dual-plasma thrusters with particle plume and realistic velocity banking.
  * Temporary invulnerability shield flashes and shield bubble effects.
* ☄️ **Dynamic Obstacles & Cosmic Hazards**:
  * **Asteroids**: Multi-sided rotating polygons with craters and varying sizes.
  * **Space Debris**: Broken satellites and tumbling solar arrays.
  * **Energy Storms**: Pulsing electric plasma spheres with arcing lightning sparks.
  * **Planet Fragments**: Glowing magma molten rocks shedding fiery embers.
* 🪙 **Collectible Energy Coins**:
  * Glowing 3D spinning energy crystals.
  * Floating point pickups and dynamic sound chimes.
* ⚡ **4 Game-Changing Power-Ups**:
  * 🛡️ **Shield**: Absorbs a single direct hit from any obstacle.
  * 🧲 **Magnet**: Gravitationally pulls all nearby coins directly into the ship.
  * ⚡ **Speed Boost**: Hyperspeed flight that smashes through obstacles with temporary invincibility.
  * ✖️ **Score 2x**: Doubles all score gains during its duration.
* 🔥 **Dynamic Combo & Near-Miss Mechanics**:
  * Narrowly dodging obstacles awards instant **NEAR MISS** combos.
  * Chaining coin pickups escalates combo multipliers (up to 5.0x score multiplier).
* 🎯 **Progressive Level Scaling**:
  * Level 1 — *Rookie Pilot* (0m)
  * Level 2 — *Sky Explorer* (3,000m)
  * Level 3 — *Space Ranger* (8,000m)
  * Level 4 — *Rocket Commander* (15,000m)
  * Level 5 — *Galaxy Master* (25,000m+)
* 🏆 **Achievements & Leaderboard System**:
  * 12 distinct unlockable achievements with animated toast alerts.
  * Local Hall of Fame tracking top 10 scores with ranks, distances, and dates.
* 🔊 **Procedural Web Audio API Sound Synthesizer**:
  * 100% offline procedural audio with sound effects and ambient sci-fi synth music.
  * Zero external audio files required.
* 📱 **Full Cross-Device Responsiveness**:
  * Optimized for Desktop, Laptop, Tablet, and Mobile.
  * On-screen touch D-Pad and direct drag flight support.
* 🛡️ **Fair & Skill-Based**:
  * **Zero gambling, betting, real-money, or wagering mechanics.**

---

## 📁 Project Structure

```
Gohrator/
├── index.html       # Single-Page Application with DOM screens, Canvas, HUD, & Modals
├── style.css        # Cyberpunk space theme, Glassmorphism, animations, & responsive styles
├── script.js        # Canvas game engine, procedural audio synthesizer, physics, state manager
└── README.md        # Beginner-friendly documentation and guide
```

---

## 🎮 How to Play

### 💻 Desktop Controls
* **Move Up**: `W` or `↑` (Up Arrow)
* **Move Down**: `S` or `↓` (Down Arrow)
* **Move Left**: `A` or `←` (Left Arrow)
* **Move Right**: `D` or `→` (Right Arrow)
* **Pause Mission**: `Esc` or click the `⏸` button in the HUD

### 📱 Mobile & Tablet Controls
* **On-Screen D-Pad**: Tap ⬆ ⬇ ⬅ ➡ buttons.
* **Direct Touch Drag**: Touch and slide anywhere on the canvas to guide the rocket.
* **Boost Button**: Tap the ⚡ BOOST button for instant emergency maneuvers.

---

## 🚀 How to Run Locally

1. Download or clone this folder to your computer.
2. Simply double-click **`index.html`** to open it directly in any modern web browser (Google Chrome, Microsoft Edge, Mozilla Firefox, Safari, Brave, etc.).
3. No build tools, Node.js servers, or package installations are required!

## ☁️ Publish on Vercel

This project is ready to deploy as a static Vercel site. Import the GitHub repository in Vercel, keep the framework preset as **Other**, leave the build command empty, and set the output directory to `.`. Vercel will serve `index.html` directly.

The game works immediately in offline-first mode: pilot profiles, scores, and settings are stored in the browser. The optional `backend-server.js` API uses local JSON files and should be deployed separately on a stateful Node host if you need a shared global leaderboard or cross-device accounts. Run it locally with `node backend-server.js`. Do not deploy it as a Vercel function expecting its JSON files to persist.

After deploying a backend, set `API_BASE_URL` near the top of `script.js` to its HTTPS URL and configure its `ALLOWED_ORIGIN` environment variable to your Vercel domain.

---

## ⚙️ Technical Details

* **Language**: Vanilla JavaScript (ES6+)
* **Rendering**: HTML5 2D Canvas with sub-pixel resolution (`window.devicePixelRatio`)
* **Audio**: Native Web Audio API (OscillatorNode, BiquadFilterNode, GainNode, AudioBuffer)
* **Storage**: `localStorage` for offline persistence of pilot profile, high scores, coins, and achievements.

---

## 📜 License

Created with ❤️ as an original browser arcade survival experience. Free to use, modify, and distribute.
