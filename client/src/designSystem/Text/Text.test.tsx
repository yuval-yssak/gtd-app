// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Text, type TextVariant } from './Text';

afterEach(cleanup);

describe('Text', () => {
    // MUI's variant → element mapping: the page outline (and every e2e getByRole('heading')) depends on it.
    it.each<[TextVariant, string]>([
        ['display', 'H3'],
        ['headline', 'H4'],
        ['title', 'H5'],
        ['titleSm', 'H6'],
        ['subtitle', 'H6'],
        ['subtitleSm', 'H6'],
        ['body', 'P'],
        ['bodySm', 'P'],
        ['caption', 'SPAN'],
        ['overline', 'SPAN'],
    ])('renders %s as <%s> by default', (variant, tagName) => {
        render(<Text variant={variant}>Inbox</Text>);
        expect(screen.getByText('Inbox').tagName).toBe(tagName);
    });

    it('exposes heading variants as headings with their level', () => {
        render(<Text variant="title">Next Actions</Text>);
        expect(screen.getByRole('heading', { level: 5, name: 'Next Actions' })).toBeDefined();
    });

    it('lets `as` override the element', () => {
        render(
            <Text variant="title" as="h1">
                Settings
            </Text>,
        );
        expect(screen.getByRole('heading', { level: 1, name: 'Settings' })).toBeDefined();
    });
});
