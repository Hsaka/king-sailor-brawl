import { asTick, DEFAULT_INPUT_PREDICTOR, GameError, RollbackError } from './types.js';
import { InputBuffer } from './input-buffer.js';
import { SnapshotBuffer } from './snapshot-buffer.js';

export class RollbackEngine {
    constructor(config) {
        this.game = config.game;
        this.localPlayerId = config.localPlayerId;
        this.maxSpeculationTicks = config.maxSpeculationTicks ?? 60;
        this.pruneBufferTicks = config.pruneBufferTicks ?? 10;
        this.inputPredictor = config.inputPredictor ?? DEFAULT_INPUT_PREDICTOR;
        this.inputSizeBytes = config.inputSizeBytes ?? 0;
        this.onPlayerAddDuringResimulation = config.onPlayerAddDuringResimulation;
        this.onPlayerRemoveDuringResimulation = config.onPlayerRemoveDuringResimulation;
        this.onRollback = config.onRollback;

        this.snapshotBuffer = new SnapshotBuffer(config.snapshotHistorySize ?? 120);
        this.inputBuffer = new InputBuffer();

        this._currentTick = asTick(0);
        this._confirmedTick = asTick(-1);
        this.localInputs = new Map();

        this.inputBuffer.addPlayer(this.localPlayerId, asTick(0));
    }

    get currentTick() {
        return this._currentTick;
    }

    get confirmedTick() {
        return this._confirmedTick;
    }

    addPlayer(playerId, joinTick) {
        this.inputBuffer.addPlayer(playerId, joinTick);
    }

    removePlayer(playerId, leaveTick) {
        this.inputBuffer.removePlayer(playerId, leaveTick);
    }

    getConfirmedTickForPlayer(playerId) {
        return this.inputBuffer.getConfirmedTick(playerId);
    }

    setLocalInput(tick, input) {
        const inputCopy = this.cloneNormalizedInput(input);
        this.localInputs.set(tick, inputCopy);
        this.inputBuffer.receiveInput(this.localPlayerId, tick, inputCopy);
    }

    receiveRemoteInput(playerId, tick, input) {
        this.inputBuffer.receiveInput(playerId, tick, this.cloneNormalizedInput(input));
    }

    getLocalInput(tick) {
        return this.localInputs.get(tick);
    }

    saveInitialSnapshot() {
        if (!this.snapshotBuffer.has(asTick(-1))) {
            const tick = asTick(-1);
            const state = this.gameSerialize(tick);
            const hash = this.gameHash(tick);
            this.snapshotBuffer.save(tick, state, hash);
        }
    }

    tick() {
        if (this._currentTick === 0) {
            this.saveInitialSnapshot();
        }

        const minConfirmed = this.inputBuffer.getMinConfirmedTick(this._currentTick);
        if (minConfirmed !== undefined) {
            const speculation = this._currentTick - minConfirmed;
            if (speculation >= this.maxSpeculationTicks) {
                return { tick: this._currentTick, rolledBack: false };
            }
        }

        const rollbackResult = this.checkAndRollback();
        const inputs = this.gatherInputs(this._currentTick);
        this.gameStep(this._currentTick, inputs);

        const state = this.gameSerialize(this._currentTick);
        const hash = this.gameHash(this._currentTick);
        this.snapshotBuffer.save(this._currentTick, state, hash);

        this.updateConfirmedTick();

        const tickResult = this._currentTick;
        this._currentTick = asTick(this._currentTick + 1);

        const result = { tick: tickResult, rolledBack: rollbackResult.rolledBack };
        if (rollbackResult.rollbackTicks !== undefined) {
            result.rollbackTicks = rollbackResult.rollbackTicks;
        }
        if (rollbackResult.error !== undefined) {
            result.error = rollbackResult.error;
        }
        return result;
    }

