import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Checkbox from '@mui/material/Checkbox';
import Chip from '@mui/material/Chip';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import FormControlLabel from '@mui/material/FormControlLabel';
import FormLabel from '@mui/material/FormLabel';
import MenuItem from '@mui/material/MenuItem';
import Stack from '@mui/material/Stack';
import Switch from '@mui/material/Switch';
import TextField from '@mui/material/TextField';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import Typography from '@mui/material/Typography';
import dayjs from 'dayjs';
import type { IDBPDatabase } from 'idb';
import { useState } from 'react';
import { createNextCalendarItem, createNextRoutineItem } from '../../db/routineItemHelpers';
import { createRoutine, updateRoutine } from '../../db/routineMutations';
import { type CalendarOption, useCalendarOptions } from '../../hooks/useCalendarOptions';
import type { EnergyLevel, MyDB, StoredPerson, StoredRoutine, StoredWorkContext } from '../../types/MyDB';
import { FrequencyPicker } from './FrequencyPicker';
import styles from './RoutineDialog.module.css';

interface Props {
    db: IDBPDatabase<MyDB>;
    userId: string;
    workContexts: StoredWorkContext[];
    people: StoredPerson[];
    /** Pass an existing routine to edit it; omit to create a new one. */
    // exactOptionalPropertyTypes requires explicit `| undefined` when the value may be undefined
    routine?: StoredRoutine | undefined;
    onClose: () => void;
    onSaved: () => Promise<void>;
}

type EndsMode = 'never' | 'onDate' | 'afterN';

interface FormState {
    routineType: 'nextAction' | 'calendar';
    title: string;
    rrule: string; // base rrule without UNTIL/COUNT — those are stored in endsMode/endsDate/endsCount
    workContextIds: string[];
    peopleIds: string[];
    energy: EnergyLevel | '';
    time: string;
    focus: boolean;
    urgent: boolean;
    hasTickler: boolean;
    ticklerLeadDays: string;
    notes: string;
    timeOfDay: string; // HH:MM — calendar routines only
    duration: string; // minutes — calendar routines only
    calendarSyncConfigId: string; // empty = use default calendar
    endsMode: EndsMode;
    endsDate: string; // ISO date — used when endsMode === 'onDate'
    endsCount: string; // positive integer string — used when endsMode === 'afterN'
}

/** Strip UNTIL and COUNT from an rrule string so FrequencyPicker can parse the base frequency. */
function stripEndClauses(rruleStr: string): string {
    return rruleStr.replace(/;UNTIL=[^;]*/g, '').replace(/;COUNT=\d+/g, '');
}

/** Parse UNTIL/COUNT from an existing rrule string into EndsMode fields. */
function parseEndsFromRrule(rruleStr: string): { endsMode: EndsMode; endsDate: string; endsCount: string } {
    const untilMatch = rruleStr.match(/UNTIL=([^;]+)/);
    const countMatch = rruleStr.match(/COUNT=(\d+)/);
    // noUncheckedIndexedAccess: capture group [1] is string | undefined; fall back to '' to satisfy types
    if (untilMatch) {
        return { endsMode: 'onDate', endsDate: dayjs(untilMatch[1] ?? '').format('YYYY-MM-DD'), endsCount: '' };
    }
    if (countMatch) {
        return { endsMode: 'afterN', endsDate: '', endsCount: countMatch[1] ?? '' };
    }
    return { endsMode: 'never', endsDate: '', endsCount: '' };
}

/** Build the final rrule by appending UNTIL or COUNT to the base rrule from FrequencyPicker. */
function buildFinalRrule(baseRrule: string, endsMode: EndsMode, endsDate: string, endsCount: string): string {
    if (endsMode === 'onDate' && endsDate) {
        // UNTIL must be in UTC datetime format per RFC 5545. Construct directly from the ISO date
        // to avoid depending on the dayjs utc plugin (not loaded in this project).
        const until = `${endsDate.replace(/-/g, '')}T235959Z`;
        return `${baseRrule};UNTIL=${until}`;
    }
    if (endsMode === 'afterN' && endsCount) {
        return `${baseRrule};COUNT=${endsCount}`;
    }
    return baseRrule;
}

