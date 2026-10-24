// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { UnsavedChangesDialog } from '../components/UnsavedChangesDialog';

afterEach(cleanup);

describe('UnsavedChangesDialog', () => {
    // The safe choice holds focus, so a reflexive Enter keeps the edits instead of discarding them.
    it('opens with focus on "Keep editing"', async () => {
        render(<UnsavedChangesDialog blocker={{ isBlocked: true, stay: vi.fn(), discard: vi.fn() }} />);
        await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId('unsavedChangesStay')));
    });
});
