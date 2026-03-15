import { Ship } from './Ship.js';
import { ShipDefinitions } from './ShipDefinitions.js';
import {
    POWERUP_TYPES,
    getPlayerPowerupField,
    getPowerupTypeId,
} from './PowerupDefinitions.js';
import { CONFIG } from '../config.js';

const FNV_OFFSET_BASIS_32 = 0x811c9dc5;
const FNV_PRIME_32 = 0x01000193;
const DANGER_BORDER_PHASE = {
    DISABLED: 0,
    WAITING: 1,
    SHRINKING: 2,
    LOCKED: 3,
};
const SAME_TYPE_PICKUP_BEHAVIOR = {
    REFRESH: 0,
    REPLACE: 1,
    IGNORE: 2,
};
const NO_OWNER_SLOT = 255;
const SPEED_BOOST_TYPE_ID = getPowerupTypeId('speed_boost');
const SHIELD_TYPE_ID = getPowerupTypeId('shield');
const ATTACK_BOOST_TYPE_ID = getPowerupTypeId('attack_boost');

function compareCloudZones(a, b) {
    return a.id.localeCompare(b.id) ||
        (a.x - b.x) ||
        (a.y - b.y) ||
        (a.radius - b.radius);
}

function normalizeCloudZones(rawZones = []) {
    const usedIds = new Set();
    const zones = [];

    for (let i = 0; i < rawZones.length; i++) {
        const raw = rawZones[i] || {};
        const fallbackId = `cloud_${i + 1}`;
        const baseId = typeof raw.id === 'string' && raw.id.trim()
            ? raw.id.trim()
            : fallbackId;
        const id = usedIds.has(baseId) ? `${baseId}_${i + 1}` : baseId;
        usedIds.add(id);

        const radius = Math.max(0, Number(raw.radius) || 0);
        if (radius <= 0) continue;

        zones.push({
            id,
            x: Math.fround(Number(raw.x) || 0),
            y: Math.fround(Number(raw.y) || 0),
            radius: Math.fround(radius),
        });
    }

    zones.sort(compareCloudZones);
    return zones;
}

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
        this.cloudCover = this.createCloudCoverState(options.cloudCoverConfig, options.arenaConfig);
        this.dangerBorder = this.createDangerBorderState(options.dangerBorderConfig, this.arena);
        this.powerupConfig = this.createPowerupConfigState(options.powerupConfig);
        this.powerups = [];
        this.nextPowerupId = 1;
        this.powerupSpawnTicksUntilNext = this.powerupConfig.spawnEnabled
            ? this.powerupConfig.spawnIntervalTicks
            : 0;
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

        if (!this.cloudCover) {
            this.cloudCover = this.createCloudCoverState();
        }

        this.cloudCover.enabled = !!this.cloudCover.enabled;
        this.cloudCover.visionRadius = Math.fround(Math.max(0, this.cloudCover.visionRadius || 0));
        this.cloudCover.affectsMinimap = !!this.cloudCover.affectsMinimap;
        this.cloudCover.zones = normalizeCloudZones(this.cloudCover.zones);

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

            player.speedBoostTicks = Math.max(0, player.speedBoostTicks | 0);
            player.shieldTicks = Math.max(0, player.shieldTicks | 0);
            player.attackBoostTicks = Math.max(0, player.attackBoostTicks | 0);
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
            debris.ownerSlot = Number.isInteger(debris.ownerSlot) ? debris.ownerSlot : NO_OWNER_SLOT;
        }

        this.nextPowerupId = Math.max(1, this.nextPowerupId | 0);
        this.powerupSpawnTicksUntilNext = Math.max(0, this.powerupSpawnTicksUntilNext | 0);

        if (!this.powerupConfig) {
            this.powerupConfig = this.createPowerupConfigState();
        }

        this.powerupConfig.enabled = !!this.powerupConfig.enabled;
        this.powerupConfig.maxActive = Math.max(0, this.powerupConfig.maxActive | 0);
        this.powerupConfig.spawnEnabled = !!this.powerupConfig.spawnEnabled;
        this.powerupConfig.spawnIntervalTicks = Math.max(0, this.powerupConfig.spawnIntervalTicks | 0);
        this.powerupConfig.spawnBatchSize = Math.max(1, this.powerupConfig.spawnBatchSize | 0);
        this.powerupConfig.despawnAfterTicks = Math.max(0, this.powerupConfig.despawnAfterTicks | 0);
        this.powerupConfig.pickupRadius = Math.fround(Math.max(0, this.powerupConfig.pickupRadius || 0));
        this.powerupConfig.spawnEdgeInsetX = Math.fround(Math.max(0, this.powerupConfig.spawnEdgeInsetX || 0));
        this.powerupConfig.spawnEdgeInsetY = Math.fround(Math.max(0, this.powerupConfig.spawnEdgeInsetY || 0));
        this.powerupConfig.spawnPlayerClearance = Math.fround(Math.max(0, this.powerupConfig.spawnPlayerClearance || 0));
        this.powerupConfig.spawnPowerupClearance = Math.fround(Math.max(0, this.powerupConfig.spawnPowerupClearance || 0));
        this.powerupConfig.spawnPositionAttempts = Math.max(1, this.powerupConfig.spawnPositionAttempts | 0);
        this.powerupConfig.sameTypePickupBehavior = Math.max(0, this.powerupConfig.sameTypePickupBehavior | 0);

        const typeConfigs = Array.isArray(this.powerupConfig.types) ? this.powerupConfig.types : [];
        this.powerupConfig.types = POWERUP_TYPES.map((typeKey, index) => {
            const raw = typeConfigs[index] || {};
            return {
                enabled: !!raw.enabled,
                durationTicks: Math.max(0, raw.durationTicks | 0),
                speedMultiplier: Math.fround(Number.isFinite(raw.speedMultiplier) ? raw.speedMultiplier : 1),
                damageMultiplier: Math.fround(Number.isFinite(raw.damageMultiplier) ? raw.damageMultiplier : 1),
                spawnWeight: Math.max(0, raw.spawnWeight | 0),
                maxActive: Math.max(0, raw.maxActive | 0),
                key: typeKey,
            };
        });

        for (const powerup of this.powerups) {
            powerup.id = Math.max(1, powerup.id | 0);
            powerup.typeId = Math.max(0, powerup.typeId | 0);
            powerup.x = Math.fround(powerup.x || 0);
            powerup.y = Math.fround(powerup.y || 0);
            powerup.despawnTicks = Math.max(0, powerup.despawnTicks | 0);
        }
    }

    getSortedPlayerEntries() {
        return Array.from(this.players.entries()).sort(([a], [b]) => a.localeCompare(b));
    }

    getSortedPowerups() {
        return [...this.powerups].sort((a, b) => a.id - b.id);
    }

    createPlayerState(slotIndex, overrides = {}) {
        return {
            slot: slotIndex,
            shipId: 'cobro',
            x: 0,
            y: 0,
            heading: 0,
            speedTier: 2,
            health: 100,
            alive: true,
            isBot: false,
            invincibilityTimer: 0,
            slowTimer: 0,
            cooldowns: [0, 0, 0, 0, 0],
            knockbackX: 0,
            knockbackY: 0,
            speedBoostTicks: 0,
            shieldTicks: 0,
            attackBoostTicks: 0,
            ...overrides,
        };
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

    createCloudCoverState(cloudCoverConfig = CONFIG.CLOUD_COVER, mapConfig = CONFIG.MAPS[0]) {
        const config = cloudCoverConfig || {};
        const map = mapConfig || {};
        return {
            enabled: !!config.ENABLED,
            visionRadius: Math.fround(Math.max(0, Number(config.VISION_RADIUS) || 0)),
            affectsMinimap: !!config.AFFECTS_MINIMAP,
            zones: normalizeCloudZones(Array.isArray(map.cloudCoverZones) ? map.cloudCoverZones : []),
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

    createPowerupConfigState(powerupConfig = CONFIG.POWERUPS) {
        const config = powerupConfig || {};
        const tickRate = Math.max(1, Number(CONFIG.NETCODE?.TICK_RATE) || 60);
        const enabled = !!config.ENABLED;
        const spawnEnabled = enabled && !!config.SPAWN_ENABLED;
        const spawnIntervalSeconds = Number(config.SPAWN_INTERVAL_SECONDS);
        const despawnSeconds = Number(config.DESPAWN_AFTER_SECONDS);
        const sameTypeBehavior = String(config.SAME_TYPE_PICKUP_BEHAVIOR || 'refresh').toLowerCase();

        const sameTypePickupBehavior = sameTypeBehavior === 'ignore'
            ? SAME_TYPE_PICKUP_BEHAVIOR.IGNORE
            : sameTypeBehavior === 'replace'
                ? SAME_TYPE_PICKUP_BEHAVIOR.REPLACE
                : SAME_TYPE_PICKUP_BEHAVIOR.REFRESH;

        const rawTypes = config.TYPES || {};
        const typeConfigs = POWERUP_TYPES.map((typeKey) => {
            const raw = rawTypes[typeKey] || {};
            const typeEnabled = enabled && !!raw.ENABLED;
            return {
                key: typeKey,
                enabled: typeEnabled,
                durationTicks: typeEnabled
                    ? Math.max(1, Math.round(Math.max(0, Number(raw.DURATION_SECONDS) || 0) * tickRate))
                    : 0,
                speedMultiplier: Math.fround(Math.max(1, Number(raw.SPEED_MULTIPLIER) || 1)),
                damageMultiplier: Math.fround(Math.max(1, Number(raw.DAMAGE_MULTIPLIER) || 1)),
                spawnWeight: typeEnabled ? Math.max(0, Math.round(Number(raw.SPAWN_WEIGHT) || 0)) : 0,
                maxActive: Math.max(0, Math.round(Number(raw.MAX_ACTIVE) || 0)),
            };
        });

        return {
            enabled,
            maxActive: Math.max(0, Math.round(Number(config.MAX_ACTIVE) || 0)),
            spawnEnabled,
            spawnIntervalTicks: spawnEnabled
                ? Math.max(1, Math.round(Math.max(0, Number.isFinite(spawnIntervalSeconds) ? spawnIntervalSeconds : 0) * tickRate))
                : 0,
            spawnBatchSize: Math.max(1, Math.round(Number(config.SPAWN_BATCH_SIZE) || 1)),
            despawnAfterTicks: Number.isFinite(despawnSeconds) && despawnSeconds > 0
                ? Math.max(1, Math.round(despawnSeconds * tickRate))
                : 0,
            pickupRadius: Math.fround(Math.max(0, Number(config.PICKUP_RADIUS) || 0)),
            spawnEdgeInsetX: Math.fround(Math.max(0, Number(config.SPAWN_EDGE_INSET_X) || 0)),
            spawnEdgeInsetY: Math.fround(Math.max(0, Number(config.SPAWN_EDGE_INSET_Y) || 0)),
            spawnPlayerClearance: Math.fround(Math.max(0, Number(config.SPAWN_PLAYER_CLEARANCE) || 0)),
            spawnPowerupClearance: Math.fround(Math.max(0, Number(config.SPAWN_POWERUP_CLEARANCE) || 0)),
            spawnPositionAttempts: Math.max(1, Math.round(Number(config.SPAWN_POSITION_ATTEMPTS) || 1)),
            sameTypePickupBehavior,
            types: typeConfigs,
        };
    }

    setDangerBorderConfig(borderConfig) {
        this.dangerBorder = this.createDangerBorderState(borderConfig, this.arena);
        this.quantizeState();
    }

    setCloudCoverConfig(cloudCoverConfig, mapConfig = CONFIG.MAPS[0]) {
        this.cloudCover = this.createCloudCoverState(cloudCoverConfig, mapConfig);
        this.quantizeState();
    }

    setPowerupConfig(powerupConfig) {
        this.powerupConfig = this.createPowerupConfigState(powerupConfig);
        this.powerups = [];
        this.nextPowerupId = 1;
        this.powerupSpawnTicksUntilNext = this.powerupConfig.spawnEnabled
            ? this.powerupConfig.spawnIntervalTicks
            : 0;
        for (const [, player] of this.players) {
            this.clearPlayerPowerupEffects(player);
        }
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

    getSortedCloudZones() {
        return [...(this.cloudCover?.zones || [])].sort(compareCloudZones);
    }

    getCloudZoneForPoint(x, y) {
        if (!this.cloudCover?.enabled) return null;

        for (const zone of this.getSortedCloudZones()) {
            const dx = x - zone.x;
            const dy = y - zone.y;
            if ((dx * dx) + (dy * dy) <= zone.radius * zone.radius) {
                return zone;
            }
        }

        return null;
    }

    getPlayerCloudZone(playerOrId) {
        const player = typeof playerOrId === 'string'
            ? this.players.get(playerOrId)
            : playerOrId;
        if (!player) return null;
        return this.getCloudZoneForPoint(player.x, player.y);
    }

    getPlayerCloudZoneId(playerOrId) {
        return this.getPlayerCloudZone(playerOrId)?.id || null;
    }

    getObserverCloudState(observerId) {
        const observer = this.players.get(observerId);
        const zone = observer ? this.getPlayerCloudZone(observer) : null;
        return {
            observerId,
            insideCloud: !!zone,
            zoneId: zone?.id || null,
            zone,
            visionRadius: this.cloudCover?.visionRadius || 0,
            affectsMinimap: !!this.cloudCover?.affectsMinimap,
        };
    }

    getPointVisibilityState(observerId, x, y, options = {}) {
        const cloudsEnabled = !!this.cloudCover?.enabled;
        const observer = this.players.get(observerId);
        const observerZone = options.observerZone || (observer ? this.getPlayerCloudZone(observer) : null);
        const targetZone = options.targetZone || this.getCloudZoneForPoint(x, y);
        const targetRadius = Math.max(0, Number(options.targetRadius) || 0);

        if (!cloudsEnabled) {
            return {
                visible: true,
                reason: 'cloud_cover_disabled',
                observerZoneId: observerZone?.id || null,
                targetZoneId: targetZone?.id || null,
            };
        }

        if (!targetZone) {
            return {
                visible: true,
                reason: observerZone ? 'outside_cloud_from_inside' : 'open_air',
                observerZoneId: observerZone?.id || null,
                targetZoneId: null,
            };
        }

        if (!observer) {
            return {
                visible: true,
                reason: 'observer_missing',
                observerZoneId: null,
                targetZoneId: targetZone.id,
            };
        }

        if (!observerZone) {
            return {
                visible: false,
                reason: 'hidden_from_open_air',
                observerZoneId: null,
                targetZoneId: targetZone.id,
            };
        }

        if (observerZone.id !== targetZone.id) {
            return {
                visible: false,
                reason: 'hidden_in_other_cloud',
                observerZoneId: observerZone.id,
                targetZoneId: targetZone.id,
            };
        }

        const visionRadius = Math.max(0, (this.cloudCover?.visionRadius || 0) + targetRadius);
        const dx = x - observer.x;
        const dy = y - observer.y;
        const visible = (dx * dx) + (dy * dy) <= visionRadius * visionRadius;
        return {
            visible,
            reason: visible ? 'same_cloud_visible' : 'same_cloud_hidden',
            observerZoneId: observerZone.id,
            targetZoneId: targetZone.id,
        };
    }

    getPlayerVisibilityState(observerId, targetId) {
        const target = this.players.get(targetId);
        if (!target || !target.alive) {
            return {
                visible: false,
                reason: 'target_inactive',
                observerZoneId: this.getPlayerCloudZoneId(observerId),
                targetZoneId: target ? this.getPlayerCloudZoneId(target) : null,
            };
        }

        if (observerId === targetId) {
            const zoneId = this.getPlayerCloudZoneId(targetId);
            return {
                visible: true,
                reason: 'self',
                observerZoneId: zoneId,
                targetZoneId: zoneId,
            };
        }

        const shipDef = ShipDefinitions.get(target.shipId);
        return this.getPointVisibilityState(observerId, target.x, target.y, {
            targetRadius: shipDef?.hitboxRadius || 0,
        });
    }

    canObserverSeePoint(observerId, x, y, options = {}) {
        return this.getPointVisibilityState(observerId, x, y, options).visible;
    }

    canPlayerObserveTarget(observerId, targetId) {
        return this.getPlayerVisibilityState(observerId, targetId).visible;
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

    getPowerupTypeConfig(typeKeyOrId) {
        const typeId = typeof typeKeyOrId === 'number' ? typeKeyOrId : getPowerupTypeId(typeKeyOrId);
        return this.powerupConfig?.types?.[typeId] || null;
    }

    getPowerupSpawnBounds() {
        const safeBounds = this.getDangerBorderSafeBounds();
        const insetX = this.powerupConfig?.spawnEdgeInsetX || 0;
        const insetY = this.powerupConfig?.spawnEdgeInsetY || 0;

        let left = safeBounds.left + insetX;
        let right = safeBounds.right - insetX;
        if (left > right) {
            const mid = (safeBounds.left + safeBounds.right) * 0.5;
            left = mid;
            right = mid;
        }

        let top = safeBounds.top + insetY;
        let bottom = safeBounds.bottom - insetY;
        if (top > bottom) {
            const mid = (safeBounds.top + safeBounds.bottom) * 0.5;
            top = mid;
            bottom = mid;
        }

        return { left, right, top, bottom };
    }

    clearPlayerPowerupEffects(player) {
        if (!player) return;
        player.speedBoostTicks = 0;
        player.shieldTicks = 0;
        player.attackBoostTicks = 0;
    }

    getPlayerSpeedMultiplier(player) {
        const typeConfig = this.getPowerupTypeConfig(SPEED_BOOST_TYPE_ID);
        if (!typeConfig?.enabled) return 1;
        return (player?.speedBoostTicks || 0) > 0 ? typeConfig.speedMultiplier : 1;
    }

    hasPlayerShield(player) {
        const typeConfig = this.getPowerupTypeConfig(SHIELD_TYPE_ID);
        if (!typeConfig?.enabled) return false;
        return (player?.shieldTicks || 0) > 0;
    }

    getPlayerDamageMultiplier(player) {
        const typeConfig = this.getPowerupTypeConfig(ATTACK_BOOST_TYPE_ID);
        if (!typeConfig?.enabled) return 1;
        return (player?.attackBoostTicks || 0) > 0 ? typeConfig.damageMultiplier : 1;
    }

    getPlayerBySlot(slot) {
        for (const [, player] of this.players) {
            if (player.slot === slot) return player;
        }
        return null;
    }

    getDamageMultiplierForSlot(slot) {
        if (!Number.isInteger(slot) || slot === NO_OWNER_SLOT) return 1;
        return this.getPlayerDamageMultiplier(this.getPlayerBySlot(slot));
    }

    isPowerupSpawnPositionClear(x, y) {
        const playerClearance = this.powerupConfig?.spawnPlayerClearance || 0;
        const powerupClearance = this.powerupConfig?.spawnPowerupClearance || 0;

        if (playerClearance > 0) {
            for (const [, player] of this.getSortedPlayerEntries()) {
                if (!player.alive) continue;
                const shipDef = ShipDefinitions.get(player.shipId);
                const dx = player.x - x;
                const dy = player.y - y;
                const clearance = playerClearance + shipDef.hitboxRadius;
                if ((dx * dx) + (dy * dy) < clearance * clearance) {
                    return false;
                }
            }
        }

        if (powerupClearance > 0) {
            for (const powerup of this.powerups) {
                const dx = powerup.x - x;
                const dy = powerup.y - y;
                if ((dx * dx) + (dy * dy) < powerupClearance * powerupClearance) {
                    return false;
                }
            }
        }

        return true;
    }

    rollPowerupSpawnPosition() {
        const bounds = this.getPowerupSpawnBounds();
        const width = Math.max(0, bounds.right - bounds.left);
        const height = Math.max(0, bounds.bottom - bounds.top);
        const attempts = Math.max(1, this.powerupConfig?.spawnPositionAttempts || 1);
        let fallback = { x: bounds.left, y: bounds.top };

        for (let i = 0; i < attempts; i++) {
            const x = Math.fround(bounds.left + (width <= 0 ? 0 : this.rand() * width));
            const y = Math.fround(bounds.top + (height <= 0 ? 0 : this.rand() * height));
            fallback = { x, y };
            if (this.isPowerupSpawnPositionClear(x, y)) {
                return fallback;
            }
        }

        return fallback;
    }

    countActivePowerupsByType(typeId) {
        let count = 0;
        for (const powerup of this.powerups) {
            if (powerup.typeId === typeId) count++;
        }
        return count;
    }

    chooseSpawnPowerupTypeId() {
        if (!this.powerupConfig?.enabled || !this.powerupConfig.spawnEnabled) return null;
        if (this.powerups.length >= this.powerupConfig.maxActive) return null;

        const eligible = [];
        let totalWeight = 0;
        for (let typeId = 0; typeId < POWERUP_TYPES.length; typeId++) {
            const typeConfig = this.getPowerupTypeConfig(typeId);
            if (!typeConfig?.enabled) continue;
            if (typeConfig.spawnWeight <= 0) continue;
            if (this.countActivePowerupsByType(typeId) >= typeConfig.maxActive) continue;
            totalWeight += typeConfig.spawnWeight;
            eligible.push({ typeId, totalWeight });
        }

        if (totalWeight <= 0) return null;

        const roll = this.rand() * totalWeight;
        for (const entry of eligible) {
            if (roll < entry.totalWeight) {
                return entry.typeId;
            }
        }

        return eligible[eligible.length - 1]?.typeId ?? null;
    }

    spawnPowerupBatch() {
        if (!this.powerupConfig?.enabled || !this.powerupConfig.spawnEnabled) return;

        const spawnLimit = Math.min(
            this.powerupConfig.spawnBatchSize,
            Math.max(0, this.powerupConfig.maxActive - this.powerups.length)
        );

        for (let i = 0; i < spawnLimit; i++) {
            const typeId = this.chooseSpawnPowerupTypeId();
            if (typeId === null) break;

            const { x, y } = this.rollPowerupSpawnPosition();
            this.powerups.push({
                id: this.nextPowerupId++,
                typeId,
                x,
                y,
                despawnTicks: this.powerupConfig.despawnAfterTicks,
            });
        }
    }

    canPlayerReceivePowerup(player, typeId) {
        const typeConfig = this.getPowerupTypeConfig(typeId);
        if (!player || !typeConfig?.enabled || typeConfig.durationTicks <= 0) return false;

        const field = getPlayerPowerupField(typeId);
        const currentTicks = player[field] || 0;
        if (
            currentTicks > 0 &&
            this.powerupConfig.sameTypePickupBehavior === SAME_TYPE_PICKUP_BEHAVIOR.IGNORE
        ) {
            return false;
        }

        return true;
    }

    updatePowerupSpawnState() {
        if (!this.powerupConfig?.enabled || !this.powerupConfig.spawnEnabled || this.powerupConfig.spawnIntervalTicks <= 0) {
            return;
        }

        this.powerupSpawnTicksUntilNext = Math.max(0, this.powerupSpawnTicksUntilNext - 1);
        if (this.powerupSpawnTicksUntilNext > 0) return;

        this.spawnPowerupBatch();
        this.powerupSpawnTicksUntilNext = this.powerupConfig.spawnIntervalTicks;
    }

    applyPowerupToPlayer(player, typeId) {
        const typeConfig = this.getPowerupTypeConfig(typeId);
        if (!this.canPlayerReceivePowerup(player, typeId)) return false;

        const field = getPlayerPowerupField(typeId);
        const currentTicks = player[field] || 0;
        if (
            currentTicks > 0 &&
            this.powerupConfig.sameTypePickupBehavior === SAME_TYPE_PICKUP_BEHAVIOR.REPLACE
        ) {
            player[field] = 0;
        }

        player[field] = typeConfig.durationTicks;
        return true;
    }

    resolvePowerupPickups(sortedPlayers) {
        if (!this.powerupConfig?.enabled || this.powerups.length === 0) return;

        const survivors = [];
        const sortedPowerups = this.getSortedPowerups();
        for (const powerup of sortedPowerups) {
            let winner = null;
            let winnerDistSq = Infinity;

            for (const [playerId, player] of sortedPlayers) {
                if (!player.alive) continue;
                if (!this.canPlayerReceivePowerup(player, powerup.typeId)) continue;

                const shipDef = ShipDefinitions.get(player.shipId);
                const pickupRadius = this.powerupConfig.pickupRadius + shipDef.hitboxRadius;
                const dx = player.x - powerup.x;
                const dy = player.y - powerup.y;
                const distSq = (dx * dx) + (dy * dy);
                if (distSq > pickupRadius * pickupRadius) continue;

                if (
                    distSq < winnerDistSq ||
                    (distSq === winnerDistSq && (!winner || playerId.localeCompare(winner.playerId) < 0))
                ) {
                    winner = { playerId, player };
                    winnerDistSq = distSq;
                }
            }

            if (winner && this.applyPowerupToPlayer(winner.player, powerup.typeId)) {
                continue;
            }

            survivors.push(powerup);
        }

        this.powerups = survivors;
    }

    tickPowerupState() {
        for (const [, player] of this.getSortedPlayerEntries()) {
            if (player.speedBoostTicks > 0) player.speedBoostTicks -= 1;
            if (player.shieldTicks > 0) player.shieldTicks -= 1;
            if (player.attackBoostTicks > 0) player.attackBoostTicks -= 1;
        }

        const remainingPowerups = [];
        for (const powerup of this.getSortedPowerups()) {
            if (powerup.despawnTicks > 0) {
                powerup.despawnTicks -= 1;
                if (powerup.despawnTicks <= 0) {
                    continue;
                }
            }
            remainingPowerups.push(powerup);
        }
        this.powerups = remainingPowerups;
    }

    destroyPlayer(player) {
        if (!player || !player.alive) return;
        player.health = 0;
        player.alive = false;
        this.clearPlayerPowerupEffects(player);
        this.spawnDebris(player.x, player.y, ShipDefinitions.get(player.shipId).debris);
    }

    applyDamageToPlayer(player, baseDamage, options = {}) {
        if (!player?.alive || !(baseDamage > 0)) {
            return { applied: false, preventedByShield: false, damage: 0, killed: false };
        }

        if (options.respectInvincibility !== false && player.invincibilityTimer > 0) {
            return { applied: false, preventedByShield: false, damage: 0, killed: false };
        }

        if (!options.ignoreShield && this.hasPlayerShield(player)) {
            return { applied: false, preventedByShield: true, damage: 0, killed: false };
        }

        const multiplier = this.getDamageMultiplierForSlot(options.ownerSlot);
        const damage = Math.fround(baseDamage * multiplier);
        player.health = Math.fround(player.health - damage);

        if (options.invincibilitySeconds > 0) {
            player.invincibilityTimer = Math.max(player.invincibilityTimer || 0, options.invincibilitySeconds);
        }

        if (options.slowSeconds > 0) {
            player.speedTier = 1;
            player.slowTimer = Math.max(player.slowTimer || 0, options.slowSeconds);
        }

        if (options.knockbackX || options.knockbackY) {
            player.knockbackX = (player.knockbackX || 0) + (options.knockbackX || 0);
            player.knockbackY = (player.knockbackY || 0) + (options.knockbackY || 0);
        }

        if (player.health <= 0) {
            this.destroyPlayer(player);
            return { applied: true, preventedByShield: false, damage, killed: true };
        }

        return { applied: true, preventedByShield: false, damage, killed: false };
    }

    resetLevel() {
        this.seed = 1337;
        this.debris = [];
        this.resetDangerBorderState();
        this.powerups = [];
        this.nextPowerupId = 1;
        this.powerupSpawnTicksUntilNext = this.powerupConfig.spawnEnabled
            ? this.powerupConfig.spawnIntervalTicks
            : 0;

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
            this.clearPlayerPowerupEffects(p);
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

        this.players.set(id, this.createPlayerState(slotIndex, {
            shipId: 'cobro',
            x,
            y,
            heading,
            speedTier: 2,
            health: 100,
        }));
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
            this.clearPlayerPowerupEffects(ship);
        }
    }

    removePlayer(id) {
        this.players.delete(id);
        this.shipInstances.delete(id);
        this.lastInput.delete(id);
    }

    serialize() {
        const playerEntries = this.getSortedPlayerEntries();
        const cloudZones = this.getSortedCloudZones();
        const count = playerEntries.length;
        const encoder = new TextEncoder();
        let bufferSize = 216 + (this.debris.length * 34) + (this.powerups.length * 20);
        const idBytesList = [];
        const cloudZoneIdBytesList = [];

        for (const zone of cloudZones) {
            const idBytes = encoder.encode(zone.id);
            cloudZoneIdBytesList.push(idBytes);
            bufferSize += 1 + idBytes.length + 12;
        }

        for (const [id] of playerEntries) {
            const idb = encoder.encode(id);
            idBytesList.push(idb);
            bufferSize += 1 + idb.length + 4 + 12 + 24 + 1 + 1 + 1 + 4 + 4 + 20 + 4 + 12;
        }

        const buffer = new ArrayBuffer(bufferSize);
        const view = new DataView(buffer);
        const uint8View = new Uint8Array(buffer);

        let offset = 0;
        view.setUint32(offset, count, true); offset += 4;
        view.setUint32(offset, this.seed, true); offset += 4;
        view.setUint32(offset, this.debris.length, true); offset += 4;
        view.setUint32(offset, this.powerups.length, true); offset += 4;
        view.setUint32(offset, this.nextPowerupId, true); offset += 4;
        view.setUint32(offset, this.powerupSpawnTicksUntilNext, true); offset += 4;
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
        view.setUint32(offset, this.powerupConfig.enabled ? 1 : 0, true); offset += 4;
        view.setUint32(offset, this.powerupConfig.maxActive, true); offset += 4;
        view.setUint32(offset, this.powerupConfig.spawnEnabled ? 1 : 0, true); offset += 4;
        view.setUint32(offset, this.powerupConfig.spawnIntervalTicks, true); offset += 4;
        view.setUint32(offset, this.powerupConfig.spawnBatchSize, true); offset += 4;
        view.setUint32(offset, this.powerupConfig.despawnAfterTicks, true); offset += 4;
        view.setFloat32(offset, this.powerupConfig.pickupRadius, true); offset += 4;
        view.setFloat32(offset, this.powerupConfig.spawnEdgeInsetX, true); offset += 4;
        view.setFloat32(offset, this.powerupConfig.spawnEdgeInsetY, true); offset += 4;
        view.setFloat32(offset, this.powerupConfig.spawnPlayerClearance, true); offset += 4;
        view.setFloat32(offset, this.powerupConfig.spawnPowerupClearance, true); offset += 4;
        view.setUint32(offset, this.powerupConfig.spawnPositionAttempts, true); offset += 4;
        view.setUint32(offset, this.powerupConfig.sameTypePickupBehavior, true); offset += 4;

        for (const typeKey of POWERUP_TYPES) {
            const typeConfig = this.getPowerupTypeConfig(typeKey);
            view.setUint32(offset, typeConfig.enabled ? 1 : 0, true); offset += 4;
            view.setUint32(offset, typeConfig.durationTicks, true); offset += 4;
            view.setFloat32(offset, typeConfig.speedMultiplier, true); offset += 4;
            view.setFloat32(offset, typeConfig.damageMultiplier, true); offset += 4;
            view.setUint32(offset, typeConfig.spawnWeight, true); offset += 4;
            view.setUint32(offset, typeConfig.maxActive, true); offset += 4;
        }

        view.setUint32(offset, this.cloudCover.enabled ? 1 : 0, true); offset += 4;
        view.setFloat32(offset, this.cloudCover.visionRadius, true); offset += 4;
        view.setUint32(offset, this.cloudCover.affectsMinimap ? 1 : 0, true); offset += 4;
        view.setUint32(offset, cloudZones.length, true); offset += 4;

        for (let i = 0; i < cloudZones.length; i++) {
            const zone = cloudZones[i];
            const idBytes = cloudZoneIdBytesList[i];
            view.setUint8(offset, idBytes.length); offset += 1;
            uint8View.set(idBytes, offset); offset += idBytes.length;
            view.setFloat32(offset, zone.x, true); offset += 4;
            view.setFloat32(offset, zone.y, true); offset += 4;
            view.setFloat32(offset, zone.radius, true); offset += 4;
        }

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
            view.setUint32(offset, p.speedBoostTicks || 0, true); offset += 4;
            view.setUint32(offset, p.shieldTicks || 0, true); offset += 4;
            view.setUint32(offset, p.attackBoostTicks || 0, true); offset += 4;
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
            view.setUint8(offset, Number.isInteger(d.ownerSlot) ? d.ownerSlot : NO_OWNER_SLOT); offset += 1;
        }

        for (const powerup of this.getSortedPowerups()) {
            view.setUint32(offset, powerup.id, true); offset += 4;
            view.setUint32(offset, powerup.typeId, true); offset += 4;
            view.setFloat32(offset, powerup.x, true); offset += 4;
            view.setFloat32(offset, powerup.y, true); offset += 4;
            view.setUint32(offset, powerup.despawnTicks, true); offset += 4;
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
        const powerupCount = view.getUint32(offset, true); offset += 4;
        this.nextPowerupId = view.getUint32(offset, true); offset += 4;
        this.powerupSpawnTicksUntilNext = view.getUint32(offset, true); offset += 4;
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
        this.powerupConfig = {
            enabled: view.getUint32(offset, true) === 1,
            maxActive: view.getUint32(offset + 4, true),
            spawnEnabled: view.getUint32(offset + 8, true) === 1,
            spawnIntervalTicks: view.getUint32(offset + 12, true),
            spawnBatchSize: view.getUint32(offset + 16, true),
            despawnAfterTicks: view.getUint32(offset + 20, true),
            pickupRadius: view.getFloat32(offset + 24, true),
            spawnEdgeInsetX: view.getFloat32(offset + 28, true),
            spawnEdgeInsetY: view.getFloat32(offset + 32, true),
            spawnPlayerClearance: view.getFloat32(offset + 36, true),
            spawnPowerupClearance: view.getFloat32(offset + 40, true),
            spawnPositionAttempts: view.getUint32(offset + 44, true),
            sameTypePickupBehavior: view.getUint32(offset + 48, true),
            types: [],
        };
        offset += 52;

        this.powerupConfig.types = POWERUP_TYPES.map((typeKey) => {
            const typeConfig = {
                key: typeKey,
                enabled: view.getUint32(offset, true) === 1,
                durationTicks: view.getUint32(offset + 4, true),
                speedMultiplier: view.getFloat32(offset + 8, true),
                damageMultiplier: view.getFloat32(offset + 12, true),
                spawnWeight: view.getUint32(offset + 16, true),
                maxActive: view.getUint32(offset + 20, true),
            };
            offset += 24;
            return typeConfig;
        });

        const decoder = new TextDecoder();

        this.cloudCover = {
            enabled: view.getUint32(offset, true) === 1,
            visionRadius: view.getFloat32(offset + 4, true),
            affectsMinimap: view.getUint32(offset + 8, true) === 1,
            zones: [],
        };
        const cloudZoneCount = view.getUint32(offset + 12, true);
        offset += 16;

        for (let i = 0; i < cloudZoneCount; i++) {
            const idLen = view.getUint8(offset); offset += 1;
            const idBytes = uint8View.subarray(offset, offset + idLen);
            const id = decoder.decode(idBytes); offset += idLen;
            const x = view.getFloat32(offset, true); offset += 4;
            const y = view.getFloat32(offset, true); offset += 4;
            const radius = view.getFloat32(offset, true); offset += 4;

            this.cloudCover.zones.push({ id, x, y, radius });
        }

        this.players.clear();
        this.lastInput.clear();

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
            const speedBoostTicks = view.getUint32(offset, true); offset += 4;
            const shieldTicks = view.getUint32(offset, true); offset += 4;
            const attackBoostTicks = view.getUint32(offset, true); offset += 4;

            this.players.set(id, {
                slot,
                shipId,
                x,
                y,
                heading,
                speedTier,
                health,
                alive,
                isBot,
                invincibilityTimer,
                slowTimer,
                cooldowns,
                knockbackX,
                knockbackY,
                speedBoostTicks,
                shieldTicks,
                attackBoostTicks,
            });
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
            const ownerSlot = view.getUint8(offset); offset += 1;

            this.debris.push({
                x,
                y,
                vx,
                vy,
                life,
                damage,
                radius,
                duration,
                spriteKey: isBomb ? 'bomb' : 'debris',
                type: typeStr,
                ownerSlot,
            });
        }

        this.powerups = [];
        for (let i = 0; i < powerupCount; i++) {
            const id = view.getUint32(offset, true); offset += 4;
            const typeId = view.getUint32(offset, true); offset += 4;
            const x = view.getFloat32(offset, true); offset += 4;
            const y = view.getFloat32(offset, true); offset += 4;
            const despawnTicks = view.getUint32(offset, true); offset += 4;

            this.powerups.push({ id, typeId, x, y, despawnTicks });
        }

        for (const id of this.shipInstances.keys()) {
            if (!this.players.has(id)) {
                this.shipInstances.delete(id);
            }
        }

        this.quantizeState();
    }

    spawnDebris(x, y, debrisConfig, ownerSlot = NO_OWNER_SLOT) {
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
                spriteKey: debrisConfig.spriteKey || null,
                ownerSlot,
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
        this.updatePowerupSpawnState();

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

            const shipState = { ...pdata, speedMultiplier: this.getPlayerSpeedMultiplier(pdata) };
            let ship = this.shipInstances.get(id);
            if (!ship) {
                ship = new Ship(id, shipState);
                this.shipInstances.set(id, ship);
            } else {
                ship.loadState(shipState);
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

        this.resolvePowerupPickups(sortedPlayers);

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
                                    spriteKey: z.bomb.spriteKey || null,
                                    ownerSlot: pdata.slot,
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
                                    if (matchEnded) continue;

                                    const distMax = Math.max(1, dist);
                                    this.applyDamageToPlayer(targetPdata, z.damage, {
                                        ownerSlot: pdata.slot,
                                        invincibilitySeconds: 2.0,
                                        knockbackX: (dx / distMax) * (z.damage * CONFIG.COMBAT.WEAPON_KNOCKBACK_MULTIPLIER),
                                        knockbackY: (dy / distMax) * (z.damage * CONFIG.COMBAT.WEAPON_KNOCKBACK_MULTIPLIER),
                                    });
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
                    if (!matchEnded) {
                        this.applyDamageToPlayer(targetPdata, d.damage, {
                            ownerSlot: d.ownerSlot,
                            invincibilitySeconds: 2.0,
                            slowSeconds: d.type === 'slow' ? (d.duration || 2.0) : 0,
                        });
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
                    this.applyDamageToPlayer(pdata, dangerDamagePerSecond * dt, {
                        respectInvincibility: false,
                    });
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
                        this.applyDamageToPlayer(p1, CONFIG.COMBAT.SHIP_COLLISION_DAMAGE, {
                            invincibilitySeconds: 2.0,
                        });
                        this.applyDamageToPlayer(p2, CONFIG.COMBAT.SHIP_COLLISION_DAMAGE, {
                            invincibilitySeconds: 2.0,
                        });
                    }
                }
            }
        }

        this.tickPowerupState();
        this.quantizeState();
    }

    hash(serializedState) {
        const bytes = serializedState instanceof Uint8Array ? serializedState : this.serialize();
        return hashBytesFNV1a(bytes);
    }
}
