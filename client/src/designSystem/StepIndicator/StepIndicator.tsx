import { clsx } from 'clsx';
import type { ReactNode } from 'react';
import styles from './StepIndicator.module.css';

export type Step = {
    key: string;
    label: ReactNode;
};

type StepIndicatorProps = {
    steps: readonly Step[];
    /** Index of the current step. */
    activeIndex: number;
    /** Makes each step a button. */
    onStepSelected?: ((index: number) => void) | undefined;
    'aria-label'?: string | undefined;
    className?: string | undefined;
    'data-testid'?: string | undefined;
};

/**
 * A wizard's progress strip (MUI Stepper). An ordered list; the current step carries
 * `aria-current="step"`, earlier ones `data-complete`.
 */
export function StepIndicator({ steps, activeIndex, onStepSelected, className, ...rest }: StepIndicatorProps) {
    return (
        <ol {...rest} className={clsx(styles.steps, className)}>
            {steps.map((step, index) => (
                <li
                    key={step.key}
                    className={styles.step}
                    data-complete={index < activeIndex || undefined}
                    data-active={index === activeIndex || undefined}
                    aria-current={index === activeIndex ? 'step' : undefined}
                >
                    <StepContent index={index} label={step.label} onStepSelected={onStepSelected} />
                </li>
            ))}
        </ol>
    );
}

function StepContent({ index, label, onStepSelected }: { index: number; label: ReactNode; onStepSelected: StepIndicatorProps['onStepSelected'] }) {
    const content = (
        <>
            <span className={styles.marker} aria-hidden="true">
                {index + 1}
            </span>
            <span className={styles.label}>{label}</span>
        </>
    );
    if (!onStepSelected) return <span className={styles.content}>{content}</span>;
    return (
        <button type="button" data-interactive="" className={styles.content} onClick={() => onStepSelected(index)}>
            {content}
        </button>
    );
}
