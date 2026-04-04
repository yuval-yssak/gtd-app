import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';

function getKey(): Buffer {
    const hex = process.env.CALENDAR_ENCRYPTION_KEY ?? '';
    if (hex.length !== 64) {
        // Fall back to a deterministic dev key — never used in production because
        // CALENDAR_ENCRYPTION_KEY is required there.
        return Buffer.from('0'.repeat(64), 'hex');
    }
    return Buffer.from(hex, 'hex');
}

/** Encrypts a plaintext string. Returns a single string: `iv:authTag:ciphertext` (all hex). */
export function encrypt(plaintext: string): string {
    const key = getKey();
    const iv = randomBytes(12); // 96-bit IV — recommended for GCM
    const cipher = createCipheriv(ALGORITHM, key, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`;
}

/** Decrypts a string produced by {@link encrypt}. */
export function decrypt(encoded: string): string {
    const parts = encoded.split(':');
    // Encoded format is `iv:authTag:ciphertext` — all three segments must be present.
    if (parts.length < 3) throw new Error('Invalid encrypted token format');
    const [ivHex, authTagHex, ciphertextHex] = parts as [string, string, string];
    const key = getKey();
    const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(ivHex, 'hex'));
    decipher.setAuthTag(Buffer.from(authTagHex, 'hex'));
    const decrypted = Buffer.concat([decipher.update(Buffer.from(ciphertextHex, 'hex')), decipher.final()]);
    return decrypted.toString('utf8');
}
