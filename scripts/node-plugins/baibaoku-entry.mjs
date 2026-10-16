import { registerApi } from './src/api.js';
import { DatabaseManager } from './src/database.js';
import { VectorStore } from './src/vector-store.js';
import { PLUGIN_ID, PLUGIN_NAME } from './src/constants.js';

export const info = { id: PLUGIN_ID, name: PLUGIN_NAME, description: 'BaiBaoKu storage and vector APIs for the TT validation host' };
const manager = new DatabaseManager();
export async function init(router) {
    const driver = await manager.getDriverStatus();
    if (!driver.available) throw new Error(`BaiBaoKu SQLite unavailable: ${driver.message}`);
    registerApi(router, manager, new VectorStore(manager));
    router.use((req, res, next) => {
        if (/^\/v1\/(?:early|chats|chat-backups|characters|settings|themes|tokenizers|extensions|preset-backups|fast-version|fast-config)(?:\/|$)/.test(req.path)) {
            return res.status(501).json({ ok: false, error: {
                code: 'TT_CAPABILITY_UNAVAILABLE',
                message: 'This BaiBaoKu endpoint requires SillyTavern server services; the TT validation host provides storage and vectors.',
            } });
        }
        next();
    });
}
export async function exit() { manager.closeAll(); }
