// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Collapsible } from './Collapsible';

afterEach(cleanup);

describe('Collapsible', () => {
    it('shows its content while open', () => {
        render(
            <Collapsible open data-testid="panel">
                Details
            </Collapsible>,
        );
        const panel = screen.getByTestId('panel');
        expect(panel.hidden).toBe(false);
        expect(panel.textContent).toBe('Details');
    });

    // Kept mounted (MUI Collapse's default) so local state inside survives a collapse, but hidden
    // so it leaves layout and the accessibility tree.
    it('keeps a closed panel mounted but hidden by default', () => {
        render(
            <Collapsible open={false} data-testid="panel">
                Details
            </Collapsible>,
        );
        expect(screen.getByTestId('panel').hidden).toBe(true);
    });

    it('does not render a closed panel without keepMounted', () => {
        render(
            <Collapsible open={false} keepMounted={false} data-testid="panel">
                Details
            </Collapsible>,
        );
        expect(screen.queryByTestId('panel')).toBeNull();
    });
});
