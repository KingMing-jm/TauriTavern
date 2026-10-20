# TauriTavern Lucky — Outfit bundle

This branch packages the pinned Outfit frontend and original JavaScript backend on every application target built by upstream. The native extension-store bridge is shared across platforms; no external Node installation, Termux or remote backend is required.

## Bundled sources and storage

- Frontend: wenshui012/Outfit-Manager, e2a98eaf5bc860029d41e82b6a65a7c8f4f09a6d.
- Backend: wenshui012/Outfit-Manager-Server, e13afe64dba250e92b62dd71932774ebbde00ae6 (2.0.3).
- BaiBai frontend: baibai-git/ST-BaiBai-Tools, 2f3a221e00dd713baba45e1f857d093141593c09 (manifest version 1.0.0).
- Original sources and notices are included in application resources. Node filesystem, hashing and Express dependencies are adapted to the WebView and native extension store; original transactions, partition validation, recovery, revisions and image GC remain in the original backend.

The persistent namespace remains `outfit-manager-native-v1`. Immutable native Blob entries and a checksummed atomic directory index preserve files, directory renames, journals and snapshots. Empty files are represented by the index without Blob IO. Unreadable referenced blocks, corrupt indexes and ambiguous failed commits stop writes. Images retain their canonical plugin API paths in storage and exports; presentation resolves them to Blob URLs. Web Locks enforce a single owning document.

Export application archives and Outfit data before changing installations. Existing data in another installation is not copied automatically. Do not install a second copy of the frontend extension in this application.

柏宝箱随 Lucky 安装包内置，在扩展管理中显示为“柏宝箱 · Tauri 内置版”，沿用现有扩展启用/停用和设置保存机制。不要另外安装同一插件的第三方副本。构建使用固定提交中的原始 `dist/index.js`、音频和说明，构建清单记录来源与脚本 SHA-256；不会在应用启动时下载安装插件代码。

此次只内置柏宝箱前端，不包含柏宝库后端；柏宝库相关面板会显示未安装，对应服务端功能不可用。插件默认把首次显示的聊天限制为最多 10 层，可在插件设置中关闭“减少加载楼层数”后调整酒馆原生设置。已有的柏宝箱用户配置仍沿用 `extension_settings.baiBaiToolkit`。

该接入不承诺性能提升。2026-10-15 的 Chromium 隔离实验中，相同 100 层、10 层和 TT 内置虚拟化条件下均未测出额外渲染收益。插件保留原始滚动、界面和请求处理行为；原生 WebView、移动设备与复杂角色卡的完整交互仍需安装后验收。

## Complete build coverage

`.github/workflows/outfit-macos.yml` keeps its historical filename but now runs **TauriTavern-Lucky - All Upstream Targets**, on every push to this feature branch or manual dispatch. Build jobs are derived from upstream stable/canary/OpenHarmony workflows, including their matrices, toolchains, dependencies and build commands:

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

## Automatic upstream synchronization

The default branch owns `.github/workflows/outfit-sync-upstream.yml`. GitHub checks `Darkatse/TauriTavern:dev` every 30 minutes, at minutes 17 and 47 UTC, and supports manual **Run workflow**. Scheduled execution may be delayed by GitHub.

On a new upstream commit, the workflow prepares merges into both `main` and `feat/outfit-manager-bundled`, retaining fork commits. It regenerates the full packaging workflow, updates the recorded upstream revision, runs `pnpm run check` on the source checkout, then prepares and smoke-tests the bundled Outfit and BaiBai integrations before pushing both candidates atomically. The Web Host fixture loads discovered extensions, so native-only bundles are generated after its tests. The existing Outfit push workflow builds all platforms. Unchanged upstream commits cause no push or build.

Conflicts, failed generation/checks or concurrent user pushes stop the operation. No force push or automatic conflict resolution is used, and neither remote branch is updated by a rejected atomic push. The Actions log and job summary report failures; GitHub notifications follow your account's Actions notification settings.

