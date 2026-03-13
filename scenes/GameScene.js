import { vec2, mainContext, mainCanvasSize, mouseWasPressed, mousePosScreen, keyIsDown, keyWasPressed, isUsingGamepad, gamepadStick, gamepadIsDown, gamepadWasPressed } from '../littlejs.esm.min.js';
import { CONFIG } from '../config.js';
import { game, switchScene } from '../App.js';
import { drawScreenText, draw3DButton, drawRoundRect } from '../utils/DrawUtils.js';
import { Ship } from '../game/Ship.js';
import { WorldState } from '../game/WorldState.js';
import { Minimap } from '../game/Minimap.js';
import { assetManager } from '../utils/AssetManager.js';
import { HUD } from '../ui/HUD.js';
import { WheelControl } from '../ui/WheelControl.js';
import { SessionState, PlayerConnectionState } from '../netcode/index.js';

let _buttons = [];
function regBtn(x, y, w, h, id, cb) { _buttons.push({ x, y, w, h, id, cb }); }
function hitTest(mx, my) {
    for (let i = _buttons.length - 1; i >= 0; i--) {
        const b = _buttons[i];
        if (mx >= b.x && mx <= b.x + b.w && my >= b.y && my <= b.y + b.h) return b;
    }
    return null;
}

export class GameScene {
    constructor(data = {}) {
        this.session = game.session;
        this.worldState = game.worldState;
        this.map = CONFIG.MAPS[0]; // 'skyreach' default

        // Camera tracking
        this.camX = 0;
        this.camY = 0;
        this._proceduralClouds = null;

        this.minimap = new Minimap();
        this.hud = new HUD();
        this.gameOverTimer = -1;
        this.spectateId = null;
        this.simTickMs = 1000 / CONFIG.NETCODE.TICK_RATE;
        this.maxCatchUpTicksPerFrame = Math.max(6, CONFIG.NETCODE.MAX_CATCH_UP_TICKS_PER_FRAME || 12);
        this.simClockStartMs = 0;
        this.simClockStartTick = 0;
        this._hadRollbackThisUpdate = false;
        this._awaitingSync = false;
        this._lastSyncRequestAtMs = 0;
        this._sessionSyncHandler = null;
        this._sessionInputDelayHandler = null;
        this._sessionDesyncHandler = null;
        this._sessionLagReportHandler = null;
        this._sessionStaleInputHandler = null;
        this._sessionSyncPayloadHandler = null;
        this._sessionStateChangeHandler = null;
        this._sessionErrorHandler = null;
        this._sessionSpeculationStallHandler = null;
        this._sessionRemoteInputHandler = null;
        this._sessionHashEventHandler = null;
        this._sessionSyncEventHandler = null;
        this._sessionTransportEventHandler = null;
        this._sessionMessageEventHandler = null;
        this._autoPausedForHidden = false;
        this._visibilityHandler = null;
        this.renderShipState = new Map();
        this.renderShips = new Map();
        this.netDebug = this.createNetDebugState();
        this.netDebugEnabled = this.resolveNetDebugEnabled();
        this.telemetry = this.createTelemetryState();
        this._lastPeerMetricsLogAtMs = 0;
        this._telemetryNotice = '';
        this._telemetryNoticeUntilMs = 0;

        // Wheel control scheme
        this.wheelControl = CONFIG.MOVEMENT.WHEEL_CONTROL_SCHEME ? new WheelControl() : null;

        // Monkey-patch: suppress LittleJS left-joystick rendering when wheel is active.
        // We do this once per GameScene construction so it is idempotent.
        if (this.wheelControl && !GameScene._joystickPatched) {
            GameScene._joystickPatched = true;
            GameScene._installJoystickPatch();
        }
    }

    resolveNetDebugEnabled() {
        const fromQuery = typeof window !== 'undefined' &&
            typeof window.location?.search === 'string' &&
            window.location.search.includes('netdebug=1');

        let fromStorage = false;
        try {
            fromStorage = localStorage.getItem('netDebugOverlay') === '1';
        } catch { }

        return fromQuery || fromStorage;
    }

    createNetDebugState() {
        const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
        return {
            sampleStartMs: now,
            rollbacksInWindow: 0,
            rollbackTicksInWindow: 0,
            maxRollbackInWindow: 0,
            rollbacksPerSec: 0,
            rollbackTicksPerSec: 0,
            maxRollbackTicks: 0,
            totalRollbacks: 0,
            totalRollbackTicks: 0,
            syncEvents: 0,
            syncRequests: 0,
            desyncEvents: 0,
            lagReports: 0,
            staleInputsDropped: 0,
            lastSyncTick: -1,
            lastDesyncTick: -1,
            lastLaggyPlayerId: '',
            lastLagTicksBehind: 0,
            desiredTicks: 0,
            ticksProcessed: 0,
            catchUpClamped: false,
            stalledTicks: 0,
            inputDelayTicks: this.session?.inputDelayTicks ?? 0,
            maxRttMs: 0,
            maxJitterMs: 0,
            worstTicksBehind: 0,
            teleportSnapsLastFrame: 0,
            rollbackSnapTeleportsLastFrame: 0,
            speculationStalls: 0,
            lastStallReason: '',
            lastStallSpeculationTicks: 0,
            lastSlowPeerId: '',
            lastSlowPeerTicksBehind: 0,
            lateRemoteInputBatches: 0,
            maxLateRemoteInputTicks: 0,
            lastLateRemoteInputPlayerId: '',
            lastLateRemoteInputTicks: 0,
            hashMatches: 0,
            hashMismatches: 0,
            hashPruned: 0,
            lastHashPhase: '',
            lastHashTick: -1,
            transportErrors: 0,
            transportDisconnects: 0,
            lastTransportPeerId: '',
            lastTransportReason: '',
            lastTransportPhase: '',
            syncCooldownSkips: 0,
            inputEpochAdvances: 0,
            lastSyncPhase: '',
            lastSyncReason: '',
        };
    }

    createTelemetryState() {
        const startPerfMs = typeof performance !== 'undefined' ? performance.now() : Date.now();
        return {
            schema: 'ksb-net-telemetry/v1',
            startedAtIso: new Date().toISOString(),
            startPerfMs,
            maxEvents: 50000,
            droppedEvents: 0,
            events: [],
        };
    }

    safeClone(value) {
        try {
            return JSON.parse(JSON.stringify(value));
        } catch {
            return null;
        }
    }

    getTelemetryNowMs() {
        if (!this.telemetry) return 0;
        const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
        return Number((now - this.telemetry.startPerfMs).toFixed(3));
    }

    recordTelemetry(type, payload = {}) {
        if (!this.telemetry) return;

        const event = {
            t: this.getTelemetryNowMs(),
            type,
            ...payload,
        };

        if (this.telemetry.events.length < this.telemetry.maxEvents) {
            this.telemetry.events.push(event);
        } else {
            this.telemetry.droppedEvents++;
        }
    }

    rollupNetDebugWindow(nowMs) {
        const elapsedMs = nowMs - this.netDebug.sampleStartMs;
        if (elapsedMs < 1000) return;

        const elapsedSeconds = Math.max(0.001, elapsedMs / 1000);
        this.netDebug.rollbacksPerSec = this.netDebug.rollbacksInWindow / elapsedSeconds;
        this.netDebug.rollbackTicksPerSec = this.netDebug.rollbackTicksInWindow / elapsedSeconds;
        this.netDebug.maxRollbackTicks = this.netDebug.maxRollbackInWindow;
        this.netDebug.rollbacksInWindow = 0;
        this.netDebug.rollbackTicksInWindow = 0;
        this.netDebug.maxRollbackInWindow = 0;
        this.netDebug.sampleStartMs = nowMs;
    }

    sampleTransportDiagnostics() {
        let maxRttMs = 0;
        let maxJitterMs = 0;
        const transport = this.session?.transport;

        if (transport?.connectedPeers) {
            for (const peerId of transport.connectedPeers) {
                const metrics = transport.getConnectionMetrics?.(peerId);
                if (!metrics) continue;
                maxRttMs = Math.max(maxRttMs, metrics.rtt || 0);
                maxJitterMs = Math.max(maxJitterMs, metrics.jitter || 0);
            }
        }

        let worstTicksBehind = 0;
        if (this.session?.playerManager) {
            for (const player of this.session.playerManager.values()) {
                if (player.id === this.session.localPlayerId) continue;
                if (player.connectionState !== PlayerConnectionState.Connected) continue;

                const confirmedTick = this.session.engine?.getConfirmedTickForPlayer(player.id);
                if (confirmedTick === undefined) continue;

                const ticksBehind = Math.max(0, this.session.currentTick - confirmedTick);
                worstTicksBehind = Math.max(worstTicksBehind, ticksBehind);
            }
        }

        this.netDebug.maxRttMs = maxRttMs;
        this.netDebug.maxJitterMs = maxJitterMs;
        this.netDebug.worstTicksBehind = worstTicksBehind;
        this.netDebug.inputDelayTicks = this.session?.inputDelayTicks ?? this.netDebug.inputDelayTicks;
    }

