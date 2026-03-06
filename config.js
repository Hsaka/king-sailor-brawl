/**
 * config.js — Game configuration for Sky Armada.
 */

window.VERSION = '0.5';

export const CONFIG = {
    // ── Identity ────────────────────────────────────────────────────────────
    GAME_TITLE: 'King Sailor Brawl',   // Shown on the loading screen

    // ── Responsive scaling ──────────────────────────────────────────────────
    DESIGN_WIDTH: 1280,
    DESIGN_HEIGHT: 720,

    USE_TARGET_RESOLUTION: true,
    TARGET_RESOLUTION: { width: 1280, height: 720 },   // landscape mobile

    MIN_SCALE: 0.4,
    MAX_SCALE: 2.0,

    MARGIN_X_MOBILE: 10,
    MARGIN_X_DESKTOP: 20,
    MARGIN_Y_MOBILE: 10,
    MARGIN_Y_DESKTOP: 20,
    MOBILE_BREAKPOINT: 768,

    // ── Audio ───────────────────────────────────────────────────────────────
    AUDIO_ENABLED: true,
    ENABLE_MUSIC: true,
    ENABLE_SFX: true,

    MASTER_VOLUME: 0.8,
    MUSIC_VOLUME: 0.3,
    SFX_VOLUME: 0.8,

    // ── UI Design System ────────────────────────────────────────────────────
    UI: {
        COLORS: {
            PRIMARY: 0x70A1FF,
            SUCCESS: 0x7BED9F,
            WARNING: 0xFFA502,
            DANGER: 0xFF6B6B,
            GOLD: 0xFFD700,
            TEXT_PRIMARY: 0xFFFFFF,
            TEXT_SECONDARY: 0xA0A0A0,
            PANEL_BG: 0x3d3d5c,
            PANEL_SHADOW: 0x2a2a40,
        },
        PLAYER_COLORS: [
            0x70A1FF,   // P1 blue
            0xFF6B6B,   // P2 red
            0x7BED9F,   // P3 green
            0xFFD700,   // P4 gold
        ],
        BUTTON: { DEPTH: 6, RADIUS: 16, SHADOW_ALPHA: 0.4, PRESS_DEPTH: 3 },
        CARD: { RADIUS: 20, DEPTH: 8, PADDING: 24, SHADOW_COLOR: 0x2a2a40 },
        PROGRESS_BAR: { HEIGHT: 24, RADIUS: 12, BG_COLOR: 0x2a2a40, FILL_COLORS: { PRIMARY: 0x70A1FF, SUCCESS: 0x7BED9F, GOLD: 0xFFD700 } },
        COUNTER: { HEIGHT: 64, RADIUS: 20, BG_COLOR: 0x2d2d44, ICON_SIZE: 34 },
        FONT_SIZES: { TITLE: 56, HEADING: 36, NUMBER: 32, BODY: 18, LABEL: 14, BUTTON: 30, RESOURCE: 28, MODAL_TITLE: 34, MODAL_NUMBER: 56, MODAL_LABEL: 20, MODAL_BODY: 22 },
        SPACING: { XS: 4, SM: 8, MD: 16, LG: 24, XL: 32, XXL: 48 },
        ANIMATIONS: { BUTTON_PRESS_DURATION: 0.1, CARD_HOVER_LIFT: 4, MODAL_FADE_DURATION: 0.3, SCORE_COUNT_DURATION: 1.0, CELEBRATION_DURATION: 2.0 },
        ICONS: { TROPHY: '🏆', GEM: '💎', COIN: '🪙', TARGET: '🎯', SOUND_ON: '🔊', SOUND_OFF: '🔇', STAR: '⭐', ARROW_RIGHT: '▶', ARROW_LEFT: '◀' },
    },

    // ── Background ──────────────────────────────────────────────────────────
    BACKGROUND_GRADIENT: {
        START: '#87CEEB',
        END: '#B0E0FF',
    },

    BACKGROUND_GRADIENT_LOBBY: {
        START: '#27363bff',
        END: '#293741ff',
    },

    // ── Floating particles ──────────────────────────────────────────────────
    FLOATING_PARTICLES: {
        MAX_COUNT: 40,
        SPAWN_RATE: 0.2,
        COLORS: ['#FFFFFF'],
        SIZE_MIN: 1.5, SIZE_MAX: 4, ALPHA_MIN: 0.1, ALPHA_MAX: 0.3,
        LIFETIME_MIN: 10, LIFETIME_MAX: 20, SPEED_MIN: 10, SPEED_MAX: 35,
        WOBBLE_AMPLITUDE: 15, WOBBLE_SPEED_MIN: 0.5, WOBBLE_SPEED_MAX: 1.5,
        GLOW_BLUR: 4, FADE_START_RATIO: 0.7,
    },

    SCREEN_SHAKE_DECAY: 0.85,
    SCREEN_SHAKE_INTENSITY_MAX: 10,

    UI_DEFAULTS: {
        TEXT_COLOR: '#ffffff',
        ICON_BUTTON_DEPTH: 4,
        ICON_BUTTON_RADIUS: 12,
        MODAL_OVERLAY_COLOR: 'rgba(0,0,0,0.7)',
    },

    // ── Game Mechanics ──────────────────────────────────────────────────────
    MOVEMENT: {
        TURN_RATE_BASE: 120, // degrees/s
        WHEEL_CONTROL_SCHEME: true,
        // How many degrees the player must rotate the physical wheel to achieve
        // one degree of ship turn.  1 = direct 1:1.  3 = three full wheel
        // revolutions to turn the ship one full revolution (harder to steer).
        WHEEL_TURN_RATIO: 1,
    },

    COMBAT: {
        BOT_COUNT: 3,
        SHIP_COLLISION_DAMAGE: 10,
        SHIP_COLLISION_COOLDOWN: 0.5, // seconds
        SHIP_COLLISION_KNOCKBACK_MULTIPLIER: 500,
        ATTACK_ZONE_ALPHA: 0.25,
        ATTACK_ZONE_COOLDOWN_ALPHA: 0.08,
        WEAPON_KNOCKBACK_MULTIPLIER: 35,
        BOMB_TYPES: ['damage', 'slow', 'emp', 'poison', 'heal'],
    },

    DEATH_ZONE: {
        WARNING_DISTANCE: 200, // design px
        VIGNETTE_ALPHA: 0.6,
    },

    NETCODE: {
        TICK_RATE: 60,
        SNAPSHOT_HISTORY: 120,
        MAX_SPECULATION_TICKS: 60,
        HASH_INTERVAL: 60,
        INPUT_REDUNDANCY: 3,
        DISCONNECT_TIMEOUT: 5000,
    },

    MOBILE: {
        JOYSTICK_RADIUS: 60,
        JOYSTICK_DEADZONE: 0.15,
        THROTTLE_WIDTH: 50,
        THROTTLE_HEIGHT: 120,
        ACTION_BUTTON_SIZE: 64,
        GAMEPAD_SIZE: 300
    },

    KEYS: {
        TURN_LEFT: ['KeyA', 'ArrowLeft'],
        TURN_RIGHT: ['KeyD', 'ArrowRight'],
        SPEED_UP: ['KeyW', 'ArrowUp'],
        SPEED_DOWN: ['KeyS', 'ArrowDown'],
        PRIMARY_FIRE: ['Space'],
        SECONDARY_FIRE: ['KeyF'],
        SPECIAL_1: ['KeyQ'],
        SPECIAL_2: ['KeyE'],
        SPECIAL_3: ['KeyR'],
        SPECTATE_NEXT: ['Tab'],
    },

    // ── Maps ─────────────────────────────────────────────────────────────────
    MAPS: [
        {
            id: 'skyreach',
            name: 'Skyreach',
            width: 2400,
            height: 2400,
            deathZoneDepth: 120,
            deathZoneDamage: 15,
            spawnPoints: [
                { x: 400, y: 400, heading: 45 },
                { x: 2000, y: 400, heading: 135 },
                { x: 400, y: 2000, heading: 315 },
                { x: 2000, y: 2000, heading: 225 },
            ],
        },
    ],

    // ── Ships ────────────────────────────────────────────────────────────────
    SHIPS: [
        {
            id: 'cobro',
            name: 'Co-Bro',
            description: `"Filthy scavengers?! We're not filthy!"`,
            stats: { speedRating: 8, armorRating: 3, maneuverRating: 9, firePowerRating: 5 },
            maxHealth: 80,
            hitboxRadius: 18,
            speedTierValues: [160, 210, 270],
            defaultSpeedTier: 2,
            maneuverability: 1.8,
            attackZones: [
                { id: 'frontCannon', type: 'zone', angleOffset: 0, arcWidth: 40, range: 100, damage: 18, cooldown: 0.5, weaponName: 'Front Cannon', inputKey: 'primary' },
                { id: 'tailGun', type: 'zone', angleOffset: 180, arcWidth: 35, range: 80, damage: 24, cooldown: 1.0, weaponName: 'Tail Gun', inputKey: 'secondary' },
            ],
            specialPowers: [
                { id: 'afterburner', name: 'Afterburner', cooldown: 8, charges: -1, inputKey: 'special1', duration: 2.0 },
                { id: 'rollEvade', name: 'Evasive Roll', cooldown: 12, charges: -1, inputKey: 'special2', turnBoost: 2.0, duration: 1.5 },
            ],
            debris: { pieceCount: 5, spreadRadius: 35, pieceRadius: 7, damage: 10 },
            spriteKey: 'shipCoBro',
        },
        {
            id: 'batteringram',
            name: 'The Battering Ram',
            description: `"Like a rock. In the sky. A sky rock."`,
            stats: { speedRating: 3, armorRating: 9, maneuverRating: 3, firePowerRating: 8 },
            maxHealth: 150,
            hitboxRadius: 30,
            speedTierValues: [40, 65, 85, 105, 115],
            defaultSpeedTier: 3,
            maneuverability: 0.7,
            attackZones: [
                { id: 'broadside_port', type: 'zone', angleOffset: 270, arcWidth: 70, range: 110, damage: 28, cooldown: 1.2, weaponName: 'Port Broadside', inputKey: 'primary' },
                { id: 'broadside_starboard', type: 'zone', angleOffset: 90, arcWidth: 70, range: 110, damage: 28, cooldown: 1.2, weaponName: 'Starboard Broadside', inputKey: 'primary' }
            ],
            specialPowers: [
                { id: 'armorPlating', name: 'Reinforced Plating', cooldown: 20, charges: -1, inputKey: 'special1', damageReduction: 0.5, duration: 4.0 },
            ],
            debris: { pieceCount: 12, spreadRadius: 60, pieceRadius: 12, damage: 18 },
            spriteKey: 'shipBatteringRam',
        },
        {
            id: 'flame',
            name: 'Flame',
            description: `"Places to be, things to burn."`,
            stats: { speedRating: 5, armorRating: 5, maneuverRating: 5, firePowerRating: 5 },
            maxHealth: 170,
            hitboxRadius: 22,
            speedTierValues: [50, 85, 120],
            defaultSpeedTier: 2,
            maneuverability: 1.1,
            attackZones: [
                { id: 'broadside_port', type: 'zone', angleOffset: 270, arcWidth: 70, range: 90, damage: 25, cooldown: 1.0, weaponName: 'Port Broadside', inputKey: 'primary' },
                { id: 'broadside_starboard', type: 'zone', angleOffset: 90, arcWidth: 70, range: 90, damage: 25, cooldown: 1.0, weaponName: 'Starboard Broadside', inputKey: 'primary' },
                { id: 'rearBomb', type: 'bomb', angleOffset: 180, arcWidth: 50, range: 80, damage: 15, cooldown: 3.0, weaponName: 'Rear Bomb Bay', inputKey: 'secondary', bomb: { pieceCount: 1, spreadRadius: 0, pieceRadius: 12, type: 'slow', lifetime: 30, duration: 2.0, spriteKey: 'bomb' } },
            ],
            specialPowers: [
                { id: 'repairKit', name: 'Field Repair', cooldown: 25, charges: 2, inputKey: 'special1', healAmount: 25 },
            ],
            debris: { pieceCount: 10, spreadRadius: 40, pieceRadius: 10, damage: 15 },
            spriteKey: 'shipFlame',
        },
        {
            id: 'leaf',
            name: 'The Leaf',
            description: `"Can't spell 'Bloom' without 'BOOM'!"`,
            stats: { speedRating: 6, armorRating: 3, maneuverRating: 8, firePowerRating: 4 },
            maxHealth: 160,
            hitboxRadius: 25,
            speedTierValues: [50, 75, 95, 115, 125],
            defaultSpeedTier: 3,
            maneuverability: 1.6,
            attackZones: [
                { id: 'broadside_port', type: 'zone', angleOffset: 270, arcWidth: 70, range: 100, damage: 22, cooldown: 1.1, weaponName: 'Port Broadside', inputKey: 'primary' },
                { id: 'broadside_starboard', type: 'zone', angleOffset: 90, arcWidth: 70, range: 100, damage: 22, cooldown: 1.1, weaponName: 'Starboard Broadside', inputKey: 'primary' },
                { id: 'rearBomb', type: 'bomb', angleOffset: 180, arcWidth: 50, range: 80, damage: 35, cooldown: 5.0, weaponName: 'Rear Bomb Bay', inputKey: 'secondary', bomb: { pieceCount: 1, spreadRadius: 0, pieceRadius: 15, type: 'damage', lifetime: 30, duration: 2.0, spriteKey: 'bomb' } },
            ],
            specialPowers: [
                { id: 'cloak', name: 'Phase Cloak', cooldown: 18, charges: -1, inputKey: 'special1', duration: 2.5 },
                { id: 'smokescreen', name: 'Smokescreen', cooldown: 12, charges: -1, inputKey: 'special2', radius: 100, duration: 5.0 },
                { id: 'teleport', name: 'Emergency Jump', cooldown: 30, charges: 1, inputKey: 'special3' },
            ],
            debris: { pieceCount: 11, spreadRadius: 30, pieceRadius: 9, damage: 12 },
            spriteKey: 'shipLeaf',
        },
    ],
};
