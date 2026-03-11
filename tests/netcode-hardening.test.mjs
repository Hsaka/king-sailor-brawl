import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.window = globalThis.window || {};
globalThis.AudioContext = globalThis.AudioContext || class {
    constructor() {
        this.destination = {};
        this.state = 'running';
        this.currentTime = 0;
    }

    createGain() {
        return { connect() { }, gain: { value: 1 } };
    }

    createBuffer() {
        return { getChannelData() { return new Float32Array(0); } };
    }

    createBufferSource() {
        return { connect() { }, start() { }, stop() { } };
    }

    resume() {
        return Promise.resolve();
    }
};
globalThis.webkitAudioContext = globalThis.webkitAudioContext || globalThis.AudioContext;

const { WorldState } = await import('../game/WorldState.js');
const { RollbackEngine } = await import('../netcode/engine.js');
const { Session } = await import('../netcode/session.js');
const { encodeMessage } = await import('../netcode/encoding.js');
const { createInput } = await import('../netcode/messages.js');
const { hashBytes } = await import('../netcode/hash.js');

function makeInput(flags) {
    const input = new Uint8Array(3);
    input[0] = flags & 0xFF;
    input[1] = (flags >> 8) & 0xFF;
    input[2] = (flags >> 16) & 0xFF;
    return input;
}

function createWorldStateWithPlayers(playerIds) {
    const world = new WorldState();
    for (let i = 0; i < playerIds.length; i++) {
        world.addPlayer(playerIds[i], i);
    }
    return world;
}

class StubTransport {
    constructor(localPeerId) {
        this.localPeerId = localPeerId;
        this.connectedPeers = new Set();
        this.onMessage = null;
        this.onConnect = null;
        this.onDisconnect = null;
        this.onKeepalivePing = null;
    }

    send() { }
    broadcast() { }
    disconnectAll() { }
}

class DeterministicRollbackGame {
    constructor(playerIds) {
        this.playerIds = [...playerIds].sort();
        this.state = new Map(this.playerIds.map((id) => [id, { position: 0, charge: 0, lastFlags: 0 }]));
    }

    step(inputs) {
        for (const playerId of this.playerIds) {
            const input = inputs.get(playerId) ?? makeInput(0);
            const flags = input[0] | (input[1] << 8) | ((input[2] || 0) << 16);
            const player = this.state.get(playerId);

            if (flags & 0x01) player.position -= 2;
            if (flags & 0x02) player.position += 3;
            if ((flags & 0x04) && !(player.lastFlags & 0x04)) {
                player.charge += 5;
            }
            if (flags & 0x08) {
                player.charge = Math.max(0, player.charge - 1);
            }

            player.lastFlags = flags;
        }
    }

    serialize() {
        const buffer = new ArrayBuffer(this.playerIds.length * 12);
        const view = new DataView(buffer);
        let offset = 0;

        for (const playerId of this.playerIds) {
            const player = this.state.get(playerId);
            view.setInt32(offset, player.position, true); offset += 4;
            view.setInt32(offset, player.charge, true); offset += 4;
            view.setUint32(offset, player.lastFlags, true); offset += 4;
        }

        return new Uint8Array(buffer);
    }

    deserialize(bytes) {
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        let offset = 0;

        for (const playerId of this.playerIds) {
            this.state.set(playerId, {
                position: view.getInt32(offset, true),
                charge: view.getInt32(offset + 4, true),
                lastFlags: view.getUint32(offset + 8, true),
            });
            offset += 12;
        }
    }

    hashSerialized(bytes) {
        return hashBytes(bytes);
    }
}

test('WorldState hash tracks serialized gameplay fields', () => {
    const world = createWorldStateWithPlayers(['p1', 'p2']);
    const baselineHash = world.hash();

    world.players.get('p1').heading += 17;
    const headingHash = world.hash();

    world.players.get('p1').cooldowns[0] = 1.25;
    const cooldownHash = world.hash();

    assert.notEqual(headingHash, baselineHash);
    assert.notEqual(cooldownHash, headingHash);
});

