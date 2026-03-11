import {
    DEFAULT_SESSION_CONFIG,
    SessionState,
    PlayerConnectionState,
    PlayerRole,
    ErrorSource,
    Topology,
    asTick,
    asPlayerId,
    playerIdToPeerId,
    validateSessionConfig,
} from './types.js';
import { encodeMessage, decodeMessage } from './encoding.js';
import { MessageType, isReliableMessage, createInput, createHash, createSync, createSyncRequest, createJoinRequest, createJoinAccept, createJoinReject, createStateSync, createPlayerJoined, createPlayerLeft, createPause, createResume, createLagReport, createDisconnectReport, createResumeCountdown, createDropPlayer } from './messages.js';
import { RollbackEngine } from './engine.js';

const RATE_LIMIT_CLEANUP_INTERVAL_MS = 60000;
const DEFAULT_LAG_REPORT_COOLDOWN_TICKS = 30;

function generateRoomId() {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) {
        return crypto.randomUUID().slice(0, 8);
    }
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    let id = '';
    for (let i = 0; i < 8; i++) {
        id += chars[Math.floor(Math.random() * chars.length)];
    }
    return id;
}

export class Session {
    constructor(options) {
        this.game = options.game;
        this.transport = options.transport;
        this.config = { ...DEFAULT_SESSION_CONFIG, ...options.config };

        validateSessionConfig(this.config);

        this._localPlayerId = options.localPlayerId ?? asPlayerId(this.transport.localPeerId);
        this.debug = this.config.debug;
        this.inputPredictor = options.inputPredictor;
        this.playerIdToPeerId = options.playerIdToPeerId ?? playerIdToPeerId;

        this.playerManager = new Map();
        this.emittedJoinEvents = new Set();
        this.pendingHashMessages = [];
        this.eventHandlers = new Map();
        this.joinRateLimiter = new Map();
        this.lagReports = new Map();
        this.lastHashBroadcastTick = asTick(-1);
        this.inputRedundancy = this.config.inputRedundancy;
        this.inputSizeBytes = this.config.inputSizeBytes;
        this.inputDelayTicks = this.config.baseInputDelayTicks;
        this.lastAdaptiveDelayUpdateTick = asTick(-1);
        this.lastSimulatedLocalInput = new Uint8Array(this.inputSizeBytes);
        this.pendingOutboundInputs = new Map();
        this.lastSyncRequestAtMs = 0;
        this.syncRequestCooldownMs = 500;
        this.rollbackPressure = 0;

        this.engine = this.createEngine();

        this.playerManager.set(this._localPlayerId, {
            id: this._localPlayerId,
            name: this.config.localPlayerName || this._localPlayerId.slice(0, 6),
            connectionState: PlayerConnectionState.Connected,
            joinTick: null,
            leaveTick: null,
            isHost: false,
            role: PlayerRole.Player,
            rtt: 0,
        });

        this.transport.onMessage = (peerId, data) => this.handleMessage(peerId, data);
        this.transport.onConnect = (peerId) => this.handlePeerConnect(peerId);
        this.transport.onDisconnect = (peerId) => this.handlePeerDisconnect(peerId);
        this.transport.onKeepalivePing = (peerId) => this.sendPing(peerId);
        this.transport.onError = (peerId, error, phase) => {
            this.emit(
                'error',
                error instanceof Error ? error : new Error(String(error)),
                { source: ErrorSource.Transport, recoverable: true, details: { peerId, phase } }
            );
        };

        this._state = SessionState.Disconnected;
        this._isHost = false;
        this._roomId = null;
        this._localRole = PlayerRole.Player;

        this.rateLimitCleanupTimer = setInterval(() => {
            this.cleanupRateLimits();
        }, RATE_LIMIT_CLEANUP_INTERVAL_MS);
    }

    get state() {
        return this._state;
    }

    get players() {
        return new Map(this.playerManager);
    }

    get localPlayerId() {
        return this._localPlayerId;
    }

    get isHost() {
        return this._isHost;
    }

    get roomId() {
        return this._roomId;
    }

    get localRole() {
        return this._localRole;
    }

    getHostPlayerId() {
        const host = Array.from(this.playerManager.values()).find(player => player.isHost);
        return host?.id ?? null;
    }

    get currentTick() {
        return this.engine.currentTick;
    }

    get confirmedTick() {
        return this.engine.confirmedTick;
    }

