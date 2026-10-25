// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Skeleton } from './Skeleton';

afterEach(cleanup);

describe('Skeleton', () => {
    // A placeholder carries no information; the loading state is announced by whoever owns it.
    it('is hidden from assistive technology', () => {
        render(<Skeleton data-testid="skeleton" />);
        expect(screen.getByTestId('skeleton').getAttribute('aria-hidden')).toBe('true');
    });

    it('defaults to a text line and takes another shape on request', () => {
        const { rerender } = render(<Skeleton data-testid="skeleton" />);
        expect(screen.getByTestId('skeleton').getAttribute('data-shape')).toBe('text');
        rerender(<Skeleton shape="circle" data-testid="skeleton" />);
        expect(screen.getByTestId('skeleton').getAttribute('data-shape')).toBe('circle');
    });
});
