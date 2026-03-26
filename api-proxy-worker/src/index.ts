// Maps each custom subdomain to its Cloud Run service hostname.
// Cloud Run URLs share the same project hash (xi26ftoh4a) across services.
const UPSTREAM: Record<string, string> = {
    'api.getting-things-done.app': 'gtd-api-xi26ftoh4a-uc.a.run.app',
    'api-staging.getting-things-done.app': 'gtd-api-staging-xi26ftoh4a-uc.a.run.app',
};

export default {
    async fetch(request: Request): Promise<Response> {
        const url = new URL(request.url);
        const upstream = UPSTREAM[url.hostname];

        if (!upstream) {
            return new Response('Not found', { status: 404 });
        }

        url.hostname = upstream;
        // Preserve the original Host header so Cloud Run routes correctly
        const proxied = new Request(url, request);
        return fetch(proxied);
    },
};