    maybeLogPeerMetrics(nowMs) {
        if (nowMs - this._lastPeerMetricsLogAtMs < 500) return;
        this._lastPeerMetricsLogAtMs = nowMs;

        const peers = [];
        const transport = this.session?.transport;
        if (transport?.connectedPeers) {
            for (const peerId of transport.connectedPeers) {
                const metrics = transport.getConnectionMetrics?.(peerId);
                const confirmedTick = this.session?.engine?.getConfirmedTickForPlayer?.(peerId);
                peers.push({
                    peerId,
                    rttMs: Number((metrics?.rtt || 0).toFixed(2)),
                    jitterMs: Number((metrics?.jitter || 0).toFixed(2)),
                    packetLoss: Number((metrics?.packetLoss || 0).toFixed(4)),
                    confirmedTick: confirmedTick ?? null,
                    ticksBehind: confirmedTick === undefined ? null : Math.max(0, this.session.currentTick - confirmedTick),
                });
            }
        }

        this.recordTelemetry('peer_metrics', {
            currentTick: this.session?.currentTick ?? -1,
            peers,
        });
    }

    trackSyncRequest(reason = 'unknown') {
        this.netDebug.syncRequests++;
        this.recordTelemetry('sync_request', {
            reason,
            currentTick: this.session ? this.session.currentTick : -1,
            awaitingSync: this._awaitingSync,
        });
    }

    downloadTelemetry(trigger = 'manual') {
        if (!this.session || !this.telemetry) return;
        this.recordTelemetry('telemetry_export_requested', {
            trigger,
            currentTick: this.session.currentTick,
        });

        const payload = {
            schema: this.telemetry.schema,
            startedAtIso: this.telemetry.startedAtIso,
            exportedAtIso: new Date().toISOString(),
            session: {
                localPlayerId: this.session.localPlayerId,
                roomId: this.session.roomId,
                isHost: this.session.isHost,
                state: this.session.state,
                currentTick: this.session.currentTick,
                confirmedTick: this.session.confirmedTick,
            },
            config: this.safeClone(this.session.config),
            netDebug: this.safeClone(this.netDebug),
            telemetry: {
                droppedEvents: this.telemetry.droppedEvents,
                eventCount: this.telemetry.events.length,
                events: this.telemetry.events,
            },
        };

        try {
            const text = JSON.stringify(payload, null, 2);
            const blob = new Blob([text], { type: 'application/json' });
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
            const localId = (this.session.localPlayerId || 'player').slice(0, 8);
            const filename = `ksb-net-telemetry-${timestamp}-${localId}.json`;
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = filename;
            document.body.appendChild(a);
            a.click();
            a.remove();
            setTimeout(() => URL.revokeObjectURL(url), 1000);

            this._telemetryNotice = `Saved ${filename}`;
            this._telemetryNoticeUntilMs = (typeof performance !== 'undefined' ? performance.now() : Date.now()) + 4000;
            this.recordTelemetry('telemetry_exported', {
                trigger,
                filename,
                eventCount: this.telemetry.events.length,
                droppedEvents: this.telemetry.droppedEvents,
            });
        } catch (error) {
            this._telemetryNotice = 'Telemetry export failed';
            this._telemetryNoticeUntilMs = (typeof performance !== 'undefined' ? performance.now() : Date.now()) + 4000;
            this.recordTelemetry('telemetry_export_failed', {
                trigger,
                error: error instanceof Error ? error.message : String(error),
            });
        }
    }

    normalizeAngleDelta(delta) {
        let d = delta;
        if (d > 180) d -= 360;
        if (d < -180) d += 360;
        return d;
    }

    decodeStateBytesToWorld(stateBytes) {
        if (!(stateBytes instanceof Uint8Array)) return null;
        try {
            const world = new WorldState();
            world.deserialize(stateBytes);
            return world;
        } catch {
            return null;
        }
    }

    buildSyncStateDiff(localStateBytes, remoteStateBytes) {
        const localWorld = this.decodeStateBytesToWorld(localStateBytes);
        const remoteWorld = this.decodeStateBytesToWorld(remoteStateBytes);

        if (!remoteWorld) {
            return { parseError: 'remote_state_decode_failed' };
        }

        if (!localWorld) {
            return {
                localAvailable: false,
                remotePlayerCount: remoteWorld.players.size,
                remoteDebrisCount: remoteWorld.debris.length,
            };
        }

        const bump = (map, key) => { map[key] = (map[key] || 0) + 1; };
        const fieldCounts = {};
        const ids = new Set([...localWorld.players.keys(), ...remoteWorld.players.keys()]);
        const changedPlayers = [];

        for (const id of [...ids].sort((a, b) => a.localeCompare(b))) {
            const local = localWorld.players.get(id);
            const remote = remoteWorld.players.get(id);

            if (!local && remote) {
                bump(fieldCounts, 'player_added');
                changedPlayers.push({ id, status: 'added' });
                continue;
            }
            if (local && !remote) {
                bump(fieldCounts, 'player_removed');
                changedPlayers.push({ id, status: 'removed' });
                continue;
            }
            if (!local || !remote) continue;

            const posDist = Math.hypot((remote.x || 0) - (local.x || 0), (remote.y || 0) - (local.y || 0));
            const headingDiff = Math.abs(this.normalizeAngleDelta((remote.heading || 0) - (local.heading || 0)));
            const healthDiff = Math.abs((remote.health || 0) - (local.health || 0));
            const knockbackDiff = Math.hypot(
                (remote.knockbackX || 0) - (local.knockbackX || 0),
                (remote.knockbackY || 0) - (local.knockbackY || 0)
            );
            const slowTimerDiff = Math.abs((remote.slowTimer || 0) - (local.slowTimer || 0));
            const invincibilityDiff = Math.abs((remote.invincibilityTimer || 0) - (local.invincibilityTimer || 0));
            const speedTierChanged = (remote.speedTier || 0) !== (local.speedTier || 0);
            const aliveChanged = !!remote.alive !== !!local.alive;
            const localCooldowns = local.cooldowns || [];
            const remoteCooldowns = remote.cooldowns || [];
            let cooldownL1 = 0;
            for (let i = 0; i < Math.max(localCooldowns.length, remoteCooldowns.length); i++) {
                cooldownL1 += Math.abs((remoteCooldowns[i] || 0) - (localCooldowns[i] || 0));
            }
            const localLastInput = localWorld.lastInput.get(id) || 0;
            const remoteLastInput = remoteWorld.lastInput.get(id) || 0;
            const lastInputChanged = localLastInput !== remoteLastInput;

            const changed =
                posDist > 0.01 ||
                headingDiff > 0.01 ||
                healthDiff > 0.01 ||
                knockbackDiff > 0.01 ||
                slowTimerDiff > 0.01 ||
                invincibilityDiff > 0.01 ||
                speedTierChanged ||
                aliveChanged ||
                cooldownL1 > 0.01 ||
                lastInputChanged;

            if (!changed) continue;

            if (posDist > 0.01) bump(fieldCounts, 'position');
            if (headingDiff > 0.01) bump(fieldCounts, 'heading');
            if (healthDiff > 0.01) bump(fieldCounts, 'health');
            if (knockbackDiff > 0.01) bump(fieldCounts, 'knockback');
            if (slowTimerDiff > 0.01) bump(fieldCounts, 'slowTimer');
            if (invincibilityDiff > 0.01) bump(fieldCounts, 'invincibilityTimer');
            if (speedTierChanged) bump(fieldCounts, 'speedTier');
            if (aliveChanged) bump(fieldCounts, 'alive');
            if (cooldownL1 > 0.01) bump(fieldCounts, 'cooldowns');
            if (lastInputChanged) bump(fieldCounts, 'lastInput');

            changedPlayers.push({
                id,
                status: 'changed',
                posDist: Number(posDist.toFixed(3)),
                headingDiff: Number(headingDiff.toFixed(3)),
                healthDiff: Number(healthDiff.toFixed(3)),
                knockbackDiff: Number(knockbackDiff.toFixed(3)),
                cooldownL1: Number(cooldownL1.toFixed(3)),
                speedTierChanged,
                aliveChanged,
                lastInputChanged,
            });
        }

        changedPlayers.sort((a, b) => {
            const scoreA = (a.posDist || 0) * 10 + (a.healthDiff || 0) + (a.cooldownL1 || 0) + (a.knockbackDiff || 0);
            const scoreB = (b.posDist || 0) * 10 + (b.healthDiff || 0) + (b.cooldownL1 || 0) + (b.knockbackDiff || 0);
            return scoreB - scoreA;
        });

        const localDebris = localWorld.debris || [];
        const remoteDebris = remoteWorld.debris || [];
        const minDebris = Math.min(localDebris.length, remoteDebris.length);
        let debrisPosDiffCount = 0;
        let debrisTypeDiffCount = 0;
        let debrisLifeDiffCount = 0;
        let maxDebrisPosDiff = 0;

        for (let i = 0; i < minDebris; i++) {
            const l = localDebris[i];
            const r = remoteDebris[i];
            const dist = Math.hypot((r.x || 0) - (l.x || 0), (r.y || 0) - (l.y || 0));
            if (dist > 0.01) {
                debrisPosDiffCount++;
                if (dist > maxDebrisPosDiff) maxDebrisPosDiff = dist;
            }
            if ((l.type || '') !== (r.type || '') || (l.spriteKey || '') !== (r.spriteKey || '')) {
                debrisTypeDiffCount++;
            }
            if (Math.abs((r.life || 0) - (l.life || 0)) > 0.01) {
                debrisLifeDiffCount++;
            }
        }

        if (debrisPosDiffCount > 0) bump(fieldCounts, 'debris_position');
        if (debrisTypeDiffCount > 0) bump(fieldCounts, 'debris_type');
        if (debrisLifeDiffCount > 0) bump(fieldCounts, 'debris_life');
        if (localDebris.length !== remoteDebris.length) bump(fieldCounts, 'debris_count');

        return {
            localAvailable: true,
            localPlayerCount: localWorld.players.size,
            remotePlayerCount: remoteWorld.players.size,
            changedPlayerCount: changedPlayers.length,
            topChangedPlayers: changedPlayers.slice(0, 8),
            fieldCounts,
            debris: {
                localCount: localDebris.length,
                remoteCount: remoteDebris.length,
                posDiffCount: debrisPosDiffCount,
                typeDiffCount: debrisTypeDiffCount,
                lifeDiffCount: debrisLifeDiffCount,
                maxPosDiff: Number(maxDebrisPosDiff.toFixed(3)),
            },
        };
    }

