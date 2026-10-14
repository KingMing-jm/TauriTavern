import assert from 'node:assert/strict';
import { pathToFileURL, fileURLToPath } from 'node:url';
import path from 'node:path';
import { memoryStore } from './test-store.mjs';
import { installExtensionStoreApi } from '../../src/tauri/main/api/extension-store.js';
import { installHostIdentity, HOSTS } from '../../tests/helpers/host-identity.mjs';
import { defMeta, defPartition } from '../../.outfit-build/frontend/src/data.js';
const root = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const bundle = pathToFileURL(path.join(root, 'src/scripts/extensions/outfit-manager/native-backend.js')).href;
// Exercise the production store's validation and binary encoding, with only
// native command IO replaced. A permissive Blob mock hid empty staging files.
const disk = memoryStore();
const host = { __TAURITAVERN__: { api: {} } };
const previousWindow = globalThis.window;
globalThis.window = host;
const restoreIdentity = installHostIdentity(HOSTS.android);
const sessions = new Map(), readers = new Map();
let nextId = 0;
async function invoke(command, args, options) {
    switch (command) {
        case 'open_extension_store_entry': {
            const result = args.kind === 'json' ? await disk.tryGetJson(args) : null;
            if (args.kind === 'json' && !result.found) return null;
            const bytes = args.kind === 'json' ? Buffer.from(JSON.stringify(result.value)) : Buffer.from(await (await disk.getBlob(args)).arrayBuffer());
            const readerId = ++nextId;
            readers.set(readerId, bytes);
            return { readerId, mimeType: 'application/octet-stream' };
        }
        case 'read_bytes': {
            assert.ok(readers.has(args.rid));
            const bytes = readers.get(args.rid);
            readers.set(args.rid, Buffer.alloc(0));
            return new Uint8Array(bytes);
        }
        case 'plugin:resources|close': return assert.ok(readers.delete(args.rid));
        case 'begin_extension_store_commit': {
            const sessionId = String(++nextId);
            sessions.set(sessionId, { entry: args, bytes: Buffer.alloc(0) });
            return { sessionId, maxFrameBytes: 1024 };
        }
        case 'append_extension_store_commit_chunk': {
            const session = sessions.get(options.headers['session-id']);
            assert.equal(Number(options.headers.offset), session.bytes.length);
            assert.equal(options.headers['chunk-encoding'], 'base64');
            session.bytes = Buffer.concat([session.bytes, Buffer.from(args.data, 'base64')]);
            return session.bytes.length;
        }
        case 'finish_extension_store_commit': {
            const session = sessions.get(args.sessionId);
            assert.ok(sessions.delete(args.sessionId));
            assert.equal(args.expectedSize, session.bytes.length);
            return session.entry.operation === 'setBlob'
                ? disk.setBlob({ ...session.entry, data: session.bytes })
                : disk.setJson({ ...session.entry, value: JSON.parse(session.bytes.toString()) });
        }
        case 'abort_extension_store_commit': return assert.ok(sessions.delete(args.sessionId));
        case 'list_extension_store_keys': return args.kind === 'blob' ? disk.listBlobKeys(args) : disk.listKeys(args);
        case 'delete_extension_store_entry': return disk.deleteBlob(args);
        default: throw new Error(`Unexpected native store command: ${command}`);
    }
}
try {
    installExtensionStoreApi({ safeInvoke: invoke, invokeTransport: invoke });
} finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
}
const store = host.__TAURITAVERN__.api.extension.store;
let generation = 0;
async function start() { return (await import(bundle + '?generation=' + ++generation)).createNativeRuntime(store); }
let runtime = await start();
const request = (method, route, body, revision) => runtime.router.dispatch(method, route, body, new Headers(revision ? { 'X-OM-Recovery-Revision': revision } : {}));
async function json(method, route, body, revision) {
    const response = await request(method, route, body, revision);
    const value = await response.json();
    assert.equal(response.status, 200, `${method} ${route}: ${JSON.stringify(value)}`);
    assert.equal(value.ok, true);
    return value;
}
let status = await json('GET', '/status');
assert.equal(status.pluginVersion, '2.0.3');
assert.equal(status.storageState, 'NEW_INSTALL');
// Match the frontend's first upload into an empty v2 backend.
await json('PUT', '/partitions/batch', { meta: defMeta(), partitions: { 'user:__default__': defPartition() } });
const pixel = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aC9sAAAAASUVORK5CYII=';
await json('PUT', '/data', { outfits: [{ id: 'outfit1', name: 'original', imageData: pixel }], categories: [], activeIds: [], accessories: [], accCategories: [] });
status = await json('GET', '/status');
assert.equal(status.storageState, 'HEALTHY');
const original = (await json('GET', '/data')).data;
const imageUrl = original.outfits[0].imageData;
assert.match(imageUrl, /^\/api\/plugins\/outfit-manager\/images\/[a-f0-9]{40}\.png$/);
const image = await request('GET', imageUrl.replace('/api/plugins/outfit-manager', ''));
assert.equal(image.headers.get('content-type'), 'image/png');
assert.equal(Buffer.from(await image.arrayBuffer()).toString('base64'), pixel.split(',')[1]);
assert.equal((await json('POST', '/images/batch-fetch', { urls: [imageUrl] })).images[imageUrl], pixel);
const invalid = await request('PUT', '/partitions/' + encodeURIComponent('user:../../outside'), {});
assert.equal(invalid.status, 400);
const invalidBatch = await request('PUT', '/partitions/batch', { meta: {}, partitions: {} });
assert.equal(invalidBatch.status, 409);
assert.equal((await json('GET', '/data')).data.outfits[0].name, 'original');
const checkpoint = await json('POST', '/recovery/checkpoints', {});
const key = '/partitions/' + encodeURIComponent('user:__default__');
const partition = (await json('GET', key)).data;
partition.outfits[0].name = 'changed';
await json('PUT', key, partition);
const oldRevision = status.recoveryRevision;
await json('POST', '/recovery/restore', { snapshotId: checkpoint.snapshot.id });
assert.equal((await json('GET', '/data')).data.outfits[0].name, 'original');
assert.equal((await request('PUT', key, partition, oldRevision)).status, 409);
status = await json('GET', '/status');
partition.outfits = []; partition.activeIds = [];
await json('PUT', key, partition, status.recoveryRevision);
await json('POST', '/gc', {}, status.recoveryRevision);
assert.equal((await request('GET', imageUrl.replace('/api/plugins/outfit-manager', ''))).status, 200, 'snapshot image survives original backend GC');
await runtime.filesystem.compact();
runtime = await start();
assert.deepEqual((await json('GET', '/data')).data.outfits, []);
await json('POST', '/recovery/restore', { snapshotId: checkpoint.snapshot.id });
assert.equal((await json('GET', '/data')).data.outfits[0].name, 'original');
// Corrupt a live partition deliberately: neither boot nor PUT may turn it into an empty wardrobe.
await runtime.filesystem.writeFile('/outfit/data/part_user____default__.json', '{broken');
runtime = await start();
assert.equal((await request('GET', '/data')).status, 409);
assert.equal((await request('PUT', '/data', {})).status, 409);
console.log('PASS: original backend through TT store API: first partition upload, persistence, images, full-data conversion, batch rejection, snapshot restore, stale-client guard, GC and corrupt-data write lock.');

assert.equal(sessions.size, 0);
assert.equal(readers.size, 0);
restoreIdentity();
