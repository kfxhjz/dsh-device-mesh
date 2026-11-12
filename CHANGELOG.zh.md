# 变更日志

[English](CHANGELOG.md) | 简体中文

本文件记录本项目所有值得注意的变更。

格式基于 [Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/)，
并且本项目遵循 [语义化版本](https://semver.org/spec/v2.0.0.html)。

## Unreleased

### 变更（Changed）

- 工具链与依赖升级到最新版本：TypeScript 7（原生编译器）、`@types/node` 26、
  Oxlint 1.93 与 `oxlint-tsgolint` 7.0.2006、tsx 4.23、`ws` 8.22、
  `@types/ws` 8.18。CI 与发布工作流改用 `actions/checkout@v7`、
  `actions/setup-node@v7`、`pnpm/action-setup@v6`、
  `actions/upload-artifact@v7`、`github/codeql-action@v4` 与
  `softprops/action-gh-release@v3`。
- 新增 npm `overrides`，把 `minimatch` 固定到已修复的 11.x 分支，Oxlint
  `@stylistic` 插件加载的开发期 ESLint 依赖链不再报告 glob 拒绝服务公告。

## 0.1.0 - 2026-11-12

### 新增（Added）

- 新增 Paseo 风格的主机切换器，放在左栏「工作区」正上方：直接显示当前主机名，下拉列出
  本机、已配对主机及实时状态。选中远程主机时，工作区区域切换为**只读远程镜像**（加载/
  空/离线/连接中状态，刷新/管理/打开远程控制，会话点击打开远端 portal）；切回本机恢复
  原生列表。「添加主机」提供直接连接、粘贴配对链接、远程 SSH（标注计划中）。由于侧栏
  没有插件 slot，主机栏与远程镜像通过 ui-workspace 的区块头锚点插入（兼容发布版的
  `sectionHeader` class 回退）。
- 修复远程镜像在切主机约 1 秒后消失：rail 判断错误地测量了被隐藏的原生工作区头
  （0px），改为测量原生根节点；选中离线主机会先自动重连再加载工作区。
- 切换主机时主区域同步到 Devices 上下文：当前主机卡片显示状态、重连、刷新与打开
  远程控制，并提示是否已有远程控制 portal；远程镜像增加本地过滤、外链标识与
  “打开远程控制”说明。移除重复的底部入口，添加主机合并为一个扫码/粘贴对话框。
- 中继地址只需填写 IP 或域名（可带端口），自动规范化为 `wss://<host>/ws`；
  「使用 TLS」开关可显式关闭 TLS，用于连接只有明文 ws 的 paseo-relay（界面会警告，
  Host 记录该选择）。
- Devices 面板回归纯管理：移除重复的工作区区域，工作区只在左栏主机切换器下展示。
- 最终兜底改为直接 `window.open(portalUrl, '_blank', 'noopener,noreferrer')`：DSH
  桌面主窗口会把 `http:`/`https:` 交给 `shell.openExternal`；空窗口再改 location 会被拒绝。
- 桌面端在没有右侧栏 surface 且 `window.open` 被拒绝时，改由 Host 调用系统浏览器
  （`open`/`xdg-open`/`start`）打开；URL 必须与已打开的 portal 完全匹配。
- portal 在发送响应头前缓冲 HTML/JS/CSS/JSON 文本资源（`/plugins/`、`/assets/`），
  首屏资源传输中途遇到会话重连时整包重放，而不是把插件 bundle 截断（"Failed to
  load plugins" 的原因）。
- 中继配置拆成两层：中继地址用于出站控制，即使关闭「允许经中继控制本机」也生效；
  旧版保存中继总是启动本机 relay daemon，在共享 paseo-relay 上可能与远端 daemon
  互相顶掉，造成循环重连。
- portal 代理请求在会话重连时会等待新会话接管，并对幂等的 GET/HEAD/OPTIONS
  （以及 WebSocket upgrade）重试一次；首屏资源不再因正处于重连而报 `session closed`。
- 主控端在返回 portal URL 前先调用 `portal.prepare` 预热被控端 DSH 登录 cookie，
  避免首次加载的并行资源请求撞上冷 cookie 而出现"加载插件异常"（刷新才好）；
  E2E 增加冷加载无 4xx/5xx 断言。
- 修复中间栏 iframe 中的 `portal capability cookie is missing or invalid`：iframe
  仅在 Web 版启用（`dsh-app:` 父页面无法携带回环 cookie），桌面版改用系统浏览器；
  iframe 鉴权失败会向父页面 postMessage `auth-failed` 并回退到顶层窗口。
- daemon 在跨 Mesh/中继传输前对文本资源做 gzip 压缩，插件 bundle 约 7MB 降到约 2MB；
  portal 缓存压缩后的字节并转发 `Content-Encoding: gzip`。
- 不可变 GUI 资源（带 hash 的 `/assets`、`/locales`、`/fonts`，以及带 `rev=` 的
  `/plugins/` bundle）缓存到 `$DSH_HOME/device-mesh/portal-cache`。打开 portal 时先
  拉取远端 HTML 的资源清单并计算 build manifest hash；缓存 key = manifest hash + 资源
  URL。远端版本更新会改变清单 hash，整批旧缓存自动失效，不会混用两个版本。
- 应用层心跳改为非致命：RPC ping 丢失不再直接断开健康的中继隧道，transport close
  才是存活信号。此前的 ping-close 循环会截断 portal 资源并让远端 SPA 白屏；首屏慢时
  加载遮罩会给出提示，不再永久转圈。
- 进入远程主机时先清空本地工作区搜索再渲染远程列表；残留的搜索词会隐藏标题不匹配
  的远程工作区。
- 进入远程主机时绕过 60 秒 inventory 缓存并强制刷新工作区/会话列表，切走期间
  远端新建的会话不会在回来时缺失。
- 远程树高度现在按自身顶部到 shell footer 的实际可用空间计算，而不是用容器查询估算；
  最后几行不会再渲染到视口下方导致滚动也看不到。
- 远程树改用有明确高度上限的滚动容器并恢复原生 wheel 处理，长工作区列表现在可以
  完整滚动到底，不再只显示可视区域内的几行。
- 切换主机不再强制打开远程设备页：每个主机恢复上次的远程会话（按设备记忆），
  工作区行尾箭头打开该工作区最新的会话而不是远端首页；iframe 首次加载会用重试的
  postMessage 补发待打开会话，因此即使远端 shell 清掉 URL query，第一次点击也能
  落到目标会话。
- 远程主机侧栏现在按设备持久化工作区展开状态，高亮内嵌远端 shell 当前显示的会话
  （通过 postMessage 同步），把等待/运行/未读映射到行首状态点，并在远程模式下
  隐藏仅作用于本地注册表的「添加工作区/视图选项」。
- 远程主机侧栏改为复用官方 Workspaces 区块头和搜索，并用 shell 自己的行 class、
  文件夹/箭头图标和行操作渲染远程工作区/会话；切换主机后与本地列表观感一致，
  只有外部 ↗ 操作是远程专属。会话按工作区展开/收起。
- 再次打开同一远程工作区/会话会复用已打开的 portal 和 iframe；第二次点击只通过
  postMessage 切换远端会话，不再新开窗口、也不会重新加载 7MB 的远端 SPA。首次冷
  加载增加加载提示；远程工作区行补上与本地一致的文件夹图标。
- 远程控制在 Web 和桌面版都改为嵌入本地中间栏：portal cookie 使用
  SameSite=None/Secure，注入 embed 样式折叠远端侧栏，并通过 `?dm-session=`
  让远端插件选中点击的会话，视觉上等同本地对话栏。
- 桌面版远程控制会先挂载一个本地 Session surface，再在 DSH 右侧栏 Browser tab
  中打开 portal（webview guest 是顶层上下文，cookie 正常）；没有本地 Session/右侧栏
  时回退系统浏览器。
- 远程控制改为在**中间栏上方以 iframe** 打开被控端 GUI（参考 dsh-remote-workspace
  的设备工作区联邦模式），本地左栏保持可用；右侧栏/系统浏览器/弹窗作为回退。
- 修复点击远程工作区/会话无法打开远程控制：窗口在点击手势内预打开，跨站弹窗改为返回
  同源 bootstrap 页面（避免 303 + SameSite=Strict cookie 被浏览器丢弃）；现在点击会
  真正打开远端 DSH UI。
- 网格短暂断开后，已打开的 portal 会存活并把新会话交给原 portal，同一个远程控制
  标签页可自动恢复。
- 远程控制优先复用右侧栏；否则复用一个浏览器窗口。portal WebSocket 增加服务端
  keepalive ping，避免空闲的远程控制页被断开。
- 侧栏更容易找到远程工作区：「远程设备」面板把「远程工作区」区放到最上方并显示总数；
  面板图标与底部入口显示在线远程设备数。
- 文档全量双语化：所有文档都提供简体中文版本和语言切换，中文文档中的链接指向对应中文版本。
- 公开文档集：一份英文用户 README、一份结构相同的中文 README、一个文档索引、贡献指南、安全政策和本变更日志。
- 维护者文档：一份开发指南（[`docs/zh/development.zh.md`](docs/zh/development.zh.md)），涵盖打包、本地回路、DSH 集成与发布；以及关于远程控制架构的 [ADR 0001](docs/zh/adr/0001-remote-control-in-dsh.zh.md)。它们取代了开发阶段的研究笔记。

### 安全（Security）

- 配对票据在控制器拨号前会校验每个端点 URL：只允许 `ws://`/`wss://`、拒绝内嵌凭据、
  限制长度，且非回环 relay 必须使用 `wss://`。恶意配对链接不能再把控制器指向任意本机
  或明文端点。
- 回环 portal 限制并发连接数与慢客户端/慢请求头超时；直连监听器的每地址限速表设置了
  上限，IPv6 地址轮换无法让表无限增长。
- 记录了威胁模型、密钥与配对码处理、漏洞报告流程以及部署加固清单。
- 最小权限落地：`view` 授权只读、workspace 白名单会过滤 `workspaces.list`、portal
  只允许不受限的 `control` 授权；受限 scope 在批准时直接拒绝，不再被静默放大。
- 撤销、忘记与授权过期现在会关闭已建立的入站会话及其 portal WebSocket（30 秒授权
  清扫周期内）；首次配对被拒绝或超时会移除刚钉扎的 peer，且不再自动重连。
- portal 加固：精确 `Host`、同源/顶层导航检查、WebSocket 升级必须携带 portal
  `Origin`，能力令牌从所有转发 path 中剥离；本机其他回环端口无法借用已打开 portal
  的 cookie。
- portal WebSocket 保留 text/binary opcode，DSH 只接受 text 的 Remote stream 可正常
  工作；超过 64 KiB 的控制结果返回 `mesh/busy` 而不是超时；WS 分片组装有 8 MiB
  上限。
- 公网 relay 必须使用 `wss://`；入站会话上限 64（每 controller 8）；配对竞态
  （批准/拒绝、并发连接、forget/revoke 期间的在途连接）具有确定终态。
- 配对令牌存储改为跨进程锁内的读-改-写：两个共享 `$DSH_HOME` 的 DSH 进程不会再
  复活已消费的令牌，也不会删除对方的票据。
- 静默对端在 10 秒内（首帧超时）被关闭，不再占用完整的 60 秒认证窗口。
- 加固直连监听与审计：单 IP 每分钟最多 60 次 upgrade 尝试（超出 429），入站认证失败
  会写入只含原因码的 `auth.failed` 审计；远程侧栏镜像在 2.5 秒状态轮询间保持滚动位置，
  并在折叠 rail 中隐藏。
- 配对时每个端点有 8 秒拨号预算，不可达的地址不会耗尽整个审批窗口；Linux 热点/
  AP 网卡（`ap0`）等虚拟接口会从配对码中过滤。

### 测试（Tests）

- 新增 Oxlint（与 DSH 上游同族）与项目配置；`npm run lint` 已纳入 CI 与发布门槛，
  并启用 DSH 的 `@stylistic` 格式规则（2 空格缩进、无分号、单引号、多行尾逗号、
  140 列），可通过 `npm run lint:fix` 自动修复。import 卫生也已启用：顶层
  `import type`、不重复导入同一模块（声明排序不属于 DSH lint 契约）。

- 新增真实浏览器 UI E2E：无头 Chrome 打开 portal 并启动被控端真实 DSH UI，包括其要求
  text 帧的 Remote stream WebSocket（`npm run test:ui`；无 Chrome 时 skip）。
- 新增 `RELEASE.md` / `RELEASE.zh.md` 与 `npm run release:check` 发布门槛：自动化检查
  加人工验证矩阵。

### 修复（Fixed）

- 第三轮 Review 完善：明确 Fetch Metadata 浏览器支持矩阵（Chromium 88+ / Firefox 90+ /
  Safari 16.4+）；单端点配对连接预算覆盖 60 秒认证窗口；relay TLS 开关根据已保存
  endpoint 初始化；缓存软上限与内联 embed 注入的 CSP 限制写入文档。
- 低优先级完善：Devices 面板也会提示远程工作区列表被截断；身份重新生成写入
  `identity.regenerated` 审计；显式 relay scheme 会同步 TLS 开关；资源清单取消等待
  有上限；配对连接与审批等待拆成独立常量。
- portal 的 cookie 认证 HTTP 请求现在必须提供 `Sec-Fetch-Site`（`same-origin` 或
  `none`）；缺少该头一律拒绝，堵住没有 Fetch Metadata 的浏览器/iframe 缺口。portal
  缓存淘汰改为批量扫描而非每次写入扫描；远端主动关闭 WebSocket 的路径补充回归测试。
- portal WebSocket 在正常关闭时回收两侧 stream 记录，不再每次关标签页泄漏一条流、
  也不会在 32 条流后触发 `mesh/busy`（H1）。
- 工作区列表限制为 100 个工作区 / 200 个会话 / 60 KiB，并在裁剪时携带 `truncated`，
  大用量用户不再因 `RPC result too large` 失败（H2）。
- 配对票据只在本机开启 relay 服务时广播 relay 端点；没有缓存端点的 peer 必须重新
  配对，不再用本机自己的 relay `serverId` 兜底（H3）。
- controller 会话关闭时自动拒绝其待批准配对请求；controller 的等待窗口长于 daemon
  的请求 TTL（S4）。
- portal 加固：`?dm-session=` 做 HTML/script 转义，资源清单读取限制 4 MiB / 5 秒，
  代理响应加 `nosniff`，daemon 剥离整个 DSH 自有的 `x-dsh-*` 头命名空间；paired
  认证拒绝 pair-token 消息，relay 连接错误对 `serverId` 脱敏。
- 正确性与卫生：store 复用 `crypto.ts` 并校验身份密钥对；客户端归一化 `sas`；侧栏
  镜像 signature 跟踪 session 状态；relay 输入框不再破坏 `https://`；去除重复的
  `portal.closed` 审计；portal 资源缓存增加磁盘预算；清理死代码与未用字段。
- 文档与实现对齐（中英文）：`SameSite=None; Secure` portal cookie、应用层心跳为
  advisory、已实现尽力而为深链、Devices 面板仅负责管理、`view` 预留、relay 票据
  规则、工作区上限与配对等待窗口。

## 0.0.1 - 2026-11-09

首个 MVP 版本，已针对 DSH `0.2.2-rc.1` 验证。

### 新增（Added）

- 对称的 DSH 设备网格插件：每次安装都同时包含 host 插件和 Web client 插件，每台设备都可以充当 daemon 或主控端。
- 设备面板，包含本地/远程分区、配对二维码和 `dsh-mesh://pair?d=…` 链接、主控端的添加/扫码/粘贴流程、带 6 位 SAS 的待批准配对请求、已配对设备状态、带**远程**徽标的远程工作区分组，以及 portal 打开/关闭操作。
- 局域网和 Tailscale 网络上的 WebSocket 直连传输，包含插件自己的监听器（默认 TCP `45871`）以及嵌入配对凭证的可达端点。
- 通过 paseo-relay v2 的公网传输（一条 control socket，每个主控端一条 data socket），并为旧版 relay 提供 v1 回退。
- `Noise_NK_25519_ChaChaPoly_SHA256` 端到端加密网格会话（prologue 为 `dsh-mesh/1`），包含设备公钥钉扎和应用层认证。
- 一次性配对凭证，TTL 为 10 分钟，由 daemon 身份密钥签名。令牌在首次出示时即预留并从磁盘移除，发生在本地批准之前；请求被拒绝或弹窗丢失时需要重新生成链接。
- 逐设备授权与撤销，以及配对、连接、撤销和 portal 事件的审计日志。
- 主控端一侧的回环 portal，经加密网格反向代理 daemon 的完整 DSH Web UI；以及 daemon 一侧的代理，把 DSH 浏览器 cookie 保留在内存中。
- DSH Connection 服务上的本地 `POST /api/device-mesh` 路由。
- 英文和中文 client 字典。

### 安全（Security）

- 直连和中继传输均启用端到端加密；中继只转发不透明帧。
- 配对需要一次性令牌、显式本机批准和匹配的 SAS；默认关闭静默配对。
- 设备身份密钥保存在 `$DSH_HOME/device-mesh/identity.json`，权限为 `0600`；私钥、令牌和会话哈希永不写入日志。
- portal 在操作系统分配的端口上绑定 `127.0.0.1`，并要求用 32 字节能力令牌换取 `HttpOnly; SameSite=None; Secure` cookie。
- 撤销会断开活动会话并拒绝后续握手。

### 测试（Tests）

- Core 套件覆盖 Noise NK/NKpsk0 官方测试向量、握手与认证失败路径、RPC/流多路复用、存储损坏恢复、配对签名/过期/重放规则，以及 portal 认证与转发。
- Transport 套件覆盖直连往返、限制和 Origin 检查，以及针对真实 relay 二进制和 mock relay 的 paseo-relay v1/v2 行为。
- 端到端套件使用真实 `dsh web` 实例：插件加载与 client bundle 出现在启动图中、两台设备通过 SAS 批准和 portal 完成直连配对，以及在关闭直连监听的情况下完成仅中继的配对/portal 运行。
