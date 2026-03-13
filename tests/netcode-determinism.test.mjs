import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.window = globalThis.window || {};

const [
    { WorldState },
    { ShipDefinitions },
    { getPowerupTypeId },
    { RollbackEngine },
    { Session },
    { decodeMessage },
    { MessageType },
] = await Promise.all([
    import('../game/WorldState.js'),
    import('../game/ShipDefinitions.js'),
    import('../game/PowerupDefinitions.js'),
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

function createPowerupConfig(overrides = {}) {
    const defaultTypes = {
        speed_boost: {
            ENABLED: true,
            DURATION_SECONDS: 3,
            SPEED_MULTIPLIER: 1.5,
            SPAWN_WEIGHT: 1,
            MAX_ACTIVE: 2,
        },
        shield: {
            ENABLED: true,
            DURATION_SECONDS: 3,
            SPAWN_WEIGHT: 1,
            MAX_ACTIVE: 2,
        },
        attack_boost: {
            ENABLED: true,
            DURATION_SECONDS: 3,
            DAMAGE_MULTIPLIER: 2,
            SPAWN_WEIGHT: 1,
            MAX_ACTIVE: 2,
        },
    };

    const rawTypeOverrides = overrides.TYPES || {};
    const mergedTypes = {
        speed_boost: { ...defaultTypes.speed_boost, ...(rawTypeOverrides.speed_boost || {}) },
        shield: { ...defaultTypes.shield, ...(rawTypeOverrides.shield || {}) },
        attack_boost: { ...defaultTypes.attack_boost, ...(rawTypeOverrides.attack_boost || {}) },
    };

    return {
        ENABLED: true,
        MAX_ACTIVE: 4,
        SPAWN_ENABLED: true,
        SPAWN_INTERVAL_SECONDS: 1,
        SPAWN_BATCH_SIZE: 1,
        DESPAWN_AFTER_SECONDS: 4,
        PICKUP_RADIUS: 18,
        SPAWN_EDGE_INSET_X: 0,
        SPAWN_EDGE_INSET_Y: 0,
        SPAWN_PLAYER_CLEARANCE: 0,
        SPAWN_POWERUP_CLEARANCE: 0,
        SPAWN_POSITION_ATTEMPTS: 1,
        SAME_TYPE_PICKUP_BEHAVIOR: 'refresh',
        ...overrides,
        TYPES: mergedTypes,
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

function addPowerup(world, typeKey, overrides = {}) {
    const powerup = {
        id: overrides.id ?? world.nextPowerupId++,
        typeId: getPowerupTypeId(typeKey),
        x: overrides.x ?? 0,
        y: overrides.y ?? 0,
        despawnTicks: overrides.despawnTicks ?? world.powerupConfig.despawnAfterTicks,
    };
    world.powerups.push(powerup);
    world.quantizeState();
    return powerup;
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
    const world = createCombatWorld({
        powerupConfig: createPowerupConfig({
            MAX_ACTIVE: 5,
            DESPAWN_AFTER_SECONDS: 6,
        }),
    });
    world.players.get('p1').speedBoostTicks = 12;
    world.players.get('p2').shieldTicks = 7;
    addPowerup(world, 'attack_boost', {
        x: 720,
        y: 560,
        despawnTicks: 55,
    });
    world.powerupSpawnTicksUntilNext = 9;
    world.quantizeState();

    const baselineBytes = world.serialize();
    const baselineHash = world.hash(baselineBytes);

    const headingChanged = createCombatWorld({ powerupConfig: createPowerupConfig({ MAX_ACTIVE: 5, DESPAWN_AFTER_SECONDS: 6 }) });
    headingChanged.players.get('p1').speedBoostTicks = 12;
    headingChanged.players.get('p2').shieldTicks = 7;
    addPowerup(headingChanged, 'attack_boost', { x: 720, y: 560, despawnTicks: 55 });
    headingChanged.powerupSpawnTicksUntilNext = 9;
    headingChanged.players.get('p1').heading += 37;
    assert.notEqual(headingChanged.hash(headingChanged.serialize()), baselineHash, 'heading changes must affect hash');

    const cooldownChanged = createCombatWorld({ powerupConfig: createPowerupConfig({ MAX_ACTIVE: 5, DESPAWN_AFTER_SECONDS: 6 }) });
    cooldownChanged.players.get('p1').speedBoostTicks = 12;
    cooldownChanged.players.get('p2').shieldTicks = 7;
    addPowerup(cooldownChanged, 'attack_boost', { x: 720, y: 560, despawnTicks: 55 });
    cooldownChanged.powerupSpawnTicksUntilNext = 9;
    cooldownChanged.players.get('p2').cooldowns[1] = 1.25;
    assert.notEqual(cooldownChanged.hash(cooldownChanged.serialize()), baselineHash, 'cooldown changes must affect hash');

    const debrisChanged = createCombatWorld({ powerupConfig: createPowerupConfig({ MAX_ACTIVE: 5, DESPAWN_AFTER_SECONDS: 6 }) });
    debrisChanged.players.get('p1').speedBoostTicks = 12;
    debrisChanged.players.get('p2').shieldTicks = 7;
    addPowerup(debrisChanged, 'attack_boost', { x: 720, y: 560, despawnTicks: 55 });
    debrisChanged.powerupSpawnTicksUntilNext = 9;
    debrisChanged.spawnDebris(640, 640, ShipDefinitions.get('cobro').debris);
    const debrisHash = debrisChanged.hash(debrisChanged.serialize());
    assert.notEqual(debrisHash, baselineHash, 'debris changes must affect hash');

    const borderChanged = createCombatWorld({ powerupConfig: createPowerupConfig({ MAX_ACTIVE: 5, DESPAWN_AFTER_SECONDS: 6 }) });
    borderChanged.players.get('p1').speedBoostTicks = 12;
    borderChanged.players.get('p2').shieldTicks = 7;
    addPowerup(borderChanged, 'attack_boost', { x: 720, y: 560, despawnTicks: 55 });
    borderChanged.powerupSpawnTicksUntilNext = 9;
    borderChanged.dangerBorder.elapsedTicks = 75;
    borderChanged.dangerBorder.currentInset = 195;
    assert.notEqual(borderChanged.hash(borderChanged.serialize()), baselineHash, 'danger border changes must affect hash');

    const powerupEntityChanged = createCombatWorld({ powerupConfig: createPowerupConfig({ MAX_ACTIVE: 5, DESPAWN_AFTER_SECONDS: 6 }) });
    powerupEntityChanged.players.get('p1').speedBoostTicks = 12;
    powerupEntityChanged.players.get('p2').shieldTicks = 7;
    addPowerup(powerupEntityChanged, 'attack_boost', { x: 740, y: 560, despawnTicks: 55 });
    powerupEntityChanged.powerupSpawnTicksUntilNext = 9;
    assert.notEqual(powerupEntityChanged.hash(powerupEntityChanged.serialize()), baselineHash, 'power-up position changes must affect hash');

    const powerupEffectChanged = createCombatWorld({ powerupConfig: createPowerupConfig({ MAX_ACTIVE: 5, DESPAWN_AFTER_SECONDS: 6 }) });
    powerupEffectChanged.players.get('p1').speedBoostTicks = 11;
    powerupEffectChanged.players.get('p2').shieldTicks = 7;
    addPowerup(powerupEffectChanged, 'attack_boost', { x: 720, y: 560, despawnTicks: 55 });
    powerupEffectChanged.powerupSpawnTicksUntilNext = 9;
    assert.notEqual(powerupEffectChanged.hash(powerupEffectChanged.serialize()), baselineHash, 'power-up player effects must affect hash');

    const powerupConfigChanged = createCombatWorld({ powerupConfig: createPowerupConfig({ MAX_ACTIVE: 6, DESPAWN_AFTER_SECONDS: 6 }) });
    powerupConfigChanged.players.get('p1').speedBoostTicks = 12;
    powerupConfigChanged.players.get('p2').shieldTicks = 7;
    addPowerup(powerupConfigChanged, 'attack_boost', { x: 720, y: 560, despawnTicks: 55 });
    powerupConfigChanged.powerupSpawnTicksUntilNext = 9;
    assert.notEqual(powerupConfigChanged.hash(powerupConfigChanged.serialize()), baselineHash, 'power-up config changes must affect hash');

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

test('power-up spawning stays deterministic across peers', () => {
    const powerupConfig = createPowerupConfig({
        SPAWN_INTERVAL_SECONDS: 1 / 60,
        SPAWN_BATCH_SIZE: 1,
        DESPAWN_AFTER_SECONDS: 10,
        MAX_ACTIVE: 3,
        SPAWN_PLAYER_CLEARANCE: 250,
        TYPES: {
            speed_boost: { SPAWN_WEIGHT: 4, MAX_ACTIVE: 2 },
            shield: { SPAWN_WEIGHT: 2, MAX_ACTIVE: 1 },
            attack_boost: { SPAWN_WEIGHT: 1, MAX_ACTIVE: 1 },
        },
    });

    const worldA = createCombatWorld({ powerupConfig });
    const worldB = createCombatWorld({ powerupConfig });

    setPlayerState(worldA, 'p1', { x: 300, y: 300, heading: 0, speedTier: 1 });
    setPlayerState(worldA, 'p2', { x: 2100, y: 2100, heading: 180, speedTier: 1 });
    setPlayerState(worldB, 'p1', { x: 300, y: 300, heading: 0, speedTier: 1 });
    setPlayerState(worldB, 'p2', { x: 2100, y: 2100, heading: 180, speedTier: 1 });

    for (let tick = 0; tick < 6; tick++) {
        worldA.step(new Map());
        worldB.step(new Map());

        const bytesA = worldA.serialize();
        const bytesB = worldB.serialize();
        assertStateBytesEqual(bytesA, bytesB, `spawned states diverged at tick ${tick}`);
    }

    assert.equal(worldA.powerups.length, 3, 'spawn limit should stop additional deterministic spawns');
    assert.deepEqual(
        worldA.powerups.map((entry) => ({ id: entry.id, typeId: entry.typeId, x: entry.x, y: entry.y })),
        worldB.powerups.map((entry) => ({ id: entry.id, typeId: entry.typeId, x: entry.x, y: entry.y })),
        'spawn ids, types, and positions should remain identical',
    );
});

test('power-up pickup resolution is deterministic and applies effects immediately', () => {
    const powerupConfig = createPowerupConfig({
        SPAWN_ENABLED: false,
        TYPES: {
            speed_boost: { DURATION_SECONDS: 3 },
            shield: { DURATION_SECONDS: 3 },
            attack_boost: { DURATION_SECONDS: 3 },
        },
    });
    const worldA = createCombatWorld({ powerupConfig });
    const worldB = createCombatWorld({ powerupConfig });

    setPlayerState(worldA, 'p1', { x: 520, y: 500, heading: 0, speedTier: 1 });
    setPlayerState(worldA, 'p2', { x: 620, y: 500, heading: 180, speedTier: 1 });
    setPlayerState(worldB, 'p1', { x: 520, y: 500, heading: 0, speedTier: 1 });
    setPlayerState(worldB, 'p2', { x: 620, y: 500, heading: 180, speedTier: 1 });

    addPowerup(worldA, 'attack_boost', { x: 525, y: 500, despawnTicks: 300 });
    addPowerup(worldA, 'shield', { x: 620, y: 500, despawnTicks: 300 });
    addPowerup(worldB, 'attack_boost', { x: 525, y: 500, despawnTicks: 300 });
    addPowerup(worldB, 'shield', { x: 620, y: 500, despawnTicks: 300 });

    worldA.step(new Map([
        ['p1', packInput(0x10)],
        ['p2', packInput(0)],
    ]));
    worldB.step(new Map([
        ['p1', packInput(0x10)],
        ['p2', packInput(0)],
    ]));

    assert.equal(worldA.powerups.length, 0, 'both deterministic pickups should be consumed');
    assert.equal(worldA.players.get('p1').attackBoostTicks, worldA.getPowerupTypeConfig('attack_boost').durationTicks - 1);
    assert.equal(worldA.players.get('p2').shieldTicks, worldA.getPowerupTypeConfig('shield').durationTicks - 1);
    assert.equal(worldA.players.get('p2').health, ShipDefinitions.get('cobro').maxHealth, 'shield pickup should protect on the same authoritative tick');

    assertStateBytesEqual(worldA.serialize(), worldB.serialize(), 'pickup results should remain byte-identical');
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

test('rollback convergence includes delayed remote power-up pickups', () => {
    const powerupConfig = createPowerupConfig({
        SPAWN_ENABLED: false,
        TYPES: {
            speed_boost: { DURATION_SECONDS: 4, SPEED_MULTIPLIER: 1.5 },
        },
    });
    const authoritativeWorld = createRollbackWorld({ powerupConfig });
    const predictedWorld = createRollbackWorld({ powerupConfig });

    setPlayerState(authoritativeWorld, 'p2', { x: 1000, y: 1000, heading: 180, speedTier: 1 });
    setPlayerState(predictedWorld, 'p2', { x: 1000, y: 1000, heading: 180, speedTier: 1 });
    addPowerup(authoritativeWorld, 'speed_boost', { x: 900, y: 1000, despawnTicks: 600 });
    addPowerup(predictedWorld, 'speed_boost', { x: 900, y: 1000, despawnTicks: 600 });

    const authoritative = createEngine(authoritativeWorld);
    const predicted = createEngine(predictedWorld);
    const remoteInputs = [];
    const delayTicks = 4;
    const totalTicks = 32;
    let sawRollback = false;

    for (let tick = 0; tick < totalTicks; tick++) {
        const localInput = packInput(0);
        const remoteInput = packInput(tick === 0 ? 0x04 : 0);
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
        const tick = totalTicks + i;
        authoritative.setLocalInput(tick, packInput(0));
        authoritative.receiveRemoteInput('p2', tick, packInput(0));
        authoritative.tick();

        predicted.setLocalInput(tick, packInput(0));
        predicted.receiveRemoteInput('p2', tick, packInput(0));
        const result = predicted.tick();
        sawRollback ||= !!result?.rolledBack;
    }

    assert.ok(sawRollback, 'late remote pickup-affecting input should trigger rollback');
    assertStateBytesEqual(predicted.getState().state, authoritative.getState().state, 'pickup rollback should converge to the same authoritative bytes');
    assert.equal(predicted.getCurrentHash(), authoritative.getCurrentHash(), 'pickup rollback should converge to the same hash');
    assert.equal(authoritative.game.players.get('p2').speedBoostTicks, predicted.game.players.get('p2').speedBoostTicks, 'pickup effect timing should converge after rollback');
});

test('power-up effects expire on deterministic tick boundaries', () => {
    const powerupConfig = createPowerupConfig({
        SPAWN_ENABLED: false,
        TYPES: {
            speed_boost: { DURATION_SECONDS: 3 / 60 },
            shield: { DURATION_SECONDS: 2 / 60 },
            attack_boost: { DURATION_SECONDS: 4 / 60 },
        },
    });
    const world = createCombatWorld({ powerupConfig });

    addPowerup(world, 'speed_boost', { x: 500, y: 500, despawnTicks: 300 });
    addPowerup(world, 'shield', { x: 580, y: 500, despawnTicks: 300 });
    addPowerup(world, 'attack_boost', { x: 500, y: 500, despawnTicks: 300, id: world.nextPowerupId++ });

    world.step(new Map([
        ['p1', packInput(0)],
        ['p2', packInput(0)],
    ]));

    assert.equal(world.players.get('p1').speedBoostTicks, 2, 'speed boost should include the pickup tick');
    assert.equal(world.players.get('p1').attackBoostTicks, 3, 'attack boost should include the pickup tick');
    assert.equal(world.players.get('p2').shieldTicks, 1, 'shield should include the pickup tick');

    world.step(new Map());
    assert.equal(world.players.get('p2').shieldTicks, 0, 'shield should expire on its configured second tick');

    world.step(new Map());
    assert.equal(world.players.get('p1').speedBoostTicks, 0, 'speed boost should expire exactly on schedule');

    world.step(new Map());
    assert.equal(world.players.get('p1').attackBoostTicks, 0, 'attack boost should expire exactly on schedule');
});

test('shield prevents authoritative damage application', () => {
    const powerupConfig = createPowerupConfig({
        SPAWN_ENABLED: false,
        TYPES: {
            shield: { DURATION_SECONDS: 10 },
        },
    });
    const world = createCombatWorld({ powerupConfig });
    world.applyPowerupToPlayer(world.players.get('p2'), getPowerupTypeId('shield'));

    world.step(new Map([
        ['p1', packInput(0x10)],
        ['p2', packInput(0)],
    ]));

    assert.equal(world.players.get('p2').health, ShipDefinitions.get('cobro').maxHealth, 'shielded player should take no damage');
});

test('attack boost modifies outgoing damage in authoritative combat', () => {
    const powerupConfig = createPowerupConfig({
        SPAWN_ENABLED: false,
        TYPES: {
            attack_boost: { DURATION_SECONDS: 10, DAMAGE_MULTIPLIER: 2 },
        },
    });
    const world = createCombatWorld({ powerupConfig });
    world.applyPowerupToPlayer(world.players.get('p1'), getPowerupTypeId('attack_boost'));

    world.step(new Map([
        ['p1', packInput(0x10)],
        ['p2', packInput(0)],
    ]));

    const expectedDamage = ShipDefinitions.get('cobro').attackZones[0].damage * 2;
    assert.equal(
        world.players.get('p2').health,
        ShipDefinitions.get('cobro').maxHealth - expectedDamage,
        'attack boost should multiply outgoing direct-hit damage',
    );
});

test('speed boost changes deterministic movement distance', () => {
    const powerupConfig = createPowerupConfig({
        SPAWN_ENABLED: false,
        TYPES: {
            speed_boost: { DURATION_SECONDS: 10, SPEED_MULTIPLIER: 1.5 },
        },
    });
    const world = createCombatWorld({ powerupConfig });
    const boostedPlayer = world.players.get('p1');
    const unboostedWorld = createCombatWorld({ powerupConfig: createPowerupConfig({ SPAWN_ENABLED: false }) });
    const unboostedPlayer = unboostedWorld.players.get('p1');

    world.applyPowerupToPlayer(boostedPlayer, getPowerupTypeId('speed_boost'));

    const boostedStartX = boostedPlayer.x;
    const unboostedStartX = unboostedPlayer.x;
    world.step(new Map([['p1', packInput(0)], ['p2', packInput(0)]]));
    unboostedWorld.step(new Map([['p1', packInput(0)], ['p2', packInput(0)]]));

    const boostedDistance = world.players.get('p1').x - boostedStartX;
    const unboostedDistance = unboostedWorld.players.get('p1').x - unboostedStartX;

    assert.ok(boostedDistance > unboostedDistance, 'boosted ship should move farther in the same deterministic tick');
    assert.equal(
        Number((boostedDistance / unboostedDistance).toFixed(2)),
        1.5,
        'speed boost should apply the configured multiplier to movement',
    );
});

test('power-up spawning respects global and per-type active limits', () => {
    const powerupConfig = createPowerupConfig({
        SPAWN_INTERVAL_SECONDS: 1 / 60,
        SPAWN_BATCH_SIZE: 3,
        MAX_ACTIVE: 2,
        SPAWN_PLAYER_CLEARANCE: 250,
        TYPES: {
            speed_boost: { SPAWN_WEIGHT: 10, MAX_ACTIVE: 1 },
            shield: { SPAWN_WEIGHT: 0, MAX_ACTIVE: 0 },
            attack_boost: { SPAWN_WEIGHT: 10, MAX_ACTIVE: 1 },
        },
    });
    const world = createCombatWorld({ powerupConfig });
    setPlayerState(world, 'p1', { x: 250, y: 250, heading: 0, speedTier: 1 });
    setPlayerState(world, 'p2', { x: 2150, y: 2150, heading: 180, speedTier: 1 });

    for (let tick = 0; tick < 5; tick++) {
        world.step(new Map());
    }

    assert.equal(world.powerups.length, 2, 'global power-up cap should stop additional spawns');
    assert.equal(world.countActivePowerupsByType(getPowerupTypeId('speed_boost')), 1, 'per-type active cap should be enforced');
    assert.equal(world.countActivePowerupsByType(getPowerupTypeId('attack_boost')), 1, 'per-type active cap should be enforced');
    assert.equal(world.countActivePowerupsByType(getPowerupTypeId('shield')), 0, 'disabled spawn weights should exclude a type entirely');
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