    createEngine() {
        return new RollbackEngine({
            game: this.game,
            localPlayerId: this._localPlayerId,
            snapshotHistorySize: this.config.snapshotHistorySize,
            maxSpeculationTicks: this.config.maxSpeculationTicks,
            inputSizeBytes: this.config.inputSizeBytes,
            inputPredictor: this.inputPredictor,
            onPlayerAddDuringResimulation: (playerId, tick) => {
                if (this.emittedJoinEvents.has(playerId)) return;
                const playerInfo = this.playerManager.get(playerId);
                if (playerInfo) {
                    this.emittedJoinEvents.add(playerId);
                    this.emit('playerJoined', playerInfo);
                }
            },
            onPlayerRemoveDuringResimulation: (playerId, tick) => {
                const playerInfo = this.playerManager.get(playerId);
                if (playerInfo) {
                    this.emit('playerLeft', playerInfo);
                }
            },
            onRollback: (restoreTick) => {
                for (const playerId of this.emittedJoinEvents) {
                    const playerInfo = this.playerManager.get(playerId);
                    if (playerInfo && playerInfo.joinTick !== null && playerInfo.joinTick > restoreTick) {
                        this.emittedJoinEvents.delete(playerId);
                    }
                }
            },
        });
    }

    getJoinAcceptConfigPayload() {
        return {
            tickRate: this.config.tickRate,
            maxPlayers: this.config.maxPlayers,
            topology: this.config.topology,
            snapshotHistorySize: this.config.snapshotHistorySize,
            maxSpeculationTicks: this.config.maxSpeculationTicks,
            hashInterval: this.config.hashInterval,
            disconnectTimeout: this.config.disconnectTimeout,
            desyncAuthority: this.config.desyncAuthority,
            lagReportThreshold: this.config.lagReportThreshold,
            inputRedundancy: this.config.inputRedundancy,
            inputSizeBytes: this.config.inputSizeBytes,
            baseInputDelayTicks: this.config.baseInputDelayTicks,
            maxInputDelayTicks: this.config.maxInputDelayTicks,
            adaptiveInputDelay: this.config.adaptiveInputDelay,
            adaptiveDelayUpdateInterval: this.config.adaptiveDelayUpdateInterval,
            jitterBufferMs: this.config.jitterBufferMs,
            joinRateLimitRequests: this.config.joinRateLimitRequests,
            joinRateLimitWindowMs: this.config.joinRateLimitWindowMs,
        };
    }

    applyHostSessionConfig(hostConfig) {
        if (!hostConfig || typeof hostConfig !== 'object') return;

        const allowedKeys = [
            'tickRate',
            'maxPlayers',
            'topology',
            'snapshotHistorySize',
            'maxSpeculationTicks',
            'hashInterval',
            'disconnectTimeout',
            'desyncAuthority',
            'lagReportThreshold',
            'inputRedundancy',
            'inputSizeBytes',
            'baseInputDelayTicks',
            'maxInputDelayTicks',
            'adaptiveInputDelay',
            'adaptiveDelayUpdateInterval',
            'jitterBufferMs',
            'joinRateLimitRequests',
            'joinRateLimitWindowMs',
        ];

        const sanitized = {};
        for (const key of allowedKeys) {
            if (Object.prototype.hasOwnProperty.call(hostConfig, key)) {
                sanitized[key] = hostConfig[key];
            }
        }

        const merged = { ...this.config, ...sanitized };
        validateSessionConfig(merged);

        this.config = merged;
        this.debug = this.config.debug;
        this.inputRedundancy = this.config.inputRedundancy;
        this.inputSizeBytes = this.config.inputSizeBytes;
        this.inputDelayTicks = this.config.baseInputDelayTicks;
        this.lastAdaptiveDelayUpdateTick = asTick(-1);
        this.lastSimulatedLocalInput = new Uint8Array(this.inputSizeBytes);
        this.pendingOutboundInputs = new Map();
        this.rollbackPressure = 0;
        this.pendingHashMessages = [];
        this.engine = this.createEngine();
    }

    destroy() {
        this.leaveRoom();

        if (this.rateLimitCleanupTimer) {
            clearInterval(this.rateLimitCleanupTimer);
            this.rateLimitCleanupTimer = null;
        }

        this.joinRateLimiter.clear();
        this.lagReports.clear();
        this.pendingHashMessages = [];

        this.transport.onMessage = null;
        this.transport.onConnect = null;
        this.transport.onDisconnect = null;
        this.transport.onError = null;
    }

    async createRoom() {
        if (this._state !== SessionState.Disconnected) {
            throw new Error('Already in a room or connecting');
        }

        this._roomId = generateRoomId();
        this._isHost = true;

        const localPlayer = this.playerManager.get(this.localPlayerId);
        if (localPlayer) {
            localPlayer.isHost = true;
            localPlayer.joinTick = asTick(0);
        }

        this.setState(SessionState.Lobby);
        return this._roomId;
    }

    async joinRoom(roomId, hostPeerId) {
        if (this._state !== SessionState.Disconnected) {
            throw new Error('Already in a room or connecting');
        }

        this._roomId = roomId;
        this._isHost = false;
        this.setState(SessionState.Connecting);

        await this.transport.connect(hostPeerId);
        this.sendToHost(createJoinRequest(this.localPlayerId, this._localRole, this.config.localPlayerName || ''));
    }