    /**
     * Replace the left-joystick arc in inputRender with a no-op so the
     * LittleJS built-in pad only draws the right-side buttons.
     *
     * Strategy: we override the globalAlpha write that gates the entire
     * touchGamepadRender block. Instead we intercept the ctx.arc call for the
     * left stick and skip it.
     *
     * Because we cannot touch littlejs.esm.min.js we patch the CanvasRenderingContext2D
     * prototype's `arc` method only during the LittleJS render phase via a flag.
     */
    static _installJoystickPatch() {
        const originalArc = CanvasRenderingContext2D.prototype.arc;
        CanvasRenderingContext2D.prototype.arc = function (x, y, radius, startAngle, endAngle, anticlockwise) {
            // When the wheel scheme is active and LittleJS is drawing the left stick
            // (which sits near (touchGamepadSize, sh - touchGamepadSize)), skip it.
            if (GameScene._suppressLeftJoystick) {
                // Left stick center is at approximately (GAMEPAD_SIZE, sh - GAMEPAD_SIZE).
                // We identify it by vicinity to that anchor.
                const pad = CONFIG.MOBILE.GAMEPAD_SIZE;
                const sh = this.canvas ? this.canvas.height : 0;
                const expectedCX = pad;
                const expectedCY = sh - pad;
                const dist = Math.hypot(x - expectedCX, y - expectedCY);
                // The left stick arc has a radius of roughly touchGamepadSize/2 which
                // is GAMEPAD_SIZE/2. Anything within ±10% of GAMEPAD_SIZE distance from
                // the expected centre is the left stick — skip it.
                if (dist < pad * 0.5) return;
            }
            return originalArc.call(this, x, y, radius, startAngle, endAngle, anticlockwise);
        };
    }

    getCloudImage() {
        const img = assetManager.getImage('bgClouds');
        if (img) return img;

        if (!this._proceduralClouds) {
            const canvas = document.createElement('canvas');
            const cw = 2400, ch = 2400;
            canvas.width = cw;
            canvas.height = ch;
            const ctx = canvas.getContext('2d');

            ctx.fillStyle = 'rgba(255, 255, 255, 0.4)';

            let seed = 1337;
            const rand = () => {
                let t = seed += 0x6D2B79F5;
                t = Math.imul(t ^ (t >>> 15), t | 1);
                t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
                return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
            };

            for (let i = 0; i < 40; i++) {
                const x = rand() * cw;
                const y = rand() * ch;
                const size = 30 + rand() * 60;
                ctx.beginPath();
                ctx.arc(x, y, size, 0, Math.PI * 2);
                ctx.arc(x + size, y + size * 0.2, size * 0.8, 0, Math.PI * 2);
                ctx.arc(x - size * 0.8, y + size * 0.4, size * 0.7, 0, Math.PI * 2);
                ctx.arc(x + size * 0.3, y - size * 0.5, size * 0.9, 0, Math.PI * 2);
                ctx.fill();
            }
            this._proceduralClouds = canvas;
        }
        return this._proceduralClouds;
    }

