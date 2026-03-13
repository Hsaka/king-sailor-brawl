import { Ship } from './Ship.js';
import { ShipDefinitions } from './ShipDefinitions.js';
import { CONFIG } from '../config.js';

const FNV_OFFSET_BASIS_32 = 0x811c9dc5;
const FNV_PRIME_32 = 0x01000193;
const DANGER_BORDER_PHASE = {
    DISABLED: 0,
    WAITING: 1,
    SHRINKING: 2,
    LOCKED: 3,
};

function hashBytesFNV1a(bytes) {
    let hash = FNV_OFFSET_BASIS_32;
    for (let i = 0; i < bytes.length; i++) {
        hash ^= bytes[i];
        hash = Math.imul(hash, FNV_PRIME_32);
    }
    return hash >>> 0;
}

export class WorldState {
    constructor(options = {}) {
        this.players = new Map();
        this.localPlayerId = null;

        // Used to track last input for debouncing up/down
        this.lastInput = new Map();

        // Runtime ship instances
        this.shipInstances = new Map();

        this.seed = 1337;
        this.debris = [];
        this.BOMB_TYPES = CONFIG.COMBAT.BOMB_TYPES;
        this.arena = this.createArenaState(options.arenaConfig);
        this.dangerBorder = this.createDangerBorderState(options.dangerBorderConfig, this.arena);
    }

    rand() {
        let t = this.seed += 0x6D2B79F5;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    }

    quantizeState() {
        this.arena.width = Math.fround(this.arena.width || 0);
        this.arena.height = Math.fround(this.arena.height || 0);
        this.arena.deathZoneDepth = Math.fround(this.arena.deathZoneDepth || 0);
        this.arena.deathZoneDamage = Math.fround(this.arena.deathZoneDamage || 0);

        this.dangerBorder.initialInset = Math.fround(this.dangerBorder.initialInset || 0);
        this.dangerBorder.currentInset = Math.fround(this.dangerBorder.currentInset || 0);
        this.dangerBorder.minInset = Math.fround(this.dangerBorder.minInset || 0);
        this.dangerBorder.shrinkUnitsPerTick = Math.fround(this.dangerBorder.shrinkUnitsPerTick || 0);
        this.dangerBorder.damagePerSecond = Math.fround(this.dangerBorder.damagePerSecond || 0);

        for (const [, player] of this.players) {
            player.x = Math.fround(player.x || 0);
            player.y = Math.fround(player.y || 0);
            player.heading = Math.fround(player.heading || 0);
            player.health = Math.fround(player.health || 0);
            player.invincibilityTimer = Math.fround(player.invincibilityTimer || 0);
            player.slowTimer = Math.fround(player.slowTimer || 0);
            player.knockbackX = Math.fround(player.knockbackX || 0);
            player.knockbackY = Math.fround(player.knockbackY || 0);

            const cooldowns = player.cooldowns || (player.cooldowns = [0, 0, 0, 0, 0]);
            for (let i = 0; i < cooldowns.length; i++) {
                cooldowns[i] = Math.fround(cooldowns[i] || 0);
            }
        }

        for (const debris of this.debris) {
            debris.x = Math.fround(debris.x || 0);
            debris.y = Math.fround(debris.y || 0);
            debris.vx = Math.fround(debris.vx || 0);
            debris.vy = Math.fround(debris.vy || 0);
            debris.life = Math.fround(debris.life || 0);
            debris.damage = Math.fround(debris.damage || 0);
            debris.radius = Math.fround(debris.radius || 0);
            debris.duration = Math.fround(debris.duration || 0);
        }
    }

    getSortedPlayerEntries() {
        return Array.from(this.players.entries()).sort(([a], [b]) => a.localeCompare(b));
    }

    createArenaState(mapConfig = CONFIG.MAPS[0]) {
        const map = mapConfig || {};
        return {
            width: Math.fround(Number(map.width) || 0),
            height: Math.fround(Number(map.height) || 0),
            deathZoneDepth: Math.fround(Number(map.deathZoneDepth) || 0),
            deathZoneDamage: Math.fround(Number(map.deathZoneDamage) || 0),
        };
    }

