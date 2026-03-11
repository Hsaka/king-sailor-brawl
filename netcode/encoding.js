import { MessageType, isReliableMessage } from './messages.js';

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export const MAX_INPUT_SIZE_PER_FRAME = 1024;
export const MAX_INPUT_MESSAGE_SIZE = 65536;

export const DEFAULT_PROTOCOL_LIMITS = {
    maxStringLength: 1024,
    maxPlayerCount: 256,
    maxStateSize: 1000000,
};

export class DecodeError extends Error {
    constructor(message, messageType, offset, expected, actual) {
        super(`${message} at offset ${offset}: expected ${expected} bytes, got ${actual}${messageType !== undefined ? ` (message type: ${messageType})` : ''}`);
        this.name = 'DecodeError';
        this.messageType = messageType;
        this.offset = offset;
        this.expected = expected;
        this.actual = actual;
    }
}

export class EncodeError extends Error {
    constructor(message, field, maxValue, actualValue) {
        super(`${message}: ${field} must be <= ${maxValue}, got ${actualValue}`);
        this.name = 'EncodeError';
        this.field = field;
        this.maxValue = maxValue;
        this.actualValue = actualValue;
    }
}

function ensureBytes(view, offset, needed, messageType) {
    const available = view.byteLength - offset;
    if (available < needed) {
        throw new DecodeError('Insufficient bytes in buffer', messageType, offset, needed, available);
    }
}

function writeString(view, offset, str) {
    const bytes = textEncoder.encode(str);
    view.setUint16(offset, bytes.length);
    const uint8View = new Uint8Array(view.buffer, view.byteOffset + offset + 2);
    uint8View.set(bytes);
    return 2 + bytes.length;
}

function readString(view, offset, messageType, maxLength) {
    ensureBytes(view, offset, 2, messageType);
    const length = view.getUint16(offset);
    if (maxLength !== undefined && length > maxLength) {
        throw new DecodeError(`String length exceeds maximum of ${maxLength} bytes`, messageType, offset, maxLength, length);
    }
    ensureBytes(view, offset + 2, length, messageType);
    const bytes = new Uint8Array(view.buffer, view.byteOffset + offset + 2, length);
    return [textDecoder.decode(bytes), 2 + length];
}

function writeBytes(view, offset, data) {
    view.setUint32(offset, data.length);
    const uint8View = new Uint8Array(view.buffer, view.byteOffset + offset + 4);
    uint8View.set(data);
    return 4 + data.length;
}

function readBytes(view, offset, messageType, maxSize) {
    ensureBytes(view, offset, 4, messageType);
    const length = view.getUint32(offset);
    if (maxSize !== undefined && length > maxSize) {
        throw new DecodeError(`Byte array size exceeds maximum of ${maxSize} bytes`, messageType, offset, maxSize, length);
    }
    ensureBytes(view, offset + 4, length, messageType);
    const data = new Uint8Array(length);
    data.set(new Uint8Array(view.buffer, view.byteOffset + offset + 4, length));
    return [data, 4 + length];
}

export function encodeMessage(message) {
    switch (message.type) {
        case MessageType.Input: return encodeInputMessage(message);
        case MessageType.InputAck: return encodeInputAckMessage(message);
        case MessageType.Hash: return encodeHashMessage(message);
        case MessageType.Sync: return encodeSyncMessage(message);
        case MessageType.SyncRequest: return encodeSyncRequestMessage(message);
        case MessageType.Pause: return encodePauseMessage(message);
        case MessageType.Resume: return encodeResumeMessage(message);
        case MessageType.JoinRequest: return encodeJoinRequestMessage(message);
        case MessageType.JoinAccept: return encodeJoinAcceptMessage(message);
        case MessageType.JoinReject: return encodeJoinRejectMessage(message);
        case MessageType.StateSync: return encodeStateSyncMessage(message);
        case MessageType.PlayerJoined: return encodePlayerJoinedMessage(message);
        case MessageType.PlayerLeft: return encodePlayerLeftMessage(message);
        case MessageType.Ping: return encodePingMessage(message);
        case MessageType.Pong: return encodePongMessage(message);
        case MessageType.LagReport: return encodeLagReportMessage(message);
        case MessageType.DisconnectReport: return encodeDisconnectReportMessage(message);
        case MessageType.ResumeCountdown: return encodeResumeCountdownMessage(message);
        case MessageType.DropPlayer: return encodeDropPlayerMessage(message);
    }
}