    checkAndRollback() {
        let earliestMisprediction = undefined;

        const activePlayers = this.inputBuffer.getActivePlayers(this._currentTick);
        for (const playerId of activePlayers) {
            if (playerId === this.localPlayerId) continue;

            const mispredictTick = this.inputBuffer.findMisprediction(
                playerId,
                this._confirmedTick >= 0 ? asTick(this._confirmedTick + 1) : asTick(0)
            );

            if (mispredictTick !== undefined) {
                if (earliestMisprediction === undefined || mispredictTick < earliestMisprediction) {
                    earliestMisprediction = mispredictTick;
                }
            }
        }

        if (earliestMisprediction === undefined) {
            return { rolledBack: false };
        }

        const restoreTick = asTick(earliestMisprediction - 1);
        let snapshot = this.snapshotBuffer.get(restoreTick);
        let actualRestoreTick = restoreTick;

        if (!snapshot) {
            snapshot = this.snapshotBuffer.getAtOrBefore(restoreTick);
            if (!snapshot) {
                return {
                    rolledBack: false,
                    error: new RollbackError(
                        `Cannot rollback to tick ${restoreTick}: no snapshots available`,
                        restoreTick
                    ),
                };
            }
            actualRestoreTick = snapshot.tick;
        }

        const resimulateFromTick = asTick(actualRestoreTick + 1);
        const ticksToResimulate = this._currentTick - resimulateFromTick;

        this.gameDeserialize(actualRestoreTick, snapshot.state);
        this.onRollback?.(actualRestoreTick);
        this.inputBuffer.clearAllUsedInputsFrom(resimulateFromTick);

        for (let tick = resimulateFromTick; tick < this._currentTick; tick++) {
            const tickAsTick = asTick(tick);
            this.handlePlayerLifecycleAtTick(tickAsTick);

            const inputs = this.gatherInputs(tickAsTick);
            this.gameStep(tickAsTick, inputs);

            const state = this.gameSerialize(tickAsTick);
            const hash = this.gameHash(tickAsTick);
            this.snapshotBuffer.save(tickAsTick, state, hash);
        }

        return { rolledBack: true, rollbackTicks: ticksToResimulate };
    }

    handlePlayerLifecycleAtTick(tick) {
        if (this.onPlayerAddDuringResimulation) {
            const joiningPlayers = this.inputBuffer.getPlayersJoiningAtTick(tick);
            for (const playerId of joiningPlayers) {
                this.onPlayerAddDuringResimulation(playerId, tick);
            }
        }

        if (this.onPlayerRemoveDuringResimulation) {
            const leavingPlayers = this.inputBuffer.getPlayersLeavingAtTick(tick);
            for (const playerId of leavingPlayers) {
                this.onPlayerRemoveDuringResimulation(playerId, tick);
            }
        }
    }

    gatherInputs(tick) {
        const inputs = new Map();
        const activePlayers = this.inputBuffer.getActivePlayers(tick);

        for (const playerId of activePlayers) {
            let input;

            if (playerId === this.localPlayerId) {
                input = this.localInputs.get(tick) ?? this.createNeutralInput();
            } else {
                const received = this.inputBuffer.getInput(playerId, tick);
                if (received) {
                    input = received;
                } else {
                    const previousUsed = tick > 0 ? this.inputBuffer.getUsedInput(playerId, asTick(tick - 1)) : undefined;
                    const lastReceived = tick > 0 ? this.inputBuffer.getLastReceivedInput(playerId, asTick(tick - 1)) : undefined;
                    const lastInput = previousUsed ?? lastReceived ?? this.inputBuffer.getLastConfirmedInput(playerId);
                    const predicted = this.inputPredictor.predict(playerId, tick, lastInput);
                    input = this.cloneNormalizedInput(predicted ?? this.createNeutralInput());
                }
            }

            inputs.set(playerId, input);
            this.inputBuffer.recordUsedInput(playerId, tick, input);
        }

        return inputs;
    }

    updateConfirmedTick() {
        const minConfirmed = this.inputBuffer.getMinConfirmedTick(this._currentTick);
        if (minConfirmed !== undefined && minConfirmed > this._confirmedTick) {
            this._confirmedTick = minConfirmed;

            if (this._confirmedTick > this.pruneBufferTicks) {
                const pruneBelow = asTick(this._confirmedTick - this.pruneBufferTicks);
                this.inputBuffer.pruneBeforeTick(pruneBelow);
                this.snapshotBuffer.pruneBeforeTick(pruneBelow);

                for (const tick of this.localInputs.keys()) {
                    if (tick < pruneBelow) this.localInputs.delete(tick);
                }
            }
        }
    }

