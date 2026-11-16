import type { Page, Route } from '@playwright/test';
import { API_URL } from './env';

/** Parks every API request without answering it, while the page stays online. */
export async function hangApi(page: Page) {
    const parked: Route[] = [];
    const park = (route: Route) => {
        parked.push(route);
    };
    await page.route(`${API_URL}/**`, park);
    return {
        /** Lets the parked requests through and stops parking new ones. */
        release: async () => {
            await page.unroute(`${API_URL}/**`, park);
            // A request parked by a page that has since navigated is gone; continuing it throws.
            await Promise.all(parked.splice(0).map((route) => route.continue().catch(() => undefined)));
        },
    };
}