export function decodeMessage(data, limits = DEFAULT_PROTOCOL_LIMITS) {
    if (data.length === 0) {
        throw new DecodeError('Empty message', undefined, 0, 1, 0);
    }
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const type = view.getUint8(0);

    switch (type) {
        case MessageType.Input: return decodeInputMessage(view, limits);
        case MessageType.InputAck: return decodeInputAckMessage(view, limits);
        case MessageType.Hash: return decodeHashMessage(view, limits);
        case MessageType.Sync: return decodeSyncMessage(view, limits);
        case MessageType.SyncRequest: return decodeSyncRequestMessage(view, limits);
        case MessageType.Pause: return decodePauseMessage(view, limits);
        case MessageType.Resume: return decodeResumeMessage(view, limits);
        case MessageType.JoinRequest: return decodeJoinRequestMessage(view, limits);
        case MessageType.JoinAccept: return decodeJoinAcceptMessage(view, limits);
        case MessageType.JoinReject: return decodeJoinRejectMessage(view, limits);
        case MessageType.StateSync: return decodeStateSyncMessage(view, limits);
        case MessageType.PlayerJoined: return decodePlayerJoinedMessage(view, limits);
        case MessageType.PlayerLeft: return decodePlayerLeftMessage(view, limits);
        case MessageType.Ping: return decodePingMessage(view);
        case MessageType.Pong: return decodePongMessage(view);
        case MessageType.LagReport: return decodeLagReportMessage(view, limits);
        case MessageType.DisconnectReport: return decodeDisconnectReportMessage(view, limits);
        case MessageType.ResumeCountdown: return decodeResumeCountdownMessage(view);
        case MessageType.DropPlayer: return decodeDropPlayerMessage(view, limits);
        default:
            throw new DecodeError(`Unknown message type: ${type}`, type, 0, 0, data.length);
    }
}

function encodeInputMessage(msg) {
    if (msg.inputs.length > 255) {
        throw new EncodeError('Input count exceeds maximum', 'inputs.length', 255, msg.inputs.length);
    }
    for (let i = 0; i < msg.inputs.length; i++) {
        const entry = msg.inputs[i];
        if (entry && entry.input.length > MAX_INPUT_SIZE_PER_FRAME) {
            throw new EncodeError('Individual input size exceeds maximum', `inputs[${i}].input.length`, MAX_INPUT_SIZE_PER_FRAME, entry.input.length);
        }
    }

    const playerIdBytes = textEncoder.encode(msg.playerId);
    let totalSize = 1 + 2 + playerIdBytes.length + 1;
    for (const entry of msg.inputs) {
        totalSize += 4 + 2 + entry.input.length;
    }

    if (totalSize > MAX_INPUT_MESSAGE_SIZE) {
        throw new EncodeError('Total input message size exceeds maximum', 'totalSize', MAX_INPUT_MESSAGE_SIZE, totalSize);
    }

    const buffer = new Uint8Array(totalSize);
    const view = new DataView(buffer.buffer);
    let offset = 0;

    view.setUint8(offset++, MessageType.Input);
    offset += writeString(view, offset, msg.playerId);
    view.setUint8(offset++, msg.inputs.length);

    for (const entry of msg.inputs) {
        view.setInt32(offset, entry.tick);
        offset += 4;
        view.setUint16(offset, entry.input.length);
        offset += 2;
        buffer.set(entry.input, offset);
        offset += entry.input.length;
    }

    return buffer;
}

