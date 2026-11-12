# DSH Device Mesh — Architecture and Security Design
[简体中文](zh/DESIGN.zh.md) | English

Status: **developer preview** (plugin `0.1.0`, targeting DSH `0.2.2-rc.2`). The wire contract is
normative in [PROTOCOL.md](PROTOCOL.md); this document explains why the system is
built this way, where its boundaries are, and how it evolves.

## Contents
1. [Goals and non-goals](#1-goals-and-non-goals)
2. [Architecture](#2-architecture)
3. [Transport matrix](#3-transport-matrix)
4. [Pairing flow](#4-pairing-flow)
5. [Portal design](#5-portal-design)
6. [Data and persistence](#6-data-and-persistence)
7. [Security model and threats](#7-security-model-and-threats)
8. [DSH integration](#8-dsh-integration)
9. [Platform matrix](#9-platform-matrix)
10. [Testing strategy](#10-testing-strategy)
11. [Roadmap and risks](#11-roadmap-and-risks)

## 1. Goals and non-goals
The project connects multiple devices running DeepSeek Harness into a **device
mesh**: after pairing once, any paired device can act as a **controller** and
remotely view and operate another device's DSH as the **daemon**.

| Goal | Design response |
|---|---|
| Any authorized direction between A/B/C/D | One symmetric package; the role is decided by who dials, not by platform. |
| LAN/Tailscale and public paths | Interchangeable direct and relay carriers under one end-to-end encrypted session. |
| Scan-to-pair | A signed, one-time QR/link ticket plus local approval and a six-digit SAS. |
| Security comparable to Paseo remote control | Noise NK, pinned keys, one-time tokens, per-peer grants, revocation and audit. |
| Local vs remote clarity | A host switcher is injected directly above the native **Workspaces** section, showing the current host and listing paired remotes plus Add host; the Devices panel follows the selection and shows a selected-host card. Remote rows carry a Remote badge and open the portal. Add host is one scan/paste pairing dialog. |

Non-goals for v1: file transfer, clipboard sync, screen streaming, multi-hop
relays, Paseo application-protocol interoperability, and a native mobile app.
Remote control ends at the remote DSH Web UI behind a portal, not at a second DSH
client tree inside the controller.

## 2. Architecture
Every device installs the same plugin bundle with two halves. The **host plugin**
runs as trusted in-process Node code inside the DSH host. The **client plugin**
runs in the browser and only talks to its own host over the same-origin local API.

```
                         ┌──────────── DSH host process (A/B/C) ────────────┐
  browser (local DSH UI) │ host plugin dsh-device-mesh                    │
  ┌──────────────────┐   │ ├─ identity / peers / audit ($DSH_HOME)          │
  │ client plugin    │──▶│ ├─ broker (sessions, pairing, status)            │
  │ • Devices panel  │API│ ├─ direct listener  ws://0.0.0.0:45871/mesh     │
  │ • pairing QR     │   │ ├─ relay daemon      wss://relay (outbound)      │
  │ • remote groups  │   │ ├─ controller sessions (Noise)                   │
  │ • open portal    │   │ ├─ portal-controller 127.0.0.1:<random port>     │
  └──────────────────┘   │ └─ portal-daemon → local DSH Web (127.0.0.1)     │
                         └──────────────────────────────────────────────────┘
                                          ▲
                          Noise NK + application auth (end-to-end)
                                          ▼
                            the same plugin on another device (symmetric)
```
Component responsibilities:

- **Store/pairing** own `identity.json`, `peers.json`, `settings.json`, hashed
  one-time tokens, the audit trail and the local approval queue/SAS.
- **Broker** is the composition root: it starts the listeners, accepts inbound
  channels, dials controllers, tracks status, serves the local API and owns portal
  lifecycles.
- **Channel/session** runs Noise, application authentication, RPC and stream
  multiplexing; **transports** implement the same `MeshTransport` seam over direct
  or paseo-relay v2/v1 sockets.
- **Portal daemon/controller** implement the two halves of the reverse proxy;
  **Web API** exposes `POST /api/device-mesh`, and the **client plugin** renders
  the sidebar host switcher, Devices panel, pairing UI and per-host workspace groups.

Three facts drive the design:

1. The DSH client is **single-host**: `ctx.connection`, `ctx.sessions` and
   `ctx.workspaces` are singletons, with no multi-host or deep-link frontend. The
   plugin pulls **metadata** (workspaces/sessions/status) over Mesh RPC into its
   own panel, while **full remote operation** uses a portal to the remote DSH Web
   UI.
2. The host plugin is trusted same-process Node code: it can listen, open outbound
   WebSockets, read/write `$DSH_HOME`, and use `ctx.webServer`/`ctx.connection`.
   Desktop DSH binds only `127.0.0.1`, so a daemon must expose its own transport.
3. The client plugin is not a network peer. It never sees peer keys or tokens; it
   calls the host's cookie-authenticated local API.

## 3. Transport matrix
| Path | Carrier | Behavior |
|---|---|---|
| Same LAN / Tailscale | Direct: plugin-owned `ws://<ip>:45871/mesh` | Independent of the DSH Web port; ticket URLs prefer private LAN, then `100.64/10`, then global IPv4/IPv6; listener rejects browser `Origin`; configurable port and disable switch. |
| Public internet | Relay: paseo-relay v2 | Daemon keeps one outbound control socket and one data socket per controller; controller keeps one outbound client socket; relay forwards opaque encrypted frames. |
| Older relay | Relay v1 | One client per `serverId`; a new socket replaces the old one. Used only when a ticket advertises v1. |

Both carriers sit below the same Noise channel, so the session layer, RPC,
workspace metadata and portal are transport-agnostic. A relay deployment never
requires an inbound port on the daemon.

Endpoint selection follows ticket order; a successful endpoint is promoted in the
peer cache. Direct heartbeat is 20 s, relay heartbeat 10 s. Controller sessions
are health-checked with an application heartbeat every 30 s; a missed ping is
advisory because the per-carrier WebSocket heartbeat (and its close event) is the
authoritative liveness signal. Reconnect backoff is 1 s to 30 s. A ticket
advertises relay only while this device serves relay; a configured endpoint used
only for outbound controller sessions stays out of the ticket, and a peer with no
cached endpoint must be re-paired rather than dialing this device's own relay
`serverId`.

## 4. Pairing flow
```
daemon A                                      controller C / D
Devices panel → create ticket                 Devices panel → Add device
┌──────────────────────┐   QR / link        ┌──────────────────────┐
│ dsh-mesh://pair?d=…  │ ─────────────────▶ │ scan or paste link    │
│ one-time token, 10m  │   out-of-band      │ verify sig, pin keys  │
└──────────────────────┘                    └──────────┬───────────┘
        ▲                                               │ Noise + token
        │        local prompt: C requests pairing       ▼
        │        SAS 123-456   allow / deny ◀── Mesh session
        └───────────────────────────────────────────────┘
```
1. The daemon signs a ticket containing its Ed25519/X25519 public keys, reachable
   endpoints, a relay route only while it serves relay, a one-time token and an
   expiry. Only the token hash is
   persisted, and the token is reserved before the approval prompt.
2. The controller scans or pastes the link, verifies the signature with the
   ticket's `signPk`, checks `deviceId` and expiry, and pins the daemon keys.
3. The controller dials an endpoint, runs Noise NK, and sends `client_auth` with
   the one-time token inside the encrypted channel.
4. The daemon checks the token, queues a local request showing the controller
   name, platform and SAS, and replies `approval: "pending"`. The controller may
   only poll `pair.status` until the user decides.
5. On approval the daemon persists the controller keys and scope; on denial or
   timeout the session closes. Later connections use Ed25519 `paired`
   authentication and do not need a token.
6. A changed peer key is an identity change: the old record must be forgotten
   before pairing again. Revocation is immediate for live sessions and for new
   handshakes. If the controller session closes before the local user decides,
   the pending request is denied; the controller waits longer than the daemon's
   5-minute request TTL, so it never rolls back while the daemon can still
   approve.

The SAS is derived from the Noise handshake hash and both Ed25519 public keys, so
it is identical on both devices and independent of roles. It authenticates the
human decision, not the network path.

## 5. Portal design
The portal is the answer to "full remote control without reimplementing DSH".
Instead of rebuilding chat, approvals, terminal and file UI on the controller, the
controller browser loads the **remote DSH Web UI** through a loopback reverse
proxy carried by the Mesh.

```
controller browser ── HTTP/WS ──▶ 127.0.0.1:<portalPort> (controller plugin)
                                       │ Mesh session (Noise)
                                       ▼
                              daemon plugin ── HTTP/WS ──▶ 127.0.0.1:<dshWebPort>
```
Controller side:

- Binds `127.0.0.1` on an OS-assigned port and returns a URL with a 32-byte
  capability token; the first navigation trades it for an
  `HttpOnly; SameSite=None; Secure` cookie scoped to the portal (loopback is a
  secure context, and the Desktop iframe is cross-site).
- Forwards ordinary HTTP methods and WebSocket upgrades, enforces body/stream/idle
  limits, and strips credentials, hop-by-hop and forwarding headers.
- Strips `Set-Cookie`, `X-Frame-Options` and CSP `frame-ancestors` so the
  controller page can embed the proxy, and rewrites same-origin redirects. A
  cookie-authenticated HTTP request must carry `Sec-Fetch-Site: same-origin` or
  `none`; a missing header is rejected (Fetch Metadata is required).

Daemon side:

- Obtains the local DSH origin via `ctx.webServer.getOrigin()` and a browser
  session via `ctx.connection.authenticatedUrl(origin)`, following the `303`
  manually so the `dsh-auth-*` cookie is visible.
- Keeps that cookie in memory only, refreshes it near expiry or after `401`, and
  never sends it over the Mesh; the controller only holds the portal cookie.
- Proxies HTTP/WS to the local origin with `Host`, `Origin`, `Referer` and
  `Sec-Fetch-Site` normalized to that authority, and drops `Content-Encoding`/
  `Content-Length` because bodies are re-streamed decoded.

The portal is a `control`-scope experience. `view` scope is reserved for a later
release and is rejected at approval time. The iframe carries
`?dm-session=<id>&dm-embed=1`; the portal stores the id and the remote copy of
this plugin opens that Session through `uiWorkspace.openSession` once the shell is
ready (best effort; it falls back to the remote home page when DSH's UI surface
changes or the remote CSP forbids the injected inline script/style).

## 6. Data and persistence
`$DSH_HOME/device-mesh/` contains:

| File | Contents |
|---|---|
| `identity.json` (0600) | Device id, name, platform and Ed25519/X25519 key pairs. |
| `peers.json` (0600) | Paired controllers and daemons, scopes, revocation timestamps, endpoint cache and the relay `serverId`. |
| `settings.json` (0600) | Direct listener enable/port, relay endpoint/TLS/enable, portal idle timeout and auto-approve (default false). |
| `pairing.json` (0600) | Outstanding one-time token hashes and expiry only. |
| `audit.jsonl` (0600) | Append-only identity lifecycle (created/regenerated), pairing, connection, revocation and portal events; rotates at 8 MiB to `audit.jsonl.1`. |
| `.state.lock` (0600) | Cross-process writer lock with stale-lock recovery. |

All writes are atomic: a temporary file is written in the same directory, `fsync`
is requested, and the file is renamed into place with mode `0600`; the directory
is `0700`. A corrupt or invalid JSON document is renamed aside as
`<file>.corrupt-<timestamp>` and replaced with defaults, so a bad file cannot
prevent startup. Multiple DSH processes sharing one `$DSH_HOME` serialize writers
through the lock and re-read state before mutating.

Runtime-only state includes pending pairing requests, live controller sessions,
portal instances/capability tokens, remote workspace caches and the daemon's DSH
browser cookie. None of it is persisted, except the hashed one-time tokens needed
to survive a restart.

## 7. Security model and threats
Trust boundaries:

- The DSH host process and its plugins are trusted; a compromised host can read
  `$DSH_HOME` and impersonate the device.
- The relay and the network are untrusted. The relay sees routing metadata
  (`serverId`, connection ids), frame timing and sizes, but no plaintext.
- The controller browser is trusted only for its own portal cookie; it never sees
  peer private keys or the daemon's DSH cookie.
- A paired controller is **owner-level** for the daemon's DSH, because the portal
  is the daemon's own owner UI. Pair only with devices and people you trust.

| Threat | Mitigation |
|---|---|
| Public-network man-in-the-middle | Noise NK with pinned daemon X25519 key; Ed25519 application signatures; relay forwards only ciphertext. |
| Stolen or leaked QR code | One-time token, 10-minute TTL, SHA-256 at rest, local approval, SAS; token dies on first use. |
| Replay, reorder, tamper | Noise CipherState monotonic nonces; AEAD failure closes immediately; client nonce replay cache for 10 minutes. |
| Impersonating a controller | Only a pinned controller signature is accepted; first contact needs explicit local approval. |
| Lost device / revocation | `revokedAt` blocks handshakes, every RPC re-checks it, and revoke/forget closes live sessions immediately. A grant that expires while a session is open is closed by the 30 s sweep. Keys and `serverId` can be rotated. |
| Local process opens the portal | Loopback bind, random port, 32-byte capability token, `HttpOnly; SameSite=None; Secure` cookie, exact `Host`/`Origin`/`Sec-Fetch-Site` fence (cookie requests without Fetch Metadata are rejected); no token/cookie logging. A local HTTP server the user visits can still read a host-scoped cookie server-side. |
| Credential leakage | Daemon DSH cookie is memory-only; private keys, tokens, nonces and handshake hashes never enter logs/audit; state files are `0600`. |
| Resource exhaustion | Connection/stream/body/header caps, 64 inbound sessions (8 per controller), pairing-queue cap, heartbeat and idle timeouts, audit rotation. |
| Relay operator or `serverId` thief | Encryption prevents reading or forgery; the residual risk is denial of service and session replacement, which the protocol cannot prevent at the relay. |

Residual risks: relay traffic analysis; a malicious paired controller has
owner-level portal access; the remote UI executes in the portal's loopback origin
and can reach other loopback services (DSH's `/api` Origin fence blocks the DSH
API, other local services may not be defended); a local HTTP server the user
visits can read the host-scoped portal cookie; local malware is outside the
threat model; DSH changes can alter cookie/auth behavior and need re-verification. The design does not hide
that two devices communicate through a relay. Grant expiry is enforced on every
RPC and by a 30 s authorization sweep, so an already-open session can outlive
`expiresAt` by up to 30 s; revoke/forget when immediate termination is required.

## 8. DSH integration
### 8.1 Cordis host plugin
The package is a standard DSH third-party bundle. `cordis.patch.yml` inserts one
Loader row; `package.json` declares `dsh.bundle.patch`, `dsh.client.platform:
"web"` and `exports["./client"]`. The host entry `apply(ctx, rawConfig)` injects
`['webServer', 'connection']` and registers cleanup with `ctx.effect`.

Two DSH seams are essential:

- **Local browser API.** `ctx.connection.fetch.register({ path:
  '/api/device-mesh', methods: ['POST'], requestBody: 'buffered', fetch })` mounts
  the handler on DSH's cookie-authenticated `/api` channel; the browser cannot
  reach it without a DSH owner session.
- **Local Web authentication.** `ctx.webServer.getOrigin()` gives the origin and
  `ctx.connection.authenticatedUrl(origin)` returns a launch URL that sets a
  `dsh-auth-*` cookie; the portal daemon follows the redirect manually.

Workspace metadata comes from `ctx.workspaceRegistry`, `ctx.sessions`,
`ctx.sessionTitle` and `ctx.agents`, accessed defensively: a missing service
yields a conservative result instead of failing activation. Without
`ctx.connection.fetch` the Mesh runtime still starts, but the browser API is off.

### 8.2 Client plugin and UI
The browser bundle is wrapped as
`window.__ModuleLoader__.load({ id: 'dsh-device-mesh', factory })` and receives
only the DSH client context. It registers:

- a keyed `main` Devices panel, a `sidebar.panellist` entry with a
  pending-pairing badge, and a `shell.overlay` for pending pairing requests;
- a plain-DOM **host bar** inserted above ui-workspace's section header. The
  sidebar contract exposes no slot between the panel list and
  `sidebar.workspaces` (a single slot owned by ui-workspace), so the bar anchors
  to `data-sidebar-workspace-header` where present and falls back to the
  shipped `sectionHeader` CSS module class. It is removed and re-inserted if the
  browser re-renders, and hides itself in the 56px rail (the panel-list entry
  remains the fallback entrance).

The panel polls `POST /api/device-mesh` with `{ endpoint, payload }` every 2.5 s
while visible. It is the management surface: this device, pairing QR/link, paired
devices with online/connecting/offline status and pending approvals. Workspaces
are not repeated here; the sidebar host bar renders them for the selected host.
Opening remote control mounts an **iframe over the official center column**
(`data-device-mesh-remote-pane`) and points it at the loopback portal. This is
the device-workspace federation pattern used by `dsh-remote-workspace`: the peer
renders its real GUI in place, the local sidebar stays usable, and no second
window or credential is needed. The iframe is fixed to the center column's
bounding box so it never covers the sidebar.

The relay endpoint and the local relay daemon are separate: outbound controller
sessions use the endpoint even when **Allow relay control of this device** is
off. On a shared paseo-relay, running a second server slot from a controller can
displace the peer daemon, so controller-only devices should leave that switch
off.

Immutable GUI assets are cached on disk under `$DSH_HOME/device-mesh/portal-cache`.
Portal open first fetches the remote DSH HTML and extracts its resource list
(`/assets`, `/plugins`, `/locales`, `/fonts`); the sorted list is hashed into a
build manifest digest. Cache entries are keyed by that digest plus the asset URL
(which is itself content-addressed: `<name>-<hash>.js`, plugin bundles carry
`&rev=<hash>`). A matching digest serves the asset from disk without touching
the Mesh session; a remote version update changes the list digest, so every old
entry misses and the new build is downloaded. This removes the repeated ~7 MB
transfer without ever mixing two remote builds.

Text assets are gzip-compressed by the daemon before crossing the Mesh/relay
(the upstream fetch uses `identity`); a ~7 MB plugin bundle becomes roughly
2 MB on the wire. HTML is left uncompressed because the controller injects the
embed stylesheet into it.

The portal controller buffers small text assets (HTML/JS/CSS/JSON, `/plugins/`
and `/assets/`) before sending headers. If the Mesh session drops mid-transfer,
the request can be replayed against the adopted session instead of truncating a
plugin bundle — a truncated bundle is what makes the remote shell show
"Failed to load plugins" until a manual refresh.

The iframe surface is used in both shells. Desktop renders on `dsh-app:`, so its
loopback iframe is cross-site; the portal cookie is therefore
`SameSite=None; Secure` (loopback is a secure context). A cross-site capability
token entry gets a same-origin bootstrap page that stores the cookie. Every
cookie-authenticated request is fenced to `same-origin`/`none`, and a request
without Fetch Metadata is rejected. The remote
document is embedded with `?dm-embed=1`: the portal injects a small layout
override that collapses the remote sidebars and plugin bars, and `?dm-session=`
makes the remote copy of this plugin select the clicked Session. The result looks
like the local conversation column, not a second DSH shell.

If the cookie is still withheld, the portal returns a tiny page that posts
`auth-failed` to the parent; the parent then falls back to the right-sidebar
Browser tab or the system browser (OS `open`/`xdg-open`/`start`).

Fallbacks, in order: `sidebarRight.openTab('browser', …)` when a session surface
is mounted; the host OS opener (`open`/`xdg-open`/`start`) on Desktop; one
reusable browser window with a same-origin portal bootstrap on plain Web. A
direct `window.open(portalUrl, '_blank', 'noopener,noreferrer')` is last: the
DSH Desktop main window routes `http:`/`https:` to `shell.openExternal`.

### 8.3 Local vs remote workspaces
DSH's native `sidebar.workspaces` is a single slot owned by `ui-workspace`, and
workspace rows expose no third-party slot. The plugin cannot inject remote rows
into the native tree without replacing that tree.

- **MVP (no upstream change).** The **sidebar host switcher above Workspaces**
  displays the current host and lists this host plus paired remotes with live
  status. Selecting a remote host hides the native browser (`dm-remote-mode`)
  and renders a **read-only remote mirror** in the same region: host name,
  status, refresh/manage/open-control actions, and that host's workspaces and
  sessions; clicking one opens the device portal. Loading, empty, offline,
  connecting and error states are explicit, and the native list returns
  immediately when this host is selected again. Remote rows never masquerade as
  local. **Add host** mirrors Paseo's flow: direct connection, paste pairing
  link, and remote SSH (marked planned until an SSH transport exists).
- **Upstream boundary (Phase 2).** The clean final form is a small
  `sidebar.workspace.row.trailing` slot in `ui-workspace` (roughly 30 lines) so a
  plugin can render a device badge on a native workspace row. The plugin would
  then use the native tree for both scopes. Replacing `sidebar.workspaces`
  wholesale is explicitly not chosen: it duplicates core rendering and breaks on
  DSH releases.

This boundary is intentional: the MVP is fully functional without touching DSH,
and the upstream patch is a rendering improvement, not a protocol dependency.

## 9. Platform matrix
| Capability | A: Linux desktop | B: Linux server (`dsh web --no-open`) | C: macOS desktop | D: mobile (future: Android / iOS / HarmonyOS) |
|---|---|---|---|---|
| Host plugin / daemon | ✅ | ✅ | ✅ | Planned / not implemented. Protocol is platform-neutral, but no mobile build exists. |
| Controller | ✅ | ✅ | ✅ | Planned / not implemented. Web UI/WebView target; camera permission and paste-link fallback are unverified. |
| Direct listener | ✅ (plugin port; firewall may need a rule) | ✅ | ✅ | Planned / not implemented. |
| Relay | ✅ | ✅ | ✅ | Planned / not implemented. |
| Show pairing QR (daemon) | ✅ | ✅ | ✅ | Planned / not implemented. |
| Scan pairing QR (controller) | `BarcodeDetector` on Chromium | Same | Same | Planned / not implemented; `BarcodeDetector`/WebView behavior unverified. |
| Recommended production mode | LAN/Tailscale, or relay with direct disabled | Relay common | Same as A | Not applicable (no mobile build). |

Portal cookie authentication requires Fetch Metadata (`Sec-Fetch-Site`): supported
controller browsers are Chromium 88+, Firefox 90+ and Safari 16.4+ (plus the
Electron shell). Older browsers can pair and manage devices but cannot open the
remote UI.

Pairing is per **device identity**, not per class: any two devices can be
paired in either direction, including two devices of the same class
(B ↔ B′, C ↔ C′). Desktop devices A/C need manual visual verification of the
center-column iframe (falling back to the right-sidebar Browser tab or the
system browser); the protocol and host
behavior are platform-independent.

## 10. Testing strategy
- **Core crypto/channel.** Official noise-c `NK`/`NKpsk0` vectors are compared
  byte for byte; negative tests cover tampered, replayed, reordered, truncated and
  oversized frames, wrong pinned keys, duplicate nonces, bad application
  signatures and authentication timeouts.
- **Session and streams.** RPC correlation/timeouts, stream multiplexing,
  backpressure, concurrent-stream caps, abort/end semantics, WebSocket message
  boundaries and protocol violations.
- **Transport.** Direct listener/client tests cover Origin rejection, limits,
  URL enumeration and heartbeat; relay tests run against a mock relay and a real
  paseo-relay binary, including v2 control/data sockets, multiple clients, v1
  replacement semantics and close codes.
- **Host state and policy.** Store atomic writes, corrupt-file recovery,
  cross-process locking, pairing signature/one-time/expiry rules, revocation,
  workspace mapping and portal header/auth behavior.
- **Client.** Static checks that the bundle registers the expected slots and
  renders without a live host.
- **End-to-end.** Three scenarios run against isolated `dsh web` instances: plugin
  load and `/api/device-mesh`; two-device pairing, SAS approval, remote workspaces
  and a portal returning the remote DSH shell; and the same flow forced through a
  real paseo-relay with direct disabled (skipped if the binary is absent). At the
  MVP commit, `npm test` covers 170 cases and all three E2E cases pass.

Known gaps: manual desktop-window/QR-camera verification, mobile builds
(Android / iOS / HarmonyOS) and portal deep links. E2E proves the protocol path, not every DSH UI surface.

## 11. Roadmap and risks
1. **Native RPC control (Phase 2).** List remote sessions, send prompts, stop
   runs, relay approvals and attach terminals inside the local UI, using the host
   transport option described in [ADR 0001](adr/0001-remote-control-in-dsh.md).
   This removes the need for a portal tab for routine work but keeps the portal
   for full fidelity.
2. **Upstream workspace badge.** Add the `sidebar.workspace.row.trailing` slot to
   `ui-workspace` and render device/Remote badges on native rows without replacing
   the tree.
3. **Mobile.** Reuse the protocol and client bundle on Android, iOS and HarmonyOS
   once the official plugin model is known; camera permissions, background
   keep-alive and mobile layout are separate work.
4. **Portal fidelity.** Support DSH deep links when upstream adds them and verify
   DSH cookie/auth behavior per release.
5. **Operations hardening.** Rotate keys/`serverId`, add admission rate limiting
   and improve relay observability without weakening opaque frames.

Risks: DSH slot/service contracts evolve (baseline `0.2.2-rc.2`), portal auth
needs per-release verification, and the relay remains a metadata/DoS trust point.
If portal authentication is unavailable, remote control is unavailable; there is
no native RPC-only fallback in the MVP. Native RPC control is Phase 2.

Known limitation: an already-open session whose grant expires remains usable
until the next 30 s authorization sweep. Revoke or forget the device when
immediate termination is required.

## Related docs
- [README](../README.md) — installation, pairing and usage.
- [CONTRIBUTING](../CONTRIBUTING.md) — contribution workflow and review expectations.
- [SECURITY](../SECURITY.md) — vulnerability reporting and disclosure policy.
- [Protocol](PROTOCOL.md) — normative wire format, RPC and portal rules.
- [Development](development.md) — build, packaging, DSH integration points, testing and releases.
- [ADR 0001](adr/0001-remote-control-in-dsh.md) — why full remote control uses a host-side mesh plus a loopback portal.
