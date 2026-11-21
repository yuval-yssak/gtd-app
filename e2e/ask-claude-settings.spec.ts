import { expect, test } from '@playwright/test';
import { withOneLoggedInDevice } from './helpers/context';
import { uniqueStamp } from './helpers/uniqueStamp';

// Settings → "Claude routine": connect a Claude routine (a Claude Code cloud routine, not a Done
// routine), see only the token's last four characters, replace it, disconnect.

const ROUTINE_ID = 'trig_01E2eSettings';
const TOKEN = 'sk-ant-oat01-e2e-settings-token-wxyz';

test.describe('Claude routine settings', () => {
    test('connects, shows only the token hint, and disconnects', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `claude-routine-settings-${uniqueStamp()}@example.com`, async (page) => {
            await page.goto('/settings');
            const section = page.getByTestId('claudeRoutineSection');
            await expect(section.getByTestId('claudeRoutineSuggestedPrompt')).toContainText('done_report_claude_ask');

            await section.getByTestId('claudeRoutineIdInput').getByRole('textbox').fill(ROUTINE_ID);
            await section.getByTestId('claudeRoutineTokenInput').locator('input').fill(TOKEN);
            await section.getByTestId('claudeRoutineSaveButton').click();

            const status = section.getByTestId('claudeRoutineStatus');
            await expect(status).toContainText(ROUTINE_ID);
            await expect(status).toContainText('wxyz');
            await expect(section).not.toContainText(TOKEN);

            // A reload reads the connection back from the server, still without the token.
            await page.reload();
            await expect(page.getByTestId('claudeRoutineStatus')).toContainText(ROUTINE_ID);
            await expect(page.getByTestId('claudeRoutineSection')).not.toContainText(TOKEN);

            await page.getByTestId('claudeRoutineDisconnectButton').click();
            await expect(page.getByTestId('claudeRoutineIdInput')).toBeVisible();
            await expect(page.getByTestId('claudeRoutineStatus')).toHaveCount(0);
        });
    });

    test('rejects a malformed Claude routine id before calling the server', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `claude-routine-invalid-${uniqueStamp()}@example.com`, async (page) => {
            await page.goto('/settings');
            const section = page.getByTestId('claudeRoutineSection');
            await section.getByTestId('claudeRoutineIdInput').getByRole('textbox').fill('routine-123');
            await section.getByTestId('claudeRoutineTokenInput').locator('input').fill(TOKEN);
            await section.getByTestId('claudeRoutineSaveButton').click();
            await expect(section.getByTestId('claudeRoutineValidationError')).toBeVisible();
            await expect(section.getByTestId('claudeRoutineStatus')).toHaveCount(0);
        });
    });
});
