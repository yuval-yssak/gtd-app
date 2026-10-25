// @vitest-environment jsdom
import { Switch as BaseSwitch } from '@base-ui/react/switch';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChoiceLabel } from './ChoiceLabel';

afterEach(cleanup);

function SwitchControl({ onCheckedChange = vi.fn() }) {
    return <BaseSwitch.Root checked={false} onCheckedChange={onCheckedChange} />;
}

describe('ChoiceLabel', () => {
    // The label wraps both lines, so the description is part of the control's name, after the label.
    it('names its control starting with the label text', () => {
        render(<ChoiceLabel control={<SwitchControl />} label="Show briefs" description="In the weekly review" />);
        expect(screen.getByRole('switch', { name: /^Show briefs/ })).toBeDefined();
    });

    it('toggles its control when the label text is clicked', async () => {
        const onCheckedChange = vi.fn();
        render(<ChoiceLabel control={<SwitchControl onCheckedChange={onCheckedChange} />} label="Show briefs" />);
        await userEvent.click(screen.getByText('Show briefs'));
        expect(onCheckedChange).toHaveBeenCalledWith(true, expect.anything());
    });

    it('marks itself disabled and puts data-testid and className on the label', () => {
        render(<ChoiceLabel control={<SwitchControl />} label="Show briefs" disabled className="settingsRow" data-testid="choice" />);
        const label = screen.getByTestId('choice');
        expect(label.hasAttribute('data-disabled')).toBe(true);
        expect(label.classList.contains('settingsRow')).toBe(true);
    });
});