    onEnter() {
        _buttons = [];
        if (!this.session) return;
        this.resetSimulationClock(this.session.currentTick);
        this._autoPausedForHidden = false;
        this._awaitingSync = false;
        this._lastSyncRequestAtMs = 0;
        this.renderShipState.clear();
        this.renderShips.clear();
        this.netDebug = this.createNetDebugState();
        this.telemetry = this.createTelemetryState();
        this._lastPeerMetricsLogAtMs = 0;
        this._telemetryNotice = '';
        this._telemetryNoticeUntilMs = 0;
        this.recordTelemetry('scene_enter', {
            localPlayerId: this.session.localPlayerId,
            roomId: this.session.roomId,
            isHost: this.session.isHost,
            state: this.session.state,
            config: this.safeClone(this.session.config),
        });

        if (!this._visibilityHandler) {
            this._visibilityHandler = () => this.onVisibilityChange();
            document.addEventListener('visibilitychange', this._visibilityHandler);
        }
        if (!this._sessionSyncHandler) {
            this._sessionSyncHandler = (tick) => {
                this.netDebug.syncEvents++;
                this.netDebug.lastSyncTick = tick ?? (this.session ? this.session.currentTick : -1);
                this.recordTelemetry('synced', {
                    tick: this.netDebug.lastSyncTick,
                    currentTick: this.session ? this.session.currentTick : -1,
                });
                this._awaitingSync = false;
                this._hadRollbackThisUpdate = false;
                this.resetSimulationClock(this.session ? this.session.currentTick : 0);
                this.renderShipState.clear();
                this.renderShips.clear();
                this.syncWheelHeadingToLocal();
            };
            this.session.on('synced', this._sessionSyncHandler);
        }
        if (!this._sessionInputDelayHandler) {
            this._sessionInputDelayHandler = (delayTicks, meta) => {
                this.netDebug.inputDelayTicks = delayTicks;
                this.recordTelemetry('input_delay_changed', {
                    delayTicks,
                    worstRttMs: meta?.worstRttMs ?? null,
                    worstJitterMs: meta?.worstJitterMs ?? null,
                    worstInputLagTicks: meta?.worstInputLagTicks ?? null,
                    rollbackPressure: meta?.rollbackPressure ?? null,
                    targetDelay: meta?.targetDelay ?? null,
                    currentTick: this.session ? this.session.currentTick : -1,
                });
            };
            this.session.on('inputDelayChanged', this._sessionInputDelayHandler);
        }
        if (!this._sessionDesyncHandler) {
            this._sessionDesyncHandler = (tick, localHash, remoteHash) => {
                this.netDebug.desyncEvents++;
                this.netDebug.lastDesyncTick = tick;
                this.recordTelemetry('desync', {
                    tick,
                    localHash,
                    remoteHash,
                    currentTick: this.session ? this.session.currentTick : -1,
                });
            };
            this.session.on('desync', this._sessionDesyncHandler);
        }
        if (!this._sessionLagReportHandler) {
            this._sessionLagReportHandler = (laggyPlayerId, ticksBehind) => {
                this.netDebug.lagReports++;
                this.netDebug.lastLaggyPlayerId = laggyPlayerId;
                this.netDebug.lastLagTicksBehind = ticksBehind;
                this.recordTelemetry('lag_report', {
                    laggyPlayerId,
                    ticksBehind,
                    currentTick: this.session ? this.session.currentTick : -1,
                });
            };
            this.session.on('lagReport', this._sessionLagReportHandler);
        }
        if (!this._sessionStaleInputHandler) {
            this._sessionStaleInputHandler = (meta) => {
                this.netDebug.staleInputsDropped++;
                this.recordTelemetry('stale_input_dropped', {
                    playerId: meta?.playerId ?? null,
                    inputEpoch: meta?.inputEpoch ?? null,
                    expectedEpoch: meta?.expectedEpoch ?? null,
                    count: meta?.count ?? 0,
                    currentTick: this.session ? this.session.currentTick : -1,
                });
            };
            this.session.on('staleInputDropped', this._sessionStaleInputHandler);
        }
        if (!this._sessionSyncPayloadHandler) {
            this._sessionSyncPayloadHandler = (payload) => {
                const diff = this.buildSyncStateDiff(payload?.localState, payload?.remoteState);
                this.recordTelemetry('sync_state_diff', {
                    tick: payload?.tick ?? -1,
                    snapshotTick: payload?.snapshotTick ?? -1,
                    syncHash: payload?.hash ?? null,
                    inputEpoch: payload?.inputEpoch ?? null,
                    localHashAtSnapshotTick: payload?.localHashAtSnapshotTick ?? null,
                    ...diff,
                });
            };
            this.session.on('syncPayload', this._sessionSyncPayloadHandler);
        }
        if (!this._sessionStateChangeHandler) {
            this._sessionStateChangeHandler = (newState, oldState) => {
                this.recordTelemetry('state_change', {
                    oldState,
                    newState,
                    currentTick: this.session ? this.session.currentTick : -1,
                });
            };
            this.session.on('stateChange', this._sessionStateChangeHandler);
        }
        if (!this._sessionErrorHandler) {
            this._sessionErrorHandler = (error, meta) => {
                this.recordTelemetry('session_error', {
                    message: error instanceof Error ? error.message : String(error),
                    source: meta?.source ?? null,
                    recoverable: meta?.recoverable ?? null,
                    details: this.safeClone(meta?.details),
                    currentTick: this.session ? this.session.currentTick : -1,
                });
            };
            this.session.on('error', this._sessionErrorHandler);
        }
        if (!this._sessionSpeculationStallHandler) {
            this._sessionSpeculationStallHandler = (meta) => {
                this.netDebug.speculationStalls++;
                this.netDebug.lastStallReason = meta?.reason || '';
                this.netDebug.lastStallSpeculationTicks = meta?.speculationTicks || 0;
                this.netDebug.lastSlowPeerId = meta?.slowestPlayerId || '';
                this.netDebug.lastSlowPeerTicksBehind = meta?.slowestTicksBehind || 0;
                this.recordTelemetry('speculation_stall', {
                    ...this.safeClone(meta),
                });
            };
            this.session.on('speculationStall', this._sessionSpeculationStallHandler);
        }
        if (!this._sessionRemoteInputHandler) {
            this._sessionRemoteInputHandler = (meta) => {
                if (meta?.phase === 'late_batch') {
                    this.netDebug.lateRemoteInputBatches++;
                    const lateTicks = meta?.newestLatenessTicks || 0;
                    this.netDebug.lastLateRemoteInputPlayerId = meta?.playerId || '';
                    this.netDebug.lastLateRemoteInputTicks = lateTicks;
                    this.netDebug.maxLateRemoteInputTicks = Math.max(this.netDebug.maxLateRemoteInputTicks, lateTicks);
                }
                this.recordTelemetry('remote_input_event', {
                    ...this.safeClone(meta),
                });
            };
            this.session.on('remoteInputEvent', this._sessionRemoteInputHandler);
        }
        if (!this._sessionHashEventHandler) {
            this._sessionHashEventHandler = (meta) => {
                const phase = meta?.phase || '';
                this.netDebug.lastHashPhase = phase;
                this.netDebug.lastHashTick = meta?.hashTick ?? this.netDebug.lastHashTick;
                if (phase === 'match') this.netDebug.hashMatches++;
                if (phase === 'mismatch') this.netDebug.hashMismatches++;
                if (phase === 'pruned') this.netDebug.hashPruned++;
                this.recordTelemetry('hash_event', {
                    ...this.safeClone(meta),
                });
            };
            this.session.on('hashEvent', this._sessionHashEventHandler);
        }
        if (!this._sessionSyncEventHandler) {
            this._sessionSyncEventHandler = (meta) => {
                const phase = meta?.phase || '';
                this.netDebug.lastSyncPhase = phase;
                this.netDebug.lastSyncReason = meta?.reason || '';
                if (phase === 'request_skipped_cooldown') this.netDebug.syncCooldownSkips++;
                if (phase === 'input_epoch_advanced') this.netDebug.inputEpochAdvances++;
                this.recordTelemetry('sync_event', {
                    ...this.safeClone(meta),
                });
            };
            this.session.on('syncEvent', this._sessionSyncEventHandler);
        }
        if (!this._sessionTransportEventHandler) {
            this._sessionTransportEventHandler = (meta) => {
                const action = meta?.action || '';
                if (action === 'error') this.netDebug.transportErrors++;
                if (action === 'peer_disconnected') this.netDebug.transportDisconnects++;
                this.netDebug.lastTransportPeerId = meta?.peerId || meta?.playerId || '';
                this.netDebug.lastTransportReason = meta?.reason || meta?.message || '';
                this.netDebug.lastTransportPhase = meta?.phase || action;
                this.recordTelemetry('transport_event', {
                    ...this.safeClone(meta),
                });
            };
            this.session.on('transportEvent', this._sessionTransportEventHandler);
        }
        if (!this._sessionMessageEventHandler) {
            this._sessionMessageEventHandler = (meta) => {
                this.recordTelemetry('message_event', {
                    ...this.safeClone(meta),
                });
            };
            this.session.on('messageEvent', this._sessionMessageEventHandler);
        }
        const local = this.worldState.players.get(this.worldState.localPlayerId);
        if (local) {
            this.camX = local.x;
            this.camY = local.y;
            // Initialise wheel heading to the ship's current heading
            if (this.wheelControl) {
                this.wheelControl.targetHeading = local.heading;
            }
        }
        // Attach wheel touch listeners — listen on document like LittleJS does.
        // Pass the last canvas in DOM as the bounding-rect reference for coordinate conversion
        // (LittleJS puts the 2D overlay canvas last, which is on top and has the correct rect).
        if (this.wheelControl) {
            const canvases = document.querySelectorAll('canvas');
            const canvas = canvases[canvases.length - 1] || document.querySelector('canvas');
            this.wheelControl.attach(canvas);
            // Enable left-joystick suppression for the duration of this scene
            GameScene._suppressLeftJoystick = true;
        }
    }

    onVisibilityChange() {
        if (!this.session) return;

        if (document.visibilityState === 'hidden') {
            this.recordTelemetry('visibility', { state: 'hidden', currentTick: this.session.currentTick });
            if (this.session.isHost && this.session.state === SessionState.Playing) {
                this._autoPausedForHidden = true;
                try {
                    this.session.pause();
                } catch { }
            }
            return;
        }

        this.recordTelemetry('visibility', { state: 'visible', currentTick: this.session.currentTick });

        if (this.session.isHost) {
            if (this._autoPausedForHidden && this.session.state === SessionState.Paused) {
                this.recordTelemetry('visibility_resume_host', { action: 'sync_resume', currentTick: this.session.currentTick });
                this.session.syncState?.('visibility_resume');
                this.session.resume();
            }
            this._autoPausedForHidden = false;
        } else if (this.session.state === SessionState.Playing || this.session.state === SessionState.Paused) {
            this._awaitingSync = true;
            this._lastSyncRequestAtMs = performance.now();
            this.trackSyncRequest('visibility_resume');
            this.session.requestSync?.('visibility_resume');
        }

        this.resetSimulationClock(this.session.currentTick);
        this.syncWheelHeadingToLocal();
    }

    resetSimulationClock(currentTick = 0) {
        this.simClockStartMs = performance.now();
        this.simClockStartTick = currentTick;
    }

    syncWheelHeadingToLocal() {
        if (!this.wheelControl) return;
        const local = this.worldState.players.get(this.worldState.localPlayerId);
        if (!local) return;
        this.wheelControl.syncToHeading(local.heading);
    }

