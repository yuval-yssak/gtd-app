import { afterEach, describe, expect, it } from 'vitest';
import { decrypt, encrypt } from '../lib/tokenEncryption.js';

// Save and restore the env var so tests don't bleed into each other.
const ORIG_KEY = process.env.CALENDAR_ENCRYPTION_KEY;

afterEach(() => {
    if (ORIG_KEY === undefined) {
        delete process.env.CALENDAR_ENCRYPTION_KEY;
    } else {
        process.env.CALENDAR_ENCRYPTION_KEY = ORIG_KEY;
    }
});

describe('encrypt / decrypt', () => {
    it('round-trips the original plaintext', () => {
        const plaintext = 'super-secret-token-value';
        expect(decrypt(encrypt(plaintext))).toBe(plaintext);
    });

    it('produces different ciphertexts for the same input (random IV)', () => {
        const plaintext = 'same-input';
        expect(encrypt(plaintext)).not.toBe(encrypt(plaintext));
    });

    it('throws on a tampered auth tag (GCM authentication failure)', () => {
        const encoded = encrypt('hello');
        const [iv, authTag, ciphertext] = encoded.split(':');
        // Flip the first byte of the auth tag.
        const tamperedTag = `ff${authTag.slice(2)}`;
        expect(() => decrypt(`${iv}:${tamperedTag}:${ciphertext}`)).toThrow();
    });

    it('throws on a string with fewer than 3 segments', () => {
        expect(() => decrypt('only-two:parts')).toThrow('Invalid encrypted token format');
    });

    it('uses the dev fallback key when CALENDAR_ENCRYPTION_KEY is absent', () => {
        delete process.env.CALENDAR_ENCRYPTION_KEY;
        const plaintext = 'dev-token';
        expect(decrypt(encrypt(plaintext))).toBe(plaintext);
    });
});

describe('encrypt output format', () => {
    it('encodes as iv:authTag:ciphertext (all hex)', () => {
        const encoded = encrypt('payload');
        const parts = encoded.split(':');
        expect(parts).toHaveLength(3);
        // IV is 12 bytes → 24 hex chars; auth tag is 16 bytes → 32 hex chars.
        expect(parts[0]).toHaveLength(24);
        expect(parts[1]).toHaveLength(32);
    });

    it('ciphertext differs from plaintext', () => {
        const plaintext = 'visible-token';
        const encoded = encrypt(plaintext);
        expect(encoded).not.toContain(plaintext);
    });
});
