'use strict';

// This launcher is packaged with the application. It never downloads or updates
// executable code at runtime. Only the native host knows the authentication token.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');

function writeReady(file, value) {
    const temporary = file + '.tmp';
    fs.writeFileSync(temporary, JSON.stringify(value), { mode: 0o600, flag: 'wx' });
    fs.renameSync(temporary, file);
}

async function start() {
    const [dataDir, readyFile, token] = process.argv.slice(2);
    if (!dataDir || !readyFile || !path.isAbsolute(dataDir) || !path.isAbsolute(readyFile)) {
        throw new Error('Absolute private data and readiness paths are required');
    }
    if (!/^[a-f0-9]{64}$/.test(token || '')) throw new Error('Invalid native transport token');
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });

    const configuration = require('./config.cjs');
    configuration.dataDir = dataDir;
    const express = require('express');
    const app = express();
    app.disable('x-powered-by');
    const expectedToken = Buffer.from(token, 'ascii');
    app.use((req, res, next) => {
        const supplied = req.headers['x-tt-outfit-token'];
        if (req.headers.origin || typeof supplied !== 'string' || supplied.length !== token.length ||
            !crypto.timingSafeEqual(Buffer.from(supplied, 'ascii'), expectedToken)) {
            res.status(403).json({ ok: false, error: 'Native transport authentication required' });
            return;
        }
        res.set('X-Content-Type-Options', 'nosniff');
        next();
    });

    // Do not listen before the upstream transaction journal and storage recovery
    // have completed. The normal frontend must never see an unhydrated backend.
    const router = express.Router();
    const plugin = require('./server/index.js');
    await plugin.init(router);
    app.use('/api/plugins/outfit-manager', router);
    app.use((_req, res) => res.status(404).json({ ok: false, error: 'Unknown Outfit endpoint' }));
    app.use((error, _req, res, _next) => {
        res.status(error.status === 413 ? 413 : 500).json({ ok: false, error: 'Outfit request failed' });
    });
    const server = http.createServer({ maxHeaderSize: 8192 }, app);
    server.requestTimeout = 120000;
    server.headersTimeout = 10000;
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    writeReady(readyFile, { ok: true, port: server.address().port });
    return server;
}

if (require.main === module) {
    start().catch((error) => {
        // node::Start is in-process on Android: never call process.exit here,
        // because that would terminate Tauri rather than just a child process.
        const readyFile = process.argv[3];
        if (readyFile && path.isAbsolute(readyFile)) {
            try { writeReady(readyFile, { ok: false, error: String(error.message || error) }); }
            catch (writeError) { console.error('[outfit-native] Readiness reporting failed:', writeError.message); }
        }
        console.error('[outfit-native] Backend startup failed:', error.message);
    });
}

module.exports = { start, writeReady };
