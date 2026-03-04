/**
 * App.js — LittleJS game bootstrap template.
 *
 * Provides:
 *   • HD canvas rendering  (physical-pixel canvas, 1:1 DPR precision)
 *   • Responsive scaling   (applyScale / updateOffsets / fixCanvasCSS)
 *   • Scene switching      (switchScene)
 *   • Asset loading screen (progress bar, weighted image + audio)
 *   • Global `game` state  (extend with your own fields)
 *
 * ── HOW THE HD RENDERING WORKS ──────────────────────────────────────────────
 *
 * Goal: 1 physical pixel = 1 canvas pixel — no blurry upscaling.
 *
 *   canvas.width  / height  = window.innerWidth/Height × devicePixelRatio
 *   canvas.style.width/height = window.innerWidth/Height  (CSS / logical px)
 *
 * LittleJS mechanism: setCanvasFixedSize(physW, physH) tells the engine to
 * keep the canvas at these pixel dimensions every frame.  updateCanvas() then
 * sets ONE of style.width / style.height to '100%' and clears the other —
 * which can leave the canvas oversized on screen.  fixCanvasCSS() (called
 * every gameRender frame) repairs this by setting BOTH style dimensions back
 * to logical-pixel values.
 *
 * Timing note: gameInit() runs BEFORE the first updateCanvas() so
 * mainCanvasSize still holds old logical-pixel values.  We patch it in-place
 * immediately so applyScale() sees correct physical-px values on its first call.
 *
 * ── HOW RESPONSIVE SCALING WORKS ────────────────────────────────────────────
 *
 * applyScale() fits CONFIG.DESIGN_WIDTH × CONFIG.DESIGN_HEIGHT (your reference
 * layout) into the physical canvas, clamped by MIN_SCALE / MAX_SCALE.  The
 * result is stored in game.scale.  Every drawing call multiplies sizes by
 * game.scale to stay proportional.
 *
 * game.offsetX / offsetY give the top-left corner of the centered content
 * area, updated every frame by updateOffsets().
 *
 * ── HOW TO ADD SCENES ────────────────────────────────────────────────────────
 *
 * 1. Create a class in scenes/ implementing:
 *      onEnter(data)  — called once when scene becomes active
 *      onUpdate()     — called every logic frame (60 fps)
 *      onRender()     — called every render frame
 *      onExit()       — called before scene is replaced
 *      onRenderPost() — (optional) called after the WebGL composite
 *
 * 2. Import the class here and add a case to switchScene().
 */

import {
    engineInit,
    engineObjectsDestroy,
    setCameraScale,
    setCanvasFixedSize,
    setCanvasClearColor,
    setGLEnable,
    setTilesPixelated,
    setCanvasPixelated,
    setShowSplashScreen,
    setSoundEnable,
    setSoundVolume,
    setFontDefault,
    mainCanvasSize,
    mainContext,
    vec2, rgb,
    setTouchGamepadEnable,
    setTouchGamepadSize
} from './littlejs.esm.min.js';

import { CONFIG } from './config.js';
import { AudioSystem } from './utils/AudioSystem.js';
import { imageCache } from './utils/ImageCache.js';
import { assetManager } from './utils/AssetManager.js';

// ── Import your scenes here ──────────────────────────────────────────────────
import { MenuScene } from './scenes/MenuScene.js';
import { LobbyScene } from './scenes/LobbyScene.js';
import { GameScene } from './scenes/GameScene.js';
import { ResultsScene } from './scenes/ResultsScene.js';

import { ConfigOverlay } from './ui/ConfigOverlay.js';

// ── Global game state ────────────────────────────────────────────────────────
// Add your own game-wide fields here (score, lives, level, etc.)
export const game = {
    currentScene: null,
    audioSystem: null,

    // Scaling state (read-only from scenes)
    scale: 1,     // current scale factor (physical px per design px)
    isMobile: false, // true when screen is portrait / small
    gameWidth: 0,     // design width in design px (= CONFIG.DESIGN_WIDTH)
    gameHeight: 0,     // design height in design px
    offsetX: 0,     // physical-px X of top-left of scaled content
    offsetY: 0,     // physical-px Y of top-left of scaled content
    dpr: 1,     // window.devicePixelRatio

    // Internal
    isLoading: true,
    loadingProgress: 0,
    _scaled: false,
    orientation: null,
    refreshedIntoLandscape: localStorage.getItem('refreshedIntoLandscape') === 'true',
    configOverlay: null
};

