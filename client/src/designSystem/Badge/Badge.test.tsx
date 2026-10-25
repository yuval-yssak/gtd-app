// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Badge } from './Badge';

afterEach(cleanup);

describe('Badge', () => {
    it('caps the count at 99 with a plus', () => {
        render(<Badge count={120} data-testid="badge" />);
        expect(screen.getByTestId('badge').textContent).toBe('99+');
    });

    it('hides at zero', () => {
        render(<Badge count={0} data-testid="badge" />);
        expect(screen.queryByTestId('badge')).toBeNull();
    });

    it('puts className on the bubble when it renders inline', () => {
        render(<Badge count={3} className="countBadge" data-testid="badge" />);
        expect(screen.getByTestId('badge').classList.contains('countBadge')).toBe(true);
    });

    it('puts className on the anchor, not the bubble, when it sits on a child', () => {
        render(
            <Badge count={3} className="countBadge" data-testid="badge">
                <button type="button">Inbox</button>
            </Badge>,
        );
        const bubble = screen.getByTestId('badge');
        expect(bubble.classList.contains('countBadge')).toBe(false);
        expect(bubble.parentElement?.classList.contains('countBadge')).toBe(true);
        expect(bubble.hasAttribute('data-anchored')).toBe(true);
    });
});
