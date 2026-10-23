import 'react';

// Lets a component set the drag displacement variable through `style` without a cast
// (`routes/_authenticated/next-actions.tsx`); the CSS module's `.rowShell` reads it.
declare module 'react' {
    interface CSSProperties {
        '--drag-shift'?: string;
    }
}
