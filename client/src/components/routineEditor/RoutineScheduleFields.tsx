import Box from '@mui/material/Box';
import Checkbox from '@mui/material/Checkbox';
import Chip from '@mui/material/Chip';
import FormControlLabel from '@mui/material/FormControlLabel';
import FormLabel from '@mui/material/FormLabel';
import MenuItem from '@mui/material/MenuItem';
import Stack from '@mui/material/Stack';
import Switch from '@mui/material/Switch';
import TextField from '@mui/material/TextField';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import Typography from '@mui/material/Typography';
import { useMemo } from 'react';
import type { CalendarOption } from '../../hooks/useCalendarOptions';
import { rankByUsage, type UsageIndex } from '../../lib/entityUsage';
import { sortByName } from '../../lib/sortByName';
import type { EnergyLevel, StoredPerson, StoredWorkContext } from '../../types/MyDB';
import { CollapsibleChipGroup } from '../pickers/CollapsibleChipGroup';
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
            <Box>
                <FormLabel>
                    <Typography
                        variant="caption"
                        className={styles.sectionLabel}
                        sx={{
                            color: 'text.secondary',
                        }}
                    >
                        Type
                    </Typography>
                </FormLabel>
                <ToggleButtonGroup
                    exclusive
                    size="small"
                    value={form.routineType}
                    disabled={disabled}
                    onChange={(_e, val: 'nextAction' | 'calendar' | null) => {
                        if (val) onPatch({ routineType: val });
                    }}
                >
                    <ToggleButton value="nextAction">Next Action</ToggleButton>
                    <ToggleButton value="calendar">Calendar</ToggleButton>
                </ToggleButtonGroup>
            </Box>

            <Box>
                <FormLabel>
                    <Typography
                        variant="caption"
                        className={styles.sectionLabel}
                        sx={{
                            color: 'text.secondary',
                        }}
                    >
                        Frequency
                    </Typography>
                </FormLabel>
                {/* key resets FrequencyPicker internal state when the host swaps the rrule seed */}
                <FrequencyPicker
                    key={frequencyKey}
                    value={form.rrule}
                    recurrenceAnchor={form.recurrenceAnchor}
                    onChange={(rrule, recurrenceAnchor) => onPatch({ rrule, recurrenceAnchor })}
                    disabled={disabled}
                />
            </Box>

            <TextField
                type="date"
                label="Start date"
                size="small"
                value={form.startDate}
                onChange={(e) => onPatch({ startDate: e.target.value })}
                slotProps={{ inputLabel: { shrink: true } }}
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
        <Stack
            sx={[
                {
                    gap: 1.5,
                },
                disabled ? { opacity: 0.5, pointerEvents: 'none' } : false,
            ]}
        >
            <Typography
                variant="caption"
                sx={{
                    color: 'text.secondary',
                    fontWeight: 600,
                }}
            >
                Calendar event settings
            </Typography>
            {/* All-day toggle hides the time + duration inputs below (they're meaningless for
                all-day events). Saving with allDay=true emits `{ allDay: true }` as the template. */}
            <FormControlLabel
                control={
                    <Switch checked={form.allDay} onChange={(e) => onPatch({ allDay: e.target.checked })} slotProps={{ input: { 'aria-label': 'All day' } }} />
                }
                label={<Typography variant="body2">All day</Typography>}
                data-testid="routineAllDayToggle"
            />
            {!form.allDay && (
                <Stack
                    direction="row"
                    sx={{
                        gap: 2,
                        alignItems: 'center',
                    }}
                >
                    <TextField
                        label="Start time"
                        type="time"
                        value={form.timeOfDay}
                        onChange={(e) => onPatch({ timeOfDay: e.target.value })}
                        size="small"
                        required
                        slotProps={{ inputLabel: { shrink: true } }}
                    />
                    <TextField
                        label="Duration (min)"
                        type="number"
                        value={form.duration}
                        onChange={(e) => onPatch({ duration: e.target.value })}
                        size="small"
                        className={styles.narrowInput}
                        slotProps={{ htmlInput: { min: 1 } }}
                    />
                </Stack>
            )}
            {/* Only show picker when user has 2+ calendars — with 0-1 there's nothing to choose. */}
            {showPicker && (
                <CalendarPicker calendarOptions={calendarOptions} value={form.calendarSyncConfigId} onChange={(v) => onPatch({ calendarSyncConfigId: v })} />
            )}
        </Stack>
    );
}

/** Groups calendar options by owning account so the picker shows one section per account. */
function groupCalendarsByAccount(calendarOptions: CalendarOption[]): Map<string, CalendarOption[]> {
    const groups = new Map<string, CalendarOption[]>();
    for (const opt of calendarOptions) {
        const list = groups.get(opt.accountEmail);
        if (list) {
            list.push(opt);
            continue;
        }
        groups.set(opt.accountEmail, [opt]);
    }
    return groups;
}

function CalendarPicker({ calendarOptions, value, onChange }: { calendarOptions: CalendarOption[]; value: string; onChange: (v: string) => void }) {
    const grouped = groupCalendarsByAccount(calendarOptions);
    const showAccountHeaders = grouped.size > 1;
    return (
        <TextField select label="Calendar" value={value} onChange={(e) => onChange(e.target.value)} size="small">
            <MenuItem value="">Default</MenuItem>
            {Array.from(grouped.entries()).flatMap(([email, opts]) => [
                ...(showAccountHeaders
                    ? [
                          <MenuItem key={`hdr-${email}`} aria-disabled value="" tabIndex={-1} className={styles.accountHeader}>
                              {email}
                          </MenuItem>,
                      ]
                    : []),
                ...opts.map((opt) => (
                    <MenuItem key={opt.configId} value={opt.configId}>
                        {opt.displayName}
                    </MenuItem>
                )),
            ])}
        </TextField>
    );
}

