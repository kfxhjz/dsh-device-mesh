# ADR 0001: Remote Control in DSH via a Host-Side Mesh and Loopback Portal
[简体中文](../zh/adr/0001-remote-control-in-dsh.zh.md) | English

- **Status:** Accepted · **Date:** 2026-11-09 · **Scope:** plugin `0.0.1`, DSH `0.2.2-rc.1`

## Context

The project must let one DSH installation operate another: list workspaces and sessions, open conversations,
answer approvals, use the terminal and files, and reach settings, with local and remote scopes distinct.

1. **The DSH client is single-host.** `ctx.connection`, `ctx.sessions` and
   `ctx.workspaces` are singletons in one Cordis tree; one document is bound to
   one host. There is no multi-host switch and no URL deep link to a remote
   workspace or session.
2. **The integration surface is a third-party bundle.** The product ships as a
   normal DSH plugin (host entry, `__ModuleLoader__` browser entry and a
   `cordis.patch.yml` row). It cannot patch DSH core and must work on desktop DSH
   and `dsh web --no-open`.
3. **The requirement is full remote control.** A read-only session list is not
   enough; approvals, terminal, files and settings are part of the feature.
   Reimplementing them from RPC would mean writing a second DSH client.

DSH supplies the broker primitives (trusted Node runtime, `ctx.webServer`,
`ctx.connection`, remote-access policies); the question is where the
data-plane/UI boundary sits. The early research notes are folded into this ADR
and the [development guide](../development.md).

## Decision

Build the feature from two separable planes.

**1. Data plane: a symmetric device mesh owned by the host plugin.** Every
install ships the same plugin. A daemon accepts a paired controller over direct
WebSocket or paseo-relay; the channel is `Noise_NK_25519_ChaChaPoly_SHA256` with
pinned keys, application authentication and a custom RPC/stream multiplexer.
Pairing uses a signed one-time ticket and local SAS approval; the host owns
identity, grants, revocation, audit and metadata
([PROTOCOL.md](../PROTOCOL.md)).