function initFormState(routine?: StoredRoutine): FormState {
    const ends = parseEndsFromRrule(routine?.rrule ?? '');
    return {
        routineType: routine?.routineType ?? 'nextAction',
        title: routine?.title ?? '',
        // Strip UNTIL/COUNT so FrequencyPicker only sees the base frequency parts
        rrule: stripEndClauses(routine?.rrule ?? 'FREQ=DAILY;INTERVAL=1'),
        workContextIds: routine?.template.workContextIds ?? [],
        peopleIds: routine?.template.peopleIds ?? [],
        energy: routine?.template.energy ?? '',
        time: routine?.template.time?.toString() ?? '',
        focus: routine?.template.focus ?? false,
        urgent: routine?.template.urgent ?? false,
        hasTickler: routine?.template.ticklerLeadDays !== undefined,
        ticklerLeadDays: routine?.template.ticklerLeadDays?.toString() ?? '0',
        notes: routine?.template.notes ?? '',
        timeOfDay: routine?.calendarItemTemplate?.timeOfDay ?? '09:00',
        duration: routine?.calendarItemTemplate?.duration?.toString() ?? '60',
        calendarSyncConfigId: routine?.calendarSyncConfigId ?? '',
        ...ends,
    };
}

/** Resolves calendarSyncConfigId + calendarIntegrationId from the form's selected config. */
function resolveCalendarLink(configId: string, options: CalendarOption[]): { calendarSyncConfigId?: string; calendarIntegrationId?: string } {
    const selected = options.find((o) => o.configId === configId);
    return selected ? { calendarSyncConfigId: selected.configId, calendarIntegrationId: selected.integrationId } : {};
}

function buildTemplate(form: FormState) {
    return {
        ...(form.workContextIds.length ? { workContextIds: form.workContextIds } : {}),
        ...(form.peopleIds.length ? { peopleIds: form.peopleIds } : {}),
        ...(form.energy ? { energy: form.energy as EnergyLevel } : {}),
        ...(form.time ? { time: parseInt(form.time, 10) } : {}),
        ...(form.focus ? { focus: true } : {}),
        ...(form.urgent ? { urgent: true } : {}),
        ...(form.hasTickler ? { ticklerLeadDays: parseInt(form.ticklerLeadDays, 10) || 0 } : {}),
        ...(form.notes.trim() ? { notes: form.notes.trim() } : {}),
    };
}

