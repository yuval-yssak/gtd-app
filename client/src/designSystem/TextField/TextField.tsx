import { Field } from '@base-ui/react/field';
import { clsx } from 'clsx';
import { type ChangeEvent, type ComponentProps, type FocusEvent, type KeyboardEvent, type ReactNode, type Ref, useRef } from 'react';
import styles from './TextField.module.css';
import { useAutosizeTextarea } from './useAutosizeTextarea';

// Events are typed as input events for both the input and the textarea: Base UI's control types
// them that way, and every handler here reads only `target.value`, which both elements have.
type ControlChangeEvent = ChangeEvent<HTMLInputElement>;

/** Attributes forwarded onto the `<input>`/`<textarea>` itself (MUI `slotProps.htmlInput`). */
export type TextFieldControlProps = Omit<ComponentProps<'input'>, 'size' | 'value' | 'onChange' | 'className' | 'ref'> &
    // data-* hooks the app's keyboard layer reads (the list-search input marker, test ids).
    Partial<Record<`data-${string}`, string>>;

export type TextFieldProps = {
    label?: ReactNode | undefined;
    value?: string | number | undefined;
    defaultValue?: string | undefined;
    onChange?: ((event: ControlChangeEvent) => void) | undefined;
    placeholder?: string | undefined;
    type?: string | undefined;
    name?: string | undefined;
    id?: string | undefined;
    required?: boolean | undefined;
    disabled?: boolean | undefined;
    readOnly?: boolean | undefined;
    autoFocus?: boolean | undefined;
    autoComplete?: string | undefined;
    /** Grows with its content, never shorter than minRows. */
    multiline?: boolean | undefined;
    minRows?: number | undefined;
    /** Text under the control; turns red with `error`. */
    helperText?: ReactNode | undefined;
    error?: boolean | undefined;
    fullWidth?: boolean | undefined;
    size?: 'sm' | 'md' | undefined;
    startAdornment?: ReactNode | undefined;
    endAdornment?: ReactNode | undefined;
    inputProps?: TextFieldControlProps | undefined;
    inputRef?: Ref<HTMLInputElement> | Ref<HTMLTextAreaElement> | undefined;
    onBlur?: ((event: FocusEvent<HTMLInputElement>) => void) | undefined;
    onFocus?: ((event: FocusEvent<HTMLInputElement>) => void) | undefined;
    onKeyDown?: ((event: KeyboardEvent<HTMLInputElement>) => void) | undefined;
    className?: string | undefined;
    'data-testid'?: string | undefined;
};

/**
 * Labelled text input (MUI TextField). The label sits above the control and labels it, so
 * `getByRole('textbox', { name })` and `getByLabel` keep working.
 */
export function TextField({
    label,
    helperText,
    error,
    fullWidth,
    size = 'sm',
    disabled,
    startAdornment,
    endAdornment,
    className,
    'data-testid': testId,
    ...controlProps
}: TextFieldProps) {
    return (
        <Field.Root
            invalid={error ?? false}
            disabled={disabled ?? false}
            data-size={size}
            data-full-width={fullWidth || undefined}
            data-testid={testId}
            className={clsx(styles.root, className)}
        >
            {label !== undefined && (
                <Field.Label className={styles.label}>
                    {label}
                    {controlProps.required && (
                        <span className={styles.required} aria-hidden="true">
                            {' *'}
                        </span>
                    )}
                </Field.Label>
            )}
            <div className={styles.shell} data-multiline={controlProps.multiline || undefined}>
                {startAdornment !== undefined && <span className={styles.adornment}>{startAdornment}</span>}
                {controlProps.multiline ? <TextareaControl {...controlProps} /> : <InputControl {...controlProps} />}
                {endAdornment !== undefined && <span className={styles.adornment}>{endAdornment}</span>}
            </div>
            {helperText !== undefined && helperText !== '' && (
                <Field.Description className={styles.helper} data-error={error || undefined}>
                    {helperText}
                </Field.Description>
            )}
        </Field.Root>
    );
}

type ControlProps = Omit<
    TextFieldProps,
    'label' | 'helperText' | 'error' | 'fullWidth' | 'size' | 'startAdornment' | 'endAdornment' | 'className' | 'data-testid' | 'disabled'
>;

function InputControl({ inputProps, inputRef, multiline: _multiline, minRows: _minRows, ...rest }: ControlProps) {
    return <Field.Control {...inputProps} {...rest} ref={(node) => assignRef(inputRef, node)} className={styles.control} />;
}

function TextareaControl({ inputProps, inputRef, multiline: _multiline, minRows = 1, value, ...rest }: ControlProps) {
    const textareaRef = useRef<HTMLTextAreaElement | null>(null);
    const fitOnInput = useAutosizeTextarea(textareaRef);
    // The row bound is a per-call number, handed to the stylesheet as a custom property.
    const rowStyle = { '--textarea-min-rows': minRows };
    return (
        <Field.Control
            {...inputProps}
            {...rest}
            {...(value === undefined ? {} : { value })}
            onInput={(event) => {
                fitOnInput();
                inputProps?.onInput?.(event);
            }}
            render={
                <textarea
                    rows={minRows}
                    ref={(node) => {
                        textareaRef.current = node;
                        assignRef(inputRef, node);
                    }}
                    style={rowStyle}
                />
            }
            className={styles.control}
        />
    );
}

/**
 * Hands the rendered control to the caller's ref. The ref is typed for whichever element the caller
 * asked for (input or textarea); `multiline` decides which one exists, so the cast is the caller's
 * own contract, not a widening.
 */
function assignRef(ref: TextFieldProps['inputRef'], node: HTMLElement | null) {
    if (typeof ref === 'function') (ref as (element: HTMLElement | null) => void)(node);
    else if (ref) (ref as { current: HTMLElement | null }).current = node;
}
