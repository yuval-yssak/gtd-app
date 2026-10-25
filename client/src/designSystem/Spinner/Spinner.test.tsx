// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Spinner } from './Spinner';

afterEach(cleanup);

describe('Spinner', () => {
    it('is a progressbar named "Loading" by default (MUI CircularProgress parity)', () => {
        render(<Spinner />);
        expect(screen.getByRole('progressbar', { name: 'Loading' })).toBeDefined();
    });

    it('takes its name from label', () => {
        render(<Spinner label="Syncing" />);
        expect(screen.getByRole('progressbar', { name: 'Syncing' })).toBeDefined();
    });

    it('hands its diameter to the stylesheet in rem', () => {
        render(<Spinner size={16} />);
        expect(screen.getByRole('progressbar').style.getPropertyValue('--spinner-size')).toBe('1rem');
    });
});
