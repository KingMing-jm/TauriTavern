# Node.js 后端插件验证宿主

本分支提供桌面端实验宿主。Node.js 是独立进程，TT 继续由 Rust 管理聊天、角色、设置和模型请求。首个接入的插件是柏宝库 0.6.4，固定源提交 `1f8e6b409839141fd0c1afa6cdf3de49d7f3ad64`。

## 当前范围

| 能力 | 当前行为 |
| --- | --- |
| 通用入口 | `plugins.json` 显式列出入口；ESM/CommonJS 的 `info / init(router) / exit()`，真实 Express Router |
| 请求 | `/api/plugins/<id>/*` 经 TT 路由、application service、Rust adapter 转发到 Node |
| 浏览器子资源 | 同一路径可加载脚本/样式/图片；production Wry 和 dev `tt-ext` 经过同一 application service |
| 用户上下文 | `req.user.profile.handle = default-user`；`req.user.directories.root` 指向当前 TT 数据根目录下的 `default-user` |
| 柏宝库 | 原始 KV、批量事务、SQLite 持久化、向量接口、`v1/client.js`；使用 Node 自带 `node:sqlite` |
| ST 服务端功能 | 聊天保存、后台生成、设置/角色缓存、预设备份、tokenizer 和前端文件改写未接入；已知相关路由返回 `501 TT_CAPABILITY_UNAVAILABLE`，status 关闭相关 capability |
| 平台 | 桌面验证；Android/iOS/OHOS 报告 `unsupported`，没有 Node Mobile 或原生 addon 打包 |

柏宝库 `api.js` 在准备阶段移除 ST 专属导入和路由，保留上游存储/向量处理器；替换入口不执行修改 ST 前端文件的 installer。替换锚点绑定固定源版本，漂移即准备失败。完整源文件及构建来源保存在生成 runtime 中，可审阅差异。

插件是受信任的本机代码，拥有当前用户的 Node 权限；进程隔离和本机令牌不构成文件系统沙箱。当前没有仓库安装 UI、自动更新、ST 内部模块 ABI 或完整多用户服务。

## 准备与使用

需要桌面 Node.js >=22.13、npm 和 Git。验证版显式选择 Node 可执行文件，尚未把 Node 二进制打进应用安装包。原有 Lucky 构建及移动端不依赖此环境。

```sh
# 第三个参数是 TT 当前的数据根目录，省略时只构建 runtime。
node scripts/node-plugins/prepare.mjs /absolute/plugin-runtime /absolute/tt-data
```

脚本固定下载源码，按 npm lockfile 安装 Express（禁用 install scripts），生成适配入口和 `plugins.json`，随后独占创建 `/absolute/tt-data/_tauritavern/node-plugins.json`。已有配置不会覆盖。格式：

```json
{
  "node": "/absolute/path/to/node",
  "runtime": "/absolute/plugin-runtime"
}
```

更新现有 runtime 前先停止宿主。TT 首次插件请求按需启动 Node。管理接口：

```js
await window.__TAURITAVERN__.api.nodePlugins.status();
await window.__TAURITAVERN__.api.nodePlugins.start();
await window.__TAURITAVERN__.api.nodePlugins.stop();
await window.__TAURITAVERN__.api.nodePlugins.restart();
await (await fetch('/api/plugins/baibaoku/v1/status')).json();
```

原始客户端可用 `<script src="/api/plugins/baibaoku/v1/client.js"></script>` 加载，提供 `window.BaiBaoKu.database(name)` 等接口。宿主不会改写页面注入客户端。前端柏宝箱出现“已安装”不能代替 capability 检查，所有 ST 专属优化并未因此可用。

数据库沿用 `default-user/baibaoku/databases/*.sqlite`、WAL 和 registry 布局。TT 聊天/设置没有另建 Node 写入入口。

## 生命周期与边界

- 未配置为 `disabled`，未启动为 `idle`；显式停止为 `stopped`，异常退出为 `failed`。异常后必须显式 start/restart。
- stdin 传递一次性令牌与用户根目录；stdout 仅用于有大小/超时上限的 readiness；日志进入 `_tauritavern/node-plugins.log`。令牌不进入 argv、前端或日志。
- Node 只监听 `127.0.0.1` 随机端口，拒绝 Origin 和缺失/错误令牌。Rust 禁用环境代理与重定向，不转发 cookie、authorization 等浏览器凭证。
- IPC 只能访问合法插件路径；私有关闭接口不可通过前端请求。JSON/text 请求和响应上限均为 8 MiB，端点超时 30 秒。暂不支持 multipart、SSE 或大文件流。
- stop 停止接受请求，等待请求结束并调用 exit hooks；超时或失败向调用者报错。父进程管道关闭也触发退出，Rust child 的 kill-on-drop 防止遗留进程。
- Wry production 资源回调是同步 API，presentation glue 在线程上等待同一个异步 service；具体进程、文件和网络 IO 归 `tt-adapter-extension`。

## 验证

```sh
node scripts/node-plugins/prepare.mjs /absolute/plugin-runtime
TT_NODE_PLUGIN_RUNTIME=/absolute/plugin-runtime TT_NODE_BINARY=/absolute/path/to/node \
  cargo test --manifest-path src-tauri/Cargo.toml -p tt-adapter-extension --test node_plugins -- --ignored
node --experimental-vm-modules scripts/node-plugins/smoke.mjs /absolute/plugin-runtime
node scripts/check-rust-crate-boundaries.mjs
pnpm run check
```

真实 Node 测试显式准备环境，不在普通 Rust 测试中联网。Rust 验收覆盖启动、SQLite 写入、关闭、重启、持久化与非法数据库名；前端 smoke 使用原始客户端、真实 TT 路由和 Node/SQLite，原生 IPC 边界由传输夹具连接，Rust 适配器另测。这不等同于原生 WebView 视觉/交互验收。

smoke 输出单条写入、100 条批量写入和读取中位耗时。没有与 TT 原生扩展存储做同口径比较，不能据此宣称启动、聊天渲染或整机性能提升。

2026-10-16 本机验收（macOS arm64、Node 22.23.2、Rust 1.95.0）：上述真实 Rust/SQLite、原始客户端、向量检索、并发写入、CommonJS/ESM 和父进程断开清理均通过；完整 `pnpm run check` 通过。每项 12 次、丢弃前 2 次后，中位耗时为单条 1 KiB 写入 3.040 ms、100 条批量写入 11.728 ms、读取 2.883 ms。前端计时包含 TT 路由和测试传输夹具，不包含真实 Tauri IPC；其他桌面平台及原生 WebView 加载尚未实测。

参考：[SillyTavern plugin loader](https://github.com/SillyTavern/SillyTavern/blob/release/src/plugin-loader.js)、[柏宝库固定源](https://github.com/baibai-git/baibaoku/tree/1f8e6b409839141fd0c1afa6cdf3de49d7f3ad64)。
