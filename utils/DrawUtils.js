/**
 * DrawUtils.js — Imperative Canvas2D drawing helpers.
 *
 * All coordinates are in SCREEN (physical pixel) space.
 * Pass game.scale to size-related arguments to keep visuals proportional
 * across all screen densities.
 *
 * Import the functions you need:
 *   import { drawRoundRect, drawScreenText, draw3DButton } from './utils/DrawUtils.js';
 */

import { mainContext, mainCanvasSize } from '../littlejs.esm.min.js';
import { CONFIG } from '../config.js';

const ctx = () => mainContext;

// ── Internal colour helpers ──────────────────────────────────────────────────

function hexToRgb(hex) {
    const h = hex.toString(16).padStart(6, '0');
    return [
        parseInt(h.slice(0, 2), 16),
        parseInt(h.slice(2, 4), 16),
        parseInt(h.slice(4, 6), 16),
    ];
}

/** Convert a 24-bit hex integer + alpha to an rgba() CSS string. */
export function hexCss(hex, alpha = 1) {
    const [r, g, b] = hexToRgb(hex);
    return `rgba(${r},${g},${b},${alpha})`;
}

/** Darken (amount > 0) or lighten (amount < 0) a hex colour by a fraction. */
export function darken(hex, amount) {
    const [r, g, b] = hexToRgb(hex);
    return (
        (Math.round(r * (1 - amount)) << 16) |
        (Math.round(g * (1 - amount)) << 8) |
        Math.round(b * (1 - amount))
    );
}

// ── Primitives ───────────────────────────────────────────────────────────────

/**
 * Draw a filled and/or stroked rounded rectangle.
 * @param {number}        x, y, w, h  - bounds in screen px
 * @param {number}        r            - corner radius
 * @param {number|string} fillColor    - 24-bit hex int or CSS colour string (null = no fill)
 * @param {number|string} strokeColor  - 24-bit hex int or CSS colour string (null = no stroke)
 * @param {number}        strokeWidth
 * @param {number}        alpha        - global alpha 0-1
 */
export function drawRoundRect(x, y, w, h, r, fillColor, strokeColor = null, strokeWidth = 0, alpha = 1) {
    const c = ctx();
    c.save();
    c.globalAlpha = alpha;
    c.beginPath();
    c.roundRect(x, y, w, h, r);
    if (fillColor !== null && fillColor !== undefined) {
        c.fillStyle = typeof fillColor === 'number' ? hexCss(fillColor) : fillColor;
        c.fill();
    }
    if (strokeColor && strokeWidth > 0) {
        c.lineWidth = strokeWidth;
        c.strokeStyle = typeof strokeColor === 'number' ? hexCss(strokeColor) : strokeColor;
        c.stroke();
    }
    c.restore();
}

/**
 * Draw text in screen space.
 * @param {string} text
 * @param {number} x, y        - screen position
 * @param {number} size        - font size in physical px
 * @param {string} color       - CSS colour
 * @param {string} align       - CanvasTextAlign ('center' | 'left' | 'right')
 * @param {string} baseline    - CanvasTextBaseline ('middle' | 'top' | 'bottom')
 * @param {string} fontFamily  - font family name
 * @param {boolean} bold
 */
export function drawScreenText(text, x, y, size, color = '#ffffff', align = 'center', baseline = 'middle', fontFamily = 'Arial', bold = false) {
    const c = ctx();
    c.save();
    c.font = `${bold ? 'bold ' : ''}${size}px ${fontFamily}`;
    c.fillStyle = color;
    c.textAlign = align;
    c.textBaseline = baseline;
    c.fillText(text, x, y);
    c.restore();
}

/**
 * Measure the pixel width of a string at a given size.
 * @returns {number} width in physical px
 */
export function measureText(text, size, bold = false, fontFamily = 'Arial') {
    const c = ctx();
    c.save();
    c.font = `${bold ? 'bold ' : ''}${size}px ${fontFamily}`;
    const w = c.measureText(text).width;
    c.restore();
    return w;
}