    createDangerBorderState(borderConfig = CONFIG.DANGER_BORDER, arena = this.arena) {
        const config = borderConfig || {};
        const tickRate = Math.max(1, Number(CONFIG.NETCODE?.TICK_RATE) || 60);
        const enabled = !!config.ENABLED;
        const initialInset = Math.max(0, Number(arena?.deathZoneDepth) || 0);
        const maxInset = Math.max(
            initialInset,
            Math.min(Number(arena?.width) || 0, Number(arena?.height) || 0) * 0.5
        );
        const requestedMinInset = Number(config.MIN_INSET);
        const minInset = Math.max(
            initialInset,
            Math.min(maxInset, Number.isFinite(requestedMinInset) ? requestedMinInset : initialInset)
        );
        const requestedDamage = Number(config.DAMAGE_PER_SECOND);
        const damagePerSecond = Number.isFinite(requestedDamage)
            ? Math.max(0, requestedDamage)
            : Math.max(0, Number(arena?.deathZoneDamage) || 0);
        const requestedShrinkRate = Number(config.SHRINK_UNITS_PER_SECOND);
        const shrinkUnitsPerTick = Number.isFinite(requestedShrinkRate) && requestedShrinkRate > 0
            ? requestedShrinkRate / tickRate
            : 0;
        const requestedDelaySeconds = Number(config.START_DELAY_SECONDS);
        const startDelayTicks = Number.isFinite(requestedDelaySeconds) && requestedDelaySeconds > 0
            ? Math.round(requestedDelaySeconds * tickRate)
            : 0;

        const border = {
            enabled,
            phase: enabled ? DANGER_BORDER_PHASE.WAITING : DANGER_BORDER_PHASE.DISABLED,
            elapsedTicks: 0,
            startDelayTicks,
            initialInset,
            currentInset: initialInset,
            minInset,
            shrinkUnitsPerTick,
            damagePerSecond,
        };
        this.syncDangerBorderDerivedState(border);
        return border;
    }

    setDangerBorderConfig(borderConfig) {
        this.dangerBorder = this.createDangerBorderState(borderConfig, this.arena);
        this.quantizeState();
    }

    syncDangerBorderDerivedState(border = this.dangerBorder) {
        if (!border) return;

        border.elapsedTicks = Math.max(0, border.elapsedTicks | 0);
        border.startDelayTicks = Math.max(0, border.startDelayTicks | 0);
        border.initialInset = Math.fround(Math.max(0, border.initialInset || 0));
        border.minInset = Math.fround(Math.max(border.initialInset, border.minInset || 0));
        border.shrinkUnitsPerTick = Math.fround(Math.max(0, border.shrinkUnitsPerTick || 0));
        border.damagePerSecond = Math.fround(Math.max(0, border.damagePerSecond || 0));

        if (!border.enabled) {
            border.phase = DANGER_BORDER_PHASE.DISABLED;
            border.currentInset = border.initialInset;
            return;
        }

        if (border.minInset <= border.initialInset || border.shrinkUnitsPerTick <= 0) {
            border.currentInset = border.initialInset;
            border.phase = DANGER_BORDER_PHASE.LOCKED;
            return;
        }

        const shrinkTicks = Math.max(0, border.elapsedTicks - border.startDelayTicks);
        const unclampedInset = border.initialInset + (shrinkTicks * border.shrinkUnitsPerTick);
        border.currentInset = Math.fround(Math.min(border.minInset, unclampedInset));

        if (border.currentInset >= border.minInset) {
            border.phase = DANGER_BORDER_PHASE.LOCKED;
        } else if (border.elapsedTicks <= border.startDelayTicks) {
            border.phase = DANGER_BORDER_PHASE.WAITING;
        } else {
            border.phase = DANGER_BORDER_PHASE.SHRINKING;
        }
    }

    resetDangerBorderState() {
        this.dangerBorder.elapsedTicks = 0;
        this.syncDangerBorderDerivedState();
    }

    updateDangerBorderState() {
        if (!this.dangerBorder.enabled) return;
        this.dangerBorder.elapsedTicks += 1;
        this.syncDangerBorderDerivedState();
    }

    getArenaBounds() {
        return this.arena;
    }

    getDangerBorderInset() {
        return this.dangerBorder.enabled ? this.dangerBorder.currentInset : this.arena.deathZoneDepth;
    }

    getDangerBorderDamagePerSecond() {
        return this.dangerBorder.enabled ? this.dangerBorder.damagePerSecond : this.arena.deathZoneDamage;
    }

    getDangerBorderSafeBounds() {
        const inset = this.getDangerBorderInset();
        return {
            left: inset,
            top: inset,
            right: this.arena.width - inset,
            bottom: this.arena.height - inset,
        };
    }

    isOutsideDangerBorder(x, y) {
        const bounds = this.getDangerBorderSafeBounds();
        return x < bounds.left || x > bounds.right || y < bounds.top || y > bounds.bottom;
    }

    getSpawnBounds() {
        const spawnInset = Math.min(
            Math.min(this.arena.width, this.arena.height) * 0.5,
            this.dangerBorder.initialInset + 100
        );
        const xMin = spawnInset;
        const xMax = Math.max(xMin, this.arena.width - spawnInset);
        const yMin = spawnInset;
        const yMax = Math.max(yMin, this.arena.height - spawnInset);
        return { xMin, xMax, yMin, yMax };
    }

