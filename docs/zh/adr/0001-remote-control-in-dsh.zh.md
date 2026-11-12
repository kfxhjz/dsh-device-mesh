# ADR 0001：通过 host 侧 Mesh 与回环 portal 在 DSH 中实现远程控制
[English](../../adr/0001-remote-control-in-dsh.md) | 简体中文

- **状态：** 已接受 · **日期：** 2026-11-09 · **范围：** 插件 `0.0.1`，DSH `0.2.2-rc.1`

## 背景

项目必须让一套 DSH 安装能够操作另一套：列出工作区与会话、打开对话、回答审批、使用
终端与文件，并进入设置，同时清晰区分本地与远程 scope。

1. **DSH 客户端是单 host 的。** `ctx.connection`、`ctx.sessions` 与 `ctx.workspaces`
   都是一棵 Cordis 树中的单例；一个文档绑定一个 host。没有多 host 切换，也没有指向
   远程工作区或会话的 URL 深链。
2. **集成面是第三方 bundle。** 产品以普通 DSH 插件交付（host 入口、
   `__ModuleLoader__` 浏览器入口和一行 `cordis.patch.yml`）。它不能 patch DSH 核心，
   必须同时运行在桌面版 DSH 与 `dsh web --no-open` 上。
3. **需求是完整远程控制。** 只读会话列表不够；审批、终端、文件与设置都属于功能的一
   部分。用 RPC 重新实现它们意味着写第二套 DSH 客户端。

DSH 提供了 broker 原语（受信任的 Node 运行时、`ctx.webServer`、`ctx.connection`、
远程访问策略）；问题在于数据面/UI 边界划在哪里。早期研究笔记已并入本 ADR 与
[开发指南](../development.zh.md)。

## 决策

用两个可分离的平面构建该功能。

**1. 数据面：由 host 插件拥有的对称设备 Mesh。** 每个安装都交付同一个插件。daemon
通过直连 WebSocket 或 paseo-relay 接受已配对 controller；通道为
`Noise_NK_25519_ChaChaPoly_SHA256`，带钉扎密钥、应用层认证和自定义 RPC/流多路复用。
配对使用带签名的一次性票据与本机 SAS 批准；host 拥有身份、授权、撤销、审计与元数据
（[协议文档](../PROTOCOL.zh.md)）。

