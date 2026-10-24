import { useMemo } from 'react';
import { Checkbox, Chip, Select, type SelectOption, Switch, Text, TextField, ToggleGroup } from '../../designSystem';
import type { CalendarOption } from '../../hooks/useCalendarOptions';
import { rankByUsage, type UsageIndex } from '../../lib/entityUsage';
import { sortByName } from '../../lib/sortByName';
import type { EnergyLevel, StoredPerson, StoredWorkContext } from '../../types/MyDB';
import { FieldSection } from '../clarify/FieldSection';
import { CollapsibleChipGroup } from '../pickers/CollapsibleChipGroup';
import { DateField } from '../pickers/DateField';
import { TimeField } from '../pickers/TimeField';
import { FrequencyPicker } from '../routines/FrequencyPicker';
import styles from './RoutineEditorBody.module.css';
import type { EndsMode, FormState } from './routineFormState';

export interface RoutineScheduleFieldsProps {
    form: FormState;
    onPatch: (patch: Partial<FormState>) => void;
    calendarOptions: CalendarOption[];
    /** Picker option pools — callers scope these to the owning account before passing them in. */
    workContexts: StoredWorkContext[];
    people: StoredPerson[];
    /** Ranks the chip clouds most-used-first and drives their collapse (see CollapsibleChipGroup). */
    usage: UsageIndex;
    /** Remount key for FrequencyPicker — it seeds internal state from `value` once, so hosts bump
     *  this when they replace the rrule out-of-band (live merge, adopt-theirs). */
    frequencyKey: string;
    /** Ended calendar routines lock every schedule field (title/notes stay editable in the host). */
    disabled?: boolean;
}

const ROUTINE_TYPE_OPTIONS: { value: FormState['routineType']; label: string }[] = [
    { value: 'nextAction', label: 'Next Action' },
    { value: 'calendar', label: 'Calendar' },
];

const ENDS_OPTIONS: { value: EndsMode; label: string }[] = [
    { value: 'never', label: 'Never' },
    { value: 'onDate', label: 'On date' },
    { value: 'afterN', label: 'After N' },
];

const ENERGY_OPTIONS: { value: EnergyLevel; label: string }[] = [
    { value: 'low', label: 'Low' },
    { value: 'medium', label: 'Medium' },
    { value: 'high', label: 'High' },
];

/**
 * The routine form minus title/notes: type, frequency, start date, ends, and the per-type
 * template/calendar sections. Shared between RoutineEditorBody (which adds title/notes, autosave,
 * account picker, and the save dispatch) and the item editor's clarify-to-routine destination
 * (which reuses the item's own title/notes fields).
 */
export function RoutineScheduleFields({
    form,
    onPatch,
    calendarOptions,
    workContexts,
    people,
    usage,
    frequencyKey,
    disabled = false,
}: RoutineScheduleFieldsProps) {
    function toggleWorkContext(id: string) {
        const ids = form.workContextIds.includes(id) ? form.workContextIds.filter((x) => x !== id) : [...form.workContextIds, id];
        onPatch({ workContextIds: ids });
    }

    function togglePerson(id: string) {
        const ids = form.peopleIds.includes(id) ? form.peopleIds.filter((x) => x !== id) : [...form.peopleIds, id];
        onPatch({ peopleIds: ids });
    }

    return (
        <>
            <FieldSection label="Type">
                <ToggleGroup
                    size="sm"
                    value={form.routineType}
                    disabled={disabled}
                    onValueChange={(routineType) => onPatch({ routineType })}
                    options={ROUTINE_TYPE_OPTIONS}
                />
            </FieldSection>

            <FieldSection label="Frequency">
                {/* key resets FrequencyPicker internal state when the host swaps the rrule seed */}
                <FrequencyPicker
                    key={frequencyKey}
                    value={form.rrule}
                    recurrenceAnchor={form.recurrenceAnchor}
                    onChange={(rrule, recurrenceAnchor) => onPatch({ rrule, recurrenceAnchor })}
                    disabled={disabled}
                />
            </FieldSection>

            <DateField
                label="Start date"
                value={form.startDate}
                onChange={(startDate) => onPatch({ startDate })}
                helperText="Optional — anchors the schedule. Leave empty to start today."
                disabled={disabled}
            />

            <EndsFields form={form} onPatch={onPatch} disabled={disabled} />

            {form.routineType === 'calendar' ? (
                <CalendarSettingsFields form={form} onPatch={onPatch} calendarOptions={calendarOptions} disabled={disabled} />
            ) : (
                <TemplateFields
                    form={form}
                    workContexts={workContexts}
                    people={people}
                    usage={usage}
                    onPatch={onPatch}
                    onToggleWorkContext={toggleWorkContext}
                    onTogglePerson={togglePerson}
                />
            )}
        </>
    );
}