test('WorldState hash normalizes benign float representation differences', () => {
    const world = createWorldStateWithPlayers(['p1']);
    const baselineState = world.serialize();
    const baselineHash = world.hashSerialized(baselineState);
    const nearEquivalentState = new Uint8Array(baselineState);
    const nearEquivalentView = new DataView(nearEquivalentState.buffer);

    const playerIdLength = baselineState[12];
    const playerOffset = 12 + 1 + playerIdLength;
    const xOffset = playerOffset + 4 + 12;
    const headingOffset = xOffset + 8;
    const knockbackXOffset = headingOffset + 8;
    const cooldownOffset = knockbackXOffset + 4 + 4 + 1 + 1 + 1 + 4 + 4;

    nearEquivalentView.setFloat32(xOffset, nearEquivalentView.getFloat32(xOffset, true) + 0.004, true);
    nearEquivalentView.setFloat32(headingOffset, nearEquivalentView.getFloat32(headingOffset, true) - 0.004, true);
    nearEquivalentView.setFloat32(knockbackXOffset, -0, true);
    nearEquivalentView.setFloat32(cooldownOffset, 0.004, true);

    assert.equal(world.hashSerialized(nearEquivalentState), baselineHash);

    nearEquivalentView.setFloat32(xOffset, nearEquivalentView.getFloat32(xOffset, true) + 0.02, true);
    assert.notEqual(world.hashSerialized(nearEquivalentState), baselineHash);
});

test('RollbackEngine converges after delayed remote inputs', () => {
    const worldA = new DeterministicRollbackGame(['p1', 'p2']);
    const worldB = new DeterministicRollbackGame(['p1', 'p2']);

    const engineA = new RollbackEngine({
        game: worldA,
        localPlayerId: 'p1',
        inputSizeBytes: 3,
        snapshotHistorySize: 180,
        maxSpeculationTicks: 120,
    });
    engineA.addPlayer('p2', 0);

    const engineB = new RollbackEngine({
        game: worldB,
        localPlayerId: 'p2',
        inputSizeBytes: 3,
        snapshotHistorySize: 180,
        maxSpeculationTicks: 120,
    });
    engineB.addPlayer('p1', 0);

    const activeTicks = 48;
    const maxDelay = 4;
    const settleTicks = maxDelay + 6;
    const totalTicks = activeTicks + settleTicks;
    const queuedForA = new Map();
    const queuedForB = new Map();
    let sawRollback = false;

    const inputsP1 = Array.from({ length: totalTicks }, (_, tick) => {
        if (tick >= activeTicks) return makeInput(0);
        let flags = 0;
        if (tick % 6 < 3) flags |= 0x02;
        if (tick % 10 === 0) flags |= 0x04;
        if (tick % 8 === 4) flags |= 0x08;
        if (tick % 5 === 0) flags |= 0x10;
        return makeInput(flags);
    });

    const inputsP2 = Array.from({ length: totalTicks }, (_, tick) => {
        if (tick >= activeTicks) return makeInput(0);
        let flags = 0;
        if (tick % 7 < 2) flags |= 0x01;
        if (tick % 9 === 0) flags |= 0x04;
        if (tick % 11 === 6) flags |= 0x08;
        if (tick % 4 === 0) flags |= 0x20;
        return makeInput(flags);
    });

    for (let loopTick = 0; loopTick < totalTicks + maxDelay + 1; loopTick++) {
        if (loopTick < totalTicks) {
            const delayToA = (loopTick * 7) % (maxDelay + 1);
            const delayToB = (loopTick * 11) % (maxDelay + 1);

            const deliveryTickForA = loopTick + delayToA;
            const deliveryTickForB = loopTick + delayToB;

            if (!queuedForA.has(deliveryTickForA)) queuedForA.set(deliveryTickForA, []);
            if (!queuedForB.has(deliveryTickForB)) queuedForB.set(deliveryTickForB, []);

            queuedForA.get(deliveryTickForA).push({ playerId: 'p2', tick: loopTick, input: inputsP2[loopTick] });
            queuedForB.get(deliveryTickForB).push({ playerId: 'p1', tick: loopTick, input: inputsP1[loopTick] });
        }

        for (const entry of queuedForA.get(loopTick) ?? []) {
            engineA.receiveRemoteInput(entry.playerId, entry.tick, entry.input);
        }
        for (const entry of queuedForB.get(loopTick) ?? []) {
            engineB.receiveRemoteInput(entry.playerId, entry.tick, entry.input);
        }

        const tickA = engineA.currentTick;
        const tickB = engineB.currentTick;

        if (tickA < totalTicks) {
            engineA.setLocalInput(tickA, inputsP1[tickA]);
        }
        if (tickB < totalTicks) {
            engineB.setLocalInput(tickB, inputsP2[tickB]);
        }

        const resultA = engineA.tick();
        const resultB = engineB.tick();

        assert.equal(resultA.error, undefined);
        assert.equal(resultB.error, undefined);
        sawRollback ||= Boolean(resultA.rolledBack || resultB.rolledBack);
    }

    const finalStateA = worldA.serialize();
    const finalStateB = worldB.serialize();

    assert.equal(Buffer.compare(Buffer.from(finalStateA), Buffer.from(finalStateB)), 0);
    assert.equal(engineA.getCurrentHash(), engineB.getCurrentHash());
    assert.equal(sawRollback, true);
});

