import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { parse, stringify } from 'yaml';
import { BRAND } from './branding.mjs';

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
const prep = { name: 'Bundle pinned Outfit and BaiBai extensions', run: 'node scripts/outfit/prepare.mjs' };
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
    // Fork artifacts depend on validation, independently of upstream release publication.
    job.needs = 'contracts';
    delete job.if;
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
    buildDesktop.with.workflowArtifactNamePattern = `${BRAND.productName}-\${{ matrix.artifact_prefix }}[platform]-[arch]-[bundle]`;
    desktop.steps.push({ name: 'Verify macOS application architecture and signature', if: "startsWith(matrix.platform, 'macos')", shell: 'bash', run: `set -euo pipefail
case "\${{ matrix.target_args }}" in *x86_64*) target=x86_64-apple-darwin; arch=x86_64;; *) target=aarch64-apple-darwin; arch=arm64;; esac
case "\${{ matrix.target_args }}" in *--debug*) profile=debug;; *) profile=release;; esac
app="src-tauri/target/$target/$profile/bundle/macos/${BRAND.productName}.app"
codesign --verify --deep --strict "$app"
executable=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$app/Contents/Info.plist")
test "$executable" = '${BRAND.mainBinaryName}'
file "$app/Contents/MacOS/$executable" | grep "$arch"` });

    const portable = common(structuredClone(canary.jobs.portable));
    portable.strategy.matrix.include = targets.portable;
    prepareAfterInstall(portable);
    step(portable, 'Build portable binary').run += ' -- --config .outfit-build/tauri.outfit.desktop.conf.json';
    step(portable, 'Upload portable binary').with.name = `${BRAND.productName}-\${{ matrix.name }}-portable`;

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
    buildMobile.with.uploadWorkflowArtifacts = false;
    delete buildMobile.with.workflowArtifactNamePattern;
    mobile.steps.splice(mobile.steps.indexOf(buildMobile), 0, androidSigning);
    mobile.steps.push(
        { name: 'Verify Android signatures and package identity', if: "matrix.mobile == 'android'", shell: 'bash', run: `set -euo pipefail
sdkmanager 'build-tools;36.0.0'
mapfile -t apks < <(find src-tauri/crates/tauritavern/gen/android/app/build/outputs/apk -name '*.apk' ! -name '*unsigned*')
test "\${#apks[@]}" -gt 0
for apk in "\${apks[@]}"; do
  "$ANDROID_HOME/build-tools/36.0.0/apksigner" verify "$apk"
  badging=$("$ANDROID_HOME/build-tools/36.0.0/aapt" dump badging "$apk")
  grep -F "package: name='${BRAND.identifier}'" <<< "$badging"
  grep -F "application-label:'${BRAND.displayName}'" <<< "$badging"
done` },
        { name: 'Name signed APK downloads', if: "matrix.mobile == 'android'", run: 'node scripts/outfit/package-artifacts.mjs android' },
        { uses: 'actions/upload-artifact@v7', if: "matrix.mobile == 'android'", with: { name: `${BRAND.productName}-android-apk`, 'include-hidden-files': true, path: '.outfit-build/packages/*.apk', 'if-no-files-found': 'error' } },
        { name: 'Build unsigned iOS archive', if: "matrix.mobile == 'ios'", env: { TAURITAVERN_IOS_POLICY_PROFILE: "${{ matrix.policy == 'standard' && 'full' || matrix.policy }}" }, run: 'node scripts/tauri-app.mjs --prepare-frontend ios build ${{ matrix.args }} --target aarch64 --no-sign --archive-only --config "$PWD/.outfit-build/tauri.outfit.ios.conf.json"' },
        { name: 'Package unsigned IPA', if: "matrix.mobile == 'ios'", shell: 'bash', run: `set -euo pipefail
app=$(find src-tauri/crates/tauritavern/gen/apple -path '*.xcarchive/Products/Applications/*.app' -type d)
test -n "$app"
test "$(printf '%s\\n' "$app" | wc -l | tr -d ' ')" = 1
test "$(basename "$app")" = '${BRAND.productName}.app'
test "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleDisplayName' "$app/Info.plist")" = '${BRAND.displayName}'
mkdir -p .outfit-build/ipa/Payload
cp -R "$app" .outfit-build/ipa/Payload/
(cd .outfit-build/ipa && ditto -c -k --keepParent Payload ../${BRAND.productName}-\${{ matrix.policy }}-unsigned.ipa)
printf '%s\\n' 'Unsigned IPA: sign with your own Apple identity before installing. No TestFlight upload performed.' > .outfit-build/IOS-SIGNING.txt` },
        { uses: 'actions/upload-artifact@v7', if: "matrix.mobile == 'ios'", with: { name: `${BRAND.productName}-ios-arm64-\${{ matrix.policy }}-unsigned-ipa`, 'include-hidden-files': true, path: '.outfit-build/*.ipa\n.outfit-build/IOS-SIGNING.txt', 'if-no-files-found': 'error' } },
        { uses: 'actions/upload-artifact@v7', if: "matrix.mobile == 'android'", with: { name: `${BRAND.productName}-Android-Signing`, 'include-hidden-files': true, path: '.outfit-build/ANDROID-SIGNING.txt', 'if-no-files-found': 'error' } },
    );

    const flatpak = common(structuredClone(stable.jobs.flatpak));
    flatpak.env = { TAURITAVERN_FLATPAK_USER: '1' };
    flatpak.steps.splice(1, 0, { uses: 'pnpm/setup@v2', with: { runtime: 'node@22', cache: true, install: false } }, { run: 'pnpm install --frozen-lockfile' }, structuredClone(prep), { name: 'Remove build-time plugin checkouts before offline packaging', run: 'rm -rf .outfit-build' });
    step(flatpak, 'Archive Flatpak application tree').run = `flatpak build-export .outfit-flatpak-repo .flatpak-build
flatpak build-bundle .outfit-flatpak-repo ${BRAND.productName}-x86_64.flatpak com.tauritavern.client`;
    step(flatpak, 'Upload Flatpak build tree').with = { name: `${BRAND.productName}-linux-x64-flatpak`, path: '*.flatpak', 'if-no-files-found': 'error' };

    const nix = common(structuredClone(stable.jobs['publish-nix-cache']));
    nix.steps = nix.steps.filter(item => !['Sign and publish runtime and dependency paths', 'Verify public Nix cache'].includes(item.name));
    nix.steps.splice(1, 0, { uses: 'pnpm/setup@v2', with: { runtime: 'node@22', cache: true, install: false } }, { run: 'pnpm install --frozen-lockfile' }, structuredClone(prep), { name: 'Include generated extensions in Nix source snapshot', run: 'git add -u && git add src/scripts/extensions/outfit-manager && git add -f src/scripts/extensions/baibai-tools' });
    nix.steps.push({ name: 'Export Nix closure', run: `sudo apt-get update && sudo apt-get install -y zstd\nnix-store --export $(nix-store --query --requisites ./result) | zstd -T0 > ${BRAND.productName}-\${{ matrix.system }}.nar.zst` }, { uses: 'actions/upload-artifact@v7', with: { name: `${BRAND.productName}-\${{ matrix.system }}-nix`, path: '*.nar.zst', 'if-no-files-found': 'error' } });

    const hap = common(structuredClone(ohos.jobs.hap));
    hap.strategy.matrix.arch = JSON.parse(canary.jobs.ohos.with.architectures);
    hap.env = { TARGET_TRIPLE: '${{ matrix.arch }}-unknown-linux-ohos' };
    prepareAfterInstall(hap);
    hap.steps.splice(hap.steps.findIndex(item => item.name === prep.name) + 1, 0, { name: 'Snapshot prepared OpenHarmony project', run: 'git add src-tauri/crates/tauritavern/gen/ohos' });
    step(hap, 'Build unsigned HAP').run = step(hap, 'Build unsigned HAP').run.replace(/          /g, '').replace(/if \[ -n "\$PACKAGE_VERSION" \]; then[\s\S]*?fi\n/, '');
    const validation = step(hap, 'Validate HAP and application project');
    validation.run = validation.run.replace('changes=$(git status --porcelain -- "$project")', 'git diff --exit-code -- "$project"\nchanges=$(git ls-files --others --exclude-standard -- "$project")');
    hap.steps.splice(hap.steps.indexOf(validation) + 1, 0, { name: 'Name HAP download', run: 'node scripts/outfit/package-artifacts.mjs ohos' });
    hap.steps.find(item => item.uses?.startsWith('actions/upload-artifact@')).with.path = '.outfit-build/packages/*.hap';
    hap.steps.find(item => item.uses?.startsWith('actions/upload-artifact@')).with['include-hidden-files'] = true;
    hap.steps.find(item => item.uses?.startsWith('actions/upload-artifact@')).with.name = `${BRAND.productName}-ohos-\${{ matrix.arch }}-unsigned-hap`;

    return stringify({ name: `${BRAND.productName} - All Upstream Targets`, on: { workflow_dispatch: null, push: { branches: ['feat/outfit-manager-bundled'] } }, permissions: { contents: 'read' }, concurrency: { group: 'outfit-bundles-${{ github.ref }}', 'cancel-in-progress': true }, env: { ...current.env, TAURITAVERN_BUILD_BRANCH: BRAND.mainBinaryName }, jobs: { contracts, desktop, portable, mobile, flatpak, nix, ohos: hap } }, { lineWidth: 0 });
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
