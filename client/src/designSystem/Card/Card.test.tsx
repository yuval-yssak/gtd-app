// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Card } from './Card';

afterEach(cleanup);

describe('Card', () => {
    it('renders its children with md padding by default', () => {
        render(<Card data-testid="card">Weekly review</Card>);
        const card = screen.getByTestId('card');
        expect(card.textContent).toBe('Weekly review');
        expect(card.getAttribute('data-padding')).toBe('md');
    });

    it('passes div props through and merges the caller className', () => {
        render(<Card padding="none" role="region" aria-label="Summary" className="summaryCard" />);
        const card = screen.getByRole('region', { name: 'Summary' });
        expect(card.getAttribute('data-padding')).toBe('none');
        expect(card.classList.contains('summaryCard')).toBe(true);
    });
});