// ── Ends section ──────────────────────────────────────────────────────────────

function EndsFields({ form, onPatch, disabled }: { form: FormState; onPatch: (patch: Partial<FormState>) => void; disabled?: boolean }) {
    return (
        <Box sx={disabled ? { opacity: 0.5, pointerEvents: 'none' } : undefined}>
            <FormLabel>
                <Typography
                    variant="caption"
                    className={styles.sectionLabel}
                    sx={{
                        color: 'text.secondary',
                    }}
                >
                    Ends
                </Typography>
            </FormLabel>
            <ToggleButtonGroup
                exclusive
                size="small"
                value={form.endsMode}
                onChange={(_e, val: EndsMode | null) => {
                    if (val) onPatch({ endsMode: val });
                }}
            >
                <ToggleButton value="never">Never</ToggleButton>
                <ToggleButton value="onDate">On date</ToggleButton>
                <ToggleButton value="afterN">After N</ToggleButton>
            </ToggleButtonGroup>
            {form.endsMode === 'onDate' && (
                <TextField
                    type="date"
                    size="small"
                    value={form.endsDate}
                    onChange={(e) => onPatch({ endsDate: e.target.value })}
                    sx={{ mt: 1, display: 'block' }}
                    slotProps={{ inputLabel: { shrink: true } }}
                    label="End date"
                />
            )}
            {form.endsMode === 'afterN' && (
                <div className={styles.ticklerRow}>
                    <Typography variant="body2">After</Typography>
                    <TextField
                        type="number"
                        size="small"
                        className={styles.narrowInput}
                        value={form.endsCount}
                        onChange={(e) => onPatch({ endsCount: e.target.value })}
                        slotProps={{ htmlInput: { min: 1 } }}
                    />
                    <Typography variant="body2">occurrences</Typography>
                </div>
            )}
        </Box>
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
        <Stack
            sx={{
                gap: 1.5,
            }}
        >
            <Typography
                variant="caption"
                sx={{
                    color: 'text.secondary',
                    fontWeight: 600,
                }}
            >
                Template fields (copied onto each generated item)
            </Typography>
            {workContexts.length > 0 && (
                <Box>
                    <FormLabel>
                        <Typography
                            variant="caption"
                            sx={{
                                color: 'text.secondary',
                            }}
                        >
                            Work contexts
                        </Typography>
                    </FormLabel>
                    <CollapsibleChipGroup
                        ranked={rankedContexts}
                        alphabetical={alphabeticalContexts}
                        selectedIds={selectedContextIds}
                        keyOf={(ctx) => ctx._id}
                        testId="routineTemplateWorkContextChip"
                        sx={{ mt: 0.5 }}
                        renderChip={(ctx) => (
                            <Chip
                                label={ctx.name}
                                data-testid="routineTemplateWorkContextChip"
                                size="small"
                                variant={form.workContextIds.includes(ctx._id) ? 'filled' : 'outlined'}
                                color={form.workContextIds.includes(ctx._id) ? 'primary' : 'default'}
                                onClick={() => onToggleWorkContext(ctx._id)}
                            />
                        )}
                    />
                </Box>
            )}
            {people.length > 0 && (
                <Box>
                    <FormLabel>
                        <Typography
                            variant="caption"
                            sx={{
                                color: 'text.secondary',
                            }}
                        >
                            People
                        </Typography>
                    </FormLabel>
                    <CollapsibleChipGroup
                        ranked={rankedPeople}
                        alphabetical={alphabeticalPeople}
                        selectedIds={selectedPeopleIds}
                        keyOf={(p) => p._id}
                        testId="routineTemplatePersonChip"
                        sx={{ mt: 0.5 }}
                        renderChip={(p) => (
                            <Chip
                                label={p.name}
                                data-testid="routineTemplatePersonChip"
                                size="small"
                                variant={form.peopleIds.includes(p._id) ? 'filled' : 'outlined'}
                                color={form.peopleIds.includes(p._id) ? 'primary' : 'default'}
                                onClick={() => onTogglePerson(p._id)}
                            />
                        )}
                    />
                </Box>
            )}
            <Box>
                <FormLabel>
                    <Typography
                        variant="caption"
                        sx={{
                            color: 'text.secondary',
                        }}
                    >
                        Energy
                    </Typography>
                </FormLabel>
                <ToggleButtonGroup
                    exclusive
                    size="small"
                    value={form.energy || null}
                    onChange={(_e, val: EnergyLevel | null) => onPatch({ energy: val ?? '' })}
                    sx={{ mt: 0.5 }}
                >
                    <ToggleButton value="low">Low</ToggleButton>
                    <ToggleButton value="medium">Medium</ToggleButton>
                    <ToggleButton value="high">High</ToggleButton>
                </ToggleButtonGroup>
            </Box>
            <TextField
                label="Time estimate (min)"
                value={form.time}
                onChange={(e) => onPatch({ time: e.target.value })}
                type="number"
                size="small"
                className={styles.narrowInput}
                slotProps={{ htmlInput: { min: 1 } }}
            />
            <Stack
                direction="row"
                sx={{
                    gap: 2,
                }}
            >
                <FormControlLabel
                    control={<Checkbox size="small" checked={form.urgent} onChange={(e) => onPatch({ urgent: e.target.checked })} />}
                    label={<Typography variant="body2">Urgent</Typography>}
                />
                <FormControlLabel
                    control={<Checkbox size="small" checked={form.focus} onChange={(e) => onPatch({ focus: e.target.checked })} />}
                    label={<Typography variant="body2">In focus</Typography>}
                />
            </Stack>
        </Stack>
    );
}
