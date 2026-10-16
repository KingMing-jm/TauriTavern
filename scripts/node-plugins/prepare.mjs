import { cp, mkdir, readFile, writeFile, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

export const source = { repo: 'baibai-git/baibaoku', sha: '1f8e6b409839141fd0c1afa6cdf3de49d7f3ad64' };
const root = fileURLToPath(new URL('../..', import.meta.url));
function run(command, args, cwd) {
    const result = spawnSync(command, args, { cwd, encoding: 'utf8', shell: process.platform === 'win32' && command === 'npm' });
    if (result.error || result.status !== 0) throw result.error || new Error(result.stderr || `${command} failed`);
    return result.stdout.trim();
}
export async function prepare(runtime) {
    await mkdir(runtime, { recursive: true });
    const checkout = path.join(root, '.cache/node-plugin-sources/baibaoku');
    await mkdir(checkout, { recursive: true });
    try { await access(path.join(checkout, '.git')); } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        run('git', ['init', '--quiet'], checkout);
        run('git', ['-c', 'core.hooksPath=/dev/null', 'fetch', '--depth=1', `https://github.com/${source.repo}.git`, source.sha], checkout);
        run('git', ['-c', 'core.hooksPath=/dev/null', 'checkout', '--detach', 'FETCH_HEAD'], checkout);
    }
    if (run('git', ['rev-parse', 'HEAD'], checkout) !== source.sha || run('git', ['status', '--porcelain'], checkout)) {
        throw new Error('BaiBaoKu source differs from the pinned revision');
    }
    await cp(path.join(root, 'integrations/node-plugins'), runtime, { recursive: true, filter: entry => path.basename(entry) !== 'node_modules' });
    run('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], runtime);
    const plugin = path.join(runtime, 'plugins/baibaoku');
    await mkdir(plugin, { recursive: true });
    await cp(checkout, plugin, { recursive: true, filter: entry => !['.git', 'node_modules'].includes(path.basename(entry)) });
    // Retain upstream KV/client/vector handlers, removing ST's server imports and
    // core-data writers. Every anchor is pinned; upstream drift fails preparation.
    let api = await readFile(path.join(plugin, 'src/api.js'), 'utf8');
    const remove = (start, end, keepEnd = false) => {
        const a = api.indexOf(start), b = api.indexOf(end, a);
        if (a < 0 || b < 0 || api.indexOf(start, a + start.length) !== -1) throw new Error(`BaiBaoKu integration anchor changed: ${start}`);
        api = api.slice(0, a) + api.slice(keepEnd ? b : b + end.length);
    };
    remove("import { registerStEndpoints }", "from './st-endpoints.js';\n");
    remove('import {\n    deletePresetBackup,', "from './preset-backups.js';\n");
    remove('    registerStEndpoints(router, manager);', '\n');
    remove("    router.post('/v1/preset-backups/save',", "    router.post('/v1/open',", true);
    const capabilities = 'capabilities: { saveGenerateCompleteResponseTool: true }';
    if (api.split(capabilities).length !== 2) throw new Error('BaiBaoKu capabilities anchor changed');
    api = api.replace(capabilities, 'capabilities: { storage: true, vectors: true, saveGenerateCompleteResponseTool: false, stEndpoints: false }');
    await writeFile(path.join(plugin, 'src/api.js'), api);
    await cp(path.join(root, 'scripts/node-plugins/baibaoku-entry.mjs'), path.join(plugin, 'tt-entry.mjs'));
    await writeFile(path.join(runtime, 'plugins.json'), JSON.stringify([{ id: 'baibaoku', entry: 'plugins/baibaoku/tt-entry.mjs' }], null, 2));
    await writeFile(path.join(runtime, 'BUILD-MANIFEST.json'), JSON.stringify({ source, mode: 'TT storage/vector entry; ST server routes and frontend patchers excluded' }, null, 2));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const runtime = path.resolve(process.argv[2] || path.join(root, '.cache/node-plugin-runtime'));
    const config = process.argv[3] ? path.resolve(process.argv[3], '_tauritavern/node-plugins.json') : null;
    if (config) {
        // Do not silently overwrite a user's runtime selection.
        try { await access(config); throw new Error(`Configuration already exists: ${config}`); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    await prepare(runtime);
    if (config) {
        await mkdir(path.dirname(config), { recursive: true });
        await writeFile(config, JSON.stringify({ node: process.execPath, runtime }, null, 2), { flag: 'wx' });
    }
    console.log(`Prepared Node plugin runtime: ${runtime}`);
}
