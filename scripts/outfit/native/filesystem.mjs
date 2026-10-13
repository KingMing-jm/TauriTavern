/** Node filesystem subset backed by Tauri's native extension store.
 * Immutable blobs + one atomic directory index make file AND directory rename
 * indivisible. The upstream backend still owns journals, snapshots and GC.
 */
import { Buffer } from 'buffer';
import path from 'path';
import { createHash, randomBytes } from 'crypto';

const ROOT = '/outfit';
const NS = 'outfit-manager-native-v1';
const copy = value => JSON.parse(JSON.stringify(value));
// serde_json may reorder object keys across the native boundary.
const stableJson = value => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
const hash = data => createHash('sha256').update(data).digest('hex');
const uid = () => randomBytes(16).toString('hex');
export const constants = { F_OK: 0, R_OK: 4, W_OK: 2, X_OK: 1, COPYFILE_EXCL: 1 };
function fault(code, filename, detail = '') {
    return Object.assign(new Error(`${code}: ${filename}${detail ? ': ' + detail : ''}`), { code, path: filename });
}
function normalize(filename) {
    if (typeof filename !== 'string' || !filename.startsWith('/') || filename.includes('\0')) throw fault('EINVAL', String(filename));
    const result = path.posix.normalize(filename);
    if (result !== ROOT && !result.startsWith(ROOT + '/')) throw fault('EACCES', filename);
    return result;
}
function stats(item) {
    return {
        size: item.size || 0, mtimeMs: item.mtime, ctimeMs: item.mtime,
        mtime: new Date(item.mtime), ctime: new Date(item.mtime), mode: item.kind === 'dir' ? 0o40700 : 0o100600,
        isFile: () => item.kind === 'file', isDirectory: () => item.kind === 'dir', isSymbolicLink: () => false,
    };
}

