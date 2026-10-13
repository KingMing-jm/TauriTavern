# TauriTavern Outfit bundle

This branch prepares two independent installation targets: macOS Apple Silicon DMG and Android arm64-v8a APK. It does not modify the fork's main branch or publish an upstream release.

## What is bundled

- Frontend: wenshui012/Outfit-Manager at e2a98eaf5bc860029d41e82b6a65a7c8f4f09a6d.
- Backend: wenshui012/Outfit-Manager-Server at e13afe64dba250e92b62dd71932774ebbde00ae6 (2.0.3), including its original index.js, recovery.js and storage-safety.js.
- Both original plugin sources are fetched only during the build, checked against exact commits, and included in the frontend resources. The application does not download or install them on first launch.
- The backend's original business logic is bundled as JavaScript. Its Node filesystem, hashing and Express transport dependencies are adapted to the WebView and Tauri native extension store. This is NOT a generic Node plugin host, a Rust rewrite of the backend, or a separately running Node server.

The prior macOS-only Node sidecar proposal is replaced by this shared desktop/mobile implementation. A Linux ARM64 Node executable is not placed inside the Android APK.

## Persistence and safety

The native namespace is `outfit-manager-native-v1`, under the host extension-store data directory. File bytes are immutable native Blob entries. A checksummed, atomically replaced JSON directory index gives file and whole-directory rename one publish point. Index checksums use canonical field ordering because native serde JSON may reorder properties. A referenced unreadable Blob is EIO, never ENOENT. Missing indexes with existing data and ambiguous failed commits stop writes rather than initializing an empty wardrobe.

Upstream v2 partition validation, full-data conversion, transaction journals, snapshots, recovery revisions and image GC are retained in the original server code. Native block compaction also preserves every file referenced by that server's virtual filesystem, including snapshots and fault backups.

Images keep the upstream canonical `/api/plugins/outfit-manager/images/...` identity in storage and exports. A scoped presentation adapter resolves DOM image sources to Blob URLs. The bridge handles only the exact same-origin plugin API path; it does not open a TCP listener or intercept arbitrary external API endpoints.

Only one document may own the store. Web Locks support is required; unsupported/old WebViews display a startup failure instead of silently opening an unsafe store. Original data in other installations is not automatically copied. Use the application's archive export/import and the Outfit Manager export/import UI, and keep an external backup. Do not enable a second separately installed copy of Outfit Manager in the same application.

## Build

The `Outfit Bundles - macOS and Android ARM64` workflow runs on pushes to this branch and by workflow_dispatch. Native adapter tests, the original server/frontend tests and a test of the actual browser-bundled backend must pass before either packaging job starts. Build artifacts expire after 14 days.

Local entry points, from the repository root:

```sh
node --test scripts/outfit/*.test.mjs
node scripts/outfit/prepare.mjs
node scripts/outfit/smoke.mjs
pnpm install --frozen-lockfile
node scripts/tauri-app.mjs --prepare-frontend build --target aarch64-apple-darwin --bundles dmg --config "$PWD/.outfit-build/tauri.outfit.macos.conf.json"
# With Android SDK, NDK, JDK and signing configured:
node scripts/tauri-app.mjs --prepare-frontend android build --apk --target aarch64 --config "$PWD/.outfit-build/tauri.outfit.android.conf.json"
```

`prepare.mjs` creates generated assets under `src/scripts/extensions/outfit-manager` and `.outfit-build`, registers the built-in extension and changes only Android's installed applicationId (not its Kotlin/JNI namespace). Run it in a clean build checkout; those generated patches are not a general upstream update mechanism. Dependencies are version-pinned; the build also retains its resolved tooling package-lock.json and BUILD-MANIFEST.json. Do not treat this as byte-for-byte reproducible across platforms or changing compiler versions.

## Package isolation and signing

- macOS: `TauriTavern Outfit.app`, identifier `com.kingming.tauritavern.outfit`, ad-hoc signing, no Apple notarization. Gatekeeper acceptance is not verified by CI codesign checks.
- Android: applicationId `com.kingming.tauritavern.outfit`, arm64-v8a only, minimum SDK inherited from upstream (26). Kotlin namespace remains `com.tauritavern.client` so native bindings stay consistent. CI verifies package identity, ABI and APK signature.
- For repeatable Android updates, configure repository secrets `OUTFIT_ANDROID_KEYSTORE_BASE64`, `OUTFIT_ANDROID_KEY_ALIAS`, and `OUTFIT_ANDROID_KEY_PASSWORD` (same key/store password). Preserve your signing key privately.
- With no keystore secret, CI creates a temporary per-run preview signing key. Such an APK is for testing; later builds with a different key cannot update that installation. Export data before changing preview installations. The private key is never published in artifacts or committed to this repository.

## Verification status at implementation

15 native filesystem/router tests passed locally, including JSON key reordering, restart persistence, failures before/after native commit, directory rename, snapshot block retention and transport error handling. The local environment could not resolve GitHub hostnames and had no Rust toolchain, so the original-plugin bundle smoke test, full application build, complete `pnpm run check`, physical Android device checks and macOS WebView/UI checks were not run locally. Their success must not be inferred from the existence of these source files. CI results and actual installed-device testing are separate evidence.

The in-process filesystem shim preserves the tested storage API behavior, but native atomic replacement is not a claim of an independently verified hardware power-loss/fsync guarantee. Large wardrobes and long-running image-grid memory/performance still need device testing.

Upstream authors retain their credits and notices; this branch adds an integration layer rather than claiming authorship of either plugin.
