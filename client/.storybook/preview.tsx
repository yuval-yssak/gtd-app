import CssBaseline from '@mui/material/CssBaseline';
import { CssVarsProvider, extendTheme } from '@mui/material/styles';
import type { Preview } from '@storybook/react';

// Same theme configuration as the production app's __root.tsx
const theme = extendTheme({
    colorSchemes: { light: true, dark: true },
    colorSchemeSelector: '[data-color-scheme="%s"]',
});

const preview: Preview = {
    parameters: {
        controls: { matchers: { color: /(background|color)$/i, date: /Date$/i } },
        layout: 'centered',
    },
    decorators: [
        (Story) => (
            <CssVarsProvider theme={theme}>
                <CssBaseline />
                <Story />
            </CssVarsProvider>
        ),
    ],
};

export default preview;
