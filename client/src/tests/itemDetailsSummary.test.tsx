// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EDIT_DETAILS_LABEL, ItemDetailsSummary, NO_DETAILS_TEXT } from '../components/itemEditor/ItemDetailsSummary';

afterEach(cleanup);

describe('ItemDetailsSummary', () => {
    it('lists each fact as a term/definition pair inside a labelled region', () => {
        render(
            <ItemDetailsSummary
                facts={[
                    { label: 'Contexts', value: 'Phone' },
                    { label: 'Energy', value: 'Low' },
                ]}
                onEditRequested={() => {}}
            />,
        );
        const region = screen.getByRole('region', { name: 'Details' });
        expect(region.querySelectorAll('dt')).toHaveLength(2);
        expect(screen.getByText('Phone').tagName).toBe('DD');
    });

    it('says there is nothing set rather than rendering an empty list', () => {
        render(<ItemDetailsSummary facts={[]} onEditRequested={() => {}} />);
        expect(screen.getByText(NO_DETAILS_TEXT)).toBeTruthy();
        expect(document.querySelector('dl')).toBeNull();
    });

    it('asks the host for the form through the labelled pencil', () => {
        const onEditRequested = vi.fn();
        render(<ItemDetailsSummary facts={[]} onEditRequested={onEditRequested} />);
        fireEvent.click(screen.getByRole('button', { name: EDIT_DETAILS_LABEL }));
        expect(onEditRequested).toHaveBeenCalledOnce();
    });
});
