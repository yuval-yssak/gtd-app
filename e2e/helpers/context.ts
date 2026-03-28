import type { Browser, Page } from '@playwright/test';
import { loginAs } from './login';

export async function withOneLoggedInDevice(browser: Browser, email: string, fn: (page: Page) => Promise<void>): Promise<void> {
    const ctx = await browser.newContext();
    try {
        const page = await loginAs(ctx, email);
        await fn(page);
    } finally {
        await ctx.close();
    }
}

export async function withTwoLoggedInDevices(browser: Browser, email: string, fn: (page1: Page, page2: Page) => Promise<void>): Promise<void> {
    const ctx1 = await browser.newContext();
    const ctx2 = await browser.newContext();
    try {
        const page1 = await loginAs(ctx1, email);
        const page2 = await loginAs(ctx2, email);
        await fn(page1, page2);
    } finally {
        await ctx1.close();
        await ctx2.close();
    }
}