// ── HD canvas helpers ────────────────────────────────────────────────────────

/** Returns the physical pixel size of the viewport (innerW/H × DPR). */
function getPhysicalSize() {
    const dpr = window.devicePixelRatio || 1;
    return vec2(
        Math.round(window.innerWidth * dpr),
        Math.round(window.innerHeight * dpr),
    );
}

/**
 * Overrides both CSS dimensions of every canvas every frame.
 *
 * LittleJS's updateCanvas() sets only ONE of style.width / style.height to
 * '100%' and leaves the other at the raw canvas attribute value — which is a
 * physical-pixel count, making the canvas enormous on high-DPR screens.
 * This function restores both to logical-pixel values so the physical buffer
 * maps 1:1 to physical screen pixels without any CSS upscaling.
 */
function fixCanvasCSS() {
    const w = window.innerWidth + 'px';
    const h = window.innerHeight + 'px';
    document.querySelectorAll('canvas').forEach(c => {
        if (c.style.width !== w) c.style.width = w;
        if (c.style.height !== h) c.style.height = h;
    });
}

// ── Responsive scaling ───────────────────────────────────────────────────────

/**
 * Runs once (after mainCanvasSize is patched) to compute game.scale.
 *
 * The scale factor maps from design pixels to physical screen pixels.
 * Drawing code multiplies every size / position by game.scale to maintain
 * the same visual layout across all screens.
 */
function applyScale() {
    if (game._scaled) return;

    const sw = mainCanvasSize.x;   // physical width
    const sh = mainCanvasSize.y;   // physical height

    game.isMobile = true;       // portrait orientation → treat as mobile
    game.dpr = window.devicePixelRatio || 1;

    if (CONFIG.USE_TARGET_RESOLUTION && game.isMobile) {
        // Portrait / mobile: pin to a fixed design resolution and fill screen.
        game.gameWidth = CONFIG.TARGET_RESOLUTION.width;
        game.gameHeight = CONFIG.TARGET_RESOLUTION.height;
    } else {
        game.gameWidth = CONFIG.DESIGN_WIDTH;
        game.gameHeight = CONFIG.DESIGN_HEIGHT;
    }

    const marginX = game.isMobile ? CONFIG.MARGIN_X_MOBILE : CONFIG.MARGIN_X_DESKTOP;
    const marginY = game.isMobile ? CONFIG.MARGIN_Y_MOBILE : CONFIG.MARGIN_Y_DESKTOP;
    const availW = sw - marginX * 2;
    const availH = sh - marginY * 2;

    let scale = Math.min(availW / game.gameWidth, availH / game.gameHeight);

    if (CONFIG.USE_TARGET_RESOLUTION && game.isMobile) {
        scale = Math.max(CONFIG.MIN_SCALE, scale);
    } else {
        scale = Math.max(CONFIG.MIN_SCALE, Math.min(CONFIG.MAX_SCALE, scale));
    }

    game.scale = scale;

    // Centre offsets: physical-px origin of the scaled content region
    game.offsetX = (sw - game.gameWidth * scale) / 2;
    game.offsetY = (sh - game.gameHeight * scale) / 2;

    game._scaled = true;
}

/** Recalculates offsets every frame (handles window resize). */
function updateOffsets() {
    if (!game._scaled) return;
    const sw = mainCanvasSize.x;
    const sh = mainCanvasSize.y;
    game.offsetX = (sw - game.gameWidth * game.scale) / 2;
    game.offsetY = (sh - game.gameHeight * game.scale) / 2;
}

// ── Scene switching ──────────────────────────────────────────────────────────

