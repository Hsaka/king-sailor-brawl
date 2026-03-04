/**
 * WheelControl.js
 *
 * A ship's-wheel touch control that replaces the LittleJS left joystick when
 * CONFIG.MOVEMENT.WHEEL_CONTROL_SCHEME is true.
 *
 * Behaviour
 * ---------
 * • Renders a wheel graphic at the bottom-left of the canvas.
 * • Tracks a single touch that started inside the wheel radius. As the finger
 *   rotates around the wheel centre the cumulative angular delta is applied
 *   directly to `this.targetHeading`.
 * • A heading arrow is drawn on the wheel face to show the demanded heading.
 * • Exposes `targetHeading` — the absolute ship heading (degrees) the wheel is
 *   currently demanding.
 * • `active` — true while a touch is being tracked on the wheel.
 *
 * Touch registration
 * ------------------
 * Listeners are attached to `document` (not to the canvas element) so they
 * receive events regardless of which canvas or overlay is on top — the same
 * strategy LittleJS itself uses. A reference to the rendering canvas is stored
 * at attach-time and used for coordinate conversion.
 */

import { mainCanvasSize } from '../littlejs.esm.min.js';
import { CONFIG } from '../config.js';

export class WheelControl {
    constructor() {
        /** Absolute heading (degrees, 0-359) the wheel is pointing at. */
        this.targetHeading = 0;

        /** True while a touch is being tracked on the wheel. */
        this.active = false;

        // Internal tracking
        this._touchId = null;   // Touch.identifier of the tracked finger
        this._lastAngle = null;   // Last polar angle of that finger (radians)
        this._canvas = null;   // Reference canvas for coordinate mapping

        // Bound handlers — stored so they can be removed cleanly
        this._onTouchStart = this._handleTouchStart.bind(this);
        this._onTouchMove = this._handleTouchMove.bind(this);
        this._onTouchEnd = this._handleTouchEnd.bind(this);
    }

    /* ── public API ───────────────────────────────────────────────── */

    /**
     * Start listening for touches.
     * @param {HTMLCanvasElement} canvas  The main rendering canvas (used only
     *   for bounding-rect coordinate conversion).
     */
    attach(canvas) {
        this._canvas = canvas;
        document.addEventListener('touchstart', this._onTouchStart, { passive: false });
        document.addEventListener('touchmove', this._onTouchMove, { passive: false });
        document.addEventListener('touchend', this._onTouchEnd, { passive: false });
        document.addEventListener('touchcancel', this._onTouchEnd, { passive: false });
    }

    /** Stop listening for touches. */
    detach() {
        document.removeEventListener('touchstart', this._onTouchStart);
        document.removeEventListener('touchmove', this._onTouchMove);
        document.removeEventListener('touchend', this._onTouchEnd);
        document.removeEventListener('touchcancel', this._onTouchEnd);
        this._canvas = null;
        this.active = false;
        this._touchId = null;
    }