**2. UI plane: the complete remote DSH Web UI behind a controller-local loopback
portal.** The controller starts a reverse proxy on `127.0.0.1:<random port>`; a
browser tab loads the daemon's own DSH Web UI through it, with HTTP/WS inside the
mesh session. The daemon injects its local DSH cookie upstream and never exposes
it; the browser holds only a portal-scoped capability cookie. See
[PROTOCOL.md §7](../PROTOCOL.md#7-portal-forwarding) and
[DESIGN.md §5](../DESIGN.md#5-portal-design).

**3. Client plugin scope: discovery and metadata, not a second DSH.** The local
bundle registers a keyed `main` Devices panel, `sidebar.panellist` and
`shell.overlay`, plus a DOM host bar above the native workspace section. It
shows this device, pairing, paired devices, and a host-scoped workspace mirror,
and opens the portal. Remote rows never masquerade as local rows; native
workspace-row badges wait for an upstream `ui-workspace` slot
([DESIGN.md §8.3](../DESIGN.md#83-local-vs-remote-workspaces)).

In the vocabulary of the alternatives, the shipped design is **B for the data
plane plus A for UI fidelity**: the mesh supplies an authenticated, encrypted
transport and controlled metadata, while the portal supplies the real remote UI.
It is explicitly not **C**, a second DSH client tree in the local renderer.

## Consequences

### Benefits

- **Full fidelity without forking DSH.** Approvals, terminal, files, settings and
  future DSH features arrive with the remote UI.
- **No core changes.** Public host services and client slots; identical install
  on desktop and server DSH.
- **One protocol, two carriers.** Direct and relay share one Noise session, RPC
  and portal; relay mode needs no inbound port.
- **Visible authorization.** The portal is the owner UI, so a paired controller
  is intentionally owner-level; tokens, SAS and revocation keep it explicit.

### Costs and risks

- **Owner-level portal access.** A product decision; the docs must say so, and
  pairing must stay explicit and revocable.
- **Version-sensitive portal auth.** Depends on `getOrigin`, `authenticatedUrl`
  and the DSH cookie/Origin fence; every DSH upgrade needs a regression pass.
- **No deep links.** v1 opens the remote home page; remote work happens in a
  portal tab (or right sidebar), local work in the native shell.
- **Relay availability.** It sees metadata and can deny service or replace a
  `serverId` session; E2EE protects content, not availability.

### Security impact

- Noise NK with pinned keys protects content from a malicious relay or network
  path; one-time tokens, local approval and SAS protect first contact.
- The portal binds loopback only and requires a 32-byte capability token
  exchanged for an `HttpOnly; SameSite=None; Secure` cookie; the DSH cookie stays
  in daemon memory. Revocation closes sessions and is re-checked on every RPC.
  (The cookie is host-scoped, not port-scoped; the request fence stops another
  loopback page from using it, but a local HTTP server the user visits can read it.)
- Remaining risks: a malicious paired controller owns the daemon UI; the remote
  UI runs in the portal's loopback origin and can reach other loopback services;
  a local HTTP server can read the host-scoped portal cookie; local malware is out
  of scope; relay traffic analysis is possible.

### Phase 2 path

The portal is the primary surface, not the end of the roadmap. Native RPC control
adds routine operations while the portal keeps full fidelity:

- **Daemon-side peer and policy.** `ctx.connection.createPeer({ principal })`
  with a `mesh-device` principal plus a `ctx.remoteAccess` policy for
  workspace/session resources; unary calls through
  `createSharedFetchHandler('/api')`, streams through the typert gateway.
- **Approval relay.** `approval/request` and `user-questions/request` are
  forwarded waterfalls only owner peers can answer. The host plugin must
  intercept its host-side waterfall, forward to the controlling device and
  return the answer; timeout and disconnect fail closed.
- **Upstream workspace badge.** Add `sidebar.workspace.row.trailing` to
  `ui-workspace` for a device badge; a rendering improvement, not a protocol
  dependency.
- **Still no core modifications.** Public services only; the badge is proposed upstream. If either changes,
  degrade to the portal.

## Alternatives considered

### A. Reverse-proxy the remote UI without a mesh

Run a plain HTTP/WS reverse proxy from controller to the daemon's DSH Web port,
with no device mesh or custom RPC.

- **Why not as the primary design:** it bypasses identity, grants and audit. The
  proxy must inject the daemon's owner cookie, so every request is owner-level
  with no per-device revocation. Cookie scope, `Origin` and `Host` fences differ
  between desktop and `dsh web`, a public deployment still needs an authenticated
  encrypted tunnel, and the Devices panel gets no metadata.
- **When it is useful:** as a trusted-LAN escape hatch when the mesh cannot run,
  or for visual debugging. It is not a shipping path.

### B. Pure mesh RPC plus a locally reimplemented remote UI

Use the mesh RPC only; render remote workspaces, sessions, conversation,
approvals, terminal and files with local components.

- **Why not now:** it means reimplementing a large, fast-moving part of DSH.
  Approvals are owner-only waterfalls, terminal attachment is a bidirectional
  stream with backpressure, and file semantics are host-rooted. Fidelity and
  maintenance cost are high, and every DSH UI change becomes our bug.
- **When it is useful:** for routine operations once the protocol exposes them
  and the local UI can render a safe subset (list, prompt, cancel, status). This
  is the Phase 2 direction, layered on top of the portal rather than replacing
  it.

### C. A second DSH client tree in the local renderer

Instantiate another Cordis client tree per remote host, install
`ctx.connection`/`api-remotes` into it, and render its slots locally.

- **Why not:** it collides with the single-host model. `ctx.sessions` and
  `ctx.workspaces` are root services and the renderer is not designed for nested
  trees. Generated typert contributions are build-time value imports, so a
  third-party bundle cannot conjure remote namespaces without its own
  generation. Approvals do not get easier: the tree is still a non-owner
  principal and `answers` is hard-coded to the owner, so it still needs B's
  relay.
- **When it is useful:** only if DSH grows a supported multi-host/nested-tree
  API; C could then replace the portal while keeping this mesh and security
  model.

### Why the combination

A alone is insecure and gives no local discovery. B alone is too much UI work
and still needs a portal for edge features. C has the highest risk and does not
remove the hardest authorization problem. The design uses B for transport,
identity and metadata and A for the remote interface; Phase 2 can move routine
operations from A to B without changing the wire protocol or pairing.

## References

- [DESIGN.md](../DESIGN.md) — architecture, portal, DSH integration and roadmap.
- [PROTOCOL.md](../PROTOCOL.md) — wire format, pairing, Noise, RPC, portal and
  relay constraints.
- [development.md](../development.md) — build, packaging, integration and tests.
- [README.md](../../README.md) — install, pairing and usage.
- DSH documentation:
  [plugin development](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/index.md),
  [client modules](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/client-modules.md),
  [slots](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/slots.md),
  [web client](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/web-client.md).
- DSH release baseline:
  [v0.2.2-rc.1](https://github.com/deepseek-ai/DeepSeek-Harness/releases/tag/dsh-v0.2.2-rc.1);
  [paseo-relay](https://github.com/kfxhjz/paseo-relay) for the optional public
  transport (routing only).
