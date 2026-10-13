const SERVER_BASE = '/api/plugins/outfit-manager';
const SERVER_IMAGES = SERVER_BASE + '/images/';
const IMAGE_NAME = /^[a-f0-9]{40}\.(?:jpg|png|webp|gif|bmp)$/i;

export function translateImages(value, from, to, depth = 0) {
    if (depth > 128) throw new Error('Outfit data exceeds the supported nesting depth');
    if (typeof value === 'string') {
        if (!value.startsWith(from)) return value;
        const name = value.slice(from.length);
        return IMAGE_NAME.test(name) ? to + name : value;
    }
    if (Array.isArray(value)) return value.map(item => translateImages(item, from, to, depth + 1));
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, translateImages(item, from, to, depth + 1)]));
    }
    return value;
}

function decodeBody(value) {
    if (typeof value !== 'string') throw new Error('Malformed native Outfit response');
    return Uint8Array.from(atob(value), char => char.charCodeAt(0));
}

export function createOutfitFetch({ originalFetch, invoke, imagePrefix, origin, baseUrl }) {
    return async function outfitFetch(input, init) {
        const rawUrl = input instanceof Request ? input.url : String(input);
        const url = new URL(rawUrl, baseUrl);
        if (url.origin !== origin || !url.pathname.startsWith(SERVER_BASE + '/')) {
            return originalFetch(input, init);
        }
        const request = input instanceof Request ? new Request(input, init) : new Request(url, init);
        request.signal.throwIfAborted();
        let body = null;
        if (request.method !== 'GET' && request.method !== 'HEAD') {
            const text = await request.text();
            if (text) body = translateImages(JSON.parse(text), imagePrefix, SERVER_IMAGES);
        }
        const result = await invoke('plugin:outfit|request', {
            request: {
                method: request.method,
                path: url.pathname + url.search,
                body,
                recoveryRevision: request.headers.get('X-OM-Recovery-Revision'),
            },
        });
        request.signal.throwIfAborted();
        let bytes = decodeBody(result.bodyBase64);
        const headers = new Headers({ 'Content-Type': result.contentType || 'application/octet-stream' });
        if (result.cacheControl) headers.set('Cache-Control', result.cacheControl);
        if ((result.contentType || '').includes('application/json') && bytes.length) {
            const decoded = JSON.parse(new TextDecoder().decode(bytes));
            bytes = new TextEncoder().encode(JSON.stringify(translateImages(decoded, SERVER_IMAGES, imagePrefix)));
        }
        return new Response(result.status === 204 || request.method === 'HEAD' ? null : bytes, { status: result.status, headers });
    };
}

export async function installOutfitTransport() {
    if (window.__OUTFIT_NATIVE_TRANSPORT_INSTALLED__) return;
    const core = window.__TAURI__?.core;
    if (!core?.invoke || !core?.convertFileSrc) throw new Error('The bundled Outfit extension requires its native Tauri backend');
    try {
        // Fail visibly before upstream initStorage: a native startup failure must
        // not fall back to an empty IndexedDB wardrobe and overwrite native data.
        const response = await core.invoke('plugin:outfit|request', {
            request: { method: 'GET', path: SERVER_BASE + '/status', body: null, recoveryRevision: null },
        });
        if (response.status !== 200) throw new Error('Native Outfit backend is not ready');
        const status = JSON.parse(new TextDecoder().decode(decodeBody(response.bodyBase64)));
        if (!status.ok || status.version !== 2 || !status.partitions || !status.partitionTransactions || !status.recovery) {
            throw new Error('The bundled Outfit backend does not provide the required storage safety features');
        }
        const imagePrefix = core.convertFileSrc('images', 'outfit-image') + '/';
        window.fetch = createOutfitFetch({
            originalFetch: window.fetch.bind(window),
            invoke: core.invoke,
            imagePrefix,
            origin: window.location.origin,
            baseUrl: window.location.href,
        });
        window.__OUTFIT_NATIVE_TRANSPORT_INSTALLED__ = true;
    } catch (error) {
        window.toastr?.error('内置穿搭后端初始化失败，已停止加载以保护衣柜数据。请查看应用日志。');
        throw error;
    }
}