function decodeInputMessage(view, limits) {
    const msgType = MessageType.Input;
    if (view.byteLength > MAX_INPUT_MESSAGE_SIZE) {
        throw new DecodeError(`Input message exceeds maximum size of ${MAX_INPUT_MESSAGE_SIZE} bytes`, msgType, 0, MAX_INPUT_MESSAGE_SIZE, view.byteLength);
    }

    let offset = 1;
    const [playerId, playerIdLen] = readString(view, offset, msgType, limits.maxStringLength);
    offset += playerIdLen;

    ensureBytes(view, offset, 1, msgType);
    const inputCount = view.getUint8(offset++);
    const inputs = [];

    for (let i = 0; i < inputCount; i++) {
        ensureBytes(view, offset, 4, msgType);
        const tick = view.getInt32(offset);
        offset += 4;
        ensureBytes(view, offset, 2, msgType);
        const inputLen = view.getUint16(offset);
        offset += 2;

        if (inputLen > MAX_INPUT_SIZE_PER_FRAME) {
            throw new DecodeError(`Input frame ${i} exceeds maximum size of ${MAX_INPUT_SIZE_PER_FRAME} bytes`, msgType, offset - 2, MAX_INPUT_SIZE_PER_FRAME, inputLen);
        }

        ensureBytes(view, offset, inputLen, msgType);
        const input = new Uint8Array(inputLen);
        input.set(new Uint8Array(view.buffer, view.byteOffset + offset, inputLen));
        offset += inputLen;
        inputs.push({ tick, input });
    }

    return { type: MessageType.Input, playerId, inputs };
}

function encodeInputAckMessage(msg) {
    const playerIdBytes = textEncoder.encode(msg.playerId);
    const buffer = new Uint8Array(1 + 2 + playerIdBytes.length + 4);
    const view = new DataView(buffer.buffer);

    let offset = 0;
    view.setUint8(offset++, MessageType.InputAck);
    offset += writeString(view, offset, msg.playerId);
    view.setInt32(offset, msg.ackedTick);

    return buffer;
}

function decodeInputAckMessage(view, limits) {
    const msgType = MessageType.InputAck;
    let offset = 1;
    const [playerId, playerIdLen] = readString(view, offset, msgType, limits.maxStringLength);
    offset += playerIdLen;
    ensureBytes(view, offset, 4, msgType);
    const ackedTick = view.getInt32(offset);

    return { type: MessageType.InputAck, playerId, ackedTick };
}

function encodeHashMessage(msg) {
    const playerIdBytes = textEncoder.encode(msg.playerId);
    const buffer = new Uint8Array(1 + 2 + playerIdBytes.length + 4 + 4);
    const view = new DataView(buffer.buffer);

    let offset = 0;
    view.setUint8(offset++, MessageType.Hash);
    offset += writeString(view, offset, msg.playerId);
    view.setInt32(offset, msg.tick);
    offset += 4;
    view.setUint32(offset, msg.hash);

    return buffer;
}

function decodeHashMessage(view, limits) {
    const msgType = MessageType.Hash;
    let offset = 1;
    const [playerId, playerIdLen] = readString(view, offset, msgType, limits.maxStringLength);
    offset += playerIdLen;
    ensureBytes(view, offset, 4, msgType);
    const tick = view.getInt32(offset);
    offset += 4;
    ensureBytes(view, offset, 4, msgType);
    const hash = view.getUint32(offset);

    return { type: MessageType.Hash, playerId, tick, hash };
}

function encodeSyncMessage(msg) {
    let timelineSize = 2;
    for (const entry of msg.playerTimeline) {
        const idBytes = textEncoder.encode(entry.playerId);
        const nameBytes = textEncoder.encode(entry.name || '');
        timelineSize += 2 + idBytes.length + 2 + nameBytes.length + 4 + 1 + (entry.leaveTick !== null ? 4 : 0);
    }

    const buffer = new Uint8Array(1 + 4 + 4 + 4 + msg.state.length + timelineSize);
    const view = new DataView(buffer.buffer);

    let offset = 0;
    view.setUint8(offset++, MessageType.Sync);
    view.setInt32(offset, msg.tick);
    offset += 4;
    view.setUint32(offset, msg.hash);
    offset += 4;
    offset += writeBytes(view, offset, msg.state);

    view.setUint16(offset, msg.playerTimeline.length);
    offset += 2;
    for (const entry of msg.playerTimeline) {
        offset += writeString(view, offset, entry.playerId);
        offset += writeString(view, offset, entry.name || '');
        view.setInt32(offset, entry.joinTick);
        offset += 4;
        if (entry.leaveTick !== null) {
            view.setUint8(offset++, 1);
            view.setInt32(offset, entry.leaveTick);
            offset += 4;
        } else {
            view.setUint8(offset++, 0);
        }
    }

    return buffer;
}

