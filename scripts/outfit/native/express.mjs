/** Minimal in-process Express surface used by the pinned storage-only plugin.
 * No TCP listener, dynamic code loading, Node runtime, or remote filesystem.
 */
import { readFile } from './filesystem.mjs';
const LIMIT = 64 * 1024 * 1024;
const jsonResponse = (value, status) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
export function Router() {
    const routes = [];
    let queue = Promise.resolve();
    const router = {
        use() { return router; },
        async dispatch(method, pathname, body, headers = new Headers()) {
            const pending = queue.then(() => dispatch(method, pathname, body, headers));
            queue = pending.catch(() => {});
            return pending;
        },
    };
    for (const method of ['get', 'post', 'put', 'delete']) router[method] = (pattern, handler) => { routes.push({ method: method.toUpperCase(), pattern, handler }); return router; };
    async function dispatch(method, pathname, body, headers) {
        if (body !== undefined && new TextEncoder().encode(JSON.stringify(body)).length > LIMIT) return jsonResponse({ ok: false, error: 'Request exceeds 64 MiB' }, 413);
        const parts = pathname.split('/');
        for (const route of routes) {
            if (route.method !== method) continue;
            const expected = route.pattern.split('/');
            const params = {};
            if (parts.length !== expected.length || !expected.every((value, index) => {
                if (!value.startsWith(':')) return value === parts[index];
                try { params[value.slice(1)] = decodeURIComponent(parts[index]); return true; } catch { return false; }
            })) continue;
            let status = 200;
            const responseHeaders = new Headers();
            let resolve, reject, done = false;
            const response = new Promise((yes, no) => { resolve = yes; reject = no; });
            const send = value => { if (!done) { done = true; resolve(new Response(value, { status, headers: responseHeaders })); } };
            const res = {
                status(code) { status = code; return res; },
                json(value) { responseHeaders.set('Content-Type', 'application/json'); send(JSON.stringify(value)); return res; },
                end(value) { send(value ?? null); return res; },
                sendFile(filename, callback) {
                    readFile(filename).then(bytes => {
                        const mime = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', bmp: 'image/bmp' }[filename.split('.').pop().toLowerCase()];
                        responseHeaders.set('Content-Type', mime || 'application/octet-stream');
                        responseHeaders.set('X-Content-Type-Options', 'nosniff');
                        send(new Uint8Array(bytes));
                        callback?.();
                    }).catch(error => {
                        if (callback) callback(error);
                        else reject(error);
                    });
                },
            };
            const req = { body, params, headers: Object.fromEntries(headers), get: name => headers.get(name) };
            try { await route.handler(req, res); } catch (error) { reject(error); }
            return response;
        }
        return jsonResponse({ ok: false, error: 'Not found' }, 404);
    }
    return router;
}
export function json() { return (_req, _res, next) => next?.(); }
export default { Router, json };