/**
 * switchScene(name, data)
 *
 * Tears down the current scene, destroys all LittleJS engine objects, then
 * constructs and enters the new scene.
 *
 * Add your own scenes in the if/else chain below.
 *
 * @param {string} name  - scene identifier, e.g. 'demo', 'menu', 'game'
 * @param {object} data  - arbitrary payload forwarded to onEnter()
 */
export function switchScene(name, data = {}) {
    if (game.currentScene) game.currentScene.onExit();
    engineObjectsDestroy();

    if (name === 'menu') {
        game.currentScene = new MenuScene(data);
    } else if (name === 'lobby') {
        game.currentScene = new LobbyScene(data);
    } else if (name === 'game') {
        game.currentScene = new GameScene(data);
    } else if (name === 'results') {
        game.currentScene = new ResultsScene(data);
    }

    game.currentScene.onEnter(data);
}

// ── LittleJS lifecycle callbacks ─────────────────────────────────────────────

function gameInit() {
    game.dpr = window.devicePixelRatio || 1;

    // ── Step 1: tell LittleJS to use a fixed physical-pixel canvas ──────────
    const physSize = getPhysicalSize();
    setCanvasFixedSize(physSize);

    // ── Step 2: patch mainCanvasSize in-place ───────────────────────────────
    // gameInit() fires BEFORE the first updateCanvas() that reads canvasFixedSize,
    // so mainCanvasSize still holds old logical-pixel values.  Patch now so
    // applyScale() sees physical dimensions from the very first call.
    mainCanvasSize.x = physSize.x;
    mainCanvasSize.y = physSize.y;

    // Load configs from local storage
    game.configOverlay = new ConfigOverlay();

    window.addEventListener('resize', () => {
        game.dpr = window.devicePixelRatio || 1;
        const newPhysSize = getPhysicalSize();
        setCanvasFixedSize(newPhysSize);
        mainCanvasSize.x = newPhysSize.x;
        mainCanvasSize.y = newPhysSize.y;
        game._scaled = false;
        applyScale();
    });

    // ── Step 3: engine settings ──────────────────────────────────────────────
    setCanvasClearColor(rgb(0, 0, 0, 0));   // transparent — we draw our own bg
    setGLEnable(true);                       // WebGL for performance
    setTilesPixelated(false);
    setCanvasPixelated(false);
    setShowSplashScreen(false);
    setSoundEnable(true);
    setSoundVolume(0.6);
    setFontDefault('Arial');
    setCameraScale(1);

    // Enable built-in touch gamepad for mobile
    setTouchGamepadEnable(true);
    setTouchGamepadSize(CONFIG.MOBILE.GAMEPAD_SIZE);

    checkOrientation();

    // ── Step 4: create audio system ──────────────────────────────────────────
    game.audioSystem = new AudioSystem();

    // ── Step 5: preload assets with progress tracking ────────────────────────
    game.isLoading = true;
    game.loadingProgress = 0;

    const assetPaths = assetManager.getImagePaths();
    let imageProgress = 0;
    let audioProgress = 0;

    const updateProgress = () => {
        // Weight images 70% / audio 30% — adjust ratios to taste.
        game.loadingProgress = (imageProgress * 0.7) + (audioProgress * 0.3);

        if (game.loadingProgress >= 1) {
            setTimeout(() => {
                game.isLoading = false;
                applyScale();
                switchScene('menu');
            }, 300);
        }
    };

    if (assetPaths.length === 0) {
        // No images to load — fast-track image progress.
        imageProgress = 1;
    } else {
        imageCache.preloadAll(assetPaths, (progress) => {
            imageProgress = progress;
            updateProgress();
        });
    }

    game.audioSystem.preloadAudio().then(() => {
        audioProgress = 1;
        updateProgress();
    }).catch(() => {
        audioProgress = 1;
        updateProgress();
    });

    // Handle the case where there's nothing to load at all.
    if (assetPaths.length === 0) updateProgress();
}

function gameUpdate() {
    updateOffsets();
    if (game.currentScene) game.currentScene.onUpdate();
}

function gameUpdatePost() { /* reserved for post-update logic */ }

// ── Loading screen ───────────────────────────────────────────────────────────

