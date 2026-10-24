import { useMemo } from 'react';
import { Checkbox, Chip, Text, TextField, ToggleGroup } from '../../designSystem';
import { EMPTY_USAGE_INDEX, rankByUsage, type UsageIndex } from '../../lib/entityUsage';
import { sortByName } from '../../lib/sortByName';
import type { EnergyLevel, StoredPerson, StoredWorkContext } from '../../types/MyDB';
import { CollapsibleChipGroup } from '../pickers/CollapsibleChipGroup';
import { DateField } from '../pickers/DateField';
import { FieldSection } from './FieldSection';
import styles from './NextActionFields.module.css';
import type { NextActionFormState } from './types';

interface Props {
    value: NextActionFormState;
    onChange: (patch: Partial<NextActionFormState>) => void;
    workContexts: StoredWorkContext[];
    people: StoredPerson[];
    /** Ranks the chip clouds most-used-first and drives their collapse; omit for alphabetical-only (stories/tests). */
    usage?: UsageIndex | undefined;
    /** Weekly review: pair the narrow controls into two columns so the whole item fits without scrolling. */
    dense?: boolean | undefined;
}

const ENERGY_OPTIONS: { value: EnergyLevel; label: string }[] = [
    { value: 'low', label: 'Low' },
    { value: 'medium', label: 'Medium' },
    { value: 'high', label: 'High' },
];

export function NextActionFields({ value, onChange, workContexts, people, usage = EMPTY_USAGE_INDEX, dense = false }: Props) {
    function toggleWorkContext(id: string) {
        const ids = value.workContextIds.includes(id) ? value.workContextIds.filter((x) => x !== id) : [...value.workContextIds, id];
        onChange({ workContextIds: ids });
    }

    function togglePerson(id: string) {
        const ids = value.peopleIds.includes(id) ? value.peopleIds.filter((x) => x !== id) : [...value.peopleIds, id];
        onChange({ peopleIds: ids });
    }

    // Collapsed pickers show the most-used chips first; expanded shows all A→Z (see CollapsibleChipGroup).
    const rankedContexts = useMemo(() => rankByUsage(workContexts, usage.contexts), [workContexts, usage.contexts]);
    const alphabeticalContexts = useMemo(() => sortByName(workContexts), [workContexts]);
    const rankedPeople = useMemo(() => rankByUsage(people, usage.people), [people, usage.people]);
    const alphabeticalPeople = useMemo(() => sortByName(people), [people]);
    const selectedContextIds = useMemo(() => new Set(value.workContextIds), [value.workContextIds]);
    const selectedPeopleIds = useMemo(() => new Set(value.peopleIds), [value.peopleIds]);
    const fullSpan = dense ? styles.fullSpan : undefined;

    return (
        <div className={styles.root} data-dense={dense || undefined}>
            <div className={styles.fields}>
                {/* Tickler field shown first — "ignoreBefore" hides the item until that date.
                Placing it at the top makes the snooze intent explicit before filling other fields. */}
                <div>
                    <Text as="span" variant="caption" tone="secondary" className={styles.caption}>
                        Tickler — hide until
                    </Text>
                    {/* The explainer costs a full line; in the review the label alone carries it. */}
                    {!dense && (
                        <Text as="span" variant="caption" tone="secondary" className={styles.explainer}>
                            Item stays hidden from Next Actions until this date
                        </Text>
                    )}
                    <DateField accessibleName="Tickler date" value={value.ignoreBefore} onChange={(ignoreBefore) => onChange({ ignoreBefore })} />
                </div>
                {/* The two dates sit together, so the dense grid can pair them on one row. */}
                <DateField label="Expected by" value={value.expectedBy} onChange={(expectedBy) => onChange({ expectedBy })} />
                {workContexts.length > 0 && (
                    <FieldSection label="Work contexts" className={fullSpan}>
                        <CollapsibleChipGroup
                            ranked={rankedContexts}
                            alphabetical={alphabeticalContexts}
                            selectedIds={selectedContextIds}
                            keyOf={(ctx) => ctx._id}
                            testId="editorWorkContextChip"
                            renderChip={(ctx) => (
                                <Chip
                                    label={ctx.name}
                                    data-testid="editorWorkContextChip"
                                    variant="outline"
                                    selected={value.workContextIds.includes(ctx._id)}
                                    onClick={() => toggleWorkContext(ctx._id)}
                                />
                            )}
                        />
                    </FieldSection>
                )}
                {people.length > 0 && (
                    <FieldSection label="People" className={fullSpan}>
                        <CollapsibleChipGroup
                            ranked={rankedPeople}
                            alphabetical={alphabeticalPeople}
                            selectedIds={selectedPeopleIds}
                            keyOf={(p) => p._id}
                            testId="editorPersonChip"
                            renderChip={(p) => (
                                <Chip
                                    label={p.name}
                                    data-testid="editorPersonChip"
                                    variant="outline"
                                    selected={value.peopleIds.includes(p._id)}
                                    onClick={() => togglePerson(p._id)}
                                />
                            )}
                        />
                    </FieldSection>
                )}
                <FieldSection label="Energy">
                    {/* No energy is a valid choice: pressing the active level clears it. */}
                    <ToggleGroup allowDeselect value={value.energy} onValueChange={(energy) => onChange({ energy })} options={ENERGY_OPTIONS} />
                </FieldSection>
                <TextField
                    label="Time estimate (min)"
                    value={value.time}
                    onChange={(e) => onChange({ time: e.target.value })}
                    type="number"
                    className={styles.timeField}
                    inputProps={{ min: 1 }}
                />
                <Checkbox checked={value.urgent} onCheckedChange={(urgent) => onChange({ urgent })} label="Urgent" />
            </div>
        </div>
    );
}
