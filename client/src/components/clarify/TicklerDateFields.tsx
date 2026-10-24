import { DateField } from '../pickers/DateField';
import styles from './TicklerDateFields.module.css';

/** The two deferral dates shared by waitingFor and somedayMaybe forms. */
export interface TicklerDates {
    expectedBy: string;
    ignoreBefore: string;
}

interface Props {
    value: TicklerDates;
    onChange: (patch: Partial<TicklerDates>) => void;
}

/**
 * `Expected by` (deadline) + `Ignore before` (tickler) date inputs, shared by the waitingFor and
 * somedayMaybe forms. Both statuses participate in the tickler (TICKLER_STATUSES), so both expose it.
 */
export function TicklerDateFields({ value, onChange }: Props) {
    return (
        <div className={styles.dates}>
            <DateField label="Expected by" value={value.expectedBy} onChange={(expectedBy) => onChange({ expectedBy })} />
            <DateField label="Ignore before" value={value.ignoreBefore} onChange={(ignoreBefore) => onChange({ ignoreBefore })} />
        </div>
    );
}
