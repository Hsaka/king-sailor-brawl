import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.window = globalThis.window || {};

const [
    { WorldState },
    { encodeMessage, decodeMessage, DEFAULT_PROTOCOL_LIMITS },
    { MessageType },
    { Session },
] = await Promise.all([
    import('../game/WorldState.js'),
    import('../netcode/encoding.js'),
    import('../netcode/messages.js'),
    import('../netcode/session.js'),
]);

test('JoinAccept encodes and decodes player lists larger than 255 entries', () => {
    const players = Array.from({ length: 300 }, (_, index) => ({
        id: `player-${index}`,
        name: `Player ${index}`,
    }));

    const encoded = encodeMessage({
        type: MessageType.JoinAccept,
        playerId: 'player-299',
        roomId: 'room-xyz',
        config: {
            tickRate: 60,
            maxPlayers: 5000,
        },
        players,
    });

    const decoded = decodeMessage(encoded, DEFAULT_PROTOCOL_LIMITS);

    assert.equal(decoded.type, MessageType.JoinAccept);
    assert.equal(decoded.config.tickRate, 60);
    assert.equal(decoded.config.maxPlayers, 5000);
    assert.equal(decoded.players.length, 300);
    assert.deepEqual(decoded.players[0], { id: 'player-0', name: 'Player 0' });
    assert.deepEqual(decoded.players[299], { id: 'player-299', name: 'Player 299' });
});

test('WorldState assigns a unique slot when a requested slot is already occupied', () => {
    const world = new WorldState();

    world.addPlayer('host', 0);
    world.addPlayer('guest-1', 1);
    world.removePlayer('host');

    world.addPlayer('guest-2', world.players.size);

    const guest1 = world.players.get('guest-1');
    const guest2 = world.players.get('guest-2');
    assert.ok(guest1);
    assert.ok(guest2);
    assert.equal(guest1.slot, 1);
    assert.equal(guest2.slot, 0);
    assert.equal(new Set([guest1.slot, guest2.slot]).size, 2);
});

test('Session rebroadcasts full startup input history during early ticks', () => {
    const sent = [];
    const transport = {
        localPeerId: 'p1',
        connectedPeers: new Set(['p2']),
        broadcast(message) {
            sent.push(message);
        },
        send() {
            return true;
        },
        disconnectAll() { },
    };
    const game = {
        step() { },
        serialize() { return new Uint8Array(0); },
        deserialize() { },
        hash() { return 0; },
    };

    const session = new Session({
        game,
        transport,
        config: {
            inputSizeBytes: 3,
            inputRedundancy: 3,
            startupInputHistoryTicks: 64,
        },
    });

    session.engine.setLocalInput(0, new Uint8Array([1, 0, 0]));
    session.engine.setLocalInput(1, new Uint8Array([2, 0, 0]));
    session.engine.setLocalInput(2, new Uint8Array([3, 0, 0]));
    session.broadcastInput(2, new Uint8Array([3, 0, 0]));

    assert.equal(sent.length, 1);
    const decoded = decodeMessage(sent[0], DEFAULT_PROTOCOL_LIMITS);
    assert.equal(decoded.type, MessageType.Input);
    assert.deepEqual(decoded.inputs.map((entry) => entry.tick), [2, 1, 0]);

    session.destroy();
});
