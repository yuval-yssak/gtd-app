// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Tooltip } from '../Tooltip/Tooltip';
import { IconButton } from './IconButton';

afterEach(cleanup);

describe('IconButton', () => {
    it('is named by its aria-label', () => {
        render(
            <IconButton aria-label="Edit">
                <svg />
            </IconButton>,
        );
        expect(screen.getByRole('button', { name: 'Edit' })).toBeDefined();
    });

    it('shows its label as a native title when no design-system tooltip wraps it (touch fallback)', () => {
        render(
            <IconButton aria-label="Edit">
                <svg />
            </IconButton>,
        );
        expect(screen.getByRole('button').getAttribute('title')).toBe('Edit');
    });

    it('drops the native title inside a Tooltip so two hints never stack', () => {
        render(
            <Tooltip title="Edit (e)">
                <IconButton aria-label="Edit">
                    <svg />
                </IconButton>
            </Tooltip>,
        );
        expect(screen.getByRole('button').hasAttribute('title')).toBe(false);
    });

    it('passes row-action attributes and tabIndex through to the button', () => {
        render(
            <IconButton aria-label="Edit" data-row-action="edit" aria-keyshortcuts="e" tabIndex={-1}>
                <svg />
            </IconButton>,
        );
        const button = screen.getByRole('button');
        expect(button.getAttribute('data-row-action')).toBe('edit');
        expect(button.getAttribute('aria-keyshortcuts')).toBe('e');
        expect(button.tabIndex).toBe(-1);
    });

    it('can be named by title alone, so a label-substring query on the field never matches it', () => {
        render(
            <IconButton title="Clear Expected by">
                <svg />
            </IconButton>,
        );
        const button = screen.getByRole('button', { name: 'Clear Expected by' });
        expect(button.hasAttribute('aria-label')).toBe(false);
        expect(button.getAttribute('title')).toBe('Clear Expected by');
    });

    it('complains in development when the label is blank', () => {
        const error = vi.spyOn(console, 'error').mockImplementation(() => {});
        render(
            <IconButton aria-label=" ">
                <svg />
            </IconButton>,
        );
        expect(error).toHaveBeenCalledWith(expect.stringContaining('aria-label'));
        error.mockRestore();
    });
});
