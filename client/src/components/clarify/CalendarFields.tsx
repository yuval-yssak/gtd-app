import FormControl from '@mui/material/FormControl';
import InputLabel from '@mui/material/InputLabel';
import ListSubheader from '@mui/material/ListSubheader';
import MenuItem from '@mui/material/MenuItem';
import Select from '@mui/material/Select';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import type { CalendarOption } from '../../hooks/useCalendarOptions';
import type { CalendarFormState } from './types';

interface Props {
    value: CalendarFormState;
    onChange: (patch: Partial<CalendarFormState>) => void;
    /** Available calendars for the picker. Omit or pass empty to hide the picker. */
    calendarOptions?: CalendarOption[];
    /**
     * Show the picker even when there is only one option. Default is false — single-calendar
     * users get a cleaner form. Used by EditItemDialog's cross-account reassign flow, where
     * validateReassign requires an explicit pick even if the target has only one calendar.
     */
    forceShowPicker?: boolean;
}

/** Groups calendars by owning account email so the picker can render one section per account. */
function groupByAccount(calendarOptions: CalendarOption[]): Map<string, CalendarOption[]> {
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

export function CalendarFields({ value, onChange, calendarOptions, forceShowPicker = false }: Props) {
    // Default rule: hide the picker until there's an actual choice (2+ options). EditItemDialog's
    // cross-account reassign opts in via forceShowPicker so the user can confirm even a single-option list.
    const minOptions = forceShowPicker ? 1 : 2;
    const showPicker = calendarOptions !== undefined && calendarOptions.length >= minOptions;
    // Pre-group when rendering — Select can't accept fragments around its children, so we
    // flatten ListSubheader + MenuItem pairs into a single array of nodes.
    const grouped = calendarOptions ? groupByAccount(calendarOptions) : new Map<string, CalendarOption[]>();
    const showAccountHeaders = grouped.size > 1;

    return (
        <Stack gap={2}>
            <TextField
                label="Date"
                type="date"
                value={value.date}
                onChange={(e) => onChange({ date: e.target.value })}
                size="small"
                required
                slotProps={{ inputLabel: { shrink: true } }}
            />
            <Stack direction="row" gap={2}>
                <TextField
                    label="Start time"
                    type="time"
                    value={value.startTime}
                    onChange={(e) => onChange({ startTime: e.target.value })}
                    size="small"
                    slotProps={{ inputLabel: { shrink: true } }}
                />
                <TextField
                    label="End time"
                    type="time"
                    value={value.endTime}
                    onChange={(e) => onChange({ endTime: e.target.value })}
                    size="small"
                    slotProps={{ inputLabel: { shrink: true } }}
                />
            </Stack>
            {showPicker && (
                <FormControl size="small">
                    <InputLabel>Calendar</InputLabel>
                    <Select label="Calendar" value={value.calendarSyncConfigId} onChange={(e) => onChange({ calendarSyncConfigId: e.target.value })}>
                        {/* Empty value = server picks the active account's default calendar */}
                        <MenuItem value="">Default</MenuItem>
                        {Array.from(grouped.entries()).flatMap(([email, opts]) => [
                            // Skip the per-account header when there's only one account — purely visual noise.
                            ...(showAccountHeaders ? [<ListSubheader key={`hdr-${email}`}>{email}</ListSubheader>] : []),
                            ...opts.map((opt) => (
                                <MenuItem key={opt.configId} value={opt.configId}>
                                    {opt.displayName}
                                </MenuItem>
                            )),
                        ])}
                    </Select>
                </FormControl>
            )}
        </Stack>
    );
}