    resetLevel() {
        this.seed = 1337;
        this.debris = [];
        this.resetDangerBorderState();

        const playerIds = this.getSortedPlayerEntries().map(([id]) => id);
        for (const id of playerIds) {
            const p = this.players.get(id);
            const { xMin, xMax, yMin, yMax } = this.getSpawnBounds();
            const x = xMin + this.rand() * (xMax - xMin);
            const y = yMin + this.rand() * (yMax - yMin);
            const heading = (x < this.arena.width / 2) ? 0 : 180;

            p.x = x;
            p.y = y;
            p.heading = heading;
            p.alive = true;
            p.health = ShipDefinitions.get(p.shipId).maxHealth;
            p.cooldowns = [0, 0, 0, 0, 0];
            p.invincibilityTimer = 0;
            p.slowTimer = 0;
            p.speedTier = ShipDefinitions.get(p.shipId).defaultSpeedTier;
            p.knockbackX = 0;
            p.knockbackY = 0;
            this.lastInput.set(id, 0);
        }

        this.quantizeState();
    }

    setLocalPlayerId(id) {
        this.localPlayerId = id;
    }

    addPlayer(id, slotIndex) {
        const { xMin, xMax, yMin, yMax } = this.getSpawnBounds();
        const x = xMin + this.rand() * (xMax - xMin);
        const y = yMin + this.rand() * (yMax - yMin);
        const heading = (x < this.arena.width / 2) ? 0 : 180;

        this.players.set(id, {
            slot: slotIndex,
            shipId: 'cobro',
            x: x,
            y: y,
            heading: heading,
            speedTier: 2,
            health: 100,
            alive: true,
            isBot: false,
            invincibilityTimer: 0,
            slowTimer: 0,
            cooldowns: [0, 0, 0, 0, 0],
            knockbackX: 0,
            knockbackY: 0
        });
        this.lastInput.set(id, 0);
        this.quantizeState();
    }

    addBot(id, slotIndex, shipId = 'cobro') {
        this.addPlayer(id, slotIndex);
        const pdata = this.players.get(id);
        pdata.isBot = true;
        pdata.shipId = shipId;
        this.setPlayerShip(id, shipId);
    }

    setPlayerShip(id, shipId) {
        if (this.players.has(id)) {
            const ship = this.players.get(id);
            const def = ShipDefinitions.get(shipId);
            ship.shipId = shipId;
            ship.health = def.maxHealth;
            ship.speedTier = def.defaultSpeedTier;
        }
    }

    removePlayer(id) {
        this.players.delete(id);
        this.shipInstances.delete(id);
        this.lastInput.delete(id);
    }

