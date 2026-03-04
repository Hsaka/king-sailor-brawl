/**
 * Animator.js — Lightweight frame-based tween / delay system.
 *
 * Does NOT depend on LittleJS Timers — it uses plain elapsed-time arithmetic
 * so it works identically in any scene update loop.
 *
 * Usage:
 *   const anim = new Animator();
 *
 *   // Animate a property from → to over a duration (seconds)
 *   anim.animate({
 *       target:   myObject,
 *       property: 'alpha',
 *       from:     0,
 *       to:       1,
 *       duration: 0.4,
 *       ease:     'easeOut',
 *       onComplete: () => console.log('done'),
 *   });
 *
 *   // Delayed callback
 *   anim.delay(1.5, () => doSomething());
 *
 *   // Must be called each update frame:
 *   anim.update(dt);   // dt in seconds
 *
 *   // Clear all tweens + delays (e.g. on scene exit):
 *   anim.clear();
 */

const EASING = {
    linear: t => t,
    easeIn: t => t * t,
    easeOut: t => 1 - (1 - t) * (1 - t),
    easeInOut: t => t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2,
    bounce: t => {
        const n1 = 7.5625, d1 = 2.75;
        if (t < 1 / d1) return n1 * t * t;
        if (t < 2 / d1) return n1 * (t -= 1.5 / d1) * t + 0.75;
        if (t < 2.5 / d1) return n1 * (t -= 2.25 / d1) * t + 0.9375;
        return n1 * (t -= 2.625 / d1) * t + 0.984375;
    },
    elastic: t => t === 0 ? 0 : t === 1 ? 1 :
        -Math.pow(2, 10 * t - 10) * Math.sin((t * 10 - 10.75) * (2 * Math.PI) / 3),
};

export class Animator {
    constructor() {
        this._tweens = [];
        this._delays = [];
    }

    /**
     * Register a numeric tween.
     * @param {object}   opts
     * @param {object}   opts.target     - object that owns the property
     * @param {string}   opts.property   - property name to animate
     * @param {number}   opts.from       - start value (set immediately if provided)
     * @param {number}   opts.to         - end value
     * @param {number}   opts.duration   - duration in seconds
     * @param {string}   [opts.ease]     - easing key (default 'easeOut')
     * @param {Function} [opts.onUpdate] - called each frame with the current value
     * @param {Function} [opts.onComplete]
     * @returns {object} tween handle (can be used to cancel by setting .done = true)
     */
    animate({ target, property, from, to, duration, ease = 'easeOut', onUpdate, onComplete }) {
        const tween = {
            target, property, from, to,
            duration, elapsed: 0,
            ease: EASING[ease] || EASING.linear,
            onUpdate, onComplete,
            done: false,
        };
        if (from !== undefined) target[property] = from;
        this._tweens.push(tween);
        return tween;
    }

    /**
     * Schedule a callback after `seconds` seconds.
     * @param {number}   seconds
     * @param {Function} callback
     */
    delay(seconds, callback) {
        this._delays.push({ remaining: seconds, callback });
    }

    /**
     * Advance all active tweens and delays.
     * Call this once per frame from your scene's onUpdate().
     * @param {number} dt - delta time in seconds (pass 1/60 for a fixed step)
     */
    update(dt) {
        // Delays
        for (let i = this._delays.length - 1; i >= 0; i--) {
            this._delays[i].remaining -= dt;
            if (this._delays[i].remaining <= 0) {
                this._delays[i].callback();
                this._delays.splice(i, 1);
            }
        }
        // Tweens
        for (let i = this._tweens.length - 1; i >= 0; i--) {
            const t = this._tweens[i];
            if (t.done) { this._tweens.splice(i, 1); continue; }
            t.elapsed += dt;
            const pct = Math.min(1, t.elapsed / t.duration);
            const eased = t.ease(pct);
            t.target[t.property] = t.from + (t.to - t.from) * eased;
            if (t.onUpdate) t.onUpdate(t.target[t.property]);
            if (pct >= 1) {
                t.done = true;
                if (t.onComplete) t.onComplete();
                this._tweens.splice(i, 1);
            }
        }
    }

    // ── Convenience shortcuts ────────────────────────────────────────────────

    /** Fade an object's `alpha` property from 0 → 1. */
    fadeIn(obj, duration = 0.3) {
        return this.animate({ target: obj, property: 'alpha', from: 0, to: 1, duration });
    }

    /** Fade an object's `alpha` property from 1 → 0. */
    fadeOut(obj, duration = 0.3, onComplete) {
        return this.animate({ target: obj, property: 'alpha', from: 1, to: 0, duration, onComplete });
    }

    /** Scale-pop: animates `scale` from 0.5 → 1 with a bounce. */
    scalePop(obj, duration = 0.25) {
        return this.animate({ target: obj, property: 'scale', from: 0.5, to: 1, duration, ease: 'bounce' });
    }

    /** Remove all active tweens and pending delays. */
    clear() {
        this._tweens = [];
        this._delays = [];
    }
}