    leaveRoom() {
        if (this._state === SessionState.Disconnected) return;

        if (this._state === SessionState.Playing) {
            this.broadcast(createPlayerLeft(this.localPlayerId, this.engine.currentTick), true);
        }

        this.transport.disconnectAll();

        this._roomId = null;
        this._isHost = false;
        this.playerManager.clear();
        this.emittedJoinEvents.clear();
        this.engine.reset();
        this.inputDelayTicks = this.config.baseInputDelayTicks;
        this.lastAdaptiveDelayUpdateTick = asTick(-1);
        this.lastSimulatedLocalInput = new Uint8Array(this.inputSizeBytes);
        this.pendingOutboundInputs.clear();
        this.rollbackPressure = 0;

        this.playerManager.set(this._localPlayerId, {
            id: this.localPlayerId,
            name: this.config.localPlayerName || this.localPlayerId.slice(0, 6),
            connectionState: PlayerConnectionState.Connected,
            joinTick: null,
            leaveTick: null,
            isHost: false,
            role: PlayerRole.Player,
            rtt: 0,
        });

        this.setState(SessionState.Disconnected);
    }

    start() {
        if (!this._isHost) throw new Error('Only the host can start the game');
        if (this._state !== SessionState.Lobby) throw new Error('Can only start from lobby state');

        this.inputDelayTicks = this.config.baseInputDelayTicks;
        this.lastAdaptiveDelayUpdateTick = asTick(-1);
        this.lastSimulatedLocalInput = new Uint8Array(this.inputSizeBytes);
        this.pendingOutboundInputs.clear();
        this.rollbackPressure = 0;

        const startTick = asTick(0);
        for (const player of this.playerManager.values()) {
            player.joinTick = startTick;
            if (player.role === PlayerRole.Player) {
                this.engine.addPlayer(player.id, startTick);
            }
        }

        const state = this.engine.getState();
        for (const pt of state.playerTimeline) {
            const p = this.playerManager.get(pt.playerId);
            if (p) pt.name = p.name;
        }
        this.broadcast(createStateSync(state.tick, state.state, this.engine.getCurrentHash(), state.playerTimeline), true);

        this.setState(SessionState.Playing);
        this.emit('gameStart');
    }

    pause(reason = 0) {
        if (!this._isHost) throw new Error('Only the host can pause');
        if (this._state !== SessionState.Playing) return;

        this.broadcast(createPause(this.localPlayerId, this.engine.currentTick, reason), true);
        this.setState(SessionState.Paused);
    }

    resume() {
        if (!this._isHost) throw new Error('Only the host can resume');
        if (this._state !== SessionState.Paused) return;

        this.broadcast(createResume(this.localPlayerId, this.engine.currentTick), true);
        this.setState(SessionState.Playing);
    }

    sendResumeCountdown(secondsRemaining) {
        if (!this._isHost) throw new Error('Only the host can send resume countdown');
        if (this._state !== SessionState.Paused) return;

        this.broadcast(createResumeCountdown(secondsRemaining), true);
        this.emit('resumeCountdown', secondsRemaining);
    }

    dropPlayer(playerId, metadata) {
        if (!this._isHost) throw new Error('Only the host can drop players');

        const player = this.playerManager.get(playerId);
        if (!player) return;

        this.markPlayerDisconnected(playerId);
        this.broadcast(createDropPlayer(playerId, metadata), true);
        this.emit('playerDropped', playerId, metadata);
    }

    tick(localInput) {
        if (this._state !== SessionState.Playing) {
            return { tick: this.engine.currentTick, rolledBack: false };
        }

        const currentTick = this.engine.currentTick;

        if (this._localRole === PlayerRole.Player) {
            if (!localInput) throw new Error('Players must provide input');
            this.scheduleLocalInput(currentTick, localInput);
        }

        const result = this.engine.tick();
        this.observeRollbackPressure(result);

        if (result.error) {
            this.emit('error', result.error, { source: ErrorSource.Engine, recoverable: true, details: { tick: result.tick } });
            if (!this._isHost) this.requestSync();
        }

        if (result.rolledBack && result.rollbackTicks !== undefined) {
            const rollbackToTick = asTick(result.tick - result.rollbackTicks);
            this.pendingHashMessages = this.pendingHashMessages.filter(h => h.tick < rollbackToTick);
        }

        this.processPendingHashComparisons();
        this.maybeBroadcastHash();
        this.checkAndReportLag();

        return result;
    }

    requestSync() {
        if (this._isHost) return;
        const now = Date.now();
        if (now - this.lastSyncRequestAtMs < this.syncRequestCooldownMs) return;
        this.lastSyncRequestAtMs = now;
        this.sendToHost(createSyncRequest(this.localPlayerId, this.engine.currentTick, this.engine.getCurrentHash()));
    }

