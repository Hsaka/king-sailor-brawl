export function hashBytes(bytes) {
    let hash = 0x811c9dc5;

    for (let i = 0; i < bytes.length; i++) {
        hash ^= bytes[i];
        hash = Math.imul(hash, 0x01000193);
    }

    return hash >>> 0;
}