function drawLoadingScreen() {
    const c = mainContext;
    const sw = mainCanvasSize.x;
    const sh = mainCanvasSize.y;
    const cx = sw / 2;
    const cy = sh / 2;
    const progress = game.loadingProgress || 0;

    // Background
    c.fillStyle = '#1a1a2e';
    c.fillRect(0, 0, sw, sh);

    // Title
    c.font = 'bold 48px Arial';
    c.fillStyle = '#70A1FF';
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.fillText(CONFIG.GAME_TITLE, cx, cy - 80);

    // "Loading…" label
    c.font = '24px Arial';
    c.fillStyle = '#ffffff';
    c.fillText('Loading...', cx, cy + 20);

    // Percentage
    const percent = Math.floor(progress * 100);
    c.font = 'bold 32px Arial';
    c.fillStyle = '#70A1FF';
    c.fillText(`${percent}%`, cx, cy + 60);

    // Progress bar background
    const barW = Math.min(400, sw * 0.6);
    const barH = 20;
    const barX = cx - barW / 2;
    const barY = cy + 100;
    const r = barH / 2;

    c.fillStyle = '#333333';
    _roundRect(c, barX, barY, barW, barH, r);
    c.fill();

    // Progress bar fill
    const fillW = barW * progress;
    if (fillW > 0) {
        c.fillStyle = '#70A1FF';
        _roundRect(c, barX, barY, fillW, barH, r);
        c.fill();
    }
}

/** Minimal rounded-rect path builder (avoids needing DrawUtils during load). */
function _roundRect(c, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    c.beginPath();
    c.moveTo(x + r, y);
    c.lineTo(x + w - r, y);
    c.quadraticCurveTo(x + w, y, x + w, y + r);
    c.lineTo(x + w, y + h - r);
    c.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    c.lineTo(x + r, y + h);
    c.quadraticCurveTo(x, y + h, x, y + h - r);
    c.lineTo(x, y + r);
    c.quadraticCurveTo(x, y, x + r, y);
    c.closePath();
}

// ── LittleJS render callbacks ────────────────────────────────────────────────

function gameRender() {
    // Must run every frame: repair LittleJS's partial CSS fix so the canvas
    // stays at logical-pixel size on screen (see fixCanvasCSS docs above).
    fixCanvasCSS();

    if (game.isLoading) {
        drawLoadingScreen();
    } else if (game.currentScene) {
        game.currentScene.onRender();
    }
}

function gameRenderPost() {
    if (game.currentScene && game.currentScene.onRenderPost) {
        game.currentScene.onRenderPost();
    }
}

function checkOrientation() {
    //create turn div if not exists
    if (!document.getElementById('turn')) {
        var turnDiv = document.createElement('div');
        turnDiv.id = 'turn';
        document.body.append(turnDiv);
    }



    // Find matches
    var mql = window.matchMedia('(orientation: landscape)');

    // If there are matches, we're in landscape
    if (mql.matches) {
        if (!game.orientation || game.orientation === 'portrait') {
            game.orientation = 'landscape';
            document.getElementById('turn').style.display = 'none';
        }
    } else {
        if (!game.orientation || game.orientation === 'landscape') {
            game.orientation = 'portrait';
            document.getElementById('turn').style.display = 'block';
            game.refreshedIntoLandscape = false;
            localStorage.setItem('refreshedIntoLandscape', false);
        }
    }

    // Add a media query change listener
    mql.addListener(function (m) {
        if (m.matches) {
            if (game.orientation === 'portrait') {
                game.orientation = 'landscape';
                document.getElementById('turn').style.display = 'none';
                if (!game.refreshedIntoLandscape) {
                    game.refreshedIntoLandscape = true;
                    localStorage.setItem('refreshedIntoLandscape', true);
                    // window.location.reload();
                }
            }
        } else {
            if (game.orientation === 'landscape') {
                game.orientation = 'portrait';
                document.getElementById('turn').style.display = 'block';
            }
        }
    }.bind(this));
}


// ── Bootstrap ────────────────────────────────────────────────────────────────
engineInit(gameInit, gameUpdate, gameUpdatePost, gameRender, gameRenderPost, [], document.body);