test('Session rejects spoofed input messages but accepts trusted ones', async () => {
    const game = {
        state: 0,
        step() { },
        serialize() { return new Uint8Array([this.state]); },
        deserialize(bytes) { this.state = bytes[0] ?? 0; },
        hashSerialized(bytes) { return bytes[0] ?? 0; },
    };

    const session = new Session({
        game,
        transport: new StubTransport('host'),
        config: {
            inputSizeBytes: 3,
            snapshotHistorySize: 32,
            maxSpeculationTicks: 16,
        },
    });

    await session.createRoom();
    session.engine.addPlayer('victim', 0);

    const errors = [];
    session.on('error', (error) => {
        errors.push(error);
    });

    const spoofed = encodeMessage(createInput('victim', [{ tick: 0, input: makeInput(0x10) }]));
    session.handleMessage('attacker', spoofed);

    assert.equal(session.engine.getConfirmedTickForPlayer('victim'), -1);
    assert.equal(errors.length, 1);

    const trusted = encodeMessage(createInput('victim', [{ tick: 0, input: makeInput(0x10) }]));
    session.handleMessage('victim', trusted);

    assert.equal(session.engine.getConfirmedTickForPlayer('victim'), 0);
    session.destroy();
});

test('Session resolves host player id independently of room id', async () => {
    const game = {
        step() { },
        serialize() { return new Uint8Array([0]); },
        deserialize() { },
        hashSerialized(bytes) { return bytes[0] ?? 0; },
    };

    const session = new Session({
        game,
        transport: new StubTransport('client'),
        config: {
            inputSizeBytes: 3,
            snapshotHistorySize: 32,
            maxSpeculationTicks: 16,
        },
    });

    session.playerManager.set('host-peer', {
        id: 'host-peer',
        name: 'Host',
        connectionState: 1,
        joinTick: null,
        leaveTick: null,
        isHost: true,
        role: 0,
        rtt: 0,
    });
    session._roomId = 'public-room-code';

    assert.equal(session.getHostPlayerId(), 'host-peer');
    assert.equal(session.roomId, 'public-room-code');

    session.destroy();
});

test('Session authorizes messages through configurable player-to-peer mapping', async () => {
    const game = {
        step() { },
        serialize() { return new Uint8Array([0]); },
        deserialize() { },
        hashSerialized(bytes) { return bytes[0] ?? 0; },
    };

    const session = new Session({
        game,
        transport: new StubTransport('peer-local'),
        localPlayerId: 'player-local',
        playerIdToPeerId(playerId) {
            if (playerId === 'remote-player') return 'remote-peer';
            if (playerId === 'player-local') return 'peer-local';
            return playerId;
        },
        config: {
            inputSizeBytes: 3,
            snapshotHistorySize: 32,
            maxSpeculationTicks: 16,
        },
    });

    await session.createRoom();
    session.engine.addPlayer('remote-player', 0);

    const trusted = encodeMessage(createInput('remote-player', [{ tick: 0, input: makeInput(0x10) }]));
    session.handleMessage('remote-peer', trusted);

    assert.equal(session.engine.getConfirmedTickForPlayer('remote-player'), 0);
    session.destroy();
});

