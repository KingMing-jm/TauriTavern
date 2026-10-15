import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

// Package and executable names use hyphens; launcher labels use spaces.
// Installed identifiers intentionally remain unchanged across this rename.
export const BRAND = JSON.parse(await readFile(new URL('../../integrations/outfit-manager/targets.json', import.meta.url), 'utf8'));

async function jsonFile(root, filename, update) {
    const file = path.join(root, filename);
    const value = JSON.parse(await readFile(file, 'utf8'));
    update(value);
    await writeFile(file, JSON.stringify(value, null, 2) + '\n');
}
async function replace(root, filename, before, after) {
    const file = path.join(root, filename);
    const original = await readFile(file, 'utf8');
    if (original.includes(after)) return;
    if (original.split(before).length !== 2) throw new Error(`Branding anchor changed in ${filename}: ${before}`);
    await writeFile(file, original.replace(before, after));
}

/** Prepare the native projects in the same disposable checkout as the plugins. */
export async function prepareBranding(root) {
    const host = 'src-tauri/crates/tauritavern';
    await jsonFile(root, `${host}/tauri.conf.json`, config => {
        config.productName = BRAND.productName;
        config.mainBinaryName = BRAND.mainBinaryName;
        for (const window of config.app.windows) window.title = BRAND.displayName;
    });
    for (const [platform, config] of Object.entries({
        desktop: { identifier: BRAND.identifier },
        android: {},
        ios: { identifier: BRAND.identifier },
    })) {
        await writeFile(path.join(root, `.outfit-build/tauri.outfit.${platform}.conf.json`), JSON.stringify(config, null, 2));
    }

    // Keep Kotlin/JNI namespace and the Xcode target/scheme unchanged.
    await replace(root, `${host}/gen/android/app/build.gradle.kts`, 'applicationId = "com.tauritavern.client"', `applicationId = "${BRAND.identifier}"`);
    for (const locale of ['values', 'values-zh-rCN']) {
        for (const key of ['app_name', 'main_activity_title']) {
            await replace(root, `${host}/gen/android/app/src/main/res/${locale}/strings.xml`, `<string name="${key}">TauriTavern</string>`, `<string name="${key}">${BRAND.displayName}</string>`);
        }
    }
    await replace(root, `${host}/gen/apple/project.yml`, 'PRODUCT_BUNDLE_IDENTIFIER: com.tauritavern.client', `PRODUCT_BUNDLE_IDENTIFIER: ${BRAND.identifier}`);
    await replace(root, `${host}/gen/apple/project.yml`, 'PRODUCT_NAME: TauriTavern\n', `PRODUCT_NAME: ${BRAND.productName}\n`);
    for (const file of ['Info.macos.plist', 'gen/apple/tauritavern_iOS/Info.plist']) {
        await replace(root, `${host}/${file}`, '<plist version="1.0">\n<dict>\n', `<plist version="1.0">\n<dict>\n\t<key>CFBundleDisplayName</key>\n\t<string>${BRAND.displayName}</string>\n`);
    }
    for (const file of ['AppScope/resources/base/element/string.json', 'entry/src/main/resources/base/element/string.json']) {
        await jsonFile(root, `${host}/gen/ohos/${file}`, data => {
            for (const entry of data.string) {
                if (['app_name', 'module_desc', 'EntryAbility_desc', 'EntryAbility_label'].includes(entry.name)) entry.value = BRAND.displayName;
            }
        });
    }

    await replace(root, `${host}/bundle/linux/TauriTavern.desktop`, 'Name={{name}}', `Name=${BRAND.displayName}`);
    await replace(root, `${host}/bundle/linux/TauriTavern.desktop`, 'StartupWMClass=tauritavern', `StartupWMClass=${BRAND.mainBinaryName}`);
    await replace(root, `${host}/bundle/linux/com.tauritavern.client.metainfo.xml`, '<name>TauriTavern</name>', `<name>${BRAND.displayName}</name>`);
    await replace(root, `${host}/bundle/linux/com.tauritavern.client.metainfo.xml`, '<launchable type="desktop-id">TauriTavern.desktop</launchable>', `<launchable type="desktop-id">${BRAND.productName}.desktop</launchable>`);
    // Flatpak keeps its existing application ID, but consumes the renamed DEB tree.
    for (const [before, after] of [
        ['desktop_source="$desktop_dir/TauriTavern.desktop"', `desktop_source="$desktop_dir/${BRAND.productName}.desktop"`],
        ['s/^Icon=tauritavern$/Icon=$APP_ID/', `s/^Icon=${BRAND.mainBinaryName}$/Icon=$APP_ID/`],
        ["'*/apps/tauritavern.png'", `'*/apps/${BRAND.mainBinaryName}.png'`],
        ['>TauriTavern.desktop</launchable>', `>${BRAND.productName}.desktop</launchable>`],
    ]) await replace(root, 'packaging/flatpak/build-app.sh', before, after);
    await replace(root, 'packaging/flatpak/com.tauritavern.client.yml', 'command: tauritavern\n', `command: ${BRAND.mainBinaryName}\n`);
    await replace(root, 'nix/package.nix', 'pname = "tauritavern";', `pname = "${BRAND.mainBinaryName}";`);
    await replace(root, 'nix/package.nix', 'mainProgram = "tauritavern";', `mainProgram = "${BRAND.mainBinaryName}";`);
    await replace(root, 'flake.nix', '/bin/tauritavern";', `/bin/${BRAND.mainBinaryName}";`);
}
