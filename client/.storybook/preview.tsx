import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import '@fontsource/inter/600.css';
import '@fontsource/inter/700.css';
// The reset + layer order main.tsx loads for the app; stories need the same document baseline.
import '../src/designSystem/tokens/base.css';
import type { Decorator, Preview } from '@storybook/react';
import { useEffect } from 'react';
import { API_SERVER } from '../src/constants/globals';

// Stamps the toolbar's scheme the same way lib/colorScheme.ts does in the app, so DS stories render
// both palettes from the same tokens.
const withColorScheme: Decorator = (Story, context) => {
    const scheme = context.globals.colorScheme === 'dark' ? 'dark' : 'light';
    useEffect(() => {
        document.documentElement.setAttribute('data-theme', scheme);
    }, [scheme]);
    return <Story />;
};

/** Empty answers for the reads components make on mount through non-seam modules. */
const EMPTY_API_READS: Array<[path: string, body: unknown]> = [
    ['/calendar/all-sync-configs', []],
    ['/sync/issues', { issues: [] }],
    ['/auth/get-session', null],
    ['/auth/multi-session/list-device-sessions', []],
];

const requestUrl = (input: RequestInfo | URL) => (typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);

/**
 * Keeps every story off the real API: the known mount-time reads get empty answers and anything
 * else aimed at the API server gets a 503. Installed before each story, so a story that stubs
 * fetch itself wraps this one — its unhandled requests still land here, never on a live server.
 */
function stubApiForStory() {
    const realFetch = window.fetch;
    window.fetch = async (input, init) => {
        const url = requestUrl(input);
        if (!API_SERVER || !url.startsWith(API_SERVER)) {
            return realFetch(input, init);
        }
        const { pathname } = new URL(url);
        const read = EMPTY_API_READS.find(([path]) => pathname === path);
        const [status, body] = read ? [200, read[1]] : [503, { error: `storybook: no API server for ${pathname}` }];
        return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
    };
    return () => {
        window.fetch = realFetch;
    };
}

const preview: Preview = {
    beforeEach: stubApiForStory,
    globalTypes: {
        colorScheme: {
            description: 'Colour scheme (data-theme on <html>)',
            toolbar: {
                title: 'Theme',
                icon: 'paintbrush',
                items: [
                    { value: 'light', title: 'Light' },
                    { value: 'dark', title: 'Dark' },
                ],
                dynamicTitle: true,
            },
        },
    },
    initialGlobals: { colorScheme: 'light' },
    parameters: {
        controls: { matchers: { color: /(background|color)$/i, date: /Date$/i } },
        layout: 'centered',
    },
    decorators: [withColorScheme],
};

export default preview;
