# Sky Armada — Game Design Specification

> **Version:** 0.1 — Draft  
> **Engine:** LittleJS (ES module build) via the LittleJS template  
> **Target:** Desktop and mobile browsers, 2–4 players, peer-to-peer multiplayer via PeerJS with rollback netcode

---

## Table of Contents

1. [Overview](#1-overview)
2. [Configuration Philosophy](#2-configuration-philosophy)
3. [Movement Model](#3-movement-model)
4. [Combat System](#4-combat-system)
5. [Debris & Collision System](#5-debris--collision-system)
6. [Airship Roster](#6-airship-roster)
7. [Maps](#7-maps)
8. [Game Flow & Session Structure](#8-game-flow--session-structure)
9. [HUD & UI](#9-hud--ui)
10. [Controls — Desktop](#10-controls--desktop)
11. [Controls — Mobile](#11-controls--mobile)
12. [Networking Architecture](#12-networking-architecture)
13. [Audio](#13-audio)
14. [File Structure](#14-file-structure)
15. [Config Reference](#15-config-reference)

---

## 1. Overview

**Sky Armada** is a top-down 2D aerial battler for 2–4 players. Players pilot airships across a bounded sky map, using momentum-based flight, zone-based attacks, and persistent debris to eliminate all opponents. The last airship flying wins. Sessions are designed to last approximately 5 minutes.

### Core Design Pillars

- **Momentum matters.** Ships are always moving. Positioning, speed management, and arc control are the primary skills.
- **The map gets deadlier.** Debris from destroyed ships persists all match, progressively restricting safe flying space.
- **Every ship plays differently.** Each airship has a unique combination of stats, attack zones, and special powers.
- **Quick sessions.** A full 4-player match should resolve in approximately 5 minutes. Config values should be tuned to support this.

---

## 2. Configuration Philosophy

All gameplay variables are defined in `config.js` and nowhere else. No magic numbers exist in game logic files. This includes — but is not limited to — ship stats, attack ranges, debris damage, map size, death zone damage rates, cooldown durations, speed tiers, and special power parameters.

This allows full balance iteration without touching game logic code.

---

## 3. Movement Model

### 3.1 Fundamentals

- Ships move **continuously in the direction they are facing**. They cannot stop or strafe.
- Speed is divided into discrete **speed tiers** (e.g. 1–5). The number of tiers is configurable.
- Ships cannot have a speed of zero — the minimum is tier 1.
- Turning causes the ship to fly in an **arc**. The arc radius is determined by:
  - Current speed (higher speed = wider arc / less tight turning)
  - Ship's **maneuverability stat** (higher = tighter arc at any given speed)

### 3.2 Turning

Each frame, the ship's heading rotates by an angular velocity calculated as:

```
angularVelocity = (TURN_RATE_BASE * maneuverability) / currentSpeed
```

Where `TURN_RATE_BASE` is a global config constant. This ensures fast ships feel heavy and slow ships feel nimble.

### 3.3 Speed Tiers

- Represented as integers (e.g. 1 = slow crawl, 5 = full throttle).
- Each tier maps to a pixels-per-second velocity defined in config.
- Ships accelerate and decelerate between tiers instantly (no acceleration curve in v1, can be added later via config flag).

### 3.4 Map Boundary & Death Zone

- The map is a fixed rectangle. All coordinates are bounded.
- Outside the safe zone border, a **death zone** exists. Ships that enter the death zone take continuous damage per second (configurable per map).
- A visual warning indicator activates when a ship is near the death zone border.

---

## 4. Combat System

### 4.1 Attack Zones

Each ship has one or more **attack zones** defined as circular arc segments anchored to the ship's center. A zone is defined by:

| Property | Description |
|---|---|
| `angleOffset` | Direction of the zone center relative to ship heading (degrees). 0 = forward, 180 = rear, 90 = right side |
| `arcWidth` | Total angular width of the zone (degrees) |
| `range` | Radius of the zone in design pixels |
| `damage` | Damage dealt per hit |
| `cooldown` | Seconds between attacks for this zone |
| `weaponName` | Display name shown in ship selection |

A zone hit occurs when **an enemy ship's hitbox center falls within the arc segment** at the moment the attack input is registered, and the cooldown has elapsed.

- A ship may have multiple zones (e.g. front cannon + rear mine launcher).
- An enemy can be hit by multiple zones simultaneously (e.g. two ships attacking the same target at once).
- Zones are **visualized** as translucent arc overlays drawn around the player's own ship. Enemy attack zones are not shown.

### 4.2 Attack Input

- On desktop: each attack zone is mapped to a configurable key (primary fire, secondary fire, etc.)
- On mobile: up to 3 action buttons are available for fire/special actions. Button assignment is defined per ship in config.
- Pressing an attack key triggers all zones mapped to that key. If a zone is on cooldown, it does not fire but others mapped to the same key may still fire.

### 4.3 Special Powers

- Each ship has between 1 and 3 special powers (varies per ship, defined in config).
- Powers may have cooldowns and/or limited charges per match.
- Powers are designed thematically per ship and may include effects such as:
  - Speed burst
  - Temporary shield / damage reduction
  - Increased turn rate
  - Area denial (dropping a hazard)
  - Smokescreen / vision disruption
  - Attack zone size or damage boost
- All power parameters (duration, cooldown, charge count, magnitude) are defined in config.

### 4.4 Damage & Health

- Each ship has a configurable max health value.
- Health does not regenerate.
- When a ship reaches 0 HP it is **destroyed** and leaves a debris field.
- The destroyed player transitions to **spectator mode** immediately.

---

## 5. Debris & Collision System

### 5.1 Debris Generation

When a ship is destroyed, it spawns a cluster of **debris objects** at its last position. The number, spread, and size of debris pieces are configurable per ship (larger ships leave more debris).

### 5.2 Debris Collision

- Each debris object has a **circular hitbox**.
- Debris persists for the entire match and is part of the synchronized game state.
- When a ship's hitbox overlaps a debris object's hitbox for the first time, the ship takes a one-time damage hit (configurable per debris type).
- Once a debris object has been "hit" by a specific ship, it does not deal damage to that same ship again (prevents continuous damage from resting on debris). It resets if the ship leaves and re-enters.
- Debris does not affect other debris.

### 5.3 Ship–Ship Collision

- Ships have circular hitboxes.
- When two ships' hitboxes overlap, **both ships take collision damage** (configurable).
- Collision damage has a per-ship cooldown to prevent continuous damage while ships are overlapping.
- There is no physics push-back from collisions — ships pass through each other (contact damage only).

### 5.4 Hitbox Sizes

All hitbox radii are defined in config per ship and per debris type. Visual ship art should be sized to match the hitbox radius for readable gameplay.

---

## 6. Airship Roster

Four airships are available at launch. Each is defined entirely in the `SHIPS` section of `config.js`. The structure below defines what each ship entry must contain.

### 6.1 Ship Config Schema

```js
{
  id: 'scout',
  name: 'The Wasp',
  description: 'Fast and fragile. Excels at hit-and-run.',
  
  // Stats (all unitless 1–10 ratings for display; actual values below)
  stats: {
    speedRating:         8,
    armorRating:         3,
    maneuverRating:      9,
    firePowerRating:     5,
  },

  // Actual gameplay values
  maxHealth:             80,
  hitboxRadius:          18,       // design px
  speedTierValues:       [60, 100, 150, 200, 260],  // px/s per tier
  defaultSpeedTier:      3,
  maneuverability:       1.8,      // multiplier for turn rate formula

  // Attack zones
  attackZones: [
    {
      id:          'frontCannon',
      angleOffset: 0,
      arcWidth:    40,
      range:       140,
      damage:      18,
      cooldown:    0.5,
      weaponName:  'Front Cannon',
      inputKey:    'primary',      // maps to primary fire button
    },
  ],

  // Special powers
  specialPowers: [
    {
      id:          'afterburner',
      name:        'Afterburner',
      description: 'Instantly jump to max speed for 2 seconds.',
      cooldown:    8,
      charges:     -1,             // -1 = unlimited, uses cooldown only
      inputKey:    'special1',
      // power-specific params:
      duration:    2.0,
    },
  ],

  // Debris on death
  debris: {
    pieceCount:   6,
    spreadRadius: 40,             // design px
    pieceRadius:  8,              // hitbox radius per piece
    damage:       12,
  },

  // Visual
  color:          '#70A1FF',      // player tint (overridden by player slot color)
  spriteKey:      'shipScout',    // key into ASSETS
}
```

### 6.2 Initial Roster Archetypes

The four launch ships should cover distinct playstyles. Exact stats are set in config — these are design intentions:

| Ship | Archetype | Speed | Armor | Maneuver | Firepower | Notes |
|---|---|---|---|---|---|---|
| **The Wasp** | Scout / Skirmisher | High | Low | Very High | Medium | Hits hard on drive-bys, can't take punishment |
| **The Ironclad** | Bruiser / Brawler | Low | Very High | Low | High | Wide arcs, multiple zones, punishes close range |
| **The Harrier** | Balanced / Generalist | Medium | Medium | Medium | Medium | Good starting ship, no extreme weaknesses |
| **The Phantom** | Wildcard / Disruptor | Medium | Low | High | Low-Medium | Unique special powers focused on evasion and disruption |

---

## 7. Maps

### 7.1 Map Config Schema

Maps are defined in config under `MAPS`:

```js
{
  id:               'skyreach',
  name:             'Skyreach',
  width:            2400,           // design px
  height:           2400,
  deathZoneDepth:   120,            // px inset from edge where damage begins
  deathZoneDamage:  15,             // HP per second while in death zone
  backgroundColor: ['#87CEEB', '#B0E0FF'],  // gradient top/bottom
  obstacles: [],                    // v1: empty — open sky
  spawnPoints: [
    { x: 400,  y: 400,  heading: 45  },
    { x: 2000, y: 400,  heading: 135 },
    { x: 400,  y: 2000, heading: 315 },
    { x: 2000, y: 2000, heading: 225 },
  ],
}
```

### 7.2 Camera

- The camera follows the local player's ship, keeping it centered.
- The visible viewport is the full physical canvas. The map scrolls beneath.
- Map edges are visually indicated (darkening sky, warning color at death zone boundary).
- Other players, debris, and attack zones outside the viewport are not rendered (culled).

### 7.3 Minimap

A minimap is displayed in the HUD showing:
- All living ships (colored by player slot)
- Debris clusters (as small dots)
- Death zone boundary
- Local player position (always centered or highlighted)

---

## 8. Game Flow & Session Structure

### 8.1 Scene List

| Scene | Description |
|---|---|
| `MenuScene` | Title screen, host/join options |
| `LobbyScene` | Room code display, ship selection, ready-up |
| `GameScene` | Main gameplay |
| `ResultsScene` | Post-match winner display, rematch option |

### 8.2 Room Flow

1. **Host** creates a room → receives a room code → shares it out-of-band.
2. **Joiners** enter the room code → connect via PeerJS.
3. All players land in `LobbyScene`.
4. Each player selects a ship. No two players may pick the same ship (first-come, first-served lock).
5. Players press Ready. When all connected players are ready, host starts the match.
6. Match supports 2–4 players. Host can start with as few as 2.
7. After the match, `ResultsScene` shows standings. Host can call a rematch (same room, returns to `LobbyScene`) or dissolve the room.

### 8.3 Spectator Mode

- Players eliminated during the match immediately enter spectator mode.
- Spectators can cycle through the cameras of remaining living players.
- Spectators see the full HUD of the ship they are spectating.
- Spectators cannot interact with the game.

### 8.4 Win Condition

- Last ship alive wins.
- If the final two ships are destroyed in the same frame (mutual kill), the player with more remaining health at the time of the last hit wins. If equal, it is declared a draw.

### 8.5 Post-Match Stats

Displayed on `ResultsScene` for all players:

- Final placement (1st / 2nd / 3rd / 4th)
- Kills
- Damage dealt
- Damage taken
- Debris collisions caused (how many debris pieces your death generated that hit enemies)
- Survival time

---

## 9. HUD & UI

### 9.1 In-Game HUD (local player only)

- **Health bar** — prominent, bottom-center or bottom-left. Only shows local player's HP.
- **Speed indicator** — matches the mobile throttle triangle visual; shows current speed tier. Visible on both desktop and mobile.
- **Attack zone overlay** — translucent arc(s) drawn around local player's ship on the game canvas (not the HUD layer). Color-coded per zone. Dims when on cooldown.
- **Cooldown indicators** — one per attack zone and per special power. Small icons with a radial fill cooldown animation.
- **Special power buttons** — visible on mobile as touch buttons; on desktop shown as key-label icons in the HUD.
- **Minimap** — corner of screen, always visible.
- **Player labels** — each ship on screen has a small colored label (P1/P2/P3/P4) above it.
- **Death zone warning** — screen-edge vignette that pulses red when the local player is in the death zone.

### 9.2 Lobby UI

- Room code displayed large and copyable.
- Ship selection grid (4 ships). Locked ships show the selecting player's color.
- Ready status indicator per player slot.
- Connected player list with ping display.

### 9.3 Results UI

- Winner announced with large text and particle effect.
- Stat table for all players.
- Rematch button (host only activates it), Leave button.

---

## 10. Controls — Desktop

| Action | Default Key |
|---|---|
| Turn left | `A` / `ArrowLeft` |
| Turn right | `D` / `ArrowRight` |
| Speed up | `W` / `ArrowUp` |
| Speed down | `S` / `ArrowDown` |
| Primary fire | `Space` |
| Secondary fire | `F` |
| Special 1 | `Q` |
| Special 2 | `E` |
| Special 3 | `R` |
| Spectate next (when dead) | `Tab` |

All key bindings are configurable in config.

---

## 11. Controls — Mobile

### 11.1 Joystick (left side)

- Virtual joystick for turning left/right.
- Horizontal axis only (left/right turn). Vertical axis is unused.
- Joystick deadzone and sensitivity are configurable.

### 11.2 Throttle Triangle (left side, beside joystick)

- A segmented triangle widget representing speed tiers.
- Player drags finger up/down along the triangle to select a speed tier.
- The number of visible segments equals the number of speed tiers defined in config.
- Currently active tier is highlighted.

### 11.3 Action Buttons (right side)

- Up to **4 buttons** on the right side:
  - 1 primary fire button (always present)
  - Up to 3 special power buttons (shown only if the selected ship has those powers)
- Button layout adapts to the number of active powers.

### 11.4 Spectate (when dead)

- A "Next" button appears center-screen to cycle spectate targets.

---

## 12. Networking Architecture

### 12.1 Transport

- **PeerJS** WebRTC data channels for peer-to-peer connections.
- Star topology: host relays state to all peers.
- Room code = host's PeerJS peer ID (or a short derived code).

### 12.2 Rollback Netcode

- Uses the template's `RollbackEngine` from `netcode/`.
- Tick rate: 60 fps (configurable via `CONFIG.NETCODE.TICK_RATE`).
- Input packet per tick contains:
  - Turn direction (2 bits: left / right / none)
  - Speed tier change (2 bits: up / down / none)
  - Attack flags (1 bit per attack zone, max 4 zones = 4 bits)
  - Special power flags (1 bit per special, max 3 = 3 bits)
  - Total: fits comfortably in 2 bytes

### 12.3 Game State (serialize / deserialize)

Synchronized state includes:
- Per ship: position (x, y), heading, speed tier, health, cooldown timers, power charge counts, alive flag
- Per debris piece: position (x, y), hitbox radius, alive flag, per-ship hit flags (bitmask)

State is encoded as a compact binary buffer for rollback snapshot storage.

### 12.4 Determinism Requirements

- No `Math.random()` in game logic — use a seeded deterministic RNG (seed set at match start, synced to all clients).
- Ship update order is sorted by player ID string each tick.
- Floating-point positions accumulated via integer sub-pixel fixed-point arithmetic where precision is critical (to be evaluated during implementation).

### 12.5 Desync Handling

- Hash computed each tick over all ship positions and healths.
- Host is the desync authority — on desync detection, host broadcasts a full state sync.

---

## 13. Audio

All audio defined in `ASSETS` in `assets.js`. Procedural ZzFX sounds used for all SFX in v1 (no audio files required).

| Sound Key | Trigger |
|---|---|
| `sfxFire` | Attack zone fires |
| `sfxHit` | Ship takes damage |
| `sfxCollision` | Ship–ship collision |
| `sfxDebrisHit` | Ship hits debris |
| `sfxDestroy` | Ship destroyed |
| `sfxSpecial` | Special power activated |
| `sfxDeathZone` | Looping while in death zone |
| `sfxUIClick` | Menu button press |
| `sfxUIReady` | Player ready up |
| `sfxVictory` | Match winner declared |
| `musicMenu` | Menu background music |
| `musicGame` | In-game background music |

Volume levels for all sounds configurable in config.

---

## 14. File Structure

```
sky-armada/
│
├── index.html
├── style.css
├── littlejs.esm.min.js
│
├── App.js                        # Bootstrap, scene switching, global game state
├── config.js                     # ALL configuration constants
├── assets.js                     # Asset definitions
│
├── scenes/
│   ├── MenuScene.js
│   ├── LobbyScene.js
│   ├── GameScene.js
│   └── ResultsScene.js
│
├── game/
│   ├── Ship.js                   # Ship entity: movement, attack zones, powers
│   ├── DebrisField.js            # Debris cluster and piece management
│   ├── CollisionSystem.js        # Hitbox overlap detection (ships, debris)
│   ├── AttackZoneSystem.js       # Zone rendering and hit detection
│   ├── Camera.js                 # Scrolling camera, world-to-screen transform
│   ├── Minimap.js                # Minimap renderer
│   ├── WorldState.js             # serialize() / deserialize() / hash() for netcode
│   ├── SeededRNG.js              # Deterministic random number generator
│   └── ShipDefinitions.js        # Loads ship configs from CONFIG.SHIPS
│
├── ui/
│   ├── HUD.js                    # In-game HUD renderer
│   ├── MobileControls.js         # Joystick, throttle triangle, action buttons
│   ├── LobbyUI.js                # Ship selection, ready state
│   └── ResultsUI.js              # Post-match stats table
│
├── netcode/                      # Template netcode (do not modify)
│   └── ...
│
└── utils/                        # Template utils (do not modify)
    └── ...
```

---

## 15. Config Reference

Below is the top-level structure of `config.js`. All values shown are illustrative starting points to be tuned during development.

```js
export const CONFIG = {

  GAME_TITLE: 'Sky Armada',
  DESIGN_WIDTH:  1280,
  DESIGN_HEIGHT: 720,
  MIN_SCALE: 0.4,
  MAX_SCALE: 2.0,
  USE_TARGET_RESOLUTION: true,
  TARGET_RESOLUTION: { width: 812, height: 375 },  // landscape mobile

  BACKGROUND_GRADIENT: {
    START: '#87CEEB',
    END:   '#B0E0FF',
  },

  // ── Movement
  MOVEMENT: {
    TURN_RATE_BASE:        120,    // degrees/s at speed tier 1, maneuver 1.0
    SPEED_TIER_COUNT:      5,
  },

  // ── Combat
  COMBAT: {
    SHIP_COLLISION_DAMAGE:  10,
    SHIP_COLLISION_COOLDOWN: 0.5,  // seconds between collision damage events
    ATTACK_ZONE_ALPHA:       0.25, // opacity of zone visualization
    ATTACK_ZONE_COOLDOWN_ALPHA: 0.08,
  },

  // ── Death Zone
  DEATH_ZONE: {
    WARNING_DISTANCE:  200,        // design px from edge to show warning
    VIGNETTE_ALPHA:    0.6,
  },

  // ── Netcode
  NETCODE: {
    TICK_RATE:              60,
    SNAPSHOT_HISTORY:       120,
    MAX_SPECULATION_TICKS:  60,
    HASH_INTERVAL:          60,
    INPUT_REDUNDANCY:       3,
    DISCONNECT_TIMEOUT:     5000,
  },

  // ── Audio
  MASTER_VOLUME: 0.8,
  MUSIC_VOLUME:  0.3,
  SFX_VOLUME:    0.8,

  // ── Mobile Controls
  MOBILE: {
    JOYSTICK_RADIUS:        60,    // design px
    JOYSTICK_DEADZONE:      0.15,
    THROTTLE_WIDTH:         50,
    THROTTLE_HEIGHT:        120,
    ACTION_BUTTON_SIZE:     64,
  },

  // ── UI Design System
  UI: {
    COLORS: {
      PRIMARY:    0x70A1FF,
      SUCCESS:    0x7BED9F,
      WARNING:    0xFFA502,
      DANGER:     0xFF6B6B,
      GOLD:       0xFFD700,
      PANEL_BG:   0x3d3d5c,
    },
    PLAYER_COLORS: [
      0x70A1FF,   // P1 blue
      0xFF6B6B,   // P2 red
      0x7BED9F,   // P3 green
      0xFFD700,   // P4 gold
    ],
  },

  // ── Desktop Key Bindings
  KEYS: {
    TURN_LEFT:     ['KeyA', 'ArrowLeft'],
    TURN_RIGHT:    ['KeyD', 'ArrowRight'],
    SPEED_UP:      ['KeyW', 'ArrowUp'],
    SPEED_DOWN:    ['KeyS', 'ArrowDown'],
    PRIMARY_FIRE:  ['Space'],
    SECONDARY_FIRE:['KeyF'],
    SPECIAL_1:     ['KeyQ'],
    SPECIAL_2:     ['KeyE'],
    SPECIAL_3:     ['KeyR'],
    SPECTATE_NEXT: ['Tab'],
  },

  // ── Maps
  MAPS: [
    {
      id:              'skyreach',
      name:            'Skyreach',
      width:           2400,
      height:          2400,
      deathZoneDepth:  120,
      deathZoneDamage: 15,
      spawnPoints: [
        { x: 400,  y: 400,  heading: 45  },
        { x: 2000, y: 400,  heading: 135 },
        { x: 400,  y: 2000, heading: 315 },
        { x: 2000, y: 2000, heading: 225 },
      ],
    },
  ],

  // ── Ships
  SHIPS: [
    {
      id:          'wasp',
      name:        'The Wasp',
      description: 'Fast and fragile. Built for hit-and-run strikes.',
      stats: { speedRating: 8, armorRating: 3, maneuverRating: 9, firePowerRating: 5 },
      maxHealth:       80,
      hitboxRadius:    18,
      speedTierValues: [70, 110, 160, 210, 270],
      defaultSpeedTier: 3,
      maneuverability: 1.8,
      attackZones: [
        { id: 'frontCannon', angleOffset: 0, arcWidth: 40, range: 140,
          damage: 18, cooldown: 0.5, weaponName: 'Front Cannon', inputKey: 'primary' },
      ],
      specialPowers: [
        { id: 'afterburner', name: 'Afterburner', cooldown: 8, charges: -1,
          inputKey: 'special1', duration: 2.0 },
        { id: 'rollEvade', name: 'Evasive Roll', cooldown: 12, charges: -1,
          inputKey: 'special2', turnBoost: 2.0, duration: 1.5 },
      ],
      debris: { pieceCount: 5, spreadRadius: 35, pieceRadius: 7, damage: 10 },
      spriteKey: 'shipWasp',
    },
    {
      id:          'ironclad',
      name:        'The Ironclad',
      description: 'Slow and heavily armored. Punishes close-range brawls.',
      stats: { speedRating: 3, armorRating: 9, maneuverRating: 3, firePowerRating: 8 },
      maxHealth:       200,
      hitboxRadius:    30,
      speedTierValues: [40, 65, 85, 105, 125],
      defaultSpeedTier: 2,
      maneuverability: 0.7,
      attackZones: [
        { id: 'broadside_port',   angleOffset: 270, arcWidth: 70, range: 110,
          damage: 28, cooldown: 1.2, weaponName: 'Port Broadside',   inputKey: 'primary' },
        { id: 'broadside_starboard', angleOffset: 90, arcWidth: 70, range: 110,
          damage: 28, cooldown: 1.2, weaponName: 'Starboard Broadside', inputKey: 'primary' },
        { id: 'rearBomb', angleOffset: 180, arcWidth: 50, range: 80,
          damage: 35, cooldown: 3.0, weaponName: 'Rear Bomb Bay', inputKey: 'secondary' },
      ],
      specialPowers: [
        { id: 'armorPlating', name: 'Reinforced Plating', cooldown: 20, charges: -1,
          inputKey: 'special1', damageReduction: 0.5, duration: 4.0 },
      ],
      debris: { pieceCount: 12, spreadRadius: 60, pieceRadius: 12, damage: 18 },
      spriteKey: 'shipIronclad',
    },
    {
      id:          'harrier',
      name:        'The Harrier',
      description: 'Well-rounded and forgiving. A solid choice for any pilot.',
      stats: { speedRating: 5, armorRating: 5, maneuverRating: 5, firePowerRating: 5 },
      maxHealth:       120,
      hitboxRadius:    22,
      speedTierValues: [55, 85, 120, 155, 190],
      defaultSpeedTier: 3,
      maneuverability: 1.1,
      attackZones: [
        { id: 'frontGuns', angleOffset: 0, arcWidth: 50, range: 130,
          damage: 20, cooldown: 0.7, weaponName: 'Front Guns', inputKey: 'primary' },
        { id: 'tailGun', angleOffset: 180, arcWidth: 35, range: 90,
          damage: 14, cooldown: 1.0, weaponName: 'Tail Gun', inputKey: 'secondary' },
      ],
      specialPowers: [
        { id: 'repairKit', name: 'Field Repair', cooldown: 25, charges: 2,
          inputKey: 'special1', healAmount: 25 },
      ],
      debris: { pieceCount: 7, spreadRadius: 40, pieceRadius: 9, damage: 12 },
      spriteKey: 'shipHarrier',
    },
    {
      id:          'phantom',
      name:        'The Phantom',
      description: 'Evasive and unpredictable. Masters of disruption.',
      stats: { speedRating: 6, armorRating: 3, maneuverRating: 8, firePowerRating: 4 },
      maxHealth:       90,
      hitboxRadius:    16,
      speedTierValues: [60, 95, 135, 175, 215],
      defaultSpeedTier: 3,
      maneuverability: 1.6,
      attackZones: [
        { id: 'forwardBurst', angleOffset: 0, arcWidth: 30, range: 160,
          damage: 15, cooldown: 0.4, weaponName: 'Forward Burst', inputKey: 'primary' },
      ],
      specialPowers: [
        { id: 'cloak', name: 'Phase Cloak', cooldown: 18, charges: -1,
          inputKey: 'special1', duration: 2.5 },
        { id: 'smokescreen', name: 'Smokescreen', cooldown: 12, charges: -1,
          inputKey: 'special2', radius: 100, duration: 5.0 },
        { id: 'teleport', name: 'Emergency Jump', cooldown: 30, charges: 1,
          inputKey: 'special3' },
      ],
      debris: { pieceCount: 4, spreadRadius: 30, pieceRadius: 6, damage: 8 },
      spriteKey: 'shipPhantom',
    },
  ],

};
```

---

*End of Sky Armada Game Design Specification v0.1*