    syncState() {
        if (!this._isHost) return;
        if (this._state !== SessionState.Playing && this._state !== SessionState.Paused) return;

        const state = this.engine.getState();
        for (const pt of state.playerTimeline) {
            const p = this.playerManager.get(pt.playerId);
            if (p) pt.name = p.name;
        }
        const syncMsg = createSync(state.tick, state.state, this.engine.getCurrentHash(), state.playerTimeline);
        this.broadcast(syncMsg, true);

        // Keep host internals aligned with the same sync baseline it just sent.
        this.engine.resetForSync(state.tick, state.playerTimeline);
        this.pendingHashMessages = [];
        this.lastSimulatedLocalInput = new Uint8Array(this.inputSizeBytes);
        this.lastAdaptiveDelayUpdateTick = asTick(-1);
        this.pendingOutboundInputs.clear();
        this.rollbackPressure = 0;
        this.emit('synced', state.tick);
    }

    on(event, handler) {
        if (!this.eventHandlers.has(event)) {
            this.eventHandlers.set(event, new Set());
        }
        this.eventHandlers.get(event).add(handler);
    }

    off(event, handler) {
        this.eventHandlers.get(event)?.delete(handler);
    }

    removeAllListeners(event) {
        if (event !== undefined) {
            this.eventHandlers.delete(event);
        } else {
            this.eventHandlers.clear();
        }
    }

    emit(event, ...args) {
        const handlers = this.eventHandlers.get(event);
        if (handlers) {
            for (const handler of handlers) {
                try {
                    handler(...args);
                } catch (error) {
                    if (event !== 'error') {
                        this.emit('error', error instanceof Error ? error : new Error(String(error)), { source: ErrorSource.Session, recoverable: true });
                    }
                }
            }
        }
    }

    setState(newState) {
        const oldState = this._state;
        if (oldState === newState) return;

        this._state = newState;
        this.emit('stateChange', newState, oldState);
    }

    handleMessage(peerId, data) {
        this.transport.recordPeerResponse?.(peerId);

        let message;
        try {
            message = decodeMessage(data);
        } catch (error) {
            this.emit('error', error, { source: ErrorSource.Protocol, recoverable: true, details: { peerId } });
            return;
        }

        if (!this.isAuthorizedMessagePeer(peerId, message)) {
            this.emit(
                'error',
                new Error(`Rejected spoofed message ${message.type} from ${peerId}`),
                { source: ErrorSource.Protocol, recoverable: true, details: { peerId, messageType: message.type } }
            );
            return;
        }

        switch (message.type) {
            case MessageType.Input:
                this.handleInputMessage(message);
                break;
            case MessageType.Hash:
                this.handleHashMessage(message);
                break;
            case MessageType.Sync:
            case MessageType.StateSync:
                this.handleSyncMessage(message);
                break;
            case MessageType.SyncRequest:
                this.handleSyncRequest(message);
                break;
            case MessageType.JoinRequest:
                this.handleJoinRequest(peerId, message);
                break;
            case MessageType.JoinAccept:
                this.handleJoinAccept(message);
                break;
            case MessageType.JoinReject:
                this.handleJoinReject(message);
                break;
            case MessageType.PlayerJoined:
                this.handlePlayerJoined(message);
                break;
            case MessageType.PlayerLeft:
                this.handlePlayerLeft(message);
                break;
            case MessageType.Pause:
                this.setState(SessionState.Paused);
                break;
            case MessageType.Resume:
                this.setState(SessionState.Playing);
                if (!this._isHost) this.requestSync();
                break;
            case MessageType.Ping:
                this.transport.handlePing?.(peerId, message.timestamp);
                break;
            case MessageType.Pong:
                this.transport.handlePong?.(peerId, message.timestamp);
                break;
            case MessageType.DisconnectReport:
                this.handleDisconnectReport(message);
                break;
            case MessageType.LagReport:
                this.handleLagReport(message);
                break;
            case MessageType.ResumeCountdown:
                this.emit('resumeCountdown', message.secondsRemaining);
                break;
            case MessageType.DropPlayer:
                this.handleDropPlayer(message);
                break;
        }
    }

    handleInputMessage(message) {
        for (const { tick, input } of message.inputs) {
            this.engine.receiveRemoteInput(message.playerId, tick, input);
        }

        if (this._isHost && this.config.topology === Topology.Star) {
            for (const peerId of this.transport.connectedPeers) {
                if (peerId !== message.playerId) {
                    this.transport.send(peerId, encodeMessage(message), false);
                }
            }
        }
    }

    handleHashMessage(message) {
        this.pendingHashMessages.push({
            tick: message.tick,
            playerId: message.playerId,
            hash: message.hash,
        });
    }

