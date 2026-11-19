import type { Locator, Page } from '@playwright/test';

/**
 * Shared locators for the item editor's two headline fields, which every editor chrome renders —
 * the item page, the dialog/popover/expand modes and the weekly review's cards.
 *
 * Both are role-based on purpose: the fields are `multiline`, so they render as `<textarea>`, and
 * a tag-based selector would silently match nothing and pass for the wrong reason.
 */
export function briefInputOf(scope: Page | Locator): Locator {
    return scope.getByTestId('briefField').getByRole('textbox', { name: 'Brief' });
}

/** The brief's read view text (both editor variants). Absent while the brief is empty or open for editing. */
export function briefTextOf(scope: Page | Locator): Locator {
    return scope.getByTestId('briefSection').getByTestId('briefLine');
}

/** The brief rests read-only; the pencil is the only way into the field. Returns the opened input. */
export async function openBriefEditor(scope: Page | Locator): Promise<Locator> {
    await scope.getByTestId('briefEditButton').click();
    return briefInputOf(scope);
}

export function titleInputOf(scope: Page | Locator): Locator {
    return scope.getByRole('textbox', { name: 'Title' });
}

/**
 * The weekly review's card rests on a read-only details summary; the pencil swaps the detail form
 * (dates, contexts, energy, account…) in place. Call before touching any of those fields in a review card.
 */
export async function openReviewDetailsForm(scope: Page | Locator): Promise<Locator> {
    await scope.getByTestId('editDetailsButton').click();
    const form = scope.getByTestId('itemDetailsForm');
    await form.waitFor();
    return form;
}
