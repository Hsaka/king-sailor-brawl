import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.window = globalThis.window || {};

const [
    { WorldState },
    { ShipDefinitions },
    { RollbackEngine },
    { Session },
    { decodeMessage },
    { MessageType },
] = await Promise.all([
    import('../game/WorldState.js'),
    import('../game/ShipDefinitions.js'),
    import('../netcode/engine.js'),
    import('../netcode/session.js'),
    import('../netcode/encoding.js'),
    import('../netcode/messages.js'),
]);

function packInput(flags) {
    return new Uint8Array([
        flags & 0xFF,
        (flags >> 8) & 0xFF,
        (flags >> 16) & 0xFF,
    ]);
}

function assertStateBytesEqual(actual, expected, message) {
    assert.equal(Buffer.from(actual).compare(Buffer.from(expected)), 0, message);
}

function setPlayerState(world, playerId, overrides) {
    const player = world.players.get(playerId);
    assert.ok(player, `missing player ${playerId}`);

    Object.assign(player, {
        x: 0,
        y: 0,
        heading: 0,
        speedTier: ShipDefinitions.get(player.shipId).defaultSpeedTier,
        health: ShipDefinitions.get(player.shipId).maxHealth,
        alive: true,
        isBot: false,
        invincibilityTimer: 0,
        slowTimer: 0,
        cooldowns: [0, 0, 0, 0, 0],
        knockbackX: 0,
        knockbackY: 0,
        ...overrides,
    });
}

function createDangerBorderConfig(overrides = {}) {
    return {
        ENABLED: true,
        START_DELAY_SECONDS: 0,
        SHRINK_UNITS_PER_SECOND: 60,
        MIN_INSET: 260,
        DAMAGE_PER_SECOND: 15,
        ...overrides,
    };
}

function createCombatWorld(options = {}) {
    const world = new WorldState(options);
    world.seed = 424242;
    world.setLocalPlayerId('p1');
    world.addPlayer('p1', 0);
    world.addPlayer('p2', 1);
    world.setPlayerShip('p1', 'cobro');
    world.setPlayerShip('p2', 'cobro');

    setPlayerState(world, 'p1', {
        x: 500,
        y: 500,
        heading: 0,
        speedTier: 1,
    });
    setPlayerState(world, 'p2', {
        x: 580,
        y: 500,
        heading: 0,
        speedTier: 1,
    });

    world.lastInput.set('p1', 0);
    world.lastInput.set('p2', 0);
    return world;
}

function createRollbackWorld(options = {}) {
    const world = new WorldState(options);
    world.seed = 98765;
    world.setLocalPlayerId('p1');
    world.addPlayer('p1', 0);
    world.addPlayer('p2', 1);
    world.setPlayerShip('p1', 'cobro');
    world.setPlayerShip('p2', 'cobro');

    setPlayerState(world, 'p1', {
        x: 300,
        y: 300,
        heading: 0,
        speedTier: 1,
    });
    setPlayerState(world, 'p2', {
        x: 1000,
        y: 1000,
        heading: 180,
        speedTier: 1,
    });

    world.lastInput.set('p1', 0);
    world.lastInput.set('p2', 0);
    return world;
}

function createEngine(world) {
    const engine = new RollbackEngine({
        game: world,
        localPlayerId: 'p1',
        snapshotHistorySize: 120,
        maxSpeculationTicks: 60,
        inputSizeBytes: 3,
    });
    engine.addPlayer('p2', 0);
    return engine;
}

class FakeTransport {
    constructor(localPeerId = 'p1') {
        this.localPeerId = localPeerId;
        this._connectedPeers = new Set(['p2']);
        this.sent = [];
        this.broadcasts = [];
        this.onMessage = null;
        this.onConnect = null;
        this.onDisconnect = null;
        this.onError = null;
        this.onKeepalivePing = null;
    }

    get connectedPeers() {
        return this._connectedPeers;
    }

    send(peerId, message, reliable) {
        this.sent.push({ peerId, message: new Uint8Array(message), reliable });
        return true;
    }

