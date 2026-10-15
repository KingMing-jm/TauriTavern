import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { createBrowserRuntime } from '../../tests/browser/runtime.mjs';

const frontend = fileURLToPath(new URL('../../src/', import.meta.url));
const runtime = createBrowserRuntime();
const { window, load, getModule, startHost } = runtime;
try {
    // The real host/router/modules run; native IO uses the existing browser fixture.
    window.fetch = async input => {
        const url = new URL(String(input), 'http://localhost');
        assert.equal(url.hostname, 'raw.githubusercontent.com', `Unexpected network request: ${url}`);
        return new window.Response(JSON.stringify({ version: '1.0.0' }), { headers: { 'Content-Type': 'application/json' } });
    };
    await startHost();
    const script = (await load('script.js')).namespace;
    script.reloadMarkdownProcessor();
    getModule('scripts/chats.js').namespace.addDOMPurifyHooks();
    getModule('tauri/main/services/chat-surface/chat-virtualization-state.js').namespace
        .initializeChatVirtualization({ chat_virtualization_enabled: false });
    const { power_user } = getModule('scripts/power-user.js').namespace;
    power_user.chat_truncation = 100;

    const manifest = JSON.parse(await readFile(path.join(frontend, 'scripts/extensions/baibai-tools/manifest.json'), 'utf8'));
    const { getExtensionResourceUrl } = getModule('scripts/extensions/runtime/resource-paths.js').namespace;
    const entryUrl = new URL(getExtensionResourceUrl('baibai-tools', manifest.js), 'http://localhost');
    const entry = new vm.SourceTextModule(await readFile(path.join(frontend, entryUrl.pathname), 'utf8'), {
        context: window,
        identifier: entryUrl.href,
        initializeImportMeta(meta) { meta.url = entryUrl.href; },
    });
    await entry.link(specifier => {
        const url = new URL(specifier, entryUrl);
        assert.equal(url.origin, entryUrl.origin);
        return getModule(path.join(frontend, url.pathname));
    });
    // Hold normal app startup, but execute the original extension's ready callbacks.
    const jquery = window.jQuery;
    const callbacks = [];
    window.jQuery = new Proxy(jquery, {
        apply(target, receiver, args) {
            if (typeof args[0] === 'function') { callbacks.push(args[0]); return; }
            return Reflect.apply(target, receiver, args);
        },
    });
    try { await entry.evaluate(); } finally { window.jQuery = jquery; }
    for (const callback of callbacks) await callback();
    assert.ok(window.document.querySelector('#bai_bai_toolkit_container input'), 'Bundled settings panel did not load');
    for (let i = 0; i < 100; i++) {
        script.chat.push({ name: 'Synthetic', is_user: false, is_system: false, mes: `Synthetic message ${i}`, send_date: '2026-10-15T00:00:00Z', extra: {} });
    }
    await script.printMessages();
    assert.equal(script.chat.length, 100, 'Floor limiting must preserve canonical history');
    assert.equal(window.document.querySelectorAll('#chat > .mes').length, 10);
    const toggle = window.document.querySelector('#bai_bai_toolkit_reduce_loaded_floors_enabled');
    assert.ok(toggle, 'Floor setting is unavailable');
    toggle.checked = false;
    jquery(toggle).trigger('input');
    power_user.chat_truncation = 100;
    script.resetChatSurfaceView();
    await script.printMessages();
    assert.equal(window.document.querySelectorAll('#chat > .mes').length, 100);
    console.log('BaiBai bundled frontend: host imports, settings, history preservation and native floor-setting control passed. Native-device acceptance remains separate.');
} finally {
    await window.happyDOM.abort();
}
