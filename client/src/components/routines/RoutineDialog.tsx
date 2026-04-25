import Alert from '@mui/material/Alert';
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
import TextField from '@mui/material/TextField';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import Typography from '@mui/material/Typography';
import dayjs from 'dayjs';
import type { IDBPDatabase } from 'idb';
import { useState } from 'react';
import {
    createFirstRoutineItem,
    deleteAndRegenerateFutureItems,
    generateCalendarItemsToHorizon,
    hardDeletePastItems,
    partitionPastItemsByDoneness,
    regenerateFutureItemContent,
} from '../../db/routineItemHelpers';
import { createRoutine, updateRoutine } from '../../db/routineMutations';
import { splitRoutine } from '../../db/routineSplit';
import { type CalendarOption, useCalendarOptions } from '../../hooks/useCalendarOptions';
import { computeSplitDate, routineHasPastItems, stripEndClauses } from '../../lib/routineSplitUtils';
import { hasAtLeastOne } from '../../lib/typeUtils';
import type { EnergyLevel, MyDB, StoredPerson, StoredRoutine, StoredWorkContext } from '../../types/MyDB';
import { FrequencyPicker } from './FrequencyPicker';
import styles from './RoutineDialog.module.css';
import { isCalendarScheduleChanged, isStartDateChanged } from './routineEditDecision';

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
    notes: string;
    timeOfDay: string; // HH:MM — calendar routines only
    duration: string; // minutes — calendar routines only
    calendarSyncConfigId: string; // empty = use default calendar
    endsMode: EndsMode;
    endsDate: string; // ISO date — used when endsMode === 'onDate'
    endsCount: string; // positive integer string — used when endsMode === 'afterN'
    startDate: string; // ISO date — anchors the rrule schedule. Empty = fall back to createdTs.
}

/**
 * Parse the compact RFC 5545 UTC datetime (YYYYMMDDTHHmmssZ) that UNTIL uses.
 * dayjs's default parser treats this as Invalid Date without an explicit format mask,
 * which corrupted the Ends mode on edit and silently triggered a split.
 */
function parseRruleUntil(raw: string): string {
    const match = raw.match(/^(\d{4})(\d{2})(\d{2})T\d{6}Z$/);
    if (!match) {
        return '';
    }
    return `${match[1]}-${match[2]}-${match[3]}`;
}

/** Parse UNTIL/COUNT from an existing rrule string into EndsMode fields. */
function parseEndsFromRrule(rruleStr: string): { endsMode: EndsMode; endsDate: string; endsCount: string } {
    const untilMatch = rruleStr.match(/UNTIL=([^;]+)/);
    const countMatch = rruleStr.match(/COUNT=(\d+)/);
    // noUncheckedIndexedAccess: capture group [1] is string | undefined; fall back to '' to satisfy types
    if (untilMatch) {
        const parsed = parseRruleUntil(untilMatch[1] ?? '');
        // Fall back to dayjs for ISO-formatted UNTIL values (defensive); compact form is handled above.
        const endsDate = parsed || dayjs(untilMatch[1] ?? '').format('YYYY-MM-DD');
        return { endsMode: 'onDate', endsDate, endsCount: '' };
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
        notes: routine?.template.notes ?? '',
        timeOfDay: routine?.calendarItemTemplate?.timeOfDay ?? '09:00',
        duration: routine?.calendarItemTemplate?.duration?.toString() ?? '60',
        calendarSyncConfigId: routine?.calendarSyncConfigId ?? '',
        startDate: routine?.startDate ?? '',
        ...ends,
    };
}

/** Resolves calendarSyncConfigId + calendarIntegrationId from the form's selected config. */
function resolveCalendarLink(configId: string, options: CalendarOption[]): { calendarSyncConfigId?: string; calendarIntegrationId?: string } {
    if (configId) {
        const selected = options.find((o) => o.configId === configId);
        return selected ? { calendarSyncConfigId: selected.configId, calendarIntegrationId: selected.integrationId } : {};
    }
    // Empty configId = "use default calendar" (see FormState.calendarSyncConfigId comment).
    // Resolve integrationId so the server can find the default config via resolvePushContext fallback.
    const fallback = options.find((o) => o.isDefault) ?? (hasAtLeastOne(options) ? options[0] : undefined);
    return fallback ? { calendarIntegrationId: fallback.integrationId } : {};
}

