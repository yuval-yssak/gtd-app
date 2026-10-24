// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Button } from './Button';

afterEach(cleanup);

describe('Button', () => {
    it('is a native button named by its text, type=button by default', () => {
        render(<Button>Save</Button>);
        const button = screen.getByRole('button', { name: 'Save' });
        expect(button.tagName).toBe('BUTTON');
        expect(button).toHaveProperty('type', 'button');
    });

    it('defaults to the ghost variant and accent tone (MUI text button)', () => {
        render(<Button>Save</Button>);
        const button = screen.getByRole('button');
        expect(button.getAttribute('data-variant')).toBe('ghost');
        expect(button.getAttribute('data-tone')).toBe('accent');
    });

    // The Next Actions grab mode suppresses exactly these two native activations
    // (useNextActionsRovingFocus / useNextActionsDrag); if they ever stop firing, those guards are dead code.
    it('clicks on Space key-up and on Enter key-down, like any native button', async () => {
        const onClick = vi.fn();
        const user = userEvent.setup();
        render(<Button onClick={onClick}>Move</Button>);
        screen.getByRole('button').focus();

        await user.keyboard('[Space>]');
        expect(onClick).not.toHaveBeenCalled();
        await user.keyboard('[/Space]');
        expect(onClick).toHaveBeenCalledTimes(1);

        await user.keyboard('[Enter>]');
        expect(onClick).toHaveBeenCalledTimes(2);
    });

    it('does not click while disabled', async () => {
        const onClick = vi.fn();
        render(
            <Button disabled onClick={onClick}>
                Save
            </Button>,
        );
        await userEvent.click(screen.getByRole('button'));
        expect(onClick).not.toHaveBeenCalled();
    });

    it('is busy and disabled while loading, with the spinner hidden from the accessible name', () => {
        render(<Button loading>Save</Button>);
        const button = screen.getByRole('button', { name: 'Save' });
        expect(button).toHaveProperty('disabled', true);
        expect(button.getAttribute('aria-busy')).toBe('true');
    });

    it('merges a caller className after its own', () => {
        render(<Button className="extra">Save</Button>);
        expect(screen.getByRole('button').className).toMatch(/button.* extra$/);
    });

    it('passes data and aria attributes through to the button', () => {
        render(
            <Button data-testid="saveButton" aria-keyshortcuts="Control+Enter">
                Save
            </Button>,
        );
        expect(screen.getByTestId('saveButton').getAttribute('aria-keyshortcuts')).toBe('Control+Enter');
    });
});
