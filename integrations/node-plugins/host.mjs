import express from 'express';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { timingSafeEqual } from 'node:crypto';
import { createInterface } from 'node:readline';
import { format } from 'node:util';

const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 13)) throw new Error('Node.js >=22.13.0 is required');

// stdout is a readiness channel. Plugin logs belong in the parent's log file.
for (const name of ['log', 'info', 'debug', 'warn', 'error']) {
    console[name] = (...args) => process.stderr.write(format(...args) + '\n');
}
const input = createInterface({ input: process.stdin });
const config = await new Promise((resolve, reject) => {
    input.once('line', line => {
        try { resolve(JSON.parse(line)); } catch (error) { reject(error); }
    });
    input.once('close', () => reject(new Error('Parent closed before configuration')));
});
if (!path.isAbsolute(config.userRoot) || !/^[a-f0-9]{64}$/.test(config.token)) {
    throw new Error('Invalid host configuration');
}
const app = express();
app.disable('x-powered-by');
app.use((req, res, next) => {
    const token = Buffer.from(req.get('x-tt-node-token') || '');
    const expected = Buffer.from(config.token);
    if (req.get('origin') || token.length !== expected.length || !timingSafeEqual(token, expected)) {
        return res.status(403).json({ error: 'Forbidden' });
    }
    next();
});
app.use(express.json({ limit: '8mb' }));
app.use((req, _res, next) => {
    req.user = { profile: { handle: 'default-user' }, directories: { root: config.userRoot } };
    next();
});
const plugins = [];
let server;
let closing;
async function shutdown() {
    if (closing) return closing;
    closing = (async () => {
        // Stop accepting work and drain requests before closing plugin databases.
        if (server) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        const results = await Promise.allSettled([...plugins].reverse().map(plugin => Promise.resolve().then(() => plugin.module.exit?.())));
        const errors = results.filter(result => result.status === 'rejected').map(result => result.reason);
        if (errors.length) throw new AggregateError(errors, 'Plugin cleanup failed');
    })();
    return closing;
}
function exit() {
    void shutdown().then(() => process.exit(0), error => {
        console.error(error);
        process.exit(1);
    });
}
input.on('close', exit); // Parent death also closes SQLite on Windows.
process.on('SIGTERM', exit);
process.on('SIGINT', exit);
try {
    const manifest = JSON.parse(await readFile(new URL('./plugins.json', import.meta.url), 'utf8'));
    const ids = new Set();
    for (const item of manifest) {
        if (!/^[a-z0-9_-]+$/.test(item.id) || ids.has(item.id)) throw new Error('Invalid or duplicate plugin id');
        ids.add(item.id);
        const entry = path.resolve(import.meta.dirname, item.entry);
        if (!entry.startsWith(import.meta.dirname + path.sep)) throw new Error('Plugin entry escapes runtime');
        const imported = await import(pathToFileURL(entry).href);
        const module = {
            info: imported.info ?? imported.default?.info,
            init: imported.init ?? imported.default?.init,
            exit: imported.exit ?? imported.default?.exit,
        };
        if (module.info?.id !== item.id || typeof module.init !== 'function'
            || typeof module.info.name !== 'string' || typeof module.info.description !== 'string') throw new Error(`Invalid plugin contract: ${item.id}`);
        const router = express.Router();
        plugins.push({ id: item.id, module });
        await module.init(router);
        app.use(`/api/plugins/${item.id}`, router);
    }
    app.post('/_tt/shutdown', (_req, res) => {
        // This control request must not hold server.close() open as a keep-alive.
        res.set('Connection', 'close').json({ ok: true });
        exit();
    });
    app.use((_req, res) => res.status(404).json({ error: 'Plugin endpoint not found' }));
    app.use((error, _req, res, _next) => {
        console.error(error);
        res.status(error.status || 500).json({ error: error.message });
    });
    server = await new Promise((resolve, reject) => {
        const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
        listener.on('error', reject);
    });
    process.stdout.write(JSON.stringify({ port: server.address().port, plugins: plugins.map(p => p.id) }) + '\n');
} catch (error) {
    console.error(error);
    await shutdown();
    process.exit(1);
}
