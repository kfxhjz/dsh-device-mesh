# 发布检查清单

[English](RELEASE.md) | 简体中文

本文是 `dsh-device-mesh` 的发布门槛，基线 DSH `0.2.2-rc.2`、插件 `0.1.x`
（开发者预览）。以下任一项未完成，不应打 tag。

## 1. 自动化门槛

在干净 checkout、`node >= 24.9` 下运行：

```sh
npm ci
npm run build
npm run typecheck
npm test
npm run test:coverage               # 源码覆盖率门槛
npm run test:e2e       # 需要 dsh CLI；relay 二进制与 Chrome 可选
npm pack --dry-run     # 必须列出 11 个文件（lib/、client.js、cordis.patch.yml、locale、icon、README、LICENSE）
```

| 检查 | 期望 |
|---|---|
| `npm run build` | 产出 `lib/host/index.js` 与 `client.js` |
| `npm run typecheck` | 无错误 |
| `npm test` | 单元/host/client 测试全绿 |
| `npm run test:e2e` | 插件加载、直连配对+portal、portal WebSocket 文本帧、真实 paseo-relay、真实浏览器远端 UI；无 Chrome 时浏览器用例 skip |
| `npm pack --dry-run` | 11 个文件，不含测试/文档/`node_modules`/密钥 |
| `git status --short` | 为空 |

E2E 可选环境变量：

- `DSH_CLI=/path/to/dsh` —— 默认用桌面版内置 CLI，其次 `PATH` 上的 `dsh`。
- `PASEO_RELAY_BIN=/path/to/paseo-relay` —— 开启真实 relay 用例，否则 skip。
- `CHROME_PATH=/path/to/chrome` —— 开启真实浏览器用例，否则 skip。

## 2. 人工验证矩阵

自动化已证明协议与远端 DSH 页面能在 Chrome 中经 portal 启动；打 tag 前仍需在真实
设备上完成下列矩阵（每列记录实际 OS/DSH 版本）。

| 场景 | A：Linux 桌面 | B：Linux 服务端 | C：macOS 桌面 | D：手机浏览器 |
|---|---|---|---|---|
| 构建并 `dsh plugin --profile <profile> add <dir>` | ☐ | ☐ | ☐ | — |
| 重启 DSH，左栏出现 **远程设备**，Settings 中可看到插件 | ☐ | ☐ | ☐ | — |
| 被控端展示配对二维码；主控端扫码或粘贴链接 | ☐ | ☐ | ☐ | ☐ 粘贴 |
| 双方显示相同 SAS；被控端批准 | ☐ | ☐ | ☐ | ☐ |
| 打开远端 UI 并完成一次 prompt/回复 | ☐ | ☐ | ☐ | ☐ |
| 远端审批、终端、文件预览可用 | ☐ | ☐ | ☐ | ☐ |
| 桌面壳中「在右侧栏打开」行为正常 | ☐ | n/a | ☐ | n/a |
| 仅 relay（关闭直连）可用 | ☐ | ☐ | ☐ | ☐ |
| 被控端撤销后 controller 会话立即关闭 | ☐ | ☐ | ☐ | ☐ |
| 内网/Tailscale 直连（无 relay）可用 | ☐ | ☐ | ☐ | — |

失败时记录设备、DSH 版本、脱敏日志与具体步骤；**"远端 prompt/审批"任一项失败即
阻塞发布**。

## 3. 安全签收

- [ ] 安全审查中 Critical/High 项已修复，且对应回归测试通过。
- [ ] 配对链接、`identity.json`、`peers.json`、DSH cookie、portal 能力 URL 未出现在
      日志、issue、截图或 release notes 中。
- [ ] `SECURITY.md` 的私密报告渠道真实可用。
- [ ] 公网部署 relay 使用 `wss://`，portal 端口绝不对外暴露；已阅读 SECURITY.md
      的加固清单。
- [ ] release notes 写明"已知限制与剩余风险"。

## 4. 仓库与发布包

- [ ] `package.json` 版本与 `CHANGELOG.md` 一致（`0.1.x`）。
- [ ] CHANGELOG 有本轮带日期的条目，无死链。
- [ ] Git 历史是预期的公开历史（无密钥、无个人机器路径；作者身份是有意选择）。
- [ ] `npm pack` 产物装进临时 `DSH_HOME` 并成功启动一次：

  ```sh
  DSH_HOME=$(mktemp -d) dsh plugin --profile web add ./dsh-device-mesh-0.1.0.tgz
  DSH_HOME=... dsh web --no-open --port 0
  ```

- [ ] 打 `v0.1.x` tag 并发布 release notes（安装命令、校验和、平台矩阵、已知限制）。
      推送 tag 会触发 `.github/workflows/release.yml`：校验 tag 与 `package.json`、重跑
      门槛、生成 `SHA256SUMS`，并从 `CHANGELOG.md` 生成 release body。npm 发布可选；
      `.tgz` 是受支持的交付物。

## 5. 每次 release notes 都要重复的已知限制

- 开发者预览：DSH 插件/slot/service 契约可能变化；每次 DSH 升级都要重跑本清单。
- Windows 不在测试矩阵内；Android/iOS/鸿蒙尚无构建（主控端是 Web client bundle）。
- 撤销会立即关闭会话，授权过期在 30 秒清扫周期内关闭；撤销的关闭码为 `1000` 而非
  `4403`。
- 一次性配对令牌在首次出示时即消费：被拒绝或超时后需要重新生成配对码。
- portal 反代的是被控端完整 DSH Web UI，等同于该设备的 owner 级控制；只与信任设备
  配对。
- 左栏主机栏与只读远程工作区镜像以纯 DOM 方式插在 ui-workspace 区块头上方（该位置
  没有插件 slot）。远程行只打开远程控制 portal，工作区/会话管理仍在远端 UI 中完成。
  如果 DSH 升级改变侧栏 DOM，它会自动隐藏，仍可从左栏的「远程设备」面板入口进入。
- portal cookie 按 host 共享、不按端口隔离：用户访问的其他本机 Web 服务能在服务端读到
  它。带 cookie 的 portal 请求还要求浏览器提供 Fetch Metadata（`Sec-Fetch-Site`），
  不发送该头的浏览器无法打开远程 UI。本机进程只应视为部分可信，请关闭不用的 portal 标签页。远端 UI 也运行在 portal
  的回环源中，可访问其他回环服务（DSH 的 `/api` Origin 围栏保护 DSH API，其他服务未必
  有同等防护）。
- 远程工作区列表最多 100 个工作区 / 200 个会话，超出时会标记为已截断；大用量用户请
  直接使用远端 UI。
- 主控端最多等待约 5.5 分钟配对批准（长于被控端 5 分钟的请求窗口）；主控端会话关闭会
  自动拒绝待批准请求。配对票据只在本机开启 relay 服务时广播 relay 端点。
