# DSH Device Mesh 线路协议 v1

[English](../PROTOCOL.md) | 简体中文

状态：**wire protocol v1 稳定版**（插件 `0.1.3`）。本文是实现与安全评审的规范依据，
`src/shared/protocol.ts` 是这份契约的可执行形式。

## 目录

1. [术语与范围](#1-术语与范围)
2. [设备身份](#2-设备身份)
3. [配对](#3-配对)
4. [传输层](#4-传输层)
5. [安全通道](#5-安全通道)
6. [会话多路复用与 RPC](#6-会话多路复用与-rpc)
7. [portal 转发](#7-portal-转发)
8. [复用 paseo-relay](#8-复用-paseo-relay)
9. [安全要求](#9-安全要求)
10. [版本与兼容](#10-版本与兼容)

## 1. 术语与范围

| 术语 | 含义 |
|---|---|
| **daemon（被控端）** | 接受远程控制的 DSH 设备，例如 Linux 桌面、Linux 服务端或 macOS 桌面。 |
| **controller（主控端）** | 发起远程控制、连接 daemon 的 DSH 设备。 |
| **pairing（配对）** | 通过二维码或配对链接带外交换密钥，使 controller 获得 daemon 身份与授权的过程。 |
| **pairing ticket（配对票据）** | 二维码或链接中经过签名、带有效期的载荷。 |
| **direct（直连）** | controller 直接连接 daemon 自己的 WebSocket 监听端口（内网 / Tailscale）。 |
| **relay（中继）** | 双方各自出站连接 paseo-relay，由 relay 按 `serverId` 转发不透明帧（公网）。 |
| **portal（传送门）** | controller 本地 `127.0.0.1:<随机端口>` 上的反向代理，把浏览器对远端 DSH Web UI 的 HTTP/WS 流量经 Mesh 会话转发到 daemon 本机 DSH Web。 |
| **SAS** | 配对时两端同时显示的六位短认证串，供人工比对。 |
| **scope（授权范围）** | 配对记录上的授权：v1 为 `control`，`view` 预留。 |

设计目标：所有授权方向共用一套协议，角色由「谁发起连接」决定而非平台；direct
与 relay 可替换，但都承载同一套端到端加密会话；二维码中包含密钥指纹、端点与一次性
令牌；逐设备授权、可撤销并保留审计；controller 侧明确区分本地与远程工作区。

v1 的非目标：文件传输、剪贴板同步、屏幕串流、多跳/级联中继、与 Paseo 原生协议互通
（只复用 relay 路由），以及原生移动端 App。controller 侧以 Web 客户端插件交付，
可在 Android、iOS 或鸿蒙的手机浏览器/WebView 中运行；移动端的 daemon 能力等官方
DSH 支持后再评估。

## 2. 设备身份

插件首次启动时创建 `$DSH_HOME/device-mesh/identity.json`（文件 `0600`，目录
`0700`）：

```jsonc
{
  "version": 1,
  "deviceId": "dm_7f3a…",              // "dm_" + 22 位小写 base32
  "name": "<device-name>",             // 人类可读，不是秘密
  "platform": "darwin", "createdAt": "2026-11-09T00:00:00.000Z",
  "signPk": "<b64url Ed25519 原始公钥>",
  "dhPk": "<b64url X25519 原始公钥>",
  "signSk": "<b64url PKCS#8 Ed25519 私钥>",
  "dhSk": "<b64url PKCS#8 X25519 私钥>"
}
```

- Ed25519（`signPk`/`signSk`）用于配对票据与会话认证签名；X25519
  （`dhPk`/`dhSk`）是 Noise 握手使用的静态密钥对。
- `deviceId` 是 `dm_` 加上 `SHA-256(Ed25519 原始公钥)` 的小写 base32 前 22 位。
  它只是公开标识，**不是**认证凭据。
- 私钥永不离开设备、永不进入二维码、永不写入日志或审计；票据只带公钥，接收方由
  `signPk` 推导 `deviceId`，不一致即拒绝。

## 3. 配对

daemon 生成一次性配对记录（默认 10 分钟有效），二维码或链接内容是：

```
dsh-mesh://pair?d=<base64url(UTF-8 JSON)>
```

```jsonc
{
  "v": 1, "id": "dm_…", "name": "<device-name>", "platform": "linux",
  "signPk": "<b64url>", "dhPk": "<b64url>",
  "eps": [                                    // 按优先级排列
    { "k": "direct", "url": "ws://<lan-ip>:45871/mesh" },
    { "k": "direct", "url": "ws://<tailscale-ip>:45871/mesh" },
    { "k": "relay", "url": "wss://relay.example.com/ws",
      "sid": "<relay-server-id>", "v": 2 }
  ],
  "tok": "<b64url 32 字节随机数>", "exp": 1762742400,
  "sig": "<b64url Ed25519 签名>"
}
```

- canonical JSON 按 key 升序、无空白，且不含 `sig`；`sig` 是 daemon 对 `v`、`id`、
  `name`、`platform`、`signPk`、`dhPk`、`eps`、`tok`、`exp` 的 UTF-8 canonical
  JSON 的 Ed25519 签名。
- controller 必须先用 `signPk` 验签，失败立即丢弃；同时要求 `id` 等于由 `signPk`
  推导的 `deviceId`、`eps` 至少有一个合法端点、`tok` 为 32 字节、`sig` 为 64
  字节、`v` 为 1 且 `exp` 未过期。
- `tok` 是只能使用一次的 bearer secret。daemon 只持久化其 SHA-256，并在弹出本机确认
  之前就将其从磁盘移除，因此并发、崩溃后重放或过期令牌都会被拒绝。
- 新 controller 默认必须由本机用户确认，界面显示 controller 名称、平台与 SAS；
  自动批准只能作为显式配置开启。批准后 daemon 在 `peers.json` 持久化 controller
  公钥与 scope，controller 持久化 daemon 公钥、relay 路由与端点缓存。
- 默认 scope 为 `{ "kind": "control", "workspaces": "all", "expiresAt": null }`；
  `view` 预留。撤销会写入 `revokedAt`，拒绝新握手并关闭已建立会话；每次 RPC 也会
  重新检查撤销状态与 scope 过期时间。配对、连接、撤销、portal 打开以及认证失败
  （只记录原因码）都会写入 `audit.jsonl`，但不记录消息内容。
- 配对票据只在本机开启 relay 服务（`relay.enabled`）时才广播 relay 端点；仅用于
  出站控制的中继配置不会进入票据。没有缓存端点的已配对 daemon 必须重新配对，绝不
  用本机自己的 relay `serverId` 兜底。
- 首次配对请求在 controller 会话关闭于本机决定之前时会被拒绝；controller 的等待
  窗口长于 daemon 的 5 分钟请求 TTL，避免 daemon 仍可批准时 controller 已经回滚。

## 4. 传输层

### 4.1 WebSocket 承载

所有 Mesh 消息都是 **WebSocket binary message**，text frame 一律忽略；一条
WebSocket 消息恰好承载一个 Mesh 帧。

- 单条密封明文最大 64 KiB；更大的 HTTP body 或 WebSocket 消息由上层流分块（§6）。
  握手报文最大 4 KiB，加密后的应用认证报文最大 16 KiB。
- 握手阶段帧首字节为 `0x01`；握手完成后帧首字节为 `0x02`（Noise 传输报文），
  解密后的明文首字节为 `0x10`（控制）或 `0x11`（流）。
- `0x01` 前缀同时避免 Mesh 帧被 paseo-relay 的握手卫生预检误判为 JSON。

### 4.2 直连

- daemon 自己开监听，与 DSH Web 端口无关：默认 `0.0.0.0:45871`、路径 `/mesh`，
  两者均可配置。回环地址不会写入票据，因为那只能连到设备自己。
- 票据端点按以下优先级枚举：内网 IPv4、Tailscale CGNAT（`100.64.0.0/10`）、其他
  公网 IPv4，最后 IPv6；回环、link-local、docker/bridge/虚拟接口与重复地址跳过。
- 监听只接受非浏览器客户端：请求带任何 `Origin` 头时在升级完成前返回 HTTP `403`；
  路径不匹配返回 `404`，非 WebSocket 升级返回 `426`，全局连接超限返回 `503`，
  单 IP 连接超限返回 `429`。
- 默认全局上限 16 条连接，单 IP 为其中一半（至少 2 条），且单 IP 每分钟最多 60 次
  HTTP upgrade 尝试（超出在窗口重置前返回 `429`）。controller 连接
  `ws://<host>:<port>/mesh`。

### 4.3 relay

见 §8。relay 上传送的仍是同样的 `0x01` 握手帧与 `0x02` 密封帧，relay 不解析内容。

### 4.4 端点选择、保活与重连

- controller 按票据顺序尝试端点，保留第一个完成 Noise 与应用认证的连接，并把该
  端点移到缓存列表最前面。
- 传输层发送 WebSocket ping：direct 每 20 秒，relay 每 10 秒；一个完整间隔内没有
  任何入站流量即判定连接死亡并终止。
- controller 会话建立后，broker 每 30 秒发送一次应用层心跳；没收到 pong 只记录日志，
  不关闭会话。真正的存活信号是传输层 close 事件（direct 20 秒 / relay 10 秒的
  WebSocket 心跳会先终止死连接）。
- 重连采用指数退避，下限 1 秒、上限 30 秒；用户主动断开不自动重连。会话断开期间
  portal 请求返回 `502`，portal 本身保持打开并显示重连状态。

## 5. 安全通道

### 5.1 Noise NK 握手

使用 **Noise_NK_25519_ChaChaPoly_SHA256**，Noise revision 34，prologue 为 ASCII
`dsh-mesh/1`（无终止符）。daemon 的 X25519 静态公钥由配对票据带外分发并被
controller 钉扎，NK 的 `<- s` 预消息让 controller 在握手阶段就能认证 daemon。

```
controller（发起方）                            daemon（响应方）
  [0x01] msg1  (-> e, es)  ──────────────────────────────▶
                            ◀──────────────────────────────  [0x01] msg2  (<- e, ee)
```

- controller 把票据里的 `dhPk` 作为 remote static key；daemon 使用自己的 `dhKey`。
  `split()` 派生独立的 tx/rx 密码状态，最终握手哈希 `h` 绑定应用认证与 SAS。
- 握手前收到 `0x02`、握手后收到 `0x01`、报文格式/长度非法、或对端使用低阶/全零
  公钥，一律以 `4400` 关闭（认证失败为 `4401`）。
- Mesh 握手报文不携带 payload。实现中的 PSK 支持只用于复现官方 noise-c 测试向量，
  生产会话永不设置 PSK。

### 5.2 应用层认证

Noise 握手完成后，controller 立即发送第一条 **密封** 应用消息：

```jsonc
// 已配对
{ "t": "client_auth", "v": 1,
  "controller": { "deviceId": "dm_…", "name": "<device-name>", "platform": "linux",
                  "signPk": "<b64url>", "dhPk": "<b64url>" },
  "nonce": "<b64url 32 字节>",
  "auth": { "kind": "paired", "sig": "<b64url Ed25519(signSk, h || \"client_auth\")>" } }
// 首次配对，使用票据中的一次性令牌
{ "t": "client_auth", "v": 1, "controller": { … }, "nonce": "<b64url 32 字节>",
  "auth": { "kind": "pair-token", "daemonId": "dm_…", "token": "<b64url 32 字节>" } }
```

daemon 回复密封的 `server_auth`：

```jsonc
{ "t": "server_auth", "v": 1,
  "daemon": { "deviceId": "dm_…", "name": "<device-name>", "platform": "linux",
              "signPk": "<b64url>", "dhPk": "<b64url>" },
  "approval": "none" | "pending",
  "requestId": "<仅 pending 时存在>",
  "sig": "<b64url Ed25519(signSk, h || \"server_auth\" || controllerNonce)>" }
```

1. controller 必须验证 `daemon.signPk`/`dhPk` 与钉扎值一致；不一致说明设备身份
   变化，立即断开并告警。
2. `paired`：daemon 检查撤销状态与授权过期时间，再用配对记录中的公钥验签；未知、
   已撤销或已过期的 controller 以 `mesh/unauthorized`/`mesh/revoked` 拒绝，并关闭
   `4403`。
3. `pair-token`：daemon 校验 `daemonId`、令牌哈希、有效期与未使用状态，然后进入
   本机确认队列，回复 `approval: "pending"` 与 `requestId`。批准前只允许
   `pair.status`，不接受任何 portal 流；拒绝或超时会关闭会话。
4. controller 验证 daemon 签名后才信任 `server_auth`，随后轮询 `pair.status`；
   daemon 持久化 controller 记录并返回 peer 后，会话才可用、设备才显示在线。
5. `nonce` 必须为 32 字节；daemon 维护 10 分钟重放缓存，重复 nonce 以 `4403`
   拒绝。
6. 首帧必须在通道建立后 10 秒内到达，应用认证必须在通道建立后 60 秒内完成
   （包含首帧窗口），否则 daemon 以 `4408` 关闭。

### 5.3 SAS

```
ikm  = h
salt = lower(bytes(signPkA)) || higher(bytes(signPkB))   // 按字节序排序
info = "dsh-mesh/1 sas"
SAS  = HKDF-SHA256(ikm, salt, info, L=4) 按大端读取
       % 1_000_000，补零为六位，格式 "123-456"
```

两端显示同一个值，用户核对后再批准。排序两个 Ed25519 公钥使结果与角色无关。

### 5.4 密封帧与关闭码

```
sealed frame   = 0x02 || Noise CipherState.encrypt(plaintext)
plaintext      = 0x10 || UTF-8 JSON
               | 0x11 || u32 streamId (BE) || u8 flags || payload
```

- 一条 WebSocket 消息对应一条 Noise 报文，CipherState nonce 每条递增一次。解密失败
  （篡改、乱序、重放、反射）以 `4401` 关闭并停止发送。发送计数接近 Noise 上限前
  必须重建会话；正常情况下不会到达。
- 流帧头 6 字节；`streamId` 为非零 31 位整数，由流发起方分配：controller 发起为
  奇数，daemon 发起为偶数。
- `flags`：`0x01` 数据、`0x02` 流结束、`0x04` 中止（payload 为 UTF-8 错误码）、
  `0x08` 一条 WebSocket 消息结束（仅 `portal.ws`）。中止后不可恢复；未知
  `streamId` 的帧会被忽略（与 abort 竞争的帧不能关闭无关会话），重复 `streamId`
  只让该 RPC 以 `mesh/bad-request` 失败、不关闭会话；超过 32 KiB 的块或其他帧格式
  非法仍以 `4400` 关闭。

| 关闭码 | 含义 |
|---|---|
| `1000` | 正常关闭或会话结束。 |
| `4400` | 协议错误：帧格式、阶段、控制消息非法。 |
| `4401` | 密码学失败：AEAD 或握手认证失败。 |
| `4403` | 未授权：未知、已撤销、已过期、签名错误或 nonce 重放。 |
| `4408` | 应用层认证超时。 |

关闭原因只使用稳定的 `mesh/…` 或 `portal/…` 错误码，不包含 payload、令牌、密钥或
握手哈希。

## 6. 会话多路复用与 RPC

控制 JSON 位于 `0x10`：

```jsonc
{ "id": 17, "method": "workspaces.list", "params": {} }        // 请求
{ "id": 17, "result": { … } }                                 // 成功
{ "id": 17, "error": { "code": "mesh/…", "message": "…" } }    // 失败
{ "event": "workspaces.changed", "data": { … } }               // 事件（无 id）
{ "ping": 123 }  /  { "pong": 123 }                           // 控制层心跳
```

- `id` 由请求方从 `1..2^31-1` 分配，会话内唯一；响应回显该 id。
- v1 只允许 controller→daemon 请求；daemon 对 controller 角色的调用返回
  `mesh/unsupported`。
- 事件为 daemon→controller，不带 `id`。v1 定义了信封但不产生事件；
  `workspaces.subscribe` 仅为向前兼容而确认，controller 使用 `workspaces.list`
  轮询。
- `ping`/`pong` 是控制层心跳；另有独立的 `ping` RPC 用于诊断。

| 方法 | 参数 | 返回 | 说明 |
|---|---|---|---|
| `info` | `{}` | `{ device: { deviceId, name, platform, signPk, dhPk, appVersion }, protocol: 1, capabilities: ["rpc","portal","workspaces","pairing","relay"], hostLabel }` | 认证后的第一个调用。 |
| `workspaces.list` | `{ refresh?: boolean }` | `{ updatedAt, workspaces: [Workspace], truncated?: boolean }` | 默认缓存 60 秒，`refresh` 绕过；`truncated` 表示列表因 wire 预算被裁剪。 |
| `workspaces.subscribe` | `{ intervalMs?: number }` | `{ ok: true }` | 仅确认；v1 由 controller 轮询。 |
| `session.archive` | `{ sessionId, stopActivity? }` | `{ archived: true }` | 需要 control 授权；写入 daemon 的注册表归档集合。 |
| `session.unarchive` | `{ sessionId }` | `{ archived: false }` | 需要 control 授权；幂等。 |
| `portal.prepare` | `{}` | `{ ok: true }` | 可选：预热 daemon 本机 DSH 浏览器会话。 |
| `portal.http` | `{ streamId, method, path, headers }` | `{ streamId, status, headers }` | 请求/响应 body 在同一流上传输。 |
| `portal.ws.open` | `{ streamId, path, headers, protocols?, compress? }` | `{ streamId, protocol?, compressed? }` | 双向 WebSocket 消息在同一流上传输。 |
| `pair.status` | `{ requestId }` | `{ state: "pending" \| "approved" \| "denied", peer? }` | 批准前唯一允许的调用。 |
| `ping` | `{}` | `{ now }` | 健康检查/诊断。 |

`Workspace`：

```jsonc
{
  "id": "<workspace-id>", "title": "<workspace-title>", "path": "<workspace-path>",
  "sessions": [{
    "id": "<session-id>", "title": "<session-title>",
    "updatedAt": "2026-11-09T00:00:00.000Z",
    "running": false, "awaitingUser": false, "unread": false, "archived": false
  }]
}
```
`archived` 为可选字段（旧 daemon 不返回）；远程镜像把缺失视为未归档。

每个工作区最多上报 200 个会话，整份列表最多 200 个会话、100 个工作区，并且会裁剪到
单条 64 KiB 控制帧以内；发生裁剪时结果带 `truncated: true`。字段来自 DSH 的
workspace/session 服务，服务不可用时返回保守结果。

错误码统一为 `<domain>/<reason>`：`mesh/unauthorized`、`mesh/revoked`、
`mesh/bad-request`、`mesh/not-found`、`mesh/unsupported`、`mesh/busy`、
`mesh/rate-limited`、`mesh/version-mismatch`、`mesh/crypto`、`mesh/internal`、
`portal/unavailable`、`portal/upstream-error`。其中 `mesh/rate-limited` 预留给本地
准入限制；v1 实际使用连接数、队列和流上限，而不是按 IP 的握手限速。

限制：单 RPC 超时 30 秒；每会话并发流 32（超出返回 `mesh/busy`）；单流入站缓冲
8 MiB；背压阈值 1 MiB；daemon 侧未完成 RPC 64 个、并发 handler 32 个；控制头最多
64 项、名字 256 字节、值 8192 字节；portal path 最多 8192 字节，必须以 `/` 开头且
不能是 `//`。

## 7. portal 转发

portal 让 controller 的浏览器打开 **完整的远端 DSH Web UI**，而不需要 DSH 核心支持
多 host。

```
浏览器 ──HTTP/WS──▶ controller host 插件 (127.0.0.1:<portal端口>)
                          │ Mesh 安全会话（direct 或 relay）
                          ▼
                   daemon host 插件 ──HTTP/WS──▶ daemon 本机 DSH Web (127.0.0.1:<dsh端口>)
```

### 7.1 controller 侧 portal 服务器

- 只绑定 `127.0.0.1`，端口由 OS 分配；本地 API 返回
  `http://127.0.0.1:<port>/?token=<32 字节 base64url>`。
- 首次携带合法 `?token=` 的导航返回 `303`，并设置
  `Set-Cookie: <portal-cookie>=<token>; Path=/; HttpOnly; SameSite=None; Secure`
  （回环属于安全上下文）。token 在 portal 关闭前可再次使用。
- 浏览器 cookie 按**主机**（不含端口）生效，回环 portal 因此共享 cookie jar；
  隔离靠请求校验而不是 cookie 名：所有请求必须携带精确的 `Host`
  （`127.0.0.1:<portal-port>`）；HTTP 请求必须同源（`Sec-Fetch-Site:
  same-origin` 或 `none`，且存在 `Origin` 时必须匹配）；带 cookie 的请求若缺少
  `Sec-Fetch-Site` 一律拒绝，因此要求浏览器提供 Fetch Metadata（不支持非浏览器
  cookie 客户端）；WebSocket 升级必须携带精确的 portal `Origin`。这样本机其他回环页面无法借用已打开 portal 的 cookie。
  但 cookie 按 host 共享、不按端口隔离：用户访问的其他本机 HTTP 服务可在服务端
  读到它，请把本机进程视为部分可信。
- portal 代理请求在控制器重连期间可幂等重试：会话关闭时等待 `adoptSession`，
  GET/HEAD/OPTIONS 与 WebSocket upgrade 各重试一次。
- `portal.prepare` 是 daemon RPC：主控端在返回 portal URL 前先让被控端获取本地
  DSH 浏览器会话，避免首屏并行资源请求撞上冷 cookie。
- 从其他回环来源（弹窗/iframe）携带能力 token 打开远程控制是正常入口。由于浏览器
  未必会应用跨站重定向中设置的 cookie，该路径返回同源 bootstrap 页面（状态码
  `200`），设置 cookie 后立即跳转到不含 token 的路径。带 cookie 的后续请求仍只允许
  `same-origin`/`none`。
- 通过上述校验、携带合法 token/cookie 的 WebSocket 升级才会放行（浏览器不会为升级
  跟随重定向）。允许的方法为 `GET`、`HEAD`、`POST`、`PUT`、`PATCH`、`DELETE`、
  `OPTIONS`，其他返回 `405`；token/cookie 缺失或错误返回 `403`。portal 会从所有
  转发 path（含 WebSocket 与非 GET 请求）中剥离 `?token=`，因此能力令牌不会进入
  daemon 的请求 path、`Referer` 或日志。
- 空闲 30 分钟后自动关闭，设备被 forget 或撤销时也会关闭。短暂的网格会话断开不会
  销毁 portal 或其能力 URL：期间请求返回 `502`，controller 自动重连后 broker 把新
  会话交给同一 portal，因此同一个标签页无需重新打开即可恢复。URL、token、cookie
  不进入日志或审计。

### 7.2 HTTP 转发

1. controller 分配奇数 `streamId`，发送
   `{ "id": n, "method": "portal.http", "params": { "streamId": s, "method": "GET", "path": "/…", "headers": {…} } }`。
2. 浏览器请求 body 以 `0x11` 分块发送；无 body 时直接结束流。
3. controller 剥离 hop-by-hop 头、`Host`、`Cookie`、`Origin`、`Referer`、
   `Content-Length`、`sec-fetch-*`、转发标记与 `X-DSH-Mesh-*`，再注入
   `X-DSH-Mesh-Peer` 与 `X-DSH-Mesh-Version: 1`。
4. daemon 校验 method/path/headers，取得内存中的 DSH cookie 后向本机 origin 发起
   请求：`Host` 由本地 origin 隐含；`Origin`/`Referer` 改写到该 origin；
   `Sec-Fetch-Site` 改为 `same-origin`；`Accept-Encoding` 强制为 `identity`。
   Mesh 传来的 hop-by-hop、凭据、`sec-fetch-*` 与 DSH 自有的整个 `x-dsh-*` 命名空间
   （含 `X-DSH-Mesh-*`、`x-dsh-auth-token`、`x-dsh-file`）一律不信任，只转发允许的
   普通头与安全的 `x-*`。
5. daemon 返回
   `{ "id": n, "result": { "streamId": s, "status": 200, "headers": {…} } }`，
   body 以 `0x11` 分块回传并以结束标志收尾；错误使用中止标志与稳定错误码。
   controller 清洗响应头后按顺序把状态、头和 body 写给浏览器。

双方都丢弃 hop-by-hop 头。daemon 丢弃 `Set-Cookie`、`Content-Encoding`、
`Content-Length`（body 解码后重新流式发送）；controller 丢弃 `Set-Cookie`、
`X-Frame-Options`、CSP `frame-ancestors` 与 report-only CSP，以便本机页面用 iframe
嵌入。指向同源的绝对 `Location` 会改写为路径相对地址，浏览器保持在 portal origin；
daemon 的 DSH cookie 永不跨 Mesh。

### 7.3 WebSocket 转发

1. 浏览器发起 `Upgrade: websocket`；controller 校验 token/cookie，接受升级并记录
   请求的子协议。
2. controller 发送
   `{ "id": n, "method": "portal.ws.open", "params": { "streamId, path, headers, protocols?, compress? } }`；
   daemon 带 cookie 和清洗后的头连接本机 DSH WebSocket，成功回复
   `{ streamId, protocol?, compressed? }`，失败回复错误。
3. 每条 WebSocket 消息由一个或多个 `0x11` 块承载；消息最后一块置 `0x08`
   （`MESSAGE_END`），空消息为无 payload 的 `Data | MESSAGE_END`。每个块不超过
   64 KiB 密封上限，更大的消息跨块传输。**消息 payload 的首字节携带 WebSocket
   opcode**（`0x00` = text，`0x01` = binary），因为 DSH 的 Remote stream 网关要求
   text 帧；接收方必须据此以 `string` 或 bytes 转发。HTTP 流不携带该字节。
   该首字节也可为 `0x02`（gzip text）或 `0x03`（gzip binary），表示消息已压缩。
   controller 用 `params.compress: true` 按连接选择启用；daemon 仅在支持该特性时
   回复 `compressed: true`，因此新旧版本混连时仍使用 `0x00`/`0x01`。daemon 在
   消息进入网格分块前对双向 ≥1024 字节的消息做 gzip，并在收到带标记的消息时解压。
   这与 `ws` 的 per-message deflate 无关：后者是逐跳的，无法减少网格/中继上的
   实际传输量。
   任一端关闭即结束流；异常关闭使用中止标志与稳定错误码，daemon 正常关闭上游使用
   `1000`，异常使用 `1011`。

### 7.4 daemon 侧 DSH 认证

- daemon 通过 `ctx.webServer.getOrigin()` 取得本机 DSH origin，通过
  `ctx.connection.authenticatedUrl(origin)` 取得浏览器登录 URL。
- 手动跟随 `303`（关闭自动重定向）以看到 DSH 的 `Set-Cookie`，然后只在内存中保存
  `dsh-auth-*=<value>`。cookie 接近过期或上游返回 `401` 时刷新一次；失败返回
  `portal/unavailable`。
- 该 cookie 只用于本机 DSH origin，不跨 Mesh、不落盘、不写日志。`portal.prepare`
  可预热，但普通 HTTP/WS 请求也会惰性获取。

### 7.5 深链

portal iframe 可以携带 `?dm-session=<session-id>&dm-embed=1`。portal 响应把该 id
存入 `sessionStorage`，远端这份插件在 shell 就绪后通过 `uiWorkspace.openSession`
打开对应会话；`dm-embed=1` 注入折叠远端侧栏的布局覆盖。这是尽力而为：当 DSH 的 UI
表面变化，或远端文档的 CSP 禁止内联 script/style 时，布局/深链注入会被跳过，
用户会落在远端首页并在 UI 内导航。

需要新建会话的父窗口改为携带
`?dm-new-session=<workspace-id>&dm-new-session-request=<id>`。portal 把
`{workspaceId, requestId}` 存入 `sessionStorage`；远端插件在就绪后调用 shell 原生的
`uiWorkspace.startSession(workspaceId)`。已加载的 iframe 被复用时，同一请求也可能以
`kind: "new-session"` 的 `postMessage` 到达；请求 id 让两条投递路径保持幂等。
URL 参数和 storage 条目在首次使用后即被消费，因此 iframe 重载不会创建第二个空白
会话。

## 8. 复用 paseo-relay

Mesh 只复用 paseo-relay 的 **路由能力**，relay 看到的是不透明、有序的 WebSocket
流；§5 的端到端加密保证它无法读取内容。

- v2 daemon：先开 control socket
  `wss://<relay>/ws?serverId=<sid>&role=server&v=2`（不带 `connectionId`），收到
  `{"type":"sync","connectionIds":[...]}`；之后每收到一个 `connected` 事件，开一条
  `wss://<relay>/ws?serverId=<sid>&role=server&v=2&connectionId=conn_…` 的 data
  socket，每条 data socket 就是一条 Mesh 传输并运行 Noise 握手。
- v2 controller：连接 `wss://<relay>/ws?serverId=<sid>&role=client&v=2`，不传
  `connectionId`；relay 分配 `conn_…` 并与 daemon 的 data socket 配对，超时未配对
  则以 `1013` 关闭。
- `disconnected` 会移除对应 data socket；control socket 断开时关闭全部 data
  transport，并按相同退避策略重连。control 通道是 JSON（`sync`、`connected`、
  `disconnected`、`ping`/`pong`），Mesh 帧不会经过它。relay 的握手卫生预检只检查
  首字符为 `{` 的帧，因此 `0x01`/`0x02` 开头的 Mesh 帧会被忽略。
- v1 回退：daemon 用 `role=server&v=1`，controller 用 `role=client&v=1`；一个
  `serverId` 只服务一个 client，同角色新连接以 `1008` 替换旧连接。本版本 broker
  只启动 v2 daemon；controller 仍会按票据里的 `v: 1` 连接旧版 daemon。
- `serverId` 是 bearer 路由秘密，不是设备身份：每台 daemon 生成 32 字节随机
  base64url，可轮换；只出现在 relay URL 与票据中，日志中必须脱敏，绝不能由
  `deviceId`、主机名或用户名派生。
- 知道 `serverId` 的人可以 attach 或替换该 relay 会话；端到端加密阻止冒充与解密，
  但无法阻止拒绝服务。公网部署必须使用 TLS 并配置 relay 的 origin 白名单；relay
  模式不开放任何公网入站端口。

### 中继约束

relay 是共享、无认证的字节管道。以下限制与关闭语义是本协议的传输假设；数值来自
paseo-relay v0.1.2 协议，可能随部署的 relay 版本变化。

| 约束 | 值 | 对本协议的含义 |
|---|---|---|
| relay 数据帧 | 约 32 MiB − 14 字节 | 密封帧上限为 64 KiB（§4.1），远低于该值，单条 Mesh 消息不需要 relay 分片。 |
| v2 control 消息 | 64 KiB | control socket 只承载 `sync`、`connected`、`disconnected` 与 `ping`/`pong`；Mesh 帧不经过它。 |
| 每个 `connectionId` 的 v2 client 数 | 默认 32，可配置 | 每个 controller 占一条 client socket。同时在线 controller 超过 relay 允许值时，需要提高上限或改用 hub；超出的 attach 会被拒绝而不是排队。 |
| 关闭码 `1008` | 被替换 / 策略关闭 | socket 在替换竞争中失败或被策略拒绝。退避重连并预期新的 `connectionId`；不要复用旧 data socket。 |
| 关闭码 `1012` | data socket 断开 / relay 关闭 | 传输已失效（relay 重启、drain 或 data socket 丢失）。让在途 portal 请求失败，重建传输并重新执行 Noise 握手。 |
| 关闭码 `1013` | 无 data route / 预算 / 慢消费者 | 通常是瞬时的：data socket 尚未 attach、准入预算耗尽或 writer 队列已满。退避重试；持续 `1013` 是容量/准入问题，不是协议错误。 |

- **公网必须 TLS。** relay 部署只暴露 `wss://` 并配置 origin 白名单；`ws://`
  仅用于本机测试。
- **relay 不认证任何人。** E2EE 与一次性配对就是认证层，不是纵深防御。relay 能看到
  路由元数据、帧大小与时序，也能丢弃、延迟或替换关闭码；它不是可靠消息总线，不提供
  可用性保证。
- **`serverId` 卫生。** 每台 daemon 生成 32 字节随机 base64url；有泄露迹象即轮换；
  不得由设备 id 或主机名派生；日志、指标与 access log 的 query 中不得出现。
- **帧卫生。** 每个 Mesh 帧以 `0x01` 或 `0x02` 开头，relay 的 JSON 握手预检不会
  检查它。保持这一性质；若未来引入 JSON 帧，除非 `key` 是规范 X25519 公钥，否则
  不要使用 `hello`/`e2ee_hello` 这两个名字。

## 9. 安全要求

1. **端到端加密**：direct 与 relay 都运行 §5；relay 无法读取或篡改而不被发现。
2. **身份钉扎**：双方钉扎对端公钥；密钥变化必须重新配对并明确告警。
3. **一次性配对令牌**：32 随机字节、10 分钟 TTL、只存 SHA-256、批准前即预留；
   过期或复用一律拒绝。
4. **显式本机确认**：新 controller 默认需要本机用户批准；自动批准必须显式开启。
5. **最小权限**：默认 `control`；过期时间与撤销状态在每次 RPC 前检查，撤销立即
   关闭在线会话。
6. **portal 隔离**：仅回环绑定、随机端口、32 字节能力令牌、
   `HttpOnly; SameSite=None; Secure` cookie、方法白名单与 body/流上限。portal 校验精确的
   `Host` authority；浏览器 HTTP 请求只允许同源（或为顶层导航），带 cookie 的请求
   必须提供 `Sec-Fetch-Site`（`same-origin` 或 `none`），WebSocket 升级必须携带本
   portal 的 `Origin`。`?token=` 能力令牌会从所有转发 path 中剥离，转发前
   `Host`/`Origin`/`Referer` 会改写为 daemon 本机 DSH origin；DSH cookie 不会暴露
   给 controller。
7. **凭据卫生**：私钥、令牌、nonce、握手哈希与 DSH cookie 不进入日志/审计；状态
   文件 `0600`，目录 `0700`。portal 令牌不会转发给 daemon，也不会进入其
   `Referer` 或访问日志。
8. **资源上限**：4 KiB 握手、16 KiB 认证、64 KiB 密封消息、32 KiB 流块、32 条流、
   8 MiB 入站缓冲、16 条 direct 连接（单 IP 一半）、64 条入站会话（每 controller
   8 条，在握手前准入）、8 个待批准配对、64 MiB portal body、100 工作区 / 200 会话
   每份列表、4 MiB / 5 秒的资源清单读取、256 MiB portal 缓存、64 个控制头、
   8 MiB 审计轮转。
9. **拒绝静默降级**：版本不匹配直接拒绝；认证期间检查 `v`；controller 还要求
   `info.protocol === 1`。
10. **最小可信代码**：传输只用 `ws`；Ed25519、X25519、SHA-256、HKDF 使用
    `node:crypto`；ChaCha20-Poly1305 使用 `@noble/ciphers`；不手写密码学原语。
11. **relay TLS**：非回环 relay 端点必须使用 `wss://`；host 会拒绝非回环主机的明文
    `ws://` 端点。`ws://` 仅允许用于绑定回环地址的本地测试 relay。

## 10. 版本与兼容

- 线路协议版本为 **1**（`PROTOCOL_VERSION`）；不兼容变更必须升版本。
- 配对票据携带 `v: 1`，`client_auth`/`server_auth` 携带 `v: 1`；其他版本以
  `mesh/version-mismatch` 拒绝并关闭 `4400`，没有协商或静默回退。
- 认证后 controller 要求 `info.protocol === 1`，否则关闭并报告
  `mesh/version-mismatch`。
- 与 Paseo 原生协议 **不兼容**，只共享 relay 路由层。
- DSH 兼容范围由 `engines.dsh` 声明（MVP 为 `>=0.2.2-rc.1 <0.3.0`）；不支持的
  版本由 DSH loader 跳过，而不是静默降级。
- 插件版本与线路版本独立；升级保留设备身份与配对记录，只有不兼容的线路变更才需要
  重新配对。

## 相关文档（Related docs）

- [README](../../README.zh.md) —— 安装、配对与日常使用。
- [CONTRIBUTING](../../CONTRIBUTING.zh.md) —— 贡献流程与评审约定。
- [SECURITY](../../SECURITY.zh.md) —— 漏洞报告与披露政策。
- [设计文档](DESIGN.zh.md) —— 架构、威胁模型、DSH 集成与路线图。
- [开发指南](development.zh.md) —— 构建、打包、DSH 集成点、测试与发布。
- [ADR 0001](adr/0001-remote-control-in-dsh.zh.md) —— 为何完整远程控制采用 host 侧 Mesh 加本机 loopback portal。
- [文档索引](../README.zh.md) —— 完整文档地图。
