import { CONFIG } from '../config.js';
import { mainCanvasSize, mainContext, vec2, mod } from '../littlejs.esm.min.js';
import { ShipDefinitions } from '../game/ShipDefinitions.js';
import { drawScreenText } from '../utils/DrawUtils.js';

export class HUD {
    constructor() {
        this.touchGamepadButtonsPositions = null;
        this.actions = null;
    }

    render(c, s, worldState, focusId) {
        const targetId = focusId || worldState.localPlayerId;
        const localPlayer = worldState.players.get(targetId);
        if (!localPlayer || !localPlayer.alive) return;

        const sw = mainCanvasSize.x;
        const sh = mainCanvasSize.y;

        // Health bar - bottom center
        const hpBarW = 400 * (s * 1.5);
        const hpBarH = 30 * s;
        const hpX = (sw - hpBarW) / 2;
        const hpY = 20 * s;

        const def = ShipDefinitions.get(localPlayer.shipId);
        const hpPct = Math.max(0, localPlayer.health / def.maxHealth);

        if (!this.touchGamepadButtonsPositions) {
            this.touchGamepadButtonsPositions = this.getTouchGamepadButtonsPositions();
        }

        if (!this.actions) {
            this.actions = this.getActions(def);
        }

        // draw background
        c.fillStyle = 'rgba(255, 0, 0, 0.5)';
        c.fillRect(hpX, hpY, hpBarW, hpBarH);

        // draw fill
        c.fillStyle = '#FF6B6B';
        if (hpPct > 0.5) c.fillStyle = '#7BED9F';
        else if (hpPct > 0.25) c.fillStyle = '#FFA502';
        c.fillRect(hpX, hpY, hpBarW * hpPct, hpBarH);

        // draw outline
        c.strokeStyle = '#000000ff';
        c.lineWidth = 2 * s;
        c.strokeRect(hpX, hpY, hpBarW, hpBarH);

        // draw health text
        drawScreenText(`${Math.ceil(localPlayer.health)} / ${def.maxHealth}`, sw / 2, hpY + hpBarH / 2 + 2 * s, 14 * s * 1.5, '#000000ff', 'center', 'middle');

        // Speed indicator
        // const speedText = `SPEED: ${localPlayer.speedTier}`;
        // drawScreenText(speedText, 20 * s, sh - 30 * s, 20 * s, '#FFF', 'left', 'middle');

        // Render Throttle Triangle
        const thrX = sw / 2;
        const thrYStart = sh - 20 * s; // bottom
        const thrH = CONFIG.MOBILE.THROTTLE_HEIGHT * s;
        const thrW = CONFIG.MOBILE.THROTTLE_WIDTH * s * 3;
        const thrYEnd = thrYStart - thrH; // top

        const tierCount = def.speedTierValues.length;

        c.save();

        // Draw segmented triangle
        for (let i = 0; i < tierCount; i++) {
            const h1 = (i / tierCount);
            const h2 = ((i + 1) / tierCount);

            const w1 = (1 - h1) * thrW;
            const w2 = (1 - h2) * thrW;

            const y1 = thrYStart - (h1 * thrH);
            const y2 = thrYStart - (h2 * thrH);

            c.beginPath();
            c.moveTo(thrX, y2); // top center
            c.lineTo(thrX + w2 / 2, y2); // top right
            c.lineTo(thrX + w1 / 2, y1); // bot right
            c.lineTo(thrX - w1 / 2, y1); // bot left
            c.lineTo(thrX - w2 / 2, y2); // top left
            c.closePath();

            // Highlight active tier
            if (localPlayer.speedTier === i + 1) {
                c.fillStyle = 'rgba(112, 161, 255, 0.8)';
            } else {
                c.fillStyle = 'rgba(255, 255, 255, 0.1)';
            }
            c.fill();
            c.strokeStyle = 'rgba(0, 0, 0, 0.3)';
            c.lineWidth = 1;
            c.stroke();
        }

        c.restore();

        // Cooldown indicators
        const iconSize = CONFIG.MOBILE.GAMEPAD_SIZE / 4;

        var primaryActions = this.actions.attackData['primary'];
        var secondaryActions = this.actions.attackData['secondary'];

        if (primaryActions && primaryActions.length > 0) {
            this.drawCooldownIcon(c, this.touchGamepadButtonsPositions[1].x, this.touchGamepadButtonsPositions[1].y, iconSize, primaryActions[0].inputKey, localPlayer.cooldowns[0] / primaryActions[0].cooldown, s);
        }

        if (secondaryActions && secondaryActions.length > 0) {
            this.drawCooldownIcon(c, this.touchGamepadButtonsPositions[2].x, this.touchGamepadButtonsPositions[2].y, iconSize, secondaryActions[0].inputKey, localPlayer.cooldowns[1] / secondaryActions[0].cooldown, s);
        }
    }

    getTouchGamepadButtonsPositions() {
        const buttonCenter = mainCanvasSize.subtract(vec2(CONFIG.MOBILE.GAMEPAD_SIZE));
        const touchGamepadButtonsPos = [];
        for (let i = 0; i < 4; i++) {
            const j = mod(i - 1, 4);
            const pos = buttonCenter.add(vec2().setDirection(j, CONFIG.MOBILE.GAMEPAD_SIZE / 2));
            touchGamepadButtonsPos.push(pos);
        }
        return touchGamepadButtonsPos;
    }

    getActions(def) {
        var data = {
            attackData: {},
            specialData: {}
        };

        for (var i = 0; i < def.attackZones.length; i++) {
            var zone = def.attackZones[i];
            var key = zone.inputKey;
            if (!data.attackData[key]) {
                data.attackData[key] = [];
            }
            data.attackData[key].push(zone);
        }

        for (var i = 0; i < def.specialPowers.length; i++) {
            var power = def.specialPowers[i];
            var key = power.inputKey;
            if (!data.specialData[key]) {
                data.specialData[key] = [];
            }
            data.specialData[key].push(power);
        }

        return data;
    }

    drawCooldownIcon(c, x, y, size, label, cdPct, s) {
        c.save();

        // Radial wipe
        if (cdPct > 0) {
            c.fillStyle = 'rgba(255, 109, 109, 0.7)';
            c.beginPath();
            c.moveTo(x, y);
            c.arc(x, y, size, -Math.PI / 2, -Math.PI / 2 + (Math.PI * 2 * cdPct), false);
            c.closePath();
            c.fill();
        }

        c.restore();
    }
}
