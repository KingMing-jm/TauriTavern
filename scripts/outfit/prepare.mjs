import { readFile, writeFile, mkdir, cp, access } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { prepareBranding } from './branding.mjs';

const root = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const build = path.join(root, '.outfit-build');
const tooling = path.join(build, 'tooling');
const extension = path.join(root, 'src/scripts/extensions/outfit-manager');
const native = path.join(root, 'scripts/outfit/native');
export const SOURCES = Object.freeze({
    frontend: { repo: 'wenshui012/Outfit-Manager', sha: 'e2a98eaf5bc860029d41e82b6a65a7c8f4f09a6d' },
    backend: { repo: 'wenshui012/Outfit-Manager-Server', sha: 'e13afe64dba250e92b62dd71932774ebbde00ae6' },
});
function run(command, args, cwd = root) {
    const result = spawnSync(command, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' && command === 'npm' });
    if (result.error || result.status !== 0) throw result.error || new Error(`${command} exited with ${result.status}`);
}
function gitOutput(args, cwd) {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8', shell: false });
    if (result.status !== 0) throw new Error(result.stderr || 'git command failed');
    return result.stdout.trim();
}
async function checkout(name, source) {
    const destination = path.join(build, name);
    if (!existsSync(destination)) {
        await mkdir(destination, { recursive: true });
        run('git', ['init', '--quiet'], destination);
        run('git', ['remote', 'add', 'origin', `https://github.com/${source.repo}.git`], destination);
        run('git', ['-c', 'core.hooksPath=/dev/null', 'fetch', '--depth=1', 'origin', source.sha], destination);
        run('git', ['-c', 'core.hooksPath=/dev/null', 'checkout', '--detach', 'FETCH_HEAD'], destination);
    }
    if (gitOutput(['rev-parse', 'HEAD'], destination) !== source.sha || gitOutput(['status', '--porcelain'], destination)) throw new Error(`Pinned ${name} checkout is missing, modified, or at the wrong revision`);
    return destination;
}
async function replaceOnce(filename, before, after) {
    const original = await readFile(filename, 'utf8');
    if (original.includes(after)) return;
    if (original.split(before).length !== 2) throw new Error(`Expected exactly one integration anchor in ${filename}; upstream changed`);
    await writeFile(filename, original.replace(before, after));
}
async function main() {
    await mkdir(build, { recursive: true });
    const frontend = await checkout('frontend', SOURCES.frontend);
    const backend = await checkout('backend', SOURCES.backend);
    const dependencyVersions = { esbuild: '0.25.10', '@noble/hashes': '1.8.0', buffer: '6.0.3', 'path-browserify': '1.0.1' };
    await mkdir(tooling, { recursive: true });
    await writeFile(path.join(tooling, 'package.json'), JSON.stringify({ private: true, type: 'module', dependencies: dependencyVersions }, null, 2));
    run('npm', [existsSync(path.join(tooling, 'package-lock.json')) ? 'ci' : 'install', '--ignore-scripts', '--no-audit', '--no-fund'], tooling);
    const { build: bundle } = await import(pathToFileURL(path.join(tooling, 'node_modules/esbuild/lib/main.js')).href);
    const supportedFs = new Set(['mkdirSync', 'existsSync', 'mkdir', 'access', 'readFile', 'writeFile', 'readdir', 'rename', 'unlink', 'rm', 'copyFile', 'cp', 'open', 'stat', 'lstat', 'constants']);
    const provenance = {};
    for (const file of ['index.js', 'recovery.js', 'storage-safety.js']) {
        const text = await readFile(path.join(backend, file), 'utf8');
        for (const match of text.matchAll(/\b(?:fs|fsp|defaultFsp)\.([A-Za-z_$][\w$]*)/g)) if (!supportedFs.has(match[1])) throw new Error(`Unsupported pinned backend filesystem operation: ${file}: ${match[1]}`);
        provenance[file] = createHash('sha256').update(text).digest('hex');
    }
    await cp(frontend, extension, { recursive: true, filter: source => !['.git', 'tests'].includes(path.basename(source)) });
    await cp(backend, path.join(extension, 'server-source'), { recursive: true, filter: source => !['.git', 'tests', 'data'].includes(path.basename(source)) });
    await writeFile(path.join(extension, 'upstream.js'), await readFile(path.join(frontend, 'index.js')));
    await writeFile(path.join(extension, 'index.js'), `import { installNativeBackend } from './native-backend.js';\ntry {\n    await installNativeBackend();\n    await import('./upstream.js');\n} catch (error) {\n    console.error('[outfit-native] Startup failed; data was not replaced', error);\n    const notice = document.createElement('div');\n    notice.style.cssText = 'position:fixed;inset:auto 12px 12px;z-index:2147483647;padding:12px;background:#381b1b;color:white;white-space:pre-wrap';\n    notice.textContent = '穿搭管理器启动失败，已停止加载以保护数据。请导出酒馆备份后排查。\\n' + String(error.message || error);\n    document.body.appendChild(notice);\n    throw error;\n}\n`);
    const manifest = JSON.parse(await readFile(path.join(extension, 'manifest.json'), 'utf8'));
    manifest.display_name += ' · Tauri 内置版';
    await writeFile(path.join(extension, 'manifest.json'), JSON.stringify(manifest, null, 2));
    await bundle({
        entryPoints: [path.join(native, 'entry.mjs')],
        outfile: path.join(extension, 'native-backend.js'),
        bundle: true, platform: 'browser', format: 'esm', target: ['safari15.4', 'chrome96'],
        sourcemap: 'external', minify: false, legalComments: 'eof',
        nodePaths: [path.join(tooling, 'node_modules')],
        inject: [path.join(native, 'globals.mjs')], define: { __dirname: JSON.stringify('/outfit') },
        plugins: [{ name: 'outfit-node-compatibility', setup(builder) {
            const aliases = {
                fs: path.join(native, 'filesystem.mjs'), 'fs/promises': path.join(native, 'filesystem.mjs'),
                crypto: path.join(native, 'crypto.mjs'), express: path.join(native, 'express.mjs'),
                path: path.join(tooling, 'node_modules/path-browserify/index.js'),
                buffer: path.join(tooling, 'node_modules/buffer/index.js'),
                'outfit-backend': path.join(backend, 'index.js'),
            };
            builder.onResolve({ filter: /^(?:node:)?(?:fs(?:\/promises)?|crypto|express|path|buffer|outfit-backend)$/ }, args => ({ path: aliases[args.path.replace(/^node:/, '')] }));
        } }],
    });
    const repository = path.join(root, 'src-tauri/crates/tt-adapter-extension/src/repositories/file_extension_repository.rs');
    await replaceOnce(repository, '    "tauritavern-version",', '    "tauritavern-version",\n    "outfit-manager",');
    await prepareBranding(root);
    const { releaseTargets } = await import('./release-workflow.mjs');
    const result = { sources: SOURCES, backendSha256: provenance, dependencies: dependencyVersions, backendMode: 'original JavaScript backend + native atomic filesystem bridge; no Node runtime', targets: await releaseTargets(), androidApplicationId: 'com.kingming.tauritavern.outfit' };
    await writeFile(path.join(build, 'BUILD-MANIFEST.json'), JSON.stringify(result, null, 2));
    await writeFile(path.join(extension, 'BUILD-MANIFEST.json'), JSON.stringify(result, null, 2));
    for (const file of ['index.js', 'upstream.js', 'native-backend.js', 'src/db.js', 'server-source/index.js', 'server-source/recovery.js', 'server-source/storage-safety.js']) await access(path.join(extension, file));
    console.log('Prepared pinned frontend and original backend for all upstream release targets.');
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