    processPendingHashComparisons() {
        if (this.pendingHashMessages.length === 0) return;

        const currentTick = this.engine.currentTick;
        const confirmedTick = this.engine.confirmedTick;
        const remaining = [];
        const pruneThreshold = asTick(Math.max(0, currentTick - this.config.hashInterval * 2));

        for (const pending of this.pendingHashMessages) {
            if (pending.tick < pruneThreshold) continue;

            if (pending.tick > confirmedTick) {
                remaining.push(pending);
                continue;
            }

            const localHash = this.engine.getHash(pending.tick);
            if (localHash !== undefined && localHash !== pending.hash) {
                this.emit('desync', pending.tick, localHash, pending.hash);
                if (!this._isHost) this.requestSync();
            }
        }

        this.pendingHashMessages = remaining;
    }

    handleSyncMessage(message) {
        this.engine.setState(message.tick, message.state, message.playerTimeline);
        this.pendingHashMessages = [];
        this.lastSimulatedLocalInput = new Uint8Array(this.inputSizeBytes);
        this.lastAdaptiveDelayUpdateTick = asTick(-1);
        this.pendingOutboundInputs.clear();
        this.rollbackPressure = 0;

        for (const entry of message.playerTimeline) {
            const connectionState = entry.leaveTick !== null ? PlayerConnectionState.Disconnected : PlayerConnectionState.Connected;

            if (!this.playerManager.has(entry.playerId)) {
                this.playerManager.set(entry.playerId, {
                    id: entry.playerId,
                    name: entry.name || entry.playerId.slice(0, 6),
                    connectionState,
                    joinTick: entry.joinTick,
                    leaveTick: entry.leaveTick,
                    isHost: false,
                    role: PlayerRole.Player,
                    rtt: 0,
                });
            } else {
                const existing = this.playerManager.get(entry.playerId);
                if (existing) {
                    existing.connectionState = connectionState;
                    existing.joinTick = entry.joinTick;
                    existing.leaveTick = entry.leaveTick;
                    if (entry.name) existing.name = entry.name;
                }
            }
        }

        if (this._state === SessionState.Connecting || this._state === SessionState.Lobby) {
            this.setState(SessionState.Playing);
            this.emit('gameStart');
        }

        this.emit('synced', message.tick);
    }

    handleSyncRequest(message) {
        if (!this._isHost) return;

        const state = this.engine.getState();
        for (const pt of state.playerTimeline) {
            const p = this.playerManager.get(pt.playerId);
            if (p) pt.name = p.name;
        }
        const syncMsg = createSync(state.tick, state.state, this.engine.getCurrentHash(), state.playerTimeline);
        this.broadcast(syncMsg, true);
        this.engine.resetForSync(state.tick, state.playerTimeline);
        this.pendingHashMessages = [];
        this.lastSimulatedLocalInput = new Uint8Array(this.inputSizeBytes);
        this.lastAdaptiveDelayUpdateTick = asTick(-1);
        this.pendingOutboundInputs.clear();
        this.rollbackPressure = 0;
        this.emit('synced', state.tick);
    }

    handleJoinRequest(peerId, message) {
        if (!this._isHost || !this._roomId) return;

        const playerId = message.playerId;

        if (this.isRateLimited(peerId)) {
            this.transport.send(peerId, encodeMessage(createJoinReject(playerId, 'Too many join requests, please wait')), true);
            return;
        }

        const connectedPlayers = Array.from(this.playerManager.values()).filter(p => p.connectionState === PlayerConnectionState.Connected);
        if (connectedPlayers.length >= this.config.maxPlayers) {
            this.transport.send(peerId, encodeMessage(createJoinReject(playerId, 'Room is full')), true);
            return;
        }

        const playerIds = connectedPlayers.map(p => ({ id: p.id, name: p.name || '' }));
        const joinConfig = this.getJoinAcceptConfigPayload();
        this.transport.send(peerId, encodeMessage(createJoinAccept(playerId, this._roomId, joinConfig, playerIds)), true);

        const playerRole = message.role ?? PlayerRole.Player;
        const playerInfo = {
            id: playerId,
            name: message.name || playerId.slice(0, 6),
            connectionState: PlayerConnectionState.Connected,
            joinTick: this._state === SessionState.Playing ? this.engine.currentTick : null,
            leaveTick: null,
            isHost: false,
            role: playerRole,
            rtt: 0,
        };

        this.playerManager.set(playerId, playerInfo);

        if (this._state === SessionState.Playing && playerInfo.joinTick !== null && playerRole === PlayerRole.Player) {
            this.engine.addPlayer(playerId, playerInfo.joinTick);
        }

        this.emittedJoinEvents.add(playerId);
        this.emit('playerJoined', playerInfo);

        if (this._state === SessionState.Playing) {
            const state = this.engine.getState();
            for (const pt of state.playerTimeline) {
                const p = this.playerManager.get(pt.playerId);
                if (p) pt.name = p.name;
            }
            this.transport.send(peerId, encodeMessage(createStateSync(state.tick, state.state, this.engine.getCurrentHash(), state.playerTimeline)), true);
        }

        if (this._state === SessionState.Playing && playerInfo.joinTick !== null) {
            this.broadcast(createPlayerJoined(playerId, playerRole, playerInfo.joinTick, playerInfo.name), true);
        } else if (this._state === SessionState.Lobby) {
            this.broadcast(createPlayerJoined(playerId, playerRole, -1, playerInfo.name), true);
        }
    }

