const HORIZON_KEY = 'gtd:calendarHorizonMonths';
const DEFAULT_HORIZON_MONTHS = 2;
const MIN_HORIZON = 1;
const MAX_HORIZON = 12;

export function getCalendarHorizonMonths(): number {
    const raw = localStorage.getItem(HORIZON_KEY);
    if (raw === null) {
        return DEFAULT_HORIZON_MONTHS;
    }
    const parsed = Number(raw);
    if (!Number.isInteger(parsed) || parsed < MIN_HORIZON || parsed > MAX_HORIZON) {
        return DEFAULT_HORIZON_MONTHS;
    }
    return parsed;
}

export function setCalendarHorizonMonths(months: number): void {
    const clamped = Math.max(MIN_HORIZON, Math.min(MAX_HORIZON, Math.round(months)));
    localStorage.setItem(HORIZON_KEY, String(clamped));
}
