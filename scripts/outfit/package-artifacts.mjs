import { cp, mkdir, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BRAND } from './branding.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));

async function files(directory, suffix) {
    const result = [];
    for (const item of await readdir(directory, { withFileTypes: true })) {
        const file = path.join(directory, item.name);
        if (item.isDirectory()) result.push(...await files(file, suffix));
        else if (item.isFile() && item.name.endsWith(suffix)) result.push(file);
    }
    return result;
}

// Android/OHOS use fixed project output names. Give the downloadable files the
// edition name as well as the architecture, without modifying signed bytes.
export async function packageAndroid(source, destination) {
    const metadata = await files(source, 'output-metadata.json');
    if (!metadata.length) throw new Error(`No APK metadata in ${source}`);
    await mkdir(destination, { recursive: true });
    const names = new Set();
    for (const file of metadata) {
        const data = JSON.parse(await readFile(file, 'utf8'));
        if (data.artifactType?.type !== 'APK') throw new Error(`Unexpected Android artifact metadata: ${file}`);
        for (const apk of data.elements) {
            if (apk.outputFile.includes('unsigned')) throw new Error(`Unsigned APK: ${apk.outputFile}`);
            const abi = apk.filters.find(filter => filter.filterType === 'ABI')?.value ?? 'universal';
            const name = `${BRAND.productName}-${apk.versionName}-android-${abi}-${data.variantName}.apk`;
            if (names.has(name)) throw new Error(`Duplicate APK destination: ${name}`);
            names.add(name);
            await cp(path.join(path.dirname(file), apk.outputFile), path.join(destination, name), { force: false, errorOnExist: true });
        }
    }
    if (!names.size) throw new Error('APK metadata contained no APKs');
    return [...names];
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const host = path.join(root, 'src-tauri/crates/tauritavern');
    const destination = path.join(root, '.outfit-build/packages');
    if (process.argv[2] === 'android') {
        console.log(await packageAndroid(path.join(host, 'gen/android/app/build/outputs/apk'), destination));
    } else if (process.argv[2] === 'ohos') {
        const haps = await files(path.join(host, 'gen/ohos/entry/build/default/outputs/default'), '.hap');
        if (haps.length !== 1) throw new Error(`Expected one HAP, found ${haps.length}`);
        const { version } = JSON.parse(await readFile(path.join(host, 'tauri.conf.json'), 'utf8'));
        await mkdir(destination, { recursive: true });
        await cp(haps[0], path.join(destination, `${BRAND.productName}-${version}-ohos-${process.env.TARGET_TRIPLE}-unsigned.hap`), { force: false, errorOnExist: true });
    } else throw new Error('Usage: node scripts/outfit/package-artifacts.mjs android|ohos');
}