    getDesiredCurrentTick(nowMs) {
        if (!this.simClockStartMs) {
            this.resetSimulationClock(this.session ? this.session.currentTick : 0);
        }
        const elapsedMs = Math.max(0, nowMs - this.simClockStartMs);
        const elapsedTicks = Math.floor(elapsedMs / this.simTickMs);
        return this.simClockStartTick + elapsedTicks + 1;
    }

    updateLocalInput() {
        let input = 0;

        // ── Keyboard steering (always available) ────────────────────────
        if (keyIsDown(CONFIG.KEYS.TURN_LEFT[0]) || keyIsDown(CONFIG.KEYS.TURN_LEFT[1])) input |= 0x01;
        if (keyIsDown(CONFIG.KEYS.TURN_RIGHT[0]) || keyIsDown(CONFIG.KEYS.TURN_RIGHT[1])) input |= 0x02;
        if (keyIsDown(CONFIG.KEYS.SPEED_UP[0]) || keyIsDown(CONFIG.KEYS.SPEED_UP[1])) input |= 0x04;
        if (keyIsDown(CONFIG.KEYS.SPEED_DOWN[0]) || keyIsDown(CONFIG.KEYS.SPEED_DOWN[1])) input |= 0x08;
        if (keyIsDown(CONFIG.KEYS.PRIMARY_FIRE[0])) input |= 0x10;
        if (keyIsDown(CONFIG.KEYS.SECONDARY_FIRE[0])) input |= 0x20;
        if (keyIsDown(CONFIG.KEYS.SPECIAL_1[0])) input |= 0x40;
        if (keyIsDown(CONFIG.KEYS.SPECIAL_2[0])) input |= 0x80;
        if (keyIsDown(CONFIG.KEYS.SPECIAL_3[0])) input |= 0x100;

        if (this.wheelControl) {
            // ── Wheel control scheme ──────────────────────────────────────
            // IMPORTANT (netcode): We must NOT read local.heading from the
            // speculative WorldState here. Doing so would make the input for
            // tick T depend on the simulated heading at tick T, which diverges
            // between peers during rollback and causes determinism failures.
            //
            // Instead, we encode the wheel's absolute targetHeading directly
            // into the input packet (bits 10-18, 0-359°) plus a WHEEL_ACTIVE
            // flag (bit 19). WorldState.step() then computes the turn bits
            // deterministically from (targetHeading - pdata.heading), using
            // only data already present inside the input word.
            const qHeading = Math.round(((this.wheelControl.targetHeading % 360) + 360) % 360) & 0x1FF; // 9 bits, 0-359
            input |= (qHeading << 10);   // bits 10-18
            input |= (1 << 19);          // bit 19 = WHEEL_ACTIVE

            // Gamepad buttons for weapons/speed (right-side pad still active)
            if (isUsingGamepad) {
                if (gamepadIsDown(0)) input |= 0x10;
                if (gamepadIsDown(1)) input |= 0x20;
                if (gamepadIsDown(2)) input |= 0x08;
                if (gamepadIsDown(3)) input |= 0x04;
                if (gamepadIsDown(4) || gamepadIsDown(5)) input |= 0x100;
            }
        } else {
            // ── Standard joystick scheme ──────────────────────────────────
            if (isUsingGamepad) {
                const stick = gamepadStick(0);
                if (stick.x < -0.2) input |= 0x01;
                if (stick.x > 0.2) input |= 0x02;

                if (gamepadIsDown(0)) input |= 0x10;
                if (gamepadIsDown(1)) input |= 0x20;
                if (gamepadIsDown(2)) input |= 0x08;
                if (gamepadIsDown(3)) input |= 0x04;
                if (gamepadIsDown(4) || gamepadIsDown(5)) input |= 0x100;
            }
        }

        if (this.wantRematch) {
            input |= 0x200;
        }

        // 3 bytes: bits 0-7, bits 8-15, bits 16-23
        const inputArr = new Uint8Array(3);
        inputArr[0] = input & 0xFF;
        inputArr[1] = (input >> 8) & 0xFF;
        inputArr[2] = (input >> 16) & 0xFF;
        return inputArr;
    }

    updateRenderShipState() {
        const localId = this.worldState.localPlayerId;
        const hadRollback = this._hadRollbackThisUpdate;
        let teleportSnaps = 0;
        let rollbackSnapTeleports = 0;

        for (const [id, pdata] of this.worldState.players) {
            const isLocal = id === localId;
            const posAlpha = isLocal ? 0.85 : 0.24;
            const headingAlpha = isLocal ? 0.85 : 0.42;

            let smooth = this.renderShipState.get(id);
            if (!smooth) {
                smooth = { x: pdata.x, y: pdata.y, heading: pdata.heading, alive: pdata.alive };
                this.renderShipState.set(id, smooth);
                continue;
            }

            const dx = pdata.x - smooth.x;
            const dy = pdata.y - smooth.y;
            const dist = Math.hypot(dx, dy);
            const rollbackJump = hadRollback && dist > 60;
            const teleported = dist > 220 || rollbackJump || pdata.alive !== smooth.alive;

            if (teleported) {
                teleportSnaps++;
                if (rollbackJump) rollbackSnapTeleports++;
                smooth.x = pdata.x;
                smooth.y = pdata.y;
                smooth.heading = pdata.heading;
            } else {
                let headingDiff = pdata.heading - smooth.heading;
                if (headingDiff > 180) headingDiff -= 360;
                if (headingDiff < -180) headingDiff += 360;

                smooth.x += dx * posAlpha;
                smooth.y += dy * posAlpha;

                // Large heading corrections are usually rollback resimulation;
                // snap immediately to avoid visible "turn back then forward" artifacts.
                const snapThreshold = isLocal ? 60 : 35;
                if (Math.abs(headingDiff) > snapThreshold || (hadRollback && !isLocal && Math.abs(headingDiff) > 18)) {
                    smooth.heading = pdata.heading;
                } else {
                    smooth.heading += headingDiff * headingAlpha;
                    if (smooth.heading >= 360) smooth.heading -= 360;
                    if (smooth.heading < 0) smooth.heading += 360;
                }
            }

            smooth.alive = pdata.alive;

            if (isLocal && hadRollback && this.wheelControl && !this.wheelControl.active) {
                this.wheelControl.syncToHeading(pdata.heading);
            }
        }

        for (const id of this.renderShipState.keys()) {
            if (!this.worldState.players.has(id)) {
                this.renderShipState.delete(id);
            }
        }

        for (const id of this.renderShips.keys()) {
            if (!this.worldState.players.has(id)) {
                this.renderShips.delete(id);
            }
        }

        this.netDebug.teleportSnapsLastFrame = teleportSnaps;
        this.netDebug.rollbackSnapTeleportsLastFrame = rollbackSnapTeleports;
        if (teleportSnaps > 0) {
            this.recordTelemetry('render_snap', {
                teleportSnaps,
                rollbackSnapTeleports,
                hadRollback,
                currentTick: this.session ? this.session.currentTick : -1,
            });
        }
    }