function decodeSyncMessage(view, limits) {
    const msgType = MessageType.Sync;
    let offset = 1;
    ensureBytes(view, offset, 4, msgType);
    const tick = view.getInt32(offset);
    offset += 4;
    ensureBytes(view, offset, 4, msgType);
    const hash = view.getUint32(offset);
    offset += 4;
    const [state, stateLen] = readBytes(view, offset, msgType, limits.maxStateSize);
    offset += stateLen;

    ensureBytes(view, offset, 2, msgType);
    const playerCount = view.getUint16(offset);
    offset += 2;

    if (playerCount > limits.maxPlayerCount) {
        throw new DecodeError(`Player count exceeds maximum of ${limits.maxPlayerCount}`, msgType, offset - 2, limits.maxPlayerCount, playerCount);
    }

    const playerTimeline = [];
    for (let i = 0; i < playerCount; i++) {
        const [playerId, idLen] = readString(view, offset, msgType, limits.maxStringLength);
        offset += idLen;
        const [name, nameLen] = readString(view, offset, msgType, limits.maxStringLength);
        offset += nameLen;
        ensureBytes(view, offset, 4, msgType);
        const joinTick = view.getInt32(offset);
        offset += 4;
        ensureBytes(view, offset, 1, msgType);
        const hasLeaveTick = view.getUint8(offset++) === 1;
        if (hasLeaveTick) ensureBytes(view, offset, 4, msgType);
        const leaveTick = hasLeaveTick ? view.getInt32(offset) : null;
        if (hasLeaveTick) offset += 4;

        playerTimeline.push({ playerId, name, joinTick, leaveTick });
    }

    return { type: MessageType.Sync, tick, state, hash, playerTimeline };
}

function encodeSyncRequestMessage(msg) {
    const playerIdBytes = textEncoder.encode(msg.playerId);
    const buffer = new Uint8Array(1 + 2 + playerIdBytes.length + 4 + 4);
    const view = new DataView(buffer.buffer);

    let offset = 0;
    view.setUint8(offset++, MessageType.SyncRequest);
    offset += writeString(view, offset, msg.playerId);
    view.setInt32(offset, msg.desyncTick);
    offset += 4;
    view.setUint32(offset, msg.localHash);

    return buffer;
}

function decodeSyncRequestMessage(view, limits) {
    const msgType = MessageType.SyncRequest;
    let offset = 1;
    const [playerId, playerIdLen] = readString(view, offset, msgType, limits.maxStringLength);
    offset += playerIdLen;
    ensureBytes(view, offset, 4, msgType);
    const desyncTick = view.getInt32(offset);
    offset += 4;
    ensureBytes(view, offset, 4, msgType);
    const localHash = view.getUint32(offset);

    return { type: MessageType.SyncRequest, playerId, desyncTick, localHash };
}

function encodePauseMessage(msg) {
    const playerIdBytes = textEncoder.encode(msg.playerId);
    const buffer = new Uint8Array(1 + 2 + playerIdBytes.length + 4 + 1);
    const view = new DataView(buffer.buffer);

    let offset = 0;
    view.setUint8(offset++, MessageType.Pause);
    offset += writeString(view, offset, msg.playerId);
    view.setInt32(offset, msg.pauseTick);
    offset += 4;
    view.setUint8(offset, msg.reason);

    return buffer;
}

function decodePauseMessage(view, limits) {
    const msgType = MessageType.Pause;
    let offset = 1;
    const [playerId, playerIdLen] = readString(view, offset, msgType, limits.maxStringLength);
    offset += playerIdLen;
    ensureBytes(view, offset, 5, msgType);
    const pauseTick = view.getInt32(offset);
    offset += 4;
    const reason = view.getUint8(offset);

    return { type: MessageType.Pause, playerId, pauseTick, reason };
}

