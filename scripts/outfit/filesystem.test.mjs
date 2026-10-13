import test from 'node:test';
import assert from 'node:assert/strict';
import { NativeFilesystem } from './native/filesystem.mjs';
import { memoryStore } from './test-store.mjs';
async function setup() { const store = memoryStore(); const fs = await new NativeFilesystem(store).initialize(); await fs.mkdir('/outfit/data', { recursive: true }); return { fs, store }; }

test('files and directories survive runtime reconstruction', async () => {
    const { fs, store } = await setup();
    await fs.writeFile('/outfit/data/meta.json', '{"value":"衣柜"}');
    const reopened = await new NativeFilesystem(store).initialize();
    assert.equal(await reopened.readFile('/outfit/data/meta.json', 'utf8'), '{"value":"衣柜"}');
    assert.deepEqual(await reopened.readdir('/outfit/data'), ['meta.json']);
});
test('nested directory rename is a single native index commit', async () => {
    const { fs, store } = await setup();
    await fs.mkdir('/outfit/data/staged/sub', { recursive: true });
    await fs.writeFile('/outfit/data/staged/sub/a', 'a');
    await fs.writeFile('/outfit/data/staged/b', 'b');
    let writes = 0; const setJson = store.setJson.bind(store); store.setJson = async a => { writes++; return setJson(a); };
    await fs.rename('/outfit/data/staged', '/outfit/data/live');
    assert.equal(writes, 1);
    assert.equal(await fs.readFile('/outfit/data/live/sub/a', 'utf8'), 'a');
    await assert.rejects(fs.access('/outfit/data/staged'), { code: 'ENOENT' });
});
test('failed directory commit leaves old disk generation intact and locks writes', async () => {
    const { fs, store } = await setup(); await fs.writeFile('/outfit/data/a', 'old');
    store.failCommit = true;
    await assert.rejects(fs.writeFile('/outfit/data/a', 'new'), { code: 'EIO' });
    await assert.rejects(fs.compact(), { code: 'EIO' });
    store.failCommit = false;
    const reopened = await new NativeFilesystem(store).initialize();
    assert.equal(await reopened.readFile('/outfit/data/a', 'utf8'), 'old');
});
test('failed acknowledgement after native commit preserves new generation', async () => {
    const { fs, store } = await setup(); await fs.writeFile('/outfit/data/a', 'old');
    const setJson = store.setJson.bind(store); store.setJson = async a => { await setJson(a); throw new Error('lost acknowledgement'); };
    await assert.rejects(fs.writeFile('/outfit/data/a', 'new'), { code: 'EIO' });
    await assert.rejects(fs.compact(), { code: 'EIO' });
    store.setJson = setJson;
    const reopened = await new NativeFilesystem(store).initialize();
    assert.equal(await reopened.readFile('/outfit/data/a', 'utf8'), 'new');
});
test('missing index with existing blocks is never a new installation', async () => {
    const { fs, store } = await setup(); await fs.writeFile('/outfit/data/a', 'valuable'); store.json.clear();
    await assert.rejects(new NativeFilesystem(store).initialize(), { code: 'EIO' });
    assert.equal(store.blobs.size, 1);
});
test('corrupt index is refused rather than overwritten', async () => {
    const { store } = await setup(); const value = [...store.json.values()][0]; value.entries['/outfit'].kind = 'file';
    await assert.rejects(new NativeFilesystem(store).initialize(), { code: 'EIO' });
});
test('referenced missing or corrupt block produces EIO, never ENOENT', async () => {
    const { fs, store } = await setup(); await fs.writeFile('/outfit/data/a', 'a');
    const k = [...store.blobs.keys()][0]; store.blobs.set(k, new Blob(['corrupt']));
    await assert.rejects(fs.readFile('/outfit/data/a'), { code: 'EIO' });
    store.blobs.delete(k); await assert.rejects(fs.readFile('/outfit/data/a'), { code: 'EIO' });
});
test('snapshots retain their blocks during compaction and live deletion', async () => {
    const { fs, store } = await setup(); await fs.writeFile('/outfit/data/live', 'v1');
    await fs.copyFile('/outfit/data/live', '/outfit/data/snapshot'); await fs.writeFile('/outfit/data/live', 'v2');
    await fs.unlink('/outfit/data/live'); await fs.compact();
    assert.equal(await fs.readFile('/outfit/data/snapshot', 'utf8'), 'v1'); assert.equal(store.blobs.size, 1);
});
test('exclusive temporary creation and atomic replacement match writer contract', async () => {
    const { fs } = await setup(); const handle = await fs.open('/outfit/data/temp', 'wx');
    await handle.writeFile(Buffer.from('new')); await handle.sync(); await handle.close();
    await assert.rejects(fs.open('/outfit/data/temp', 'wx'), { code: 'EEXIST' });
    await fs.writeFile('/outfit/data/live', 'old'); await fs.rename('/outfit/data/temp', '/outfit/data/live');
    assert.equal(await fs.readFile('/outfit/data/live', 'utf8'), 'new');
    const directory = await fs.open('/outfit/data', 'r'); await directory.sync(); await directory.close();
});
test('empty files persist without Blob IO and can be filled after restart', async () => {
    const { fs, store } = await setup();
    const { setBlob, getBlob } = store;
    store.setBlob = async () => { throw new Error('empty Blob writes are forbidden'); };
    store.getBlob = async () => { throw new Error('empty files have no Blob'); };
    const handle = await fs.open('/outfit/data/empty', 'wx'); await handle.close();
    const reopened = await new NativeFilesystem(store).initialize();
    assert.equal((await reopened.readFile('/outfit/data/empty')).length, 0);
    assert.equal((await reopened.stat('/outfit/data/empty')).size, 0);
    store.setBlob = setBlob;
    store.getBlob = getBlob;
    await reopened.writeFile('/outfit/data/empty', 'filled');
    assert.equal(await reopened.readFile('/outfit/data/empty', 'utf8'), 'filled');
});
test('concurrent writes do not lose directory entries', async () => {
    const { fs, store } = await setup(); await Promise.all(Array.from({ length: 30 }, (_, i) => fs.writeFile('/outfit/data/f' + i, String(i))));
    const reopened = await new NativeFilesystem(store).initialize(); assert.equal((await reopened.readdir('/outfit/data')).length, 30);
});
test('traversal and null bytes cannot access another namespace', async () => {
    const { fs } = await setup();
    for (const path of ['/etc/passwd', '/outfit/../../etc', '/outfit-other/a', '/outfit/data/\0']) await assert.rejects(fs.readFile(path));
});
test('mkdir below a file and destructive directory replacement are refused', async () => {
    const { fs } = await setup(); await fs.writeFile('/outfit/data/file', 'x');
    await assert.rejects(fs.mkdir('/outfit/data/file/child', { recursive: true }), { code: 'ENOTDIR' });
    await fs.mkdir('/outfit/data/dir'); await fs.writeFile('/outfit/data/dir/a', 'a');
    await assert.rejects(fs.rename('/outfit/data/file', '/outfit/data/dir'), { code: 'EISDIR' });
});
