// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { ButtonLink } from './ButtonLink';

afterEach(cleanup);

describe('ButtonLink', () => {
    it('stays a link with an href — never role="button"', () => {
        render(<ButtonLink href="/login">Sign in</ButtonLink>);
        const link = screen.getByRole('link', { name: 'Sign in' });
        expect(link.getAttribute('href')).toBe('/login');
        expect(screen.queryByRole('button')).toBeNull();
    });

    it('renders the given element (a router Link) with the button look', () => {
        render(
            <ButtonLink render={<a href="/privacy" data-router-link="" />} variant="solid">
                Privacy
            </ButtonLink>,
        );
        const link = screen.getByRole('link', { name: 'Privacy' });
        expect(link.hasAttribute('data-router-link')).toBe(true);
        expect(link.getAttribute('data-variant')).toBe('solid');
    });
});