    handleJoinAccept(message) {
        if (message?.roomId) {
            this._roomId = message.roomId;
        }

        try {
            this.applyHostSessionConfig(message?.config);
        } catch (error) {
            this.setState(SessionState.Disconnected);
            this.emit(
                'error',
                error instanceof Error ? error : new Error(String(error)),
                { source: ErrorSource.Protocol, recoverable: false, details: { phase: 'joinAcceptConfig' } }
            );
            return;
        }

        if (this._state === SessionState.Connecting) {
            this.setState(SessionState.Lobby);
        }

        for (const p of message.players) {
            if (!this.playerManager.has(p.id)) {
                this.playerManager.set(p.id, {
                    id: p.id,
                    name: p.name || p.id.slice(0, 6),
                    connectionState: PlayerConnectionState.Connected,
                    joinTick: null,
                    leaveTick: null,
                    isHost: p.id === message.players[0].id,
                    role: PlayerRole.Player,
                    rtt: 0,
                });
            }
        }
    }

    handleJoinReject(message) {
        this.setState(SessionState.Disconnected);
        this.emit('error', new Error(`Join rejected: ${message.reason}`), { source: ErrorSource.Session, recoverable: false, details: { reason: message.reason } });
    }

    handlePlayerJoined(message) {
        const playerInfo = {
            id: message.playerId,
            name: message.name || message.playerId.slice(0, 6),
            connectionState: PlayerConnectionState.Connected,
            joinTick: message.joinTick >= 0 ? message.joinTick : null,
            leaveTick: null,
            isHost: false,
            role: message.role,
            rtt: 0,
        };

        this.playerManager.set(message.playerId, playerInfo);
        if (message.role === PlayerRole.Player) {
            this.engine.addPlayer(message.playerId, message.joinTick);
        }

        this.emittedJoinEvents.add(message.playerId);
        this.emit('playerJoined', playerInfo);
    }

    handlePlayerLeft(message) {
        const player = this.playerManager.get(message.playerId);
        if (player) {
            player.leaveTick = message.leaveTick;
            player.connectionState = PlayerConnectionState.Disconnected;
            if (this._state === SessionState.Playing) {
                this.engine.removePlayer(message.playerId, message.leaveTick);
            } else {
                this.playerManager.delete(message.playerId);
            }
            this.emittedJoinEvents.delete(message.playerId);
            this.emit('playerLeft', player);

            if (this._isHost && this.config.topology === Topology.Star) {
                this.broadcast(createPlayerLeft(message.playerId, message.leaveTick), true);
            }
        }
    }

    handleDisconnectReport(message) {
        if (!this._isHost) return;
        this.markPlayerDisconnected(message.disconnectedPeerId);
    }

    handleLagReport(message) {
        if (!this._isHost) return;
        this.emit('lagReport', message.laggyPlayerId, message.ticksBehind);
    }

    handleDropPlayer(message) {
        this.markPlayerDisconnected(message.playerId);
        this.emit('playerDropped', message.playerId, message.metadata);
    }

    handlePeerConnect(peerId) {
        const playerId = asPlayerId(peerId);
        const player = this.playerManager.get(playerId);
        if (player) {
            player.connectionState = PlayerConnectionState.Connected;
        }
    }

    handlePeerDisconnect(peerId) {
        const playerId = asPlayerId(peerId);
        this.markPlayerDisconnected(playerId);
    }

    markPlayerDisconnected(playerId) {
        const player = this.playerManager.get(playerId);
        if (!player) return;

        player.connectionState = PlayerConnectionState.Disconnected;

        if (this._state === SessionState.Playing) {
            player.leaveTick = this.engine.currentTick;
            if (player.role === PlayerRole.Player) {
                this.engine.removePlayer(playerId, player.leaveTick);
            }
            this.emittedJoinEvents.delete(playerId);
            this.emit('playerLeft', player);

            if (this._isHost && this.config.desyncAuthority === 0) {
                this.broadcast(createPlayerLeft(playerId, player.leaveTick), true);
            }
        } else {
            this.playerManager.delete(playerId);
            this.emittedJoinEvents.delete(playerId);
            this.emit('playerLeft', player);

            if (this._isHost) {
                this.broadcast(createPlayerLeft(playerId, -1), true);
            }
        }
    }

