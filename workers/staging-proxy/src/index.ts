export default {
    async fetch(request: Request): Promise<Response> {
        const url = new URL(request.url);
        // Rewrite host to the Cloudflare Pages staging branch URL
        url.hostname = 'staging.gtd-app-1c2.pages.dev';
        return fetch(new Request(url.toString(), request));
    },
};
