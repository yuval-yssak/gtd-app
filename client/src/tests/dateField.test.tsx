import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { DateField, type DateFieldProps } from '../components/pickers/DateField';
import { DatePickerPanel, DatePickerPopover } from '../components/pickers/DatePickerPopover';
import { TimeField } from '../components/pickers/TimeField';

// vitest runs in the node env (no DOM), so these components are rendered to static HTML and the
// markup is inspected — the same approach as nextActionFieldsDense.test.tsx. The popover itself is
// closed in static markup; its body is covered by rendering DatePickerPanel directly.

// Omit the naming union — the helper always supplies the label.
function dateFieldMarkup(props: Partial<Omit<DateFieldProps, 'label' | 'accessibleName'>> = {}) {
    return renderToStaticMarkup(<DateField label="Expected by" value="2026-10-15" onChange={() => {}} {...props} />);
}

function countOf(html: string, needle: string) {
    return html.split(needle).length - 1;
}

describe('DateField', () => {
    it('keeps the native date input so keyboard entry and mobile wheels stay native', () => {
        expect(dateFieldMarkup()).toContain('type="date"');
    });

    it('offers a Clear button named after the field while a date is set', () => {
        expect(dateFieldMarkup()).toContain('title="Clear Expected by"');
    });

    it('names the buttons via title so getByLabel(<label>) still resolves only the input', () => {
        // An aria-label containing the field label would make Playwright's substring getByLabel
        // match the buttons too — a strict-mode violation in every spec that fills a date field.
        expect(dateFieldMarkup()).not.toMatch(/aria-label="[^"]*Expected by/);
    });

    it('hides Clear when the field is empty — nothing to clear', () => {
        const html = dateFieldMarkup({ value: '' });
        expect(html).not.toContain('Clear Expected by');
        expect(html).toContain('title="Pick Expected by"');
    });

    it('hides Clear and disables Pick when the field is disabled', () => {
        const html = dateFieldMarkup({ disabled: true });
        expect(html).not.toContain('Clear Expected by');
        expect(html).toMatch(/<button[^>]*disabled=""[^>]*title="Pick Expected by"/);
    });

    it('names the input and its buttons from accessibleName when there is no floating label', () => {
        // NextActionFields renders its own "Tickler — hide until" caption instead of a label.
        const html = renderToStaticMarkup(<DateField accessibleName="Tickler date" value="2026-10-15" onChange={() => {}} />);
        expect(html).toMatch(/<input[^>]*aria-label="Tickler date"/);
        expect(html).toContain('title="Clear Tickler date"');
        expect(html).toContain('title="Pick Tickler date"');
    });

    it('forwards the input test id and helper text', () => {
        const html = dateFieldMarkup({ inputTestId: 'endDatePicker', helperText: 'Leave empty for a single day' });
        expect(html).toContain('data-testid="endDatePicker"');
        expect(html).toContain('Leave empty for a single day');
    });
});

describe('TimeField', () => {
    it('offers Clear only while a time is set, named via title for the same locator reason', () => {
        const filled = renderToStaticMarkup(<TimeField label="End time" value="09:30" onChange={() => {}} />);
        expect(filled).toContain('title="Clear End time"');
        expect(filled).not.toMatch(/aria-label="[^"]*End time/);
        expect(renderToStaticMarkup(<TimeField label="End time" value="" onChange={() => {}} />)).not.toContain('Clear End time');
    });
});

describe('DatePickerPanel', () => {
    const html = renderToStaticMarkup(<DatePickerPanel value="2026-10-15" todayIso="2026-10-03" onPick={() => {}} />);

    it('opens on the month of the current value, not on today', () => {
        expect(html).toContain('October 2026');
    });

    it('renders the full six-week grid of day buttons', () => {
        expect(countOf(html, 'aria-pressed=')).toBe(42);
    });

    it('marks only the selected day as pressed', () => {
        expect(countOf(html, 'aria-pressed="true"')).toBe(1);
        expect(html).toMatch(/aria-label="Thursday, October 15, 2026"[^>]*aria-pressed="true"/);
    });

    it('lists the quick picks relative to today', () => {
        for (const label of ['Today', 'Tomorrow', 'Next Mon', 'In a week', 'In a month']) expect(html).toContain(label);
    });

    it('opens on today when the field is empty', () => {
        const emptyHtml = renderToStaticMarkup(<DatePickerPanel value="" todayIso="2026-03-20" onPick={() => {}} />);
        expect(emptyHtml).toContain('March 2026');
        expect(countOf(emptyHtml, 'aria-pressed="true"')).toBe(0);
    });
});

describe('DatePickerPopover', () => {
    it('renders no panel markup while closed', () => {
        // Only the closed path is reachable in the node renderer; the remount-and-reseed behaviour
        // that depends on it is pinned by the "reopening the picker" e2e test.
        const html = renderToStaticMarkup(<DatePickerPopover anchorEl={null} value="2026-10-15" onPick={() => {}} onClose={() => {}} />);
        expect(html).not.toContain('datePickerPanel');
    });
});
