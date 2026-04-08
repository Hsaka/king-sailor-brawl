export const TICK_MIN = -1;
export const MAX_PLAYERS_LIMIT = 65535;

export const Topology = { Mesh: 0, Star: 1 };
export const DesyncAuthority = { Host: 0, Peer: 1 };
export const SessionState = { Disconnected: 0, Connecting: 1, Lobby: 2, Playing: 3, Paused: 4 };
export const PlayerRole = { Player: 0, Spectator: 1 };
export const PlayerConnectionState = { Connecting: 0, Connected: 1, Disconnected: 2 };
export const ErrorSource = { Engine: 0, Transport: 1, Protocol: 2, Session: 3 };
export const PauseReason = { PlayerRequest: 0, PlayerDisconnect: 1, ExcessiveLag: 2 };

export const DEFAULT_SESSION_CONFIG = {
    tickRate: 60,
    maxPlayers: MAX_PLAYERS_LIMIT,
    topology: Topology.Star,
    snapshotHistorySize: 120,
    maxSpeculationTicks: 60,
    hashInterval: 60,
    disconnectTimeout: 5000,
    debug: false,
    desyncAuthority: DesyncAuthority.Peer,
    lagReportThreshold: 30,
    inputRedundancy: 3,
    inputSizeBytes: 3,
    baseInputDelayTicks: 2,
    maxInputDelayTicks: 12,
    adaptiveInputDelay: true,
    adaptiveDelayUpdateInterval: 30,
    jitterBufferMs: 8,
    joinRateLimitRequests: 3,
    joinRateLimitWindowMs: 10000,
    startupInputHistoryTicks: 64,
};

export function asTick(n) {
    return n;
}

export function asPlayerId(s) {
    return s;
}

export function validateTick(n) {
    if (!Number.isInteger(n) || n < TICK_MIN) {
        throw new ValidationError(`Tick must be an integer >= ${TICK_MIN}`, 'tick', n);
    }
}

export function validatePlayerId(s) {
    if (typeof s !== 'string' || s.length === 0) {
        throw new ValidationError('Player ID must be a non-empty string', 'playerId', s);
    }
}

export function playerIdToPeerId(playerId) {
    return playerId;
}

export function validateSessionConfig(config) {
    if (config.tickRate <= 0) {
        throw new ValidationError('tickRate must be greater than 0', 'tickRate', config.tickRate);
    }
    if (config.maxPlayers < 1 || config.maxPlayers > MAX_PLAYERS_LIMIT) {
        throw new ValidationError(`maxPlayers must be between 1 and ${MAX_PLAYERS_LIMIT}`, 'maxPlayers', config.maxPlayers);
    }
    if (config.maxSpeculationTicks <= 0) {
        throw new ValidationError('maxSpeculationTicks must be greater than 0', 'maxSpeculationTicks', config.maxSpeculationTicks);
    }
    if (config.snapshotHistorySize < config.maxSpeculationTicks) {
        throw new ValidationError('snapshotHistorySize must be >= maxSpeculationTicks', 'snapshotHistorySize', config.snapshotHistorySize);
    }
    if (config.hashInterval <= 0) {
        throw new ValidationError('hashInterval must be greater than 0', 'hashInterval', config.hashInterval);
    }
    if (config.disconnectTimeout <= 0) {
        throw new ValidationError('disconnectTimeout must be greater than 0', 'disconnectTimeout', config.disconnectTimeout);
    }
    if (!Number.isInteger(config.inputSizeBytes) || config.inputSizeBytes <= 0) {
        throw new ValidationError('inputSizeBytes must be a positive integer', 'inputSizeBytes', config.inputSizeBytes);
    }
    if (!Number.isInteger(config.baseInputDelayTicks) || config.baseInputDelayTicks < 0) {
        throw new ValidationError('baseInputDelayTicks must be an integer >= 0', 'baseInputDelayTicks', config.baseInputDelayTicks);
    }
    if (!Number.isInteger(config.maxInputDelayTicks) || config.maxInputDelayTicks < config.baseInputDelayTicks) {
        throw new ValidationError('maxInputDelayTicks must be >= baseInputDelayTicks', 'maxInputDelayTicks', config.maxInputDelayTicks);
    }
    if (!Number.isInteger(config.adaptiveDelayUpdateInterval) || config.adaptiveDelayUpdateInterval <= 0) {
        throw new ValidationError('adaptiveDelayUpdateInterval must be a positive integer', 'adaptiveDelayUpdateInterval', config.adaptiveDelayUpdateInterval);
    }
    if (typeof config.adaptiveInputDelay !== 'boolean') {
        throw new ValidationError('adaptiveInputDelay must be a boolean', 'adaptiveInputDelay', config.adaptiveInputDelay);
    }
    if (!Number.isFinite(config.jitterBufferMs) || config.jitterBufferMs < 0) {
        throw new ValidationError('jitterBufferMs must be >= 0', 'jitterBufferMs', config.jitterBufferMs);
    }
    if (!Number.isInteger(config.startupInputHistoryTicks) || config.startupInputHistoryTicks < 1) {
        throw new ValidationError('startupInputHistoryTicks must be a positive integer', 'startupInputHistoryTicks', config.startupInputHistoryTicks);
    }
}

export const DEFAULT_INPUT_PREDICTOR = {
    predict(_playerId, _tick, lastConfirmed) {
        return lastConfirmed ?? new Uint8Array(0);
    },
};

export class RollbackError extends Error {
    constructor(message, tick, originalError) {
        super(message, { cause: originalError });
        this.name = 'RollbackError';
        this.tick = tick;
    }
}

export class ValidationError extends Error {
    constructor(message, field, value) {
        super(message);
        this.name = 'ValidationError';
        this.field = field;
        this.value = value;
    }
}

export class GameError extends Error {
    constructor(operation, tick, cause) {
        super(`Game ${operation}() failed at tick ${tick}: ${cause.message}`, { cause });
        this.name = 'GameError';
        this.operation = operation;
        this.tick = tick;
    }
}
