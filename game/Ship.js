import { ShipDefinitions } from './ShipDefinitions.js';
import { CONFIG } from '../config.js';
import { mainContext } from '../littlejs.esm.min.js';

export class Ship {
    constructor(playerId, stateData) {
        this.id = playerId;
        this.slot = stateData.slot;
        this.color = CONFIG.UI.PLAYER_COLORS[this.slot % CONFIG.UI.PLAYER_COLORS.length];
        this.exhaustParticles = Array.from({ length: 80 }, () => ({
            active: false, x: 0, y: 0, vx: 0, vy: 0, life: 0, maxLife: 0, size: 0, color: ''
        }));
        this.exhaustIdx = 0;
        this.exhaustAccum = 0;

        this.weaponParticles = Array.from({ length: 40 }, () => ({
            active: false, x: 0, y: 0, vx: 0, vy: 0, life: 0, maxLife: 0, size: 0, color: ''
        }));
        this.weaponIdx = 0;
        this.lastCooldowns = [0, 0, 0, 0, 0];

        this.explosionParticles = Array.from({ length: 150 }, () => ({
            active: false, x: 0, y: 0, vx: 0, vy: 0, life: 0, maxLife: 0, size: 0, color: ''
        }));
        this.explosionIdx = 0;

        this.loadState(stateData);
    }

    spawnExplosion(count, force) {
        if (!this.explosionParticles) return;
        for (let j = 0; j < count; j++) {
            let p = this.explosionParticles[this.explosionIdx];
            this.explosionIdx = (this.explosionIdx + 1) % this.explosionParticles.length;

            p.active = true;
            p.x = this.x + (Math.random() - 0.5) * this.def.hitboxRadius;
            p.y = this.y + (Math.random() - 0.5) * this.def.hitboxRadius;

            const angle = Math.random() * Math.PI * 2;
            const speed = (20 + Math.random() * 80) * (force > 50 ? 2 : 1);
            p.vx = Math.cos(angle) * speed;
            p.vy = Math.sin(angle) * speed;
            p.life = 0.2 + Math.random() * 0.4 + (force > 50 ? 0.3 : 0);
            p.maxLife = p.life;
            p.size = 2 + Math.random() * 6 * (force > 50 ? 1.5 : 1);
            p.color = Math.random() > 0.5 ? '#FFA502' : (Math.random() > 0.5 ? '#FF6B6B' : '#FFFFFF');
        }
    }

    spawnWeaponParticles(zone) {
        if (!this.weaponParticles) return;
        const count = 5 + Math.random() * 5;
        const fireRad = (this.heading + zone.angleOffset) * Math.PI / 180;
        const shipVx = Math.cos(this.heading * Math.PI / 180) * this.currentSpeed;
        const shipVy = Math.sin(this.heading * Math.PI / 180) * this.currentSpeed;

        for (let j = 0; j < count; j++) {
            let p = this.weaponParticles[this.weaponIdx];
            this.weaponIdx = (this.weaponIdx + 1) % this.weaponParticles.length;

            const spreadRad = fireRad + (Math.random() * (zone.arcWidth * Math.PI / 180)) - (zone.arcWidth * Math.PI / 180 / 2);

            p.active = true;
            p.x = this.x + Math.cos(fireRad) * this.def.hitboxRadius;
            p.y = this.y + Math.sin(fireRad) * this.def.hitboxRadius;
            p.vx = shipVx + Math.cos(spreadRad) * (200 + Math.random() * 200);
            p.vy = shipVy + Math.sin(spreadRad) * (200 + Math.random() * 200);
            p.life = 0.1 + Math.random() * 0.15;
            p.maxLife = p.life;
            p.size = 2 + Math.random() * 3;
            p.color = '#000000ff';
        }
    }

    loadState(stateData) {
        this.shipId = stateData.shipId;
        this.def = ShipDefinitions.get(this.shipId);

        this.x = stateData.x;
        this.y = stateData.y;
        this.heading = stateData.heading; // degrees
        this.speedTier = stateData.speedTier || this.def.defaultSpeedTier;
        this.health = stateData.health;
        this.alive = stateData.alive;
        this.invincibilityTimer = stateData.invincibilityTimer || 0;
        this.cooldowns = stateData.cooldowns || [0, 0, 0, 0, 0];
        this.knockbackX = stateData.knockbackX || 0;
        this.knockbackY = stateData.knockbackY || 0;

        // Current real speed based on tier (1-indexed theoretically, 0 to N internally)
        this.currentSpeed = this.def.speedTierValues[this.speedTier - 1] || this.def.speedTierValues[2];
    }

