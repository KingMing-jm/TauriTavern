import assert from 'node:assert/strict';
import test from 'node:test';
import { createRouteRegistry } from '../src/tauri/main/router.js';
import { registerSystemRoutes } from '../src/tauri/main/routes/system-routes.js';
import { registerNodePluginRoutes } from '../src/tauri/main/routes/node-plugin-routes.js';
import { readRequestBody, jsonResponse } from '../src/tauri/main/http-utils.js';

test('plugin routing preserves raw JSON, query, error status and binary response through the host fallback', async () => {
    const router = createRouteRegistry();
    registerSystemRoutes(router, {}, { jsonResponse });
    const body = '{ "value": "柏宝库" }';
    const input = new Request('http://localhost/api/plugins/baibaoku/v1/set?x=1', {
        method: 'POST', headers: { 'content-type': 'application/json', authorization: 'not-forwarded' }, body,
    });
    registerNodePluginRoutes(router, { async safeInvoke(command, { request }) {
        assert.equal(command, 'node_plugin_request');
        assert.equal(request.path, '/api/plugins/baibaoku/v1/set?x=1');
        assert.equal(new TextDecoder().decode(Uint8Array.from(request.body)), body);
        assert.deepEqual(request.headers, { 'content-type': 'application/json' });
        return { status: 422, headers: { 'content-type': 'application/octet-stream' }, body: [0, 128, 255] };
    } });
    const response = await router.handle({ method: input.method, path: new URL(input.url).pathname, url: new URL(input.url), input,
        body: await readRequestBody(input, undefined, router.bodyMode(input.method, new URL(input.url).pathname)),
    });
    assert.equal(response.status, 422);
    assert.deepEqual([...new Uint8Array(await response.arrayBuffer())], [0, 128, 255]);
});