test('Session surfaces transport errors through session error events', async () => {
    const transport = new StubTransport('host');
    const session = new Session({
        game: {
            step() { },
            serialize() { return new Uint8Array([0]); },
            deserialize() { },
            hashSerialized(bytes) { return bytes[0] ?? 0; },
        },
        transport,
        config: {
            inputSizeBytes: 3,
            snapshotHistorySize: 32,
            maxSpeculationTicks: 16,
        },
    });

    const seen = [];
    session.on('error', (error, metadata) => {
        seen.push({ error, metadata });
    });

    transport.onError?.('peer-1', new Error('transport broke'), 'configSync');

    assert.equal(seen.length, 1);
    assert.equal(seen[0].metadata.source, 1);
    assert.equal(seen[0].metadata.details.peerId, 'peer-1');
    assert.equal(seen[0].metadata.details.phase, 'configSync');

    session.destroy();
});

test('Session accepts host-relayed input messages in star topology', async () => {
    const game = {
        step() { },
        serialize() { return new Uint8Array([0]); },
        deserialize() { },
        hashSerialized(bytes) { return bytes[0] ?? 0; },
    };

    const session = new Session({
        game,
        transport: new StubTransport('client-peer'),
        config: {
            topology: 1,
            inputSizeBytes: 3,
            snapshotHistorySize: 32,
            maxSpeculationTicks: 16,
        },
    });

    session.playerManager.set('host-peer', {
        id: 'host-peer',
        name: 'Host',
        connectionState: 1,
        joinTick: null,
        leaveTick: null,
        isHost: true,
        role: 0,
        rtt: 0,
    });
    session.playerManager.set('remote-peer', {
        id: 'remote-peer',
        name: 'Remote',
        connectionState: 1,
        joinTick: null,
        leaveTick: null,
        isHost: false,
        role: 0,
        rtt: 0,
    });
    session.engine.addPlayer('host-peer', 0);
    session.engine.addPlayer('remote-peer', 0);

    const relayed = encodeMessage(createInput('remote-peer', [{ tick: 0, input: makeInput(0x10) }]));
    session.handleMessage('host-peer', relayed);

    assert.equal(session.engine.getConfirmedTickForPlayer('remote-peer'), 0);
    session.destroy();
});

test('Session raises adaptive input delay immediately when a remote peer falls behind', async () => {
    const session = new Session({
        game: {
            step() { },
            serialize() { return new Uint8Array([0]); },
            deserialize() { },
            hashSerialized(bytes) { return bytes[0] ?? 0; },
        },
        transport: new StubTransport('local-peer'),
        config: {
            inputSizeBytes: 3,
            snapshotHistorySize: 32,
            maxSpeculationTicks: 16,
            adaptiveInputDelay: true,
            adaptiveDelayUpdateInterval: 30,
            baseInputDelayTicks: 2,
            maxInputDelayTicks: 12,
            tickRate: 60,
            jitterBufferMs: 8,
        },
    });

    try {
        await session.createRoom();
        session.playerManager.set('remote-peer', {
            id: 'remote-peer',
            name: 'Remote',
            connectionState: 1,
            joinTick: null,
            leaveTick: null,
            isHost: false,
            role: 0,
            rtt: 0,
        });
        session.engine.addPlayer('remote-peer', 0);

        session.inputDelayTicks = 2;
        session.lastAdaptiveDelayUpdateTick = 39;
        session.engine._currentTick = 40;
        session.engine.inputBuffer.players.get('remote-peer').confirmedTick = 34;

        session.updateAdaptiveInputDelay(40);

        assert.equal(session.inputDelayTicks, 7);
    } finally {
        session.destroy();
    }
});