    toState() {
        return {
            slot: this.slot,
            shipId: this.shipId,
            x: this.x,
            y: this.y,
            heading: this.heading,
            speedTier: this.speedTier,
            health: this.health,
            alive: this.alive,
            invincibilityTimer: this.invincibilityTimer,
            cooldowns: [...this.cooldowns],
            knockbackX: this.knockbackX,
            knockbackY: this.knockbackY,
        };
    }

    step(inputFlags, dt) {
        if (!this.alive) return;

        // inputFlags is 1 byte bitmask:
        // 0x01: Left
        // 0x02: Right
        // 0x04: Up (SpeedUp)
        // 0x08: Down (SpeedDown)
        // 0x10: Primary
        // 0x20: Secondary
        // 0x40: Special 1
        // 0x80: Special 2

        // Speed modifications
        // In rollback, only edge triggers should ideally change speed to prevent holding changing it every frame
        // Alternatively we can use a cooldown or only toggle it when just-pressed. 
        // We'll leave it simple for now, we assume the game tick is handled correctly.
        // Usually, need an isPressed state tracked or input manager that emits events. For rollback, we send only flags.
        // It's safer to read 'up' 'down' and clamp, but we have to ensure it doesn't repeatedly trigger.

        // Actually wait, continuous turn rate
        let angularVelocity = 0;
        if (inputFlags & 0x01) {
            // Left
            angularVelocity = -(CONFIG.MOVEMENT.TURN_RATE_BASE * this.def.maneuverability) / (this.currentSpeed / 100);
            // the spec formula: (TURN_RATE_BASE * maneuverability) / currentSpeed (but normalize speed so it doesn't drop to 0.1)
            // Let's use currentSpeed directly or scaled
            angularVelocity = -(CONFIG.MOVEMENT.TURN_RATE_BASE * this.def.maneuverability) * (100 / this.currentSpeed);
        } else if (inputFlags & 0x02) {
            // Right
            angularVelocity = (CONFIG.MOVEMENT.TURN_RATE_BASE * this.def.maneuverability) * (100 / this.currentSpeed);
        }

        this.heading += angularVelocity * dt;
        if (this.heading >= 360) this.heading -= 360;
        if (this.heading < 0) this.heading += 360;

        const rad = this.heading * Math.PI / 180;
        const vx = Math.cos(rad) * this.currentSpeed;
        const vy = Math.sin(rad) * this.currentSpeed;

        this.x += vx * dt;
        this.y += vy * dt;

        if (Math.abs(this.knockbackX) > 0.1 || Math.abs(this.knockbackY) > 0.1) {
            this.x += this.knockbackX * dt;
            this.y += this.knockbackY * dt;

            const knockbackFriction = Math.pow(0.01, dt);
            this.knockbackX *= knockbackFriction;
            this.knockbackY *= knockbackFriction;
        } else {
            this.knockbackX = 0;
            this.knockbackY = 0;
        }

        // Bounds checking handled in WorldState/CollisionSystem
    }