    serialize() {
        const playerEntries = this.getSortedPlayerEntries();
        const count = playerEntries.length;
        let bufferSize = 64 + (this.debris.length * 33); // header(64) + debris(33 ea - 8 floats + 1 byte for type)
        const encoder = new TextEncoder();
        const idBytesList = [];

        for (const [id] of playerEntries) {
            const idb = encoder.encode(id);
            idBytesList.push(idb);
            // 1(len)+idBytes+4(slot)+12(shipId)+4(x)+4(y)+4(heading)+4(hp)+4(kbX)+4(kbY)+1(speed)+1(alive)+1(isBot)+4(invinc)+4(slow)+20(cooldowns)+4(lastInput)
            bufferSize += 1 + idb.length + 4 + 12 + 24 + 1 + 1 + 1 + 4 + 4 + 20 + 4;
        }

        const buffer = new ArrayBuffer(bufferSize);
        const view = new DataView(buffer);
        const uint8View = new Uint8Array(buffer);

        let offset = 0;
        view.setUint32(offset, count, true); offset += 4;
        view.setUint32(offset, this.seed, true); offset += 4;
        view.setUint32(offset, this.debris.length, true); offset += 4;
        view.setFloat32(offset, this.arena.width, true); offset += 4;
        view.setFloat32(offset, this.arena.height, true); offset += 4;
        view.setFloat32(offset, this.arena.deathZoneDepth, true); offset += 4;
        view.setFloat32(offset, this.arena.deathZoneDamage, true); offset += 4;
        view.setUint32(offset, this.dangerBorder.enabled ? 1 : 0, true); offset += 4;
        view.setUint32(offset, this.dangerBorder.phase, true); offset += 4;
        view.setUint32(offset, this.dangerBorder.elapsedTicks, true); offset += 4;
        view.setUint32(offset, this.dangerBorder.startDelayTicks, true); offset += 4;
        view.setFloat32(offset, this.dangerBorder.initialInset, true); offset += 4;
        view.setFloat32(offset, this.dangerBorder.currentInset, true); offset += 4;
        view.setFloat32(offset, this.dangerBorder.minInset, true); offset += 4;
        view.setFloat32(offset, this.dangerBorder.shrinkUnitsPerTick, true); offset += 4;
        view.setFloat32(offset, this.dangerBorder.damagePerSecond, true); offset += 4;

        for (let i = 0; i < playerEntries.length; i++) {
            const [id, p] = playerEntries[i];
            const idb = idBytesList[i];
            view.setUint8(offset, idb.length); offset += 1;
            uint8View.set(idb, offset); offset += idb.length;

            view.setUint32(offset, p.slot, true); offset += 4;

            const shipB = encoder.encode(p.shipId.padEnd(12, ' ').slice(0, 12));
            uint8View.set(shipB, offset); offset += 12;

            view.setFloat32(offset, p.x, true); offset += 4;
            view.setFloat32(offset, p.y, true); offset += 4;
            view.setFloat32(offset, p.heading, true); offset += 4;
            view.setFloat32(offset, p.health, true); offset += 4;
            view.setFloat32(offset, p.knockbackX || 0, true); offset += 4;
            view.setFloat32(offset, p.knockbackY || 0, true); offset += 4;
            view.setUint8(offset, p.speedTier); offset += 1;
            view.setUint8(offset, p.alive ? 1 : 0); offset += 1;
            view.setUint8(offset, p.isBot ? 1 : 0); offset += 1;
            view.setFloat32(offset, p.invincibilityTimer || 0, true); offset += 4;
            view.setFloat32(offset, p.slowTimer || 0, true); offset += 4;
            view.setFloat32(offset, p.cooldowns[0], true); offset += 4;
            view.setFloat32(offset, p.cooldowns[1], true); offset += 4;
            view.setFloat32(offset, p.cooldowns[2], true); offset += 4;
            view.setFloat32(offset, p.cooldowns[3], true); offset += 4;
            view.setFloat32(offset, p.cooldowns[4], true); offset += 4;
            view.setUint32(offset, this.lastInput.get(id) || 0, true); offset += 4;
        }

        for (const d of this.debris) {
            view.setFloat32(offset, d.x, true); offset += 4;
            view.setFloat32(offset, d.y, true); offset += 4;
            view.setFloat32(offset, d.vx, true); offset += 4;
            view.setFloat32(offset, d.vy, true); offset += 4;
            view.setFloat32(offset, d.life, true); offset += 4;
            view.setFloat32(offset, d.damage, true); offset += 4;
            view.setFloat32(offset, d.radius, true); offset += 4;
            view.setFloat32(offset, d.duration || 0, true); offset += 4;

            let typeIdx = this.BOMB_TYPES.indexOf(d.type);
            if (typeIdx === -1) typeIdx = 0;
            const isBomb = d.spriteKey === 'bomb' ? 128 : 0;
            view.setUint8(offset, (typeIdx & 0x7F) | isBomb); offset += 1;
        }

        return new Uint8Array(buffer);
    }

    deserialize(data) {
        const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
        const uint8View = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
        let offset = 0;
        const count = view.getUint32(offset, true); offset += 4;
        this.seed = view.getUint32(offset, true); offset += 4;
        const debrisCount = view.getUint32(offset, true); offset += 4;
        this.arena = {
            width: view.getFloat32(offset, true),
            height: view.getFloat32(offset + 4, true),
            deathZoneDepth: view.getFloat32(offset + 8, true),
            deathZoneDamage: view.getFloat32(offset + 12, true),
        };
        offset += 16;
        this.dangerBorder = {
            enabled: view.getUint32(offset, true) === 1,
            phase: view.getUint32(offset + 4, true),
            elapsedTicks: view.getUint32(offset + 8, true),
            startDelayTicks: view.getUint32(offset + 12, true),
            initialInset: view.getFloat32(offset + 16, true),
            currentInset: view.getFloat32(offset + 20, true),
            minInset: view.getFloat32(offset + 24, true),
            shrinkUnitsPerTick: view.getFloat32(offset + 28, true),
            damagePerSecond: view.getFloat32(offset + 32, true),
        };
        offset += 36;

        this.players.clear();
        this.lastInput.clear();
        const decoder = new TextDecoder();

        for (let i = 0; i < count; i++) {
            const idLen = view.getUint8(offset); offset += 1;
            const idBytes = uint8View.subarray(offset, offset + idLen);
            const id = decoder.decode(idBytes); offset += idLen;

            const slot = view.getUint32(offset, true); offset += 4;

            const shipBytes = uint8View.subarray(offset, offset + 12);
            const shipId = decoder.decode(shipBytes).trim(); offset += 12;

            const x = view.getFloat32(offset, true); offset += 4;
            const y = view.getFloat32(offset, true); offset += 4;
            const heading = view.getFloat32(offset, true); offset += 4;
            const health = view.getFloat32(offset, true); offset += 4;
            const knockbackX = view.getFloat32(offset, true); offset += 4;
            const knockbackY = view.getFloat32(offset, true); offset += 4;
            const speedTier = view.getUint8(offset); offset += 1;
            const alive = view.getUint8(offset) === 1; offset += 1;
            const isBot = view.getUint8(offset) === 1; offset += 1;
            const invincibilityTimer = view.getFloat32(offset, true); offset += 4;
            const slowTimer = view.getFloat32(offset, true); offset += 4;
            const cooldowns = [0, 0, 0, 0, 0];
            cooldowns[0] = view.getFloat32(offset, true); offset += 4;
            cooldowns[1] = view.getFloat32(offset, true); offset += 4;
            cooldowns[2] = view.getFloat32(offset, true); offset += 4;
            cooldowns[3] = view.getFloat32(offset, true); offset += 4;
            cooldowns[4] = view.getFloat32(offset, true); offset += 4;
            const lastFlags = view.getUint32(offset, true); offset += 4;

            this.players.set(id, { slot, shipId, x, y, heading, speedTier, health, alive, isBot, invincibilityTimer, slowTimer, cooldowns, knockbackX, knockbackY });
            this.lastInput.set(id, lastFlags);
        }

        this.debris = [];
        for (let i = 0; i < debrisCount; i++) {
            const x = view.getFloat32(offset, true); offset += 4;
            const y = view.getFloat32(offset, true); offset += 4;
            const vx = view.getFloat32(offset, true); offset += 4;
            const vy = view.getFloat32(offset, true); offset += 4;
            const life = view.getFloat32(offset, true); offset += 4;
            const damage = view.getFloat32(offset, true); offset += 4;
            const radius = view.getFloat32(offset, true); offset += 4;
            const duration = view.getFloat32(offset, true); offset += 4;
            const flag = view.getUint8(offset); offset += 1;

            const isBomb = (flag & 128) !== 0;
            const typeStr = this.BOMB_TYPES[flag & 0x7F] || 'damage';

            this.debris.push({ x, y, vx, vy, life, damage, radius, duration, spriteKey: isBomb ? 'bomb' : 'debris', type: typeStr });
        }

        for (const id of this.shipInstances.keys()) {
            if (!this.players.has(id)) {
                this.shipInstances.delete(id);
            }
        }
    }

