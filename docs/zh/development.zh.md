# 开发与维护指南
[English](../development.md) | 简体中文

状态：适用于插件 `0.1.4`，面向 DSH `0.2.2-rc.2`。本指南面向构建、扩展、评审或发布该插件的人，涵盖仓库布局、DSH 打包与 client bundle 契约、本地开发回路、host 与 UI 集成接缝、测试、调试与发布。

线路契约以[协议文档](PROTOCOL.zh.md)为规范；架构、安全理由与路线图见[设计文档](DESIGN.zh.md)。本指南说明如何在这份代码上工作，并链接到那些文档，而不是复述它们。

## 目录
1. [范围与版本基线](#1-范围与版本基线)
2. [仓库布局](#2-仓库布局)
3. [插件打包契约](#3-插件打包契约)
4. [client bundle 契约](#4-client-bundle-契约)
5. [本地开发回路](#5-本地开发回路)
6. [host 集成点](#6-host-集成点)
7. [client UI 集成地图](#7-client-ui-集成地图)
8. [测试策略](#8-测试策略)
9. [调试清单](#9-调试清单)
10. [发布与版本策略](#10-发布与版本策略)
11. [相关文档](#11-相关文档)

## 1. 范围与版本基线

- **DSH 基线：** `0.2.2-rc.2`；`package.json` 声明
  `"engines": { "dsh": ">=0.2.2-rc.1 <0.3.0", "node": ">=24.9.0" }`。
- **Node：** 构建和运行 `dsh web` 需要 24.9+；桌面应用自带运行时，因此这主要影响
  开发与 CI。
- **pnpm：** `dsh plugin add`/`remove` 会转发给 pnpm。桌面版自带的 CLI 仍需要
  `PATH` 上有 pnpm；CI 会安装 pnpm 11。
- **npm：** 用于 `npm ci`、构建、测试与 `npm pack`。
- **DSH 状态：** 开发者预览。manifest schema、client module loader、slot 目录、
  Connection 与 WebServer 服务都不是 semver 契约。把 DSH 升级当作代码变更，而不是
  依赖升级。

`engines.dsh` 是准入检查，不是沙箱。当 bundle 声明了 `engines.dsh` 时，Loader 只检查
该范围；没有声明时，它检查 `@deepseek-ai/dsh*` 的 peer 范围。范围之外的 bundle 会被
跳过并记录在 `skippedBundles` 中，绝不会静默降级。版本豁免确实存在，但那是显式的风险
决策，并不会让不兼容的代码变得安全。

每次 DSH 升级都需要同样的回归检查：`npm ci && npm run build && npm run typecheck && npm test`；
`DSH_CLI=<dsh> npm run test:e2e`；安装到一个一次性 profile，检查启动图、Devices 面板、
配对、远程工作区列表和一个 portal 标签页；对这里用到的每个 slot 与服务，重新阅读 DSH 的
slot 目录与 client-module 文档（§6–§7）。只有完成这些之后才放宽 `engines.dsh`，绝不
提前。

## 2. 仓库布局

```text
src/shared/   线路类型、RPC/session 接口与传输接缝。不 import
              node:，不 import DSH：浏览器 bundle 会内联它。
src/host/     host 插件：identity/store、配对、broker、Noise 通道、
              RPC/流、传输、portal controller/daemon、工作区、
              本地 Web API 与 DSH 装配。
src/client/   浏览器插件：Devices 面板、配对二维码/链接 UI、overlay、
              远程工作区分组、样式与字典。
scripts/      build.mjs：用 esbuild 构建 host bundle 与 client wrapper。
docs/         协议、设计、本指南与 ADR。
test/         core/、transport/、host/、client/ 与 e2e/ 套件。
```

保持两半职责清晰的原则：

- `src/shared/` 是唯一被两半同时 import 的代码；它必须不依赖 Node 内置模块和 DSH
  包，这样才能内联进 `client.js`。
- host 半边是受信任的同进程 Node 代码。它拥有 socket、`$DSH_HOME` 状态、配对、密码学
  与 portal，并且必须使用 `ctx.get(...)`，使缺失的可选服务降级为「功能不可用」。
- client 半边不是网络对端。它永远看不到设备密钥、配对令牌或 daemon 的 DSH cookie；
  它通过 `POST /api/device-mesh` 与自己的 host 通信，所有跨设备工作都发生在 host 内。
- `index.js` 只重新导出 `lib/host/index.js`，使包的 `main` 在构建后无需改写
  `package.json` 就能解析。

## 3. 插件打包契约

`package.json` 是与 DSH Loader 之间的契约。只有以下键对 DSH 有意义，其余都是普通的
npm 元数据。

| 键 | 此处的值 | 为什么重要 |
|---|---|---|
| `main` / `exports["."]` | `index.js` | host 半边的 Loader 入口。 |
| `exports["./client"]` | `./client.js` | 只要声明了 `dsh.client` 就必须提供；缺失会在组装阶段拒绝该包。 |
| `dsh.bundle.patch` | `./cordis.patch.yml` | 声明该包是一个 bundle，并指定它的 profile 层。 |
| `dsh.client.platform` | `"web"` | DSH 消费的唯一浏览器平台。 |
| `engines.dsh` | `>=0.2.2-rc.1 <0.3.0` | Loader 准入范围。 |
| `files` | `index.js`、`client.js`、`lib/`、`cordis.patch.yml`、`locale/`、`icon.svg`、`README.md`、`LICENSE` | `npm pack` 发布的内容。`README.zh.md` 未列出，但 npm 总会自动纳入，因此 tarball 为 11 个文件。 |

`cordis.patch.yml` 只插入一行 bare-package Loader row：

```yaml
- insert:
    - id: device-mesh
      name: dsh-device-mesh
      config: {}
```

一行就够。client 半边**不是**第二行：DSH 会扫描 Loader 入口，找到最近的
`package.json`，读取 `dsh.client` 并提供 `exports["./client"]`。再加一行 client row
会重复图入口，是白屏的常见原因。

组装顺序很重要。后加载的层会覆盖先前的行：profile 的 `dsh.profile.bundles` 按列表
顺序，然后是 profile 自己的 `cordis.patch.yml`，再是机器级 patch，最后是 `--patch`
覆盖层。新 bundle 会追加到列表末尾，因此它不会自动胜过已有的 patch。用
`dsh --profile <profile> --dump-config` 检查解析后的层；永远不要手工编辑 profile 文件。

| 安装方式 | 命令 | 说明 |
|---|---|---|
| npm registry | `dsh plugin --profile <profile> add dsh-device-mesh` | 版本发布后推荐给用户；安装预构建文件，无需构建授权。 |
| Release tarball | `dsh plugin --profile <profile> add ./dsh-device-mesh-<version>.tgz` | 预构建兜底；受支持的交付物。 |
| 本地 checkout | `dsh plugin --profile <profile> add "$PWD"` | 追加 bundle 并链接 checkout；开发回路。 |
| 桌面 GUI / agent 工具 | 设置 → 插件 / `plugin_manager` | 同一套 pnpm 操作；安装本地目录。agent 工具需要 `danger-full-access` 或逐次批准。 |

### DSH profile

DSH 的 **profile** 是 `$DSH_HOME/profiles/<name>/` 下按顺序叠加插件 bundle patch 层的
具名环境。它拥有自己的 `package.json`（`dsh.profile.bundles` 列表与依赖）和
`cordis.patch.yml`，所以装进一个 profile 的 bundle 不会出现在另一个 profile 中。
`dsh plugin --profile <name> add …` 会在该 profile 目录内运行 pnpm，并把 bundle 追加进
列表；`--profile` 是必填的，profile 会在首次使用时初始化。

| 你的启动方式 | 安装到 |
|---|---|
| DSH Desktop 桌面版 | `desktop` |
| `dsh web` | `web` |
| `dsh headless` | `headless` |
| `dsh tui` | `tui` |
| `dsh --profile <name>` | `<name>` |

```sh
# 桌面版
dsh plugin --profile desktop add dsh-device-mesh

# 运行 `dsh web` 的无头服务器
dsh plugin --profile web add dsh-device-mesh

# 基于随附 web 模板创建的自定义 profile
dsh --from-default-profile web --profile edge --dump-config
dsh plugin --profile edge add dsh-device-mesh

# 不启动检查
dsh plugin --profile desktop list --depth 0
dsh --profile desktop --dump-config
```

`$DSH_HOME` 默认是 `~/.dsh`，profile 位于 `~/.dsh/profiles/` 下。

链接的目录不会被 `files` 过滤，因此重新构建后无需重新安装即可生效；`files` 只作用于
`npm pack`。git 安装针对源码运行，因此 `prepare` 脚本需要在 profile 的 pnpm 设置中
批准；npm 包或 `.tgz` 可以避开这一步。

关于 DSH 一侧，请参阅官方[插件开发指南](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/index.md)、
[发布指南](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/publish.md)
与 [client modules 参考](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/client-modules.md)。

## 4. client bundle 契约

`client.js` 不是普通的浏览器 bundle。它必须是惰性的 CommonJS 工厂：

```js
window.__ModuleLoader__.load({
  id: 'dsh-device-mesh',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    return module.exports
  },
})
```

- `id` 必须等于包名；不匹配会失败并报
  `loaded without registering "<id>" via __ModuleLoader__.load`。
- 脚本执行只注册工厂。slot、样式与监听器属于导出的 Cordis 插件的 `apply`，在实例化
  时运行。工厂返回该插件：一个带 `apply` 和可选 `inject` 的函数、对象或类。

DSH Web shell 冻结了一组共享模块基线。它们必须保持 **external**；把 React 打包进来
会创建第二个 React 实例并破坏 hooks。

```text
react, react/jsx-runtime, react-dom, react-dom/client, @deepseek-ai/cordis, zod,
@tanstack/react-virtual, dsh-client-store, @deepseek-ai/dsh-client-ui-slots,
@deepseek-ai/dsh-client-ui-primitives, @deepseek-ai/dsh-client-ui-dockkit
```

`dsh.client.external` 只用于额外的、由 shell 提供的基础设施。普通库会内联进
`client.js`；不要把它们标记为 external。

`scripts/build.mjs` 是一个很薄的 esbuild 包装：

- **Host：** `src/host/index.ts` → `lib/host/index.js`，ESM，`node24`，
  `packages: 'external'`，使 `ws`、`@noble/ciphers` 与 Node 内置模块从 profile 的
  `node_modules` 解析。
- **Client：** `src/client/index.tsx` → `client.js`，CJS，`es2022`，
  `jsx: 'automatic'`，使用基线 external 列表，并加上 banner/footer 字符串以生成上面
  的 wrapper。

不要后处理 `client.js`；改 TypeScript 源码或构建脚本，然后重新构建两半。

HMR 只作用于 client bundle。DSH 监听被提供的 `client.js`（mtime、ctime 和大小，约每
500 ms 轮询一次），推送 `rebuilt` 事件，浏览器随后重新实例化该模块。它不会运行本仓库
的构建：请使用 `npm run watch`。改动 `package.json`、`cordis.patch.yml` 或 host
bundle 仍然需要重启 DSH，因为它们改变的是组装结果或 Node 进程。

## 5. 本地开发回路

```sh
npm ci
npm run build          # host + client
npm run typecheck      # tsc --noEmit
npm test               # core + transport + host + client
npm run watch          # rebuild on change
```

要在真实的 DSH 实例中使用构建产物，请把 checkout 安装到一个一次性 profile，并重启
DSH 一次：

```sh
npm run build
dsh plugin --profile <profile> add "$PWD"
```

为实验使用单独的 `DSH_HOME`，这样开发身份、配对记录与审计日志永远不会碰到你的真实
设备：

```sh
export DSH_HOME="$(mktemp -d)"
dsh web --no-open --port 0
```

命令会打印 `http://127.0.0.1:<port>/?token=…`。打开一次该 URL，用启动令牌换取浏览器
cookie，然后正常使用浏览器。进行无头探测时，保留 cookie jar，并用
`{ "endpoint": "...", "payload": ... }` 调用 `/api/device-mesh`。

桌面版 DSH 只读取保留的 `desktop` profile；`dsh web` 使用你传入的 profile（通常是
`web`）。装错 profile 是「插件不见了」最常见的报告。

| 变更 | 操作 |
|---|---|
| `client.js` / `src/client/**` | 重新构建；HMR 会替换 bundle。如果页面在 HMR 生效前就已打开，请刷新。 |
| `lib/host/index.js` / `src/host/**` | 重新构建并重启 DSH；host 代码运行在 Node 进程内。 |
| `package.json`、`cordis.patch.yml`、`locale/*.json` 元数据 | 重新安装/重启；Loader 的组装结果变了。 |
| `scripts/build.mjs` | 重新构建；只有 host bundle 变化时才需要重启。 |

端到端测试使用以下环境变量：

| 变量 | 用途 |
|---|---|
| `DSH_CLI` | 用于隔离实例的 `dsh` 可执行文件；回退顺序是 macOS 打包的 CLI，然后 `PATH` 上的 `dsh`。 |
| `PASEO_RELAY_BIN` | relay E2E 用例使用的 paseo-relay 二进制；回退到 `.build/bin/paseo-relay` 与 `.build/paseo-relay-target/release/paseo-relay`。缺失时跳过。 |
| `DSH_MESH_FORCE_BUILD` | 设为 `1` 时在运行前重新构建，而不是复用已有产物。 |

测试框架在 `.test/e2e/` 下创建一次性 home；它从不读取或写入真实的 `$DSH_HOME`。要
测试本地 relay，请在 paseo-relay checkout 中运行
`CARGO_TARGET_DIR="$PWD/.build/paseo-relay-target" cargo build --release`，或者让
`PASEO_RELAY_BIN` 指向已有的二进制。

## 6. host 集成点

host 入口声明 `inject = ['webServer', 'connection']`。这两个服务都由随附的 Web 与
Desktop profile 组装。其他一切——工作区注册表、会话、标题、agent——都以防御式方式查找，
在精简的组装中可能不存在。架构理由见[设计文档 §8](DESIGN.zh.md#8-dsh-集成点)。

1. **本地浏览器 API。** 在 `apply` 期间，插件调用
   `ctx.connection.fetch.register({ path: '/api/device-mesh', methods: ['POST'], requestBody: 'buffered', fetch })`。
   这把 handler 挂到 DSH 经 cookie 认证的 `/api` 通道上：只有 DSH owner 会话能到达它。
   这是同机控制通道，不是跨设备 API。
2. **本地 DSH origin。** `ctx.webServer.getOrigin()` 返回运行中的 DSH 实例真实的
   scheme、host 与端口；portal 绝不能猜测 `127.0.0.1:3080`。
3. **本地 DSH 认证。** `ctx.connection.authenticatedUrl(origin)` 返回一个会设置
   `dsh-auth-*` 浏览器 cookie 的启动 URL。daemon 手动跟随 `303`（自动重定向会隐藏
   `Set-Cookie`），只在内存中保留 `dsh-auth-*` 值，并在接近过期或上游返回 `401` 时
   刷新。它永不写入磁盘、进入日志或经 Mesh 发送。

portal 把 cookie 处理拆成两段。浏览器用 portal 作用域的
`HttpOnly; SameSite=None; Secure` cookie 与 `127.0.0.1:<portal-port>` 通信，而 daemon
在上游注入自己的 DSH cookie。回环 cookie 按 host 共享、不按端口隔离：请求围栏
（精确 `Host`、同源 `Sec-Fetch-Site`、WebSocket `Origin`）阻止其他回环页面**使用**
cookie，但无法阻止其他本机 HTTP 服务在服务端**读取**它。带 cookie 的 HTTP 请求
必须提供 `Sec-Fetch-Site`（`same-origin` 或 `none`），缺失即拒绝，因此不支持非浏览器
cookie 客户端。Hop-by-hop 头、`Host`、
`Cookie`、`Origin`、`Referer`、`sec-fetch-*` 与 DSH 自有的整个 `x-dsh-*` 命名空间在
信任边界被剥离，并在 daemon 侧重建；`Set-Cookie`、`X-Frame-Options` 与 CSP
`frame-ancestors` 被移除（并补充 `X-Content-Type-Options: nosniff`），使本地页面可以
嵌入远程 UI。完整规则见[协议文档 §7](PROTOCOL.zh.md#7-portal-转发)。

这些接口虽然都是公开服务，但对版本敏感。`connection.fetch.register`、
`webServer.getOrigin`、`authenticatedUrl` 与 `/api` 信任围栏是内部产品契约，不是
semver API。DSH 升级可能改变签名、cookie 属性、Origin 规则或头名称。每次升级后都要
重新运行 portal E2E 与手工检查；只通过 typecheck 是不够的。

## 7. client UI 集成地图

client bundle 是一个普通的 Cordis 插件，使用 `ctx.slots.inject` 与
`ctx.slots.register`。它使用四个 slot：

| Slot | 类型 | 本插件注册的内容 |
|---|---|---|
| `main` | keyed | Devices 面板，key 为 `device-mesh`。`sidebar.panellist` 的 id 必须匹配，并且面板必须先注册，`ctx.layout.selectPanel` 才能成功。 |
| `sidebar.panellist` | list | Devices 图标行，带待批准配对角标。 |
| `shell.overlay` | list | 点击穿透的 overlay，在面板关闭时保持待批准配对请求可见。 |

「工作区」上方的主机切换器**不是** slot 注册：ui-sidebar 在面板列表与
`sidebar.workspaces`（ui-workspace 独占的 single slot）之间没有插件位置。
`src/client/sidebar-host.ts` 在 ui-workspace 的区块头前插入一小块纯 DOM 主机栏
（锚点 `data-sidebar-workspace-header`，回退到发布版的 `sectionHeader` class），
重新渲染后自动补插，并在 56px rail 中隐藏。它必须保持零依赖（不使用 `react-dom`）
且失败时自动退让：锚点变化时由面板列表入口与 Devices 面板兜底。

每个注册都遵循同一种模式：

```ts
ctx.slots.inject('main', () => ctx.slots.register({
  name: 'main', key: 'device-mesh', locale: NS,
  inject: () => ({ openRemoteTab }),
}, DevicesPanel))
```

- 等待 slot 声明；绝不要在 apply 时直接注册。
- `list` slot 需要 `id`，并应设置 `order` 与 `locale`；`single` slot 按优先级抢占。
- 组件不接收 `ctx`；数据与回调通过 `inject` 的 hooks/props 或本地 API 模块传入，
  `apply` 负责查找服务。样式、locale 与 effect 注册通过 `ctx.effect` 返回清理函数。

Devices 面板是**管理**界面：**本机**（身份、直连、relay）与**远程设备**（配对、状态、
打开/撤销/忘记）。工作区不再在面板里重复：原生 Workspaces 标题上方的 **host 切换器**
选择主机，并在原位置以只读镜像展示该主机的工作区与会话（行点击打开远程 portal）。
DSH 原生的 `sidebar.workspaces` 是由 `ui-workspace` 独占的 single slot，原生工作区行
不暴露第三方 slot。注入远程行意味着替换整棵树，并复制搜索、分组、拖拽、悬停卡片与
会话创建。[设计文档 §8.3](DESIGN.zh.md#83-本地--远程工作区)记录了这一边界。

干净的最终形态是上游 `ui-workspace` 增加一个小 slot：`sidebar.workspace.row.trailing`，
让插件可以在原生工作区行上渲染设备徽标，并让两种 scope 都使用原生树。这大约是一个
30 行的上游改动，不是协议依赖，也不属于 MVP。不要在本仓库中 patch `ui-workspace`。

移动端与扫码限制：controller 是 Web 客户端，可以在手机浏览器或 WebView 中工作，但
仍受 DSH 移动布局约束（抽屉式侧栏、悬停只在 `@media (hover: hover)` 下启用、粗指针
目标区域）。portal 的 cookie 认证要求浏览器提供 Fetch Metadata（`Sec-Fetch-Site`；Chromium 88+、
Firefox 90+、Safari 16.4+）；更旧的浏览器只能配对/管理，无法打开远程 UI。扫码使用
`BarcodeDetector`，可在安全上下文中的 Chromium 系浏览器（包括
Android Chrome）上使用；iOS 的 Safari 不提供它，鸿蒙浏览器的支持情况未经验证，因此
保留粘贴链接的兜底方案。没有移动应用或原生相机集成；后台保活、权限以及面向
Android / iOS / 鸿蒙的原生外壳是另外的工作。深链是尽力而为：controller 在 portal URL
上追加 `?dm-session=<id>&dm-embed=1`；portal 保存 id，远端这份插件在 shell 就绪后通过
`uiWorkspace.openSession` 打开对应会话，DSH UI 表面变化时回退到远端首页。

## 8. 测试策略

每个 pull request 之前运行 `npm test`；涉及传输、配对、portal、DSH 装配或 client
启动图的改动还要运行 `npm run test:e2e`；提交前先跑 `npm run lint`（Oxlint + DSH 的 `@stylistic` 格式规则）。

| 套件 | 命令 | 覆盖范围 |
|---|---|---|
| Core | `npm run test:core` | Noise NK/NKpsk0 测试向量、密码学、通道认证（含 paired 与 pair-token 不变量）、RPC/流多路复用、portal WebSocket 关闭记账、篡改/重放失败。 |
| Transport | `npm run test:transport` | 直连 listener/client、Origin 拒绝、上限、针对 mock 与真实 relay 的 relay v1/v2。 |
| Host | `npm run test:host` | Store 原子性/恢复与身份密钥对校验、配对签名/TTL/重放、broker（含 relay 票据开关与待批准请求取消）、工作区映射与 64 KiB 列表预算、portal controller/daemon、本地 Web API。 |
| Client | `npm test` | 覆盖 client store、normalizers、i18n 字典、QR 与 deep-link helper 的直接单测，sidebar host bar/switcher 的 happy-dom 测试，以及 bundle 是否注册预期 slot、是否没有 host-only import 的静态检查。 |
| 覆盖率 | `npm run test:coverage` | 同一套测试，统计 `src/**/*.ts`。Node 26 上用 `--test-coverage-include-all` 计入从未加载的文件，并强制行/分支/函数门槛 80/72/77；Node 24 回退到已加载文件门槛（89/72/77），CI 在 Ubuntu 上同时运行两种模式。`src/client/index.tsx` 这个 bundle 入口刻意不在统计范围内（include glob 只匹配 `.ts`）；它的接线契约由 bundle 测试覆盖。 |
| 端到端 | `npm run test:e2e` | 两个隔离的 `dsh web` 实例：插件加载与本地 API；直连配对、SAS 批准、工作区列表与 portal；仅 relay 的配对与 portal；portal WebSocket 文本帧。 |
| 浏览器 UI | `npm run test:ui`（包含在 `test:e2e` 中） | 无头 Chrome 打开 portal 并启动被控端真实 DSH UI，包括其要求 text 帧的 Remote stream WebSocket；无 Chrome 时 skip。 |

真实 paseo-relay 用例是可选的。设置 `PASEO_RELAY_BIN`，或在 `.build/` 下构建 relay；
没有二进制时该用例会被跳过，而不是失败。mock relay 测试仍会运行，因此普通 checkout
也能捕获传输回归。

打 tag 前运行 `npm run release:check`：执行构建、typecheck、单元与 E2E、`npm pack --dry-run`，
对应 [`RELEASE.zh.md`](../../RELEASE.zh.md) 的自动化门槛。

CI 在 Ubuntu、macOS 上以 Node.js 24 和 26 运行 `npm ci`、`npm run build`、`npm run typecheck`、
`npm run lint`、`npm test`，并把同一套单元门禁在 Windows/Node 24 上作为独立 job 运行（Windows
单独失败不会阻塞 E2E）。覆盖率在 Ubuntu 上同时覆盖 Node 24（已加载文件回退门槛）与 Node 26
（完整 include-all 门槛）。两个 E2E job 与发布门禁都使用 Node 26；`npm run test:e2e` 以全局安装的
DSH `0.2.2-rc.2` 和 `DSH_CLI=dsh` 运行。另有独立的 `e2e-relay` job 会构建固定版本的 paseo-relay
`v0.1.2` 二进制，并针对它运行 `test/transport/relay-e2e.test.ts` 与 `test/e2e/relay.test.ts`。
夜间定时任务会完整重跑一次 CI，并额外运行 soak 套件。

发布工作流（`.github/workflows/release.yml`）通过 `npm run release:check` 运行同一套门槛，校验 `v*`
tag 与 `package.json` 版本一致，生成 `SHA256SUMS`，并用 `scripts/release-notes.mjs` 从 `CHANGELOG.md`
生成发布说明后发布 tarball。

测试不得依赖真实的 `$DSH_HOME`、网络对端或相机。在测试时于临时目录下生成 fixture。
绝不要把真实设备名、LAN 地址、host ID、配对链接或令牌粘贴进 fixture。

## 9. 调试清单

| 症状 | 可能原因 | 检查或修复 |
|---|---|---|
| 白屏或插件缺失 | bundle 未注册、`id` 错误、缺少 `exports["./client"]`，或 profile 错误 | 查看启动审计与 host 日志；检查 `exports` 与 Loader row；确认界面所用 profile（`desktop` 还是 `web`）。 |
| `require("x") missed the module table` | 基线模块被一起打包，或非基线模块被标记为 external | 保持 §4 的基线 external；其他库内联；不要自创 `dsh.client.external` 条目。 |
| Invalid hook call / 两个 React | React 或 `react-dom` 被一起打包 | 用基线 external 列表重新构建；检查 esbuild 选项，而不只是 import。 |
| slot 注册抛错 | slot 未声明、`id` 重复，或 `single` 抢占冲突 | 查看对应 DSH 版本的 slot 目录；确认 slot、props 与 id 的形态。 |
| 插件出现在 `skippedBundles` 中 | `engines.dsh`/peer 范围不匹配，或 `dsh.bundle.platforms` 排除了该 host | 打印跳过原因；只在完成回归检查后放宽范围，或添加显式豁免。 |
| Loader row 存在但无效 | 更高的 patch 层覆盖/禁用了该行，或某个 override 替换了整个 `config` | 运行 `dsh --profile <profile> --dump-config`；在 override 中重新写全 config。 |
| `client.js` 变了但页面没变 | HMR 被禁用、时间戳/大小未变，或 manifest 变了 | 确认 `client-hmr` 已启用；touch 构建产物；manifest/patch 变化后重启。 |
| portal 403/401 或登录循环 | Origin/Host 围栏、缺少受信任 authority、DSH cookie 过期，或 cookie 属性 | 验证回环、`getOrigin()`、`authenticatedUrl()`、`--trusted-host`、TLS 与 portal cookie；见 §6。 |
| relay 始终连不上 | endpoint 错误、TLS/Origin 白名单、`serverId` 不匹配，或 relay 不可达 | 检查 `wss://…/ws`、证书与 relay 日志；确认两端共享 `serverId`；持续 `1013` 是容量/准入问题，不是协议问题。 |
| 直连超时 | 防火墙拦截插件端口，或票据公布了不可达的接口 | 放行 TCP `45871`（或配置的端口）；优先使用 Tailscale；检查票据的端点列表。 |
| 桌面 portal 窗口/右侧栏显示异常 | 这条路径未自动化 | 在 Electron 中手工验证，并在 pull request 中记录结果。 |

当失败与安全相关时，先脱敏：从日志与截图中移除令牌、密钥、cookie、`serverId` 值、
配对链接与私有路径。

## 10. 发布与版本策略

`prepack` 运行 `npm run build`，因此 `npm pack` 与 `npm publish` 一定包含
`client.js` 与 `lib/`；`prepublishOnly` 还会运行 `npm test`。发布从干净的 checkout
开始，而不是工作树：

1. 运行 `npm ci`、`npm run typecheck`、`npm run lint`、`npm test`、
   `npm run test:coverage` 与 `npm run test:e2e`（需要 DSH CLI；如果 relay 行为有
   变化，还需要真实 paseo-relay）；`npm run release:check` 会执行同一套自动化门槛。
2. 运行 `npm run build`；检查 `lib/host/index.js`，并确认 `client.js` 以生成的
   `__ModuleLoader__.load` banner 开头。
3. 运行 `npm pack --dry-run`；tarball 必须包含预期的 11 个文件：
   `index.js`、`client.js`、`lib/host/index.js`、`cordis.patch.yml`、
   `locale/en.json`、`locale/zh.json`、`icon.svg`、`README.md`、`README.zh.md`、
   `LICENSE` 与 `package.json`。
4. 把 tarball 安装到一次性 profile，重复冒烟测试，更新
   [CHANGELOG](../../CHANGELOG.zh.md) 并为发布打 tag。

绝不要提交构建产物或本地状态：`lib/`、`client.js`、`node_modules/`、`.test/`、
`.build/`、`*.tgz`、`.pnpm-store/`、`$DSH_HOME` profile、设备身份、配对记录、令牌、
私钥或审计转储。`.gitignore` 覆盖了常见路径；暂存前检查 `git status --short`。

版本策略：插件版本独立于线路版本。保持协议 `1` 的发布不需要重新配对；不兼容的线路
变更会升 `PROTOCOL_VERSION`，并需要重新配对。`engines.dsh` 是发布契约的一部分：
不要发布未经测试的范围；DSH 会跳过 bundle，而不是降级。安全与协议变更遵循
[SECURITY](../../SECURITY.zh.md) 与[协议文档](PROTOCOL.zh.md)，并与代码同步更新。
不要发布 `private` 包，也不要依赖 git 安装来运行构建：请发布产物，或记录
`prepare`/批准步骤。

## 11. 相关文档

- [README](../../README.zh.md) —— 安装、配对与运行。
- [CONTRIBUTING](../../CONTRIBUTING.zh.md) —— 工作流、命令与 PR 期望。
- [设计文档](DESIGN.zh.md) —— 架构、威胁模型、DSH 集成与路线图。
- [协议文档](PROTOCOL.zh.md) —— 线路格式、RPC、portal 与 relay 规则。
- [ADR 0001](adr/0001-remote-control-in-dsh.zh.md) —— 为什么 MVP 使用 host 侧
  mesh 加回环 portal，而不是第二棵 client 树。
- [SECURITY](../../SECURITY.zh.md) —— 漏洞报告与部署加固。
- DSH 参考：[client modules](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/client-modules.md)、
  [slots](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/slots.md)、
  [web server](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/web-server.md)、
  [web client](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/web-client.md)。
