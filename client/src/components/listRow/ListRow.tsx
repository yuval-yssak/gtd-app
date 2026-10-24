import { clsx } from 'clsx';
import type { ComponentProps, KeyboardEvent, MouseEvent, ReactNode } from 'react';
import { Text } from '../../designSystem';
import styles from './ListRow.module.css';

type ListRowProps = ComponentProps<'div'> & {
    /** Row-level buttons (Edit, Copy id, Move to…) — siblings of the row button, never inside it. */
    actions?: ReactNode | undefined;
    /** Draws the hairline under the row; the list leaves it off the last row of a section. */
    isDivided?: boolean | undefined;
};

/**
 * One item row of a list page: an optional leading slot (a drag handle), the row button, and its
 * actions. A plain element: the list item is the `<li>` around it (virtua's, or a ListRowShell `as="li"`).
 */
export function ListRow({ actions, isDivided = false, className, children, ...rest }: ListRowProps) {
    return (
        <div {...rest} className={clsx(styles.row, className)} data-divided={isDivided || undefined}>
            {children}
            {actions !== undefined && <div className={styles.actions}>{actions}</div>}
        </div>
    );
}

type ActivationEvent = MouseEvent<HTMLDivElement> | KeyboardEvent<HTMLDivElement>;

type ListRowButtonProps = Omit<ComponentProps<'div'>, 'onClick' | 'role'> & {
    /** Click, Enter or Space — the event carries the modifier keys (cmd/ctrl opens a new tab). */
    onActivate: (event: ActivationEvent) => void;
};

/**
 * The row's clickable body. A `div role="button"` rather than a `<button>`, at parity with the MUI
 * ListItemButton it replaces: rows hold their own controls (the routine indicator is a button), and an
 * HTML <button> cannot even contain one. The nested-interactive ARIA issue remains either way (a
 * button role makes its children presentational) — moving such controls beside the row is the real
 * fix, tracked rather than done in the facelift. Keys follow a
 * native button exactly — Enter on keydown, Space on keyup unless a keyup handler claimed it — which
 * the Next Actions grab mode relies on: Space there grabs and drops instead of opening the item.
 */
export function ListRowButton({ onActivate, onKeyDown, onKeyUp, className, tabIndex = 0, ...rest }: ListRowButtonProps) {
    return (
        // biome-ignore lint/a11y/useSemanticElements: MUI ListItemButton parity — an HTML <button> cannot hold the row's own buttons (see above)
        <div
            role="button"
            tabIndex={tabIndex}
            {...rest}
            className={clsx(styles.rowButton, className)}
            onClick={onActivate}
            onKeyDown={(e) => {
                onKeyDown?.(e);
                activateOnKeyDown(e, onActivate);
            }}
            onKeyUp={(e) => {
                onKeyUp?.(e);
                activateOnKeyUp(e, onActivate);
            }}
        />
    );
}

/** Keys that bubble up from a control inside the row belong to that control. */
const isOwnKey = (e: KeyboardEvent<HTMLDivElement>) => e.target === e.currentTarget;

function activateOnKeyDown(e: KeyboardEvent<HTMLDivElement>, onActivate: (event: ActivationEvent) => void) {
    if (!isOwnKey(e)) return;
    if (e.key === ' ') {
        e.preventDefault(); // Space must not scroll the page; it activates on keyup.
    } else if (e.key === 'Enter') {
        e.preventDefault();
        onActivate(e);
    }
}

function activateOnKeyUp(e: KeyboardEvent<HTMLDivElement>, onActivate: (event: ActivationEvent) => void) {
    if (isOwnKey(e) && e.key === ' ' && !e.defaultPrevented) onActivate(e);
}

type ListRowTextProps = {
    primary: ReactNode;
    secondary?: ReactNode | undefined;
};

/** The row's two lines: the title (with its chips) and a muted detail line under it. */
export function ListRowText({ primary, secondary }: ListRowTextProps) {
    return (
        <span className={styles.text}>
            <span className={styles.primary} data-testid="listRowPrimary">
                {primary}
            </span>
            {secondary !== undefined && (
                <Text as="span" variant="bodySm" tone="secondary" className={styles.secondary}>
                    {secondary}
                </Text>
            )}
        </span>
    );
}