**2. UI 平面：完整的远程 DSH Web UI，位于 controller 本机的回环 portal 之后。**
controller 在 `127.0.0.1:<随机端口>` 上启动反向代理；浏览器标签页通过它加载 daemon
自己的 DSH Web UI，HTTP/WS 都在 Mesh 会话内传输。daemon 向上游注入自己的本地 DSH
cookie，并且从不暴露它；浏览器只持有 portal 作用域的能力 cookie。见
[协议文档 §7](../PROTOCOL.zh.md#7-portal-转发)与
[设计文档 §5](../DESIGN.zh.md#5-portal-原理)。

**3. client 插件范围：发现与元数据，而不是第二套 DSH。** 本地 bundle 注册 keyed
`main` Devices 面板、`sidebar.panellist`、主机栏（DOM 注入）与
`shell.overlay`。它展示本机、配对、已配对设备与远程工作区分组，并打开 portal。远程行
绝不伪装成本地行；原生工作区行徽标要等上游提供 `ui-workspace` slot
（[设计文档 §8.3](../DESIGN.zh.md#83-本地--远程工作区)）。

用替代方案的语言来说，最终交付的设计是**数据面选 B，UI 保真选 A**：Mesh 提供经过
认证和加密的传输与受控元数据，portal 提供真正的远程 UI。它明确不是 **C**——在本地
渲染器中再建一棵 DSH client 树。

## 结果

### 收益

- **不 fork DSH 也能获得完整保真。** 审批、终端、文件、设置以及未来的 DSH 功能都随
  远程 UI 一起到来。
- **不改核心。** 使用公开的 host 服务与 client slot；桌面版与服务端 DSH 安装方式一致。
- **一套协议，两种承载。** 直连与 relay 共享同一个 Noise 会话、RPC 与 portal；relay
  模式不需要任何入站端口。
- **可见的授权。** portal 就是 owner UI，因此已配对 controller 有意保持 owner 级；
  令牌、SAS 与撤销让这件事始终是显式的。

### 成本与风险

- **owner 级 portal 访问。** 这是产品决策；文档必须说明，配对也必须始终显式且可撤销。
- **对版本敏感的 portal 认证。** 依赖 `getOrigin`、`authenticatedUrl` 和 DSH 的
  cookie/Origin 围栏；每次 DSH 升级都需要回归检查。
- **没有深链。** v1 打开远程首页；远程工作在 portal 标签页（或右侧栏）中进行，本地
  工作在原生 shell 中进行。
- **relay 可用性。** relay 能看到元数据，也能拒绝服务或替换某个 `serverId` 会话；
  E2EE 保护内容，不保护可用性。

### 安全影响

- 带钉扎密钥的 Noise NK 保护内容免受恶意 relay 或网络路径影响；一次性令牌、本机批准
  与 SAS 保护首次接触。
- portal 只绑定回环，并要求用 32 字节能力令牌换取
  `HttpOnly; SameSite=None; Secure` cookie；DSH cookie 只留在 daemon 内存中。撤销会
  关闭会话，并在每次 RPC 时重新检查。（cookie 按 host 共享、不按端口隔离；请求围栏
  阻止其他回环页面使用它，但用户访问的本机 HTTP 服务可以在服务端读到它。）
- 残余风险：恶意的已配对 controller 拥有 daemon UI；远端 UI 运行在 portal 的回环
  源中并可访问其他回环服务；本机 HTTP 服务可以读到按 host 共享的 portal cookie；本机
  恶意软件不在威胁模型内；relay 流量分析是可能的。

### Phase 2 路径

portal 是主要界面，但不是路线图的终点。原生 RPC 控制增加日常操作，同时 portal 继续
提供完整保真：

- **daemon 侧的 peer 与策略。** `ctx.connection.createPeer({ principal })`，使用
  `mesh-device` principal，再加一个面向工作区/会话资源的 `ctx.remoteAccess` 策略；
  一元调用走 `createSharedFetchHandler('/api')`，流走 typert gateway。
- **审批中继。** `approval/request` 与 `user-questions/request` 是只有 owner peer 才
  能回答的转发 waterfall。host 插件必须拦截自己这一侧的 host waterfall，转发给正在
  控制的设备并返回答案；超时与断连都失败关闭。
- **上游工作区徽标。** 为 `ui-workspace` 增加 `sidebar.workspace.row.trailing`，
  用于显示设备徽标；这是渲染改进，不是协议依赖。
- **仍然不改核心。** 只用公开服务；徽标是向上游提议的。如果两者发生变化，降级到
  portal。

## 考虑过的替代方案

### A. 没有 Mesh，直接反向代理远程 UI

从 controller 到 daemon 的 DSH Web 端口运行一个普通 HTTP/WS 反向代理，不使用设备
Mesh 或自定义 RPC。

- **为什么不作为主设计：** 它绕过身份、授权与审计。代理必须注入 daemon 的 owner
  cookie，因此每个请求都是 owner 级，无法按设备撤销。cookie 作用域、`Origin` 与
  `Host` 围栏在桌面版和 `dsh web` 之间不同，公网部署仍然需要经过认证的加密隧道，
  而且 Devices 面板拿不到任何元数据。
- **什么时候有用：** 在 Mesh 无法运行时作为受信任局域网的逃生通道，或用于可视化
  调试。它不是可发布的路径。

### B. 纯 Mesh RPC 加本地重新实现的远程 UI

只使用 Mesh RPC；用本地组件渲染远程工作区、会话、对话、审批、终端与文件。

- **为什么现在不做：** 这意味着重新实现 DSH 中一大块快速演进的部分。审批是 owner
  only 的 waterfall，终端 attach 是带背压的双向流，文件语义以 host 为根。保真度与
  维护成本都很高，而且 DSH 的每一次 UI 变化都会变成我们的 bug。
- **什么时候有用：** 当协议暴露日常操作、且本地 UI 能渲染安全子集（列表、prompt、
  取消、状态）之后。这是 Phase 2 的方向，叠加在 portal 之上，而不是取代它。

### C. 在本地渲染器中再建一棵 DSH client 树

为每台远程 host 实例化另一棵 Cordis client 树，把 `ctx.connection`/`api-remotes`
装进去，并在本地渲染它的 slot。

- **为什么不行：** 它与单 host 模型冲突。`ctx.sessions` 与 `ctx.workspaces` 是根
  服务，渲染器也不是为嵌套树设计的。生成的 typert 贡献是构建期的值导入，因此第三方
  bundle 若没有自己的生成步骤，就无法凭空造出远程命名空间。审批也不会更容易：这棵
  树仍然是非 owner principal，而 `answers` 硬编码给 owner，所以它仍然需要 B 的
  中继。
- **什么时候有用：** 只有当 DSH 长出受支持的多 host/嵌套树 API 时；那时 C 可以取代
  portal，同时保留这套 Mesh 与安全模型。

### 为什么选择这个组合

A 单独使用不安全，也没有本地发现。B 单独使用需要太多 UI 工作，而且边缘功能仍然需要
portal。C 风险最高，也没有消除最难的授权问题。本设计用 B 做传输、身份与元数据，用 A
做远程界面；Phase 2 可以把日常操作从 A 移到 B，而不改变线路协议或配对。

## 参考资料

- [DESIGN.zh.md](../DESIGN.zh.md) —— 架构、portal、DSH 集成与路线图。
- [PROTOCOL.zh.md](../PROTOCOL.zh.md) —— 线路格式、配对、Noise、RPC、portal 与
  relay 约束。
- [development.zh.md](../development.zh.md) —— 构建、打包、集成与测试。
- [README.zh.md](../../../README.zh.md) —— 安装、配对与使用。
- DSH 文档：
  [插件开发](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/index.md)、
  [client modules](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/client-modules.md)、
  [slots](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/slots.md)、
  [web client](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/web-client.md)。
- DSH 发布基线：
  [v0.2.2-rc.1](https://github.com/deepseek-ai/DeepSeek-Harness/releases/tag/dsh-v0.2.2-rc.1)；
  [paseo-relay](https://github.com/kfxhjz/paseo-relay) 用于可选的公网传输（仅路由）。
