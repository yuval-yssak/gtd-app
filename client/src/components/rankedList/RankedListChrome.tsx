import { useMemo } from 'react';
import { Toast } from '../../designSystem';
import type { RankedListApi } from '../../hooks/useRankedList';
import { isApplePlatform } from '../../lib/platformKeys';
import type { RowActionName } from '../../lib/rowShortcuts';
import { MoveToSheet } from '../nextActions/MoveToSheet';
import { reorderHintText } from './rankedListHint';

interface Props {
    ranked: RankedListApi;
    /** The row letters this list answers to (named in the screen-reader hint). */
    actions: readonly RowActionName[];
    /** One section of the list, as the hint names it: "day" (dated lists) or "list". */
    sectionNoun: string;
    /** Test id of the polite announcer — pages keep their own so specs can tell them apart. */
    liveTestId: string;
}

/** The parts of a ranked list that are not rows: its keyboard hints, the reorder announcer, the failure toast and the Move to sheet. */
export function RankedListChrome({ ranked, actions, sectionNoun, liveTestId }: Props) {
    const isApple = useMemo(isApplePlatform, []);
    const { key, ...sheet } = ranked.moveToSheet;
    return (
        <>
            <span id={ranked.hintIds.list} className="srOnly">
                {reorderHintText(isApple, actions, sectionNoun)}
            </span>
            <span id={ranked.hintIds.row} className="srOnly">
                Space to reorder, Arrow Right for the row’s buttons.
            </span>
            <div aria-live="polite" className="srOnly" data-testid={liveTestId}>
                {ranked.drag.liveText}
            </div>
            <Toast open={ranked.drag.error !== null} tone="error" autoHideDuration={4000} onClose={ranked.drag.clearError} message={ranked.drag.error ?? ''} />
            <MoveToSheet key={key} {...sheet} />
        </>
    );
}