    spawnDebris(x, y, debrisConfig) {
        for (let i = 0; i < debrisConfig.pieceCount; i++) {
            const angle = this.rand() * Math.PI * 2;
            const speed = this.rand() * 50 + 20;
            const dist = this.rand() * debrisConfig.spreadRadius;
            this.debris.push({
                x: x + Math.cos(angle) * dist,
                y: y + Math.sin(angle) * dist,
                vx: Math.cos(angle) * speed,
                vy: Math.sin(angle) * speed,
                life: 30 + this.rand() * 30,
                damage: debrisConfig.damage,
                radius: debrisConfig.pieceRadius,
                duration: 0,
                type: 'damage',
                spriteKey: debrisConfig.spriteKey || null
            });
        }

        this.quantizeState();
    }

    computeBotInput(id, dt) {
        const pdata = this.players.get(id);
        if (!pdata.alive) return 0;

        let flags = 0;
        const def = ShipDefinitions.get(pdata.shipId);

        let nearestEnemy = null;
        let minEnemyDist = Infinity;
        for (const [otherId, targetPdata] of this.getSortedPlayerEntries()) {
            if (otherId === id || !targetPdata.alive) continue;
            const dx = targetPdata.x - pdata.x;
            const dy = targetPdata.y - pdata.y;
            const dist = Math.hypot(dx, dy);
            if (dist < minEnemyDist) {
                minEnemyDist = dist;
                nearestEnemy = { pdata: targetPdata, dist, dx, dy };
            }
        }

        let targetAngle = pdata.heading;
        const safeMargin = this.getDangerBorderInset() + 150;

        let inDanger = false;
        let dangerDx = 0;
        let dangerDy = 0;

        if (pdata.x < safeMargin) { inDanger = true; dangerDx = 1; }
        else if (pdata.x > this.arena.width - safeMargin) { inDanger = true; dangerDx = -1; }

        if (pdata.y < safeMargin) { inDanger = true; dangerDy = 1; }
        else if (pdata.y > this.arena.height - safeMargin) { inDanger = true; dangerDy = -1; }

        if (inDanger) {
            targetAngle = Math.atan2(dangerDy, dangerDx) * 180 / Math.PI;
            if (dangerDx === 0 && dangerDy === 0) {
                targetAngle = Math.atan2(this.arena.height / 2 - pdata.y, this.arena.width / 2 - pdata.x) * 180 / Math.PI;
            }
        } else if (nearestEnemy) {
            let angleToEnemy = Math.atan2(nearestEnemy.dy, nearestEnemy.dx) * 180 / Math.PI;
            if (angleToEnemy < 0) angleToEnemy += 360;

            const healthPercent = pdata.health / def.maxHealth;
            const enemyDef = ShipDefinitions.get(nearestEnemy.pdata.shipId);
            const enemyHealthPercent = nearestEnemy.pdata.health / enemyDef.maxHealth;

            if (healthPercent < 0.3 && enemyHealthPercent >= 0.3) {
                targetAngle = (angleToEnemy + 180) % 360;
            } else {
                targetAngle = angleToEnemy;

                const getBotCooldownIndex = (key) => {
                    if (key === 'primary') return 0;
                    if (key === 'secondary') return 1;
                    if (key === 'special1') return 2;
                    if (key === 'special2') return 3;
                    if (key === 'special3') return 4;
                    return 0;
                };

                for (let i = 0; i < def.attackZones.length; i++) {
                    const z = def.attackZones[i];
                    const cdIdx = getBotCooldownIndex(z.inputKey);
                    if (pdata.cooldowns[cdIdx] <= 0 && nearestEnemy.dist <= z.range + ShipDefinitions.get(nearestEnemy.pdata.shipId).hitboxRadius) {
                        let zoneCenterAngle = (pdata.heading + z.angleOffset) % 360;
                        if (zoneCenterAngle < 0) zoneCenterAngle += 360;

                        let diff = Math.abs(angleToEnemy - zoneCenterAngle);
                        if (diff > 180) diff = 360 - diff;

                        if (diff <= z.arcWidth / 2) {
                            if (z.inputKey === 'primary') flags |= 0x10;
                            if (z.inputKey === 'secondary') flags |= 0x20;
                        }
                    }
                }
            }
        }

        if (targetAngle < 0) targetAngle += 360;

        let angleDiff = targetAngle - pdata.heading;
        if (angleDiff > 180) angleDiff -= 360;
        if (angleDiff < -180) angleDiff += 360;

        if (angleDiff > 5) {
            flags |= 0x02;
        } else if (angleDiff < -5) {
            flags |= 0x01;
        }

        return flags;
    }

