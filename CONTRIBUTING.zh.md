# 为 DSH Device Mesh 做贡献

[English](CONTRIBUTING.md) | 简体中文

感谢你抽出时间参与贡献。本文涵盖开发环境、插件打包契约、评审规则，以及合并 PR 之前需要通过的测试。[docs/zh/development.zh.md](docs/zh/development.zh.md) 是更深入的维护者指南：打包、host/UI 接缝、测试与发布。

参与即表示你同意保持讨论的技术性与相互尊重，并同意按仓库的 [MIT 许可证](LICENSE) 授权你的贡献。

## 开发环境

| 要求 | 说明 |
|---|---|
| Node.js `>=24.9.0` | host bundle 以 `node24` 为目标；完整源码覆盖率门槛建议使用 Node 26（`.nvmrc`）。 |
| npm | 仓库使用 `package-lock.json`；干净安装用 `npm ci` 即可。 |
| pnpm | `dsh plugin add`/`remove` 会转发给 pnpm，因此 DSH CLI 需要 `PATH` 上有 pnpm；CI 使用 pnpm 11。 |
| DSH `0.2.2-rc.2` | 插件基于该基线构建和测试（`engines.dsh` 为 `>=0.2.2-rc.1 <0.3.0`）。 |
| 可选：paseo-relay | 仅 relay 端到端测试和手工公网链路测试需要。 |

```sh
git clone <repo-url> dsh-device-mesh
cd dsh-device-mesh
npm ci
npm run build
npm run typecheck
npm test
```

## 命令

| 命令 | 作用 |
|---|---|
| `npm run build` | 同时构建两半：`lib/host/index.js` 和 `client.js`。 |
| `npm run build:host` | 只构建 host bundle。 |
| `npm run build:client` | 只构建 client bundle（改 UI 时使用）。 |
| `npm run watch` | 变更时自动重建。 |
| `npm run typecheck` | `tsc -p tsconfig.json --noEmit`。 |
| `npm test` | core、transport、host 和 client 测试套件。 |
| `npm run test:coverage` | 同一套测试，外加源码行/分支/函数覆盖率门槛。 |
| `npm run test:core` / `test:transport` / `test:host` | 每次只跑一个套件。 |
| `npm run lint` | 使用与 DSH 上游同族的 Oxlint 检查 `src`、`test`、`scripts`，包含 DSH 的 `@stylistic` 格式规则以及 import 卫生（顶层 `import type`、不重复导入同一模块）。 |
| `npm run check:scripts` | 对 `scripts/` 执行 `node --check`（Oxlint 忽略 `.mjs`，这能在 workflow 运行前发现语法错误）。 |
| `npm run test:e2e` | 启动真实的 `dsh web` 实例；见下文。 |

Oxlint `@stylistic` 插件加载的开发期 ESLint 依赖链，通过 `package.json` 的
`overrides` 固定为 `minimatch` 11.x，因为 ESLint 声明的范围仍带有 glob 拒绝服务公告；
等 ESLint 发布兼容范围后应移除该 override。

要在真实的 DSH profile 中试用改动，先把当前 checkout 构建并安装到一个一次性 profile，然后重启 DSH：

```sh
npm run build
dsh plugin --profile desktop add "$PWD"
```

实验时请使用隔离的 `DSH_HOME`，以免干扰你真实的设备身份和配对记录。

## 仓库结构

```text
src/shared/   线路类型、传输和会话接口（不依赖 Node）
src/host/     host 插件：Noise/通道/会话、传输、存储、配对、
              工作区、portal controller/daemon、DSH 装配
src/client/   Web client 插件：设备面板、配对二维码、远程工作区
scripts/      构建脚本
docs/         设计、协议、开发指南与 ADR
test/         core、transport、host、client 与端到端测试套件
```

host 插件是运行在进程内的受信任 Node.js 代码。它可以打开 socket、发起出站连接并读取 `$DSH_HOME`；请让这份能力保持窄小且可审计。client 插件运行在 DSH 浏览器外壳中，只通过同源的 `/api/device-mesh` 路由与本机 host 插件通信。

## 插件打包契约

以下几点很容易被破坏，而且很难调试。在修改 `package.json`、`cordis.patch.yml` 或 `scripts/build.mjs` 之前请先阅读。

### Bundle manifest

- `package.json` 必须让 `dsh.bundle.patch` 指向 `cordis.patch.yml`，且 `dsh.client.platform` 必须保持为 `"web"`。
- `prepack` 会重新构建两半，因此从干净 checkout 执行 `npm pack` 也一定包含 `client.js`
  与 `lib/host/index.js`。请保留它；单独的 `prepublishOnly` 不会在 `npm pack` 时运行。
- 声明了 `dsh.client` 的包**必须**导出 `./client`；否则 DSH 的组合步骤会拒绝该包。
- `cordis.patch.yml` 只插入一行 bare-package Loader 配置。不要把 client 半边写进 patch：DSH 会从包 manifest 中发现它。
- 保持 `engines.dsh` 准确。范围写错会让 DSH 跳过该 bundle（会记录在 `skippedBundles` 中，而不是被静默忽略）。

### Client bundle 格式

`client.js` 不是普通的浏览器 bundle。它必须是一个惰性 CommonJS 工厂，并严格按下面的形式包装：

```js
window.__ModuleLoader__.load({
  id: 'dsh-device-mesh',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    // bundled client code
    return module.exports
  },
})
```

