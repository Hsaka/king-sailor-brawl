# Networking Checklist for New Gameplay Features

This game uses rollback peer simulation, not a host-authoritative action model.
Every player simulates the same match locally, exchanges inputs, and rewinds/resimulates when late inputs arrive.

That means a feature is "network-safe" only if every peer:

1. receives the same inputs
2. runs the same simulation logic
3. mutates the same authoritative state
4. serializes that state into the same bytes

If any one of those rules is broken, the feature will eventually desync.

## Current Netcode Model

- `scenes/GameScene.js` collects local input and packs it into a 3-byte input word.
- `netcode/session.js` schedules delayed local input, receives remote input, runs rollback, and handles sync/desync recovery.
- `netcode/engine.js` drives the rollback engine and stores snapshots/hashes.
- `game/WorldState.js` is the authoritative gameplay simulation.
- `game/Ship.js` is used by the simulation for movement math, but its render particles are cosmetic only.

For gameplay purposes, the contract is:

- `WorldState.step(inputs)` is the only place gameplay should advance.
- `WorldState.serialize()` and `WorldState.deserialize()` define the full authoritative state.
- `WorldState.hash()` is used for desync detection and currently hashes the serialized bytes.

## Non-Negotiable Rules

### 1. Gameplay state must live in `WorldState`

If a new feature affects match outcome, it must be stored in `WorldState`.

Examples:

- shrinking border radius/state
- hazard positions and timers
- powerup spawn state
- active buffs/debuffs
- projectile lifetime and ownership
- score, elimination, respawn, or pickup state

Do not keep gameplay-affecting state only in:

- `GameScene`
- UI classes
- render smoothing state
- audio systems
- DOM state
- transport/session metadata

### 2. All gameplay-affecting state must be serialized

If a value changes gameplay, it must round-trip through:

- `WorldState.serialize()`
- `WorldState.deserialize()`

If it is not serialized, sync will not restore it correctly and hash checks will not protect it.

Because `WorldState.hash()` now hashes serialized bytes, anything serialized is automatically part of desync detection.

### 3. Advance time in ticks, not wall-clock time

Gameplay must use deterministic tick progression.

Use:

- `dt = 1 / CONFIG.NETCODE.TICK_RATE`
- tick counters
- `startTick`
- `durationTicks`

Do not use:

- `Date.now()`
- `performance.now()`
- animation time
- frame count outside the simulation
- browser timers for gameplay state

### 4. Use deterministic randomness only

For authoritative randomness, use `WorldState.rand()`.

Do not use `Math.random()` inside gameplay state updates.

`Math.random()` is acceptable only for cosmetic-only effects that do not affect the serialized match state.

Examples:

- good: powerup spawn location chosen inside `WorldState` via `rand()`
- bad: hazard targeting chosen in `GameScene` via `Math.random()`
- good: explosion particle spread in rendering
- bad: projectile scatter that affects damage

### 5. Process entities in a stable order

Whenever order matters, use deterministic ordering.

Good patterns:

- sorted player ids
- stable arrays
- explicit entity ids
- fixed collision resolution order

Bad patterns:

- iterating plain object keys with implicit ordering assumptions
- relying on insertion order when peers may build collections differently
- "first thing found wins" without deterministic ordering

### 6. Keep `step()` side-effect free

Rollback will replay `WorldState.step()` many times.

That means `step()` must not directly do:

- DOM updates
- audio playback
- console-driven logic
- network sends
- localStorage writes
- analytics events

Those belong in render/UI/session layers, driven by authoritative state changes after simulation.

### 7. New numeric state must respect snapshot precision

The authoritative state is serialized with `Float32` values.
The simulation now quantizes important state in `WorldState.quantizeState()` to avoid rollback drift.

If you add new floating-point gameplay fields, ensure they are:

- serialized/deserialized
- quantized if they remain live in memory between snapshots
- compared/updated deterministically

Examples:

- hazard radius
- zone center
- projectile velocity
- status effect timers
- moving platform positions

If you add a new float field and forget to include it in `quantizeState()`, rollback may converge visually but not byte-for-byte.

### 8. Inputs are a protocol, not just local controls

The current player input packet is 3 bytes (`CONFIG.NETCODE.INPUT_BYTES = 3`).
Current usage consumes bits 0-19, leaving only bits 20-23 unused.

If a new feature needs new player actions:

1. update input packing in `GameScene.updateLocalInput()`
2. update simulation decoding in `WorldState.step()`
3. increase `CONFIG.NETCODE.INPUT_BYTES` if needed
4. ensure session config and engine input sizing still match
5. add/adjust tests