    onUpdate() {
        if (!this.session) return;
        if (keyWasPressed('F3')) {
            this.netDebugEnabled = !this.netDebugEnabled;
            try {
                localStorage.setItem('netDebugOverlay', this.netDebugEnabled ? '1' : '0');
            } catch { }
            this.recordTelemetry('net_debug_toggled', { enabled: this.netDebugEnabled });
        }
        if (keyWasPressed('F4')) {
            this.downloadTelemetry('hotkey_f4');
        }

        if (!this.session.isHost && this._awaitingSync) {
            const nowMs = performance.now();
            if (nowMs - this._lastSyncRequestAtMs > 600) {
                this.trackSyncRequest('awaiting_sync_retry');
                this.session.requestSync?.('awaiting_sync_retry');
                this._lastSyncRequestAtMs = nowMs;
            }
            this.netDebug.desiredTicks = Math.max(0, this.getDesiredCurrentTick(nowMs) - this.session.currentTick);
            this.netDebug.ticksProcessed = 0;
            this.netDebug.catchUpClamped = false;
            this.sampleTransportDiagnostics();
            this.rollupNetDebugWindow(nowMs);
            this.recordTelemetry('frame', {
                phase: 'awaiting_sync',
                currentTick: this.session.currentTick,
                confirmedTick: this.session.confirmedTick,
                desiredTicks: this.netDebug.desiredTicks,
                ticksProcessed: 0,
                catchUpClamped: false,
                inputDelayTicks: this.netDebug.inputDelayTicks,
                worstTicksBehind: this.netDebug.worstTicksBehind,
                maxRttMs: Number(this.netDebug.maxRttMs.toFixed(2)),
                maxJitterMs: Number(this.netDebug.maxJitterMs.toFixed(2)),
                speculationStalls: this.netDebug.speculationStalls,
                transportErrors: this.netDebug.transportErrors,
                lateRemoteInputBatches: this.netDebug.lateRemoteInputBatches,
                hashMismatches: this.netDebug.hashMismatches,
            });
            this.maybeLogPeerMetrics(nowMs);
            this.updateRenderShipState();
            return;
        }

        const now = performance.now();
        const desiredCurrentTick = this.getDesiredCurrentTick(now);
        const desiredTicks = Math.max(0, desiredCurrentTick - this.session.currentTick);
        let ticksToProcess = desiredTicks;
        this.netDebug.desiredTicks = desiredTicks;
        this.netDebug.catchUpClamped = false;

        const dynamicMaxCatchUp = this.session?.isHost
            ? Math.max(this.maxCatchUpTicksPerFrame, Math.floor(this.maxCatchUpTicksPerFrame * 1.5))
            : this.maxCatchUpTicksPerFrame;

        if (ticksToProcess > dynamicMaxCatchUp) {
            const lagTicks = ticksToProcess - dynamicMaxCatchUp;
            ticksToProcess = dynamicMaxCatchUp;
            this.netDebug.catchUpClamped = true;
            this.recordTelemetry('catchup_clamped', {
                desiredTicks,
                maxCatchUp: dynamicMaxCatchUp,
                lagTicks,
                currentTick: this.session.currentTick,
            });

            // If we're severely behind wall-clock, rebase to prevent endless saturation.
            if (lagTicks > dynamicMaxCatchUp * 3) {
                this.recordTelemetry('sim_clock_rebase', {
                    reason: 'severe_catchup_lag',
                    lagTicks,
                    dynamicMaxCatchUp,
                    fromTick: this.session.currentTick,
                    toTick: this.session.currentTick + ticksToProcess,
                });
                this.resetSimulationClock(this.session.currentTick + ticksToProcess);
            }
        }

        this._hadRollbackThisUpdate = false;
        let ticksProcessed = 0;
        let frameRollbacks = 0;
        let frameRollbackTicks = 0;
        let frameStalledTicks = 0;
        for (let i = 0; i < ticksToProcess; i++) {
            const tickBefore = this.session.currentTick;
            const input = this.updateLocalInput();
            const result = this.session.tick(input);
            ticksProcessed++;

            if (result?.rolledBack) this._hadRollbackThisUpdate = true;
            if (result?.rolledBack) {
                const rollbackTicks = Math.max(1, result.rollbackTicks ?? 1);
                frameRollbacks++;
                frameRollbackTicks += rollbackTicks;
                this.netDebug.rollbacksInWindow++;
                this.netDebug.rollbackTicksInWindow += rollbackTicks;
                this.netDebug.maxRollbackInWindow = Math.max(this.netDebug.maxRollbackInWindow, rollbackTicks);
                this.netDebug.totalRollbacks++;
                this.netDebug.totalRollbackTicks += rollbackTicks;
                this.recordTelemetry('rollback', {
                    tick: result.tick ?? tickBefore,
                    rollbackTicks,
                    currentTick: this.session.currentTick,
                    confirmedTick: this.session.confirmedTick,
                });
            }
            if (this.session.currentTick === tickBefore) {
                this.netDebug.stalledTicks++;
                frameStalledTicks++;
                this.recordTelemetry('tick_stalled', {
                    tick: tickBefore,
                    desiredTicks,
                    iteration: i,
                    confirmedTick: this.session.confirmedTick,
                    stalledReason: result?.stalledReason ?? null,
                    speculationTicks: result?.speculationTicks ?? null,
                    minConfirmedTick: result?.minConfirmedTick ?? null,
                });
            }
        }
        this.netDebug.ticksProcessed = ticksProcessed;
        this.sampleTransportDiagnostics();
        this.rollupNetDebugWindow(now);
        this.updateRenderShipState();

        this.recordTelemetry('frame', {
            phase: 'active',
            currentTick: this.session.currentTick,
            confirmedTick: this.session.confirmedTick,
            localAhead: Math.max(0, this.session.currentTick - (this.session.confirmedTick + 1)),
            desiredTicks,
            ticksToProcess,
            ticksProcessed,
            catchUpClamped: this.netDebug.catchUpClamped,
            hadRollback: this._hadRollbackThisUpdate,
            rollbacks: frameRollbacks,
            rollbackTicks: frameRollbackTicks,
            stalledTicks: frameStalledTicks,
            inputDelayTicks: this.netDebug.inputDelayTicks,
            worstTicksBehind: this.netDebug.worstTicksBehind,
            maxRttMs: Number(this.netDebug.maxRttMs.toFixed(2)),
            maxJitterMs: Number(this.netDebug.maxJitterMs.toFixed(2)),
            teleportSnaps: this.netDebug.teleportSnapsLastFrame,
            rollbackSnapTeleports: this.netDebug.rollbackSnapTeleportsLastFrame,
            speculationStalls: this.netDebug.speculationStalls,
            lastStallReason: this.netDebug.lastStallReason,
            lastStallSpeculationTicks: this.netDebug.lastStallSpeculationTicks,
            lateRemoteInputBatches: this.netDebug.lateRemoteInputBatches,
            maxLateRemoteInputTicks: this.netDebug.maxLateRemoteInputTicks,
            hashMismatches: this.netDebug.hashMismatches,
            transportErrors: this.netDebug.transportErrors,
            transportDisconnects: this.netDebug.transportDisconnects,
        });
        this.maybeLogPeerMetrics(now);

        // Update camera targeting smoothly
        let focusId = this.worldState.localPlayerId;
        const local = this.worldState.players.get(focusId);

        if (local && !local.alive) {
            const alivePlayers = Array.from(this.worldState.players.keys()).filter(id => this.worldState.players.get(id).alive);

            if (alivePlayers.length === 1) {
                this.spectateId = alivePlayers[0];
            } else if (keyWasPressed(CONFIG.KEYS.SPECTATE_NEXT[0]) || gamepadWasPressed(0)) {
                if (alivePlayers.length > 0) {
                    if (!this.spectateId || !alivePlayers.includes(this.spectateId)) {
                        this.spectateId = alivePlayers[0];
                    } else {
                        const idx = alivePlayers.indexOf(this.spectateId);
                        this.spectateId = alivePlayers[(idx + 1) % alivePlayers.length];
                    }
                }
            }

            if (this.spectateId && !this.worldState.players.get(this.spectateId).alive) {
                this.spectateId = alivePlayers.length > 0 ? alivePlayers[0] : null;
            }

            if (this.spectateId) {
                focusId = this.spectateId;
            }
        }

        const focusPlayer = this.worldState.players.get(focusId);
        const focusSmooth = this.renderShipState.get(focusId);
        this.focusId = focusId;
        if (focusPlayer) {
            const targetCamX = focusSmooth ? focusSmooth.x : focusPlayer.x;
            const targetCamY = focusSmooth ? focusSmooth.y : focusPlayer.y;
            this.camX += (targetCamX - this.camX) * 0.1;
            this.camY += (targetCamY - this.camY) * 0.1;

            // Camera bounds
            const padding = this.map.deathZoneDepth;
            const s = game.scale;
            const sw = mainCanvasSize.x;
            const sh = mainCanvasSize.y;

            // Limit view to stay roughly within death zone + small margin
            const maxCamX = this.map.width + padding - (sw / 2) / s;
            const minCamX = -padding + (sw / 2) / s;
            const maxCamY = this.map.height + padding - (sh / 2) / s;
            const minCamY = -padding + (sh / 2) / s;

            // Only clamp if the map is actually larger than the screen
            if (maxCamX > minCamX) this.camX = Math.max(minCamX, Math.min(maxCamX, this.camX));
            if (maxCamY > minCamY) this.camY = Math.max(minCamY, Math.min(maxCamY, this.camY));
        }

        const mp = mousePosScreen;
        this._hovered = hitTest(mp.x, mp.y);

        if (mouseWasPressed(0) && this._hovered) {
            this._hovered.cb();
        }

        // Win Condition Check
        let aliveCount = 0;
        let lastAlive = null;
        for (const [id, p] of this.worldState.players) {
            if (p.alive) {
                aliveCount++;
                lastAlive = id;
            }
        }

        if (aliveCount <= 1 && this.gameOverTimer === -1) {
            this.gameOverTimer = 2.0; // Wait 2 seconds before showing game over UI
            this.winner = lastAlive;
        }

        if (this.gameOverTimer > 0) {
            this.gameOverTimer -= 1 / 60;
            if (this.gameOverTimer <= 0) {
                this.gameOverTimer = 0;
            }
        }

        // Let's reset the UI flags if the game restarts
        if (aliveCount > 1) {
            this.gameOverTimer = -1;
            this.winner = null;
            this.wantRematch = false;
        }
    }

