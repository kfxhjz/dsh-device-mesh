# DSH Device Mesh —— 架构与安全设计

[English](../DESIGN.md) | 简体中文

状态：**MVP**（插件 `0.0.1`，面向 DSH `0.2.2-rc.1`）。线路契约以
[PROTOCOL.zh.md](PROTOCOL.zh.md) 为准；本文解释为什么这样设计、边界在哪里、后续
怎么走。

## 目录

1. [目标与非目标](#1-目标与非目标)
2. [总体架构](#2-总体架构)
3. [传输矩阵](#3-传输矩阵)
4. [配对流程](#4-配对流程)
5. [portal 原理](#5-portal-原理)
6. [数据与持久化](#6-数据与持久化)
7. [安全模型与威胁](#7-安全模型与威胁)
8. [DSH 集成点](#8-dsh-集成点)
9. [平台矩阵](#9-平台矩阵)
10. [测试策略](#10-测试策略)
11. [路线图与风险](#11-路线图与风险)

## 1. 目标与非目标

把多台运行 DeepSeek Harness 的设备连成一个**设备网格**：配对一次之后，任何一台
已配对设备都可以作为**主控端（controller）**，远程查看并操作另一台设备（**被控端
daemon**）的 DSH。

| 目标 | 设计回应 |
|---|---|
| A/B/C/D 之间任意授权方向 | 同一个对称插件包；角色由「谁发起连接」决定，不绑定平台。 |
| 内网/Tailscale 与公网 | direct 与 relay 两种可替换传输，之上是同一套端到端加密会话。 |
| 扫码配对 | 带签名的一次性二维码/链接，加本机确认与六位 SAS。 |
| 安全性对齐 Paseo 远程控制 | Noise NK、公钥钉扎、一次性令牌、逐设备授权、撤销与审计。 |
| 本地/远程清晰区分 | 在原生「工作区」区块正上方注入主机切换器，直接显示当前主机名，点击列出本机与已配对主机及添加主机，Devices 面板跟随所选主机并显示当前主机卡片。远程行带「远程」徽标并打开远程控制。添加主机是一个扫码/粘贴配对对话框。 |

v1 的非目标：文件/剪贴板同步、屏幕串流、多跳中继、与 Paseo 原生协议互通，以及
原生移动端 App。远程控制止于 portal 中的远端 DSH Web UI，而不是在 controller
里再挂一棵 DSH client 树。

## 2. 总体架构

每台设备安装同一个插件包，包内两半：**host 插件**作为受信任的同进程 Node 代码运行
在 DSH 宿主内；**client 插件**运行在浏览器中，只通过同源本地 API 与自己的 host
通信。

```
                         ┌──────────── DSH 宿主进程（A/B/C）────────────┐
  浏览器（本机 DSH UI）  │ host 插件 dsh-device-mesh                   │
  ┌──────────────────┐   │ ├─ identity / peers / audit（$DSH_HOME）     │
  │ client 插件       │──▶│ ├─ broker（连接管理/配对/状态）              │
  │ • 设备面板        │API│ ├─ direct listener ws://0.0.0.0:45871/mesh  │
  │ • 配对二维码      │   │ ├─ relay daemon     wss://relay（出站）      │
  │ • 远程工作区分组  │   │ ├─ controller sessions（Noise）             │
  │ • 打开远程控制    │   │ ├─ portal-controller 127.0.0.1:<随机端口>    │
  └──────────────────┘   │ └─ portal-daemon → 本机 DSH Web（127.0.0.1） │
                         └─────────────────────────────────────────────┘
                                         ▲
                         Noise NK + 应用层认证（端到端）
                                         ▼
                          另一台设备上的同一插件（对称）
```

组件职责：

- **Store/Pairing**：管理 `identity.json`、`peers.json`、`settings.json`、哈希后的
  一次性令牌、审计记录，以及本机批准队列与 SAS。
- **Broker**：组合根——启动监听与 relay daemon，接受入站通道，拨号 controller，
  维护设备状态，提供本地 API，并管理 portal 生命周期。
- **Channel/Session**：Noise、应用认证、RPC 与流多路复用；**Transport** 在 direct
  或 paseo-relay v2/v1 socket 上实现同一 `MeshTransport` 接缝。
- **Portal daemon/controller**：反向代理的两半；**Web API** 暴露
  `POST /api/device-mesh`，**client 插件**渲染左栏主机切换器、设备面板、配对 UI 与按主机的远程工作区分组。

三个关键事实：

1. DSH 客户端是**单 host** 模型：`ctx.connection`、`ctx.sessions`、`ctx.workspaces`
   都是单例，前端没有多 host 或深链能力。插件不试图在浏览器里装第二棵 DSH client
   树；它通过 Mesh RPC 拉取**元数据**（工作区/会话/状态）在自己的面板渲染，**完整
   远程操作**则由 portal 反向代理远端 DSH Web UI 提供。
2. host 插件是受信任的同进程 Node 代码：可以监听端口、出站 WebSocket、读写
   `$DSH_HOME`，并使用 `ctx.webServer`/`ctx.connection`。桌面版 DSH 只绑
   `127.0.0.1`，所以 daemon 必须由插件自己开监听/出站。
3. client 插件不是网络对端：它看不到 peer 私钥或令牌，只调用本机经过 cookie 认证的
   本地 API。

## 3. 传输矩阵

| 场景 | 传输 | 说明 |
|---|---|---|
| 同内网 / Tailscale | direct：插件自己的 `ws://<ip>:45871/mesh` | 不依赖 DSH Web 端口；票据优先写内网地址，然后 `100.64/10`，再全局 IPv4/IPv6；拒绝浏览器 `Origin`；端口可配、可禁用。 |
| 公网 | relay：paseo-relay v2 | daemon 出站 control socket + 每 controller 一条 data socket；controller 出站一条 client socket；relay 只转发不透明密文。 |
| 旧版 relay | relay v1 | 一个 `serverId` 只服务一个 client；同角色新连接替换旧连接。仅当票据声明 v1 时使用。 |

两种传输都在同一 Noise 通道之下，因此会话层、RPC、工作区元数据与 portal 完全与
传输无关。relay 模式下 daemon 不需要任何公网入站端口。

controller 按票据顺序选择端点，成功后把该端点提升到缓存首位。direct 心跳 20 秒，
relay 心跳 10 秒；controller 会话每 30 秒做一次应用层健康检查，错过 pong 只记录
日志——真正的存活信号是传输层 close 事件（direct/relay 的 WebSocket 心跳会先终止
死连接）。重连退避 1 秒到 30 秒。票据只在本机开启 relay 服务时广播 relay 端点；
仅用于出站控制的端点不会进入票据，缺少缓存端点的 daemon 必须重新配对，绝不用本机
自己的 `serverId` 兜底。

## 4. 配对流程

```
被控端 A                                      主控端 C / D
Devices 面板 → 生成配对码                     Devices 面板 → 添加设备
┌──────────────────────┐   二维码/链接       ┌──────────────────────┐
│ dsh-mesh://pair?d=…  │ ─────────────────▶ │ 扫码或粘贴链接        │
│ 一次性 token，10 分钟 │   带外信道          │ 验签 + 钉扎公钥      │
└──────────────────────┘                     └──────────┬───────────┘
        ▲                                                │ Noise + token
        │        本机弹窗：C 请求配对                    ▼
        │        SAS 123-456   允许/拒绝 ◀── Mesh 会话
        └────────────────────────────────────────────────┘
```

1. daemon 生成并签名票据，内容包含 Ed25519/X25519 公钥、可达端点、一次性令牌与
   过期时间，以及仅在本机开启 relay 服务时才有的 relay 路由；磁盘只保存令牌哈希，并在弹出确认前预留/移除。
2. controller 扫码或粘贴链接，用票据中的 `signPk` 验签，校验 `deviceId` 与过期
   时间，并钉扎 daemon 公钥。
3. controller 依次尝试端点，完成 Noise NK，在加密通道内发送携带一次性令牌的
   `client_auth`。
4. daemon 校验令牌，弹出本机确认（显示 controller 名称、平台与 SAS），回复
   `approval: "pending"`；用户决定前 controller 只能轮询 `pair.status`。
5. 批准后 daemon 持久化 controller 公钥与 scope；拒绝或超时则关闭会话。后续连接
   使用 Ed25519 `paired` 认证，不再需要令牌。
6. 对端公钥变化视为身份变化，必须先 forget 再重新配对；撤销对在线会话和新握手立即
   生效。controller 会话在本机决定前关闭时，待批准请求会被拒绝；controller 的等待
   窗口长于 daemon 的 5 分钟请求 TTL，避免 daemon 仍可批准时 controller 已回滚。

SAS 由 Noise 握手哈希与双方 Ed25519 公钥派生，两端一致且与角色无关。它认证的是
「人做的决定」，而不是网络路径。

## 5. portal 原理

portal 回答的是「不重写 DSH，如何获得完整远程控制」：controller 浏览器通过 Mesh
承载的回环反向代理，直接加载**远端 DSH Web UI**，而不是在本地重做聊天、审批、终端
与文件界面。

```
controller 浏览器 ── HTTP/WS ──▶ 127.0.0.1:<portalPort>（controller 插件）
                                       │ Mesh 会话（Noise）
                                       ▼
                              daemon 插件 ── HTTP/WS ──▶ 127.0.0.1:<dshWebPort>
```

controller 侧：

- 只绑 `127.0.0.1`，端口由 OS 分配；URL 中带 32 字节能力令牌。首次导航用令牌换
  `HttpOnly; SameSite=None; Secure`、按 portal 实例命名的 cookie（回环是安全上下文，
  桌面版 iframe 是跨站）。
- 只转发普通 HTTP 方法与 WebSocket 升级；限制 body/流/空闲时间；剥离浏览器请求中的
  凭据、hop-by-hop 与转发头。
- 剥离远端响应的 `Set-Cookie`、`X-Frame-Options` 与 CSP `frame-ancestors`，让本机
  页面可以 iframe 嵌入；同源绝对重定向改写为路径相对地址。带 cookie 的 HTTP 请求
  必须提供 `Sec-Fetch-Site: same-origin` 或 `none`，缺失即拒绝（要求 Fetch
  Metadata）。

daemon 侧：

- 通过 `ctx.webServer.getOrigin()` 取本机 DSH origin，通过
  `ctx.connection.authenticatedUrl(origin)` 取浏览器会话；手动跟随 `303`，以看到
  `dsh-auth-*` cookie。
- cookie 只在内存中，接近过期或遇到 `401` 时刷新，永不跨 Mesh 传输；controller
  浏览器只持有 portal 自己的 cookie。
- 向本机 origin 代理 HTTP/WS 时，把 `Host`、`Origin`、`Referer`、`Sec-Fetch-Site`
  归一化到本地 authority，以满足 DSH 的同源 `/api` 围栏；响应丢弃
  `Content-Encoding`/`Content-Length`，因为 body 已解码后重新流式发送。

portal 属于 `control` scope；`view` 预留且审批时拒绝。iframe 携带
`?dm-session=<id>&dm-embed=1`：portal 保存 id，远端这份插件在 shell 就绪后通过
`uiWorkspace.openSession` 打开对应会话；这是尽力而为，DSH UI 变化或远端 CSP 禁止注入的内联 script/style 时
回退到远端首页。

## 6. 数据与持久化

`$DSH_HOME/device-mesh/`：

| 文件 | 内容 |
|---|---|
| `identity.json`（0600） | 设备 id、名称、平台、Ed25519/X25519 密钥对。 |
| `peers.json`（0600） | 已配对 controllers/daemons、scope、撤销时间、端点缓存与 relay `serverId`。 |
| `settings.json`（0600） | direct 开关/端口、relay endpoint/TLS/开关、portal 空闲超时、自动批准（默认 false）。 |
| `pairing.json`（0600） | 仅未使用的一次性令牌哈希与过期时间。 |
| `audit.jsonl`（0600） | 追加配对、连接、撤销、portal 事件；8 MiB 轮转为 `audit.jsonl.1`。 |
| `.state.lock`（0600） | 跨进程写锁，支持陈旧锁恢复。 |

所有写入都是原子的：同目录临时文件、请求 `fsync`、以 `0600` rename 到位；目录为
`0700`。损坏或非法的 JSON 会改名为 `<file>.corrupt-<timestamp>` 并用默认值重建，
不会阻塞启动。多个共享同一 `$DSH_HOME` 的 DSH 进程通过锁串行化写入，并在修改前
重新读取磁盘状态。

运行态包括待批准配对请求、在线 controller 会话、portal 实例与能力令牌、远程工作区
缓存，以及 daemon 的 DSH 浏览器 cookie。除重启需要的一次性令牌哈希外，这些都不落盘。

## 7. 安全模型与威胁

信任边界：

- DSH 宿主进程及其插件是受信任的；宿主被攻破即可读 `$DSH_HOME` 并冒充设备。
- relay 与网络不可信。relay 能看到路由元数据（`serverId`、connection id）、帧时序
  与大小，但看不到明文。
- controller 浏览器只被信任持有自己的 portal cookie；它看不到 peer 私钥或 daemon
  的 DSH cookie。
- 已配对 controller 对 daemon 的 DSH 是 **owner 级**的，因为 portal 就是 daemon
  自己的 owner UI。只与信任的设备和人员配对。

| 威胁 | 对策 |
|---|---|
| 公网中间人 | Noise NK + 钉扎 daemon X25519 公钥；Ed25519 应用层签名；relay 只转发密文。 |
| 二维码泄露 | 一次性令牌、10 分钟 TTL、只存哈希、本机确认、SAS；首次使用后令牌失效。 |
| 重放/乱序/篡改 | Noise CipherState 单调 nonce；AEAD 失败立即关闭；client nonce 10 分钟重放缓存。 |
| 伪装的 controller | 只接受已钉扎 controller 签名；首次配对必须本机显式批准。 |
| 设备丢失/撤销 | `revokedAt` 拒绝新握手，每次 RPC 复检，撤销/忘记会立即关闭在线会话；授权在工作区会话存续期间过期的，由 30 秒清扫关闭；可轮换密钥与 `serverId`。 |
| 本机其它进程访问 portal | 仅回环绑定、随机端口、32 字节能力令牌、`HttpOnly; SameSite=None; Secure` cookie、精确 `Host`/`Origin`/`Sec-Fetch-Site` 围栏（缺少 Fetch Metadata 的 cookie 请求被拒绝）；不记录 token/cookie。用户访问的其他本机 HTTP 服务仍可在服务端读到按 host 共享的 cookie。 |
| 凭据外泄 | DSH cookie 只在内存；私钥、令牌、nonce、握手哈希不写日志/审计；状态文件 `0600`。 |
| 资源滥用 | 连接/流/body/头上限、64 条入站会话（每 controller 8 条）、待批准队列上限、心跳与空闲超时、审计轮转。 |
| relay 运营方或 `serverId` 窃取者 | 加密阻止读取与伪造；残余风险是拒绝服务与会话替换，协议层无法在 relay 侧消除。 |

残余风险：relay 的流量分析；恶意已配对 controller 拥有 owner 级 portal 权限；远端 UI
运行在 portal 的回环源中，可访问其他回环服务（DSH 的 `/api` Origin 围栏会阻止 DSH
API，其他本地服务未必有同等防护）；用户访问的本机 HTTP 服务可以读到按 host 共享的
portal cookie；任一端的本机恶意软件不在威胁模型内；DSH 升级可能改变 cookie/认证
行为，需要逐版本复验。
本设计不试图隐藏「两台设备正在通过 relay 通信」这一事实。授权过期在每次 RPC 和每
30 秒一次的授权清扫中生效，因此已打开的会话最多可在 `expiresAt` 之后继续存在 30 秒；
需要立即终止时请撤销或忘记设备。

## 8. DSH 集成点

### 8.1 Cordis host 插件

插件是标准 DSH 第三方 bundle。`cordis.patch.yml` 只插入一个 Loader row；
`package.json` 声明 `dsh.bundle.patch`、`dsh.client.platform: "web"` 与
`exports["./client"]`。host 入口为 `apply(ctx, rawConfig)`，注入
`['webServer', 'connection']`，并通过 `ctx.effect` 注册清理，使监听、会话、portal
与定时器随插件停止。

两个关键 DSH 接缝：

- **本地浏览器 API**：`ctx.connection.fetch.register({ path:
  '/api/device-mesh', methods: ['POST'], requestBody: 'buffered', fetch })` 把
  handler 挂到 DSH 经 cookie 认证的同源 `/api` 通道；没有 DSH owner 会话就到不了
  handler。
- **本机 Web 认证**：`ctx.webServer.getOrigin()` 给出本机 DSH origin；
  `ctx.connection.authenticatedUrl(origin)` 返回会设置 `dsh-auth-*` cookie 的登录
  URL。portal daemon 手动跟随重定向并只在内存保存 cookie。

工作区元数据来自 `ctx.workspaceRegistry`、`ctx.sessions`、`ctx.sessionTitle`、
`ctx.agents`，全部防御式访问：服务缺失时返回保守结果，而不是让插件激活失败。若
`ctx.connection.fetch` 不存在，Mesh 运行时仍启动，但浏览器 API 关闭。

### 8.2 client 插件与 UI

浏览器 bundle 以 `window.__ModuleLoader__.load({ id: 'dsh-device-mesh', factory })`
包装，只拿到 DSH client 上下文。它注册：

- keyed `main` 设备主面板；
- 带待批准角标的 `sidebar.panellist` 入口；
- 用于待批准配对的 `shell.overlay`。

面板在可见时每 2.5 秒轮询 `POST /api/device-mesh`（`{ endpoint, payload }`），
只承担管理职责：本机、配对二维码/链接、已配对设备状态与待批准请求；工作区不再在
面板重复展示，统一由左栏主机切换器下的工作区区域呈现。打开远程控制时，在官方中间栏
上方挂载 **iframe**（`data-device-mesh-remote-pane`）并指向回环 portal；这是
`dsh-remote-workspace` 采用的设备工作区联邦模式：被控端渲染真实 GUI，本地左栏保持可用，
不需要第二个窗口或第二份凭据。iframe 按中间栏的 bounding box 固定，不会盖住左栏。
回退顺序：有 session surface 时用 `sidebarRight.openTab('browser', …)`；桌面 Host 用系统
opener（`open`/`xdg-open`/`start`）；纯 Web 用可复用窗口 + portal 同源 bootstrap；最后
直接 `window.open(portalUrl, '_blank', 'noopener,noreferrer')`，由 DSH 桌面主窗口转给
`shell.openExternal`。原桌面壳在面板打开时没有右侧栏
surface，因此 Host 用系统浏览器（`open`/`xdg-open`/`start`）打开能力 URL；纯 Web 则
回退到一个可复用窗口，并通过 portal 的同源 bootstrap 完成 cookie 建立。

### 8.3 本地 / 远程工作区

DSH 原生 `sidebar.workspaces` 是被 `ui-workspace` 独占的 single 槽，工作区行没有
第三方 slot，插件无法在不替换整棵树的情况下向原生列表注入远程行。

- **MVP（零上游改动）**：左栏「工作区」上方的**主机切换器**显示当前主机，下拉列出本机、
  已配对主机及实时状态。选中远程主机时：原生工作区浏览器被隐藏（`dm-remote-mode`），
  同一区域渲染**只读远程镜像**——主机名、状态、刷新/管理/打开远程控制，以及该主机的
  工作区与会话；点击任意一项打开该设备的 portal。加载、空、离线、连接中、错误均有明确
  状态；切回本机立即恢复原生列表。远程行绝不伪装成本地行。Devices 面板仍负责配对与
  管理。**添加主机**对齐 Paseo：直接连接、粘贴配对链接、远程 SSH（在 SSH 传输实现前
  标注计划中）。
- **上游边界（Phase 2）**：最终形态是在 `ui-workspace` 增加一个
  `sidebar.workspace.row.trailing` 槽（约 30 行），让插件在原生工作区行上渲染设备
  徽标；届时两种 scope 都可使用原生树。明确不采用整块替换 `sidebar.workspaces`：
  那会复制核心渲染并在 DSH 升级时频繁崩坏。

这条边界是有意为之：MVP 不碰 DSH 就能完整工作，上游 patch 只是渲染增强，不是协议
依赖。

## 9. 平台矩阵

| 能力 | A：Linux 桌面 | B：Linux 服务端（`dsh web --no-open`） | C：macOS 桌面 | D：移动端（未来：Android / iOS / 鸿蒙） |
|---|---|---|---|---|
| host 插件 / daemon | ✅ | ✅ | ✅ | 计划中 / 未实现。协议已平台无关，但目前没有移动端构建。 |
| controller | ✅ | ✅ | ✅ | 计划中 / 未实现。目标是 Web UI/WebView；相机权限与粘贴链接兜底尚未验证。 |
| 直连监听 | ✅（插件端口，可能需防火墙放行） | ✅ | ✅ | 计划中 / 未实现。 |
| relay | ✅ | ✅ | ✅ | 计划中 / 未实现。 |
| 展示配对二维码（daemon） | ✅ | ✅ | ✅ | 计划中 / 未实现。 |
| 扫码（controller） | Chromium 的 `BarcodeDetector` | 同左 | 同左 | 计划中 / 未实现；`BarcodeDetector`/WebView 行为未验证。 |
| 生产建议 | 仅内网/Tailscale，或开 relay 后关直连 | 常用 relay | 同 A | 不适用（没有移动端构建）。 |

portal 的 cookie 认证要求浏览器提供 Fetch Metadata（`Sec-Fetch-Site`）：支持
Chromium 88+、Firefox 90+、Safari 16.4+（以及 Electron 外壳）。更旧的浏览器仍可
配对和管理设备，但无法打开远程 UI。

配对按**设备身份**而不是设备类别：任意两台设备都可以双向配对，包括同类设备之间
（B ↔ B′、C ↔ C′）。桌面版 A/C 仍需手动目视验证 Electron 窗口内的
`window.open`/右侧栏 Browser 行为；协议与 host 行为本身与平台无关。

## 10. 测试策略

- **核心密码学/通道**：与官方 noise-c `NK`/`NKpsk0` 测试向量逐字节比对；负向测试
  覆盖篡改、重放、乱序、截断、超大帧、错误钉扎公钥、重复 nonce、错误应用签名与
  认证超时。
- **会话与流**：RPC 关联/超时、流多路复用、背压、并发流上限、abort/end 语义、
  WebSocket 消息边界与协议违规。
- **传输**：direct 的 Origin 拒绝、连接限制、URL 枚举与心跳；relay 使用 mock 与
  真实 paseo-relay 二进制，覆盖 v2 control/data、多 client、v1 替换语义与关闭码。
- **host 状态与策略**：store 原子写、损坏恢复、跨进程锁、配对验签/一次性/过期、
  撤销、工作区映射、portal 头处理与认证。
- **client**：静态检查 bundle 是否注册预期 slot，以及在无真实 host 时能否渲染。
- **端到端**：三个场景运行在真实隔离的 `dsh web` 实例上——插件加载与
  `/api/device-mesh`；双设备配对、SAS 批准、远程工作区与 portal 返回远端 DSH
  shell；以及禁用 direct、强制走真实 paseo-relay 的同一流程（二进制缺失时 skip）。
  MVP 提交时 `npm test` 覆盖 170 项，三个 E2E 全部通过。

已知空白：桌面窗口/真机扫码需人工验证，移动端（Android / iOS / 鸿蒙）构建与 portal 深链未覆盖。E2E 证明的是
协议路径，不是 DSH 的每一个 UI 表面。

## 11. 路线图与风险

1. **原生 RPC 控制（Phase 2）**：在本地 UI 内列远端会话、发 prompt、停止运行、中继
   审批、attach 终端，方案见 [ADR 0001](adr/0001-remote-control-in-dsh.zh.md)。日常
   操作不再必须开 portal，但完整保真仍保留 portal。
2. **上游工作区徽标**：在 `ui-workspace` 增加 `sidebar.workspace.row.trailing` 槽，
   在原生行上渲染设备/「远程」徽标，不替换整棵树。
3. **移动端**：官方插件模型确定后，在 Android / iOS / 鸿蒙上复用协议与 client bundle；
   相机权限、后台保活与移动布局单独适配。
4. **portal 保真**：上游支持 DSH 深链后接入；继续按 DSH 版本复验 cookie/认证行为。
5. **运维加固**：轮换密钥与 `serverId`，增加显式准入限速，在不破坏不透明帧的前提下
   改善 relay 侧可观测性。

风险：DSH 的 slot/服务契约会演进（MVP 基线 `0.2.2-rc.1`）；portal 认证需随 DSH
版本复验；relay 仍是元数据/拒绝服务的信任点。若 portal 认证不可用，远程控制即不可用；
MVP 没有仅原生 RPC 的降级路径，原生 RPC 控制属于第二阶段。

已知限制：授权在工作区会话存续期间过期时，已打开的会话会继续可用，直到下一次 30 秒
授权清扫。需要立即终止时请撤销或忘记设备。

## 相关文档（Related docs）

- [README](../../README.zh.md) —— 安装、配对与使用。
- [CONTRIBUTING](../../CONTRIBUTING.zh.md) —— 贡献流程与评审约定。
- [SECURITY](../../SECURITY.zh.md) —— 漏洞报告与披露政策。
- [协议文档](PROTOCOL.zh.md) —— 线路格式、RPC 与 portal 规则。
- [开发指南](development.zh.md) —— 构建、打包、DSH 集成点、测试与发布。
- [ADR 0001](adr/0001-remote-control-in-dsh.zh.md) —— 为何完整远程控制采用 host 侧 Mesh 加本机 loopback portal。
- [文档索引](../README.zh.md) —— 完整文档地图。
