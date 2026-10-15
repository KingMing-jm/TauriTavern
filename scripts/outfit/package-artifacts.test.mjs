import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { packageAndroid } from './package-artifacts.mjs';

test('split APK downloads retain signed bytes and distinguish ABI and build variant', async t => {
    const temporary = await mkdtemp(path.join(os.tmpdir(), 'outfit-apk-'));
    t.after(() => rm(temporary, { recursive: true, force: true }));
    const source = path.join(temporary, 'apk');
    const destination = path.join(temporary, 'downloads');
    const expected = new Map();
    for (const variant of ['release', 'debug']) {
        const directory = path.join(source, variant);
        await mkdir(directory, { recursive: true });
        const elements = [];
        for (const abi of ['arm64-v8a', 'armeabi-v7a']) {
            const outputFile = `app-${abi}-${variant}.apk`;
            const bytes = Buffer.from([0x50, 0x4b, variant.length, abi.length, 0x00, 0xff]);
            await writeFile(path.join(directory, outputFile), bytes);
            elements.push({ outputFile, versionName: '2.3.0', filters: [{ filterType: 'ABI', value: abi }] });
            expected.set(`${abi}-${variant}.apk`, bytes);
        }
        await writeFile(path.join(directory, 'output-metadata.json'), JSON.stringify({ artifactType: { type: 'APK' }, variantName: variant, elements }));
    }
    const names = await packageAndroid(source, destination);
    assert.equal(new Set(names).size, 4);
    for (const [suffix, bytes] of expected) {
        const name = names.find(item => item.endsWith(suffix));
        assert.ok(name);
        assert.deepEqual(await readFile(path.join(destination, name)), bytes);
    }
    await assert.rejects(packageAndroid(source, destination), { code: 'ERR_FS_CP_EEXIST' });
});
