import { Autocomplete as BaseAutocomplete } from '@base-ui/react/autocomplete';
import { clsx } from 'clsx';
import { type KeyboardEvent, type ReactNode, useRef } from 'react';
import { MODAL_POPUP_ATTR } from '../../lib/keyboardRegionDom';
import styles from './Autocomplete.module.css';

type AutocompleteProps<T> = {
    /** The typed text — the field is free text with suggestions (MUI Autocomplete `freeSolo`). */
    inputValue: string;
    onInputValueChange: (value: string) => void;
    /** The suggestions to show, already filtered by the caller; an empty list keeps the popup closed. */
    items: readonly T[];
    itemKey: (item: T) => string;
    renderItem: (item: T) => ReactNode;
    /** A suggestion was chosen — by pointer, or Enter on the highlighted one. */
    onItemPicked: (item: T) => void;
    /** Enter with no suggestion highlighted: the caller decides what the typed text means. */
    onSubmitText?: ((text: string) => void) | undefined;
    placeholder?: string | undefined;
    /** Names the combobox; the field has no visible label of its own. */
    'aria-label': string;
    'data-testid'?: string | undefined;
    itemTestId?: ((item: T) => string) | undefined;
    className?: string | undefined;
};

/**
 * Free-text input with a suggestion list (MUI Autocomplete `freeSolo`). The input is
 * `role="combobox"` and suggestions are `role="option"`, like MUI's.
 */
export function Autocomplete<T>({
    inputValue,
    onInputValueChange,
    items,
    itemKey,
    renderItem,
    onItemPicked,
    onSubmitText,
    placeholder,
    'aria-label': ariaLabel,
    'data-testid': testId,
    itemTestId,
    className,
}: AutocompleteProps<T>) {
    // Which suggestion Enter would pick; none means Enter submits the typed text instead.
    const highlightedRef = useRef<T | undefined>(undefined);

    function onInputKeyDown(event: KeyboardEvent<HTMLInputElement>) {
        if (event.key !== 'Enter' || highlightedRef.current !== undefined || !onSubmitText) {
            return;
        }
        event.preventDefault();
        onSubmitText(inputValue);
    }

    return (
        <BaseAutocomplete.Root<T>
            items={items}
            // The caller filters; Base UI's own matching would second-guess it.
            filter={null}
            value={inputValue}
            onValueChange={(next, details) => {
                // A pick is the caller's to resolve (onItemPicked) — Base UI would otherwise write the
                // item's key into the field after the caller cleared it.
                if (details.reason !== 'item-press') onInputValueChange(next);
            }}
            itemToStringValue={itemKey}
            onItemHighlighted={(item) => {
                highlightedRef.current = item;
            }}
        >
            <BaseAutocomplete.Input
                placeholder={placeholder}
                aria-label={ariaLabel}
                data-testid={testId}
                onKeyDown={onInputKeyDown}
                className={clsx(styles.input, className)}
            />
            {/* No suggestions, no popup — an empty list box would float under the field. */}
            {items.length > 0 && (
                <BaseAutocomplete.Portal>
                    <BaseAutocomplete.Positioner className={styles.positioner} sideOffset={4}>
                        <BaseAutocomplete.Popup {...{ [MODAL_POPUP_ATTR]: '' }} className={styles.popup}>
                            <BaseAutocomplete.List>
                                {(item: T) => (
                                    <BaseAutocomplete.Item
                                        key={itemKey(item)}
                                        value={item}
                                        onClick={() => onItemPicked(item)}
                                        data-testid={itemTestId?.(item)}
                                        className={styles.item}
                                    >
                                        {renderItem(item)}
                                    </BaseAutocomplete.Item>
                                )}
                            </BaseAutocomplete.List>
                        </BaseAutocomplete.Popup>
                    </BaseAutocomplete.Positioner>
                </BaseAutocomplete.Portal>
            )}
        </BaseAutocomplete.Root>
    );
}
