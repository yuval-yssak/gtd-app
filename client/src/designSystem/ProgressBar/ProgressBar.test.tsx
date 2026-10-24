// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { ProgressBar } from './ProgressBar';

afterEach(cleanup);

describe('ProgressBar', () => {
    it('exposes its value as a progressbar', () => {
        render(<ProgressBar value={67} aria-label="Stage progress" />);
        expect(screen.getByRole('progressbar', { name: 'Stage progress' }).getAttribute('aria-valuenow')).toBe('67');
    });

    // Inside a <button> only phrasing content is valid — the whole bar must be spans there.
    it('renders only spans when asked to sit inside phrasing content', () => {
        render(<ProgressBar value={50} as="span" aria-label="Stage progress" />);
        const bar = screen.getByRole('progressbar');
        expect(bar.tagName).toBe('SPAN');
        expect(bar.querySelectorAll('div')).toHaveLength(0);
    });
});
