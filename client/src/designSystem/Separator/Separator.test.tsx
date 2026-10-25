// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Separator } from './Separator';

afterEach(cleanup);

describe('Separator', () => {
    it('is a horizontal separator that keeps the caller className', () => {
        render(<Separator className="sectionGap" />);
        const separator = screen.getByRole('separator');
        expect(separator.getAttribute('aria-orientation')).not.toBe('vertical');
        expect(separator.classList.contains('sectionGap')).toBe(true);
    });
});
