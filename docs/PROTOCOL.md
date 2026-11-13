# DSH Device Mesh Wire Protocol v1
[简体中文](zh/PROTOCOL.zh.md) | English

Status: **stable for wire protocol v1** (plugin `0.1.3`). This document is normative;
`src/shared/protocol.ts` is the executable form of the contract.

## Contents
1. [Terminology and scope](#1-terminology-and-scope)
2. [Device identity](#2-device-identity)
3. [Pairing](#3-pairing)
4. [Transport](#4-transport)
5. [Secure channel](#5-secure-channel)
6. [Session multiplexing and RPC](#6-session-multiplexing-and-rpc)
7. [Portal forwarding](#7-portal-forwarding)
8. [paseo-relay reuse](#8-paseo-relay-reuse)
9. [Security requirements](#9-security-requirements)
10. [Versioning and compatibility](#10-versioning-and-compatibility)

## 1. Terminology and scope
| Term | Meaning |
|---|---|
| **daemon** | A DSH device that accepts remote control (Linux desktop, Linux server, macOS desktop). |
| **controller** | A DSH device that initiates remote control of a daemon. |
| **pairing** | The out-of-band exchange that gives a controller a daemon identity and a grant, using a QR code or link. |
| **pairing ticket** | The signed, expiring payload inside a pairing QR code or link. |
| **direct transport** | The controller connects to the daemon's own WebSocket listener over a LAN or Tailscale. |
| **relay transport** | Both sides connect outbound to a paseo-relay, which forwards opaque frames keyed by `serverId`. |
| **portal** | A controller-local reverse proxy on `127.0.0.1:<random port>` that carries a browser's HTTP/WS traffic for the remote DSH Web UI over the Mesh session. |
| **SAS** | A six-digit short authentication string shown on both devices for human comparison. |
| **scope** | The grant attached to a peer: `control` (v1) or the reserved `view`. |

Goals: one protocol for every authorized direction, roles decided by who
initiates; interchangeable transports carrying the same end-to-end encrypted
session; scannable pairing with fingerprints, endpoints and a one-time token;
per-peer grants and an audit trail; visibly distinct local and remote workspaces.

Non-goals for v1: file transfer, clipboard sync, screen streaming, multi-hop
relays, Paseo's native frame format (only relay routing is reused) and a native
mobile application. The controller is a Web client plugin runnable in a mobile
browser or WebView on Android, iOS or HarmonyOS; mobile daemon capability waits
for official DSH support.

## 2. Device identity
On first start the host plugin creates `$DSH_HOME/device-mesh/identity.json`
(mode `0600`; directory `0700`):

```jsonc
{
  "version": 1,
  "deviceId": "dm_7f3a…",              // "dm_" + 22 lowercase base32 chars
  "name": "<device-name>",             // human-readable, not a secret
  "platform": "darwin", "createdAt": "2026-11-09T00:00:00.000Z",
  "signPk": "<b64url raw Ed25519 public key>",
  "dhPk": "<b64url raw X25519 public key>",
  "signSk": "<b64url PKCS#8 Ed25519 private key>",
  "dhSk": "<b64url PKCS#8 X25519 private key>"
}
```
- Ed25519 (`signPk`/`signSk`) signs pairing tickets and session authenticators;
  X25519 (`dhPk`/`dhSk`) is the Noise static key pair.
- `deviceId` is `dm_` plus the first 22 lowercase base32 characters of
  `SHA-256(raw Ed25519 public key)`. It is a public label, not a credential.
- Private keys never leave the host, enter a QR code, or appear in logs or audit;
  tickets carry public keys only, and a receiver rejects a `deviceId` mismatch.

## 3. Pairing
A daemon creates a one-time record (default lifetime 10 minutes) and renders:

```
dsh-mesh://pair?d=<base64url(UTF-8 JSON)>
```
```jsonc
{
  "v": 1, "id": "dm_…", "name": "<device-name>", "platform": "linux",
  "signPk": "<b64url>", "dhPk": "<b64url>",
  "eps": [                                    // preference order
    { "k": "direct", "url": "ws://<lan-ip>:45871/mesh" },
    { "k": "direct", "url": "ws://<tailscale-ip>:45871/mesh" },
    { "k": "relay", "url": "wss://relay.example.com/ws", "sid": "<relay-server-id>", "v": 2 }
  ],
  "tok": "<b64url 32 random bytes>", "exp": 1762742400,  // one-time token; Unix seconds
  "sig": "<b64url Ed25519 signature>"
}
```
- Canonical JSON sorts keys ascending, emits no whitespace and omits `sig`. `sig`
  is Ed25519 over the UTF-8 canonical JSON of `v`, `id`, `name`, `platform`,
  `signPk`, `dhPk`, `eps`, `tok` and `exp`.
- The receiver verifies `sig` before using any field; failure discards the ticket.
  It also requires `id` to equal the derived `deviceId`, at least one well-formed
  endpoint, 32-byte `tok`, 64-byte `sig`, `v: 1` and a future `exp`.
- `tok` is a bearer secret valid for one pairing; the daemon stores only its
  SHA-256 and reserves it before approval, so expired or reused tokens fail.
- A new controller needs explicit local approval by default, showing its name,
  platform and SAS; auto-approval is an explicit opt-in setting. The daemon then persists
  the controller keys and scope in `peers.json`; the controller persists the
  daemon keys, relay route and endpoint cache.
- The default grant is `{ kind: "control", workspaces: "all", expiresAt: null }`;
  `view` is reserved. Revocation sets `revokedAt`, refuses new handshakes, closes
  live sessions, and is re-checked with expiry on every RPC. Pairing, connections,
  revocation, portal opens and failed authentication (reason code only) go to
  `audit.jsonl` without contents.
- A pairing ticket advertises a relay endpoint only while this device serves
  relay (`relay.enabled`). An endpoint configured solely for outbound controller
  sessions is never advertised. A paired daemon with no cached endpoint must be
  re-paired; this device's own relay `serverId` is never used as a fallback.
- A pending first-contact request is denied when its controller session closes
  before the local user decides. The controller waits up to the daemon's request
  TTL plus 30 s, so it never rolls back while the daemon can still approve.

## 4. Transport
### 4.1 WebSocket carrier
All Mesh messages are **binary** WebSocket messages; text frames are ignored.
One WebSocket message carries exactly one Mesh frame.

- A sealed plaintext message is at most 64 KiB. Larger HTTP or WebSocket payloads
  are split into stream chunks (§6). Handshake messages are at most 4 KiB and
  encrypted application-auth messages at most 16 KiB.
- Handshake frames start with `0x01`. After the handshake every frame starts with
  `0x02` (Noise transport); the sealed plaintext starts with `0x10` (control) or
  `0x11` (stream).
- The `0x01` prefix keeps Mesh frames from resembling the JSON that paseo-relay
  inspects during handshake hygiene.

### 4.2 Direct transport
- The daemon runs its own listener, independent of the DSH Web port: default
  `0.0.0.0:45871`, path `/mesh`, both configurable. Loopback is not advertised
  because it only reaches the daemon itself.
- Ticket URLs are enumerated in preference order: private LAN IPv4, Tailscale
  CGNAT (`100.64.0.0/10`), other global IPv4, then IPv6. Loopback, link-local,
  docker/bridge/virtual interfaces and duplicates are skipped.
- Only non-browser clients are accepted. Any request with an `Origin` header is
  rejected with HTTP `403` before the upgrade completes. Path mismatch is `404`,
  a non-WebSocket request `426`, too many global connections `503`, and too many
  connections from one address `429`.
- Default caps are 16 global connections and half that per IP (at least 2), and
  at most 60 HTTP upgrade attempts per address per minute (further attempts get
  `429` until the window resets); the controller dials
  `ws://<host>:<port>/mesh`.

### 4.3 Relay transport
See §8. Relay frames are the same `0x01` handshake and `0x02` sealed frames as
direct; the relay never parses them.

### 4.4 Endpoint selection, liveness and reconnect
- The controller tries ticket endpoints in order and keeps the first that
  completes Noise plus application authentication; it moves that endpoint to the
  front of the cached list.
- Transports send WebSocket pings every 20 s (direct) or 10 s (relay); a socket
  with no inbound traffic for a full interval is terminated.
- While a controller session is open, the broker sends an application heartbeat
  every 30 s. A missed `ping` is advisory (logged only): the transport close event
  is the authoritative liveness signal, and the per-carrier WebSocket heartbeat
  (20 s direct / 10 s relay) already terminates a dead socket.
- Reconnect backoff is exponential, 1 s to 30 s. A user disconnect does not
  reconnect. Portal requests fail with `502` while the session is down; the portal
  stays open and shows reconnect state.

## 5. Secure channel
### 5.1 Noise NK handshake
The channel uses **Noise_NK_25519_ChaChaPoly_SHA256**, Noise revision 34, with
prologue `dsh-mesh/1` (ASCII, no terminator). The daemon's X25519 static public
key is distributed out of band and pinned by the controller; NK's `<- s`
pre-message authenticates the daemon during the handshake.

```
controller (initiator)                          daemon (responder)
  [0x01] msg1  (-> e, es)  ──────────────────────────────▶
                            ◀──────────────────────────────  [0x01] msg2  (<- e, ee)
```
- The controller passes the pinned `dhPk` as the remote static key; the daemon
  uses `dhKey`. `split()` derives independent tx/rx cipher states, and the final
  handshake hash `h` binds application authentication and the SAS.
- A `0x02` frame before the handshake, a `0x01` frame after it, a malformed or
  oversized message, or a low-order/all-zero key closes `4400` (`4401` for auth).
- Handshake payloads are empty. PSK support exists only to reproduce official
  noise-c test vectors; production sessions never set a PSK.

### 5.2 Application authentication
The controller sends its first **sealed** message immediately after the
handshake:

```jsonc
// Already paired
{ "t": "client_auth", "v": 1,
  "controller": { "deviceId": "dm_…", "name": "<device-name>", "platform": "linux",
                  "signPk": "<b64url>", "dhPk": "<b64url>" },
  "nonce": "<b64url 32 bytes>",
  "auth": { "kind": "paired", "sig": "<b64url Ed25519(signSk, h || \"client_auth\")>" } }
// First contact, using the one-time token
{ "t": "client_auth", "v": 1, "controller": { … }, "nonce": "<b64url 32 bytes>",
  "auth": { "kind": "pair-token", "daemonId": "dm_…", "token": "<b64url 32 bytes>" } }
```
The daemon replies with a sealed `server_auth`:

```jsonc
{ "t": "server_auth", "v": 1,
  "daemon": { "deviceId": "dm_…", "name": "<device-name>", "platform": "linux",
              "signPk": "<b64url>", "dhPk": "<b64url>" },
  "approval": "none" | "pending",
  "requestId": "<present only when approval is pending>",
  "sig": "<b64url Ed25519(signSk, h || \"server_auth\" || controllerNonce)>" }
```
1. The controller must verify that `daemon.signPk`/`dhPk` equal the pinned values.
   A mismatch is an identity change: close and alert the user.
2. For `paired`, the daemon checks revocation and grant expiry, then verifies the
   controller signature. Unknown, revoked or expired peers fail with
   `mesh/unauthorized`/`mesh/revoked` and close `4403`.
3. For `pair-token`, the daemon checks `daemonId`, the token hash, expiry and
   unused state, then queues a local approval and replies `approval: "pending"`
   with a `requestId`. Until approval, only `pair.status` is allowed and no portal
   stream is accepted; denial or timeout closes the session.
4. The controller verifies the daemon signature, then polls `pair.status`. Once
   the daemon persists the controller record and returns the peer, the session is
   usable and the device is online.
5. `nonce` must be 32 bytes. The daemon keeps a 10-minute replay cache and rejects
   a repeated nonce with `4403`.
6. The first Noise frame must arrive within 10 s of the channel opening, and
   application authentication must finish within 60 s of the channel opening
   (the first-frame window is included); otherwise the daemon closes with `4408`.

### 5.3 SAS
```
ikm  = h
salt = lower(bytes(signPkA)) || higher(bytes(signPkB))   // bytewise sort
info = "dsh-mesh/1 sas"
SAS  = HKDF-SHA256(ikm, salt, info, L=4) read big-endian
       % 1_000_000, zero-padded to six digits, formatted "123-456"
```
Both sides display this value; the user compares it before approving. Sorting the
two Ed25519 public keys makes the result role-independent.

### 5.4 Sealed frames and close codes
```
sealed frame   = 0x02 || Noise CipherState.encrypt(plaintext)
plaintext      = 0x10 || UTF-8 JSON
               | 0x11 || u32 streamId (BE) || u8 flags || payload
```
- Each WebSocket message is one Noise message; the CipherState nonce increments
  once per message. Decryption failure (tamper, reorder, replay, reflection)
  closes with `4401` and stops all sending. Rebuild before the send counter wraps;
  this is unreachable in normal operation.
- The stream header is 6 bytes. `streamId` is non-zero 31-bit, allocated by the
  opener: odd for controller-opened streams, even for daemon-opened streams.
- `flags`: `0x01` data, `0x02` end of stream, `0x04` abort (UTF-8 error code),
  `0x08` end of one WebSocket message (`portal.ws` only). An abort is final. A
  frame for an unknown `streamId` is ignored (a frame racing an abort must not
  close an unrelated session); a duplicate id fails that RPC with
  `mesh/bad-request` without closing the session. Chunks over 32 KiB or other
  framing violations close `4400`.

| Close code | Meaning |
|---|---|
| `1000` | Normal closure or session finished. |
| `4400` | Protocol error: bad framing, unexpected phase, invalid control message. |
| `4401` | Cryptographic failure: AEAD or handshake authentication. |
| `4403` | Unauthorized: unknown, revoked or expired peer, bad signature, replayed nonce. |
| `4408` | Application authentication timed out. |

The close reason is a stable `mesh/…` or `portal/…` code, never a payload or
secret.

## 6. Session multiplexing and RPC
Control JSON travels inside `0x10`:

```jsonc
{ "id": 17, "method": "workspaces.list", "params": {} }        // request
{ "id": 17, "result": { … } }                                 // success
{ "id": 17, "error": { "code": "mesh/…", "message": "…" } }    // failure
{ "event": "workspaces.changed", "data": { … } }               // event (no id)
{ "ping": 123 }  /  { "pong": 123 }                           // control heartbeat
```
- `id` is allocated by the requester from `1..2^31-1`, unique per session; a
  response echoes it.
- v1 permits controller-to-daemon requests only; a daemon rejects controller-role
  calls with `mesh/unsupported`.
- Events are daemon-to-controller and carry no `id`. v1 defines the envelope but
  emits no events; `workspaces.subscribe` is acknowledged for forward
  compatibility and controllers poll `workspaces.list`.
- `ping`/`pong` are the control heartbeat; the separate `ping` RPC is diagnostic.

| Method | Params | Result | Notes |
|---|---|---|---|
| `info` | `{}` | `{ device: { deviceId, name, platform, signPk, dhPk, appVersion }, protocol: 1, capabilities: ["rpc","portal","workspaces","pairing","relay"], hostLabel }` | First call after authentication. |
| `workspaces.list` | `{ refresh?: boolean }` | `{ updatedAt, workspaces: [Workspace], truncated?: boolean }` | Cached 60 s unless `refresh` is true; `truncated` means the wire budget dropped rows. |
| `workspaces.subscribe` | `{ intervalMs?: number }` | `{ ok: true }` | Acknowledged; v1 controllers poll. |
| `workspaces.subscribe` | `{}` | `{ ok: true }` | No-op in v1; controllers poll. |
| `session.archive` | `{ sessionId, stopActivity? }` | `{ archived: true }` | Requires a control grant. Calls the daemon's registry archive set. |
| `session.unarchive` | `{ sessionId }` | `{ archived: false }` | Requires a control grant. Idempotent. |
| `portal.prepare` | `{}` | `{ ok: true }` | Optional warm-up of the local DSH browser session. |
| `portal.http` | `{ streamId, method, path, headers }` | `{ streamId, status, headers }` | Request/response bodies follow on the same stream. |
| `portal.ws.open` | `{ streamId, path, headers, protocols?, compress? }` | `{ streamId, protocol?, compressed? }` | Duplex WebSocket messages follow on the same stream. |
| `pair.status` | `{ requestId }` | `{ state: "pending" \| "approved" \| "denied", peer? }` | Only call allowed before approval. |
| `ping` | `{}` | `{ now }` | Health/diagnostic check. |

`Workspace`:

```jsonc
{
  "id": "<workspace-id>", "title": "<workspace-title>", "path": "<workspace-path>",
  "sessions": [{
    "id": "<session-id>", "title": "<session-title>", "updatedAt": "2026-11-09T00:00:00.000Z",
    "running": false, "awaitingUser": false, "unread": false, "archived": false
  }]
}
```
`archived` is optional (older daemons omit it); the remote mirror treats an absent
field as not archived.
Workspace listings report at most 200 sessions per workspace and at most 200
sessions across the whole listing (100 workspaces maximum); the result is also
trimmed so its JSON fits one 64 KiB control frame. When anything is dropped the
result carries `truncated: true`. Fields are derived from DSH workspace/session
services and may be conservative when unavailable.

Error codes are `<domain>/<reason>`: `mesh/unauthorized`, `mesh/revoked`,
`mesh/bad-request`, `mesh/not-found`, `mesh/unsupported`, `mesh/busy`,
`mesh/rate-limited`, `mesh/version-mismatch`, `mesh/crypto`, `mesh/internal`,
`portal/unavailable`, `portal/upstream-error`. `mesh/rate-limited` is reserved for
local admission limits; v1 applies connection and queue caps rather than a
per-IP handshake limiter.

Limits: 30 s per-RPC timeout; 32 concurrent streams (excess fails `mesh/busy`);
8 MiB inbound buffer per stream; backpressure at 1 MiB; 64 outstanding RPCs and
32 concurrent handlers on a daemon; control headers limited to 64 entries, 256-byte
names and 8192-byte values; portal paths at most 8192 bytes, starting with `/` and
not `//`.

## 7. Portal forwarding
The portal lets a controller browser load the **complete remote DSH Web UI**
without making DSH itself multi-host.

```
browser ──HTTP/WS──▶ controller host plugin (127.0.0.1:<portal-port>)
                          │ Mesh secure session (direct or relay)
                          ▼
                   daemon host plugin ──HTTP/WS──▶ daemon DSH Web server (127.0.0.1:<dsh-port>)
```
### 7.1 Controller-side portal server
- Binds `127.0.0.1` only, on an OS-assigned port. The local API returns
  `http://127.0.0.1:<port>/?token=<32-byte base64url token>`.
- The first valid `?token=` navigation gets a `303` with
  `Set-Cookie: <portal-cookie>=<token>; Path=/; HttpOnly; SameSite=None; Secure`
  (loopback is a secure context). The token remains usable until the portal
  closes.
- Browser cookies are scoped to the **host**, not the port, so loopback portals
  share a cookie jar. Isolation is enforced by request checks, not by the cookie
  name: every request must carry the exact `Host` authority
  (`127.0.0.1:<portal-port>`); HTTP requests must be same-origin
  (`Sec-Fetch-Site: same-origin` or `none`, plus a matching `Origin` when
  present); a cookie-authenticated request with no `Sec-Fetch-Site` is rejected,
  so browser Fetch Metadata is required (non-browser cookie clients are not
  supported); and WebSocket upgrades must carry exactly the portal's `Origin`. This prevents another loopback page from borrowing an open portal's
  cookie. A cookie is host-scoped, not port-scoped, so a different local HTTP
  server that the user visits can still read it server-side; treat local
  processes as partially trusted and close unused portals.
- Portal proxy requests are idempotent-retryable across a controller reconnect:
  a request that arrives while the session is closed waits for `adoptSession`,
  and GET/HEAD/OPTIONS plus WebSocket upgrades retry once.
- `portal.prepare` is a daemon RPC that acquires the local DSH browser session
  before the controller returns the portal URL, so the first asset burst does
  not race a cold cookie.
- A capability-token navigation from another loopback origin is a normal way to
  open remote control (popup/iframe). Because a browser may not apply a cookie
  set through a cross-site redirect, that path receives a same-origin bootstrap
  page (status `200`) which sets the cookie and immediately navigates to the
  token-free path. Cookie-authenticated requests are still fenced to
  `same-origin`/`none`.
- WebSocket upgrades with a valid token or cookie are admitted after the checks
  above; browsers do not follow redirects for upgrades. Allowed methods are
  `GET`, `HEAD`, `POST`, `PUT`, `PATCH`, `DELETE` and `OPTIONS`; anything else is
  `405`, and a missing or wrong token/cookie is `403`. The portal strips `?token=`
  from every forwarded path (including WebSocket and non-GET requests), so the
  capability never reaches the daemon's request path, `Referer` or logs.
- Idle portals close after 30 minutes and are closed on forget/revoke. A
  transient mesh-session loss keeps the portal server and its capability URL
  alive: requests fail with `502` until the controller reconnects, then the
  broker hands the portal the new session, so the same tab recovers without
  being reopened. URLs, tokens and cookies never enter logs or audit.

### 7.2 HTTP exchange
1. The controller allocates an odd `streamId` and sends
   `{ "id": n, "method": "portal.http", "params": { "streamId": s, "method": "GET", "path": "/…", "headers": {…} } }`.
2. The browser request body, if any, follows as `0x11` chunks; an empty body ends
   the stream immediately.
3. The controller strips hop-by-hop headers, `Host`, `Cookie`, `Origin`,
   `Referer`, `Content-Length`, `sec-fetch-*`, forwarding markers and any
   `X-DSH-Mesh-*`, then adds `X-DSH-Mesh-Peer` and `X-DSH-Mesh-Version: 1`.
4. The daemon validates method, path and headers, obtains its in-memory DSH cookie
   and forwards to its local origin. `Host` is implied by that origin; `Origin`
   and `Referer` are rewritten to it, `Sec-Fetch-Site` becomes `same-origin`, and
   `Accept-Encoding` is forced to `identity`. Hop-by-hop, credential,
   `sec-fetch-*` and the whole DSH-owned `x-dsh-*` namespace (including
   `X-DSH-Mesh-*`, `x-dsh-auth-token` and `x-dsh-file`) are not trusted; only
   allowlisted ordinary headers plus safe `x-*` headers are forwarded.
5. The daemon replies with
   `{ "id": n, "result": { "streamId": s, "status": 200, "headers": {…} } }` and
   streams the body back as `0x11` chunks ending with an end flag. Errors use an
   abort flag with a stable portal code; the controller sanitizes response
   headers and streams status, headers and body to the browser in order.

Both sides drop hop-by-hop headers. The daemon drops `Set-Cookie`,
`Content-Encoding` and `Content-Length` because the body is re-streamed decoded.
The controller drops `Set-Cookie`, `X-Frame-Options`, CSP `frame-ancestors` and
report-only CSP so the local page can embed the proxy in an iframe, and adds
`X-Content-Type-Options: nosniff` to every proxied response. A same-origin
absolute `Location` becomes path-relative so the browser stays on the portal
origin. The daemon's DSH cookie never crosses the Mesh.

### 7.3 WebSocket exchange
1. The browser sends `Upgrade: websocket`; the controller validates the
   token/cookie, accepts the upgrade and records the requested subprotocols.
2. The controller sends
   `{ "id": n, "method": "portal.ws.open", "params": { "streamId, path, headers, protocols?, compress? } }`.
   The daemon dials the local DSH WebSocket with its cookie and sanitized headers,
   then replies `{ streamId, protocol?, compressed? }` or an error.
3. Each message is one or more `0x11` chunks. The last chunk sets `0x08`
   (`MESSAGE_END`); an empty message is `Data | MESSAGE_END` with no payload.
   Each chunk is within the 64 KiB sealed limit, so larger messages span chunks.
   **The message payload starts with one byte carrying the WebSocket opcode**
   (`0x00` = text, `0x01` = binary), because the DSH Remote-stream gateway
   requires text frames; the receiver must forward it as `string` or bytes
   accordingly. HTTP streams never carry this byte.
   The same byte is `0x02` (gzip text) or `0x03` (gzip binary) when the message
   is compressed. The controller opts in per exchange with
   `params.compress: true`; the daemon replies `compressed: true` only when it
   supports the feature, so a mixed-version pair keeps using `0x00`/`0x01`. The
   daemon gzips messages of at least 1024 bytes in both directions before the
   Mesh framing splits them, and inflates a tagged message on receipt. This is
   independent of `ws` per-message deflate, which is hop-by-hop and would not
   reduce the Mesh/relay transfer.
   Either side closing ends the stream; an abnormal close uses the abort flag with
   a stable code, and the daemon closes upstream with `1000`/`1011`.

### 7.4 Daemon-side DSH authentication
- The daemon gets its local origin from `ctx.webServer.getOrigin()` and an
  authenticated launch URL from `ctx.connection.authenticatedUrl(origin)`.
- It follows the resulting `303` manually so the DSH `Set-Cookie` is visible, then
  keeps only `dsh-auth-*=<value>` in memory. The cookie is refreshed near expiry
  or after an upstream `401`, with one retry; failure returns `portal/unavailable`.
- The cookie is scoped to the local DSH origin and is never sent over the Mesh,
  written to disk or logged. `portal.prepare` may warm it, but requests also
  acquire it lazily.

### 7.5 Deep links
The portal iframe may carry `?dm-session=<session-id>&dm-embed=1`. The portal
response stores the id in `sessionStorage` and the remote copy of this plugin
opens that Session through `uiWorkspace.openSession` once the shell is ready,
while `dm-embed=1` injects the layout override that collapses the remote
sidebars. This is best effort: when DSH's UI surface changes, or the remote
document's CSP forbids inline script/style, the layout/deep-link injection is
skipped and the user lands on the remote home page and navigates inside it.

A parent that wants a new Session carries
`?dm-new-session=<workspace-id>&dm-new-session-request=<id>` instead. The portal
stores `{workspaceId, requestId}` in `sessionStorage`; the remote plugin calls
the shell's native `uiWorkspace.startSession(workspaceId)` once ready. The same
request can also arrive as a `postMessage` with `kind: "new-session"` while an
already-loaded iframe is reused; the request id makes both delivery paths
idempotent. The URL parameters and storage entry are consumed on first use so an
iframe reload cannot create a second blank Session.

## 8. paseo-relay reuse
The Mesh reuses paseo-relay **routing only**; the relay sees an opaque stream.

- v2 daemon: control socket
  `wss://<relay>/ws?serverId=<sid>&role=server&v=2` (no `connectionId`) receives
  `{"type":"sync","connectionIds":[...]}`. For each `connected` event it opens
  `wss://<relay>/ws?serverId=<sid>&role=server&v=2&connectionId=conn_…`; each data
  socket is one Mesh transport running the Noise handshake.
- v2 controller: `wss://<relay>/ws?serverId=<sid>&role=client&v=2` without a
  `connectionId`; the relay allocates `conn_…` and pairs it with a daemon data
  socket, closing `1013` if none attaches in time.
- `disconnected` removes the data socket; losing the control socket closes every
  data transport and reconnects with the same backoff. The control channel is
  JSON (`sync`, `connected`, `disconnected`, `ping`/`pong`); Mesh frames never
  traverse it. The relay's hygiene prefilter only inspects frames starting with
  `{`, so `0x01`/`0x02` Mesh frames are ignored.
- v1 fallback: daemon `role=server&v=1`, controller `role=client&v=1`; one
  `serverId` serves one client and a new same-role socket replaces the old one
  with `1008`. The shipped broker starts the v2 daemon only; a controller still
  dials a ticket advertising `v: 1` when talking to an older daemon.
- `serverId` is a bearer routing secret, not an identity: 32 random base64url
  bytes per daemon, rotatable, never derived from `deviceId`, hostname or username,
  and redacted from logs. Anyone who knows it can attach to or replace a relay
  session; encryption prevents impersonation and decryption, not denial of
  service. Public deployments need TLS and the relay origin allowlist; relay mode
  opens no public inbound port.

### Relay constraints

The relay is a shared, unauthenticated byte pipe. These limits and close
semantics are transport assumptions; the values come from the paseo-relay v0.1.2
protocol and may change with the deployed relay version.

| Constraint | Value | Consequence for the Mesh |
|---|---|---|
| Relay data frame | about 32 MiB − 14 bytes | Sealed frames are at most 64 KiB (§4.1), far below the limit, so one Mesh message never needs relay fragmentation. |
| v2 control message | 64 KiB | The control socket carries only `sync`, `connected`, `disconnected` and `ping`/`pong`; Mesh frames never traverse it. |
| v2 clients per `connectionId` | 32 by default, configurable | Each controller consumes one client socket. A daemon with more simultaneous controllers than the relay allows needs a higher limit or a hub design; excess attaches are refused rather than queued. |
| Close `1008` | Replaced / policy | The socket lost a replacement race or was rejected by policy. Reconnect with backoff and expect a new `connectionId`; do not reuse the old data socket. |
| Close `1012` | Data socket gone / relay shutdown | The transport is gone (relay restart, drain, or data-socket loss). Fail in-flight portal requests, rebuild the transport and run the Noise handshake again. |
| Close `1013` | No data route / budget / slow consumer | Usually transient: the data socket has not attached, admission is exhausted, or a writer queue is full. Retry with backoff; repeated `1013` is a capacity or admission problem, not a protocol error. |

- **TLS is mandatory in public.** A relay deployment exposes `wss://` only, with
  the relay origin allowlist configured; plain `ws://` is for loopback testing.
- **The relay authenticates nobody.** E2EE and one-time pairing are the
  authentication layer, not defense in depth. The relay sees routing metadata,
  frame sizes and timing, and can drop, delay or replace close codes; it is not a
  reliable message bus and provides no availability guarantee.
- **`serverId` hygiene.** Generate 32 random base64url bytes per daemon, rotate
  it on suspicion, never derive it from a device id or host name, and keep it out
  of logs, metrics and access-log query strings.
- **Frame hygiene.** Every Mesh frame starts with `0x01` or `0x02`, so the relay's
  JSON handshake prefilter never inspects it. Keep that property; if a future
  frame is JSON, avoid the names `hello` and `e2ee_hello` unless its `key` is a
  canonical X25519 public key.

## 9. Security requirements
1. **End-to-end encryption.** Direct and relay both run §5; a relay cannot read or
   modify a payload without detection.
2. **Identity pinning.** Both sides pin peer keys; a key change requires
   re-pairing and a clear warning.
3. **One-time pairing token.** 32 random bytes, 10-minute TTL, SHA-256 at rest,
   reserved before approval; expired or reused tokens are rejected.
4. **Explicit local approval.** New controllers need approval by default;
   auto-approval is opt-in only.
5. **Least privilege.** Default `control` scope; expiry and revocation are checked
   on every RPC, and revoking closes live sessions.
6. **Portal isolation.** Loopback bind, random port, 32-byte capability token,
   `HttpOnly; SameSite=None; Secure` cookie, method allowlist and body/stream
   caps. The portal requires the exact `Host` authority; browser HTTP requests are
   limited to same-origin (or a top-level navigation), cookie-authenticated
   requests require `Sec-Fetch-Site` (`same-origin` or `none`), and WebSocket
   upgrades must carry the portal's `Origin`. The `?token=` capability is stripped from every forwarded path, and
   `Host`/`Origin`/`Referer` are rewritten to the daemon's local DSH origin
   before forwarding. The DSH cookie is never exposed to the controller.
7. **Secret hygiene.** Keys, tokens, nonces, handshake hashes and the DSH cookie
   never enter logs or audit; state is `0600` in a `0700` directory. The portal
   token is not forwarded to the daemon and does not enter its `Referer` or
   access logs.
8. **Resource limits.** 4 KiB handshake, 16 KiB auth, 64 KiB sealed, 32 KiB
   chunks, 32 streams, 8 MiB inbound buffer, 16 direct connections (half per IP),
   64 inbound sessions (8 per controller, admitted before the handshake), 8
   pending pairings, 64 MiB portal body, 100 workspaces / 200 sessions per
   listing, 4 MiB / 5 s asset-manifest read, 256 MiB portal cache, 64 headers,
   8 MiB audit rotation.
9. **No silent downgrade.** Version mismatches are rejected and `v` is checked
   during authentication; the controller also requires `info.protocol === 1`.
10. **Minimal trusted code.** Transport uses `ws`; Ed25519, X25519, SHA-256 and
    HKDF use `node:crypto`; ChaCha20-Poly1305 uses `@noble/ciphers`. No primitive
    is implemented by hand.
11. **Relay TLS.** A non-loopback relay endpoint must be `wss://`; the host
    rejects a plain `ws://` endpoint for non-loopback hosts. `ws://` is accepted
    only for a relay bound to loopback for local testing.

## 10. Versioning and compatibility
- The wire version is **1** (`PROTOCOL_VERSION`); incompatible changes bump it.
- Pairing tickets carry `v: 1`; `client_auth` and `server_auth` carry `v: 1`. Any
  other version is rejected with `mesh/version-mismatch` and close `4400`; there
  is no negotiation or silent fallback.
- After authentication the controller requires `info.protocol === 1`, otherwise
  it closes and reports `mesh/version-mismatch`.
- Paseo's native protocol is **not** compatible; only relay routing is shared.
- DSH compatibility is declared by `engines.dsh` (`>=0.2.2-rc.1 <0.3.0` at the
  MVP); the DSH loader skips the plugin on unsupported versions, never degrading.
- The plugin version is independent of the wire version; upgrades keep identity
  and peer records, and only an incompatible wire change needs re-pairing.

## Related docs
- [README](../README.md) — installation, pairing and day-to-day usage.
- [CONTRIBUTING](../CONTRIBUTING.md) — contribution workflow and review expectations.
- [SECURITY](../SECURITY.md) — vulnerability reporting and disclosure policy.
- [Design](DESIGN.md) — architecture, threat model, DSH integration and roadmap.
- [Development](development.md) — build, packaging, DSH integration points, testing and releases.
- [ADR 0001](adr/0001-remote-control-in-dsh.md) — why full remote control uses a host-side mesh plus a loopback portal.
- [Docs index](README.md) — the full documentation map.