function encodeResumeMessage(msg) {
    const playerIdBytes = textEncoder.encode(msg.playerId);
    const buffer = new Uint8Array(1 + 2 + playerIdBytes.length + 4);
    const view = new DataView(buffer.buffer);

    let offset = 0;
    view.setUint8(offset++, MessageType.Resume);
    offset += writeString(view, offset, msg.playerId);
    view.setInt32(offset, msg.resumeTick);

    return buffer;
}

function decodeResumeMessage(view, limits) {
    const msgType = MessageType.Resume;
    let offset = 1;
    const [playerId, playerIdLen] = readString(view, offset, msgType, limits.maxStringLength);
    offset += playerIdLen;
    ensureBytes(view, offset, 4, msgType);
    const resumeTick = view.getInt32(offset);

    return { type: MessageType.Resume, playerId, resumeTick };
}

function encodeJoinRequestMessage(msg) {
    const playerIdBytes = textEncoder.encode(msg.playerId);
    const nameBytes = textEncoder.encode(msg.name || '');
    const buffer = new Uint8Array(1 + 2 + playerIdBytes.length + 1 + 2 + nameBytes.length);
    const view = new DataView(buffer.buffer);

    let offset = 0;
    view.setUint8(offset++, MessageType.JoinRequest);
    offset += writeString(view, offset, msg.playerId);
    view.setUint8(offset++, msg.role !== undefined ? msg.role : 0xff);
    offset += writeString(view, offset, msg.name || '');

    return buffer;
}

function decodeJoinRequestMessage(view, limits) {
    const msgType = MessageType.JoinRequest;
    let offset = 1;
    const [playerId, playerIdLen] = readString(view, offset, msgType, limits.maxStringLength);
    offset += playerIdLen;

    let role = undefined;
    if (view.byteLength > offset) {
        const roleValue = view.getUint8(offset++);
        if (roleValue !== 0xff) role = roleValue;
    }

    let name = undefined;
    if (view.byteLength > offset) {
        const [n, nLen] = readString(view, offset, msgType, limits.maxStringLength);
        name = n;
        offset += nLen;
    }

    const result = { type: MessageType.JoinRequest, playerId };
    if (role !== undefined) result.role = role;
    if (name !== undefined) result.name = name;
    return result;
}

function encodeJoinAcceptMessage(msg) {
    const playerIdBytes = textEncoder.encode(msg.playerId);
    const roomIdBytes = textEncoder.encode(msg.roomId);
    const configJson = JSON.stringify(msg.config || {});
    const configBytes = textEncoder.encode(configJson);

    let playersSize = 1;
    for (const p of msg.players) {
        playersSize += 2 + textEncoder.encode(p.id).length + 2 + textEncoder.encode(p.name || '').length;
    }

    const buffer = new Uint8Array(1 + 2 + playerIdBytes.length + 2 + roomIdBytes.length + 2 + 1 + playersSize + 2 + configBytes.length);
    const view = new DataView(buffer.buffer);

    let offset = 0;
    view.setUint8(offset++, MessageType.JoinAccept);
    offset += writeString(view, offset, msg.playerId);
    offset += writeString(view, offset, msg.roomId);
    view.setUint16(offset, msg.config.tickRate);
    offset += 2;
    view.setUint8(offset++, msg.config.maxPlayers);
    view.setUint8(offset++, msg.players.length);

    for (const p of msg.players) {
        offset += writeString(view, offset, p.id);
        offset += writeString(view, offset, p.name || '');
    }

    offset += writeString(view, offset, configJson);

    return buffer;
}

