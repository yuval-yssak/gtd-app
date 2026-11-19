import { Pencil } from 'lucide-react';
import { useId } from 'react';
import { IconButton, Text } from '../../designSystem';
import type { ItemFact } from '../itemFactsLogic';
import styles from './ItemDetailsSummary.module.css';

export const EDIT_DETAILS_LABEL = 'Edit details';
export const NO_DETAILS_TEXT = 'No details set';

interface ItemDetailsSummaryProps {
    facts: ItemFact[];
    /** Swaps the summary for the full detail form, in place. */
    onEditRequested: () => void;
}

/**
 * Read-only face of an item's detail form for the weekly review: only the filled fields, flowing
 * inline so a typical next action takes one or two lines instead of the form's seven rows. The
 * pencil is the only way into the form, like the brief and notes beside it.
 */
export function ItemDetailsSummary({ facts, onEditRequested }: ItemDetailsSummaryProps) {
    const headingId = useId();
    return (
        <section className={styles.summary} aria-labelledby={headingId} data-testid="itemDetailsSummary">
            <Text as="h2" id={headingId} variant="caption" tone="secondary" weight="semibold" className="srOnly">
                Details
            </Text>
            {facts.length > 0 ? (
                <dl className={styles.facts}>
                    {facts.map((fact) => (
                        <div key={fact.label} className={styles.fact} data-testid="itemDetailsFact">
                            <Text as="dt" variant="caption" tone="secondary">
                                {fact.label}
                            </Text>
                            <Text as="dd" variant="bodySm">
                                {fact.value}
                            </Text>
                        </div>
                    ))}
                </dl>
            ) : (
                <Text variant="bodySm" tone="secondary" className={styles.empty}>
                    {NO_DETAILS_TEXT}
                </Text>
            )}
            <IconButton size="sm" aria-label={EDIT_DETAILS_LABEL} onClick={onEditRequested} data-testid="editDetailsButton">
                <Pencil />
            </IconButton>
        </section>
    );
}
