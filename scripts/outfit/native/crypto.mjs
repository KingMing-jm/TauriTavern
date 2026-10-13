import { Buffer } from 'buffer';
import { sha1 } from '@noble/hashes/sha1';
import { sha256 } from '@noble/hashes/sha256';
export function randomBytes(length) {
    const value = Buffer.alloc(length);
    for (let offset = 0; offset < length; offset += 65536) globalThis.crypto.getRandomValues(value.subarray(offset, Math.min(offset + 65536, length)));
    return value;
}
export function createHash(algorithm) {
    const implementation = { sha1, sha256 }[algorithm];
    if (!implementation) throw new Error(`Unsupported Outfit hash algorithm: ${algorithm}`);
    const state = implementation.create();
    return {
        update(value, encoding) { state.update(typeof value === 'string' ? Buffer.from(value, encoding || 'utf8') : value); return this; },
        digest(encoding) { const output = Buffer.from(state.digest()); return encoding ? output.toString(encoding) : output; },
    };
}
export default { randomBytes, createHash };
