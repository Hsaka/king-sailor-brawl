/**
 * AudioSystem.js — Game audio manager.
 *
 * Wraps LittleJS's built-in Sound class (ZzFX) for procedural audio and the
 * Web Audio API for file-based sounds.  Reads all sound definitions from
 * assets.js; volume settings come from config.js.
 *
 * Usage:
 *   import { AudioSystem } from './utils/AudioSystem.js';
 *
 *   // Created in App.js gameInit():
 *   game.audioSystem = new AudioSystem();
 *   await game.audioSystem.preloadAudio();
 *
 *   // In scenes:
 *   game.audioSystem.play('uiClick');
 *   game.audioSystem.toggleMute();
 *   game.audioSystem.startMusic();
 *
 * EXTENDING FOR YOUR GAME
 * ────────────────────────
 * Add named wrapper methods for your own sound keys, e.g.:
 *
 *   playJump()   { this.play('jump'); }
 *   playCollect(){ this.play('collect'); }
 *
 * This keeps call sites readable while the asset key lives in assets.js.
 */

import { Sound } from '../littlejs.esm.min.js';
import { CONFIG } from '../config.js';
import { ASSETS } from '../assets.js';

export class AudioSystem {
    constructor() {
        this.isMuted = false;
        this._sounds = {};    // key → LittleJS Sound  (procedural/ZzFX)
        this._fileSounds = {};    // key → { path, loaded, audio, volume }
        this._musicInstance = null;

        if (CONFIG.AUDIO_ENABLED !== false) {
            this._initSounds();
        }
    }

    // ── Initialisation ───────────────────────────────────────────────────────

    _initSounds() {
        for (const [key, asset] of Object.entries(ASSETS)) {
            if (asset.type !== 'audio' || asset.source === 'disabled') continue;

            if (asset.source === 'procedural' && asset.params) {
                this._sounds[key] = new Sound(asset.params);
            } else if (asset.source === 'file' && asset.path) {
                this._fileSounds[key] = {
                    path: asset.path,
                    loaded: false,
                    audio: null,
                    volume: asset.volume ?? 1,
                };
            }
        }
    }

    /**
     * Preloads all file-based audio assets.
     * Call this from App.js gameInit() and await the result before switching
     * to the first scene.
     */
    async preloadAudio() {
        const entries = Object.entries(ASSETS).filter(
            ([, a]) => a.type === 'audio' && a.source === 'file' && a.path,
        );
        if (entries.length === 0) return;

        const results = await Promise.all(
            entries.map(async ([key, asset]) => {
                try {
                    const audio = new Audio(asset.path);
                    await new Promise((resolve, reject) => {
                        audio.addEventListener('canplaythrough', resolve, { once: true });
                        audio.addEventListener('error', reject, { once: true });
                        audio.load();
                    });
                    return { key, audio, ok: true };
                } catch {
                    console.warn(`AudioSystem: failed to load "${asset.path}"`);
                    return { key, audio: null, ok: false };
                }
            }),
        );

        for (const { key, audio, ok } of results) {
            if (ok && this._fileSounds[key]) {
                this._fileSounds[key].audio = audio;
                this._fileSounds[key].loaded = true;
            }
        }
    }

    // ── Volume helpers ───────────────────────────────────────────────────────

    _sfxVolume(assetVolume = 1) {
        return CONFIG.MASTER_VOLUME * CONFIG.SFX_VOLUME * assetVolume;
    }

    // ── Playback ─────────────────────────────────────────────────────────────