    onRender() {
        const c = mainContext;
        const sw = mainCanvasSize.x;
        const sh = mainCanvasSize.y;
        const s = game.scale;
        const cx = sw / 2;
        const cy = sh / 2;
        _buttons = [];

        // Draw Map Background
        const grad = c.createLinearGradient(0, 0, 0, sh);
        grad.addColorStop(0, CONFIG.BACKGROUND_GRADIENT.START);
        grad.addColorStop(1, CONFIG.BACKGROUND_GRADIENT.END);
        c.fillStyle = grad;
        c.fillRect(0, 0, sw, sh);

        if (!this.session) return;

        // Viewport center relative to map
        // Game screen is the full viewport physical dims
        // We calculate offsets for rendering entities based on camera pos
        const renderOffsetX = cx - this.camX * s;
        const renderOffsetY = cy - this.camY * s;

        // Draw clouds with slight parallax
        const bgImg = this.getCloudImage();
        if (bgImg) {
            c.save();
            const parallax = 0.5;
            const imgScale = s * 1.5;
            const imgW = bgImg.width * imgScale;
            const imgH = bgImg.height * imgScale;
            // Modulo to wrap seamlessly
            let ox = (renderOffsetX * parallax) % imgW;
            let oy = (renderOffsetY * parallax) % imgH;
            if (ox > 0) ox -= imgW;
            if (oy > 0) oy -= imgH;

            for (let x = ox - imgW; x < sw + imgW; x += imgW) {
                for (let y = oy - imgH; y < sh + imgH; y += imgH) {
                    c.drawImage(bgImg, x, y, imgW, imgH);
                }
            }
            c.restore();
        }

        // Draw map boundaries
        const mx = renderOffsetX;
        const my = renderOffsetY;
        const mw = this.map.width * s;
        const mh = this.map.height * s;
        c.lineWidth = 4 * s;
        c.strokeStyle = '#FFFFFF';
        c.strokeRect(mx, my, mw, mh);

        // Draw death zone overlay vignette
        // Simplest: fill rects outside the bounds with red tint
        c.fillStyle = `rgba(255,0,0,${CONFIG.DEATH_ZONE.VIGNETTE_ALPHA * 0.3})`;
        c.fillRect(0, 0, sw, Math.max(0, my + this.map.deathZoneDepth * s));
        c.fillRect(0, Math.min(sh, my + mh - this.map.deathZoneDepth * s), sw, sh);
        c.fillRect(0, 0, Math.max(0, mx + this.map.deathZoneDepth * s), sh);
        c.fillRect(Math.min(sw, mx + mw - this.map.deathZoneDepth * s), 0, sw, sh);

        // Render Ships
        for (const [id, pdata] of this.worldState.players) {
            const smooth = this.renderShipState.get(id);
            const renderPdata = smooth
                ? { ...pdata, x: smooth.x, y: smooth.y, heading: smooth.heading }
                : pdata;

            // Keep render-only ship objects separate from simulation ship instances.
            let ship = this.renderShips.get(id);
            if (!ship) {
                ship = new Ship(id, renderPdata);
                this.renderShips.set(id, ship);
            } else {
                ship.loadState(renderPdata);
            }
            const sessionPlayer = this.session?.playerManager.get(id);
            const playerName = sessionPlayer ? sessionPlayer.name : null;
            ship.render(c, s, renderOffsetX, renderOffsetY, 1.0, playerName);
        }

        // Render Debris
        c.fillStyle = '#A0A0A0';
        c.strokeStyle = '#2a2a40';
        c.lineWidth = 2 * s;
        for (const d of this.worldState.debris) {
            let renderedWithSprite = false;
            if (d.spriteKey) {
                const img = assetManager.getImage(d.spriteKey);
                if (img) {
                    const drawSize = d.radius * 2 * s;
                    c.drawImage(img, renderOffsetX + d.x * s - drawSize / 2, renderOffsetY + d.y * s - drawSize / 2, drawSize, drawSize);
                    renderedWithSprite = true;
                }
            }

            if (!renderedWithSprite) {
                c.beginPath();
                c.arc(renderOffsetX + d.x * s, renderOffsetY + d.y * s, d.radius * s, 0, Math.PI * 2);
                if (d.type === 'slow') {
                    c.fillStyle = '#FFDD55'; // Give slow bombs a yellowish tint
                } else {
                    c.fillStyle = '#A0A0A0';
                }
                c.fill();
                c.stroke();
            }
        }

        const renderFocusId = this.focusId || this.worldState.localPlayerId;

        // ── Wheel control render ─────────────────────────────────────────────
        if (this.wheelControl) {
            // Temporarily disable suppress so the wheel's own arc() calls are not filtered.
            // Re-enable immediately after so LittleJS inputRender (runs after gameRender)
            // still sees the flag set and skips the left joystick arc.
            GameScene._suppressLeftJoystick = false;
            this.wheelControl.render(c);
            GameScene._suppressLeftJoystick = true;
        }

        // HUD overlay
        if (this.focusId && this.focusId !== this.worldState.localPlayerId) {
            const specSessionPlayer = this.session?.playerManager.get(this.focusId);
            const specName = specSessionPlayer ? specSessionPlayer.name : this.focusId.slice(0, 6);
            drawScreenText('SPECTATING: ' + specName + ' (FIRE to cycle)', cx, 100 * s, 24 * s, '#FFF', 'center');
        }

        if (this.netDebugEnabled) {
            this.drawNetDebugOverlay(sw, s);
        }

        // drawScreenText('Tick: ' + this.session.currentTick, cx, 30 * s, 14 * s, '#FFF', 'center');

        this.hud.render(c, s, this.worldState, renderFocusId);

        // Minimap HUD
        const padding = 20 * s;
        const mmSize = 150 * s;
        this.minimap.render(c, s * 1.5, this.worldState, renderFocusId, sw - mmSize - padding, padding, mmSize);

        // Game Over Overlay
        if (this.gameOverTimer === 0) {
            c.fillStyle = 'rgba(0,0,0,0.5)';
            c.fillRect(0, 0, sw, sh);
            if (this.winner) {
                const winnerPlayer = this.worldState.players.get(this.winner);
                const winSessionPlayer = this.session?.playerManager.get(this.winner);
                const winName = winSessionPlayer && winSessionPlayer.name ? winSessionPlayer.name : this.winner.slice(0, 6);
                const wColor = winnerPlayer ? CONFIG.UI.PLAYER_COLORS[winnerPlayer.slot % CONFIG.UI.PLAYER_COLORS.length] : '#FFF';
                drawScreenText('WINNER: ' + winName, cx, cy - 80 * s, 48 * s, wColor, 'center', 'middle');
            } else {
                drawScreenText('DRAW!', cx, cy - 80 * s, 48 * s, '#FFF', 'center', 'middle');
            }

            // Rematch button
            const localSessionPlayer = this.session?.playerManager.get(this.session?.localPlayerId);
            const isHost = localSessionPlayer && localSessionPlayer.isHost;

            let otherPlayersConnected = 0;
            if (this.session && this.session.players) {
                for (const [id, player] of this.session.players) {
                    if (id !== this.session.localPlayerId && player.connectionState === 1) { // 1 is PlayerConnectionState.Connected
                        otherPlayersConnected++;
                    }
                }
            }

            if (isHost && otherPlayersConnected > 0 && !this.wantRematch) {
                const rBtnW = 200 * s;
                const rBtnH = 50 * s;
                draw3DButton(cx - rBtnW / 2, cy + 20 * s, rBtnW, rBtnH, 'Rematch', CONFIG.UI.COLORS.SUCCESS, false, this._hovered?.id === 'rematch');
                regBtn(cx - rBtnW / 2, cy + 20 * s, rBtnW, rBtnH, 'rematch', () => {
                    this.wantRematch = true;
                });
            } else if (!isHost) {
                drawScreenText('Waiting for host to rematch...', cx, cy + 30 * s, 20 * s, '#CCC', 'center', 'middle');
            }

            // Leave Match button
            const leaveBtnW = 200 * s;
            const leaveBtnH = 50 * s;
            const leaveBtnY = cy + 90 * s;
            draw3DButton(cx - leaveBtnW / 2, leaveBtnY, leaveBtnW, leaveBtnH, 'Leave Match', CONFIG.UI.COLORS.DANGER, false, this._hovered?.id === 'leave_end');
            regBtn(cx - leaveBtnW / 2, leaveBtnY, leaveBtnW, leaveBtnH, 'leave_end', () => {
                this.session.leaveRoom();
                this.session.destroy();
                game.session = null;
                game.worldState = null;
                switchScene('menu');
            });
        }

        const btnW = 100 * s;
        draw3DButton(padding, padding, btnW, 40 * s, 'Leave', 0xFF6B6B, false, this._hovered?.id === 'leave');
        regBtn(padding, padding, btnW, 40 * s, 'leave', () => {
            if (this.session) {
                this.session.leaveRoom();
                this.session.destroy();
            }
            game.session = null;
            game.worldState = null;
            switchScene('menu');
        });

        const exportBtnW = 150 * s;
        const exportBtnX = padding + btnW + 12 * s;
        draw3DButton(exportBtnX, padding, exportBtnW, 40 * s, 'Export Log', CONFIG.UI.COLORS.WARNING, false, this._hovered?.id === 'export_log');
        regBtn(exportBtnX, padding, exportBtnW, 40 * s, 'export_log', () => {
            this.downloadTelemetry('ui_button');
        });

        const nowMs = performance.now();
        if (this._telemetryNotice && nowMs <= this._telemetryNoticeUntilMs) {
            drawScreenText(this._telemetryNotice, exportBtnX + exportBtnW / 2, padding + 52 * s, 12 * s, '#FFF', 'center', 'middle', 'Arial', true);
        }

    }

