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
import { encodeMessage, decodeMessage, DEFAULT_PROTOCOL_LIMITS } from './encoding.js';
import { MessageType, isReliableMessage, createInput, createHash, createSync, createSyncRequest, createJoinRequest, createJoinAccept, createJoinReject, createStateSync, createPlayerJoined, createPlayerLeft, createPause, createResume, createPing, createPong, createLagReport, createDisconnectReport, createResumeCountdown, createDropPlayer } from './messages.js';
import { RollbackEngine } from './engine.js';

const RATE_LIMIT_CLEANUP_INTERVAL_MS = 60000;
const DEFAULT_LAG_REPORT_COOLDOWN_TICKS = 30;
const RTT_SAMPLE_COUNT = 5;

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

        this.playerManager = new Map();
        this.emittedJoinEvents = new Set();
        this.pendingHashMessages = [];
        this.peerRttData = new Map();
        this.eventHandlers = new Map();
        this.joinRateLimiter = new Map();
        this.lagReports = new Map();
        this.lastHashBroadcastTick = asTick(-1);
        this.inputRedundancy = this.config.inputRedundancy;


        this.engine = new RollbackEngine({
            game: this.game,
            localPlayerId: this._localPlayerId,
            snapshotHistorySize: this.config.snapshotHistorySize,
            maxSpeculationTicks: this.config.maxSpeculationTicks,
            inputPredictor: options.inputPredictor,
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

    get currentTick() {
        return this.engine.currentTick;
    }

    get confirmedTick() {
        return this.engine.confirmedTick;
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

            this.engine.setLocalInput(currentTick, localInput);
            this.broadcastInput(currentTick, localInput);
        }

        const result = this.engine.tick();

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
        this.sendToHost(createSyncRequest(this.localPlayerId, this.engine.currentTick, this.engine.getCurrentHash()));
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
        this.transport.send(peerId, encodeMessage(createJoinAccept(playerId, this._roomId, { tickRate: this.config.tickRate, maxPlayers: this.config.maxPlayers }, playerIds)), true);

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
        this.peerRttData.delete(peerId);
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

    sendPing(peerId) {
        const timestamp = Date.now();
        this.transport.sendPing?.(peerId, timestamp);

        let data = this.peerRttData.get(peerId);
        if (!data) {
            data = { pendingPings: new Map(), rtt: 0, samples: [] };
            this.peerRttData.set(peerId, data);
        }
        data.pendingPings.set(timestamp, timestamp);
    }

    getRtt(peerId) {
        return this.peerRttData.get(peerId)?.rtt ?? 0;
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