export function RoutineDialog({ db, userId, workContexts, people, routine, onClose, onSaved }: Props) {
    const isEdit = routine !== undefined;
    const [form, setForm] = useState<FormState>(() => initFormState(routine));
    const [isSaving, setIsSaving] = useState(false);
    const { options: calendarOptions } = useCalendarOptions();

    function patch(update: Partial<FormState>) {
        setForm((f) => ({ ...f, ...update }));
    }

    function toggleWorkContext(id: string) {
        const ids = form.workContextIds.includes(id) ? form.workContextIds.filter((x) => x !== id) : [...form.workContextIds, id];
        patch({ workContextIds: ids });
    }

    function togglePerson(id: string) {
        const ids = form.peopleIds.includes(id) ? form.peopleIds.filter((x) => x !== id) : [...form.peopleIds, id];
        patch({ peopleIds: ids });
    }

    async function onSave() {
        const trimmedTitle = form.title.trim();
        if (!trimmedTitle || !form.rrule || isSaving) return;

        setIsSaving(true);
        try {
            const finalRrule = buildFinalRrule(form.rrule, form.endsMode, form.endsDate, form.endsCount);
            const template = buildTemplate(form);
            const calendarItemTemplate =
                form.routineType === 'calendar' ? { timeOfDay: form.timeOfDay, duration: parseInt(form.duration, 10) || 60 } : undefined;
            const calendarLink = form.routineType === 'calendar' ? resolveCalendarLink(form.calendarSyncConfigId, calendarOptions) : {};

            if (isEdit) {
                await updateRoutine(db, {
                    ...routine,
                    routineType: form.routineType,
                    title: trimmedTitle,
                    rrule: finalRrule,
                    template,
                    ...(calendarItemTemplate !== undefined ? { calendarItemTemplate } : {}),
                    ...calendarLink,
                });
            } else {
                const created = await createRoutine(db, {
                    userId,
                    routineType: form.routineType,
                    rrule: finalRrule,
                    template,
                    title: trimmedTitle,
                    active: true,
                    ...(calendarItemTemplate !== undefined ? { calendarItemTemplate } : {}),
                    ...calendarLink,
                });

                // Auto-create the first item — best-effort so a failure doesn't block saving the routine
                try {
                    if (form.routineType === 'calendar') {
                        // refDate = just before start of today so the first occurrence on/after today is returned
                        const refDate = dayjs().startOf('day').subtract(1, 'ms').toDate();
                        await createNextCalendarItem(db, userId, created, refDate);
                    } else {
                        await createNextRoutineItem(db, userId, created, dayjs().toDate());
                    }
                } catch (err) {
                    console.error('[routine] failed to create first item:', err);
                }
            }

            await onSaved();
            onClose();
        } finally {
            setIsSaving(false);
        }
    }

    const isCalendar = form.routineType === 'calendar';

    return (
        <Dialog open onClose={onClose} fullWidth maxWidth="sm">
            <DialogTitle>{isEdit ? 'Edit routine' : 'New routine'}</DialogTitle>
            {/* MUI removes DialogContent top padding when preceded by DialogTitle; restore with sx */}
            <DialogContent className={styles.dialogContent} sx={{ pt: 2 }}>
                <TextField label="Title" value={form.title} onChange={(e) => patch({ title: e.target.value })} fullWidth required autoFocus />

                <Box>
                    <FormLabel>
                        <Typography variant="caption" color="text.secondary" className={styles.sectionLabel}>
                            Type
                        </Typography>
                    </FormLabel>
                    <ToggleButtonGroup
                        exclusive
                        size="small"
                        value={form.routineType}
                        onChange={(_e, val: 'nextAction' | 'calendar' | null) => {
                            if (val) patch({ routineType: val });
                        }}
                    >
                        <ToggleButton value="nextAction">Next Action</ToggleButton>
                        <ToggleButton value="calendar">Calendar</ToggleButton>
                    </ToggleButtonGroup>
                </Box>

                <Box>
                    <FormLabel>
                        <Typography variant="caption" color="text.secondary" className={styles.sectionLabel}>
                            Frequency
                        </Typography>
                    </FormLabel>
                    {/* key resets FrequencyPicker internal state when switching between create/edit */}
                    <FrequencyPicker key={routine?._id ?? 'new'} value={form.rrule} onChange={(rrule) => patch({ rrule })} />
                </Box>

                <EndsFields form={form} onPatch={patch} />

                {isCalendar ? (
                    <CalendarFields form={form} onPatch={patch} calendarOptions={calendarOptions} />
                ) : (
                    <>
                        <TemplateFields
                            form={form}
                            workContexts={workContexts}
                            people={people}
                            onPatch={patch}
                            onToggleWorkContext={toggleWorkContext}
                            onTogglePerson={togglePerson}
                        />
                        <TicklerFields form={form} onPatch={patch} />
                    </>
                )}

                <TextField
                    label="Notes (template)"
                    value={form.notes}
                    onChange={(e) => patch({ notes: e.target.value })}
                    fullWidth
                    multiline
                    rows={3}
                    placeholder="Notes copied onto every generated item"
                />
            </DialogContent>

            <DialogActions>
                <Button onClick={onClose}>Cancel</Button>
                <Button variant="contained" disabled={!form.title.trim() || !form.rrule || isSaving} onClick={() => void onSave()}>
                    {isEdit ? 'Save changes' : 'Create routine'}
                </Button>
            </DialogActions>
        </Dialog>
    );
}

// ── Calendar-specific fields ───────────────────────────────────────────────────

function CalendarFields({
    form,
    onPatch,
    calendarOptions,
}: {
    form: FormState;
    onPatch: (patch: Partial<FormState>) => void;
    calendarOptions: CalendarOption[];
}) {
    const showPicker = calendarOptions.length > 1;

    return (
        <Stack gap={1.5}>
            <Typography variant="caption" color="text.secondary" fontWeight={600}>
                Calendar event settings
            </Typography>
            <Stack direction="row" gap={2} alignItems="center">
                <TextField
                    label="Start time"
                    type="time"
                    value={form.timeOfDay}
                    onChange={(e) => onPatch({ timeOfDay: e.target.value })}
                    size="small"
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
            {/* Only show picker when user has 2+ calendars — with 0-1 there's nothing to choose. */}
            {showPicker && (
                <TextField
                    select
                    label="Calendar"
                    value={form.calendarSyncConfigId}
                    onChange={(e) => onPatch({ calendarSyncConfigId: e.target.value })}
                    size="small"
                >
                    <MenuItem value="">Default</MenuItem>
                    {calendarOptions.map((opt) => (
                        <MenuItem key={opt.configId} value={opt.configId}>
                            {opt.displayName}
                        </MenuItem>
                    ))}
                </TextField>
            )}
        </Stack>
    );
}