    render(c, s, gameAreaX, gameAreaY, mapScale = 1.0, playerName = null) {
        if (!this.exhaustParticles || this.exhaustParticles.length === 0) {
            this.exhaustParticles = Array.from({ length: 80 }, () => ({
                active: false, x: 0, y: 0, vx: 0, vy: 0, life: 0, maxLife: 0, size: 0, color: ''
            }));
            this.exhaustIdx = 0;
            this.exhaustAccum = 0;
        }
        if (!this.weaponParticles || this.weaponParticles.length === 0) {
            this.weaponParticles = Array.from({ length: 40 }, () => ({
                active: false, x: 0, y: 0, vx: 0, vy: 0, life: 0, maxLife: 0, size: 0, color: ''
            }));
            this.weaponIdx = 0;
            this.lastCooldowns = [0, 0, 0, 0, 0];
        }
        if (!this.explosionParticles || this.explosionParticles.length === 0) {
            this.explosionParticles = Array.from({ length: 150 }, () => ({
                active: false, x: 0, y: 0, vx: 0, vy: 0, life: 0, maxLife: 0, size: 0, color: ''
            }));
            this.explosionIdx = 0;
            this.lastHealth = this.health;
            this.lastAlive = this.alive;
        }

        const frameDt = 1 / 60;

        if (this.health < this.lastHealth) {
            this.spawnExplosion(50, 50);
        }
        if (!this.alive && this.lastAlive) {
            this.spawnExplosion(200, 100);
        }
        this.lastHealth = this.health;
        this.lastAlive = this.alive;

        if (this.alive) {
            const maxSpeed = this.def.speedTierValues[this.def.speedTierValues.length - 1];
            const speedRatio = Math.max(0, this.currentSpeed / maxSpeed);

            this.exhaustAccum += speedRatio * 2.0;
            let particlesToEmit = Math.floor(this.exhaustAccum);
            this.exhaustAccum -= particlesToEmit;
            if (particlesToEmit > 5) particlesToEmit = 5;

            for (let i = 0; i < particlesToEmit; i++) {
                const angleOffset = (Math.random() * 40 - 20);
                const spreadRad = (this.heading + 180 + angleOffset) * Math.PI / 180;
                const spawnRad = (this.heading + 180) * Math.PI / 180;
                const dist = this.def.hitboxRadius * 0.9;

                let p = this.exhaustParticles[this.exhaustIdx];
                this.exhaustIdx = (this.exhaustIdx + 1) % this.exhaustParticles.length;

                p.active = true;
                p.x = this.x + Math.cos(spawnRad) * dist;
                p.y = this.y + Math.sin(spawnRad) * dist;
                p.vx = Math.cos(spreadRad) * (this.currentSpeed * 0.2 + 30 + Math.random() * 30);
                p.vy = Math.sin(spreadRad) * (this.currentSpeed * 0.2 + 30 + Math.random() * 30);
                p.life = 0.1 + Math.random() * 0.2 + (speedRatio * 0.2);
                p.maxLife = 0.4 + speedRatio * 0.2;
                p.size = 2 + Math.random() * 4;
                p.color = Math.random() > 0.4 ? '#FFA502' : '#FF6B6B';
            }
        }

        c.save();
        for (let i = 0; i < this.exhaustParticles.length; i++) {
            let p = this.exhaustParticles[i];
            if (!p.active) continue;

            p.x += p.vx * frameDt;
            p.y += p.vy * frameDt;
            p.life -= frameDt;

            if (p.life <= 0) {
                p.active = false;
                continue;
            }

            const pxExhaust = gameAreaX + p.x * s * mapScale;
            const pyExhaust = p.y * s * mapScale + gameAreaY;

            c.globalAlpha = p.life / p.maxLife;
            c.fillStyle = p.color;
            c.beginPath();
            c.arc(pxExhaust, pyExhaust, p.size * s * mapScale, 0, Math.PI * 2);
            c.fill();
        }
        c.restore();

        c.save();
        for (let i = 0; i < this.weaponParticles.length; i++) {
            let p = this.weaponParticles[i];
            if (!p.active) continue;

            p.x += p.vx * frameDt;
            p.y += p.vy * frameDt;
            p.life -= frameDt;

            if (p.life <= 0) {
                p.active = false;
                continue;
            }

            const pxWep = gameAreaX + p.x * s * mapScale;
            const pyWep = p.y * s * mapScale + gameAreaY;

            c.globalAlpha = p.life / p.maxLife;
            c.fillStyle = p.color;
            c.beginPath();
            c.arc(pxWep, pyWep, p.size * s * mapScale, 0, Math.PI * 2);
            c.fill();
        }
        c.restore();

        c.save();
        for (let i = 0; i < this.explosionParticles.length; i++) {
            let p = this.explosionParticles[i];
            if (!p.active) continue;

            p.x += p.vx * frameDt;
            p.y += p.vy * frameDt;
            p.life -= frameDt;

            if (p.life <= 0) {
                p.active = false;
                continue;
            }

            const pxExpl = gameAreaX + p.x * s * mapScale;
            const pyExpl = p.y * s * mapScale + gameAreaY;

            c.globalAlpha = Math.max(0, p.life / p.maxLife);
            c.fillStyle = p.color;
            c.beginPath();
            c.arc(pxExpl, pyExpl, p.size * s * mapScale, 0, Math.PI * 2);
            c.fill();
        }
        c.restore();

        if (!this.alive) return;

        const px = gameAreaX + this.x * s * mapScale;
        const py = gameAreaY + this.y * s * mapScale;
        const r = this.def.hitboxRadius * s * mapScale;

        c.save();
        if (this.invincibilityTimer > 0) {
            if (Math.floor(this.invincibilityTimer * 10) % 2 === 0) {
                c.globalAlpha = 0.4;
            }
        }

        c.translate(px, py);
        c.rotate(this.heading * Math.PI / 180);

        // Draw basic triangle for now
        const colorStr = typeof this.color === 'number' ? '#' + this.color.toString(16).padStart(6, '0') : this.color;
        c.fillStyle = '#2a2a40';
        c.beginPath();
        c.moveTo(r, 0); // nose
        c.lineTo(-r, r * 0.8); // back wing
        c.lineTo(-r * 0.5, 0); // back center indent
        c.lineTo(-r, -r * 0.8);
        c.closePath();
        c.fill();
        c.strokeStyle = colorStr;
        c.lineWidth = 2 * s;
        c.stroke();

        if (!this.lastCooldowns) this.lastCooldowns = [0, 0, 0, 0, 0];

        // Arc zones visualization 
        for (let i = 0; i < this.def.attackZones.length; i++) {
            const z = this.def.attackZones[i];

            var cooldownIndex = 0;
            if (z.inputKey === 'primary') {
                cooldownIndex = 0;
            } else if (z.inputKey === 'secondary') {
                cooldownIndex = 1;
            } else if (z.inputKey === 'special1') {
                cooldownIndex = 2;
            } else if (z.inputKey === 'special2') {
                cooldownIndex = 3;
            } else if (z.inputKey === 'special3') {
                cooldownIndex = 4;
            }

            const cd = this.cooldowns[cooldownIndex] || 0;

            if (this.lastCooldowns[cooldownIndex] <= 0 && cd > 0) {
                this.spawnWeaponParticles(z);
            }

            // Convert angle to rads. Angle offset is relative to ship heading.
            const startAngle = (z.angleOffset - z.arcWidth / 2) * Math.PI / 180;
            const endAngle = (z.angleOffset + z.arcWidth / 2) * Math.PI / 180;

            c.beginPath();
            c.moveTo(0, 0);
            c.arc(0, 0, z.range * s * mapScale, startAngle, endAngle);
            c.closePath();

            if (cd > 0) {
                c.fillStyle = `rgba(255, 0, 0, ${CONFIG.COMBAT.ATTACK_ZONE_COOLDOWN_ALPHA})`;
            } else {
                c.fillStyle = `rgba(255, 255, 255, ${CONFIG.COMBAT.ATTACK_ZONE_ALPHA})`;
            }
            c.fill();

            // Outline
            c.strokeStyle = `rgba(255, 255, 255, ${cd > 0 ? 0.2 : 0.6})`;
            c.lineWidth = 1 * s;
            c.stroke();
        }

        for (let i = 0; i < this.cooldowns.length; i++) {
            this.lastCooldowns[i] = this.cooldowns[i] || 0;
        }

        c.restore();

        // Health bar
        const hpBarW = 40 * s;
        const hpBarH = 4 * s;
        const hpY = py + r + 10 * s;
        const hpPct = Math.max(0, this.health / this.def.maxHealth);
        c.fillStyle = '#FF6B6B';
        c.fillRect(px - hpBarW / 2, hpY, hpBarW, hpBarH);
        c.fillStyle = '#7BED9F';
        c.fillRect(px - hpBarW / 2, hpY, hpBarW * hpPct, hpBarH);

        // Label
        c.font = `bold ${12 * s}px Arial`;
        c.fillStyle = '#FFF';
        c.textAlign = 'center';
        c.fillText(playerName || this.id.slice(0, 4), px, py + r + 15 * s);
    }
}