    broadcast(message, reliable) {
        this.broadcasts.push({ message: new Uint8Array(message), reliable });
        for (const peerId of this._connectedPeers) {
            this.sent.push({ peerId, message: new Uint8Array(message), reliable, via: 'broadcast' });
        }
    }

    disconnectAll() {
        this._connectedPeers.clear();
    }

    getConnectionMetrics() {
        return { rtt: 0, jitter: 0, packetLoss: 0, lastUpdated: Date.now() };
    }

    recordPeerResponse() { }
}

function createHashSession() {
    const world = createRollbackWorld();
    const transport = new FakeTransport('p1');
    const session = new Session({
        game: world,
        transport,
        localPlayerId: 'p1',
        config: {
            hashInterval: 60,
            adaptiveInputDelay: false,
        },
    });
    session.playerManager.set('p2', {
        id: 'p2',
        name: 'p2',
        connectionState: 1,
        joinTick: 0,
        leaveTick: null,
        isHost: false,
        role: 0,
        rtt: 0,
    });
    return { session, transport, world };
}

function seedSessionSnapshot(session, world, tick) {
    const state = world.serialize();
    session.engine.setState(tick, state, [
        { playerId: 'p1', joinTick: 0, leaveTick: null },
        { playerId: 'p2', joinTick: 0, leaveTick: null },
    ]);
}

test('rollback engine reports max-speculation stalls explicitly', () => {
    const engine = new RollbackEngine({
        game: createRollbackWorld(),
        localPlayerId: 'p1',
        snapshotHistorySize: 32,
        maxSpeculationTicks: 4,
        inputSizeBytes: 3,
    });
    engine.addPlayer('p2', 0);

    for (let tick = 0; tick < 3; tick++) {
        engine.setLocalInput(tick, packInput(0x10));
        const result = engine.tick();
        assert.equal(result.stalledReason, undefined, `tick ${tick} should still advance`);
    }

    const tickBefore = engine.currentTick;
    engine.setLocalInput(tickBefore, packInput(0x10));
    const stalled = engine.tick();

    assert.equal(stalled.stalledReason, 'max_speculation');
    assert.equal(stalled.tick, tickBefore);
    assert.equal(stalled.speculationTicks, 4);
    assert.equal(stalled.maxSpeculationTicks, 4);
    assert.equal(stalled.minConfirmedTick, -1);
    assert.equal(engine.currentTick, tickBefore, 'engine should not advance when max speculation is hit');
});

test('session defers hash broadcast until the local snapshot exists', (t) => {
    const { session, transport, world } = createHashSession();
    t.after(() => session.destroy());
    seedSessionSnapshot(session, world, 58);

    session.engine._confirmedTick = 61;
    session.maybeBroadcastHash();

    assert.equal(transport.broadcasts.length, 0, 'hash should not broadcast before the local snapshot exists');
    assert.equal(session.lastHashBroadcastTick, -1, 'broadcast watermark should not advance on a deferred hash');

    const hashState = world.serialize();
    const hash = world.hash(hashState);
    session.engine.snapshotBuffer.save(60, hashState, hash);
    session.engine._currentTick = 61;
    session.engine._confirmedTick = 62;

    session.maybeBroadcastHash();

    assert.equal(transport.broadcasts.length, 1, 'hash should broadcast once the local snapshot becomes available');
    assert.equal(session.lastHashBroadcastTick, 60);

    const message = decodeMessage(transport.broadcasts[0].message);
    assert.equal(message.type, MessageType.Hash);
    assert.equal(message.tick, 60);
    assert.equal(message.hash, hash);
});