// ── Composite widgets ────────────────────────────────────────────────────────

/**
 * Draw a 3-D "playful" button with a shadow layer, highlight sheen, and label.
 * @param {number}  x, y, w, h  - bounds
 * @param {string}  label        - button text
 * @param {number}  color        - 24-bit hex fill colour
 * @param {boolean} pressed
 * @param {boolean} hovered
 */
export function draw3DButton(x, y, w, h, label, color, pressed = false, hovered = false) {
    const depth = CONFIG.UI.BUTTON.DEPTH;
    const r = CONFIG.UI.BUTTON.RADIUS;
    const shadow = darken(color, 0.3);
    const dy = pressed ? depth / 2 : 0;

    // Shadow layer
    drawRoundRect(x, y + depth, w, h, r, shadow, null, 0, pressed ? 0.5 : 1);
    // Face
    const faceColor = hovered ? darken(color, -0.1) : color;
    drawRoundRect(x, y + dy, w, h, r, faceColor);
    // Highlight sheen
    drawRoundRect(x + 4, y + dy + 4, w - 8, h / 2 - 4, r - 2, 'rgba(255,255,255,0.15)');
    // Label
    const c = ctx();
    c.save();
    c.font = `bold ${CONFIG.UI.FONT_SIZES.BUTTON}px Arial`;
    c.fillStyle = '#ffffff';
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.shadowColor = '#000';
    c.shadowBlur = 2;
    c.shadowOffsetY = 1;
    c.fillText(label, x + w / 2, y + dy + h / 2);
    c.restore();
}

/**
 * Draw a 3-D card panel.
 * @param {number} x, y, w, h  - bounds
 * @param {number} color        - 24-bit hex fill colour
 */
export function draw3DCard(x, y, w, h, color = CONFIG.UI.COLORS.PANEL_BG) {
    const depth = CONFIG.UI.CARD.DEPTH;
    const r = CONFIG.UI.CARD.RADIUS;
    const shadow = darken(color, 0.4);
    drawRoundRect(x, y + depth, w, h, r, shadow);
    drawRoundRect(x, y, w, h, r, color);
    drawRoundRect(x, y, w, h, r, null, 'rgba(255,255,255,0.1)', 2);
}

/**
 * Draw a pill-shaped label, optionally with an icon prefix.
 * Returns { width, height } of the rendered pill.
 */
export function drawPill(x, y, text, color, icon = null, scale = 1, center = false) {
    const h = 44 * scale;
    const pad = icon ? 16 * scale : 20 * scale;
    const fontSize = CONFIG.UI.FONT_SIZES.MODAL_BODY * scale;
    const iconSize = 20 * scale;
    const textW = measureText(text, fontSize, true);
    const w = pad * 2 + textW + (icon ? 28 * scale : 0);
    const actualX = center ? (mainCanvasSize.x - w) / 2 : x;

    drawRoundRect(actualX, y, w, h, h / 2, color);
    let xOff = actualX + pad;
    if (icon) {
        drawScreenText(icon, xOff + 10 * scale, y + h / 2, iconSize, '#fff');
        xOff += 28 * scale;
    }
    drawScreenText(text, xOff, y + h / 2, fontSize, '#fff', 'left', 'middle', 'Arial', true);
    return { width: w, height: h };
}

/**
 * Draw a horizontal progress bar.
 * @param {number} x, y, w   - bounds (height is taken from CONFIG)
 * @param {number} current    - current value
 * @param {number} max        - maximum value
 * @param {number} color      - 24-bit hex fill colour
 * @param {number} scale
 * Returns { width, height }.
 */
