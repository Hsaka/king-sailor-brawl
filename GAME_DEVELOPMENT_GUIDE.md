# LittleJS Game Template — Developer Guide

> **Audience:** This document is written for a Large Language Model tasked with creating a new game using this template.
> Read it fully before writing any code. Every decision the template makes is explained here.

---

## Table of Contents

1. [Template at a Glance](#1-template-at-a-glance)
2. [File Structure](#2-file-structure)
3. [Core Architecture — The Three-Layer Model](#3-core-architecture--the-three-layer-model)
4. [HD Rendering Pipeline](#4-hd-rendering-pipeline)
5. [Responsive Scaling System](#5-responsive-scaling-system)
6. [Configuration (config.js)](#6-configuration-configjs)
7. [Asset Management (assets.js + AssetManager)](#7-asset-management-assetsjs--assetmanager)
8. [Scene System](#8-scene-system)
9. [Drawing — DrawUtils API Reference](#9-drawing--drawutils-api-reference)
10. [Animation — Animator API Reference](#10-animation--animator-api-reference)
11. [Floating Particles](#11-floating-particles)
12. [Audio System](#12-audio-system)
13. [Input Handling](#13-input-handling)
14. [Mobile vs Desktop Differences](#14-mobile-vs-desktop-differences)
15. [Step-by-Step: Creating a New Game](#15-step-by-step-creating-a-new-game)
16. [Complete Worked Example — "Clicker Quest"](#16-complete-worked-example--clicker-quest)
17. [Common Pitfalls](#17-common-pitfalls)
18. [Netcode — Rollback Multiplayer System](#18-netcode--rollback-multiplayer-system)
19. [Quick-Reference Cheat Sheet](#19-quick-reference-cheat-sheet)

---

## 1. Template at a Glance

This template is a production-grade LittleJS game starter with:

- **Sharp rendering on all screens** — physical-pixel canvas (1 canvas pixel = 1 screen pixel), correct on retina/HiDPI displays and mobile devices.
- **Responsive scaling** — your game scales to fill any screen size automatically.
- **Scene system** — clean `onEnter / onUpdate / onRender / onExit` lifecycle.
- **Asset pipeline** — declarative asset definitions, preloading with a progress bar.
- **Audio** — ZzFX procedural sounds AND file-based audio, both managed through one system.
- **Canvas2D drawing helpers** — 3D buttons, cards, progress bars, pills, resource counters.
- **Tween system** — frame-based Animator with easing presets.
- **Floating particles** — ready-to-use ambient background decoration.
- **Rollback netcode** — deterministic multiplayer with WebRTC P2P via PeerJS.

The engine used is **LittleJS** (`littlejs.esm.min.js`). It is loaded as an ES module. You do not need to understand LittleJS internals deeply — the template wraps everything you need.

---

## 2. File Structure

```
littlejs-template/
│
├── index.html                  # HTML shell — do not modify
├── style.css                   # Full-viewport CSS — do not modify
├── littlejs.esm.min.js         # LittleJS engine (ES module build) — do not modify
│
├── App.js                      # ★ Bootstrap — HD rendering + scene switching
├── config.js                   # ★ All configuration constants
├── assets.js                   # ★ Asset definitions (textures + audio)
│
├── scenes/
│   ├── DemoScene.js            # Example scene — replace with your scenes
│   └── MultiplayerScene.js     # Multiplayer demo using rollback netcode
│
├── netcode/
│   ├── index.js                # Public API exports
│   ├── engine.js               # RollbackEngine — core rollback logic
│   ├── session.js              # Session — room/player management
│   ├── input-buffer.js         # Input history and prediction tracking
│   ├── snapshot-buffer.js      # Circular buffer for state snapshots
│   ├── messages.js             # Message type definitions
│   ├── encoding.js             # Binary protocol encoding/decoding
│   ├── peerjs-transport.js     # WebRTC transport via PeerJS
│   └── types.js                # Type definitions and constants
│
└── utils/
    ├── ImageCache.js           # Image preloader + synchronous accessor
    ├── AssetManager.js         # Unified asset descriptor accessor
    ├── AudioSystem.js          # ZzFX + file-based audio manager
    ├── DrawUtils.js            # Canvas2D drawing primitives
    ├── Animator.js             # Frame-based tween system
    └── FloatingParticles.js    # Ambient particle background
```

**Files you must modify:** `App.js`, `config.js`, `assets.js`, and everything in `scenes/`.
**Files you must NOT modify:** `index.html`, `style.css`, `littlejs.esm.min.js`, and all `utils/`.

---

## 3. Core Architecture — The Three-Layer Model

Understanding this mental model is essential before writing any game code.

```
┌─────────────────────────────────────────────────┐
│  PHYSICAL CANVAS (browser pixels × DPR)         │  ← mainCanvasSize.x / .y
│  e.g. 2560×1440 on a 1280×720@2× screen         │
├─────────────────────────────────────────────────┤
│  GAME DESIGN SPACE (your reference layout)      │  ← CONFIG.DESIGN_WIDTH / HEIGHT
│  e.g. 800×600 for a desktop game                │  ← game.scale maps between these two
├─────────────────────────────────────────────────┤
│  CSS LOGICAL SPACE (what the user sees)         │  ← window.innerWidth / innerHeight
│  e.g. 1280×720 logical pixels                   │
└─────────────────────────────────────────────────┘
```

**Rule:** All your drawing coordinates are in **physical pixels** (`mainCanvasSize` space).
Multiply every position, size, and font size by **`game.scale`** when placing things on screen.

`game.offsetX` and `game.offsetY` give the physical-pixel top-left corner of your scaled
content area. Use these when you need to place content relative to the game viewport.

---

## 4. HD Rendering Pipeline

The template solves a subtle but critical problem: on high-DPR (retina) screens, a canvas
element sized in CSS pixels is rendered blurry because the browser upscales it.

### How it works

```
gameInit() {
    const physSize = vec2(
        window.innerWidth  × devicePixelRatio,
        window.innerHeight × devicePixelRatio
    );
    setCanvasFixedSize(physSize);   // tell LittleJS to use physical px
    mainCanvasSize.x = physSize.x;  // patch immediately (before first frame)
    mainCanvasSize.y = physSize.y;
}
```

Every render frame, `fixCanvasCSS()` is called:

```js
// Sets canvas.style.width = window.innerWidth + 'px'
//      canvas.style.height = window.innerHeight + 'px'
// This maps the physical-pixel buffer back to logical CSS pixels —
// 1 physical canvas pixel = 1 physical screen pixel. No upscaling.
```

**You do not need to call any of this yourself.** It all happens in `App.js`.

### What this means for you

- `mainCanvasSize.x` and `mainCanvasSize.y` are the physical pixel dimensions. Use these
  as your drawing bounds (they equal `window.inner* × DPR`).
- Never hard-code pixel values. Always multiply by `game.scale`.

---

## 5. Responsive Scaling System

`applyScale()` in `App.js` runs once after assets load and computes `game.scale`.

### Inputs

| Source             | Variable                    | Meaning                            |
|--------------------|-----------------------------|------------------------------------|
| `config.js`        | `CONFIG.DESIGN_WIDTH/HEIGHT`| Your reference layout size         |
| `config.js`        | `CONFIG.MIN_SCALE`          | Prevent content from getting tiny  |
| `config.js`        | `CONFIG.MAX_SCALE`          | Prevent content from getting huge  |
| Screen             | `mainCanvasSize.x/y`        | Physical px dimensions             |
| Screen orientation | `sh > sw`                  | Portrait = mobile                  |

### Outputs stored on `game`

| Field           | Type    | Meaning                                                      |
|-----------------|---------|--------------------------------------------------------------|
| `game.scale`    | number  | Multiply every size/position by this                         |
| `game.isMobile` | boolean | `true` when portrait / small screen                          |
| `game.gameWidth`| number  | Design width in design px (= CONFIG.DESIGN_WIDTH)            |
| `game.gameHeight`| number | Design height in design px (= CONFIG.DESIGN_HEIGHT)          |
| `game.offsetX`  | number  | Physical-px X where your centered content starts             |
| `game.offsetY`  | number  | Physical-px Y where your centered content starts             |
| `game.dpr`      | number  | `window.devicePixelRatio`                                    |

### Example: placing content in the center of the screen

```js
// In onRender():
const sw = mainCanvasSize.x;     // full physical width
const sh = mainCanvasSize.y;     // full physical height
const s  = game.scale;
const cx = sw / 2;               // horizontal center
const cy = sh / 2;               // vertical center

// Draw a 200-design-px wide button centered on screen:
const btnW = 200 * s;
const btnH = 60 * s;
draw3DButton(cx - btnW/2, cy - btnH/2, btnW, btnH, 'Play', 0x70A1FF);
```

### Portrait mobile with fixed design resolution

Set in `config.js`:
```js
USE_TARGET_RESOLUTION: true,
TARGET_RESOLUTION: { width: 720, height: 1280 },
```

When enabled on a portrait screen, `game.gameWidth/Height` becomes `720×1280` instead
of `DESIGN_WIDTH×DESIGN_HEIGHT`, and the scale fills the screen without letterboxing.

---

## 6. Configuration (`config.js`)

`config.js` exports a single `CONFIG` object. Import it anywhere:

```js
import { CONFIG } from '../config.js';        // from a scene
import { CONFIG } from './config.js';         // from App.js level
```

### Key sections to set for your game

```js
export const CONFIG = {
    // ── Identity
    GAME_TITLE: 'My Space Shooter',   // shown on loading screen

    // ── Responsive scaling
    DESIGN_WIDTH:  800,    // your reference canvas width
    DESIGN_HEIGHT: 600,    // your reference canvas height
    MIN_SCALE: 0.4,
    MAX_SCALE: 2.0,

    // ── Audio
    MASTER_VOLUME: 0.8,
    MUSIC_VOLUME:  0.4,
    SFX_VOLUME:    0.8,

    // ── UI design system (colours, fonts, spacing)
    UI: { COLORS: { PRIMARY: 0x70A1FF, ... }, ... },

    // ── YOUR GAME-SPECIFIC SECTION
    PLAYER: {
        SPEED:      250,
        LIVES:      3,
        SHOOT_RATE: 0.25,
    },
    ENEMY: {
        SPAWN_INTERVAL: 2.0,
        SPEED:          80,
    },
};
```

**Important:** `CONFIG` values that involve sizes should be in **design pixels** (before
`game.scale` is applied). Multiply by `game.scale` at draw time. Do not mutate CONFIG
inside game loops — CONFIG is for constant definitions.

### UI Design System colours

Colours in the UI system are 24-bit hex integers (NOT CSS strings):

```js
CONFIG.UI.COLORS.PRIMARY      // 0x70A1FF
CONFIG.UI.COLORS.SUCCESS      // 0x7BED9F
CONFIG.UI.COLORS.WARNING      // 0xFFA502
CONFIG.UI.COLORS.DANGER       // 0xFF6B6B
CONFIG.UI.COLORS.GOLD         // 0xFFD700
CONFIG.UI.COLORS.PANEL_BG     // 0x3d3d5c
```

Pass them directly to `DrawUtils` functions — they handle hex → CSS conversion internally.

---

## 7. Asset Management (`assets.js` + `AssetManager`)

### Defining assets (`assets.js`)

Every texture and audio file is declared as a keyed entry:

```js
export const ASSETS = {
    // ── Textures (images)
    playerShip: {
        type:   'texture',
        source: 'file',
        path:   'images/player-ship.png',   // relative to index.html
    },

    explosion: {
        type:   'texture',
        source: 'file',
        path:   'images/explosion.png',
    },

    // ── Procedural audio (ZzFX)
    shootSfx: {
        type:   'audio',
        source: 'procedural',
        volume: 0.8,
        // ZzFX array: [volume, randomness, freq, attack, sustain, release, shape, ...]
        params: [1, 0, 440, 0.01, 0.05, 0.1, 1, 1.5, 0, 0, 0, 0, 0, 1],
    },

    // ── File-based audio
    explosionSfx: {
        type:   'audio',
        source: 'file',
        volume: 1.0,
        path:   'audio/explosion.mp3',
    },

    // ── Background music
    music: {
        type:   'audio',
        source: 'file',
        volume: 0.3,
        path:   'audio/theme.mp3',
        loop:   true,
    },
};
```

All `source: 'file'` textures are automatically preloaded before the game starts.
The loading screen progress bar reflects this.

### Using assets in scenes

```js
import { assetManager } from '../utils/AssetManager.js';

// ── Images
const img = assetManager.getImage('playerShip');   // HTMLImageElement | null
if (assetManager.hasImage('playerShip')) {
    ctx.drawImage(img, x, y, w, h);
}

// ── Audio (see AudioSystem section for playback)
const sfxConfig = assetManager.getAudio('shootSfx');
```

### ZzFX parameter guide

ZzFX parameters are an array: `[volume, randomness, frequency, attack, sustain, release, shape, shapeCurve, slide, deltaSlide, pitchJump, pitchJumpTime, repeatTime, noise, modulation, bitCrush, delay, sustainVolume, decay, tremolo]`

For quick sounds without deep knowledge:
- **Short click**: `[0.5, 0, 300, 0.01, 0.02, 0.05, 0, 1]`
- **Positive chime**: `[1, 0, 523, 0.01, 0.1, 0.2, 0, 1.5, 0, 0, 0, 0, 0, 1]`
- **Laser fire**: `[1.5, 0, 440, 0.01, 0.05, 0.1, 1, 1.5, 0, 0, 0, 0, 0, 1]`
- **Explosion**: `[1, 0.3, 80, 0.01, 0.3, 0.5, 4, 1, -0.5, 0, 0, 0, 0, 20]`
- **Game over**: `[1, 0, 220, 0.05, 0.3, 0.5, 1, 1, 0, 0, 0, 0, 0, 1]`

Reference: https://github.com/KilledByAPixel/ZzFX

---

## 8. Scene System

### Scene lifecycle

Every scene is a plain JavaScript class with these methods:

```js
export class MyScene {
    constructor(data = {}) {
        // Allocate objects here. data is whatever was passed to switchScene().
    }

    onEnter(data = {}) {
        // Called once when the scene becomes active.
        // Load images from assetManager, reset state, start music.
    }

    onUpdate() {
        // Called every logic frame (~60 fps).
        // Advance dt = 1/60. Update game objects, read input, run animator.
    }

    onRender() {
        // Called every render frame.
        // Draw everything to mainContext. Rebuild button hit-areas here.
    }

    onExit() {
        // Called before the scene is destroyed.
        // Clear the animator, stop music, release references.
    }

    onRenderPost() {
        // Optional. Called after LittleJS composites the WebGL layer.
        // Use for HUD overlays drawn on top of everything.
    }
}
```

### Registering scenes in `App.js`

1. Import your scene class at the top of `App.js`:
```js
import { MenuScene } from './scenes/MenuScene.js';
import { GameScene } from './scenes/GameScene.js';
```

2. Add cases to `switchScene()`:
```js
export function switchScene(name, data = {}) {
    if (game.currentScene) game.currentScene.onExit();
    engineObjectsDestroy();

    if (name === 'menu') {
        game.currentScene = new MenuScene(data);
    } else if (name === 'game') {
        game.currentScene = new GameScene(data);
    }
    game.currentScene.onEnter(data);
}
```

3. Change the initial scene in `gameInit()`:
```js
setTimeout(() => {
    game.isLoading = false;
    applyScale();
    switchScene('menu');   // ← your first scene
}, 300);
```

### Switching scenes from a button

```js
import { switchScene } from '../App.js';

// In a button callback:
regBtn(x, y, w, h, 'play', () => switchScene('game', { mode: 'easy' }));

// In GameScene constructor:
constructor(data = {}) {
    this.mode = data.mode ?? 'normal';
}
```

### Storing shared game state

The `game` object in `App.js` is the global state store. Add your fields there:

```js
// In App.js:
export const game = {
    currentScene:    null,
    audioSystem:     null,
    scale:           1,
    isMobile:        false,
    // ... scaling fields ...

    // YOUR GAME STATE:
    score:           0,
    highScore:       0,
    lives:           3,
    level:           1,
};
```

Persist high scores with `localStorage`:
```js
function loadHighScore() {
    try { return parseInt(localStorage.getItem('myGameHighScore') || '0', 10); } catch { return 0; }
}
function saveHighScore(s) {
    try { localStorage.setItem('myGameHighScore', s.toString()); } catch {}
}
```

---

## 9. Drawing — `DrawUtils` API Reference

Import from `../utils/DrawUtils.js`. All coordinates are in **physical pixels**.
All size parameters should be multiplied by `game.scale`.

```js
import {
    drawRoundRect, drawScreenText, measureText,
    draw3DButton, draw3DCard, drawPill,
    drawProgressBar, drawResourceCounter,
    drawIconButton, drawModalOverlay, drawNumberDisplay,
    hexCss, darken,
} from '../utils/DrawUtils.js';
```

### `drawRoundRect(x, y, w, h, r, fillColor, strokeColor?, strokeWidth?, alpha?)`

General-purpose rounded rectangle.

```js
// Filled panel:
drawRoundRect(100, 200, 300, 150, 12, CONFIG.UI.COLORS.PANEL_BG);

// Outlined only:
drawRoundRect(100, 200, 300, 150, 12, null, '#FFD700', 2);

// Semi-transparent fill + border:
drawRoundRect(100, 200, 300, 150, 12, CONFIG.UI.COLORS.PANEL_BG, 0x70A1FF, 2, 0.85);
```

- `fillColor` / `strokeColor`: either a 24-bit hex integer (e.g. `0x70A1FF`) or a CSS string.
- Pass `null` for `fillColor` to skip fill (stroke only), and for `strokeColor` to skip stroke (fill only).

### `drawScreenText(text, x, y, size, color?, align?, baseline?, fontFamily?, bold?)`

```js
// Centred heading:
drawScreenText('GAME OVER', cx, cy, 48 * s, '#FF6B6B', 'center', 'middle', 'Arial', true);

// Left-aligned body text:
drawScreenText('Score: 1042', x, y, 18 * s, '#ffffff', 'left', 'top');
```

Defaults: `color='#ffffff'`, `align='center'`, `baseline='middle'`, `font='Arial'`, `bold=false`.

### `measureText(text, size, bold?, fontFamily?) → number`

Returns the width in physical pixels — use for dynamic layout:

```js
const w = measureText('Hello', 24 * s, true);
// Draw a background box exactly wide enough:
drawRoundRect(x - 8, y - 4, w + 16, 32 * s, 6, 0x3d3d5c);
drawScreenText('Hello', x, y, 24 * s, '#fff', 'left', 'middle', 'Arial', true);
```

### `draw3DButton(x, y, w, h, label, color, pressed?, hovered?)`

Renders a 3-D push button with shadow, face, and highlight sheen.

```js
draw3DButton(btnX, btnY, btnW, btnH, '▶  Play', CONFIG.UI.COLORS.PRIMARY,
    isPressed, isHovered);
```

- `color`: 24-bit hex integer
- `pressed` / `hovered` affect shadow depth and face colour — pass boolean state from your hit-test

### `draw3DCard(x, y, w, h, color?)`

Renders a panel with a 3-D bottom shadow and a subtle border sheen.

```js
draw3DCard(cardX, cardY, cardW, cardH, CONFIG.UI.COLORS.PANEL_BG);
```

### `drawPill(x, y, text, color, icon?, scale?, center?) → { width, height }`

A rounded pill badge, optionally with an emoji icon prefix.

```js
// Plain pill:
drawPill(x, y, 'Round 3', 0x70A1FF, null, s);

// With icon, centered:
drawPill(0, y, '⭐  x 5', 0xFFD700, null, s, true);
```

### `drawProgressBar(x, y, w, current, max, color?, scale?) → { width, height }`

Draws a rounded progress bar with a highlight sheen and max-value label.

```js
drawProgressBar(barX, barY, barW, this.health, this.maxHealth, CONFIG.UI.COLORS.DANGER, s);
drawProgressBar(barX, barY, barW, this.xp, this.maxXp, CONFIG.UI.COLORS.SUCCESS, s);
```

### `drawResourceCounter(x, y, icon, value, color?, scale?) → { width, height }`

Compact icon + number combination used for HUD resource displays.

```js
drawResourceCounter(10, 10, '💎', game.gems, CONFIG.UI.COLORS.PANEL_BG, s);
drawResourceCounter(10, 80, '❤️', game.lives, 0x3d1a1a, s);
```

### `drawIconButton(x, y, size, icon, color, pressed?, hovered?)`

A square emoji/icon button with the same 3-D treatment as `draw3DButton`.

```js
drawIconButton(sw - 70 * s, 10 * s, 56 * s, '🔊', CONFIG.UI.COLORS.PANEL_BG, false, hovered);
```

### `drawModalOverlay(sw, sh)`

Draws a semi-transparent black overlay across the entire canvas — use as the first step when rendering a modal dialog.

```js
if (this._showModal) {
    drawModalOverlay(sw, sh);
    draw3DCard(cx - 150*s, cy - 100*s, 300*s, 200*s);
    // ... modal content ...
}
```

### `drawNumberDisplay(cx, y, label, value, color, scale?)`

A vertically-stacked label + large number with a drop shadow — suited for score/level displays in modals.

```js
drawNumberDisplay(cx, cy - 60*s, 'SCORE', game.score, CONFIG.UI.COLORS.GOLD, s);
drawNumberDisplay(cx, cy + 20*s, 'BEST', game.highScore, CONFIG.UI.COLORS.PRIMARY, s);
```

### `hexCss(hex, alpha?) → string`

Converts a 24-bit hex integer to `rgba(r,g,b,a)`. Useful when Canvas2D needs a CSS string:

```js
ctx.fillStyle = hexCss(CONFIG.UI.COLORS.PRIMARY);        // opaque
ctx.strokeStyle = hexCss(0xFF6B6B, 0.6);                 // semi-transparent
```

### `darken(hex, amount) → number`

Darkens (amount > 0) or lightens (amount < 0) a hex colour by a fraction (0–1).

```js
const shadow = darken(0x70A1FF, 0.3);   // 30% darker, returns hex int
const bright = darken(0x70A1FF, -0.1);  // 10% lighter
```

---

## 10. Animation — `Animator` API Reference

```js
import { Animator } from '../utils/Animator.js';

// Create one per scene:
this.animator = new Animator();

// Call every update frame:
this.animator.update(1/60);

// Clear on exit:
this.animator.clear();
```

### `animate({ target, property, from, to, duration, ease?, onUpdate?, onComplete? })`

Tweens `target[property]` from `from` to `to` over `duration` seconds.

```js
// Slide a panel in from the right:
this.panelX = sw;                         // start off-screen
this.animator.animate({
    target: this, property: 'panelX',
    from: sw, to: sw/2 - 150*s,
    duration: 0.4, ease: 'easeOut',
});

// Fade out on completion then switch scene:
this.animator.animate({
    target: this, property: '_alpha',
    from: 1, to: 0, duration: 0.3,
    onComplete: () => switchScene('game'),
});
```

Available easing functions: `'linear'`, `'easeIn'`, `'easeOut'`, `'easeInOut'`, `'bounce'`, `'elastic'`

### `delay(seconds, callback)`

Schedule a callback without animating a property:

```js
this.animator.delay(2.0, () => {
    this._showBonusText = false;
    switchScene('menu');
});
```

### Convenience shortcuts

```js
this.animator.fadeIn(this, 0.4);     // animates this.alpha 0→1
this.animator.fadeOut(this, 0.3, () => switchScene('menu'));   // 1→0 then callback
this.animator.scalePop(this, 0.3);   // animates this.scale 0.5→1 with bounce
```

For shortcuts to work, the target object must have an `alpha` or `scale` property that you use when drawing. Example:

```js
// In your scene:
this.alpha = 0;

// In onRender():
c.save();
c.globalAlpha = this.alpha;
// ... draw scene contents ...
c.restore();
```

---

## 11. Floating Particles

Background ambient particles that float up from the bottom of the screen with a glow effect.

```js
import { FloatingParticles } from '../utils/FloatingParticles.js';

this.fp = new FloatingParticles();

// onEnter:
this.fp.reset();

// onUpdate:
this.fp.update(1/60, mainCanvasSize.x, mainCanvasSize.y);

// onRender (draw AFTER background, BEFORE UI):
this.fp.render(mainContext, game.scale);
```

Configure particle behaviour in `config.js` under `FLOATING_PARTICLES`:

```js
FLOATING_PARTICLES: {
    MAX_COUNT:    100,
    SPAWN_RATE:   0.55,
    COLORS:       ['#70A1FF', '#FFD700', '#FFFFFF'],
    SIZE_MIN:     1.5,   SIZE_MAX:     4,
    ALPHA_MIN:    0.2,   ALPHA_MAX:    0.4,
    LIFETIME_MIN: 10,    LIFETIME_MAX: 20,   // seconds
    SPEED_MIN:    10,    SPEED_MAX:    35,   // px/s
    WOBBLE_AMPLITUDE: 15,
    GLOW_BLUR:    8,
},
```

---

## 12. Audio System

The `AudioSystem` is created in `App.js` and stored at `game.audioSystem`. You never
construct it yourself — just call methods on it.

```js
game.audioSystem.play('shootSfx');       // play any key from ASSETS
game.audioSystem.playUIClick();           // built-in wrapper
game.audioSystem.playConfirm();
game.audioSystem.playDeny();
game.audioSystem.toggleMute();            // returns new muted state
game.audioSystem.startMusic();            // starts ASSETS.music
game.audioSystem.stopMusic();
game.audioSystem.setMasterVolume(0.5);   // 0-1
game.audioSystem.setMusicVolume(0.3);
game.audioSystem.setSFXVolume(0.8);
```

### Adding named wrappers for your sounds

In `utils/AudioSystem.js`, add methods like:

```js
playShoot()          { this.play('shootSfx'); }
playExplosion()      { this.play('explosionSfx'); }
playLevelComplete()  { this.play('levelComplete'); }
```

Then at the call site:
```js
if (game.audioSystem) game.audioSystem.playShoot();
```

Always guard with `if (game.audioSystem)` — during the loading phase, it exists but
muted scenes may call these methods before the game is fully initialised.

---

## 13. Input Handling

LittleJS provides input utilities. Import what you need:

```js
import {
    mouseWasPressed,
    mouseIsDown,
    mousePosScreen,
    keyWasPressed,
    keyIsDown,
} from '../littlejs.esm.min.js';
```

### Mouse / Touch

```js
// Was the primary button just pressed this frame?
if (mouseWasPressed(0)) {
    const mx = mousePosScreen.x;  // physical px
    const my = mousePosScreen.y;
    const btn = hitTest(mx, my);
    if (btn) btn.cb();
}

// Is mouse button held?
if (mouseIsDown(0)) { /* drag logic */ }
```

`mousePosScreen` is automatically scaled to physical pixels — it matches coordinates in
`mainCanvasSize` space.

### Keyboard

```js
// Movement:
if (keyIsDown('ArrowLeft') || keyIsDown('KeyA')) { /* move left */ }
if (keyIsDown('ArrowRight') || keyIsDown('KeyD')) { /* move right */ }

// Action keys (once per press):
if (keyWasPressed('Space')) { player.shoot(); }
if (keyWasPressed('Escape')) { switchScene('menu'); }
```

### Button Registry Pattern

Because button positions change with `game.scale`, rebuild the hit-area list every
render frame (not every update frame — it belongs in `onRender`):

```js
// Module-level list (or class field):
let _buttons = [];

function regBtn(x, y, w, h, id, cb) {
    _buttons.push({ x, y, w, h, id, cb });
}

function hitTest(mx, my) {
    for (let i = _buttons.length - 1; i >= 0; i--) {
        const b = _buttons[i];
        if (mx >= b.x && mx <= b.x + b.w && my >= b.y && my <= b.y + b.h) return b;
    }
    return null;
}

// In onRender() — reset first, then register:
_buttons = [];   // <-- CRITICAL: reset each frame
// ... draw button ...
regBtn(btnX, btnY, btnW, btnH, 'play', () => switchScene('game'));

// In onUpdate() — detect click:
if (mouseWasPressed(0)) {
    const btn = hitTest(mousePosScreen.x, mousePosScreen.y);
    if (btn) {
        if (game.audioSystem) game.audioSystem.playUIClick();
        btn.cb();
    }
}
```

### Hover detection

```js
// onUpdate():
this._hovered = hitTest(mousePosScreen.x, mousePosScreen.y);

// onRender() when drawing a button:
const isHovered = this._hovered && this._hovered.id === 'play';
draw3DButton(x, y, w, h, 'Play', 0x70A1FF, false, isHovered);
```

---

## 14. Mobile vs Desktop Differences

The template detects orientation via `game.isMobile = mainCanvasSize.y > mainCanvasSize.x`.

### Layout adjustments

```js
const s  = game.scale;
const cx = mainCanvasSize.x / 2;
const cy = mainCanvasSize.y / 2;

// Conditionally reposition elements:
const titleY = cy - (game.isMobile ? 280 : 200) * s;
const btnY   = cy + (game.isMobile ? 150 : 100) * s;

// Larger tap targets on mobile:
const btnH = (game.isMobile ? 70 : 56) * s;
```

### Touch vs mouse

LittleJS maps touch events to `mouseWasPressed(0)` and `mousePosScreen` automatically.
No extra touch code is required.

### Portrait filling the screen

For games designed for mobile portrait (e.g. 720×1280), set:
```js
USE_TARGET_RESOLUTION: true,
TARGET_RESOLUTION: { width: 720, height: 1280 },
```
This tells `applyScale()` to pick a scale that fills the portrait screen edge-to-edge
rather than letterboxing.

---

## 15. Step-by-Step: Creating a New Game

### Step 1 — Configure

Edit `config.js`:
```js
GAME_TITLE:    'My Game Name',
DESIGN_WIDTH:  800,
DESIGN_HEIGHT: 600,
// Add your game constants:
PLAYER: { SPEED: 250, LIVES: 3 },
ENEMY:  { SPEED: 80, SPAWN_INTERVAL: 2.0 },
```

### Step 2 — Define assets

Edit `assets.js` with your textures and sounds. Keep source `'procedural'` for sounds
until you have audio files — ZzFX works out-of-the-box with no files.

### Step 3 — Create scenes

Create `scenes/MenuScene.js` and `scenes/GameScene.js`.
Start each file with this scaffold:

```js
import { mainContext, mainCanvasSize, mouseWasPressed, mousePosScreen } from '../littlejs.esm.min.js';
import { CONFIG }             from '../config.js';
import { game, switchScene }  from '../App.js';
import { assetManager }       from '../utils/AssetManager.js';
import { drawRoundRect, drawScreenText, draw3DButton, drawIconButton, hexCss } from '../utils/DrawUtils.js';
import { Animator }           from '../utils/Animator.js';
import { FloatingParticles }  from '../utils/FloatingParticles.js';

let _buttons = [];
const regBtn  = (x,y,w,h,id,cb) => _buttons.push({x,y,w,h,id,cb});
const hitTest = (mx,my) => { for(let i=_buttons.length-1;i>=0;i--){const b=_buttons[i];if(mx>=b.x&&mx<=b.x+b.w&&my>=b.y&&my<=b.y+b.h)return b;} return null; };

export class MenuScene {
    constructor(data={}) {
        this.animator = new Animator();
        this.fp       = new FloatingParticles();
        this._hovered = null;
        this._time    = 0;
        this.alpha    = 0;
    }

    onEnter() {
        _buttons = [];
        this.fp.reset();
        this.animator.fadeIn(this, 0.4);
        if (game.audioSystem) game.audioSystem.startMusic();
    }

    onUpdate() {
        const dt = 1/60;
        this._time += dt;
        this.animator.update(dt);
        this.fp.update(dt, mainCanvasSize.x, mainCanvasSize.y);
        this._hovered = hitTest(mousePosScreen.x, mousePosScreen.y);
        if (mouseWasPressed(0)) {
            const btn = hitTest(mousePosScreen.x, mousePosScreen.y);
            if (btn) { if(game.audioSystem)game.audioSystem.playUIClick(); btn.cb(); }
        }
    }

    onRender() {
        const c = mainContext;
        const sw = mainCanvasSize.x, sh = mainCanvasSize.y;
        const s = game.scale, cx = sw/2, cy = sh/2;
        _buttons = [];   // rebuild each frame

        // Background
        const g = c.createLinearGradient(0,0,0,sh);
        g.addColorStop(0, CONFIG.BACKGROUND_GRADIENT.START);
        g.addColorStop(1, CONFIG.BACKGROUND_GRADIENT.END);
        c.fillStyle = g; c.fillRect(0,0,sw,sh);

        this.fp.render(c, s);

        c.save(); c.globalAlpha = this.alpha;

        // Title
        drawScreenText(CONFIG.GAME_TITLE, cx, cy - 150*s, 52*s, '#70A1FF', 'center', 'middle', 'Arial', true);

        // Play button
        const bw=260*s, bh=60*s, bx=cx-bw/2, by=cy-bh/2;
        const hov = this._hovered?.id === 'play';
        draw3DButton(bx, by, bw, bh, '▶  Play', CONFIG.UI.COLORS.PRIMARY, false, hov);
        regBtn(bx, by, bw, bh, 'play', () => switchScene('game'));

        c.restore();
    }

    onExit() { this.animator.clear(); this.fp.reset(); if(game.audioSystem)game.audioSystem.stopMusic(); }
    onRenderPost(){}
}
```

### Step 4 — Wire scenes in `App.js`

```js
import { MenuScene } from './scenes/MenuScene.js';
import { GameScene } from './scenes/GameScene.js';

// In switchScene():
if (name === 'menu')      game.currentScene = new MenuScene(data);
else if (name === 'game') game.currentScene = new GameScene(data);

// In gameInit() setTimeout callback:
switchScene('menu');
```

Remove the `DemoScene` import and its case from `switchScene`.

### Step 5 — Add game state to `game`

In `App.js`:
```js
export const game = {
    // ... existing scaling fields ...
    score:     0,
    highScore: loadHighScore(),
    lives:     3,
    level:     1,
};
```

### Step 6 — Implement `GameScene`

Build your game loop inside `GameScene.onUpdate()`. Use `mainContext` directly for
Canvas2D drawing in `GameScene.onRender()`.

---

## 16. Complete Worked Example — "Clicker Quest"

A simple click-counter game demonstrating every template system.

### `config.js` additions

```js
CLICKER: {
    POINTS_PER_CLICK:   1,
    COMBO_TIME:         0.5,    // seconds between clicks to build combo
    MAX_COMBO:          10,
    COMBO_MULTIPLIER:   0.5,    // extra points per combo level
},
```

### `assets.js`

```js
export const ASSETS = {
    clickSfx: {
        type: 'audio', source: 'procedural', volume: 0.7,
        params: [0.6, 0.1, 400, 0.005, 0.02, 0.04, 0, 1.2],
    },
    comboSfx: {
        type: 'audio', source: 'procedural', volume: 1.0,
        params: [1, 0, 660, 0.01, 0.1, 0.2, 0, 2, 0, 0, 0, 0, 0, 1],
    },
    music: { type: 'audio', source: 'disabled', volume: 0.3 },
};
```

Add `clickSfx` / `comboSfx` named wrappers to `AudioSystem.js`:
```js
playClick() { this.play('clickSfx'); }
playCombo()  { this.play('comboSfx'); }
```

### `App.js` additions

```js
export const game = {
    // (existing scaffold fields)
    currentScene: null, audioSystem: null,
    scale: 1, isMobile: false,
    gameWidth: 0, gameHeight: 0, offsetX: 0, offsetY: 0, dpr: 1,
    isLoading: true, loadingProgress: 0, _scaled: false,

    // Clicker Quest state:
    score:     0,
    highScore: (() => { try { return parseInt(localStorage.getItem('cqHigh')||'0'); } catch { return 0; } })(),
    combo:     0,
};

// Add save function:
export function checkHighScore(s) {
    if (s > game.highScore) {
        game.highScore = s;
        try { localStorage.setItem('cqHigh', s); } catch {}
        return true;
    }
    return false;
}
```

### `scenes/GameScene.js`

```js
import { mainContext, mainCanvasSize, mouseWasPressed, mousePosScreen } from '../littlejs.esm.min.js';
import { CONFIG }            from '../config.js';
import { game, switchScene, checkHighScore }  from '../App.js';
import { drawRoundRect, drawScreenText, draw3DButton, drawIconButton, drawProgressBar, hexCss } from '../utils/DrawUtils.js';
import { Animator }          from '../utils/Animator.js';
import { FloatingParticles } from '../utils/FloatingParticles.js';

let _buttons = [];
const regBtn  = (x,y,w,h,id,cb) => _buttons.push({x,y,w,h,id,cb});
const hitTest = (mx,my) => { for(let i=_buttons.length-1;i>=0;i--){const b=_buttons[i];if(mx>=b.x&&mx<=b.x+b.w&&my>=b.y&&my<=b.y+b.h)return b;} return null; };

const GOAL = 50;   // clicks to win

export class GameScene {
    constructor() {
        this.animator        = new Animator();
        this.fp              = new FloatingParticles();
        this._hovered        = null;
        this._time           = 0;
        this.alpha           = 0;

        // Game state
        this.clicks          = 0;
        this.combo           = 0;
        this._lastClickTime  = 0;
        this._floatingTexts  = [];   // { text, x, y, alpha, vy }
        this._btnScale       = 1;
        this._btnPulse       = 0;
    }

    onEnter() {
        _buttons = [];
        this.fp.reset();
        game.score  = 0;
        game.combo  = 0;
        this.clicks = 0;
        this.animator.fadeIn(this, 0.5);
    }

    onUpdate() {
        const dt   = 1/60;
        this._time += dt;
        this.animator.update(dt);
        this.fp.update(dt, mainCanvasSize.x, mainCanvasSize.y);

        // Pulse the button gently
        this._btnPulse = 1 + Math.sin(this._time * 4) * 0.02;

        // Advance floating texts
        for (let i = this._floatingTexts.length - 1; i >= 0; i--) {
            const ft = this._floatingTexts[i];
            ft.y     -= 60 * dt;
            ft.alpha -= dt * 1.5;
            if (ft.alpha <= 0) this._floatingTexts.splice(i, 1);
        }

        // Combo timeout
        if (this._time - this._lastClickTime > CONFIG.CLICKER.COMBO_TIME && this.combo > 0) {
            this.combo = 0;
            game.combo = 0;
        }

        this._hovered = hitTest(mousePosScreen.x, mousePosScreen.y);

        if (mouseWasPressed(0)) {
            const btn = hitTest(mousePosScreen.x, mousePosScreen.y);
            if (btn) { if(game.audioSystem)game.audioSystem.playUIClick(); btn.cb(); }
        }
    }

    _handleClick(x, y) {
        // Combo logic
        const now = this._time;
        if (now - this._lastClickTime <= CONFIG.CLICKER.COMBO_TIME) {
            this.combo = Math.min(this.combo + 1, CONFIG.CLICKER.MAX_COMBO);
        } else {
            this.combo = 0;
        }
        this._lastClickTime = now;
        game.combo = this.combo;

        // Score
        const pts = CONFIG.CLICKER.POINTS_PER_CLICK +
                    Math.floor(this.combo * CONFIG.CLICKER.COMBO_MULTIPLIER);
        game.score += pts;
        this.clicks++;

        // SFX
        if (game.audioSystem) {
            if (this.combo >= 3) game.audioSystem.playCombo();
            else                 game.audioSystem.playClick();
        }

        // Floating text
        this._floatingTexts.push({ text: `+${pts}`, x, y, alpha: 1, vy: 0 });

        // Button pop animation
        this.animator.animate({
            target: this, property: '_btnScale',
            from: 1.15, to: 1, duration: 0.2, ease: 'easeOut',
        });

        // Win condition
        if (this.clicks >= GOAL) {
            checkHighScore(game.score);
            this.animator.delay(1.2, () => switchScene('menu'));
        }
    }

    onRender() {
        const c  = mainContext;
        const sw = mainCanvasSize.x, sh = mainCanvasSize.y;
        const s  = game.scale, cx = sw/2, cy = sh/2;
        _buttons = [];

        // Background
        const g = c.createLinearGradient(0, 0, 0, sh);
        g.addColorStop(0, CONFIG.BACKGROUND_GRADIENT.START);
        g.addColorStop(1, CONFIG.BACKGROUND_GRADIENT.END);
        c.fillStyle = g; c.fillRect(0, 0, sw, sh);

        this.fp.render(c, s);
        c.save(); c.globalAlpha = this.alpha;

        // Score display
        drawScreenText(`${game.score}`, cx, 80*s, 64*s, '#FFD700', 'center', 'middle', 'Arial', true);
        drawScreenText(`best: ${game.highScore}`, cx, 140*s, 18*s, '#a0b4cc', 'center', 'middle');

        // Progress bar
        drawProgressBar(cx - 150*s, 170*s, 300*s, this.clicks, GOAL, CONFIG.UI.COLORS.SUCCESS, s);
        drawScreenText(`${this.clicks} / ${GOAL} clicks`, cx, 205*s, 14*s, '#a0b4cc', 'center', 'middle');

        // Combo pill
        if (this.combo > 0) {
            const label = `🔥 x${this.combo} combo`;
            const col   = this.combo >= 5 ? CONFIG.UI.COLORS.GOLD : CONFIG.UI.COLORS.WARNING;
            drawScreenText(label, cx, 240*s, 20*s, hexCss(col), 'center', 'middle', 'Arial', true);
        }

        // Big clickable button
        const bs  = this._btnScale;
        const bw  = 200*s*bs, bh = 200*s*bs;
        const bx  = cx - bw/2, by = cy - bh/2 + 30*s;
        const hov = this._hovered?.id === 'click';

        c.save();
        c.shadowColor = '#70A1FF';
        c.shadowBlur  = 20 + Math.sin(this._time*4) * 10;
        drawRoundRect(bx, by, bw, bh, bw/2, CONFIG.UI.COLORS.PRIMARY);
        c.restore();
        drawScreenText('🎯', cx, by + bh/2, 80*s);
        regBtn(bx, by, bw, bh, 'click', () => this._handleClick(cx, by));

        // Back button
        const backW=80*s, backH=36*s, backX=16*s, backY=16*s;
        draw3DButton(backX, backY, backW, backH, '← Menu', CONFIG.UI.COLORS.PANEL_BG,
            false, this._hovered?.id==='back');
        regBtn(backX, backY, backW, backH, 'back', () => switchScene('menu'));

        // Floating "+N" texts
        for (const ft of this._floatingTexts) {
            c.save();
            c.globalAlpha = ft.alpha;
            drawScreenText(ft.text, ft.x, ft.y, 28*s, '#FFD700', 'center', 'middle', 'Arial', true);
            c.restore();
        }

        c.restore();   // end fade alpha
    }

    onExit()       { this.animator.clear(); this.fp.reset(); }
    onRenderPost() {}
}
```

---

## 17. Common Pitfalls

### ❌ Forgetting `game.scale`

```js
// WRONG — hard-coded pixels look fine on one screen, wrong on others:
draw3DButton(100, 500, 260, 60, 'Play', 0x70A1FF);

// CORRECT — always scale every coordinate and size:
const s = game.scale;
draw3DButton(cx - 130*s, cy + 200*s, 260*s, 60*s, 'Play', 0x70A1FF);
```

### ❌ Not resetting `_buttons` in `onRender`

```js
// WRONG — buttons accumulate every frame and click detection breaks:
onRender() {
    regBtn(x, y, w, h, 'play', () => switchScene('game'));
}

// CORRECT — reset at the START of onRender:
onRender() {
    _buttons = [];
    // ... draw ...
    regBtn(x, y, w, h, 'play', () => switchScene('game'));
}
```

### ❌ Reading `mainCanvasSize` too early

Never read `mainCanvasSize` before `gameInit()` returns. It will have wrong logical-pixel
values until `App.js` patches it.

### ❌ Mutating CONFIG values in game loops

CONFIG is for constants. If you need runtime-mutable state, store it on `game.*`:
```js
// WRONG:
CONFIG.PLAYER.SPEED *= 1.1;  // breaks on scene restart

// CORRECT:
game.playerSpeed = CONFIG.PLAYER.SPEED;
game.playerSpeed *= 1.1;
```

### ❌ Drawing without `c.save()` / `c.restore()`

Canvas state (font, fillStyle, globalAlpha, shadowBlur) leaks between draw calls.
Always wrap modified state in save/restore:

```js
c.save();
c.globalAlpha = 0.5;
c.shadowColor = 'red';
c.shadowBlur  = 20;
// ... draw ...
c.restore();
// Now shadow and alpha are back to default
```

### ❌ Playing audio before user interaction

Browsers block audio until the user has interacted with the page. The template
starts audio in `onEnter()` of the first interactive scene (not during loading).
Never call `startMusic()` or `play()` from `gameInit()`.

---

## 18. Netcode — Rollback Multiplayer System

This template includes a production-grade rollback netcode implementation for peer-to-peer multiplayer games using WebRTC (via PeerJS).

### Overview

The netcode system provides:
- **Deterministic rollback** — Predicts remote inputs, rolls back and resimulates when predictions are wrong
- **State synchronization** — Automatic hash verification detects desyncs
- **Peer-to-peer networking** — Uses WebRTC via PeerJS for direct browser-to-browser connections
- **Session management** — Room creation, joining, player lifecycle events

### Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  Session (session.js)                                           │
│  - Room lifecycle (create, join, leave)                         │
│  - Player management, events, state transitions                 │
├─────────────────────────────────────────────────────────────────┤
│  RollbackEngine (engine.js)                                     │
│  - Input prediction for remote players                          │
│  - Snapshot save/restore for rollback                           │
│  - Resimulation when mispredictions detected                    │
├─────────────────────────────────────────────────────────────────┤
│  InputBuffer (input-buffer.js)                                  │
│  - Per-player input history                                     │
│  - Prediction tracking (predicted vs received)                  │
│  - Misprediction detection                                      │
├─────────────────────────────────────────────────────────────────┤
│  SnapshotBuffer (snapshot-buffer.js)                            │
│  - Circular buffer of game states                               │
│  - O(1) lookup by tick                                          │
│  - Binary search for nearest snapshot                           │
├─────────────────────────────────────────────────────────────────┤
│  PeerJSTransport (peerjs-transport.js)                          │
│  - WebRTC data channel management                               │
│  - Connection lifecycle, keepalive, RTT metrics                 │
├─────────────────────────────────────────────────────────────────┤
│  Encoding (encoding.js) + Messages (messages.js)                │
│  - Binary protocol for network efficiency                       │
│  - Message types: Input, Hash, Sync, Join, etc.                 │
└─────────────────────────────────────────────────────────────────┘
```

### Game Interface

Your game class must implement these methods:

```js
class MyGame {
    step(inputs) {
        // Advance one frame (16.67ms at 60fps)
        // inputs: Map<playerId, Uint8Array>
    }

    serialize() {
        // Return Uint8Array representing full game state
    }

    deserialize(data) {
        // Restore state from Uint8Array
    }

    hash() {
        // Return 32-bit hash (number) for desync detection
    }
}
```

### Complete Multiplayer Game Example

```js
import {
    createSession,
    PeerJSTransport,
    SessionState,
    PlayerConnectionState,
} from '../netcode/index.js';

const INPUT_LEFT  = 0x01;
const INPUT_RIGHT = 0x02;
const INPUT_UP    = 0x04;
const INPUT_DOWN  = 0x08;

class MultiplayerGame {
    constructor() {
        this.players = new Map();
        this.localPlayerId = null;
    }

    setLocalPlayerId(id) {
        this.localPlayerId = id;
    }

    addPlayer(id, x = 200, y = 200, color = '#70A1FF') {
        this.players.set(id, { x, y, color });
    }

    removePlayer(id) {
        this.players.delete(id);
    }

    step(inputs) {
        const speed = 5;
        for (const [playerId, input] of inputs) {
            const player = this.players.get(playerId);
            if (!player) continue;

            if (input[0] & INPUT_LEFT)  player.x -= speed;
            if (input[0] & INPUT_RIGHT) player.x += speed;
            if (input[0] & INPUT_UP)    player.y -= speed;
            if (input[0] & INPUT_DOWN)  player.y += speed;
        }
    }

    serialize() {
        const count = this.players.size;
        const encoder = new TextEncoder();
        
        let bufferSize = 4;
        for (const [id] of this.players) {
            bufferSize += 1 + encoder.encode(id).length + 8;
        }
        
        const buffer = new ArrayBuffer(bufferSize);
        const view = new DataView(buffer);
        const uint8View = new Uint8Array(buffer);

        view.setUint32(0, count, true);
        let offset = 4;

        for (const [id, player] of this.players) {
            const idBytes = encoder.encode(id);
            view.setUint8(offset, idBytes.length);
            offset += 1;
            uint8View.set(idBytes, offset);
            offset += idBytes.length;
            view.setFloat32(offset, player.x, true);
            offset += 4;
            view.setFloat32(offset, player.y, true);
            offset += 4;
        }

        return new Uint8Array(buffer);
    }

    deserialize(data) {
        const view = new DataView(data.buffer, data.byteOffset);
        const count = view.getUint32(0, true);
        let offset = 4;

        this.players.clear();
        const decoder = new TextDecoder();

        for (let i = 0; i < count; i++) {
            const idLen = view.getUint8(offset);
            offset += 1;
            const idBytes = new Uint8Array(data.buffer, data.byteOffset + offset, idLen);
            const id = decoder.decode(idBytes);
            offset += idLen;
            const x = view.getFloat32(offset, true);
            offset += 4;
            const y = view.getFloat32(offset, true);
            offset += 4;
            this.players.set(id, { x, y, color: this.getPlayerColor(id) });
        }
    }

    hash() {
        let h = 0;
        for (const [id, player] of this.players) {
            h = ((h << 5) - h + Math.floor(player.x * 100)) | 0;
            h = ((h << 5) - h + Math.floor(player.y * 100)) | 0;
            for (let i = 0; i < id.length; i++) {
                h = ((h << 5) - h + id.charCodeAt(i)) | 0;
            }
        }
        return h >>> 0;
    }

    getPlayerColor(id) {
        const colors = ['#70A1FF', '#FF6B6B', '#7BED9F', '#FFA502'];
        let hash = 0;
        for (let i = 0; i < id.length; i++) {
            hash = ((hash << 5) - hash + id.charCodeAt(i)) | 0;
        }
        return colors[Math.abs(hash) % colors.length];
    }

    updateLocalInput() {
        let input = 0;
        if (keyIsDown('ArrowLeft') || keyIsDown('KeyA')) input |= INPUT_LEFT;
        if (keyIsDown('ArrowRight') || keyIsDown('KeyD')) input |= INPUT_RIGHT;
        if (keyIsDown('ArrowUp') || keyIsDown('KeyW')) input |= INPUT_UP;
        if (keyIsDown('ArrowDown') || keyIsDown('KeyS')) input |= INPUT_DOWN;
        return new Uint8Array([input]);
    }
}
```

### Creating a Session

```js
// In your scene:
this.game = new MultiplayerGame();
this.peer = null;
this.transport = null;
this.session = null;

async hostGame() {
    this.peer = new Peer();  // PeerJS constructor
    
    this.peer.on('open', (id) => {
        this.game.setLocalPlayerId(id);
        this.game.addPlayer(id, 200, 200, '#70A1FF');

        this.transport = new PeerJSTransport(id);
        this.transport.setPeerInstance(this.peer);

        this.session = createSession({
            game: this.game,
            transport: this.transport,
            config: { 
                tickRate: 60,
                maxPlayers: 4,
                debug: false,
            },
        });

        this.setupSessionEvents();
        this.session.createRoom();
    });
}

async joinGame(hostPeerId) {
    this.peer = new Peer();
    
    this.peer.on('open', (id) => {
        this.game.setLocalPlayerId(id);
        this.game.addPlayer(id, 300, 200);

        this.transport = new PeerJSTransport(id);
        this.transport.setPeerInstance(this.peer);

        this.session = createSession({
            game: this.game,
            transport: this.transport,
        });

        this.setupSessionEvents();
        this.session.joinRoom(hostPeerId, hostPeerId);
    });
}

setupSessionEvents() {
    this.session.on('playerJoined', (player) => {
        this.game.addPlayer(player.id, 300, 200);
        console.log(`Player ${player.id} joined`);
    });

    this.session.on('playerLeft', (player) => {
        this.game.removePlayer(player.id);
        console.log(`Player ${player.id} left`);
    });

    this.session.on('stateChange', (newState, oldState) => {
        // SessionState: Disconnected, Connecting, Lobby, Playing, Paused
        console.log(`State: ${oldState} -> ${newState}`);
    });

    this.session.on('gameStart', () => {
        console.log('Game started!');
    });

    this.session.on('desync', (tick, localHash, remoteHash) => {
        console.warn(`Desync at tick ${tick}`);
    });

    this.session.on('error', (err, ctx) => {
        console.error('Session error:', err.message, ctx);
    });
}
```

### Game Loop Integration

```js
onUpdate() {
    if (this.session && this.session.state === SessionState.Playing) {
        const input = this.game.updateLocalInput();
        const result = this.session.tick(input);
        
        // result = { tick, rolledBack, rollbackTicks?, error? }
        if (result.rolledBack) {
            console.log(`Rolled back ${result.rollbackTicks} ticks`);
        }
    }
}
```

### Session API Reference

#### Properties

| Property | Type | Description |
|----------|------|-------------|
| `state` | `SessionState` | Current session state |
| `players` | `Map<id, PlayerInfo>` | Connected players |
| `localPlayerId` | `string` | Your player ID |
| `isHost` | `boolean` | True if you created the room |
| `currentTick` | `number` | Current simulation tick |
| `confirmedTick` | `number` | Tick where all inputs are confirmed |

#### Methods

| Method | Description |
|--------|-------------|
| `createRoom()` | Create a new room (host only) |
| `joinRoom(roomId, hostPeerId)` | Join an existing room |
| `leaveRoom()` | Leave the current room |
| `start()` | Start the game (host only) |
| `pause(reason?)` | Pause the game (host only) |
| `resume()` | Resume the game (host only) |
| `tick(input)` | Advance simulation one frame |
| `on(event, handler)` | Subscribe to events |
| `off(event, handler)` | Unsubscribe from events |
| `destroy()` | Clean up resources |

#### Events

| Event | Arguments | Description |
|-------|-----------|-------------|
| `playerJoined` | `(playerInfo)` | New player joined |
| `playerLeft` | `(playerInfo)` | Player disconnected |
| `gameStart` | `()` | Game started |
| `stateChange` | `(newState, oldState)` | Session state changed |
| `desync` | `(tick, localHash, remoteHash)` | Desync detected |
| `error` | `(error, context)` | Error occurred |
| `lagReport` | `(playerId, ticksBehind)` | Player is lagging |
| `resumeCountdown` | `(secondsRemaining)` | Resume countdown update |

### Configuration Options

```js
const config = {
    tickRate: 60,                    // Frames per second
    maxPlayers: 4,                   // Maximum players in room
    topology: Topology.Star,         // Star (host relay) or Mesh (P2P)
    snapshotHistorySize: 120,        // Snapshots to keep (2 seconds at 60fps)
    maxSpeculationTicks: 60,         // Max frames ahead without confirmation
    hashInterval: 60,                // Hash comparison frequency (frames)
    disconnectTimeout: 5000,         // MS before considering peer dead
    debug: false,                    // Enable debug logging
    desyncAuthority: DesyncAuthority.Host, // Who resolves desyncs
    lagReportThreshold: 30,          // Frames behind to trigger lag report
    inputRedundancy: 3,              // Redundant input packets
    joinRateLimitRequests: 3,        // Join request rate limit
    joinRateLimitWindowMs: 10000,    // Rate limit window
};
```

### Input Prediction

By default, the engine predicts missing remote inputs by repeating the last confirmed input. Customize prediction:

```js
const customPredictor = {
    predict(playerId, tick, lastConfirmedInput) {
        // Return predicted input for this tick
        // lastConfirmedInput is the last known good input (Uint8Array | undefined)
        return lastConfirmedInput ?? new Uint8Array([0]);
    }
};

this.session = createSession({
    game: this.game,
    transport: this.transport,
    inputPredictor: customPredictor,
});
```

### Transport Configuration

```js
const transport = new PeerJSTransport(localPeerId, {
    connectionTimeout: 60000,    // MS to wait for connection
    keepaliveInterval: 5000,     // MS between keepalive checks
    keepaliveTimeout: 15000,     // MS without response = disconnect
});

transport.setPeerInstance(peer);  // Connect to PeerJS instance

// Events:
transport.onMessage = (peerId, data) => { };
transport.onConnect = (peerId) => { };
transport.onDisconnect = (peerId) => { };
transport.onError = (peerId, error, type) => { };
```

### Rollback Engine Direct Usage

For advanced use cases, use the engine directly:

```js
import { RollbackEngine, InputBuffer, SnapshotBuffer } from '../netcode/index.js';

const engine = new RollbackEngine({
    game: myGame,
    localPlayerId: 'player1',
    snapshotHistorySize: 120,
    maxSpeculationTicks: 60,
    inputPredictor: customPredictor,
    onRollback: (restoreTick) => {
        console.log(`Rolled back to tick ${restoreTick}`);
    },
    onPlayerAddDuringResimulation: (playerId, tick) => { },
    onPlayerRemoveDuringResimulation: (playerId, tick) => { },
});

engine.addPlayer('player2', 0);
engine.setLocalInput(0, new Uint8Array([INPUT_RIGHT]));
engine.receiveRemoteInput('player2', 0, new Uint8Array([INPUT_LEFT]));

const result = engine.tick();
// result = { tick: 0, rolledBack: false }
```

### Binary Protocol

Messages are encoded as binary for efficiency:

| Message Type | Code | Purpose |
|--------------|------|---------|
| `Input` | `0x01` | Player input (with redundancy) |
| `Hash` | `0x10` | State hash for desync detection |
| `Sync` | `0x11` | Full state synchronization |
| `SyncRequest` | `0x12` | Request state sync |
| `JoinRequest` | `0x30` | Request to join room |
| `JoinAccept` | `0x31` | Accept join request |
| `JoinReject` | `0x32` | Reject join request |
| `PlayerJoined` | `0x34` | Broadcast player joined |
| `PlayerLeft` | `0x35` | Broadcast player left |
| `Pause`/`Resume` | `0x20`/`0x21` | Game pause/resume |
| `Ping`/`Pong` | `0x40`/`0x41` | Latency measurement |

### Best Practices

1. **Deterministic simulation** — Ensure identical results on all clients for same inputs. Avoid:
   - `Math.random()` (use seeded RNG)
   - Floating-point edge cases
   - Iteration order dependencies (use sorted arrays)

2. **Input size** — Keep inputs small (1-8 bytes typical). Larger inputs increase bandwidth and rollback cost.

3. **State size** — Smaller states serialize faster and reduce bandwidth. Consider delta compression for large states.

4. **Hash consistency** — Your `hash()` must produce identical values for identical states across all clients.

5. **Graceful degradation** — Handle `rolledBack` events to update visual interpolation.

### Common Pitfalls

#### Non-deterministic state

```js
// WRONG — Map iteration order is not guaranteed
for (const [id, player] of this.players) {
    hash = ((hash << 5) - hash + player.x) | 0;
}

// CORRECT — Use sorted iteration
const sortedIds = [...this.players.keys()].sort();
for (const id of sortedIds) {
    const player = this.players.get(id);
    hash = ((hash << 5) - hash + player.x) | 0;
}
```

#### Forgetting to handle rollback visuals

```js
// Visual interpolation can become stale after rollback
this.session.on('playerJoined', (player) => {
    // Reset interpolation for this player
    this.visualPositions.delete(player.id);
});
```

#### Not cleaning up on exit

```js
onExit() {
    if (this.session) {
        this.session.leaveRoom();
        this.session.destroy();
    }
    if (this.peer) {
        this.peer.destroy();
    }
}
```

---

## 19. Quick-Reference Cheat Sheet

### Imports

```js
// LittleJS:
import { mainContext, mainCanvasSize, mouseWasPressed, mouseIsDown,
         mousePosScreen, keyWasPressed, keyIsDown } from '../littlejs.esm.min.js';

// Template:
import { CONFIG }                        from '../config.js';
import { game, switchScene }             from '../App.js';
import { assetManager }                  from '../utils/AssetManager.js';
import { drawRoundRect, drawScreenText, measureText,
         draw3DButton, draw3DCard, drawPill,
         drawProgressBar, drawResourceCounter,
         drawIconButton, drawModalOverlay,
         drawNumberDisplay, hexCss, darken } from '../utils/DrawUtils.js';
import { Animator }                      from '../utils/Animator.js';
import { FloatingParticles }             from '../utils/FloatingParticles.js';

// Netcode (for multiplayer):
import {
    createSession,
    Session,
    RollbackEngine,
    PeerJSTransport,
    SessionState,
    PlayerConnectionState,
    MessageType,
    Topology,
    DesyncAuthority,
} from '../netcode/index.js';
```

### Key variables

| Variable              | Type     | Value                                          |
|-----------------------|----------|------------------------------------------------|
| `mainCanvasSize.x`    | number   | Canvas width in physical px                    |
| `mainCanvasSize.y`    | number   | Canvas height in physical px                   |
| `mainContext`         | ctx2D    | The 2D Canvas rendering context                |
| `game.scale`          | number   | Scale factor: design px → physical px          |
| `game.isMobile`       | boolean  | true when portrait / small screen              |
| `game.offsetX/Y`      | number   | Physical-px top-left of content area           |
| `game.audioSystem`    | object   | AudioSystem singleton (always guard with `if`) |
| `mousePosScreen.x/y`  | number   | Cursor position in physical px                  |

### Scene skeleton (copy-paste ready)

```js
import { mainContext, mainCanvasSize, mouseWasPressed, mousePosScreen } from '../littlejs.esm.min.js';
import { CONFIG }            from '../config.js';
import { game, switchScene } from '../App.js';
import { drawRoundRect, drawScreenText, draw3DButton, hexCss } from '../utils/DrawUtils.js';
import { Animator }          from '../utils/Animator.js';
import { FloatingParticles } from '../utils/FloatingParticles.js';

let _buttons = [];
const regBtn  = (x,y,w,h,id,cb) => _buttons.push({x,y,w,h,id,cb});
const hitTest = (mx,my) => { for(let i=_buttons.length-1;i>=0;i--){const b=_buttons[i];if(mx>=b.x&&mx<=b.x+b.w&&my>=b.y&&my<=b.y+b.h)return b;}return null; };

export class MyScene {
    constructor(data={}) {
        this.animator = new Animator();
        this.fp       = new FloatingParticles();
        this._hovered = null;
        this._time    = 0;
        this.alpha    = 0;
    }

    onEnter(data={}) {
        _buttons = [];
        this.fp.reset();
        this.animator.fadeIn(this, 0.4);
    }

    onUpdate() {
        const dt = 1/60;
        this._time += dt;
        this.animator.update(dt);
        this.fp.update(dt, mainCanvasSize.x, mainCanvasSize.y);
        this._hovered = hitTest(mousePosScreen.x, mousePosScreen.y);
        if (mouseWasPressed(0)) {
            const btn = hitTest(mousePosScreen.x, mousePosScreen.y);
            if (btn) { if(game.audioSystem)game.audioSystem.playUIClick(); btn.cb(); }
        }
    }

    onRender() {
        const c = mainContext;
        const sw = mainCanvasSize.x, sh = mainCanvasSize.y;
        const s = game.scale, cx = sw/2, cy = sh/2;
        _buttons = [];  // ← ALWAYS reset here

        // Background
        const g = c.createLinearGradient(0,0,0,sh);
        g.addColorStop(0, CONFIG.BACKGROUND_GRADIENT.START);
        g.addColorStop(1, CONFIG.BACKGROUND_GRADIENT.END);
        c.fillStyle = g; c.fillRect(0,0,sw,sh);

        this.fp.render(c, s);

        c.save(); c.globalAlpha = this.alpha;
        // ── Draw your scene here ──
        c.restore();
    }

    onExit()       { this.animator.clear(); this.fp.reset(); }
    onRenderPost() {}
}
```
