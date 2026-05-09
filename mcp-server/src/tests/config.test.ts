import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { collectTokensFromEnv, loadConfig } from '../config.js';

describe('loadConfig', () => {
    const origEnv = { ...process.env };
    beforeEach(() => {
        // Strip every GTD_API_TOKEN_* key so each test starts from a clean slate.
        for (const key of Object.keys(process.env)) {
            if (key === 'GTD_API_BASE' || key === 'GTD_API_TOKEN' || key.startsWith('GTD_API_TOKEN_')) {
                delete process.env[key];
            }
        }
    });
    afterEach(() => {
        process.env = { ...origEnv };
    });

    it('throws when no GTD API tokens are configured', () => {
        expect(() => loadConfig()).toThrow(/No GTD API tokens configured/);
    });

    it('defaults apiBase to http://localhost:4000 and stores the default token under "default"', () => {
        process.env.GTD_API_TOKEN = 'gtd_t';
        const cfg = loadConfig();
        expect(cfg.apiBase).toBe('http://localhost:4000');
        expect(cfg.tokens.get('default')).toBe('gtd_t');
    });

    it('strips trailing slashes from GTD_API_BASE', () => {
        process.env.GTD_API_BASE = 'https://api.example.com//';
        process.env.GTD_API_TOKEN = 'gtd_t';
        expect(loadConfig().apiBase).toBe('https://api.example.com');
    });
});

describe('collectTokensFromEnv', () => {
    it('returns a single-entry map for the default account when only GTD_API_TOKEN is set', () => {
        const tokens = collectTokensFromEnv({ GTD_API_TOKEN: 'gtd_default' } as NodeJS.ProcessEnv);
        expect(tokens.size).toBe(1);
        expect(tokens.get('default')).toBe('gtd_default');
    });

    it('enumerates additional accounts via GTD_API_TOKEN_<LABEL>, lowercasing the label', () => {
        const tokens = collectTokensFromEnv({
            GTD_API_TOKEN: 'gtd_default',
            GTD_API_TOKEN_WORK: 'gtd_work',
            GTD_API_TOKEN_PERSONAL2: 'gtd_p2',
        } as NodeJS.ProcessEnv);
        expect(tokens.get('default')).toBe('gtd_default');
        expect(tokens.get('work')).toBe('gtd_work');
        expect(tokens.get('personal2')).toBe('gtd_p2');
    });

    it('throws when an additional-account variable has an empty value', () => {
        expect(() => collectTokensFromEnv({ GTD_API_TOKEN: 'gtd_default', GTD_API_TOKEN_WORK: '' } as NodeJS.ProcessEnv)).toThrow(/Empty value/);
    });

    it('throws when there are no tokens at all', () => {
        expect(() => collectTokensFromEnv({} as NodeJS.ProcessEnv)).toThrow(/No GTD API tokens configured/);
    });

    it('rejects GTD_API_TOKEN_DEFAULT (reserved label)', () => {
        expect(() => collectTokensFromEnv({ GTD_API_TOKEN: 'gtd_default', GTD_API_TOKEN_DEFAULT: 'gtd_x' } as NodeJS.ProcessEnv)).toThrow(/reserved/);
    });

    it('lets the user run without GTD_API_TOKEN as long as a numbered account is set', () => {
        const tokens = collectTokensFromEnv({ GTD_API_TOKEN_WORK: 'gtd_work' } as NodeJS.ProcessEnv);
        expect(tokens.size).toBe(1);
        expect(tokens.get('work')).toBe('gtd_work');
        expect(tokens.has('default')).toBe(false);
    });
});
