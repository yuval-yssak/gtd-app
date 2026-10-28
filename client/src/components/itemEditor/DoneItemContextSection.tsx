import { clsx } from 'clsx';
import { type ComponentProps, useId } from 'react';
import { Text } from '../../designSystem';
import type { DoneItemContext } from '../doneItemContextLogic';
import styles from './DoneItemContextSection.module.css';

interface DoneItemContextSectionProps extends ComponentProps<'section'> {
    context: DoneItemContext;
}

/** Read-only "what it was" panel on a done item: its prior status and the fields that mattered there. */
export function DoneItemContextSection({ context, className, ...rest }: DoneItemContextSectionProps) {
    const headingId = useId();
    return (
        <section aria-labelledby={headingId} data-testid="doneItemContext" {...rest} className={clsx(styles.section, className)}>
            <Text id={headingId} as="h2" variant="caption" tone="secondary" weight="semibold" className={styles.heading}>
                Before it was done
            </Text>
            {context.statusLabel && (
                <Text variant="bodySm" weight="medium" data-testid="doneItemContextStatus">
                    {context.statusLabel}
                    {/* Items completed before the status was recorded: deduced from their leftover fields. */}
                    {context.isInferred && (
                        <Text as="span" variant="caption" tone="secondary">
                            {' '}
                            · inferred from its details
                        </Text>
                    )}
                </Text>
            )}
            {context.facts.length > 0 && (
                <dl className={styles.facts}>
                    {context.facts.map((fact) => (
                        <div key={fact.label} className={styles.fact} data-testid="doneItemContextFact">
                            <Text as="dt" variant="caption" tone="secondary">
                                {fact.label}
                            </Text>
                            <Text as="dd" variant="bodySm">
                                {fact.value}
                            </Text>
                        </div>
                    ))}
                </dl>
            )}
        </section>
    );
}
