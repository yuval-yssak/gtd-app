import { clsx } from 'clsx';
import type { ReactNode } from 'react';
import styles from './StepIndicator.module.css';

export type Step = {
    key: string;
    label: ReactNode;
    /** Overrides the positional default (every step before the current one) — for a wizard walked in any order. */
    isComplete?: boolean | undefined;
};

type StepIndicatorProps = {
    steps: readonly Step[];
    /** Index of the current step. */
    activeIndex: number;
    /** Makes each step a button. */
    onStepSelected?: ((index: number) => void) | undefined;
    /** `data-testid` for each step button (only rendered with `onStepSelected`). */
    stepTestId?: string | undefined;
    /** `below` stacks each label under its marker (MUI `alternativeLabel`) — fits many steps in a narrow strip. */
    labelPlacement?: 'inline' | 'below' | undefined;
    'aria-label'?: string | undefined;
    className?: string | undefined;
    'data-testid'?: string | undefined;
};

/**
 * A wizard's progress strip (MUI Stepper). An ordered list; the current step carries
 * `aria-current="step"`, completed ones `data-complete`.
 */
export function StepIndicator({ steps, activeIndex, onStepSelected, stepTestId, labelPlacement = 'inline', className, ...rest }: StepIndicatorProps) {
    return (
        <ol {...rest} data-label-placement={labelPlacement} className={clsx(styles.steps, className)}>
            {steps.map((step, index) => (
                <li
                    key={step.key}
                    className={styles.step}
                    data-complete={(step.isComplete ?? index < activeIndex) || undefined}
                    data-active={index === activeIndex || undefined}
                    aria-current={index === activeIndex ? 'step' : undefined}
                >
                    <StepContent index={index} label={step.label} onStepSelected={onStepSelected} testId={stepTestId} />
                </li>
            ))}
        </ol>
    );
}

type StepContentProps = {
    index: number;
    label: ReactNode;
    onStepSelected: StepIndicatorProps['onStepSelected'];
    testId: string | undefined;
};

function StepContent({ index, label, onStepSelected, testId }: StepContentProps) {
    const content = (
        <>
            <span className={styles.marker} aria-hidden="true">
                {index + 1}
            </span>
            <span className={styles.label}>{label}</span>
        </>
    );
    if (!onStepSelected) {
        return <span className={styles.content}>{content}</span>;
    }
    return (
        <button type="button" data-interactive="" className={styles.content} onClick={() => onStepSelected(index)} data-testid={testId}>
            {content}
        </button>
    );
}
