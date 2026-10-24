import { Link } from '@tanstack/react-router';
import { Select, Text } from '../../designSystem';
import { sortByName } from '../../lib/sortByName';
import type { StoredPerson } from '../../types/MyDB';
import { TicklerDateFields } from './TicklerDateFields';
import type { WaitingForFormState } from './types';
import styles from './WaitingForFields.module.css';

interface Props {
    value: WaitingForFormState;
    onChange: (patch: Partial<WaitingForFormState>) => void;
    people: StoredPerson[];
}

export function WaitingForFields({ value, onChange, people }: Props) {
    const personOptions = [{ value: '', label: '— No one —' }, ...sortByName(people).map((person) => ({ value: person._id, label: person.name }))];
    return (
        <div className={styles.fields}>
            {/* The person is optional — a waitingFor item can be blocked on something other than a
                named contact (e.g. "waiting for a part to arrive"). The "— No one —" entry clears it. */}
            <Select
                label="Waiting for (optional)"
                value={value.waitingForPersonId}
                onValueChange={(waitingForPersonId) => onChange({ waitingForPersonId })}
                options={personOptions}
                className={styles.waitingForSelect}
            />
            {people.length === 0 && (
                <Text variant="bodySm" tone="secondary">
                    No people yet — add contacts in the{' '}
                    <Link to="/people" className={styles.peopleLink}>
                        People
                    </Link>{' '}
                    section to name who you're waiting on.
                </Text>
            )}
            <TicklerDateFields value={value} onChange={onChange} />
        </div>
    );
}