    /**
     * Draw the wheel.
     * @param {CanvasRenderingContext2D} ctx
     */
    render(ctx) {
        const sh = mainCanvasSize.y;
        const pad = CONFIG.MOBILE.GAMEPAD_SIZE;
        const cx = pad;
        const cy = sh - pad;
        const outerR = pad * 0.8;
        const innerR = outerR * 0.4;

        const alpha = this.active ? 0.85 : 0.45;

        ctx.save();
        ctx.globalAlpha = alpha;

        // ── outer rim ──────────────────────────────────────────────
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 4;
        ctx.fillStyle = this.active ? 'rgba(255,255,255,0.18)' : 'rgba(0,0,0,0.35)';
        ctx.beginPath();
        ctx.arc(cx, cy, outerR, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();

        // ── spokes (8) ─────────────────────────────────────────────
        ctx.strokeStyle = 'rgba(255,255,255,0.55)';
        ctx.lineWidth = 3;
        for (let i = 0; i < 8; i++) {
            const a = (i / 8) * Math.PI * 2;
            ctx.beginPath();
            ctx.moveTo(cx + Math.cos(a) * innerR, cy + Math.sin(a) * innerR);
            ctx.lineTo(cx + Math.cos(a) * outerR, cy + Math.sin(a) * outerR);
            ctx.stroke();
        }

        // ── inner hub ──────────────────────────────────────────────
        ctx.fillStyle = 'rgba(40,40,60,0.9)';
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 8;
        ctx.beginPath();
        ctx.arc(cx, cy, innerR, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();

        // ── heading arrow ──────────────────────────────────────────
        const headRad = this.targetHeading * Math.PI / 180;
        const arrowLen = outerR * 1.15;
        const arrowTipX = cx + Math.cos(headRad) * arrowLen;
        const arrowTipY = cy + Math.sin(headRad) * arrowLen;
        const arrowTailX = cx - Math.cos(headRad) * innerR * 0.5;
        const arrowTailY = cy - Math.sin(headRad) * innerR * 0.5;

        ctx.strokeStyle = '#ff6b6b';
        ctx.lineWidth = 15;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(arrowTailX, arrowTailY);
        ctx.lineTo(arrowTipX, arrowTipY);
        ctx.stroke();

        const headWidth = 0.85;
        const headLen = 44;
        ctx.fillStyle = '#ff6b6b';
        ctx.beginPath();
        ctx.moveTo(arrowTipX, arrowTipY);
        ctx.lineTo(
            arrowTipX - Math.cos(headRad - headWidth) * headLen,
            arrowTipY - Math.sin(headRad - headWidth) * headLen
        );
        ctx.lineTo(
            arrowTipX - Math.cos(headRad + headWidth) * headLen,
            arrowTipY - Math.sin(headRad + headWidth) * headLen
        );
        ctx.closePath();
        ctx.fill();

        ctx.restore();
    }

    /* ── private helpers ──────────────────────────────────────────── */

    /**
     * Convert a Touch's client coordinates into canvas pixel coordinates.
     * Uses the stored canvas reference rather than touch.target so the mapping
     * is always correct regardless of which DOM element received the touch.
     */
    _clientToCanvas(clientX, clientY) {
        const canvas = this._canvas;
        if (!canvas) return { x: clientX, y: clientY };
        const rect = canvas.getBoundingClientRect();
        const scaleX = canvas.width / rect.width;
        const scaleY = canvas.height / rect.height;
        return {
            x: (clientX - rect.left) * scaleX,
            y: (clientY - rect.top) * scaleY,
        };
    }

    _wheelCenter() {
        const pad = CONFIG.MOBILE.GAMEPAD_SIZE;
        return { cx: pad, cy: mainCanvasSize.y - pad };
    }

    _isInsideWheel(x, y) {
        const { cx, cy } = this._wheelCenter();
        const outerR = CONFIG.MOBILE.GAMEPAD_SIZE * 0.8;
        return Math.hypot(x - cx, y - cy) <= outerR;
    }

    _angleAt(x, y) {
        const { cx, cy } = this._wheelCenter();
        return Math.atan2(y - cy, x - cx);
    }

    _handleTouchStart(e) {
        if (this._touchId !== null) return; // already tracking a finger
        for (const touch of e.changedTouches) {
            const { x, y } = this._clientToCanvas(touch.clientX, touch.clientY);
            if (this._isInsideWheel(x, y)) {
                this._touchId = touch.identifier;
                this._lastAngle = this._angleAt(x, y);
                this.active = true;
                break;
            }
        }
    }

    _handleTouchMove(e) {
        if (this._touchId === null) return;
        for (const touch of e.changedTouches) {
            if (touch.identifier !== this._touchId) continue;
            const { x, y } = this._clientToCanvas(touch.clientX, touch.clientY);
            const newAngle = this._angleAt(x, y);
            let delta = newAngle - this._lastAngle;

            // Unwrap to (−π, π]
            if (delta > Math.PI) delta -= Math.PI * 2;
            if (delta < -Math.PI) delta += Math.PI * 2;

            // Apply ratio: divide physical rotation by ratio so a ratio > 1
            // requires more wheel revolutions to achieve the same ship turn.
            const ratio = CONFIG.MOVEMENT.WHEEL_TURN_RATIO || 1;
            this.targetHeading += (delta / ratio) * (180 / Math.PI);
            this.targetHeading = ((this.targetHeading % 360) + 360) % 360;
            this._lastAngle = newAngle;
            break;
        }
    }

    _handleTouchEnd(e) {
        if (this._touchId === null) return;
        for (const touch of e.changedTouches) {
            if (touch.identifier === this._touchId) {
                this._touchId = null;
                this._lastAngle = null;
                this.active = false;
                break;
            }
        }
    }
}
