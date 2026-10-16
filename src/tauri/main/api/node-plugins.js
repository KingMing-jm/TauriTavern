export function installNodePluginApi(context) {
    const hostAbi = window.__TAURITAVERN__;
    if (!hostAbi) throw new Error('Host ABI __TAURITAVERN__ is missing');
    hostAbi.api ??= {};
    hostAbi.api.nodePlugins = Object.freeze({
        status: () => context.safeInvoke('node_plugin_status'),
        start: () => context.safeInvoke('start_node_plugins'),
        stop: () => context.safeInvoke('stop_node_plugins'),
        async restart() {
            await context.safeInvoke('stop_node_plugins');
            return context.safeInvoke('start_node_plugins');
        },
    });
}
