# TauriTavern Outfit bundle

This branch packages the pinned Outfit frontend and original JavaScript backend on every application target built by upstream. The native extension-store bridge is shared across platforms; no external Node installation, Termux or remote backend is required.

## Bundled sources and storage

- Frontend: wenshui012/Outfit-Manager, e2a98eaf5bc860029d41e82b6a65a7c8f4f09a6d.
- Backend: wenshui012/Outfit-Manager-Server, e13afe64dba250e92b62dd71932774ebbde00ae6 (2.0.3).
- Original sources and notices are included in application resources. Node filesystem, hashing and Express dependencies are adapted to the WebView and native extension store; original transactions, partition validation, recovery, revisions and image GC remain in the original backend.

The persistent namespace remains `outfit-manager-native-v1`. Immutable native Blob entries and a checksummed atomic directory index preserve files, directory renames, journals and snapshots. Empty files are represented by the index without Blob IO. Unreadable referenced blocks, corrupt indexes and ambiguous failed commits stop writes. Images retain their canonical plugin API paths in storage and exports; presentation resolves them to Blob URLs. Web Locks enforce a single owning document.

Export application archives and Outfit data before changing installations. Existing data in another installation is not copied automatically. Do not install a second copy of the frontend extension in this application.

## Complete build coverage

`.github/workflows/outfit-macos.yml` keeps its historical filename but now runs **Outfit Bundles - All Upstream Targets**, on every push to this feature branch or manual dispatch. Build jobs are derived from upstream stable/canary/OpenHarmony workflows, including their matrices, toolchains, dependencies and build commands:

| Target | Packages |
| --- | --- |
| Windows x64 | NSIS, MSI, debug NSIS with devtools, portable executable |
| macOS Intel and Apple Silicon | DMG and app, release and debug with devtools |
| Linux x64 | AppImage, DEB, RPM, portable binary |
| Linux ARM64 | DEB, RPM, portable binary |
| Android | APKs split for arm64-v8a and armeabi-v7a |
| iOS ARM64 | Unsigned IPA, standard and external-beta policy variants |
| Flatpak x64 | Installable `.flatpak` bundle |
| Nix x64 and ARM64 | Exported runtime closures (`.nar.zst`) |
| Experimental OpenHarmony ARM64 | Unsigned HAP |

After merging upstream, regenerate and verify the jobs:

```sh
pnpm install --frozen-lockfile
node scripts/outfit/release-workflow.mjs
node scripts/outfit/release-workflow.mjs --check
```

Commit the resulting workflow alongside the merge. CI rejects stale generation rather than silently dropping upstream targets. `BUILD-MANIFEST.json` derives its target inventory from those same upstream workflows. Platform jobs start only after native filesystem/router tests, original plugin tests and the real bundled backend smoke test pass.

Artifacts are downloadable under the run's **Artifacts** section. Desktop/mobile artifacts are uploaded by upstream's Tauri action; other jobs upload named package artifacts. GitHub wraps artifacts in ZIP; extract once, then install the contained package. A raw APK can be installed directly. These builds do not publish to upstream's package repositories or TestFlight groups.

## Local build

```sh
node --test scripts/outfit/*.test.mjs
node scripts/outfit/prepare.mjs
node scripts/outfit/smoke.mjs
node scripts/tauri-app.mjs --prepare-frontend build --target aarch64-apple-darwin --bundles app,dmg --config "$PWD/.outfit-build/tauri.outfit.desktop.conf.json"
# With Android SDK, NDK, JDK and signing configured:
node scripts/tauri-app.mjs --prepare-frontend android build --apk --split-per-abi --target aarch64 armv7 --config "$PWD/.outfit-build/tauri.outfit.android.conf.json"
```

Run preparation in a disposable build checkout. It generates `.outfit-build` and `src/scripts/extensions/outfit-manager`, registers the first-party extension, and isolates Android/iOS installed identifiers without changing Android's Kotlin/JNI namespace. Pinned plugin commits, tooling versions, resolved tooling lockfile and backend hashes are retained in build manifests.

## Identity and signing

Windows/macOS use the Outfit product name and identifier `com.kingming.tauritavern.outfit`; Android/iOS use that installed identifier. Flatpak, Nix and OpenHarmony retain upstream's package identity to use their existing packaging contracts; they replace the corresponding original package.

macOS uses ad-hoc signing without notarization. Android uses repository secrets `OUTFIT_ANDROID_KEYSTORE_BASE64`, `OUTFIT_ANDROID_KEY_ALIAS`, `OUTFIT_ANDROID_KEY_PASSWORD` when configured. Otherwise CI uses a temporary preview signing key: later builds cannot update that installation with a different key. Preserve your own signing key privately; private keys are never artifacts.

iOS archives use `--no-sign --archive-only`, then package the app in an IPA. Both standard and external-beta policy variants are built, but neither is an App Store/TestFlight signed distribution. Sign using your own Apple identity before installation. OpenHarmony HAPs are also unsigned and require device-specific signing.

## Verification limits

The smoke test uses the production TT extension-store frontend API, including streamed reads, chunked commits and Android base64 IPC. Only native command IO is replaced; it checks initial partition upload, restart persistence, images, invalid batches, snapshot restore, stale revisions, GC and corrupt-data write locks. Native tests cover storage failures, empty files, rename and snapshot block retention.

CI packaging success and installed-device behavior are separate evidence. No filesystem shim test certifies hardware power-loss durability. Physical-device startup, large wardrobes, image-grid performance and operating-system installation/signing acceptance still require device testing.
