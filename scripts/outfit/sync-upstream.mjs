import { execFileSync } from 'node:child_process';
import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PACKAGING_BRANCH = 'feat/outfit-manager-bundled';
function git(cwd, args, options = {}) {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options }).trim();
}
function ancestor(cwd, base, head) {
    try {
        git(cwd, ['merge-base', '--is-ancestor', base, head]);
        return true;
    } catch (error) {
        if (error.status === 1) return false;
        throw error;
    }
}
function merge(cwd, upstream, commit) {
    try {
        git(cwd, ['merge', '--no-ff', commit ? '--no-edit' : '--no-commit', upstream]);
    } catch (cause) {
        const conflicts = git(cwd, ['diff', '--name-only', '--diff-filter=U']);
        throw new Error(`Upstream merge stopped; nothing was pushed.\n${conflicts || cause.stderr || cause.message}`, { cause });
    }
}
/** Prepare both branch candidates locally. Remote refs are changed only by publishSync. */
export async function prepareSync(cwd, { sourceRef = 'refs/remotes/upstream/dev', mainRef = 'refs/remotes/origin/main' } = {}) {
    if (git(cwd, ['status', '--porcelain'])) throw new Error('Sync requires a clean build checkout');
    const upstreamSha = git(cwd, ['rev-parse', `${sourceRef}^{commit}`]);
    const featureBase = git(cwd, ['rev-parse', 'HEAD']);
    let mainSha = git(cwd, ['rev-parse', `${mainRef}^{commit}`]);
    const featureChanged = !ancestor(cwd, upstreamSha, featureBase);
    const mainChanged = !ancestor(cwd, upstreamSha, mainSha);
    if (mainChanged) {
        const temporary = await mkdtemp(path.join(os.tmpdir(), 'outfit-upstream-'));
        const checkout = path.join(temporary, 'main');
        let attached = false;
        try {
            git(cwd, ['worktree', 'add', '--detach', checkout, mainSha]);
            attached = true;
            merge(checkout, upstreamSha, true);
            mainSha = git(checkout, ['rev-parse', 'HEAD']);
        } finally {
            if (attached) git(cwd, ['worktree', 'remove', '--force', checkout]);
            await rm(temporary, { recursive: true, force: true });
        }
    }
    if (featureChanged) merge(cwd, upstreamSha, false);
    return { changed: featureChanged || mainChanged, featureChanged, upstreamSha, mainSha, featureBase };
}

export async function finalizeSync(cwd, upstreamSha) {
    if (!/^[a-f0-9]{40}$/.test(upstreamSha)) throw new Error('Invalid upstream commit');
    const merged = git(cwd, ['rev-parse', 'MERGE_HEAD']);
    if (merged !== upstreamSha) throw new Error('Candidate is not merging the inspected upstream commit');
    execFileSync(process.execPath, ['scripts/outfit/release-workflow.mjs'], { cwd, stdio: 'inherit' });
    execFileSync(process.execPath, ['scripts/outfit/release-workflow.mjs', '--check'], { cwd, stdio: 'inherit' });
    const pinFile = path.join(cwd, 'integrations/outfit-manager/targets.json');
    const pins = JSON.parse(await readFile(pinFile, 'utf8'));
    pins.upstream.tauritavern = upstreamSha;
    await writeFile(pinFile, JSON.stringify(pins, null, 2) + '\n');
    git(cwd, ['add', '.github/workflows/outfit-macos.yml', 'integrations/outfit-manager/targets.json']);
    git(cwd, ['commit', '-m', `Merge upstream dev ${upstreamSha.slice(0, 12)} and refresh Outfit packaging`]);
}

export function publishSync(cwd, mainSha) {
    if (!/^[a-f0-9]{40}$/.test(mainSha)) throw new Error('Invalid main candidate');
    git(cwd, ['diff', '--exit-code', 'HEAD']);
    const featureSha = git(cwd, ['rev-parse', 'HEAD']);
    // A concurrent user push rejects the entire transaction; neither branch is forced.
    git(cwd, ['push', '--atomic', 'origin', `${mainSha}:refs/heads/main`, `${featureSha}:refs/heads/${PACKAGING_BRANCH}`]);
    return { mainSha, featureSha };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const cwd = process.cwd();
    switch (process.argv[2]) {
        case 'prepare': {
            const result = await prepareSync(cwd);
            if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT,
                `changed=${result.changed}\nfeature_changed=${result.featureChanged}\nupstream_sha=${result.upstreamSha}\nmain_sha=${result.mainSha}\n`);
            console.log(JSON.stringify(result));
            break;
        }
        case 'finalize': await finalizeSync(cwd, process.env.UPSTREAM_SHA); break;
        case 'publish': console.log(JSON.stringify(publishSync(cwd, process.env.MAIN_SHA))); break;
        default: throw new Error('Usage: node scripts/outfit/sync-upstream.mjs prepare|finalize|publish');
    }
}