// ── Calendar-specific fields ───────────────────────────────────────────────────

function CalendarSettingsFields({
    form,
    onPatch,
    calendarOptions,
    disabled,
}: {
    form: FormState;
    onPatch: (patch: Partial<FormState>) => void;
    calendarOptions: CalendarOption[];
    disabled?: boolean;
}) {
    const showPicker = calendarOptions.length > 1;

    return (
        // A locked (ended) routine passes `disabled` to every control: the Switch and Select render
        // spans that a native <fieldset disabled> would not reach. Each draws its own disabled look.
        <div className={styles.typeSection}>
            <Text variant="caption" tone="secondary" weight="semibold">
                Calendar event settings
            </Text>
            {/* All-day toggle hides the time + duration inputs below (they're meaningless for
                all-day events). Saving with allDay=true emits `{ allDay: true }` as the template. */}
            <Switch
                label="All day"
                checked={form.allDay}
                onCheckedChange={(allDay) => onPatch({ allDay })}
                disabled={disabled}
                data-testid="routineAllDayToggle"
            />
            {!form.allDay && (
                <div className={styles.timeRow}>
                    <TimeField label="Start time" value={form.timeOfDay} onChange={(timeOfDay) => onPatch({ timeOfDay })} required disabled={disabled} />
                    <TextField
                        label="Duration (min)"
                        type="number"
                        value={form.duration}
                        onChange={(e) => onPatch({ duration: e.target.value })}
                        size="sm"
                        className={styles.narrowInput}
                        disabled={disabled}
                        inputProps={{ min: 1 }}
                    />
                </div>
            )}
            {/* Only show picker when user has 2+ calendars — with 0-1 there's nothing to choose. */}
            {showPicker && (
                <CalendarPicker
                    calendarOptions={calendarOptions}
                    value={form.calendarSyncConfigId}
                    onChange={(v) => onPatch({ calendarSyncConfigId: v })}
                    disabled={disabled}
                />
            )}
        </div>
    );
}

/** Picker options: Default first, then each account's calendars — grouped under the account once there are several. */
export function calendarPickerOptions(calendarOptions: CalendarOption[]): SelectOption<string>[] {
    // A Set keeps insertion order: accounts are listed in the order they first appear.
    const accountEmails = [...new Set(calendarOptions.map((option) => option.accountEmail))];
    const isGrouped = accountEmails.length > 1;
    const calendarRows = accountEmails.flatMap((email) =>
        calendarOptions
            .filter((option) => option.accountEmail === email)
            .map((option) => ({ value: option.configId, label: option.displayName, ...(isGrouped ? { group: email } : {}) })),
    );
    return [{ value: '', label: 'Default' }, ...calendarRows];
}

interface CalendarPickerProps {
    calendarOptions: CalendarOption[];
    value: string;
    onChange: (v: string) => void;
    disabled: boolean | undefined;
}

function CalendarPicker({ calendarOptions, value, onChange, disabled }: CalendarPickerProps) {
    return <Select label="Calendar" size="sm" value={value} onValueChange={onChange} options={calendarPickerOptions(calendarOptions)} disabled={disabled} />;
}

// ── Ends section ──────────────────────────────────────────────────────────────