export function drawProgressBar(x, y, w, current, max, color = CONFIG.UI.COLORS.PRIMARY, scale = 1) {
    const h = CONFIG.UI.PROGRESS_BAR.HEIGHT * scale;
    const r = h / 2;
    drawRoundRect(x, y, w, h, r, CONFIG.UI.PROGRESS_BAR.BG_COLOR);
    const fillW = Math.max(0, Math.min(w, (current / max) * w));
    if (fillW > 0) {
        drawRoundRect(x, y, fillW, h, r, color);
        drawRoundRect(x + 2, y + 2, fillW - 4, h / 2 - 2, r - 2, 'rgba(255,255,255,0.2)');
    }
    drawScreenText(
        max.toLocaleString(),
        x + w / 2, y + h / 2,
        14 * scale, '#fff', 'center', 'middle', 'Arial', true,
    );
    return { width: w, height: h };
}

/**
 * Draw a resource counter pill (icon + value).
 * Returns { width, height }.
 */
export function drawResourceCounter(x, y, icon, value, color = CONFIG.UI.COLORS.PANEL_BG, scale = 1) {
    const h = CONFIG.UI.COUNTER.HEIGHT * scale;
    const iconSize = CONFIG.UI.COUNTER.ICON_SIZE * scale;
    const pad = 12 * scale;
    const fontSize = CONFIG.UI.FONT_SIZES.RESOURCE * scale;
    const valStr = value.toString();
    const valW = measureText(valStr, fontSize, true);
    const w = pad * 2 + iconSize + 8 * scale + valW + 8 * scale;

    drawRoundRect(x, y, w, h, h / 2, color);

    const c = ctx();
    c.save();
    c.beginPath();
    c.arc(x + pad + iconSize / 2, y + h / 2, iconSize / 2 + 4 * scale, 0, Math.PI * 2);
    c.fillStyle = 'rgba(255,255,255,0.2)';
    c.fill();
    c.restore();

    drawScreenText(icon, x + pad + iconSize / 2, y + h / 2, iconSize - 4 * scale, '#fff');
    drawScreenText(valStr, x + pad + iconSize + 8 * scale, y + h / 2, fontSize, '#fff', 'left', 'middle', 'Arial', true);
    return { width: w, height: h };
}

/**
 * Draw a square icon button with a 3-D shadow.
 */
export function drawIconButton(x, y, size, icon, color, pressed = false, hovered = false) {
    const depth = CONFIG.UI_DEFAULTS.ICON_BUTTON_DEPTH;
    const r = CONFIG.UI_DEFAULTS.ICON_BUTTON_RADIUS;
    const shadow = darken(color, 0.3);
    const dy = pressed ? depth / 2 : 0;
    drawRoundRect(x, y + depth, size, size, r, shadow, null, 0, pressed ? 0.5 : 1);
    drawRoundRect(x, y + dy, size, size, r, hovered ? darken(color, -0.05) : color);
    drawScreenText(icon, x + size / 2, y + dy + size / 2, size * 0.5, '#fff');
}

/**
 * Draw a modal dim overlay across the full canvas.
 */
export function drawModalOverlay(sw, sh) {
    const c = ctx();
    c.save();
    c.fillStyle = CONFIG.UI_DEFAULTS.MODAL_OVERLAY_COLOR;
    c.fillRect(0, 0, sw, sh);
    c.restore();
}

/**
 * Draw a labelled numeric value with a drop-shadow, suitable for score displays.
 */
export function drawNumberDisplay(cx, y, label, value, color, scale = 1) {
    const labelSize = CONFIG.UI.FONT_SIZES.MODAL_LABEL * scale;
    const valueSize = CONFIG.UI.FONT_SIZES.MODAL_NUMBER * scale;
    drawScreenText(label, cx, y, labelSize, hexCss(CONFIG.UI.COLORS.TEXT_SECONDARY), 'center', 'top', 'Arial', true);
    const c = ctx();
    c.save();
    c.font = `bold ${valueSize}px Arial`;
    c.fillStyle = typeof color === 'number' ? hexCss(color) : color;
    c.textAlign = 'center';
    c.textBaseline = 'top';
    c.shadowColor = '#000';
    c.shadowBlur = 6;
    c.shadowOffsetY = 3;
    c.fillText(value.toString(), cx, y + labelSize + 8 * scale);
    c.restore();
}
