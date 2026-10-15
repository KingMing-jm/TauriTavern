import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { PACKAGING_BRANCH, prepareSync, publishSync } from './sync-upstream.mjs';

function git(cwd, ...args) {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
async function fixture(t) {
    const root = await mkdtemp(path.join(os.tmpdir(), 'outfit-sync-test-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const repo = path.join(root, 'repo'), remote = path.join(root, 'remote.git');
    git(root, 'init', '--bare', remote);
    git(root, 'init', '-b', 'main', repo);
    git(repo, 'config', 'user.name', 'Sync test');
    git(repo, 'config', 'user.email', 'sync@example.invalid');
    const commit = async (name, text, message) => {
        await writeFile(path.join(repo, name), text);
        git(repo, 'add', name);
        git(repo, 'commit', '-m', message);
        return git(repo, 'rev-parse', 'HEAD');
    };
    const base = await commit('shared.txt', 'base\n', 'base');
    git(repo, 'remote', 'add', 'origin', remote);
    git(repo, 'push', 'origin', 'main');
    git(repo, 'checkout', '-b', PACKAGING_BRANCH);
    await commit('outfit.txt', 'custom plugin\n', 'bundle plugin');
    git(repo, 'push', 'origin', PACKAGING_BRANCH);
    git(repo, 'update-ref', 'refs/remotes/upstream/dev', base);
    return { root, repo, remote, base, commit };
}

test('no new upstream commits leaves both branches and the working tree unchanged', async t => {
    const f = await fixture(t);
    const before = git(f.repo, 'rev-parse', 'HEAD');
    const result = await prepareSync(f.repo);
    assert.equal(result.changed, false);
    assert.equal(git(f.repo, 'rev-parse', 'HEAD'), before);
    assert.equal(git(f.repo, 'status', '--porcelain'), '');
});

test('an upstream merge retains plugin data and publishes both branches atomically', async t => {
    const f = await fixture(t);
    git(f.repo, 'checkout', '-b', 'source', f.base);
    const update = await f.commit('upstream.txt', 'new upstream\n', 'upstream update');
    git(f.repo, 'update-ref', 'refs/remotes/upstream/dev', update);
    git(f.repo, 'checkout', PACKAGING_BRANCH);
    const result = await prepareSync(f.repo);
    assert.equal(result.featureChanged, true);
    assert.equal(await readFile(path.join(f.repo, 'outfit.txt'), 'utf8'), 'custom plugin\n');
    assert.equal(await readFile(path.join(f.repo, 'upstream.txt'), 'utf8'), 'new upstream\n');
    assert.equal(git(f.remote, 'rev-parse', 'main'), f.base, 'preparation cannot publish');
    git(f.repo, 'commit', '-m', 'validated merge');
    const published = publishSync(f.repo, result.mainSha);
    assert.equal(git(f.remote, 'rev-parse', 'main'), published.mainSha);
    assert.equal(git(f.remote, 'rev-parse', PACKAGING_BRANCH), published.featureSha);
    git(f.repo, 'merge-base', '--is-ancestor', update, published.featureSha);
});

test('conflicts do not alter either remote branch', async t => {
    const f = await fixture(t);
    const own = await f.commit('shared.txt', 'plugin change\n', 'custom change');
    git(f.repo, 'push', 'origin', PACKAGING_BRANCH);
    git(f.repo, 'checkout', '-b', 'source', f.base);
    const upstream = await f.commit('shared.txt', 'upstream change\n', 'conflicting source');
    git(f.repo, 'update-ref', 'refs/remotes/upstream/dev', upstream);
    git(f.repo, 'checkout', PACKAGING_BRANCH);
    await assert.rejects(prepareSync(f.repo), /shared\.txt/);
    assert.equal(git(f.remote, 'rev-parse', 'main'), f.base);
    assert.equal(git(f.remote, 'rev-parse', PACKAGING_BRANCH), own);
});

test('a concurrent user push rejects both branch updates without overwriting the user', async t => {
    const f = await fixture(t);
    git(f.repo, 'checkout', '-b', 'source', f.base);
    const upstream = await f.commit('upstream.txt', 'update\n', 'source update');
    git(f.repo, 'update-ref', 'refs/remotes/upstream/dev', upstream);
    git(f.repo, 'checkout', PACKAGING_BRANCH);
    const result = await prepareSync(f.repo);
    git(f.repo, 'commit', '-m', 'candidate');
    const concurrent = path.join(f.root, 'concurrent');
    git(f.root, 'clone', f.remote, concurrent);
    git(concurrent, 'config', 'user.name', 'User');
    git(concurrent, 'config', 'user.email', 'user@example.invalid');
    git(concurrent, 'checkout', PACKAGING_BRANCH);
    await writeFile(path.join(concurrent, 'user.txt'), 'keep this\n');
    git(concurrent, 'add', 'user.txt');
    git(concurrent, 'commit', '-m', 'user work');
    git(concurrent, 'push', 'origin', PACKAGING_BRANCH);
    const user = git(concurrent, 'rev-parse', 'HEAD');
    assert.throws(() => publishSync(f.repo, result.mainSha));
    assert.equal(git(f.remote, 'rev-parse', 'main'), f.base);
    assert.equal(git(f.remote, 'rev-parse', PACKAGING_BRANCH), user);
});
