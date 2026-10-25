/**
 * Token-discipline gate for the design system and the app CSS that consumes it.
 *
 * Colours come from tokens, geometry is RTL-safe (logical properties only), component modules
 * never style elements, no `!important` (the `@layer gtd.*` order makes it unnecessary), and
 * z-index and font-size only through the shared `--z-*` scale and `--type-*` ramp. Ported from
 * realtime-app's gate.
 *
 * Deliberate exceptions use `stylelint-disable-next-line <rule>` with a comment saying why.
 */

// Shared by every block below; the blocks only vary the selector policy.
const tokenDisciplineRules = {
    // CSS-modules pseudo-classes; without the ignore the rule crashes on `:global(.x)`.
    'selector-pseudo-class-no-unknown': [true, { ignorePseudoClasses: ['global', 'local'] }],
    'keyframes-name-pattern': ['^[a-z][a-zA-Z0-9]*$', { message: 'Expected keyframe name to be camelCase' }],

    // Colours only via var(--…) tokens.
    'color-no-hex': true,
    'color-named': 'never',
    'function-disallowed-list': ['rgb', 'rgba', 'hsl', 'hsla', 'hwb', 'lab', 'lch', 'color'],

    // Logical properties only — physical geometry breaks RTL.
    'property-disallowed-list': [
        'left',
        'right',
        'margin-left',
        'margin-right',
        'padding-left',
        'padding-right',
        '/^border-left/',
        '/^border-right/',
        '/^border-top-left/',
        '/^border-top-right/',
        '/^border-bottom-left/',
        '/^border-bottom-right/',
    ],
    'declaration-property-value-disallowed-list': {
        'text-align': ['left', 'right'],
        float: ['left', 'right'],
        clear: ['left', 'right'],
    },

    'declaration-no-important': true,

    // z-index from the shared scale; font-size from the type ramp (`inherit` and `calc()` for a
    // size derived from a token — a glyph scaled to its row).
    'declaration-property-value-allowed-list': {
        'z-index': ['/^var\\(--z-/', 'auto'],
        'font-size': ['/^var\\(--type-/', 'inherit', '/^calc\\(/'],
    },

    // Repo convention: camelCase classes (`styles.editIcon`).
    'selector-class-pattern': ['^[a-z][a-zA-Z0-9]*$', { message: 'Expected class selector to be camelCase' }],
};

export default {
    // The real scope boundary is the lint:css glob plus these overrides.
    rules: {},
    overrides: [
        {
            // Design-system modules: element selectors banned outright — variants are data-* attributes.
            files: ['src/designSystem/**/*.module.css'],
            extends: ['stylelint-config-standard'],
            rules: {
                ...tokenDisciplineRules,
                'selector-max-type': 0,
            },
        },
        {
            // App CSS (pages and app components): same rules, but type selectors are allowed below a class only — app surfaces style markup they don't author
            // (rendered markdown, svg icons, a DS list's <ul>).
            files: ['src/**/*.module.css', '!src/designSystem/**'],
            extends: ['stylelint-config-standard'],
            rules: {
                ...tokenDisciplineRules,
                'selector-max-type': [0, { ignore: ['descendant', 'child'] }],
                // CSS Modules composition.
                'property-no-unknown': [true, { ignoreProperties: ['composes'] }],
                // CodeMirror's own `cm-*` classes, reached through :global().
                'selector-class-pattern': ['^([a-z][a-zA-Z0-9]*|cm-[a-zA-Z-]+)$', { message: 'Expected class selector to be camelCase' }],
            },
        },
        {
            // The reset: element selectors are the whole point of a reset.
            files: ['src/designSystem/tokens/base.css'],
            extends: ['stylelint-config-standard'],
            rules: {
                ...tokenDisciplineRules,
                'selector-id-pattern': null,
                // The rem-downscaling queries use `em` widths, a font-relative unit that range syntax keeps.
                'media-feature-range-notation': 'context',
            },
        },
        {
            // The token definitions: raw hex lives here by design.
            files: ['src/designSystem/tokens/variables.css'],
            extends: ['stylelint-config-standard'],
            rules: {
                ...tokenDisciplineRules,
                'color-no-hex': null,
                'color-hex-length': null,
                'comment-empty-line-before': null,
                'custom-property-empty-line-before': null,
                'selector-max-type': 0,
            },
        },
    ],
};
