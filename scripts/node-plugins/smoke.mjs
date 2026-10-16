import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { createInterface } from 'node:readline';
import vm from 'node:vm';
import { createBrowserRuntime } from '../../tests/browser/runtime.mjs';

const runtime = path.resolve(process.argv[2] || '.cache/node-plugin-runtime');
const data = await mkdtemp(path.join(tmpdir(), 'tt-node-smoke-'));
await mkdir(path.join(data, 'default-user'));
const token = randomBytes(32).toString('hex');
const child = spawn(process.execPath, [path.join(runtime, 'host.mjs')], { stdio: ['pipe', 'pipe', 'pipe'] });
let logs = '';
child.stderr.on('data', bytes => { logs = (logs + bytes).slice(-16384); });
const exited = once(child, 'exit');
const reader = createInterface({ input: child.stdout });
const ready = Promise.race([
    once(reader, 'line').then(([line]) => JSON.parse(line)),
    exited.then(([code]) => { throw new Error(`Node startup failed (${code}): ${logs}`); }),
]);
child.stdin.write(JSON.stringify({ token, userRoot: path.join(data, 'default-user') }) + '\n');
const browser = createBrowserRuntime();
let stopped = false;
try {
    const { port, plugins } = await ready;
    assert.deepEqual(plugins, ['baibaoku']);
    const base = `http://127.0.0.1:${port}`;
    assert.equal((await fetch(base + '/api/plugins/baibaoku/v1/status')).status, 403);
    assert.equal((await fetch(base + '/api/plugins/baibaoku/v1/status', { headers: { 'x-tt-node-token': token, origin: 'http://localhost' } })).status, 403);
    const nativeInvoke = browser.window.__TAURI__.core.invoke;
    browser.window.__TAURI__.core.invoke = async (command, args) => {
        if (command !== 'node_plugin_request') return nativeInvoke(command, args);
        const request = args.request;
        assert.ok(request.path.startsWith('/api/plugins/'));
        const response = await fetch(base + request.path, {
            method: request.method, headers: { ...request.headers, 'x-tt-node-token': token },
            body: ['GET', 'HEAD'].includes(request.method) ? undefined : Buffer.from(request.body),
            redirect: 'manual',
        });
        return { status: response.status, headers: Object.fromEntries(response.headers), body: [...new Uint8Array(await response.arrayBuffer())] };
    };
    await browser.startHost();
    const client = await browser.window.fetch('/api/plugins/baibaoku/v1/client.js');
    assert.equal(client.status, 200);
    assert.match(client.headers.get('content-type'), /javascript/);
    vm.runInContext(await client.text(), browser.window, { filename: 'baibaoku-client.js' });
    const bridge = browser.window.BaiBaoKu;
    assert.equal(await bridge.isAvailable(), true);
    const db = bridge.database('browser-validation');
    await db.open();
    await db.set('values', 'json', { hello: '柏宝库' });
    assert.equal((await db.get('values', 'json')).value.hello, '柏宝库');
    await Promise.all(Array.from({ length: 12 }, (_, i) => db.set('values', `parallel-${i}`, i)));
    assert.deepEqual(Array.from((await db.getMany('values', ['parallel-0', 'parallel-11'])).entries, entry => entry.value), [0, 11]);
    await assert.rejects(() => bridge.database('../escape').open());
    await assert.rejects(() => bridge.request('chats/save-generate', {}), error => error.code === 'TT_CAPABILITY_UNAVAILABLE');
    const vector = Buffer.alloc(8);
    vector.writeFloatLE(1, 0); vector.writeFloatLE(0, 4);
    await bridge.request('vec/upsert', { database: 'browser-validation', scope: 'test', items: [{ leafId: 'leaf-1', vector: vector.toString('base64'), payload: { text: 'match' } }] });
    const matches = await bridge.request('vec/search', { database: 'browser-validation', scopes: ['test'], queryVectors: [vector.toString('base64')], topK: 1 });
    assert.ok(JSON.stringify(matches).includes('leaf-1'));
    const median = values => [...values].sort((a,b) => a-b)[Math.floor(values.length / 2)];
    const measure = async action => {
        const times = [];
        for (let i=0; i<12; i++) { const start = performance.now(); await action(i); if (i>1) times.push(performance.now()-start); }
        return Number(median(times).toFixed(3));
    };
    const singleWriteMs = await measure(i => db.set('perf', `key-${i}`, { text: 'x'.repeat(1024) }));
    const batch100Ms = await measure(i => db.setMany('perf', Array.from({length:100}, (_,j) => ({key:`batch-${i}-${j}`, value:{text:'x'.repeat(1024)}}))));
    const readMs = await measure(() => db.get('values', 'json'));
    console.log(JSON.stringify({ passed: true, source: 'BaiBaoKu original client + TT frontend router + Node host + SQLite',
        isolation: 'synthetic temporary user data',
        medianMs: { singleWrite1KiB: singleWriteMs, batch100Writes1KiB: batch100Ms, jsonRead: readMs },
        comparison: 'No native TT baseline measured; these timings do not establish an application performance improvement.',
    }, null, 2));
    const shutdown = await fetch(base + '/_tt/shutdown', { method: 'POST', headers: { 'x-tt-node-token': token } });
    assert.equal(shutdown.status, 200);
    assert.equal((await exited)[0], 0);
    stopped = true;
} finally {
    if (!stopped) { child.kill('SIGKILL'); await exited; }
    reader.close();
    await browser.window.happyDOM.close();
    await rm(data, { recursive: true, force: true });
}
