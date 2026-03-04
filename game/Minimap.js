import { CONFIG } from '../config.js';

export class Minimap {
    constructor() { }

    /**
     * Renders the minimap on the HUD layer (screen space coordinates)
     */
    render(c, s, worldState, localPlayerId, x, y, size) {
        const map = CONFIG.MAPS[0]; // Active map

        c.save();
        c.translate(x, y);

        // Minimap background
        c.fillStyle = 'rgba(42, 42, 64, 0.7)';
        c.fillRect(0, 0, size, size);

        // Death zone warning
        const mapW = map.width;
        const mapH = map.height;
        const scaleX = size / mapW;
        const scaleY = size / mapH;

        const dzScaleX = map.deathZoneDepth * scaleX;
        const dzScaleY = map.deathZoneDepth * scaleY;

        // Draw death zone red vignette on minimap
        c.fillStyle = 'rgba(231, 110, 110, 0.81)';
        c.fillRect(0, 0, size, dzScaleY); // Top
        c.fillRect(0, size - dzScaleY, size, dzScaleY); // Bottom
        c.fillRect(0, dzScaleY, dzScaleX, size - (dzScaleY * 2)); // Left
        c.fillRect(size - dzScaleX, dzScaleY, dzScaleX, size - (dzScaleY * 2)); // Right

        // Border
        c.strokeStyle = '#000000ff';
        c.lineWidth = 1 * s;
        c.strokeRect(0, 0, size, size);

        // Render Debris
        c.fillStyle = '#A0A0A0';
        for (const d of worldState.debris) {
            const dx = d.x * scaleX;
            const dy = d.y * scaleY;
            c.beginPath();
            c.arc(dx, dy, Math.max(0.5, d.radius * scaleX * 1.5), 0, Math.PI * 2);
            c.fill();
        }

        // Render Ships
        for (const [id, p] of worldState.players) {
            if (!p.alive) continue;

            const px = p.x * scaleX;
            const py = p.y * scaleY;
            const isLocal = id === localPlayerId;
            const colorNum = CONFIG.UI.PLAYER_COLORS[p.slot % CONFIG.UI.PLAYER_COLORS.length];
            const colorStr = typeof colorNum === 'number' ? '#' + colorNum.toString(16).padStart(6, '0') : colorNum;

            c.fillStyle = colorStr;
            c.beginPath();
            c.arc(px, py, isLocal ? 3 * s : 2 * s, 0, Math.PI * 2);
            c.fill();

            if (isLocal) {
                // Flash or highlight for local player
                c.strokeStyle = '#FFFFFF';
                c.lineWidth = 1 * s;
                c.stroke();

                // Draw heading indicator
                c.beginPath();
                c.moveTo(px, py);
                c.lineTo(px + Math.cos(p.heading * Math.PI / 180) * 8 * s, py + Math.sin(p.heading * Math.PI / 180) * 8 * s);
                c.strokeStyle = '#FFFFFF';
                c.stroke();
            }
        }

        c.restore();
    }
}
