/** Tripwire test (issue #19 step 12).
 *
 * The dev-only token cap (50, in `routes/devLogin.ts`) and the production token cap (20, in
 * `routes/tokens.ts`) intentionally live as separate constants in separate files because they
 * have different risk profiles. This test fails if a future refactor extracts them into a single
 * shared constant — by which point the values would necessarily have converged.
 *
 * If you ever want to lower the production cap, change the constant in `routes/tokens.ts`. If you
 * ever want to raise the dev cap, change the constant in `routes/devLogin.ts`. Do not centralize
 * either side without acknowledging that you are intentionally giving up the dual-cap separation.
 */
import { describe, expect, it } from 'vitest';
import { DEV_TOKEN_CAP_PER_USER } from '../routes/devLogin.js';
import { PROD_TOKEN_CAP_PER_USER } from '../routes/tokens.js';

describe('token caps are separately defined', () => {
    it('the dev cap and the production cap have distinct values', () => {
        expect(DEV_TOKEN_CAP_PER_USER).not.toBe(PROD_TOKEN_CAP_PER_USER);
    });

    it('the dev cap is higher than the prod cap (rapid mint/revoke is normal in dev)', () => {
        expect(DEV_TOKEN_CAP_PER_USER).toBeGreaterThan(PROD_TOKEN_CAP_PER_USER);
    });

    it('both caps are sane positive integers', () => {
        expect(Number.isInteger(DEV_TOKEN_CAP_PER_USER) && DEV_TOKEN_CAP_PER_USER > 0).toBe(true);
        expect(Number.isInteger(PROD_TOKEN_CAP_PER_USER) && PROD_TOKEN_CAP_PER_USER > 0).toBe(true);
    });
});
