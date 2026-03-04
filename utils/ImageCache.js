/**
 * ImageCache.js — Global singleton image cache.
 *
 * Pre-loads all images before the game starts so scenes can access them
 * synchronously via imageCache.get(path).
 *
 * Usage:
 *   // In App.js gameInit():
 *   imageCache.preloadAll(paths, onProgress);
 *
 *   // In any scene:
 *   const img = imageCache.get('images/player.png');
 *   if (img) ctx.drawImage(img, x, y);
 */

class ImageCache {
    constructor() {
        this._images = new Map();
        this._loading = new Map();
    }

    /**
     * Preload a single image.
     * Deduplicates: calling this multiple times for the same src is safe.
     * @param  {string}          src
     * @returns {Promise<HTMLImageElement>}
     */
    preload(src) {
        if (this._images.has(src)) return Promise.resolve(this._images.get(src));
        if (this._loading.has(src)) return this._loading.get(src);

        const promise = new Promise((resolve, reject) => {
            const img = new Image();
            img.onload = () => { this._images.set(src, img); this._loading.delete(src); resolve(img); };
            img.onerror = () => { this._loading.delete(src); reject(new Error(`ImageCache: failed to load "${src}"`)); };
            img.src = src;
        });

        this._loading.set(src, promise);
        return promise;
    }

    /**
     * Preload multiple images, reporting progress.
     * @param {string[]} sources
     * @param {(progress: number, loaded: number, total: number) => void} [onProgress]
     */
    async preloadAll(sources, onProgress) {
        const total = sources.length;
        let loaded = 0;

        const promises = sources.map(async (src) => {
            try {
                await this.preload(src);
            } catch (e) {
                console.warn(e.message);
            } finally {
                loaded++;
                onProgress?.(loaded / total, loaded, total);
            }
        });

        await Promise.all(promises);
    }

    /**
     * Synchronously retrieve a preloaded image.
     * Returns null if the image has not been loaded yet.
     * @param  {string} src
     * @returns {HTMLImageElement | null}
     */
    get(src) {
        return this._images.get(src) ?? null;
    }

    /** Returns true if the image has been successfully loaded. */
    has(src) {
        return this._images.has(src);
    }
}

/** Singleton — use this throughout the project. */
export const imageCache = new ImageCache();

/** Convenience helper — equivalent to imageCache.get(src). */
export function getImage(src) {
    return imageCache.get(src);
}