- `id` 必须等于包名（`dsh-device-mesh`），否则外壳会报告 `loaded without registering "<id>" via __ModuleLoader__.load`。
- 在工厂函数运行之前，注册必须没有副作用；UI slot 和 effect 属于插件的 `apply`。
- DSH 外壳提供一组固定的共享模块基线。它们必须保持 **external**，绝不能被打进 bundle，否则页面会出现第二个 React 实例，导致 hooks 失败：

  `react`、`react/jsx-runtime`、`react-dom`、`react-dom/client`、
  `@deepseek-ai/cordis`、`zod`、`@tanstack/react-virtual`、`dsh-client-store`、
  `@deepseek-ai/dsh-client-ui-slots`、`@deepseek-ai/dsh-client-ui-primitives`、
  `@deepseek-ai/dsh-client-ui-dockkit`。

- 其他库会被内联进 bundle。除非它们确实是外壳提供的基础设施，否则不要把它们加入 `dsh.client.external`。
- slot 名称和服务契约会跟随 DSH 版本变化。使用新 slot 时，请在受支持的 DSH 基线上确认它确实存在，并在缺失时优雅降级。参见 [docs/zh/development.zh.md](docs/zh/development.zh.md) 和 [docs/zh/DESIGN.zh.md §8.3](docs/zh/DESIGN.zh.md#83-本地--远程工作区)。

### 不要提交的内容

以下内容属于生成物、本地状态或密钥，已被 `.gitignore` 忽略：

- `node_modules/`、`lib/`、`client.js`（构建产物）
- `.test/`、`.build/`、`.npm-cache/`、`.pnpm-store/`、`*.tgz`
- 本地 `$DSH_HOME` 状态、profile、设备身份和配对记录
- 配对链接、一次性令牌、私钥、cookie、来自真实设备的审计转储

如果需要 fixture，请在测试运行时于临时目录下生成。不要把真实的设备名、局域网地址、主机名或用户路径粘贴到源码、测试、文档或截图中。

## 编码约定

- TypeScript、ES 模块、两空格缩进；不要改成无分号风格，也不要引入其他风格变更。
- 保持 `src/shared/` 不引入 Node.js import，以便浏览器半边仍可复用。
- 优先使用现有的结构化服务访问方式（`ctx.get`）；可选的 DSH 服务缺失时应软失败。
- 永远不要记录配对令牌、私钥、会话哈希、cookie 或消息正文。只有消息确实需要时才记录设备 id。
- 新的协议行为属于规范变更：在同一个 PR 中更新 [docs/zh/PROTOCOL.zh.md](docs/zh/PROTOCOL.zh.md)，不兼容变更还要提升协议版本。
- 用户可见字符串放在 `src/client/locale.ts`；每个 key 都需要同时提供 `zh` 和 `en` 文案。

## 提交与 PR 约定

- 使用 Conventional Commit 风格的主题：`feat:`、`fix:`、`docs:`、`test:`、`refactor:`、`chore:`。使用祈使语气，不超过 72 个字符。
- 一个 PR 只做一项逻辑变更。不相关的重构、依赖升级和行为变更请拆开。
- 正文应解释**为什么**，而不是复述 diff。适用时用 `Fixes #123` 引用 issue。
- 在 [CHANGELOG.zh.md](CHANGELOG.zh.md) 的 `[Unreleased]` 下记录用户可见的变更（`Added`、`Security`、`Tests`）。
- PR 应说明：
  - 改了什么、为什么改；
  - 在哪些平台/DSH 版本上验证过；
  - 实际运行的命令及其结果；
  - 任何未验证的行为（桌面窗口 UI、相机扫码、面向 Android / iOS / 鸿蒙的移动端构建等）。
- 推送前运行 `git diff --check`；不要提交冲突标记或行尾空白。

## 测试要求

### 单元与传输测试

运行 `npm test`。修改协议、加密、配对、持久化或 portal 代理的 PR 需要：

- 为新路径提供正向覆盖；
- 适用时，为篡改、重放、过期、错误作用域和超大帧提供负向覆盖；
- 当握手实现变化时，更新 Noise 测试向量（`test/core/vectors/`）。

### 端到端测试

`npm run test:e2e` 会启动两个隔离的 DSH home，并通过本地 `/api/device-mesh` 路由驱动它们。它需要 DSH CLI；浏览器 UI 用例还会启动本机 Chrome（Playwright 驱动已安装的 Chrome，不下载浏览器），可用 `CHROME_PATH` 指定路径，否则该用例 skip；发布前运行 `npm run release:check` 执行 RELEASE.md 的自动化门槛。

- 把 `DSH_CLI` 设置为 `dsh` 可执行文件，例如安装 `@deepseek-ai/dsh` 后使用 `DSH_CLI="$(command -v dsh)"`。
- 如果未设置 `DSH_CLI`，测试框架会先尝试 macOS 打包的 CLI，再尝试 `PATH` 上的 `dsh`。
- relay 用例需要 paseo-relay 二进制。把 `PASEO_RELAY_BIN` 设置为它的路径，或把构建产物放到 `.build/` 下。缺失时 relay 用例会被跳过，而不是失败。
- `DSH_MESH_FORCE_BUILD=1` 会强制先重新构建。

测试框架在 `.test/e2e/` 下创建一次性 home；它永远不会读写真实的 `$DSH_HOME`。

### 手工检查

对于 UI 变更，请把构建安装到一个一次性 DSH profile，并在真实浏览器中检查设备面板、配对对话框、远程工作区列表和 portal。对于桌面端变更，请明确说明 Electron 窗口和右侧栏行为是否已人工检查——这部分不在自动化覆盖范围内。

## 安全

发现漏洞时不要开公开 issue。请遵循 [SECURITY.zh.md](SECURITY.zh.md)。拿不准时先脱敏：从日志和截图中移除令牌、密钥、cookie、`serverId` 值、配对链接和私有路径。

## 许可证

贡献按 [MIT 许可证](LICENSE) 接受。