    step(inputs) {
        const dt = 1 / CONFIG.NETCODE.TICK_RATE;
        const sortedPlayers = this.getSortedPlayerEntries();
        this.updateDangerBorderState();

        for (const [id, pdata] of sortedPlayers) {
            let flags = 0;
            if (pdata.isBot) {
                flags = this.computeBotInput(id, dt);
            } else {
                const input = inputs.get(id);
                flags = input ? (input[0] | (input[1] << 8) | ((input[2] || 0) << 16)) : 0;

                // ── Wheel control scheme steering (deterministic) ────────────
                // Bit 19 = WHEEL_ACTIVE, bits 10-18 = quantized targetHeading.
                // We resolve the turn bits here, inside the deterministic sim,
                // so ALL peers compute the same turn bits from the same input datum.
                if (flags & (1 << 19)) {
                    const targetHeading = (flags >> 10) & 0x1FF; // 0-359
                    let diff = targetHeading - pdata.heading;
                    if (diff > 180) diff -= 360;
                    if (diff < -180) diff += 360;
                    const DEAD = 1.5;
                    // Clear any keyboard-originated turn bits and replace with wheel-derived ones
                    flags &= ~0x03;
                    if (diff > DEAD) flags |= 0x02; // turn right
                    else if (diff < -DEAD) flags |= 0x01; // turn left
                }
            }

            if (flags & 0x200) {
                this.resetLevel();
                this.quantizeState();
                return; // Level reset, skip rest of tick
            }

            const last = this.lastInput.get(id) || 0;

            // Speed controls
            const def = ShipDefinitions.get(pdata.shipId);
            if ((flags & 0x04) && !(last & 0x04)) {
                if ((pdata.slowTimer || 0) <= 0) {
                    pdata.speedTier = Math.min(def.speedTierValues.length, pdata.speedTier + 1);
                }
            }
            if ((flags & 0x08) && !(last & 0x08)) {
                pdata.speedTier = Math.max(1, pdata.speedTier - 1);
            }

            this.lastInput.set(id, flags);

            let ship = this.shipInstances.get(id);
            if (!ship) {
                ship = new Ship(id, pdata);
                this.shipInstances.set(id, ship);
            } else {
                ship.loadState(pdata);
            }

            ship.step(flags, dt);
            Object.assign(pdata, ship.toState());

            if (pdata.invincibilityTimer > 0) {
                pdata.invincibilityTimer = Math.max(0, pdata.invincibilityTimer - dt);
            }
            if (pdata.slowTimer > 0) {
                pdata.slowTimer = Math.max(0, pdata.slowTimer - dt);
            }
        }

        // Check if match ended
        let aliveCount = 0;
        for (const [, p] of sortedPlayers) {
            if (p.alive) aliveCount++;
        }
        const matchEnded = aliveCount <= 1;

        // Process Combat & Attack Zones
        for (const [id, pdata] of sortedPlayers) {
            if (!pdata.alive) continue;

            const def = ShipDefinitions.get(pdata.shipId);
            const flags = this.lastInput.get(id) || 0;

            const getCooldownIndex = (key) => {
                if (key === 'primary') return 0;
                if (key === 'secondary') return 1;
                if (key === 'special1') return 2;
                if (key === 'special2') return 3;
                if (key === 'special3') return 4;
                return 0;
            };

            for (let i = 0; i < pdata.cooldowns.length; i++) {
                if (pdata.cooldowns[i] > 0) {
                    pdata.cooldowns[i] = Math.max(0, pdata.cooldowns[i] - dt);
                }
            }

            const readyToFire = pdata.cooldowns.map(cd => cd === 0);

            for (let i = 0; i < def.attackZones.length; i++) {
                const z = def.attackZones[i];
                const cdIdx = getCooldownIndex(z.inputKey);

                let isFiring = false;
                if (z.inputKey === 'primary' && (flags & 0x10)) isFiring = true;
                if (z.inputKey === 'secondary' && (flags & 0x20)) isFiring = true;
                if (z.inputKey === 'special1' && (flags & 0x40)) isFiring = true;
                if (z.inputKey === 'special2' && (flags & 0x80)) isFiring = true;

                if (isFiring && readyToFire[cdIdx]) {
                    pdata.cooldowns[cdIdx] = Math.max(pdata.cooldowns[cdIdx], z.cooldown);

                    if (z.type === 'bomb') {
                        const dropRad = (pdata.heading + z.angleOffset) * Math.PI / 180;
                        const dropDist = def.hitboxRadius + (z.bomb ? z.bomb.pieceRadius : 12) + 5;
                        const dropX = pdata.x + Math.cos(dropRad) * dropDist;
                        const dropY = pdata.y + Math.sin(dropRad) * dropDist;

                        if (z.bomb) {
                            for (let b = 0; b < z.bomb.pieceCount; b++) {
                                const angle = this.rand() * Math.PI * 2;
                                const dist = this.rand() * z.bomb.spreadRadius;
                                this.debris.push({
                                    x: dropX + Math.cos(angle) * dist,
                                    y: dropY + Math.sin(angle) * dist,
                                    vx: 0, // Bombs are stationary
                                    vy: 0,
                                    life: z.bomb.lifetime || 30,
                                    damage: z.damage,
                                    radius: z.bomb.pieceRadius,
                                    duration: z.bomb.duration || 0,
                                    type: z.bomb.type || 'damage',
                                    spriteKey: z.bomb.spriteKey || null
                                });
                            }
                        }
                    } else {
                        // Check targets inside cone
                        for (const [targetId, targetPdata] of sortedPlayers) {
                            if (id === targetId || !targetPdata.alive) continue;

                            const dx = targetPdata.x - pdata.x;
                            const dy = targetPdata.y - pdata.y;
                            const dist = Math.hypot(dx, dy);

                            if (dist <= z.range + ShipDefinitions.get(targetPdata.shipId).hitboxRadius) {
                                let angleToTarget = Math.atan2(dy, dx) * 180 / Math.PI;
                                if (angleToTarget < 0) angleToTarget += 360;

                                let zoneCenterAngle = (pdata.heading + z.angleOffset) % 360;
                                if (zoneCenterAngle < 0) zoneCenterAngle += 360;

                                let diff = Math.abs(angleToTarget - zoneCenterAngle);
                                if (diff > 180) diff = 360 - diff;

                                if (diff <= z.arcWidth / 2) {
                                    if (targetPdata.invincibilityTimer <= 0 && !matchEnded) {
                                        targetPdata.health -= z.damage;

                                        const distMax = Math.max(1, dist);
                                        targetPdata.knockbackX = (targetPdata.knockbackX || 0) + (dx / distMax) * (z.damage * CONFIG.COMBAT.WEAPON_KNOCKBACK_MULTIPLIER);
                                        targetPdata.knockbackY = (targetPdata.knockbackY || 0) + (dy / distMax) * (z.damage * CONFIG.COMBAT.WEAPON_KNOCKBACK_MULTIPLIER);

                                        targetPdata.invincibilityTimer = 2.0;
                                        if (targetPdata.health <= 0) {
                                            targetPdata.health = 0;
                                            targetPdata.alive = false;
                                            this.spawnDebris(targetPdata.x, targetPdata.y, ShipDefinitions.get(targetPdata.shipId).debris);
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }

        // Process Debris
        for (let i = this.debris.length - 1; i >= 0; i--) {
            const d = this.debris[i];
            d.x += d.vx * dt;
            d.y += d.vy * dt;
            d.life -= dt;
            d.vx *= 0.99; // slight friction
            d.vy *= 0.99;

            if (d.life <= 0) {
                this.debris.splice(i, 1);
                continue;
            }

            // Debris Ship collision
            for (const [targetId, targetPdata] of sortedPlayers) {
                if (!targetPdata.alive) continue;

                const targetDef = ShipDefinitions.get(targetPdata.shipId);
                const dx = targetPdata.x - d.x;
                const dy = targetPdata.y - d.y;
                const distSq = dx * dx + dy * dy;
                const rSum = d.radius + targetDef.hitboxRadius;

                if (distSq <= rSum * rSum) {
                    if (targetPdata.invincibilityTimer <= 0 && !matchEnded) {
                        if (d.type === 'slow') {
                            // Apply slow effect: reduce speed tier down to 1 temporarily
                            targetPdata.speedTier = 1;
                            targetPdata.slowTimer = d.duration || 2.0;
                            // Still do damage but maybe a nominal amount, let's use configured
                            targetPdata.health -= d.damage;

                            // Let's create an external debuff, but since we don't have a debuff system we can just lower health and speed
                            // They can speed back up manually
                        } else {
                            // regular damage
                            targetPdata.health -= d.damage;
                        }

                        targetPdata.invincibilityTimer = 2.0;
                        if (targetPdata.health <= 0) {
                            targetPdata.health = 0;
                            targetPdata.alive = false;
                            this.spawnDebris(targetPdata.x, targetPdata.y, targetDef.debris);
                        }
                    }
                    this.debris.splice(i, 1); // remove debris
                    break; // can only hit one ship at a time
                }
            }
        }

        // Process Death Zone
        const dangerBounds = this.getDangerBorderSafeBounds();
        const dangerDamagePerSecond = this.getDangerBorderDamagePerSecond();
        for (const [id, pdata] of sortedPlayers) {
            if (!pdata.alive) continue;

            if (pdata.x < dangerBounds.left || pdata.x > dangerBounds.right ||
                pdata.y < dangerBounds.top || pdata.y > dangerBounds.bottom) {

                if (!matchEnded) {
                    pdata.health -= dangerDamagePerSecond * dt;
                    if (pdata.health <= 0) {
                        pdata.health = 0;
                        pdata.alive = false;
                        this.spawnDebris(pdata.x, pdata.y, ShipDefinitions.get(pdata.shipId).debris);
                    }
                }
            }
        }

        // Process Ship-to-Ship Collisions
        for (let i = 0; i < sortedPlayers.length; i++) {
            const [id1, p1] = sortedPlayers[i];
            if (!p1.alive) continue;
            for (let j = i + 1; j < sortedPlayers.length; j++) {
                const [id2, p2] = sortedPlayers[j];
                if (!p2.alive) continue;

                const def1 = ShipDefinitions.get(p1.shipId);
                const def2 = ShipDefinitions.get(p2.shipId);

                const dx = p2.x - p1.x;
                const dy = p2.y - p1.y;
                const distSq = dx * dx + dy * dy;
                const rSum = def1.hitboxRadius + def2.hitboxRadius;

                if (distSq < rSum * rSum) {
                    const dist = Math.sqrt(distSq) || 1;
                    const overlap = rSum - dist;
                    const nx = dx / dist;
                    const ny = dy / dist;

                    // Simple push-apart
                    p1.x -= nx * overlap * 0.5;
                    p1.y -= ny * overlap * 0.5;
                    p2.x += nx * overlap * 0.5;
                    p2.y += ny * overlap * 0.5;

                    p1.knockbackX = (p1.knockbackX || 0) - nx * CONFIG.COMBAT.SHIP_COLLISION_KNOCKBACK_MULTIPLIER;
                    p1.knockbackY = (p1.knockbackY || 0) - ny * CONFIG.COMBAT.SHIP_COLLISION_KNOCKBACK_MULTIPLIER;
                    p2.knockbackX = (p2.knockbackX || 0) + nx * CONFIG.COMBAT.SHIP_COLLISION_KNOCKBACK_MULTIPLIER;
                    p2.knockbackY = (p2.knockbackY || 0) + ny * CONFIG.COMBAT.SHIP_COLLISION_KNOCKBACK_MULTIPLIER;

                    if (!matchEnded) {
                        if (p1.invincibilityTimer <= 0) {
                            p1.health -= CONFIG.COMBAT.SHIP_COLLISION_DAMAGE;
                            p1.invincibilityTimer = 2.0;
                            if (p1.health <= 0) {
                                p1.health = 0;
                                p1.alive = false;
                                this.spawnDebris(p1.x, p1.y, ShipDefinitions.get(p1.shipId).debris);
                            }
                        }

                        if (p2.invincibilityTimer <= 0) {
                            p2.health -= CONFIG.COMBAT.SHIP_COLLISION_DAMAGE;
                            p2.invincibilityTimer = 2.0;
                            if (p2.health <= 0) {
                                p2.health = 0;
                                p2.alive = false;
                                this.spawnDebris(p2.x, p2.y, ShipDefinitions.get(p2.shipId).debris);
                            }
                        }
                    }
                }
            }
        }

        this.quantizeState();
    }

    hash(serializedState) {
        const bytes = serializedState instanceof Uint8Array ? serializedState : this.serialize();
        return hashBytesFNV1a(bytes);
    }
}
