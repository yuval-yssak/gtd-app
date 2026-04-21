import { beforeEach, vi } from 'vitest';

// Silence incidental console.* from production code during tests.
// If a test has installed its own spy (e.g. vi.spyOn(console, 'warn')),
// isMockFunction is already true and we leave it alone — preserving tests
// that assert on console output (e.g. calendarIntegrationsDAO.updateTokens).
beforeEach(() => {
    if (!vi.isMockFunction(console.log)) vi.spyOn(console, 'log').mockImplementation(() => {});
    if (!vi.isMockFunction(console.info)) vi.spyOn(console, 'info').mockImplementation(() => {});
    if (!vi.isMockFunction(console.debug)) vi.spyOn(console, 'debug').mockImplementation(() => {});
    if (!vi.isMockFunction(console.warn)) vi.spyOn(console, 'warn').mockImplementation(() => {});
    if (!vi.isMockFunction(console.error)) vi.spyOn(console, 'error').mockImplementation(() => {});
});
