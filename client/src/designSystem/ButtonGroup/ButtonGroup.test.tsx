// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Button } from '../Button/Button';
import { ButtonGroup } from './ButtonGroup';

afterEach(cleanup);

describe('ButtonGroup', () => {
    it('is a named group around its buttons', () => {
        render(
            <ButtonGroup aria-label="Position">
                <Button>Up</Button>
                <Button>Down</Button>
            </ButtonGroup>,
        );
        const group = screen.getByRole('group', { name: 'Position' });
        expect(group.querySelectorAll('button')).toHaveLength(2);
    });

    // A fieldset's disabled disables every control inside it — documented, and relied on.
    it('disables every button when disabled', () => {
        render(
            <ButtonGroup aria-label="Position" disabled>
                <Button>Up</Button>
                <Button>Down</Button>
            </ButtonGroup>,
        );
        expect(screen.getAllByRole('button').every((button) => (button as HTMLButtonElement).matches(':disabled'))).toBe(true);
    });
});
