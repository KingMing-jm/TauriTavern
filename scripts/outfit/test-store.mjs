export function memoryStore() {
    const json = new Map(), blobs = new Map();
    const key = a => `${a.namespace}/${a.table}/${a.key}`;
    return {
        json, blobs, failCommit: false,
        async tryGetJson(a) { const k = key(a); return json.has(k) ? { found: true, value: structuredClone(json.get(k)) } : { found: false }; },
        async setJson(a) { if (this.failCommit) throw new Error('simulated native failure'); json.set(key(a), JSON.parse(JSON.stringify(a.value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item))); },
        async listKeys(a) { const prefix = `${a.namespace}/${a.table}/`; return [...json.keys()].filter(k => k.startsWith(prefix)).map(k => k.slice(prefix.length)); },
        async setBlob(a) { blobs.set(key(a), new Blob([a.data])); },
        async getBlob(a) { if (!blobs.has(key(a))) throw new Error('missing block'); return blobs.get(key(a)); },
        async deleteBlob(a) { blobs.delete(key(a)); },
        async listBlobKeys(a) { const prefix = `${a.namespace}/${a.table}/`; return [...blobs.keys()].filter(k => k.startsWith(prefix)).map(k => k.slice(prefix.length)); },
    };
}
