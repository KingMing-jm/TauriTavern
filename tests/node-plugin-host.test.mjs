import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { cp, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

const prepared = process.env.TT_NODE_PLUGIN_RUNTIME;
test('real host loads CommonJS and ESM and runs every exit hook on parent disconnect', { skip: !prepared }, async () => {
    const runtime = await mkdtemp(path.join(tmpdir(), 'tt-node-lifecycle-'));
    let child;
    let exited;
    try {
        await cp(new URL('../integrations/node-plugins/host.mjs', import.meta.url), path.join(runtime, 'host.mjs'));
        await symlink(path.join(prepared, 'node_modules'), path.join(runtime, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
        const cjsExit = path.join(runtime, 'cjs-exited');
        const esmExit = path.join(runtime, 'esm-exited');
        await writeFile(path.join(runtime, 'fixture.cjs'), `
            module.exports = {
                info: { id:'cjs_test', name:'fixture', description:'test' },
                init(router) { router.get('/echo', (_req,res) => res.json({ language:'CommonJS' })); },
                async exit() { await require('node:fs/promises').writeFile(${JSON.stringify(cjsExit)}, 'closed'); }
            };
        `);
        await writeFile(path.join(runtime, 'fixture.mjs'), `
            import { writeFile } from 'node:fs/promises';
            export const info = { id:'esm-test', name:'fixture', description:'test' };
            export function init(router) { router.get('/echo', (_req,res) => res.status(207).send(Buffer.from([0,128,255]))); }
            export async function exit() { await writeFile(${JSON.stringify(esmExit)}, 'closed'); }
        `);
        await writeFile(path.join(runtime, 'plugins.json'), JSON.stringify([{ id: 'cjs_test', entry: 'fixture.cjs' }, { id: 'esm-test', entry: 'fixture.mjs' }]));
        child = spawn(process.execPath, [path.join(runtime, 'host.mjs')], { stdio: ['pipe', 'pipe', 'pipe'] });
        let logs = '';
        child.stderr.on('data', bytes => { logs += bytes; });
        exited = once(child, 'exit');
        const reader = createInterface({ input: child.stdout });
        const ready = Promise.race([
            once(reader, 'line').then(([line]) => JSON.parse(line)),
            exited.then(([code]) => { throw new Error(`Startup exited ${code}: ${logs}`); }),
        ]);
        const token = randomBytes(32).toString('hex');
        child.stdin.write(JSON.stringify({ token, userRoot: runtime }) + '\n');
        const { port } = await ready;
        const headers = { 'x-tt-node-token': token };
        const base = `http://127.0.0.1:${port}/api/plugins/`;
        const cjs = await fetch(base + 'cjs_test/echo', { headers });
        assert.deepEqual(await cjs.json(), { language: 'CommonJS' });
        const esm = await fetch(base + 'esm-test/echo', { headers });
        assert.equal(esm.status, 207);
        assert.deepEqual([...new Uint8Array(await esm.arrayBuffer())], [0, 128, 255]);
        child.stdin.end();
        assert.equal((await exited)[0], 0, logs);
        assert.equal(await readFile(cjsExit, 'utf8'), 'closed');
        assert.equal(await readFile(esmExit, 'utf8'), 'closed');
    } finally {
        if (child && child.exitCode === null) { child.kill('SIGKILL'); await exited; }
        await rm(runtime, { recursive: true, force: true });
    }
});