    /**
     * Play a sound effect by asset key.
     * Safe to call even if the key doesn't exist — emits a console warning.
     * @param {string} key  — key from ASSETS (e.g. 'uiClick', 'jump')
     */
    async play(key) {
        if (this.isMuted || !CONFIG.AUDIO_ENABLED || !CONFIG.ENABLE_SFX) return;

        const asset = ASSETS[key];
        if (!asset || asset.type !== 'audio') {
            console.warn(`AudioSystem.play: unknown key "${key}"`);
            return;
        }

        const vol = this._sfxVolume(asset.volume ?? 1);

        if (asset.source === 'procedural') {
            const s = this._sounds[key];
            if (s) s.play(undefined, vol);
            return;
        }

        if (asset.source === 'file') {
            let fs = this._fileSounds[key];
            if (!fs) { console.warn(`AudioSystem: no file entry for "${key}"`); return; }

            // Lazy load if preloadAudio() didn't cover this key
            if (!fs.loaded) {
                try {
                    const audio = new Audio(fs.path);
                    await new Promise((resolve, reject) => {
                        audio.addEventListener('canplaythrough', resolve, { once: true });
                        audio.addEventListener('error', reject, { once: true });
                        audio.load();
                    });
                    fs.audio = audio;
                    fs.loaded = true;
                } catch {
                    console.warn(`AudioSystem: lazy load failed for "${fs.path}"`);
                    return;
                }
            }

            if (fs.audio) {
                fs.audio.volume = vol;
                fs.audio.currentTime = 0;
                fs.audio.play().catch(e => console.warn('AudioSystem: play() blocked', e));
            }
        }
    }

    // ── Convenience wrappers ─────────────────────────────────────────────────
    // Add your own named methods here for readability at call sites.

    /** Play the UI click sound. */
    playUIClick() { this.play('uiClick'); }

    /** Play the confirm / positive sound. */
    playConfirm() { this.play('confirm'); }

    /** Play the deny / error sound. */
    playDeny() { this.play('deny'); }

    // ── Mute ─────────────────────────────────────────────────────────────────

    /** Toggle mute on/off.  Returns the new muted state. */
    toggleMute() {
        this.isMuted = !this.isMuted;
        for (const fs of Object.values(this._fileSounds)) {
            if (fs.audio) fs.audio.muted = this.isMuted;
        }
        if (this._musicInstance) this._musicInstance.muted = this.isMuted;
        return this.isMuted;
    }

    // ── Music ─────────────────────────────────────────────────────────────────

    /** Start background music as defined by ASSETS.music. */
    async startMusic() {
        if (!CONFIG.AUDIO_ENABLED || !CONFIG.ENABLE_MUSIC || this.isMuted) return;
        this.stopMusic();

        const musicAsset = ASSETS.music;
        if (!musicAsset || musicAsset.source === 'disabled') return;

        if (musicAsset.source === 'file' && musicAsset.path) {
            try {
                const audio = new Audio(musicAsset.path);
                audio.loop = musicAsset.loop ?? true;
                audio.volume = CONFIG.MASTER_VOLUME * CONFIG.MUSIC_VOLUME * (musicAsset.volume ?? 1);
                await new Promise((resolve, reject) => {
                    audio.addEventListener('canplaythrough', resolve, { once: true });
                    audio.addEventListener('error', reject, { once: true });
                    audio.load();
                });
                this._musicInstance = audio;
                audio.play().catch(e => console.warn('AudioSystem: music play() blocked', e));
            } catch {
                console.warn('AudioSystem: failed to load music');
            }
        }
    }

    /** Stop and unload background music. */
    stopMusic() {
        if (this._musicInstance) {
            this._musicInstance.pause();
            this._musicInstance.currentTime = 0;
            this._musicInstance = null;
        }
    }

    /** Adjust master volume (0-1) at runtime. */
    setMasterVolume(v) {
        CONFIG.MASTER_VOLUME = Math.max(0, Math.min(1, v));
        if (this._musicInstance) {
            const ma = ASSETS.music;
            this._musicInstance.volume = CONFIG.MASTER_VOLUME * CONFIG.MUSIC_VOLUME * (ma?.volume ?? 1);
        }
    }

    /** Adjust music volume (0-1) at runtime. */
    setMusicVolume(v) {
        CONFIG.MUSIC_VOLUME = Math.max(0, Math.min(1, v));
        if (this._musicInstance) {
            const ma = ASSETS.music;
            this._musicInstance.volume = CONFIG.MASTER_VOLUME * CONFIG.MUSIC_VOLUME * (ma?.volume ?? 1);
        }
    }

    /** Adjust SFX volume (0-1) at runtime. */
    setSFXVolume(v) {
        CONFIG.SFX_VOLUME = Math.max(0, Math.min(1, v));
    }
}