    checkAndReportLag() {
        if (this._isHost || this.config.lagReportThreshold === 0) return;

        const currentTick = this.engine.currentTick;

        for (const player of this.playerManager.values()) {
            if (player.id === this.localPlayerId) continue;
            if (player.role !== PlayerRole.Player) continue;
            if (player.connectionState !== PlayerConnectionState.Connected) continue;

            const confirmedTick = this.engine.getConfirmedTickForPlayer(player.id);
            if (confirmedTick === undefined) continue;

            const ticksBehind = currentTick - confirmedTick;

            if (ticksBehind >= this.config.lagReportThreshold) {
                const lastReport = this.lagReports.get(player.id) ?? 0;
                if (currentTick - lastReport >= DEFAULT_LAG_REPORT_COOLDOWN_TICKS) {
                    this.lagReports.set(player.id, currentTick);
                    this.sendToHost(createLagReport(player.id, ticksBehind));
                }
            }
        }
    }

    maybeBroadcastHash() {
        const confirmedTick = this.engine.confirmedTick;
        const hashTick = asTick(Math.floor(confirmedTick / this.config.hashInterval) * this.config.hashInterval);

        if (hashTick > 0 && hashTick !== this.lastHashBroadcastTick) {
            this.lastHashBroadcastTick = hashTick;

            const hash = this.engine.getHash(hashTick);
            if (hash === undefined) return;

            this.broadcast(createHash(this.localPlayerId, hashTick, hash), true);
        }
    }

    broadcastInput(tick, input) {
        const inputs = [{ tick, input }];

        for (let i = 1; i < this.inputRedundancy; i++) {
            const prevTick = asTick(tick - i);
            if (prevTick >= 0) {
                const prevInput = this.engine.getLocalInput(prevTick);
                if (prevInput) {
                    inputs.push({ tick: prevTick, input: prevInput });
                }
            }
        }

        this.broadcast(createInput(this.localPlayerId, inputs), false);
    }

    queueOutboundInput(tick, input) {
        this.pendingOutboundInputs.set(tick, this.cloneInput(input));
    }

    flushPendingInputs() {
        if (this.pendingOutboundInputs.size === 0) return;

        const sortedTicks = Array.from(this.pendingOutboundInputs.keys()).sort((a, b) => a - b);
        const latestTick = sortedTicks[sortedTicks.length - 1];
        const queuedTicks = new Set(sortedTicks);
        const inputs = sortedTicks.map((tick) => ({
            tick,
            input: this.pendingOutboundInputs.get(tick),
        }));

        for (let i = 1; i < this.inputRedundancy; i++) {
            const prevTick = asTick(latestTick - i);
            if (prevTick < 0 || queuedTicks.has(prevTick)) continue;

            const prevInput = this.engine.getLocalInput(prevTick);
            if (prevInput) {
                inputs.push({ tick: prevTick, input: prevInput });
            }
        }

        inputs.sort((a, b) => a.tick - b.tick);
        this.pendingOutboundInputs.clear();
        this.broadcast(createInput(this.localPlayerId, inputs), false);
    }

    sendPing(peerId) {
        const timestamp = Date.now();
        this.transport.sendPing?.(peerId, timestamp);
    }

    getRtt(peerId) {
        return this.transport.getConnectionMetrics?.(peerId)?.rtt ?? 0;
    }

    normalizeInput(input) {
        const source = input instanceof Uint8Array ? input : new Uint8Array(input ?? []);
        const normalized = new Uint8Array(this.inputSizeBytes);
        normalized.set(source.subarray(0, this.inputSizeBytes));
        return normalized;
    }

    cloneInput(input) {
        const copy = new Uint8Array(input.length);
        copy.set(input);
        return copy;
    }

    updateAdaptiveInputDelay(currentTick) {
        if (!this.config.adaptiveInputDelay) {
            this.inputDelayTicks = this.config.baseInputDelayTicks;
            return;
        }

        if (this.lastAdaptiveDelayUpdateTick >= 0 &&
            currentTick - this.lastAdaptiveDelayUpdateTick < this.config.adaptiveDelayUpdateInterval) {
            return;
        }

        this.lastAdaptiveDelayUpdateTick = currentTick;

        const currentEngineTick = this.engine.currentTick;
        let worstRttMs = 0;
        let worstJitterMs = 0;
        let worstInputLagTicks = 0;

        for (const player of this.playerManager.values()) {
            if (player.id === this.localPlayerId) continue;
            if (player.role !== PlayerRole.Player) continue;
            if (player.connectionState !== PlayerConnectionState.Connected) continue;

            const confirmedTick = this.engine.getConfirmedTickForPlayer(player.id);
            if (confirmedTick !== undefined) {
                worstInputLagTicks = Math.max(worstInputLagTicks, Math.max(0, currentEngineTick - confirmedTick - 1));
            }

            const metrics = this.transport.getConnectionMetrics?.(playerIdToPeerId(player.id));
            if (!metrics) continue;

            worstRttMs = Math.max(worstRttMs, metrics.rtt || 0);
            worstJitterMs = Math.max(worstJitterMs, metrics.jitter || 0);
        }

        const tickMs = 1000 / this.config.tickRate;
        const rttDelay = Math.ceil(((worstRttMs * 0.5) + worstJitterMs + this.config.jitterBufferMs) / tickMs);
        const cadenceDelay = Math.min(this.config.maxInputDelayTicks, worstInputLagTicks);
        const rollbackDelay = Math.min(this.config.maxInputDelayTicks, Math.ceil(this.rollbackPressure / 3));
        const targetDelay = Math.min(
            this.config.maxInputDelayTicks,
            Math.max(
                this.config.baseInputDelayTicks,
                rttDelay,
                cadenceDelay,
                rollbackDelay
            )
        );

        const previousDelay = this.inputDelayTicks;
        if (targetDelay > previousDelay) {
            this.inputDelayTicks = targetDelay;
        } else if (targetDelay < previousDelay) {
            this.inputDelayTicks = Math.max(targetDelay, previousDelay - 1);
        }

        if (this.inputDelayTicks !== previousDelay) {
            this.emit('inputDelayChanged', this.inputDelayTicks, {
                worstRttMs,
                worstJitterMs,
                worstInputLagTicks,
                rollbackPressure: this.rollbackPressure,
                targetDelay,
            });
        }
    }

