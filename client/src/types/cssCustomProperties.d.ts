import 'react';

// Lets `style` carry CSS custom properties (`style={{ '--account-color': color }}`) — the way a
// per-call value reaches a CSS Module — without casting.
declare module 'react' {
    interface CSSProperties {
        [customProperty: `--${string}`]: string | number | undefined;
    }
}