function decodeJoinAcceptMessage(view, limits) {
    const msgType = MessageType.JoinAccept;
    let offset = 1;
    const [playerId, playerIdLen] = readString(view, offset, msgType, limits.maxStringLength);
    offset += playerIdLen;
    const [roomId, roomIdLen] = readString(view, offset, msgType, limits.maxStringLength);
    offset += roomIdLen;
    ensureBytes(view, offset, 2, msgType);
    const tickRate = view.getUint16(offset);
    offset += 2;
    ensureBytes(view, offset, 2, msgType);
    const maxPlayers = view.getUint8(offset++);
    const playerCount = view.getUint8(offset++);

    if (playerCount > limits.maxPlayerCount) {
        throw new DecodeError(`Player count exceeds maximum of ${limits.maxPlayerCount}`, msgType, offset - 1, limits.maxPlayerCount, playerCount);
    }

    const players = [];
    for (let i = 0; i < playerCount; i++) {
        const [id, pLen] = readString(view, offset, msgType, limits.maxStringLength);
        offset += pLen;
        const [name, nLen] = readString(view, offset, msgType, limits.maxStringLength);
        offset += nLen;
        players.push({ id, name });
    }

    let extraConfig = {};
    if (offset < view.byteLength) {
        const [configJson] = readString(view, offset, msgType, limits.maxStringLength * 4);
        try {
            const parsed = JSON.parse(configJson);
            if (parsed && typeof parsed === 'object') {
                extraConfig = parsed;
            }
        } catch {
            extraConfig = {};
        }
    }

    return { type: MessageType.JoinAccept, playerId, roomId, config: { tickRate, maxPlayers, ...extraConfig }, players };
}

function encodeJoinRejectMessage(msg) {
    const playerIdBytes = textEncoder.encode(msg.playerId);
    const reasonBytes = textEncoder.encode(msg.reason);
    const buffer = new Uint8Array(1 + 2 + playerIdBytes.length + 2 + reasonBytes.length);
    const view = new DataView(buffer.buffer);

    let offset = 0;
    view.setUint8(offset++, MessageType.JoinReject);
    offset += writeString(view, offset, msg.playerId);
    writeString(view, offset, msg.reason);

    return buffer;
}

function decodeJoinRejectMessage(view, limits) {
    const msgType = MessageType.JoinReject;
    let offset = 1;
    const [playerId, playerIdLen] = readString(view, offset, msgType, limits.maxStringLength);
    offset += playerIdLen;
    const [reason] = readString(view, offset, msgType, limits.maxStringLength);

    return { type: MessageType.JoinReject, playerId, reason };
}

function encodeStateSyncMessage(msg) {
    let timelineSize = 2;
    for (const entry of msg.playerTimeline) {
        const idBytes = textEncoder.encode(entry.playerId);
        const nameBytes = textEncoder.encode(entry.name || '');
        timelineSize += 2 + idBytes.length + 2 + nameBytes.length + 4 + 1 + (entry.leaveTick !== null ? 4 : 0);
    }

    const buffer = new Uint8Array(1 + 4 + 4 + 4 + msg.state.length + timelineSize);
    const view = new DataView(buffer.buffer);

    let offset = 0;
    view.setUint8(offset++, MessageType.StateSync);
    view.setInt32(offset, msg.tick);
    offset += 4;
    view.setUint32(offset, msg.hash);
    offset += 4;
    offset += writeBytes(view, offset, msg.state);

    view.setUint16(offset, msg.playerTimeline.length);
    offset += 2;
    for (const entry of msg.playerTimeline) {
        offset += writeString(view, offset, entry.playerId);
        offset += writeString(view, offset, entry.name || '');
        view.setInt32(offset, entry.joinTick);
        offset += 4;
        if (entry.leaveTick !== null) {
            view.setUint8(offset++, 1);
            view.setInt32(offset, entry.leaveTick);
            offset += 4;
        } else {
            view.setUint8(offset++, 0);
        }
    }

    return buffer;
}