    drawNetDebugOverlay(sw, s) {
        const dbg = this.netDebug;
        const localAhead = Math.max(0, this.session.currentTick - (this.session.confirmedTick + 1));
        const lines = [
            'NET DEBUG (F3)',
            `tick cur/conf ${this.session.currentTick}/${this.session.confirmedTick}  ahead ${localAhead}`,
            `desired/proc ${dbg.desiredTicks}/${dbg.ticksProcessed}  clamp ${dbg.catchUpClamped ? 'Y' : 'N'}`,
            `rb/s ${dbg.rollbacksPerSec.toFixed(1)}  rbTicks/s ${dbg.rollbackTicksPerSec.toFixed(1)}  maxRb ${dbg.maxRollbackTicks}`,
            `totRb ${dbg.totalRollbacks}  totRbTicks ${dbg.totalRollbackTicks}  stallTicks ${dbg.stalledTicks}`,
            `stallEv ${dbg.speculationStalls}  last ${dbg.lastStallReason || '-'}  spec ${dbg.lastStallSpeculationTicks}`,
            `snaps tele ${dbg.teleportSnapsLastFrame}  rbTele ${dbg.rollbackSnapTeleportsLastFrame}`,
            `inputDelay ${dbg.inputDelayTicks}t  worstBehind ${dbg.worstTicksBehind}t`,
            `maxRTT ${Math.round(dbg.maxRttMs)}ms  maxJitter ${Math.round(dbg.maxJitterMs)}ms`,
            `sync ${dbg.syncEvents} (req ${dbg.syncRequests}) lastSync ${dbg.lastSyncTick}`,
            `syncPhase ${dbg.lastSyncPhase || '-'}  reason ${dbg.lastSyncReason || '-'}`,
            `desync ${dbg.desyncEvents} last ${dbg.lastDesyncTick} lagReports ${dbg.lagReports}`,
            `staleInputs ${dbg.staleInputsDropped}  lateIn ${dbg.lateRemoteInputBatches} maxLate ${dbg.maxLateRemoteInputTicks}`,
            `hash ok/mm/pr ${dbg.hashMatches}/${dbg.hashMismatches}/${dbg.hashPruned} last ${dbg.lastHashPhase || '-'}@${dbg.lastHashTick}`,
            `transport err/disc ${dbg.transportErrors}/${dbg.transportDisconnects} ${dbg.lastTransportPhase || '-'} ${dbg.lastTransportReason || '-'}`,
        ];
        if (dbg.lastLaggyPlayerId) {
            lines.push(`lastLag ${dbg.lastLaggyPlayerId.slice(0, 8)} ${dbg.lastLagTicksBehind}t`);
        }
        if (dbg.lastSlowPeerId) {
            lines.push(`slowPeer ${dbg.lastSlowPeerId.slice(0, 8)} ${dbg.lastSlowPeerTicksBehind}t`);
        }

        const lineHeight = 15 * s;
        const textSize = 12 * s;
        const padding = 10 * s;
        const panelWidth = 560 * s;
        const panelHeight = padding * 2 + lineHeight * lines.length;
        const x = sw - panelWidth - 18 * s;
        const y = 70 * s;

        drawRoundRect(
            x, y, panelWidth, panelHeight, 10 * s,
            'rgba(8, 12, 22, 0.78)',
            'rgba(255, 255, 255, 0.22)',
            Math.max(1, 1.5 * s)
        );

        for (let i = 0; i < lines.length; i++) {
            drawScreenText(
                lines[i],
                x + padding,
                y + padding + (i + 0.5) * lineHeight,
                textSize,
                '#E6F0FF',
                'left',
                'middle',
                'monospace'
            );
        }
    }

    onExit() {
        this.recordTelemetry('scene_exit', {
            currentTick: this.session ? this.session.currentTick : -1,
            confirmedTick: this.session ? this.session.confirmedTick : -1,
        });
        if (this._visibilityHandler) {
            document.removeEventListener('visibilitychange', this._visibilityHandler);
            this._visibilityHandler = null;
        }
        if (this._sessionSyncHandler && this.session) {
            this.session.off('synced', this._sessionSyncHandler);
            this._sessionSyncHandler = null;
        }
        if (this._sessionInputDelayHandler && this.session) {
            this.session.off('inputDelayChanged', this._sessionInputDelayHandler);
            this._sessionInputDelayHandler = null;
        }
        if (this._sessionDesyncHandler && this.session) {
            this.session.off('desync', this._sessionDesyncHandler);
            this._sessionDesyncHandler = null;
        }
        if (this._sessionLagReportHandler && this.session) {
            this.session.off('lagReport', this._sessionLagReportHandler);
            this._sessionLagReportHandler = null;
        }
        if (this._sessionStaleInputHandler && this.session) {
            this.session.off('staleInputDropped', this._sessionStaleInputHandler);
            this._sessionStaleInputHandler = null;
        }
        if (this._sessionSyncPayloadHandler && this.session) {
            this.session.off('syncPayload', this._sessionSyncPayloadHandler);
            this._sessionSyncPayloadHandler = null;
        }
        if (this._sessionStateChangeHandler && this.session) {
            this.session.off('stateChange', this._sessionStateChangeHandler);
            this._sessionStateChangeHandler = null;
        }
        if (this._sessionErrorHandler && this.session) {
            this.session.off('error', this._sessionErrorHandler);
            this._sessionErrorHandler = null;
        }
        if (this._sessionSpeculationStallHandler && this.session) {
            this.session.off('speculationStall', this._sessionSpeculationStallHandler);
            this._sessionSpeculationStallHandler = null;
        }
        if (this._sessionRemoteInputHandler && this.session) {
            this.session.off('remoteInputEvent', this._sessionRemoteInputHandler);
            this._sessionRemoteInputHandler = null;
        }
        if (this._sessionHashEventHandler && this.session) {
            this.session.off('hashEvent', this._sessionHashEventHandler);
            this._sessionHashEventHandler = null;
        }
        if (this._sessionSyncEventHandler && this.session) {
            this.session.off('syncEvent', this._sessionSyncEventHandler);
            this._sessionSyncEventHandler = null;
        }
        if (this._sessionTransportEventHandler && this.session) {
            this.session.off('transportEvent', this._sessionTransportEventHandler);
            this._sessionTransportEventHandler = null;
        }
        if (this._sessionMessageEventHandler && this.session) {
            this.session.off('messageEvent', this._sessionMessageEventHandler);
            this._sessionMessageEventHandler = null;
        }
        this.renderShipState.clear();
        this.renderShips.clear();
        this._hadRollbackThisUpdate = false;
        this._awaitingSync = false;
        // Detach wheel touch listeners
        if (this.wheelControl) {
            this.wheelControl.detach();
        }
        // Reset suppression flag
        GameScene._suppressLeftJoystick = false;
    }
}

// Static flags for the monkey-patch
GameScene._joystickPatched = false;
GameScene._suppressLeftJoystick = false;
