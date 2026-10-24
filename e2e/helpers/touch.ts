import type { CDPSession, Locator, Page } from '@playwright/test';

/**
 * Real touch input for phone specs. Playwright's `touchscreen` only taps, so drags are driven
 * through CDP `Input.dispatchTouchEvent`. A phone context (touch + coarse pointer) also turns on
 * the always-visible reorder handles (one `(hover: none) and (pointer: coarse)` predicate).
 */
export const PHONE = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true };
/** Longer than the drag hook's 250 ms long press. */
export const LONG_PRESS_MS = 350;

export interface Point {
    x: number;
    y: number;
}

export async function touch(cdp: CDPSession, type: 'touchStart' | 'touchMove' | 'touchEnd', points: Point[]): Promise<void> {
    await cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points.map((p) => ({ x: p.x, y: p.y, radiusX: 4, radiusY: 4, force: 1, id: 1 })) });
}

export async function centerOf(locator: Locator): Promise<Point> {
    const box = await locator.boundingBox();
    if (!box) throw new Error('no box to touch');
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/** Moves a held finger from `from` toward `to` in steps (a frame apart), as a real glide does. */
export async function glide(page: Page, cdp: CDPSession, from: Point, to: Point, steps = 12): Promise<void> {
    for (let i = 1; i <= steps; i++) {
        await touch(cdp, 'touchMove', [{ x: from.x + ((to.x - from.x) * i) / steps, y: from.y + ((to.y - from.y) * i) / steps }]);
        await page.waitForTimeout(16);
    }
}

/** Long-press `handle`, glide vertically to `targetY`, hold still past the shift transition, release. */
export async function longPressDrag(page: Page, cdp: CDPSession, handle: Locator, targetY: number): Promise<void> {
    const start = await centerOf(handle);
    await touch(cdp, 'touchStart', [start]);
    await page.waitForTimeout(LONG_PRESS_MS);
    await glide(page, cdp, start, { x: start.x, y: targetY });
    // A user pauses before letting go; the drop must not depend on releasing mid-transition.
    await page.waitForTimeout(400);
    await touch(cdp, 'touchEnd', []);
}