    observeRollbackPressure(result) {
        // Exponential decay so transient spikes settle naturally.
        this.rollbackPressure *= 0.9;

        if (result?.rolledBack) {
            const rollbackTicks = Math.max(1, result.rollbackTicks ?? 1);
            this.rollbackPressure += Math.min(20, rollbackTicks);
        } else {
            this.rollbackPressure = Math.max(0, this.rollbackPressure - 0.05);
        }
    }

    scheduleLocalInput(currentTick, localInput) {
        this.updateAdaptiveInputDelay(currentTick);

        const normalizedInput = this.normalizeInput(localInput);
        const delayedTick = asTick(currentTick + this.inputDelayTicks);

        if (!this.engine.getLocalInput(delayedTick)) {
            this.engine.setLocalInput(delayedTick, normalizedInput);
            this.queueOutboundInput(delayedTick, normalizedInput);
        }

        let simulatedInput = this.engine.getLocalInput(currentTick);
        if (!simulatedInput) {
            simulatedInput = this.cloneInput(this.lastSimulatedLocalInput);
            this.engine.setLocalInput(currentTick, simulatedInput);
            if (currentTick !== delayedTick) {
                this.queueOutboundInput(currentTick, simulatedInput);
            }
        }

        this.lastSimulatedLocalInput = this.cloneInput(simulatedInput);
    }

    broadcast(message, reliable) {
        const encoded = encodeMessage(message);
        this.transport.broadcast(encoded, reliable);
    }

    sendToHost(message) {
        const host = Array.from(this.playerManager.values()).find(p => p.isHost);
        if (host && host.id !== this.localPlayerId) {
            this.transport.send(host.id, encodeMessage(message), isReliableMessage(message));
            return;
        }

        const peers = this.transport.connectedPeers;
        if (peers.size > 0) {
            const hostPeerId = peers.values().next().value;
            this.transport.send(hostPeerId, encodeMessage(message), isReliableMessage(message));
        }
    }

    isAuthorizedMessagePeer(peerId, message) {
        switch (message.type) {
            case MessageType.Input:
                if (this.playerIdToPeerId(message.playerId) === peerId) {
                    return true;
                }

                // In star topology, non-host peers receive relayed inputs from the host.
                if (!this._isHost && this.config.topology === Topology.Star) {
                    const hostPeerId = this.getHostPlayerId();
                    if (hostPeerId && hostPeerId === peerId) {
                        return true;
                    }
                }

                return false;
            case MessageType.Hash:
            case MessageType.SyncRequest:
            case MessageType.JoinRequest:
                return this.playerIdToPeerId(message.playerId) === peerId;
            default:
                return true;
        }
    }

    isRateLimited(peerId) {
        const now = Date.now();
        const windowStart = now - this.config.joinRateLimitWindowMs;
        let requests = this.joinRateLimiter.get(peerId) ?? [];

        requests = requests.filter(t => t > windowStart);
        this.joinRateLimiter.set(peerId, requests);

        if (requests.length >= this.config.joinRateLimitRequests) {
            return true;
        }

        requests.push(now);
        return false;
    }

    cleanupRateLimits() {
        const now = Date.now();
        const windowStart = now - this.config.joinRateLimitWindowMs;

        for (const [peerId, requests] of this.joinRateLimiter) {
            const filtered = requests.filter(t => t > windowStart);
            if (filtered.length === 0) {
                this.joinRateLimiter.delete(peerId);
            } else {
                this.joinRateLimiter.set(peerId, filtered);
            }
        }
    }
}

export function createSession(options) {
    return new Session(options);
}
