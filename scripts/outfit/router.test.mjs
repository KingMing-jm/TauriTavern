import test from 'node:test';
import assert from 'node:assert/strict';
import { Router } from './native/express.mjs';
import { initializeFilesystem } from './native/filesystem.mjs';
import { memoryStore } from './test-store.mjs';
test('router decodes partition keys, preserves revisions and serializes calls', async () => {
    const router = Router(); const calls = [];
    router.put('/partitions/:key', async (req, res) => { await Promise.resolve(); calls.push(req.params.key); res.status(409).json({ revision: req.get('X-OM-Recovery-Revision'), body: req.body }); });
    const [a, b] = await Promise.all([
        router.dispatch('PUT', '/partitions/user%3A__default__', { value: 1 }, new Headers({ 'X-OM-Recovery-Revision': 'abc' })),
        router.dispatch('PUT', '/partitions/char%3A__shared__', { value: 2 }),
    ]);
    assert.deepEqual(calls, ['user:__default__', 'char:__shared__']);
    assert.equal(a.status, 409); assert.equal((await a.json()).revision, 'abc'); assert.equal((await b.json()).body.value, 2);
});
test('sendFile supports deferred bytes and upstream callback error handling', async () => {
    const fs = await initializeFilesystem(memoryStore()); await fs.mkdir('/outfit/data', { recursive: true }); await fs.writeFile('/outfit/data/p.png', Buffer.from([1, 2, 3]));
    const router = Router();
    router.get('/images/:name', (req, res) => res.sendFile('/outfit/data/' + req.params.name, error => { if (error) res.status(error.code === 'ENOENT' ? 404 : 500).json({ error: error.message }); }));
    const ok = await router.dispatch('GET', '/images/p.png'); assert.equal(ok.status, 200); assert.deepEqual([...new Uint8Array(await ok.arrayBuffer())], [1, 2, 3]);
    assert.equal((await router.dispatch('GET', '/images/missing.png')).status, 404);
});
test('unknown routes are not passed to the network and thrown errors do not poison the queue', async () => {
    const router = Router(); router.get('/fail', () => { throw new Error('read failed'); });
    await assert.rejects(router.dispatch('GET', '/fail'), /read failed/);
    assert.equal((await router.dispatch('DELETE', '/unknown')).status, 404);
});
