import { asTick } from './types.js';

function inputsEqual(a, b) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) return false;
    }
    return true;
}

export class InputBuffer {
    constructor() {
        this.players = new Map();
        this.joinsByTick = new Map();
        this.leavesByTick = new Map();
    }

    addPlayer(playerId, joinTick) {
        const existing = this.players.get(playerId);
        if (existing) {
            if (existing.leaveTick !== null) {
                this.removeFromTickIndex(this.joinsByTick, existing.joinTick, playerId);
                this.removeFromTickIndex(this.leavesByTick, existing.leaveTick, playerId);

                existing.joinTick = joinTick;
                existing.leaveTick = null;
                existing.confirmedTick = asTick(joinTick - 1);
                existing.received.clear();
                existing.usedInputs.clear();

                this.addToTickIndex(this.joinsByTick, joinTick, playerId);
            }
            return;
        }

        this.players.set(playerId, {
            joinTick,
            leaveTick: null,
            received: new Map(),
            confirmedTick: asTick(joinTick - 1),
            usedInputs: new Map(),
        });

        this.addToTickIndex(this.joinsByTick, joinTick, playerId);
    }

    removePlayer(playerId, leaveTick) {
        const player = this.players.get(playerId);
        if (player) {
            if (player.leaveTick !== null) {
                this.removeFromTickIndex(this.leavesByTick, player.leaveTick, playerId);
            }
            player.leaveTick = leaveTick;
            this.addToTickIndex(this.leavesByTick, leaveTick, playerId);
        }
    }

    setConfirmedTickForSync(tick) {
        if (tick <= 0) return;
        const confirmedTick = asTick(tick - 1);
        for (const player of this.players.values()) {
            if (player.leaveTick === null || player.leaveTick > tick) {
                if (player.confirmedTick < confirmedTick) {
                    player.confirmedTick = confirmedTick;
                }
            }
        }
    }

    isPlayerActive(playerId, tick) {
        const player = this.players.get(playerId);
        if (!player) return false;
        if (tick < player.joinTick) return false;
        if (player.leaveTick !== null && tick >= player.leaveTick) return false;
        return true;
    }

    getActivePlayers(tick) {
        const active = [];
        for (const [playerId] of this.players) {
            if (this.isPlayerActive(playerId, tick)) {
                active.push(playerId);
            }
        }
        return active;
    }

    getAllPlayers() {
        return Array.from(this.players.keys());
    }

    receiveInput(playerId, tick, input) {
        const player = this.players.get(playerId);
        if (!player) return;
        if (tick < player.joinTick) return;
        if (player.leaveTick !== null && tick >= player.leaveTick) return;

        const inputCopy = new Uint8Array(input.length);
        inputCopy.set(input);
        player.received.set(tick, inputCopy);
        this.updateConfirmedTick(player);
    }

    updateConfirmedTick(player) {
        let tick = player.confirmedTick + 1;
        while (player.received.has(asTick(tick))) {
            tick++;
        }
        player.confirmedTick = asTick(tick - 1);
    }

    getInput(playerId, tick) {
        const player = this.players.get(playerId);
        if (!player) return undefined;
        return player.received.get(tick);
    }

    getConfirmedTick(playerId) {
        const player = this.players.get(playerId);
        if (!player) return undefined;
        return player.confirmedTick;
    }

    getJoinTick(playerId) {
        return this.players.get(playerId)?.joinTick;
    }

    getLeaveTick(playerId) {
        return this.players.get(playerId)?.leaveTick;
    }

    recordUsedInput(playerId, tick, input) {
        const player = this.players.get(playerId);
        if (!player) return;

        const inputCopy = new Uint8Array(input.length);
        inputCopy.set(input);
        player.usedInputs.set(tick, inputCopy);
    }

    getUsedInput(playerId, tick) {
        return this.players.get(playerId)?.usedInputs.get(tick);
    }

    findMisprediction(playerId, fromTick) {
        const player = this.players.get(playerId);
        if (!player) return undefined;

        for (let tick = fromTick; tick <= player.confirmedTick; tick++) {
            const received = player.received.get(asTick(tick));
            const used = player.usedInputs.get(asTick(tick));

            if (received !== undefined && used !== undefined) {
                if (!inputsEqual(received, used)) {
                    return asTick(tick);
                }
            }
        }

        return undefined;
    }

    getLastConfirmedInput(playerId) {
        const player = this.players.get(playerId);
        if (!player) return undefined;

        if (player.confirmedTick >= player.joinTick) {
            return player.received.get(player.confirmedTick);
        }
        return undefined;
    }

    getLastReceivedInput(playerId, upToTick) {
        const player = this.players.get(playerId);
        if (!player) return undefined;

        let bestTick = undefined;
        let bestInput = undefined;

        for (const [tick, input] of player.received) {
            if (tick > upToTick) continue;
            if (bestTick === undefined || tick > bestTick) {
                bestTick = tick;
                bestInput = input;
            }
        }

        return bestInput;
    }

    pruneBeforeTick(tick) {
        for (const player of this.players.values()) {
            for (const t of player.received.keys()) {
                if (t < tick) player.received.delete(t);
            }
            for (const t of player.usedInputs.keys()) {
                if (t < tick) player.usedInputs.delete(t);
            }
        }
    }

    clearUsedInputsFrom(playerId, fromTick) {
        const player = this.players.get(playerId);
        if (!player) return;

        for (const tick of player.usedInputs.keys()) {
            if (tick >= fromTick) player.usedInputs.delete(tick);
        }
    }

    clearAllUsedInputsFrom(fromTick) {
        for (const playerId of this.players.keys()) {
            this.clearUsedInputsFrom(playerId, fromTick);
        }
    }

    getMinConfirmedTick(tick) {
        let minTick = undefined;

        for (const [playerId, player] of this.players) {
            if (this.isPlayerActive(playerId, tick)) {
                if (minTick === undefined || player.confirmedTick < minTick) {
                    minTick = player.confirmedTick;
                }
            }
        }

        return minTick;
    }

    hasAllInputsForTick(tick) {
        for (const [playerId] of this.players) {
            if (this.isPlayerActive(playerId, tick)) {
                if (!this.getInput(playerId, tick)) return false;
            }
        }
        return true;
    }

    clearPlayer(playerId) {
        const player = this.players.get(playerId);
        if (player) {
            this.removeFromTickIndex(this.joinsByTick, player.joinTick, playerId);
            if (player.leaveTick !== null) {
                this.removeFromTickIndex(this.leavesByTick, player.leaveTick, playerId);
            }
        }
        this.players.delete(playerId);
    }

    clear() {
        this.players.clear();
        this.joinsByTick.clear();
        this.leavesByTick.clear();
    }

    getPlayersJoiningAtTick(tick) {
        const players = this.joinsByTick.get(tick);
        return players ? Array.from(players) : [];
    }

    getPlayersLeavingAtTick(tick) {
        const players = this.leavesByTick.get(tick);
        return players ? Array.from(players) : [];
    }

    addToTickIndex(index, tick, playerId) {
        let players = index.get(tick);
        if (!players) {
            players = new Set();
            index.set(tick, players);
        }
        players.add(playerId);
    }

    removeFromTickIndex(index, tick, playerId) {
        const players = index.get(tick);
        if (players) {
            players.delete(playerId);
            if (players.size === 0) index.delete(tick);
        }
    }
}