function EndsFields({ form, onPatch, disabled }: { form: FormState; onPatch: (patch: Partial<FormState>) => void; disabled?: boolean }) {
    return (
        <FieldSection label="Ends" disabled={disabled}>
            <ToggleGroup size="sm" value={form.endsMode} disabled={disabled} onValueChange={(endsMode) => onPatch({ endsMode })} options={ENDS_OPTIONS} />
            {form.endsMode === 'onDate' && (
                <DateField
                    label="End date"
                    value={form.endsDate}
                    onChange={(endsDate) => onPatch({ endsDate })}
                    disabled={disabled}
                    className={styles.endDate}
                />
            )}
            {form.endsMode === 'afterN' && (
                <div className={styles.ticklerRow}>
                    <Text as="span" variant="bodySm">
                        After
                    </Text>
                    <TextField
                        type="number"
                        size="sm"
                        className={styles.narrowInput}
                        value={form.endsCount}
                        onChange={(e) => onPatch({ endsCount: e.target.value })}
                        inputProps={{ min: 1, 'aria-label': 'Number of occurrences' }}
                    />
                    <Text as="span" variant="bodySm">
                        occurrences
                    </Text>
                </div>
            )}
        </FieldSection>
    );
}

// ── Next-action template fields ────────────────────────────────────────────────

interface TemplateFieldsProps {
    form: FormState;
    workContexts: StoredWorkContext[];
    people: StoredPerson[];
    /** Ranks the chip clouds most-used-first and drives their collapse (see CollapsibleChipGroup). */
    usage: UsageIndex;
    onPatch: (patch: Partial<FormState>) => void;
    onToggleWorkContext: (id: string) => void;
    onTogglePerson: (id: string) => void;
}

function TemplateFields({ form, workContexts, people, usage, onPatch, onToggleWorkContext, onTogglePerson }: TemplateFieldsProps) {
    // Memoized like NextActionFields — without these every keystroke in the surrounding form
    // re-sorts both chip clouds.
    const rankedContexts = useMemo(() => rankByUsage(workContexts, usage.contexts), [workContexts, usage.contexts]);
    const alphabeticalContexts = useMemo(() => sortByName(workContexts), [workContexts]);
    const rankedPeople = useMemo(() => rankByUsage(people, usage.people), [people, usage.people]);
    const alphabeticalPeople = useMemo(() => sortByName(people), [people]);
    const selectedContextIds = useMemo(() => new Set(form.workContextIds), [form.workContextIds]);
    const selectedPeopleIds = useMemo(() => new Set(form.peopleIds), [form.peopleIds]);
    return (
        <div className={styles.typeSection}>
            <Text variant="caption" tone="secondary" weight="semibold">
                Template fields (copied onto each generated item)
            </Text>
            {workContexts.length > 0 && (
                <FieldSection label="Work contexts">
                    <CollapsibleChipGroup
                        ranked={rankedContexts}
                        alphabetical={alphabeticalContexts}
                        selectedIds={selectedContextIds}
                        keyOf={(ctx) => ctx._id}
                        testId="routineTemplateWorkContextChip"
                        className={styles.chipGroup}
                        renderChip={(ctx) => (
                            <Chip
                                label={ctx.name}
                                data-testid="routineTemplateWorkContextChip"
                                selected={form.workContextIds.includes(ctx._id)}
                                onClick={() => onToggleWorkContext(ctx._id)}
                            />
                        )}
                    />
                </FieldSection>
            )}
            {people.length > 0 && (
                <FieldSection label="People">
                    <CollapsibleChipGroup
                        ranked={rankedPeople}
                        alphabetical={alphabeticalPeople}
                        selectedIds={selectedPeopleIds}
                        keyOf={(p) => p._id}
                        testId="routineTemplatePersonChip"
                        className={styles.chipGroup}
                        renderChip={(p) => (
                            <Chip
                                label={p.name}
                                data-testid="routineTemplatePersonChip"
                                selected={form.peopleIds.includes(p._id)}
                                onClick={() => onTogglePerson(p._id)}
                            />
                        )}
                    />
                </FieldSection>
            )}
            <FieldSection label="Energy">
                <ToggleGroup allowDeselect size="sm" value={form.energy} onValueChange={(energy) => onPatch({ energy })} options={ENERGY_OPTIONS} />
            </FieldSection>
            <TextField
                label="Time estimate (min)"
                value={form.time}
                onChange={(e) => onPatch({ time: e.target.value })}
                type="number"
                size="sm"
                className={styles.narrowInput}
                inputProps={{ min: 1 }}
            />
            <Checkbox checked={form.urgent} onCheckedChange={(urgent) => onPatch({ urgent })} label="Urgent" />
        </div>
    );
}