test('session keeps pending hash comparisons queued until the local hash exists', (t) => {
    const { session, world } = createHashSession();
    t.after(() => session.destroy());
    seedSessionSnapshot(session, world, 58);

    const phases = [];
    session.on('hashEvent', (meta) => phases.push(meta.phase));

    const hashState = world.serialize();
    const hash = world.hash(hashState);
    session.pendingHashMessages = [{ tick: 60, playerId: 'p2', hash }];
    session.engine._confirmedTick = 61;

    session.processPendingHashComparisons();

    assert.deepEqual(session.pendingHashMessages, [{ tick: 60, playerId: 'p2', hash }], 'future hash should remain queued');
    assert.ok(phases.includes('awaiting_local_hash'));

    session.engine.snapshotBuffer.save(60, hashState, hash);
    session.engine._currentTick = 61;
    session.engine._confirmedTick = 62;
    session.processPendingHashComparisons();

    assert.equal(session.pendingHashMessages.length, 0, 'hash should clear once the local snapshot is available');
    assert.ok(phases.includes('match'));
});

test('world state hash covers the full serialized state and round-trips cleanly', () => {
    const world = createCombatWorld();

    const baselineBytes = world.serialize();
    const baselineHash = world.hash(baselineBytes);

    const headingChanged = createCombatWorld();
    headingChanged.players.get('p1').heading += 37;
    assert.notEqual(headingChanged.hash(headingChanged.serialize()), baselineHash, 'heading changes must affect hash');

    const cooldownChanged = createCombatWorld();
    cooldownChanged.players.get('p2').cooldowns[1] = 1.25;
    assert.notEqual(cooldownChanged.hash(cooldownChanged.serialize()), baselineHash, 'cooldown changes must affect hash');

    const debrisChanged = createCombatWorld();
    debrisChanged.spawnDebris(640, 640, ShipDefinitions.get('cobro').debris);
    const debrisHash = debrisChanged.hash(debrisChanged.serialize());
    assert.notEqual(debrisHash, baselineHash, 'debris changes must affect hash');

    const borderChanged = createCombatWorld();
    borderChanged.dangerBorder.elapsedTicks = 75;
    borderChanged.dangerBorder.currentInset = 195;
    assert.notEqual(borderChanged.hash(borderChanged.serialize()), baselineHash, 'danger border changes must affect hash');

    const roundTrip = new WorldState();
    roundTrip.deserialize(baselineBytes);
    const roundTripBytes = roundTrip.serialize();
    assertStateBytesEqual(roundTripBytes, baselineBytes, 'serialize/deserialize round-trip should be byte-stable');
    assert.equal(roundTrip.hash(roundTripBytes), baselineHash, 'round-tripped state should hash identically');
});

test('two peers remain byte-identical under the same scripted simulation', () => {
    const borderConfig = createDangerBorderConfig({
        MIN_INSET: 320,
        DAMAGE_PER_SECOND: 22,
    });
    const worldA = createCombatWorld({ dangerBorderConfig: borderConfig });
    const worldB = createCombatWorld({ dangerBorderConfig: borderConfig });

    setPlayerState(worldA, 'p1', { x: 250, y: 250, heading: 0, speedTier: 1 });
    setPlayerState(worldA, 'p2', { x: 2150, y: 2150, heading: 180, speedTier: 1 });
    setPlayerState(worldB, 'p1', { x: 250, y: 250, heading: 0, speedTier: 1 });
    setPlayerState(worldB, 'p2', { x: 2150, y: 2150, heading: 180, speedTier: 1 });

    worldA.spawnDebris(640, 640, ShipDefinitions.get('cobro').debris);
    worldB.spawnDebris(640, 640, ShipDefinitions.get('cobro').debris);

    for (let tick = 0; tick < 150; tick++) {
        const p1Flags = 0x10;
        const p2Flags = tick % 45 === 0 ? 0x20 : 0;
        const inputs = new Map([
            ['p1', packInput(p1Flags)],
            ['p2', packInput(p2Flags)],
        ]);

        worldA.step(inputs);
        worldB.step(inputs);

        const bytesA = worldA.serialize();
        const bytesB = worldB.serialize();
        assertStateBytesEqual(bytesA, bytesB, `peer states diverged at tick ${tick}`);
        assert.equal(worldA.hash(bytesA), worldB.hash(bytesB), `peer hashes diverged at tick ${tick}`);
    }
});