// ── Ends section ──────────────────────────────────────────────────────────────

function EndsFields({ form, onPatch }: { form: FormState; onPatch: (patch: Partial<FormState>) => void }) {
    return (
        <Box>
            <FormLabel>
                <Typography variant="caption" color="text.secondary" className={styles.sectionLabel}>
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
    onPatch: (patch: Partial<FormState>) => void;
    onToggleWorkContext: (id: string) => void;
    onTogglePerson: (id: string) => void;
}

function TemplateFields({ form, workContexts, people, onPatch, onToggleWorkContext, onTogglePerson }: TemplateFieldsProps) {
    return (
        <Stack gap={1.5}>
            <Typography variant="caption" color="text.secondary" fontWeight={600}>
                Template fields (copied onto each generated item)
            </Typography>

            {workContexts.length > 0 && (
                <Box>
                    <FormLabel>
                        <Typography variant="caption" color="text.secondary">
                            Work contexts
                        </Typography>
                    </FormLabel>
                    <Stack direction="row" flexWrap="wrap" gap={0.75} mt={0.5}>
                        {workContexts.map((ctx) => (
                            <Chip
                                key={ctx._id}
                                label={ctx.name}
                                size="small"
                                variant={form.workContextIds.includes(ctx._id) ? 'filled' : 'outlined'}
                                color={form.workContextIds.includes(ctx._id) ? 'primary' : 'default'}
                                onClick={() => onToggleWorkContext(ctx._id)}
                            />
                        ))}
                    </Stack>
                </Box>
            )}

            {people.length > 0 && (
                <Box>
                    <FormLabel>
                        <Typography variant="caption" color="text.secondary">
                            People
                        </Typography>
                    </FormLabel>
                    <Stack direction="row" flexWrap="wrap" gap={0.75} mt={0.5}>
                        {people.map((p) => (
                            <Chip
                                key={p._id}
                                label={p.name}
                                size="small"
                                variant={form.peopleIds.includes(p._id) ? 'filled' : 'outlined'}
                                color={form.peopleIds.includes(p._id) ? 'primary' : 'default'}
                                onClick={() => onTogglePerson(p._id)}
                            />
                        ))}
                    </Stack>
                </Box>
            )}

            <Box>
                <FormLabel>
                    <Typography variant="caption" color="text.secondary">
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

            <Stack direction="row" gap={2}>
                <FormControlLabel
                    control={<Checkbox size="small" checked={form.urgent} onChange={(e) => onPatch({ urgent: e.target.checked })} />}
                    label={<Typography variant="body2">Urgent</Typography>}
                />
                <FormControlLabel
                    control={<Checkbox size="small" checked={form.focus} onChange={(e) => onPatch({ focus: e.target.checked })} />}
                    label={<Typography variant="body2">Needs focus</Typography>}
                />
            </Stack>
        </Stack>
    );
}

function TicklerFields({ form, onPatch }: { form: FormState; onPatch: (patch: Partial<FormState>) => void }) {
    return (
        <Box>
            <FormControlLabel
                control={<Switch size="small" checked={form.hasTickler} onChange={(e) => onPatch({ hasTickler: e.target.checked })} />}
                label={<Typography variant="body2">Hide until X days before due (tickler)</Typography>}
            />
            {form.hasTickler && (
                <div className={styles.ticklerRow}>
                    <Typography variant="body2">Show</Typography>
                    <TextField
                        type="number"
                        size="small"
                        className={styles.narrowInput}
                        value={form.ticklerLeadDays}
                        onChange={(e) => onPatch({ ticklerLeadDays: e.target.value })}
                        slotProps={{ htmlInput: { min: 0 } }}
                    />
                    <Typography variant="body2">days before due (0 = show on due date)</Typography>
                </div>
            )}
        </Box>
    );
}