function buildTemplate(form: FormState) {
    return {
        ...(form.workContextIds.length ? { workContextIds: form.workContextIds } : {}),
        ...(form.peopleIds.length ? { peopleIds: form.peopleIds } : {}),
        ...(form.energy ? { energy: form.energy as EnergyLevel } : {}),
        ...(form.time ? { time: parseInt(form.time, 10) } : {}),
        ...(form.focus ? { focus: true } : {}),
        ...(form.urgent ? { urgent: true } : {}),
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
        if (!trimmedTitle || !form.rrule || isSaving) {
            return;
        }
        if (form.routineType === 'calendar' && !form.timeOfDay) {
            return;
        }

        setIsSaving(true);
        try {
            const finalRrule = buildFinalRrule(form.rrule, form.endsMode, form.endsDate, form.endsCount);
            const template = buildTemplate(form);
            const calendarItemTemplate =
                form.routineType === 'calendar' ? { timeOfDay: form.timeOfDay, duration: parseInt(form.duration, 10) || 60 } : undefined;
            const calendarLink = form.routineType === 'calendar' ? resolveCalendarLink(form.calendarSyncConfigId, calendarOptions) : {};

            if (isEdit) {
                // Split only when a calendar routine's schedule changed AND it has past items —
                // past items should keep their original schedule. Title/notes-only edits always
                // stay in-place; forking a routine just because the user renamed it would be
                // surprising and leave orphaned chains.
                const isCalendarEdit = form.routineType === 'calendar';
                const editIntent = {
                    routineType: form.routineType,
                    rrule: finalRrule,
                    timeOfDay: calendarItemTemplate?.timeOfDay,
                    duration: calendarItemTemplate?.duration,
                    startDate: form.startDate || undefined,
                };
                const scheduleChanged = isCalendarScheduleChanged(routine, editIntent);
                const startDateChanged = isStartDateChanged(routine, editIntent);
                const formStartDate = form.startDate || undefined;
                // Saving a paused routine from the dialog counts as a resume — flip active=true so
                // the server pushback sees the transition and the GCal cap is cleared.
                const resumeOnSave = !routine.active;

                // startDate change path: if any `done` past items exist, split to preserve them;
                // otherwise hard-delete past non-done items and update in place. This happens
                // before the generic schedule-change split so the startDate branch wins when both
                // apply (new startDate fully supersedes any rrule-only change semantics).
                if (startDateChanged) {
                    const { donePast, nonDonePast } = await partitionPastItemsByDoneness(db, userId, routine._id);
                    if (donePast.length > 0) {
                        // Split: cap old routine at yesterday, tail anchored at new startDate.
                        const yesterday = dayjs().subtract(1, 'day').format('YYYY-MM-DD');
                        await splitRoutine(
                            db,
                            userId,
                            routine,
                            {
                                routineType: form.routineType,
                                title: trimmedTitle,
                                rrule: finalRrule,
                                template,
                                ...(calendarItemTemplate !== undefined ? { calendarItemTemplate } : {}),
                                ...calendarLink,
                                ...(formStartDate ? { startDate: formStartDate } : {}),
                            },
                            yesterday,
                        );
                    } else {
                        await hardDeletePastItems(db, nonDonePast);
                        const updatedRoutine: StoredRoutine = {
                            ...routine,
                            routineType: form.routineType,
                            title: trimmedTitle,
                            rrule: finalRrule,
                            template,
                            active: true,
                            ...(calendarItemTemplate !== undefined ? { calendarItemTemplate } : {}),
                            ...calendarLink,
                            ...(formStartDate ? { startDate: formStartDate } : {}),
                        };
                        if (!formStartDate) {
                            delete updatedRoutine.startDate;
                        }
                        await updateRoutine(db, updatedRoutine);
                        if (isCalendarEdit) {
                            await deleteAndRegenerateFutureItems(db, userId, updatedRoutine);
                        } else {
                            // nextAction: seed the first item so the user doesn't see an empty routine.
                            // Skip when startDate is still in the future — the boot-tick picks it up.
                            const todayStr = dayjs().startOf('day').format('YYYY-MM-DD');
                            const futureStart = formStartDate !== undefined && formStartDate > todayStr;
                            if (!futureStart) {
                                await createFirstRoutineItem(db, userId, updatedRoutine);
                            }
                        }
                    }
                } else {
                    const hasPastItems = scheduleChanged ? await routineHasPastItems(db, userId, routine._id) : false;
                    const splitDate = hasPastItems ? computeSplitDate(routine.rrule, routine.createdTs) : null;

                    if (splitDate) {
                        await splitRoutine(
                            db,
                            userId,
                            routine,
                            {
                                routineType: form.routineType,
                                title: trimmedTitle,
                                rrule: finalRrule,
                                template,
                                ...(calendarItemTemplate !== undefined ? { calendarItemTemplate } : {}),
                                ...calendarLink,
                                ...(formStartDate ? { startDate: formStartDate } : {}),
                            },
                            splitDate,
                        );
                    } else {
                        const updatedRoutine: StoredRoutine = {
                            ...routine,
                            routineType: form.routineType,
                            title: trimmedTitle,
                            rrule: finalRrule,
                            template,
                            // Resume: flip active=true when saving a paused routine from the dialog.
                            ...(resumeOnSave ? { active: true } : {}),
                            ...(calendarItemTemplate !== undefined ? { calendarItemTemplate } : {}),
                            ...calendarLink,
                            ...(formStartDate ? { startDate: formStartDate } : {}),
                        };
                        if (!formStartDate) {
                            delete updatedRoutine.startDate;
                        }
                        await updateRoutine(db, updatedRoutine);

                        if (isCalendarEdit && routine.routineType === 'calendar') {
                            if (scheduleChanged || resumeOnSave) {
                                await deleteAndRegenerateFutureItems(db, userId, updatedRoutine);
                            } else {
                                await regenerateFutureItemContent(db, userId, updatedRoutine);
                            }
                        }
                    }
                }
            } else {
                const formStartDate = form.startDate || undefined;
                const created = await createRoutine(db, {
                    userId,
                    routineType: form.routineType,
                    rrule: finalRrule,
                    template,
                    title: trimmedTitle,
                    active: true,
                    ...(calendarItemTemplate !== undefined ? { calendarItemTemplate } : {}),
                    ...calendarLink,
                    ...(formStartDate ? { startDate: formStartDate } : {}),
                });

                // Auto-create items — best-effort so a failure doesn't block saving the routine.
                // For nextAction routines with a future startDate, skip initial creation — the
                // boot-tick (materializePendingNextActionRoutines) will produce the first item
                // when the startDate arrives.
                const todayStr = dayjs().startOf('day').format('YYYY-MM-DD');
                const futureStart = formStartDate !== undefined && formStartDate > todayStr;
                try {
                    if (form.routineType === 'calendar') {
                        await generateCalendarItemsToHorizon(db, userId, created);
                    } else if (!futureStart) {
                        await createFirstRoutineItem(db, userId, created);
                    }
                } catch (err) {
                    console.error('[routine] failed to create items:', err);
                }
            }

            await onSaved();
            onClose();
        } finally {
            setIsSaving(false);
        }
    }

    const isCalendar = form.routineType === 'calendar';
    // An ended calendar routine has no future occurrences — schedule fields are locked.
    const isEndedCalendar = isEdit && routine.routineType === 'calendar' && computeSplitDate(routine.rrule, routine.createdTs) === null;

    return (
        <Dialog open onClose={onClose} fullWidth maxWidth="sm">
            <DialogTitle>{isEdit ? 'Edit routine' : 'New routine'}</DialogTitle>
            {/* MUI removes DialogContent top padding when preceded by DialogTitle; restore with sx */}
            <DialogContent className={styles.dialogContent} sx={{ pt: 2 }}>
                {isEdit && !routine.active && (
                    <Alert severity="info" variant="outlined">
                        This routine is paused. Save your changes to resume it.
                    </Alert>
                )}
                {isEndedCalendar && (
                    <Alert severity="info" variant="outlined">
                        This routine has ended. Only title and notes can be edited.
                    </Alert>
                )}

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
                        disabled={isEndedCalendar}
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
                    <FrequencyPicker key={routine?._id ?? 'new'} value={form.rrule} onChange={(rrule) => patch({ rrule })} disabled={isEndedCalendar} />
                </Box>

                <TextField
                    type="date"
                    label="Start date"
                    size="small"
                    value={form.startDate}
                    onChange={(e) => patch({ startDate: e.target.value })}
                    slotProps={{ inputLabel: { shrink: true } }}
                    helperText="Optional — anchors the schedule. Leave empty to start today."
                    disabled={isEndedCalendar}
                />

                <EndsFields form={form} onPatch={patch} disabled={isEndedCalendar} />

                {isCalendar ? (
                    <CalendarFields form={form} onPatch={patch} calendarOptions={calendarOptions} disabled={isEndedCalendar} />
                ) : (
                    <TemplateFields
                        form={form}
                        workContexts={workContexts}
                        people={people}
                        onPatch={patch}
                        onToggleWorkContext={toggleWorkContext}
                        onTogglePerson={togglePerson}
                    />
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
    disabled,
}: {
    form: FormState;
    onPatch: (patch: Partial<FormState>) => void;
    calendarOptions: CalendarOption[];
    disabled?: boolean;
}) {
    const showPicker = calendarOptions.length > 1;

    return (
        <Stack gap={1.5} sx={disabled ? { opacity: 0.5, pointerEvents: 'none' } : undefined}>
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

function EndsFields({ form, onPatch, disabled }: { form: FormState; onPatch: (patch: Partial<FormState>) => void; disabled?: boolean }) {
    return (
        <Box sx={disabled ? { opacity: 0.5, pointerEvents: 'none' } : undefined}>
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
