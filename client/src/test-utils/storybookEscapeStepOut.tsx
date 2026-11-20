import type { Decorator } from '@storybook/react';
import type { ReactNode } from 'react';
import { useEscapeStepsOutOfFields } from '../hooks/useEscapeStepsOutOfFields';

function EscapeStepOutHost({ children }: { children: ReactNode }) {
    useEscapeStepsOutOfFields();
    return children;
}

/** The app mounts the Escape step-out layer globally (GlobalShortcuts); a parked-field story needs it too. */
export const withEscapeStepOut: Decorator = (Story) => (
    <EscapeStepOutHost>
        <Story />
    </EscapeStepOutHost>
);
