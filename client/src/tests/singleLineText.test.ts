import { describe, expect, it } from 'vitest';
import { collapseToSingleLine } from '../lib/singleLineText';

describe('collapseToSingleLine', () => {
    it('leaves a value with no line breaks untouched', () => {
        expect(collapseToSingleLine('Renew passport before the June trip')).toBe('Renew passport before the June trip');
    });

    it('turns a pasted line break into a single space', () => {
        expect(collapseToSingleLine('Renew passport\nbefore the June trip')).toBe('Renew passport before the June trip');
    });

    it('handles Windows line endings', () => {
        expect(collapseToSingleLine('Renew passport\r\nbefore the June trip')).toBe('Renew passport before the June trip');
    });

    it('handles a lone carriage return, which some spreadsheet copies produce', () => {
        expect(collapseToSingleLine('Renew passport\rbefore the June trip')).toBe('Renew passport before the June trip');
    });

    it('collapses a blank line and its surrounding indentation to one space', () => {
        expect(collapseToSingleLine('Renew passport\n\n    before the June trip')).toBe('Renew passport before the June trip');
    });

    it('does not glue the words on either side of a break together', () => {
        expect(collapseToSingleLine('one\ntwo')).not.toContain('onetwo');
    });

    it('keeps spacing around the break from doubling up', () => {
        expect(collapseToSingleLine('one \n two')).toBe('one two');
    });

    it('preserves interior spacing that is not a line break', () => {
        expect(collapseToSingleLine('one  two')).toBe('one  two');
    });

    it('returns an empty string unchanged', () => {
        expect(collapseToSingleLine('')).toBe('');
    });

    it('is idempotent, so re-collapsing a controlled value never drifts', () => {
        const once = collapseToSingleLine('a\nb\r\nc');
        expect(collapseToSingleLine(once)).toBe(once);
    });

    it('leaves a trailing break as a trailing space — callers trim before storing', () => {
        expect(collapseToSingleLine('Renew passport\n')).toBe('Renew passport ');
    });
});
