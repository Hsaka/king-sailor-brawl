export const POWERUP_TYPES = Object.freeze([
    'speed_boost',
    'shield',
    'attack_boost',
]);

export const POWERUP_TYPE_IDS = Object.freeze({
    speed_boost: 0,
    shield: 1,
    attack_boost: 2,
});

export const PLAYER_POWERUP_FIELDS = Object.freeze({
    speed_boost: 'speedBoostTicks',
    shield: 'shieldTicks',
    attack_boost: 'attackBoostTicks',
});

export const POWERUP_ASSET_KEYS = Object.freeze({
    speed_boost: 'powerupSpeedBoost',
    shield: 'powerupShield',
    attack_boost: 'powerupAttackBoost',
});

export function getPowerupTypeKey(typeId) {
    return POWERUP_TYPES[typeId] ?? POWERUP_TYPES[0];
}

export function getPowerupTypeId(typeKey) {
    return POWERUP_TYPE_IDS[typeKey] ?? 0;
}

export function getPlayerPowerupField(typeKeyOrId) {
    const key = typeof typeKeyOrId === 'number' ? getPowerupTypeKey(typeKeyOrId) : typeKeyOrId;
    return PLAYER_POWERUP_FIELDS[key] ?? PLAYER_POWERUP_FIELDS.speed_boost;
}

export function getPowerupAssetKey(typeKeyOrId) {
    const key = typeof typeKeyOrId === 'number' ? getPowerupTypeKey(typeKeyOrId) : typeKeyOrId;
    return POWERUP_ASSET_KEYS[key] ?? POWERUP_ASSET_KEYS.speed_boost;
}