test('rollback engine converges back to the authoritative state after delayed remote inputs', () => {
    const borderConfig = createDangerBorderConfig({
        MIN_INSET: 360,
        DAMAGE_PER_SECOND: 20,
    });
    const authoritative = createEngine(createRollbackWorld({ dangerBorderConfig: borderConfig }));
    const predicted = createEngine(createRollbackWorld({ dangerBorderConfig: borderConfig }));
    const remoteInputs = [];
    const delayTicks = 4;
    const totalTicks = 64;
    let sawRollback = false;

    for (let tick = 0; tick < totalTicks; tick++) {
        const localFlags = tick % 8 < 4 ? 0x10 : 0x00;
        const remoteFlags = ((tick % 6) < 3 ? 0x01 : 0x02) | (tick % 10 === 0 ? 0x20 : 0x00);
        const localInput = packInput(localFlags);
        const remoteInput = packInput(remoteFlags);
        remoteInputs.push(remoteInput);

        authoritative.setLocalInput(tick, localInput);
        authoritative.receiveRemoteInput('p2', tick, remoteInput);
        authoritative.tick();

        predicted.setLocalInput(tick, localInput);
        if (tick >= delayTicks) {
            predicted.receiveRemoteInput('p2', tick - delayTicks, remoteInputs[tick - delayTicks]);
        }

        const result = predicted.tick();
        sawRollback ||= !!result?.rolledBack;
    }

    for (let tick = totalTicks - delayTicks; tick < totalTicks; tick++) {
        predicted.receiveRemoteInput('p2', tick, remoteInputs[tick]);
    }

    for (let i = 0; i < delayTicks; i++) {
        authoritative.setLocalInput(totalTicks + i, packInput(0));
        authoritative.receiveRemoteInput('p2', totalTicks + i, packInput(0));
        authoritative.tick();

        predicted.setLocalInput(totalTicks + i, packInput(0));
        predicted.receiveRemoteInput('p2', totalTicks + i, packInput(0));
        const result = predicted.tick();
        sawRollback ||= !!result?.rolledBack;
    }

    assert.ok(sawRollback, 'delayed inputs should have forced at least one rollback');
    assert.equal(predicted.currentTick, authoritative.currentTick, 'engines should end on the same tick');

    const authoritativeState = authoritative.getState().state;
    const predictedState = predicted.getState().state;
    assertStateBytesEqual(predictedState, authoritativeState, 'predicted engine should converge to the authoritative state');
    assert.equal(predicted.getCurrentHash(), authoritative.getCurrentHash(), 'authoritative and predicted hashes should match after convergence');
});

test('danger border uses config-authored delay, shrink rate, and minimum inset deterministically', () => {
    const world = createCombatWorld({
        dangerBorderConfig: createDangerBorderConfig({
            START_DELAY_SECONDS: 1,
            SHRINK_UNITS_PER_SECOND: 60,
            MIN_INSET: 125,
        }),
    });

    assert.equal(world.dangerBorder.startDelayTicks, 60, 'seconds should convert to deterministic delay ticks once');
    assert.equal(world.dangerBorder.shrinkUnitsPerTick, 1, 'units per second should convert to units per tick once');
    assert.equal(world.dangerBorder.currentInset, 120, 'border should start at the arena death-zone inset');

    for (let tick = 0; tick < 60; tick++) {
        world.step(new Map());
    }

    assert.equal(world.dangerBorder.currentInset, 120, 'border should not shrink before the configured delay elapses');
    assert.equal(world.dangerBorder.elapsedTicks, 60);

    world.step(new Map());
    assert.equal(world.dangerBorder.currentInset, 121, 'border should advance exactly one unit on the first shrink tick');

    for (let i = 0; i < 8; i++) {
        world.step(new Map());
    }

    assert.equal(world.dangerBorder.currentInset, 125, 'border should stop at the configured minimum inset');
    assert.equal(world.dangerBorder.phase, 3, 'border should enter a locked phase once it reaches the stop threshold');
});