One-time setup: create a fine-grained personal access token restricted to `KingMing-jm/TauriTavern`, with repository **Contents: Read and write** and **Workflows: Read and write**. Store it as the repository Actions secret **`UPSTREAM_SYNC_TOKEN`**. Keep the value out of code, chat and artifacts. The token is supplied only to the final publication step; dependency installation and validation use no publisher credential.

This permission is needed because upstream updates and packaging regeneration can modify workflow files. A PAT push also triggers the existing build workflow; an ordinary `GITHUB_TOKEN` push does not. If the secret is absent or expires, updates stop with an explicit error. No-change runs remain read-only. Default-branch workflow placement is required by GitHub schedules; keep that controller on `main` when changing repository branches.

For a manual local merge, refresh packaging with:

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
pnpm run web:build --config-name vendor-libs
node --experimental-vm-modules scripts/outfit/baibai-smoke.mjs
node scripts/tauri-app.mjs --prepare-frontend build --target aarch64-apple-darwin --bundles app,dmg --config "$PWD/.outfit-build/tauri.outfit.desktop.conf.json"
# With Android SDK, NDK, JDK and signing configured:
node scripts/tauri-app.mjs --prepare-frontend android build --apk --split-per-abi --target aarch64 armv7 --config "$PWD/.outfit-build/tauri.outfit.android.conf.json"
```

Run preparation in a disposable build checkout. It generates `.outfit-build`, `src/scripts/extensions/outfit-manager` and `src/scripts/extensions/baibai-tools`, registers the bundled extensions, and isolates Android/iOS installed identifiers without changing Android's Kotlin/JNI namespace. Pinned plugin commits, tooling versions, resolved tooling lockfile and script hashes are retained in build manifests.

## Identity and signing

The personal edition mark is **Lucky**. `integrations/outfit-manager/targets.json` owns the product name `TauriTavern-Lucky`, launcher label `TauriTavern Lucky`, and executable name `tauritavern-lucky` (`.exe` on Windows). Preparation applies these names to desktop bundles, Android resources, the existing Xcode project, OpenHarmony labels, Linux desktop metadata and Flatpak/Nix packaging. Kotlin/JNI namespaces, Xcode target/scheme and native library names stay unchanged.

Download artifact names and contained packages carry `TauriTavern-Lucky`. APK names include version, ABI and build variant; IPA names distinguish the two policy variants; HAP names include the target architecture. Mobile package staging copies signed bytes without rewriting them. Installed identifiers and the Outfit storage namespace stay unchanged from earlier fork builds; the visible rename is not a data migration. Windows installation paths and MSI upgrade detection follow the new product name, so export a backup before replacing an older Outfit installer.

Windows/macOS use the Lucky product name and identifier `com.kingming.tauritavern.outfit`; Android/iOS use that installed identifier. Flatpak and OpenHarmony retain upstream's package identity to use their existing packaging contracts; they replace the corresponding original package. Nix retains the `tauritavern` flake output but installs `tauritavern-lucky`.

macOS uses ad-hoc signing without notarization. Android uses repository secrets `OUTFIT_ANDROID_KEYSTORE_BASE64`, `OUTFIT_ANDROID_KEY_ALIAS`, `OUTFIT_ANDROID_KEY_PASSWORD` when configured. Otherwise CI uses a temporary preview signing key: later builds cannot update that installation with a different key. Preserve your own signing key privately; private keys are never artifacts.

iOS archives use `--no-sign --archive-only`, then package the app in an IPA. Both standard and external-beta policy variants are built, but neither is an App Store/TestFlight signed distribution. Sign using your own Apple identity before installation. OpenHarmony HAPs are also unsigned and require device-specific signing.

## Verification limits

The smoke test uses the production TT extension-store frontend API, including streamed reads, chunked commits and Android base64 IPC. Only native command IO is replaced; it checks initial partition upload, restart persistence, images, invalid batches, snapshot restore, stale revisions, GC and corrupt-data write locks. Native tests cover storage failures, empty files, rename and snapshot block retention.

CI packaging success and installed-device behavior are separate evidence. No filesystem shim test certifies hardware power-loss durability. Physical-device startup, large wardrobes, image-grid performance and operating-system installation/signing acceptance still require device testing.
