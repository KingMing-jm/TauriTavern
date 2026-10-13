import backend from 'outfit-backend';
import { Router } from './express.mjs';
import { initializeFilesystem } from './filesystem.mjs';
const BASE = '/api/plugins/outfit-manager';
const IMAGE_BASE = BASE + '/images/';
const jsonResponse = (value, status) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });

/** Only image presentation changes; persisted/exported URLs stay canonical. */
function installImageBridge(fetchImage) {
    const blobs = new Map();
    const pending = new Map();
    async function resolve(url) {
        if (blobs.has(url)) return blobs.get(url);
        if (!pending.has(url)) pending.set(url, (async () => {
            const response = await fetchImage(url);
            if (!response.ok) throw new Error(`Outfit image: HTTP ${response.status}`);
            const blob = URL.createObjectURL(await response.blob());
            blobs.set(url, blob);
            // Keep a bounded cache when old sheets/grids have been removed.
            if (blobs.size > 128) for (const [key, value] of blobs) {
                if (key !== url && !document.querySelector(`[src="${value}"], [style*="${value}"]`)) { URL.revokeObjectURL(value); blobs.delete(key); }
                if (blobs.size <= 96) break;
            }
            return blob;
        })().finally(() => pending.delete(url)));
        return pending.get(url);
    }
    function patch(element) {
        if (!(element instanceof Element)) return;
        const src = element.getAttribute('src');
        if (src?.startsWith(IMAGE_BASE)) resolve(src).then(url => {
            if (element.getAttribute('src') === src) element.setAttribute('src', url);
        }).catch(error => console.error('[outfit-native] Image read failed', error));
        const style = element.getAttribute('style');
        if (style?.includes(IMAGE_BASE)) {
            const urls = [...new Set(style.match(/\/api\/plugins\/outfit-manager\/images\/[a-fA-F0-9]{40}\.(?:jpg|png|webp|gif|bmp)/g) || [])];
            Promise.all(urls.map(async url => [url, await resolve(url)])).then(replacements => {
                if (element.getAttribute('style') !== style) return;
                let next = style; for (const [source, target] of replacements) next = next.split(source).join(target);
                element.setAttribute('style', next);
            }).catch(error => console.error('[outfit-native] Background read failed', error));
        }
    }
    const observer = new MutationObserver(changes => {
        for (const change of changes) {
            if (change.type === 'attributes') patch(change.target);
            else for (const node of change.addedNodes) if (node instanceof Element) { patch(node); node.querySelectorAll('img[src], [style]').forEach(patch); }
        }
    });
    document.querySelectorAll('img[src], [style]').forEach(patch);
    observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['src', 'style'] });
    window.addEventListener('pagehide', () => { observer.disconnect(); for (const url of blobs.values()) URL.revokeObjectURL(url); }, { once: true });
}

async function acquireLifetimeLock() {
    if (!navigator.locks?.request) throw new Error('Web Locks unavailable; refusing unsafe multi-window storage. Update the system WebView.');
    let grant, reject;
    const ready = new Promise((yes, no) => { grant = yes; reject = no; });
    navigator.locks.request('outfit-manager-native-v1', { mode: 'exclusive', ifAvailable: true }, async lock => {
        if (!lock) { reject(new Error('Outfit Manager storage is already open in another window.')); return; }
        // The browser releases this lock when the document is destroyed. Do not
        // release on pagehide while native writes may still be in flight.
        grant();
        await new Promise(() => {});
    }).catch(reject);
    return ready;
}

export async function installNativeBackend() {
    if (window.__OUTFIT_NATIVE_INSTALLED__) return;
    await (window.__TAURITAVERN__?.ready ?? window.__TAURITAVERN_MAIN_READY__);
    const store = window.__TAURITAVERN__?.api?.extension?.store;
    if (!store) throw new Error('Tauri native extension storage is unavailable.');
    await acquireLifetimeLock();
    const { filesystem, router } = await createNativeRuntime(store);
    const originalFetch = window.fetch;
    let writes = 0;
    window.fetch = async function(input, options) {
        const url = new URL(input instanceof Request ? input.url : String(input), location.href);
        if (url.origin !== location.origin || !(url.pathname === BASE || url.pathname.startsWith(BASE + '/'))) return originalFetch.call(this, input, options);
        const request = input instanceof Request ? new Request(input, options) : new Request(url, options);
        try {
            let body;
            if (!['GET', 'HEAD'].includes(request.method)) {
                const text = await request.text();
                if (new TextEncoder().encode(text).length > 64 * 1024 * 1024) return jsonResponse({ ok: false, error: 'Request exceeds 64 MiB' }, 413);
                if (text) { try { body = JSON.parse(text); } catch { return jsonResponse({ ok: false, error: 'Invalid JSON' }, 400); } }
            }
            const response = await router.dispatch(request.method, url.pathname.slice(BASE.length) || '/', body, request.headers);
            if (response.ok && !['GET', 'HEAD'].includes(request.method) && ++writes % 20 === 0) {
                await filesystem.compact().catch(error => console.warn('[outfit-native] Deferred block cleanup failed', error));
            }
            return response;
        } catch (error) {
            console.error('[outfit-native] Backend request failed', error);
            return jsonResponse({ ok: false, error: String(error.message || error), code: error.code || 'NATIVE_STORAGE_ERROR' }, 500);
        }
    };
    installImageBridge(url => window.fetch(url));
    window.__OUTFIT_NATIVE_INSTALLED__ = true;
}

/** Integration harness uses the exact browser bundle, not a mock backend. */
export async function createNativeRuntime(store) {
    const filesystem = await initializeFilesystem(store);
    const router = Router();
    await backend.init(router);
    return { filesystem, router };
}
