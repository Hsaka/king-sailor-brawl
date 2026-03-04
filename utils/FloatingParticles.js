/**
 * FloatingParticles.js — Ambient background particle system.
 *
 * Spawns glowing particles from the edges of the screen that drift inward
 * with a sinusoidal wobble.  Purely decorative — no game logic dependency.
 *
 * Reads all configuration from CONFIG.FLOATING_PARTICLES.
 *
 * Usage:
 *   const fp = new FloatingParticles();
 *
 *   // In onEnter():
 *   fp.reset();
 *
 *   // In onUpdate():
 *   fp.update(dt, mainCanvasSize.x, mainCanvasSize.y);
 *
 *   // In onRender():
 *   fp.render(mainContext, game.scale);
 */

import { CONFIG } from '../config.js';

export class FloatingParticles {
    constructor() {
        this.particles = [];
        this.time = 0;
    }

    /** Clear all live particles (call on scene enter/exit). */
    reset() {
        this.particles = [];
        this.time = 0;
    }

    _spawnParticle(sw, sh) {
        const cfg = CONFIG.FLOATING_PARTICLES;
        const side = Math.floor(Math.random() * 4);
        const speed = cfg.SPEED_MIN + Math.random() * (cfg.SPEED_MAX - cfg.SPEED_MIN);
        let x, y, vx, vy;

        switch (side) {
            case 0:   // bottom → upward
                x = Math.random() * sw;
                y = sh + 20;
                vx = (Math.random() - 0.5) * 20;
                vy = -speed;
                break;
            case 1:   // left → rightward
                x = -20;
                y = Math.random() * sh;
                vx = speed * 0.6;
                vy = -speed * 0.5;
                break;
            case 2:   // right → leftward
                x = sw + 20;
                y = Math.random() * sh;
                vx = -speed * 0.6;
                vy = -speed * 0.5;
                break;
            default:  // top → downward (infrequent)
                x = Math.random() * sw;
                y = -20;
                vx = (Math.random() - 0.5) * 20;
                vy = speed * 0.4;
                break;
        }

        this.particles.push({
            x, y, vx, vy,
            r: cfg.SIZE_MIN + Math.random() * (cfg.SIZE_MAX - cfg.SIZE_MIN),
            color: cfg.COLORS[Math.floor(Math.random() * cfg.COLORS.length)],
            alpha: cfg.ALPHA_MIN + Math.random() * (cfg.ALPHA_MAX - cfg.ALPHA_MIN),
            life: 0,
            maxLife: cfg.LIFETIME_MIN + Math.random() * (cfg.LIFETIME_MAX - cfg.LIFETIME_MIN),
            wobbleOffset: Math.random() * Math.PI * 2,
            wobbleSpeed: cfg.WOBBLE_SPEED_MIN + Math.random() * (cfg.WOBBLE_SPEED_MAX - cfg.WOBBLE_SPEED_MIN),
        });
    }

    /**
     * Advance the system by one tick.
     * @param {number} dt  - delta time in seconds
     * @param {number} sw  - screen width  in physical px (mainCanvasSize.x)
     * @param {number} sh  - screen height in physical px (mainCanvasSize.y)
     */
    update(dt, sw, sh) {
        const cfg = CONFIG.FLOATING_PARTICLES;
        this.time += dt;

        if (this.particles.length < cfg.MAX_COUNT && Math.random() < cfg.SPAWN_RATE) {
            this._spawnParticle(sw, sh);
        }

        for (let i = this.particles.length - 1; i >= 0; i--) {
            const p = this.particles[i];
            p.life += dt;

            if (p.life >= p.maxLife) {
                this.particles.splice(i, 1);
                continue;
            }

            const wobble = Math.sin(this.time * p.wobbleSpeed + p.wobbleOffset) * cfg.WOBBLE_AMPLITUDE;
            p.x += (p.vx + wobble * 0.5) * dt;
            p.y += p.vy * dt;

            if (p.life > p.maxLife * cfg.FADE_START_RATIO) {
                p.alpha *= 0.98;
            }
        }
    }

    /**
     * Draw all particles.
     * @param {CanvasRenderingContext2D} c      - the 2D context
     * @param {number}                   scale  - game.scale (for glow size)
     */
    render(c, scale) {
        const cfg = CONFIG.FLOATING_PARTICLES;
        for (const p of this.particles) {
            c.save();
            c.globalAlpha = p.alpha;
            c.shadowColor = p.color;
            c.shadowBlur = cfg.GLOW_BLUR * scale;
            c.beginPath();
            c.arc(p.x, p.y, p.r * scale, 0, Math.PI * 2);
            c.fillStyle = p.color;
            c.fill();
            c.restore();
        }
    }
}
