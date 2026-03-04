export const MessageType = {
    Input: 0x01,
    InputAck: 0x02,
    Hash: 0x10,
    Sync: 0x11,
    SyncRequest: 0x12,
    Pause: 0x20,
    Resume: 0x21,
    LagReport: 0x22,
    DisconnectReport: 0x23,
    ResumeCountdown: 0x24,
    DropPlayer: 0x25,
    JoinRequest: 0x30,
    JoinAccept: 0x31,
    JoinReject: 0x32,
    StateSync: 0x33,
    PlayerJoined: 0x34,
    PlayerLeft: 0x35,
    Ping: 0x40,
    Pong: 0x41,
};

export function isReliableMessage(msg) {
    switch (msg.type) {
        case MessageType.Input:
        case MessageType.InputAck:
        case MessageType.Ping:
        case MessageType.Pong:
            return false;
        default:
            return true;
    }
}

export function createInput(playerId, inputs) {
    return { type: MessageType.Input, playerId, inputs };
}

export function createInputAck(playerId, ackedTick) {
    return { type: MessageType.InputAck, playerId, ackedTick };
}

export function createHash(playerId, tick, hash) {
    return { type: MessageType.Hash, playerId, tick, hash };
}

export function createSync(tick, state, hash, playerTimeline) {
    return { type: MessageType.Sync, tick, state, hash, playerTimeline };
}

export function createSyncRequest(playerId, desyncTick, localHash) {
    return { type: MessageType.SyncRequest, playerId, desyncTick, localHash };
}

export function createPause(playerId, pauseTick, reason) {
    return { type: MessageType.Pause, playerId, pauseTick, reason };
}

export function createResume(playerId, resumeTick) {
    return { type: MessageType.Resume, playerId, resumeTick };
}

export function createJoinRequest(playerId, role, name) {
    return { type: MessageType.JoinRequest, playerId, role, name };
}

export function createJoinAccept(playerId, roomId, config, players) {
    return { type: MessageType.JoinAccept, playerId, roomId, config, players };
}

export function createJoinReject(playerId, reason) {
    return { type: MessageType.JoinReject, playerId, reason };
}

export function createStateSync(tick, state, hash, playerTimeline) {
    return { type: MessageType.StateSync, tick, state, hash, playerTimeline };
}

export function createPlayerJoined(playerId, role, joinTick, name) {
    return { type: MessageType.PlayerJoined, playerId, role, joinTick, name };
}

export function createPlayerLeft(playerId, leaveTick) {
    return { type: MessageType.PlayerLeft, playerId, leaveTick };
}

export function createPing(timestamp) {
    return { type: MessageType.Ping, timestamp };
}

export function createPong(timestamp) {
    return { type: MessageType.Pong, timestamp };
}

export function createLagReport(laggyPlayerId, ticksBehind) {
    return { type: MessageType.LagReport, laggyPlayerId, ticksBehind };
}

export function createDisconnectReport(disconnectedPeerId) {
    return { type: MessageType.DisconnectReport, disconnectedPeerId };
}

export function createResumeCountdown(secondsRemaining) {
    return { type: MessageType.ResumeCountdown, secondsRemaining };
}

export function createDropPlayer(playerId, metadata) {
    return { type: MessageType.DropPlayer, playerId, metadata };
}