    getHash(tick) {
        return this.snapshotBuffer.get(tick)?.hash;
    }

    getCurrentHash() {
        const latestStateTick = asTick(this._currentTick - 1);
        return this.gameHash(latestStateTick);
    }

    getState() {
        const players = this.inputBuffer.getAllPlayers();
        const playerTimeline = [];

        for (const playerId of players) {
            const joinTick = this.inputBuffer.getJoinTick(playerId);
            const leaveTick = this.inputBuffer.getLeaveTick(playerId);

            if (joinTick !== undefined) {
                playerTimeline.push({ playerId, joinTick, leaveTick: leaveTick ?? null });
            }
        }

        return {
            tick: this._currentTick,
            state: this.gameSerialize(asTick(this._currentTick - 1)),
            playerTimeline,
        };
    }

    setState(tick, state, playerTimeline) {
        this.gameDeserialize(tick, state);

        this.snapshotBuffer.clear();
        this.inputBuffer.clear();
        this.localInputs.clear();

        for (const entry of playerTimeline) {
            this.inputBuffer.addPlayer(entry.playerId, entry.joinTick);
            if (entry.leaveTick !== null) {
                this.inputBuffer.removePlayer(entry.playerId, entry.leaveTick);
            }
        }

        this.inputBuffer.setConfirmedTickForSync(tick);

        const snapshotTick = asTick(tick - 1);
        const hash = this.gameHash(snapshotTick);
        this.snapshotBuffer.save(snapshotTick, state, hash);

        this._currentTick = tick;
        this._confirmedTick = asTick(tick - 1);
    }

    resetForSync(tick, playerTimeline) {
        this.snapshotBuffer.clear();
        this.inputBuffer.clear();
        this.localInputs.clear();

        for (const entry of playerTimeline) {
            this.inputBuffer.addPlayer(entry.playerId, entry.joinTick);
            if (entry.leaveTick !== null) {
                this.inputBuffer.removePlayer(entry.playerId, entry.leaveTick);
            }
        }

        this.inputBuffer.setConfirmedTickForSync(tick);

        const snapshotTick = asTick(tick - 1);
        const state = this.gameSerialize(snapshotTick);
        const hash = this.gameHash(snapshotTick);
        this.snapshotBuffer.save(snapshotTick, state, hash);

        this._currentTick = tick;
        this._confirmedTick = asTick(tick - 1);
    }

    hasAllInputsForTick(tick) {
        return this.inputBuffer.hasAllInputsForTick(tick);
    }

    getActivePlayers() {
        return this.inputBuffer.getActivePlayers(this._currentTick);
    }

    getAllPlayers() {
        return this.inputBuffer.getAllPlayers();
    }

    reset() {
        this.snapshotBuffer.clear();
        this.inputBuffer.clear();
        this.localInputs.clear();
        this._currentTick = asTick(0);
        this._confirmedTick = asTick(-1);
        this.inputBuffer.addPlayer(this.localPlayerId, asTick(0));
    }

    wrapGameOperation(operation, tick, fn) {
        try {
            return fn();
        } catch (error) {
            throw new GameError(operation, tick, error instanceof Error ? error : new Error(String(error)));
        }
    }

    gameStep(tick, inputs) {
        this.wrapGameOperation('step', tick, () => this.game.step(inputs));
    }

    gameSerialize(tick) {
        return this.wrapGameOperation('serialize', tick, () => this.game.serialize());
    }

    gameDeserialize(tick, state) {
        this.wrapGameOperation('deserialize', tick, () => this.game.deserialize(state));
    }

    gameHash(tick) {
        return this.wrapGameOperation('hash', tick, () => this.game.hash());
    }

    createNeutralInput() {
        return new Uint8Array(Math.max(0, this.inputSizeBytes));
    }

    cloneNormalizedInput(input) {
        const src = input instanceof Uint8Array ? input : new Uint8Array(input ?? []);
        if (this.inputSizeBytes > 0) {
            const normalized = new Uint8Array(this.inputSizeBytes);
            normalized.set(src.subarray(0, this.inputSizeBytes));
            return normalized;
        }
        const copy = new Uint8Array(src.length);
        copy.set(src);
        return copy;
    }
}