Do not smuggle authoritative gameplay through ad hoc custom transport messages during a match.

### 9. Sync/join must produce a complete match state

A late join or sync request must reconstruct the full authoritative world.

Ask:

- If a peer syncs mid-match, does it receive enough data to rebuild this feature?
- If a player joins or reconnects, will the feature exist with the right timers and ownership?
- If the host forces sync, will the feature continue cleanly from the restored state?

If the answer depends on "local scene state" or "things that happened earlier", the feature is not network-safe yet.

## Feature Design Checklist

Before implementing a feature, answer all of these:

- What exact data is authoritative?
- Which of those values change match outcome?
- Where will those values live in `WorldState`?
- How are they serialized and deserialized?
- What determines their lifetime: tick, duration, owner, collision, pickup, or expiry?
- Does the feature need deterministic randomness?
- Does it need stable ids?
- Can rollback replay it from any previous snapshot and get the same result?
- Does sync/join reconstruct it fully?
- Does it add new player inputs?
- Does it require new telemetry or debug output?

## Feature-Specific Guidance

### Shrinking Border / Safe Zone

Recommended model:

- store border state in `WorldState`
- define it with tick-based parameters such as:
  - `phase`
  - `startTick`
  - `durationTicks`
  - `initialRadius`
  - `targetRadius`
  - `centerX`, `centerY`

Avoid:

- shrinking based on wall-clock time
- computing radius only in rendering
- using local easing timers not stored in state

Questions:

- Is border damage applied inside `WorldState.step()`?
- Is the border center/radius serialized?
- If the border moves between phases, is the phase transition deterministic?

### Powerups

Recommended model:

- treat each powerup as an authoritative entity with a stable id
- serialize:
  - spawn state
  - position
  - type
  - active/collected state
  - owner if applicable
  - expiry tick if applicable

Avoid:

- client-only spawn effects that decide gameplay
- pickup resolution based on local arrival order without deterministic tie-breaking
- buff timers based on wall-clock time

Questions:

- If two players overlap the same pickup on the same tick, who wins and why?
- Is that tie-break deterministic on every peer?
- Can a sync restore active buffs correctly?

### Stage Hazards

Recommended model:

- hazards are authoritative world entities or deterministic scripted state
- serialize all hazard parameters that affect gameplay
- resolve hazard damage/effects in `WorldState.step()`

Avoid:

- hazards driven by render animation state
- "spawn when seen on screen" logic
- local-only timers

Questions:

- Are hazard activation windows tick-based?
- Is target selection deterministic?
- Are collisions/resolution ordered deterministically?

## Safe Separation: Gameplay vs Cosmetics

This is the line to maintain:

Gameplay-authoritative:

- health
- cooldowns
- knockback
- zone timers
- hazard state
- pickup ownership
- buff durations
- spawn tables

Cosmetic-only:

- camera smoothing
- particle systems
- screen shake
- HUD animations
- sound timing
- render interpolation

Cosmetic systems may read authoritative state, but they must never become the source of truth for gameplay.

## Code Review Checklist

When reviewing a networking-sensitive gameplay PR, check:

- Does the feature mutate only authoritative sim state?
- Is every gameplay field serialized/deserialized?
- Is randomness deterministic?
- Is iteration order deterministic?
- Is time tick-based?
- Can rollback replay the feature without side effects?
- Does sync reconstruct the feature?
- If new floats were added, are they quantized appropriately?
- If inputs changed, was the input protocol updated everywhere?
- Were determinism tests added or updated?

## Testing Workflow

Minimum expectation before merging a new gameplay feature:

1. Run the deterministic test harness:

```bash
node --experimental-default-type=module --test tests/netcode-determinism.test.mjs
```

2. If the feature introduces new authoritative state, add a targeted test for it.

Examples:

- border shrink progression remains byte-identical across peers
- powerup pickup tie-breaks deterministically
- hazard activation survives rollback
- sync after mid-match restore reproduces the same state

3. If the feature adds new inputs, test:

- normal play
- delayed remote inputs
- rollback convergence
- sync after desync request

## Warning Signs

These usually indicate a networking bug waiting to happen:

- "It only exists in the scene, not the world state"
- "The host decides and tells everyone later"
- "We only need it visually"
- "It uses `Math.random()` but should be close enough"
- "The timer is based on elapsed milliseconds"
- "The order should probably be the same"
- "We can patch it in on sync if needed"

In a rollback game, those are not minor shortcuts. They are desync sources.

## Practical Rule of Thumb

If removing the feature from `WorldState.serialize()` would change match outcome, the feature belongs fully inside the deterministic simulation contract.

If the feature cannot survive rollback, it is not ready to ship.
