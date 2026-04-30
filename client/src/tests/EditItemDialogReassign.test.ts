import { describe, expect, it } from 'vitest';
import { decideSavePath } from '../components/editItemDialogLogic';

// Locks in the EditItemDialog Save invariants that fix the cross-account corruption bug:
// - ownerChanged && statusChanged → block (the server's reassign path doesn't run the
//   clarify-style status-transition pipeline; combining them would silently lose fields).
// - ownerChanged !statusChanged → reassign-only (and crucially: NEVER saveInPlace, because
//   that would write under the source user's IDB — the bug that put item ebd197ea-… under
//   the wrong user when the active session was the target).
// - !ownerChanged && statusChanged → statusTransition (existing same-account flow).
// - !ownerChanged && !statusChanged → saveInPlace.
describe('decideSavePath', () => {
    it('blocks the combo of ownerChanged + statusChanged with an actionable error', () => {
        const path = decideSavePath(true, true);
        expect(path.kind).toBe('block');
        if (path.kind === 'block') {
            expect(path.error).toMatch(/either the status or the account/);
        }
    });

    it('returns "reassign" when only the owner changed — saveInPlace must NOT run on this path', () => {
        expect(decideSavePath(true, false)).toEqual({ kind: 'reassign' });
    });

    it('returns "statusTransition" when only the status changed', () => {
        expect(decideSavePath(false, true)).toEqual({ kind: 'statusTransition' });
    });

    it('returns "saveInPlace" when neither owner nor status changed (vanilla edit)', () => {
        expect(decideSavePath(false, false)).toEqual({ kind: 'saveInPlace' });
    });
});
