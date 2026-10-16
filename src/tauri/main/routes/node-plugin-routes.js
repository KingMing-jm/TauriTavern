export function registerNodePluginRoutes(router, context) {
    router.all('/api/plugins/*', async ({ method, url, body, input, init }) => {
        if (body != null && typeof body !== 'string') throw new Error('Node plugin transport requires a JSON or text request body');
        const encoded = body == null ? [] : Array.from(new TextEncoder().encode(body));
        const forwarded = {};
        const incoming = new Headers(init?.headers ?? input?.headers);
        for (const name of ['content-type', 'accept']) {
            const value = incoming.get(name);
            if (value) forwarded[name] = value;
        }
        const result = await context.safeInvoke('node_plugin_request', {
            request: { method, path: url.pathname + url.search, body: encoded, headers: forwarded },
        });
        return new Response([204, 205, 304].includes(result.status) || method === 'HEAD' ? null : new Uint8Array(result.body), {
            status: result.status, headers: result.headers,
        });
    }, { body: 'text' });
}
