import { useEffect, useRef } from 'react';

/**
 * Interchangeable pinned-bar primaries: a lost control restores onto whichever of these the new
 * view offers, in this order (the empty card's Continue, then the stage kinds' primary buttons).
 */
const PRIMARY_ACTION_TEST_IDS = ['stageContinue', 'clarifySaveNext', 'focusKeep'] as const;

/**
 * The lookup surface resolveFocusTarget needs — element-by-testid plus focusability. Structural
 * (not HTMLElement-typed) so the fallback rules stay unit-testable in the node test environment.
 */
export interface FocusControlLookup<T> {
    byTestId(testId: string): T | null;
    canFocus(control: T): boolean;
}

/**
 * Which control should receive focus after the one the user was on left the DOM: the same-testid
 * control in the new view when it exists and can take focus (e.g. the next item's ▶), otherwise
 * the bar's primary action (e.g. ▶ walked onto the end card, whose primary is Continue).
 */
export function resolveFocusTarget<T>(lookup: FocusControlLookup<T>, lostTestId: string): T | null {
    const exact = lookup.byTestId(lostTestId);
    if (exact !== null && lookup.canFocus(exact)) {
        return exact;
    }
    const primary = PRIMARY_ACTION_TEST_IDS.map((testId) => lookup.byTestId(testId)).find(
        (control): control is NonNullable<typeof control> => control !== null && lookup.canFocus(control),
    );
    return primary ?? null;
}

const domLookup = (root: HTMLElement): FocusControlLookup<HTMLElement> => ({
    byTestId: (testId) => root.querySelector<HTMLElement>(`[data-testid="${testId}"]`),
    // Genuinely focusable only: a recorded CONTAINER sentinel (see onFocusIn) also carries a
    // testid, but focusing a plain Box would silently no-op — it must fall to the bar primary.
    canFocus: (control) => control.matches('button, [href], input, select, textarea, [tabindex]') && !control.matches(':disabled'),
});

interface FocusedControl {
    element: HTMLElement;
    testId: string;
}

/**
 * Keeps keyboard focus alive across wizard transitions. Advancing to another item remounts the
 * portaled action row, and a stage change remounts the whole stage — the focused button is ripped
 * out of the DOM and focus falls to <body>, stranding keyboard users mid-review. This restores
 * focus onto the equivalent control in the new view (see resolveFocusTarget).
 *
 * Deliberately keyed on the focused ELEMENT being disconnected: a user who parks focus on
 * purpose (clicks empty space) is never focus-stolen, because their last control is still in the
 * DOM. A successful restore fires focusin, which re-records onto the newly focused control — so
 * the record can't go stale; an unsuccessful one (the action row portals in a LATER commit than
 * the unmount) simply retries on that commit.
 */
export function useTransitionFocusRestore(rootRef: React.RefObject<HTMLElement | null>) {
    const focusedControlRef = useRef<FocusedControl | null>(null);

    useEffect(() => {
        const root = rootRef.current;
        if (!root) {
            return;
        }
        // Every focus move inside the wizard re-records, so the ref always describes where focus
        // is RIGHT NOW, never a stale control the user left. A focused text field carries no
        // testid of its own — its closest testid'd ancestor (the card container) is recorded as a
        // disconnection SENTINEL: Escape from the field remounts the whole card, and without the
        // sentinel that unmount would go undetected. resolveFocusTarget never focuses the
        // container itself (canFocus rejects it) — the bar primary takes it instead.
        const onFocusIn = (event: FocusEvent) => {
            const target = event.target instanceof HTMLElement ? event.target : null;
            const recorded = target?.closest<HTMLElement>('[data-testid]') ?? null;
            const testId = recorded?.getAttribute('data-testid');
            focusedControlRef.current = recorded && testId ? { element: recorded, testId } : null;
        };
        root.addEventListener('focusin', onFocusIn);
        return () => root.removeEventListener('focusin', onFocusIn);
    }, [rootRef]);

    // A MutationObserver (not a render-driven effect) does the restoring: the unmount that
    // strands focus can happen in a CHILD-only commit this wizard never re-renders for —
    // entering/leaving the revisit view is stage-local state, and the replacement action row
    // portals in yet another child commit. Watching the DOM directly catches every transition
    // regardless of which component committed it, and naturally retries when the replacement
    // control appears a mutation later. No feedback loop: a successful restore DOES mutate the
    // subtree (MUI's focus ripple), but its focusin dispatches synchronously — re-recording onto
    // the now-connected control — before the observer's microtask-scheduled callback runs.
    useEffect(() => {
        const root = rootRef.current;
        if (!root) {
            return;
        }
        const restoreIfOrphaned = () => {
            const lost = focusedControlRef.current;
            if (!lost || lost.element.isConnected || !isFocusParked(document)) {
                return;
            }
            resolveFocusTarget(domLookup(root), lost.testId)?.focus();
        };
        const observer = new MutationObserver(restoreIfOrphaned);
        observer.observe(root, { childList: true, subtree: true });
        return () => observer.disconnect();
    }, [rootRef]);
}

/** Focus fell back to the page itself — nothing is actively focused. */
function isFocusParked(doc: Document): boolean {
    return doc.activeElement === doc.body || doc.activeElement === null;
}