export class NativeFilesystem {
    constructor(store, namespace = NS) {
        this.store = store;
        this.namespace = namespace;
        this.entries = null;
        this.queue = Promise.resolve();
        this.poisoned = false;
        this.dirty = false;
    }
    args(table, key) { return { namespace: this.namespace, table, key }; }
    async initialize() {
        const result = await this.store.tryGetJson(this.args('control', 'index'));
        if (result.found) {
            const index = result.value;
            if (index?.version !== 1 || !index.entries || hash(stableJson(index.entries)) !== index.sha256) throw fault('EIO', ROOT, 'directory index is corrupt; refusing empty initialization');
            for (const [name, item] of Object.entries(index.entries)) {
                if (normalize(name) !== name || !['file', 'dir'].includes(item?.kind) ||
                    (item.kind === 'file' && (!/^[a-f0-9]{32}$/.test(item.block) || !/^[a-f0-9]{64}$/.test(item.sha256) || !Number.isSafeInteger(item.size) || item.size < 0))) throw fault('EIO', name, 'invalid index entry');
            }
            if (index.entries[ROOT]?.kind !== 'dir') throw fault('EIO', ROOT, 'root directory is missing');
            for (const name of Object.keys(index.entries)) if (name !== ROOT && index.entries[path.dirname(name)]?.kind !== 'dir') throw fault('EIO', name, 'parent directory is missing');
            this.entries = index.entries;
        } else {
            const blocks = await this.store.listBlobKeys({ namespace: this.namespace, table: 'blocks' });
            const controls = await this.store.listKeys({ namespace: this.namespace, table: 'control' });
            if (blocks.length || controls.length) throw fault('EIO', ROOT, 'index missing with existing storage; manual recovery required');
            await this.publish({ [ROOT]: { kind: 'dir', mtime: Date.now() } });
        }
        return this;
    }
    async publish(entries) {
        try {
            await this.store.setJson({ ...this.args('control', 'index'), value: { version: 1, entries, sha256: hash(stableJson(entries)) } });
            this.entries = entries;
            this.dirty = false;
        } catch (error) {
            // A failed acknowledgement may follow a committed native rename.
            // Never guess which generation is live or garbage-collect its data.
            this.poisoned = true;
            throw fault('EIO', ROOT, `native index commit failed: ${error.message}`);
        }
    }
    run(task) {
        const pending = this.queue.then(async () => {
            if (!this.entries || this.poisoned) throw fault('EIO', ROOT, 'filesystem unavailable; restart and inspect data');
            if (this.dirty) await this.publish(copy(this.entries));
            return task();
        });
        this.queue = pending.catch(() => {});
        return pending;
    }
    entry(name) {
        const item = this.entries[name];
        if (!item) throw fault('ENOENT', name);
        return item;
    }
    requireParent(name) {
        const parent = this.entry(path.dirname(name));
        if (parent.kind !== 'dir') throw fault('ENOTDIR', path.dirname(name));
    }
    mkdirSync(filename, options = {}) {
        if (!this.entries || this.poisoned) throw fault('EIO', filename);
        const name = normalize(filename);
        if (this.entries[name]) {
            if (this.entries[name].kind !== 'dir' || !options.recursive) throw fault('EEXIST', name);
            return;
        }
        const next = copy(this.entries);
        const missing = [];
        for (let parent = name; !next[parent]; parent = path.dirname(parent)) missing.push(parent);
        const existingParent = path.dirname(missing[missing.length - 1]);
        if (next[existingParent]?.kind !== 'dir') throw fault('ENOTDIR', existingParent);
        if (!options.recursive && missing.length > 1) throw fault('ENOENT', path.dirname(name));
        for (const item of missing.reverse()) next[item] = { kind: 'dir', mtime: Date.now() };
        this.entries = next;
        this.dirty = true;
        return options.recursive ? missing[0] : undefined;
    }
    mkdir(filename, options) { return this.run(async () => { const result = this.mkdirSync(filename, options); if (this.dirty) await this.publish(copy(this.entries)); return result; }); }
    existsSync(filename) { return !!this.entries?.[normalize(filename)]; }
    stat(filename) { return this.run(() => stats(this.entry(normalize(filename)))); }
    access(filename) { return this.run(() => { this.entry(normalize(filename)); }); }
    readdir(filename, options = {}) {
        return this.run(() => {
            const name = normalize(filename);
            if (this.entry(name).kind !== 'dir') throw fault('ENOTDIR', name);
            return Object.keys(this.entries).filter(item => item !== name && path.dirname(item) === name).sort().map(item => {
                const basename = path.basename(item);
                return options?.withFileTypes ? { name: basename, ...stats(this.entries[item]) } : basename;
            });
        });
    }
    async readRaw(name) {
        const item = this.entry(name);
        if (item.kind !== 'file') throw fault('EISDIR', name);
        let raw;
        // Empty files are represented by the index; Tauri rejects empty Blobs.
        try { raw = item.size === 0 ? Buffer.alloc(0) : Buffer.from(await (await this.store.getBlob(this.args('blocks', item.block))).arrayBuffer()); }
        catch (error) { throw fault('EIO', name, `referenced data block unreadable: ${error.message}`); }
        if (raw.length !== item.size || hash(raw) !== item.sha256) throw fault('EIO', name, 'data block checksum mismatch');
        return raw;
    }
    readFile(filename, options) {
        return this.run(async () => {
            const raw = await this.readRaw(normalize(filename));
            const encoding = typeof options === 'string' ? options : options?.encoding;
            return encoding ? raw.toString(encoding) : raw;
        });
    }
    async writeRaw(name, data, options = {}) {
        this.requireParent(name);
        if (this.entries[name]?.kind === 'dir') throw fault('EISDIR', name);
        const flag = typeof options === 'object' ? options.flag : undefined;
        if (flag?.includes('x') && this.entries[name]) throw fault('EEXIST', name);
        const encoding = typeof options === 'string' ? options : options.encoding;
        let raw = Buffer.from(data, encoding || 'utf8');
        if (flag?.startsWith('a') && this.entries[name]) raw = Buffer.concat([await this.readRaw(name), raw]);
        const block = uid();
        if (raw.length) await this.store.setBlob({ ...this.args('blocks', block), data: new Uint8Array(raw) });
        const next = copy(this.entries);
        next[name] = { kind: 'file', block, sha256: hash(raw), size: raw.length, mtime: Date.now() };
        await this.publish(next);
    }
    writeFile(filename, data, options) { return this.run(() => this.writeRaw(normalize(filename), data, options)); }
    rename(from, to) {
        return this.run(async () => {
            const source = normalize(from), destination = normalize(to);
            if (source === ROOT || destination === ROOT) throw fault('EACCES', source);
            const item = this.entry(source);
            if (source === destination) return;
            this.requireParent(destination);
            if (destination.startsWith(source + '/')) throw fault('EINVAL', destination);
            if (this.entries[destination] && this.entries[destination].kind !== item.kind) throw fault(item.kind === 'dir' ? 'ENOTDIR' : 'EISDIR', destination);
            if (Object.keys(this.entries).some(name => name.startsWith(destination + '/'))) throw fault('ENOTEMPTY', destination);
            const next = copy(this.entries);
            for (const name of Object.keys(this.entries)) if (name === source || name.startsWith(source + '/')) {
                next[destination + name.slice(source.length)] = next[name];
                delete next[name];
            }
            await this.publish(next);
        });
    }
    unlink(filename) {
        return this.run(async () => {
            const name = normalize(filename);
            if (this.entry(name).kind === 'dir') throw fault('EISDIR', name);
            const next = copy(this.entries); delete next[name]; await this.publish(next);
        });
    }
    rm(filename, options = {}) {
        return this.run(async () => {
            const name = normalize(filename);
            if (name === ROOT) throw fault('EACCES', name);
            if (!this.entries[name]) { if (options.force) return; throw fault('ENOENT', name); }
            if (this.entries[name].kind === 'dir' && !options.recursive) throw fault('EISDIR', name);
            const next = copy(this.entries);
            for (const item of Object.keys(next)) if (item === name || item.startsWith(name + '/')) delete next[item];
            await this.publish(next);
        });
    }
    copyFile(from, to, mode = 0) {
        return this.run(async () => {
            const source = normalize(from), destination = normalize(to);
            const item = this.entry(source);
            if (item.kind !== 'file' || this.entries[destination]?.kind === 'dir') throw fault('EISDIR', source);
            this.requireParent(destination);
            if ((mode & constants.COPYFILE_EXCL) && this.entries[destination]) throw fault('EEXIST', destination);
            // Verify source bytes; unreadable data must not become a good snapshot.
            await this.readRaw(source);
            const next = copy(this.entries); next[destination] = { ...item, mtime: Date.now() }; await this.publish(next);
        });
    }
    cp(from, to, options = {}) {
        return this.run(async () => {
            const source = normalize(from), destination = normalize(to);
            const item = this.entry(source);
            if (destination === source || destination.startsWith(source + '/')) throw fault('EINVAL', destination);
            if (item.kind === 'dir' && !options.recursive) throw fault('EISDIR', source);
            this.requireParent(destination);
            const next = copy(this.entries);
            for (const name of Object.keys(this.entries)) if (name === source || name.startsWith(source + '/')) {
                const target = destination + name.slice(source.length);
                if (next[target] && options.force === false) { if (options.errorOnExist) throw fault('EEXIST', target); continue; }
                if (this.entries[name].kind === 'file') await this.readRaw(name);
                next[target] = { ...this.entries[name] };
            }
            await this.publish(next);
        });
    }
    async open(filename, flags = 'r') {
        const name = normalize(filename);
        if (typeof flags !== 'string') throw fault('ENOTSUP', name, 'numeric open flags');
        if (flags.startsWith('w')) await this.writeFile(name, Buffer.alloc(0), { flag: flags });
        else if (flags.startsWith('a')) await this.run(async () => { if (!this.entries[name]) await this.writeRaw(name, Buffer.alloc(0), { flag: flags }); });
        else await this.access(name);
        let closed = false;
        const ensure = () => { if (closed) throw fault('EBADF', name); };
        return {
            writeFile: (data, options) => { ensure(); if (flags === 'r') throw fault('EBADF', name); return this.writeFile(name, data, options); },
            readFile: options => { ensure(); return this.readFile(name, options); },
            sync: () => { ensure(); return this.run(() => undefined); },
            datasync: () => { ensure(); return this.run(() => undefined); },
            stat: () => { ensure(); return this.stat(name); },
            close: async () => { closed = true; },
        };
    }
    compact() {
        return this.run(async () => {
            const referenced = new Set(Object.values(this.entries).filter(item => item.kind === 'file').map(item => item.block));
            for (const block of await this.store.listBlobKeys({ namespace: this.namespace, table: 'blocks' })) if (!referenced.has(block)) await this.store.deleteBlob(this.args('blocks', block));
        });
    }
}

let instance;
export async function initializeFilesystem(store) { instance = await new NativeFilesystem(store).initialize(); return instance; }
const call = (method, args) => { if (!instance) throw fault('EIO', ROOT, 'filesystem not initialized'); return instance[method](...args); };
export const mkdirSync = (...args) => call('mkdirSync', args);
export const existsSync = (...args) => call('existsSync', args);
export const mkdir = (...args) => call('mkdir', args);
export const access = (...args) => call('access', args);
export const readFile = (...args) => call('readFile', args);
export const writeFile = (...args) => call('writeFile', args);
export const readdir = (...args) => call('readdir', args);
export const rename = (...args) => call('rename', args);
export const unlink = (...args) => call('unlink', args);
export const rm = (...args) => call('rm', args);
export const copyFile = (...args) => call('copyFile', args);
export const cp = (...args) => call('cp', args);
export const open = (...args) => call('open', args);
export const stat = (...args) => call('stat', args);
export const lstat = stat;
export const promises = { mkdir, access, readFile, writeFile, readdir, rename, unlink, rm, copyFile, cp, open, stat, lstat, constants };
export default { ...promises, promises, mkdirSync, existsSync, constants };