function decodeStateSyncMessage(view, limits) {
    const msgType = MessageType.StateSync;
    let offset = 1;
    ensureBytes(view, offset, 4, msgType);
    const tick = view.getInt32(offset);
    offset += 4;
    ensureBytes(view, offset, 4, msgType);
    const hash = view.getUint32(offset);
    offset += 4;
    const [state, stateLen] = readBytes(view, offset, msgType, limits.maxStateSize);
    offset += stateLen;

    ensureBytes(view, offset, 2, msgType);
    const playerCount = view.getUint16(offset);
    offset += 2;

    if (playerCount > limits.maxPlayerCount) {
        throw new DecodeError(`Player count exceeds maximum of ${limits.maxPlayerCount}`, msgType, offset - 2, limits.maxPlayerCount, playerCount);
    }

    const playerTimeline = [];
    for (let i = 0; i < playerCount; i++) {
        const [playerId, idLen] = readString(view, offset, msgType, limits.maxStringLength);
        offset += idLen;
        const [name, nameLen] = readString(view, offset, msgType, limits.maxStringLength);
        offset += nameLen;
        ensureBytes(view, offset, 4, msgType);
        const joinTick = view.getInt32(offset);
        offset += 4;
        ensureBytes(view, offset, 1, msgType);
        const hasLeaveTick = view.getUint8(offset++) === 1;
        if (hasLeaveTick) ensureBytes(view, offset, 4, msgType);
        const leaveTick = hasLeaveTick ? view.getInt32(offset) : null;
        if (hasLeaveTick) offset += 4;

        playerTimeline.push({ playerId, name, joinTick, leaveTick });
    }

    return { type: MessageType.StateSync, tick, state, hash, playerTimeline };
}

function encodePlayerJoinedMessage(msg) {
    const playerIdBytes = textEncoder.encode(msg.playerId);
    const nameBytes = textEncoder.encode(msg.name || '');
    const buffer = new Uint8Array(1 + 2 + playerIdBytes.length + 4 + 1 + 2 + nameBytes.length);
    const view = new DataView(buffer.buffer);

    let offset = 0;
    view.setUint8(offset++, MessageType.PlayerJoined);
    offset += writeString(view, offset, msg.playerId);
    view.setInt32(offset, msg.joinTick);
    offset += 4;
    view.setUint8(offset++, msg.role);
    offset += writeString(view, offset, msg.name || '');

    return buffer;
}

function decodePlayerJoinedMessage(view, limits) {
    const msgType = MessageType.PlayerJoined;
    let offset = 1;
    const [playerId, playerIdLen] = readString(view, offset, msgType, limits.maxStringLength);
    offset += playerIdLen;
    ensureBytes(view, offset, 5, msgType);
    const joinTick = view.getInt32(offset);
    offset += 4;
    const role = view.getUint8(offset++);

    let name = undefined;
    if (view.byteLength > offset) {
        const [n, nLen] = readString(view, offset, msgType, limits.maxStringLength);
        name = n;
        offset += nLen;
    }

    return { type: MessageType.PlayerJoined, playerId, joinTick, role, name };
}

function encodePlayerLeftMessage(msg) {
    const playerIdBytes = textEncoder.encode(msg.playerId);
    const buffer = new Uint8Array(1 + 2 + playerIdBytes.length + 4);
    const view = new DataView(buffer.buffer);

    let offset = 0;
    view.setUint8(offset++, MessageType.PlayerLeft);
    offset += writeString(view, offset, msg.playerId);
    view.setInt32(offset, msg.leaveTick);

    return buffer;
}

function decodePlayerLeftMessage(view, limits) {
    const msgType = MessageType.PlayerLeft;
    let offset = 1;
    const [playerId, playerIdLen] = readString(view, offset, msgType, limits.maxStringLength);
    offset += playerIdLen;
    ensureBytes(view, offset, 4, msgType);
    const leaveTick = view.getInt32(offset);

    return { type: MessageType.PlayerLeft, playerId, leaveTick };
}

function encodePingMessage(msg) {
    const buffer = new Uint8Array(1 + 8);
    const view = new DataView(buffer.buffer);
    view.setUint8(0, MessageType.Ping);
    view.setBigUint64(1, BigInt(msg.timestamp));
    return buffer;
}

function decodePingMessage(view) {
    const msgType = MessageType.Ping;
    ensureBytes(view, 1, 8, msgType);
    const timestamp = Number(view.getBigUint64(1));
    return { type: MessageType.Ping, timestamp };
}

