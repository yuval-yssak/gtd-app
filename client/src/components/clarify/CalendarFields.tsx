import { Select, type SelectOption, Switch } from '../../designSystem';
import type { CalendarOption } from '../../hooks/useCalendarOptions';
import { DateField } from '../pickers/DateField';
import { TimeField } from '../pickers/TimeField';
import styles from './CalendarFields.module.css';
import type { CalendarFormState } from './types';

interface Props {
    value: CalendarFormState;
    onChange: (patch: Partial<CalendarFormState>) => void;
    /** Available calendars for the picker. Omit or pass empty to hide the picker. */
    calendarOptions?: CalendarOption[] | undefined;
    /**
     * Show the picker even when there is only one option. Default is false — single-calendar
     * users get a cleaner form. Used by the item editor's cross-account reassign flow, where
     * validateReassign requires an explicit pick even if the target has only one calendar.
     */
    forceShowPicker?: boolean | undefined;
}

/**
 * The picker's options: "Default" (empty value — the server picks the active account's default
 * calendar), then each calendar. With calendars from more than one account, each account's
 * calendars sit under its email; with one account the header would be visual noise.
 */
export function calendarSelectOptions(calendarOptions: readonly CalendarOption[]): SelectOption<string>[] {
    // Accounts in first-seen order; a group needs its calendars contiguous.
    const accounts = [...new Set(calendarOptions.map((option) => option.accountEmail))];
    const hasSeveralAccounts = accounts.length > 1;
    const byAccount = accounts.flatMap((email) => calendarOptions.filter((option) => option.accountEmail === email));
    return [
        { value: '', label: 'Default' },
        ...byAccount.map((option) => ({
            value: option.configId,
            label: option.displayName,
            ...(hasSeveralAccounts ? { group: option.accountEmail } : {}),
        })),
    ];
}

export function CalendarFields({ value, onChange, calendarOptions, forceShowPicker = false }: Props) {
    // Default rule: hide the picker until there's an actual choice (2+ options). The item editor's
    // cross-account reassign opts in via forceShowPicker so the user can confirm even a single-option list.
    const minOptions = forceShowPicker ? 1 : 2;
    const showPicker = calendarOptions !== undefined && calendarOptions.length >= minOptions;

    return (
        <div className={styles.fields}>
            <Switch
                // data-testid sits on the wrapping label so tests can locate the toggle by stable
                // selector; the switch role remains the canonical a11y entry point.
                data-testid="allDayToggle"
                checked={value.allDay}
                onCheckedChange={(allDay) => onChange({ allDay })}
                label="All day"
            />
            <DateField label={value.allDay ? 'Start date' : 'Date'} value={value.date} onChange={(date) => onChange({ date })} required />
            {value.allDay ? (
                <DateField
                    label="End date"
                    value={value.endDate}
                    onChange={(endDate) => onChange({ endDate })}
                    helperText="Leave empty for a single day"
                    inputTestId="endDatePicker"
                />
            ) : (
                <div className={styles.timeRow}>
                    <TimeField label="Start time" value={value.startTime} onChange={(startTime) => onChange({ startTime })} />
                    <TimeField label="End time" value={value.endTime} onChange={(endTime) => onChange({ endTime })} />
                </div>
            )}
            {showPicker && (
                <Select
                    label="Calendar"
                    value={value.calendarSyncConfigId}
                    onValueChange={(calendarSyncConfigId) => onChange({ calendarSyncConfigId })}
                    options={calendarSelectOptions(calendarOptions)}
                    className={styles.calendarSelect}
                />
            )}
        </div>
    );
}
