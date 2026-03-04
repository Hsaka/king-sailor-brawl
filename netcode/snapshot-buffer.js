import { asTick } from './types.js';

export class SnapshotBuffer {
    constructor(capacity) {
        if (capacity <= 0) throw new Error('Capacity must be positive');
        this.capacity = capacity;
        this.buffer = new Array(capacity);
        this.tickToIndex = new Map();
        this.head = 0;
        this.count = 0;
        this._oldestTick = undefined;
        this._newestTick = undefined;
    }

    get size() {
        return this.count;
    }

    get oldestTick() {
        return this._oldestTick;
    }

    get newestTick() {
        return this._newestTick;
    }

    save(tick, state, hash) {
        const stateCopy = new Uint8Array(state.length);
        stateCopy.set(state);

        const snapshot = { tick, state: stateCopy, hash };

        const existingIdx = this.tickToIndex.get(tick);
        if (existingIdx !== undefined) {
            this.buffer[existingIdx] = snapshot;
            return;
        }

        if (this._newestTick !== undefined && tick < this._newestTick) {
            throw new Error(`SnapshotBuffer: tick ${tick} is out of order (newest: ${this._newestTick}).`);
        }

        if (this.count === this.capacity) {
            const oldSnapshot = this.buffer[this.head];
            if (oldSnapshot) {
                this.tickToIndex.delete(oldSnapshot.tick);
            }
            this.buffer[this.head] = snapshot;
            this.tickToIndex.set(tick, this.head);
            this.head = (this.head + 1) % this.capacity;
            const oldestSnapshot = this.buffer[this.head];
            this._oldestTick = oldestSnapshot?.tick;
        } else {
            const writePos = (this.head + this.count) % this.capacity;
            this.buffer[writePos] = snapshot;
            this.tickToIndex.set(tick, writePos);
            this.count++;
            if (this.count === 1) {
                this._oldestTick = tick;
            }
        }

        this._newestTick = tick;
    }

    get(tick) {
        const idx = this.tickToIndex.get(tick);
        if (idx === undefined) return undefined;
        return this.buffer[idx];
    }

    getOldest() {
        if (this.count === 0) return undefined;
        return this.buffer[this.head];
    }

    getNewest() {
        if (this.count === 0) return undefined;
        const newestIdx = (this.head + this.count - 1) % this.capacity;
        return this.buffer[newestIdx];
    }

    clear() {
        this.buffer.fill(undefined);
        this.tickToIndex.clear();
        this.head = 0;
        this.count = 0;
        this._oldestTick = undefined;
        this._newestTick = undefined;
    }

    getAtOrBefore(tick) {
        if (this.count === 0) return undefined;

        let lo = 0;
        let hi = this.count - 1;
        let result = undefined;

        while (lo <= hi) {
            const mid = (lo + hi) >>> 1;
            const idx = (this.head + mid) % this.capacity;
            const snapshot = this.buffer[idx];

            if (snapshot && snapshot.tick <= tick) {
                result = snapshot;
                lo = mid + 1;
            } else {
                hi = mid - 1;
            }
        }

        return result;
    }

    pruneBeforeTick(tick) {
        while (this.count > 0) {
            const oldest = this.buffer[this.head];
            if (oldest && oldest.tick < tick) {
                this.tickToIndex.delete(oldest.tick);
                this.buffer[this.head] = undefined;
                this.head = (this.head + 1) % this.capacity;
                this.count--;
                if (this.count === 0) {
                    this._oldestTick = undefined;
                    this._newestTick = undefined;
                } else {
                    this._oldestTick = this.buffer[this.head]?.tick;
                }
            } else {
                break;
            }
        }
    }

    has(tick) {
        return this.get(tick) !== undefined;
    }

    getTicks() {
        const ticks = [];
        for (let i = 0; i < this.count; i++) {
            const idx = (this.head + i) % this.capacity;
            const snapshot = this.buffer[idx];
            if (snapshot) ticks.push(snapshot.tick);
        }
        return ticks;
    }
}
