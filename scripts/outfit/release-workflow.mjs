import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { parse, stringify } from 'yaml';

const root = fileURLToPath(new URL('../..', import.meta.url));
const destination = path.join(root, '.github/workflows/outfit-macos.yml');
async function workflow(name) {
    return parse(await readFile(path.join(root, `.github/workflows/${name}.yml`), 'utf8'));
}
async function sources() {
    const [stable, canary, ohos] = await Promise.all(['stable-release', 'canary-release', 'ohos'].map(workflow));
    return { stable, canary, ohos };
}
function unionTargets(stable, canary, fields) {
    const targets = new Map();
    for (const item of [...stable, ...canary]) targets.set(JSON.stringify(fields.map(field => item[field])), item);
    return [...targets.values()];
}
export async function releaseTargets() {
    const { stable, canary } = await sources();
    return {
        desktop: unionTargets(stable.jobs.desktop.strategy.matrix.include, canary.jobs.desktop.strategy.matrix.include, ['platform', 'target_args', 'artifact_prefix']),
        portable: unionTargets(stable.jobs.portable.strategy.matrix.include, canary.jobs.portable.strategy.matrix.include, ['platform', 'name']),
        mobile: unionTargets(stable.jobs.mobile.strategy.matrix.include, canary.jobs.mobile.strategy.matrix.include, ['platform', 'mobile', 'args']),
        flatpak: stable.jobs.flatpak['runs-on'],
        nix: stable.jobs['publish-nix-cache'].strategy.matrix.include,
        ohos: JSON.parse(canary.jobs.ohos.with.architectures),
    };
}
const prep = { name: 'Bundle pinned Outfit frontend and backend', run: 'node scripts/outfit/prepare.mjs' };
function step(job, name) {
    const matches = job.steps.filter(item => item.name === name);
    if (matches.length !== 1) throw new Error(`Upstream build step changed: ${name}; update the Outfit workflow generator`);
    return matches[0];
}
function prepareAfterInstall(job) {
    const index = job.steps.findIndex(item => item.run === 'pnpm install --frozen-lockfile');
    if (index < 0) throw new Error('Upstream pnpm install step changed');
    job.steps.splice(index + 1, 0, structuredClone(prep));
}
function common(job) {
    job.needs = 'contracts';
    delete job.env;
    delete job.concurrency;
    delete job['continue-on-error'];
    job['timeout-minutes'] ??= 120;
    for (const item of job.steps) {
        if (item.uses?.startsWith('actions/checkout@')) item.with = { 'persist-credentials': false };
    }
    return job;
}
async function generate() {
    const { stable, canary, ohos } = await sources();
    const current = await workflow('outfit-macos');
    const targets = await releaseTargets();
    const contracts = current.jobs.contracts;
    const androidSigning = structuredClone(step(current.jobs.android ?? current.jobs.mobile, 'Configure APK signing'));
    androidSigning.if = "matrix.mobile == 'android'";
    if (!contracts.steps.some(item => item.name === 'Check complete upstream packaging coverage')) {
        contracts.steps.splice(2, 0,
            { uses: 'pnpm/setup@v2', with: { runtime: 'node@22', cache: true, install: false } },
            { run: 'pnpm install --frozen-lockfile' },
            { name: 'Check complete upstream packaging coverage', run: 'node scripts/outfit/release-workflow.mjs --check' });
    }
    const desktop = common(structuredClone(canary.jobs.desktop));
    desktop.strategy.matrix.include = targets.desktop;
    for (const target of desktop.strategy.matrix.include) {
        // Retain the app bundle for architecture/signature verification after DMG creation.
        if (target.platform.startsWith('macos')) target.target_args = target.target_args.replace('--bundles dmg', '--bundles app,dmg');
    }
    desktop.steps = desktop.steps.filter(item => !['Prepare Linux Canary package version', 'Setup macOS signing and notarization'].includes(item.name));
    prepareAfterInstall(desktop);
    const buildDesktop = step(desktop, 'Build desktop bundles');
    buildDesktop.env = { GITHUB_TOKEN: '${{ secrets.GITHUB_TOKEN }}', APPLE_SIGNING_IDENTITY: '-' };
    buildDesktop.with.args = '${{ matrix.target_args }} --config ${{ github.workspace }}/.outfit-build/tauri.outfit.desktop.conf.json';
    buildDesktop.with.workflowArtifactNamePattern = 'TauriTavern-Outfit-${{ matrix.artifact_prefix }}[platform]-[arch]-[bundle]';
    desktop.steps.push({ name: 'Verify macOS application architecture and signature', if: "startsWith(matrix.platform, 'macos')", shell: 'bash', run: `set -euo pipefail
case "\${{ matrix.target_args }}" in *x86_64*) target=x86_64-apple-darwin; arch=x86_64;; *) target=aarch64-apple-darwin; arch=arm64;; esac
case "\${{ matrix.target_args }}" in *--debug*) profile=debug;; *) profile=release;; esac
app="src-tauri/target/$target/$profile/bundle/macos/TauriTavern Outfit.app"
codesign --verify --deep --strict "$app"
executable=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$app/Contents/Info.plist")
file "$app/Contents/MacOS/$executable" | grep "$arch"` });

    const portable = common(structuredClone(canary.jobs.portable));
    portable.strategy.matrix.include = targets.portable;
    prepareAfterInstall(portable);
    step(portable, 'Build portable binary').run += ' -- --config .outfit-build/tauri.outfit.desktop.conf.json';
    step(portable, 'Upload portable binary').with.name = 'TauriTavern-Outfit-${{ matrix.name }}-portable';

    const mobile = common(structuredClone(canary.jobs.mobile));
    mobile.strategy.matrix.include = targets.mobile;
    const ios = mobile.strategy.matrix.include.find(item => item.mobile === 'ios');
    if (!ios || mobile.strategy.matrix.include.some(item => !['android', 'ios'].includes(item.mobile))) throw new Error('Unsupported upstream mobile target');
    ios.policy = 'standard';
    mobile.strategy.matrix.include.push({ ...ios, policy: 'ios_external_beta' });
    const omitted = ['Prepare public TestFlight build identity', 'Setup Android signing', 'Setup App Store Connect API key', 'Restore iOS transport security for TestFlight', 'Build public TestFlight IPA'];
    mobile.steps = mobile.steps.filter(item => !omitted.includes(item.name));
    prepareAfterInstall(mobile);
    const buildMobile = step(mobile, 'Build mobile bundle');
    buildMobile.if = "matrix.mobile == 'android'";
    buildMobile.env = { GITHUB_TOKEN: '${{ secrets.GITHUB_TOKEN }}', NDK_HOME: '${{ steps.setup-ndk.outputs.ndk-path }}' };
    buildMobile.with.args = '${{ matrix.args }} --config ${{ github.workspace }}/.outfit-build/tauri.outfit.android.conf.json';
    buildMobile.with.workflowArtifactNamePattern = 'TauriTavern-Outfit-[platform]-[arch]-[bundle]';
    mobile.steps.splice(mobile.steps.indexOf(buildMobile), 0, androidSigning);
    mobile.steps.push(
        { name: 'Verify Android signatures and package identity', if: "matrix.mobile == 'android'", shell: 'bash', run: `set -euo pipefail
sdkmanager 'build-tools;36.0.0'
mapfile -t apks < <(find src-tauri/crates/tauritavern/gen/android/app/build/outputs/apk -name '*.apk' ! -name '*unsigned*')
test "\${#apks[@]}" -gt 0
for apk in "\${apks[@]}"; do
  "$ANDROID_HOME/build-tools/36.0.0/apksigner" verify "$apk"
  "$ANDROID_HOME/build-tools/36.0.0/aapt" dump badging "$apk" | grep "package: name='com.kingming.tauritavern.outfit'"
done` },
        { name: 'Build unsigned iOS archive', if: "matrix.mobile == 'ios'", env: { TAURITAVERN_IOS_POLICY_PROFILE: "${{ matrix.policy == 'standard' && 'full' || matrix.policy }}" }, run: 'node scripts/tauri-app.mjs --prepare-frontend ios build ${{ matrix.args }} --target aarch64 --no-sign --archive-only --config "$PWD/.outfit-build/tauri.outfit.ios.conf.json"' },
        { name: 'Package unsigned IPA', if: "matrix.mobile == 'ios'", shell: 'bash', run: `set -euo pipefail
app=$(find src-tauri/crates/tauritavern/gen/apple -path '*.xcarchive/Products/Applications/*.app' -type d)
test -n "$app"
test "$(printf '%s\\n' "$app" | wc -l | tr -d ' ')" = 1
mkdir -p .outfit-build/ipa/Payload
cp -R "$app" .outfit-build/ipa/Payload/
(cd .outfit-build/ipa && ditto -c -k --keepParent Payload ../TauriTavern-Outfit-unsigned.ipa)
printf '%s\\n' 'Unsigned IPA: sign with your own Apple identity before installing. No TestFlight upload performed.' > .outfit-build/IOS-SIGNING.txt` },
        { uses: 'actions/upload-artifact@v7', if: "matrix.mobile == 'ios'", with: { name: 'TauriTavern-Outfit-ios-arm64-${{ matrix.policy }}-unsigned-ipa', 'include-hidden-files': true, path: '.outfit-build/*.ipa\n.outfit-build/IOS-SIGNING.txt', 'if-no-files-found': 'error' } },
        { uses: 'actions/upload-artifact@v7', if: "matrix.mobile == 'android'", with: { name: 'TauriTavern-Outfit-Android-Signing', 'include-hidden-files': true, path: '.outfit-build/ANDROID-SIGNING.txt', 'if-no-files-found': 'error' } },
    );

    const flatpak = common(structuredClone(stable.jobs.flatpak));
    flatpak.env = { TAURITAVERN_FLATPAK_USER: '1' };
    flatpak.steps.splice(1, 0, { uses: 'pnpm/setup@v2', with: { runtime: 'node@22', cache: true, install: false } }, { run: 'pnpm install --frozen-lockfile' }, structuredClone(prep), { name: 'Remove build-time plugin checkouts before offline packaging', run: 'rm -rf .outfit-build' });
    step(flatpak, 'Archive Flatpak application tree').run = `flatpak build-export .outfit-flatpak-repo .flatpak-build
flatpak build-bundle .outfit-flatpak-repo TauriTavern-Outfit-x86_64.flatpak com.tauritavern.client`;
    step(flatpak, 'Upload Flatpak build tree').with = { name: 'TauriTavern-Outfit-linux-x64-flatpak', path: '*.flatpak', 'if-no-files-found': 'error' };

    const nix = common(structuredClone(stable.jobs['publish-nix-cache']));
    nix.steps = nix.steps.filter(item => !['Sign and publish runtime and dependency paths', 'Verify public Nix cache'].includes(item.name));
    nix.steps.splice(1, 0, { uses: 'pnpm/setup@v2', with: { runtime: 'node@22', cache: true, install: false } }, { run: 'pnpm install --frozen-lockfile' }, structuredClone(prep), { name: 'Include generated extension in Nix source snapshot', run: 'git add src/scripts/extensions/outfit-manager src-tauri/crates/tt-adapter-extension/src/repositories/file_extension_repository.rs' });
    nix.steps.push({ name: 'Export Nix closure', run: 'sudo apt-get update && sudo apt-get install -y zstd\nnix-store --export $(nix-store --query --requisites ./result) | zstd -T0 > TauriTavern-Outfit-${{ matrix.system }}.nar.zst' }, { uses: 'actions/upload-artifact@v7', with: { name: 'TauriTavern-Outfit-${{ matrix.system }}-nix', path: '*.nar.zst', 'if-no-files-found': 'error' } });

    const hap = common(structuredClone(ohos.jobs.hap));
    hap.strategy.matrix.arch = JSON.parse(canary.jobs.ohos.with.architectures);
    hap.env = { TARGET_TRIPLE: '${{ matrix.arch }}-unknown-linux-ohos' };
    prepareAfterInstall(hap);
    step(hap, 'Build unsigned HAP').run = step(hap, 'Build unsigned HAP').run.replace(/          /g, '').replace(/if \[ -n "\$PACKAGE_VERSION" \]; then[\s\S]*?fi\n/, '');
    hap.steps.find(item => item.uses?.startsWith('actions/upload-artifact@')).with.name = 'TauriTavern-Outfit-ohos-${{ matrix.arch }}-unsigned-hap';

    return stringify({ name: 'Outfit Bundles - All Upstream Targets', on: { workflow_dispatch: null, push: { branches: ['feat/outfit-manager-bundled'] } }, permissions: { contents: 'read' }, concurrency: { group: 'outfit-bundles-${{ github.ref }}', 'cancel-in-progress': true }, env: current.env, jobs: { contracts, desktop, portable, mobile, flatpak, nix, ohos: hap } }, { lineWidth: 0 });
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const content = '# Build jobs derived by scripts/outfit/release-workflow.mjs from upstream release workflows.\n' + await generate();
    if (process.argv.includes('--check')) {
        if (await readFile(destination, 'utf8') !== content) throw new Error('Outfit packaging is out of sync with upstream. Run node scripts/outfit/release-workflow.mjs and commit the workflow.');
        console.log('Outfit packaging covers all current upstream build jobs.');
    } else {
        await writeFile(destination, content);
        console.log('Updated Outfit packaging from upstream release workflows.');
    }
}