function encodePongMessage(msg) {
    const buffer = new Uint8Array(1 + 8);
    const view = new DataView(buffer.buffer);
    view.setUint8(0, MessageType.Pong);
    view.setBigUint64(1, BigInt(msg.timestamp));
    return buffer;
}

function decodePongMessage(view) {
    const msgType = MessageType.Pong;
    ensureBytes(view, 1, 8, msgType);
    const timestamp = Number(view.getBigUint64(1));
    return { type: MessageType.Pong, timestamp };
}

function encodeLagReportMessage(msg) {
    const playerIdBytes = textEncoder.encode(msg.laggyPlayerId);
    const buffer = new Uint8Array(1 + 2 + playerIdBytes.length + 4);
    const view = new DataView(buffer.buffer);

    let offset = 0;
    view.setUint8(offset++, MessageType.LagReport);
    offset += writeString(view, offset, msg.laggyPlayerId);
    view.setInt32(offset, msg.ticksBehind);

    return buffer;
}

function decodeLagReportMessage(view, limits) {
    const msgType = MessageType.LagReport;
    let offset = 1;
    const [laggyPlayerId, playerIdLen] = readString(view, offset, msgType, limits.maxStringLength);
    offset += playerIdLen;
    ensureBytes(view, offset, 4, msgType);
    const ticksBehind = view.getInt32(offset);

    return { type: MessageType.LagReport, laggyPlayerId, ticksBehind };
}

function encodeDisconnectReportMessage(msg) {
    const playerIdBytes = textEncoder.encode(msg.disconnectedPeerId);
    const buffer = new Uint8Array(1 + 2 + playerIdBytes.length);
    const view = new DataView(buffer.buffer);

    let offset = 0;
    view.setUint8(offset++, MessageType.DisconnectReport);
    writeString(view, offset, msg.disconnectedPeerId);

    return buffer;
}

function decodeDisconnectReportMessage(view, limits) {
    const msgType = MessageType.DisconnectReport;
    const [disconnectedPeerId] = readString(view, 1, msgType, limits.maxStringLength);

    return { type: MessageType.DisconnectReport, disconnectedPeerId };
}

function encodeResumeCountdownMessage(msg) {
    const buffer = new Uint8Array(1 + 2);
    const view = new DataView(buffer.buffer);
    view.setUint8(0, MessageType.ResumeCountdown);
    view.setUint16(1, msg.secondsRemaining);
    return buffer;
}

function decodeResumeCountdownMessage(view) {
    const msgType = MessageType.ResumeCountdown;
    ensureBytes(view, 1, 2, msgType);
    const secondsRemaining = view.getUint16(1);
    return { type: MessageType.ResumeCountdown, secondsRemaining };
}

function encodeDropPlayerMessage(msg) {
    const playerIdBytes = textEncoder.encode(msg.playerId);
    const hasMetadata = msg.metadata !== undefined;
    const metadataSize = hasMetadata && msg.metadata ? 4 + msg.metadata.length : 0;
    const buffer = new Uint8Array(1 + 2 + playerIdBytes.length + 1 + metadataSize);
    const view = new DataView(buffer.buffer);

    let offset = 0;
    view.setUint8(offset++, MessageType.DropPlayer);
    offset += writeString(view, offset, msg.playerId);
    view.setUint8(offset++, hasMetadata ? 1 : 0);
    if (hasMetadata && msg.metadata) {
        writeBytes(view, offset, msg.metadata);
    }

    return buffer;
}

function decodeDropPlayerMessage(view, limits) {
    const msgType = MessageType.DropPlayer;
    let offset = 1;
    const [playerId, playerIdLen] = readString(view, offset, msgType, limits.maxStringLength);
    offset += playerIdLen;
    ensureBytes(view, offset, 1, msgType);
    const hasMetadata = view.getUint8(offset++) === 1;

    const result = { type: MessageType.DropPlayer, playerId };
    if (hasMetadata) {
        const [data] = readBytes(view, offset, msgType, limits.maxStateSize);
        result.metadata = data;
    }
    return result;
}

export { isReliableMessage };
