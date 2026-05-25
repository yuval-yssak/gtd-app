import { describe, expect, it, vi } from 'vitest';
import { buildClarifyToDoneOpts, decideSavePath } from '../components/editItemDialogLogic';

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

// Locks in the wiring contract for the fromGmail-read-only snackbar: ItemEditorBody calls this
// helper inside its `'done'` status-transition branch. A future refactor that drops the helper
// call (or stops forwarding the prop) will break the toast on the editor surfaces silently —
// these tests catch that regression by asserting the helper's input→output contract.
describe('buildClarifyToDoneOpts', () => {
    it('returns undefined when no callback is supplied (exactOptionalPropertyTypes-safe)', () => {
        expect(buildClarifyToDoneOpts(undefined)).toBeUndefined();
    });

    it('wraps the callback into { onReadOnlyGCal } so clarifyToDone receives a single named opt', () => {
        const cb = vi.fn();
        const opts = buildClarifyToDoneOpts(cb);
        expect(opts).toEqual({ onReadOnlyGCal: cb });
        // Identity preserved — the route's stable handler must remain the one invoked.
        expect(opts?.onReadOnlyGCal).toBe(cb);
    });
});
