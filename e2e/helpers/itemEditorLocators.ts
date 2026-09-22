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

export function titleInputOf(scope: Page | Locator): Locator {
    return scope.getByRole('textbox', { name: 'Title' });
}
