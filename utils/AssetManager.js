/**
 * AssetManager.js — Unified asset registry and accessor.
 *
 * Reads asset definitions from assets.js and provides a clean API to check
 * whether textures are loaded and to retrieve the underlying HTMLImageElement
 * or audio configuration.
 *
 * Usage:
 *   import { assetManager } from './utils/AssetManager.js';
 *
 *   // Get a loaded image:
 *   const img = assetManager.getImage('backgroundDesktop');
 *
 *   // Check if image is ready before drawing:
 *   if (assetManager.hasImage('logo')) { ... }
 *
 *   // Get audio asset config:
 *   const sfx = assetManager.getAudio('uiClick');
 */

import { ASSETS } from '../assets.js';
import { imageCache } from './ImageCache.js';

export class AssetManager {
    constructor() {
        this._loaded = false;
    }

    // ── Image paths ──────────────────────────────────────────────────────────

    /** Returns all file-based texture paths — used by imageCache.preloadAll(). */
    getImagePaths() {
        const paths = [];
        for (const asset of Object.values(ASSETS)) {
            if (asset.type === 'texture' && asset.source === 'file' && asset.path) {
                paths.push(asset.path);
            }
        }
        return paths;
    }

    /** Returns all file-based audio paths — used by AudioSystem.preloadAudio(). */
    getAudioPaths() {
        const paths = [];
        for (const asset of Object.values(ASSETS)) {
            if (asset.type === 'audio' && asset.source === 'file' && asset.path) {
                paths.push(asset.path);
            }
        }
        return paths;
    }

    // ── Asset access ─────────────────────────────────────────────────────────

    /** Returns the raw asset descriptor from ASSETS, or null. */
    getAsset(key) {
        return ASSETS[key] ?? null;
    }

    /**
     * Returns the loaded HTMLImageElement for a file-based texture asset.
     * Returns null if the asset is not a file texture or the image hasn't loaded.
     */
    getImage(key) {
        const asset = ASSETS[key];
        if (!asset || asset.type !== 'texture') return null;
        if (asset.source === 'file' && asset.path) return imageCache.get(asset.path);
        return null;
    }

    /**
     * Returns true when the image is loaded, complete, and has non-zero dimensions.
     * Use this as a guard before drawImage() calls.
     */
    hasImage(key) {
        const asset = ASSETS[key];
        if (!asset || asset.type !== 'texture') return false;
        if (asset.source === 'file' && asset.path) {
            const img = imageCache.get(asset.path);
            return !!(img && img.complete && img.naturalWidth > 0);
        }
        return false;
    }

    /**
     * Returns true if the image exists in the cache but failed to load
     * (e.g. 404 or network error).
     */
    hasImageError(key) {
        const asset = ASSETS[key];
        if (!asset || asset.type !== 'texture' || asset.source !== 'file') return false;
        const img = imageCache.get(asset.path);
        return !!(img && img.complete && img.naturalWidth === 0);
    }

    /**
     * Returns the audio asset configuration object, or null.
     * Passed directly to AudioSystem for ZzFX / file playback.
     */
    getAudio(key) {
        const asset = ASSETS[key];
        if (!asset || asset.type !== 'audio') return null;
        return asset;
    }
}

/** Singleton instance — import this everywhere instead of constructing new ones. */
export const assetManager = new AssetManager();
