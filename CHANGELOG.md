# Changelog

[简体中文](CHANGELOG.zh.md) | English

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Unreleased

### Added

- Remote workspace rows now offer **New session** (`+`). The controller asks the
  embedded remote shell to open that workspace's native blank Session through
  the portal and then selects it; a per-request id makes the URL and
  postMessage/retry delivery paths idempotent.

## 0.1.3 - 2026-11-13

### Added

- The remote workspace mirror now has a **View options** menu: group by
  workspace or one flat list, order by recent activity or title, and hide, show
  or isolate archived sessions. Preferences are stored per remote device.
- Remote session rows offer **Archive** / **Unarchive**. Archiving a session
  with running work asks for confirmation first. Archived rows are dimmed and
  cannot be opened until they are restored. The action uses the daemon's own
  registry, so the change is immediately visible to that device's local user.

### Fixed

- Remote archive/unarchive actions now take effect: the controller-side
  workspace sanitizer preserves the `archived` flag, so an archived row
  disappears from the default view, filters work, and the row can be restored.
- Loading a large remote Session's history no longer sends the whole
  `/api/remote.mux` WebSocket payload uncompressed across the Mesh. Portal
  WebSocket messages above 1 KiB are now gzipped end to end (negotiated per
  exchange), which typically shrinks a multi-megabyte JSON history snapshot
  several-fold over LAN/relay. Older peers keep the previous raw envelope.

## 0.1.2 - 2026-11-12

### Fixed

- The sidebar remote mirror now re-requests the selected device's workspace
  listing every 5 seconds while that host stays selected, so running, awaiting
  and unread session state tracks the daemon instead of staying frozen at the
  first listing.
- Running remote sessions render the native-style spinning status indicator
  (with a `Running` tooltip and accessible label) in both the cloned native rows
  and the fallback rows; previously a running session showed no live indicator.

## 0.1.1 - 2026-11-12

### Added

- Direct unit tests for the client half: API normalizers, the host-selection
  store, both locale dictionaries, QR encoding, deep-link handling and a
  happy-dom test for the sidebar host bar/switcher. Measured with
  `--test-coverage-include-all`, overall source line coverage rises from roughly
  69% to roughly 84%, and the client half is no longer covered only by bundle
  static assertions.
- `npm run test:coverage` enforces source line/branch/function thresholds
  (80/72/77) and is part of `npm run release:check`. Node 26 uses
  `--test-coverage-include-all`; Node 24 falls back to loaded-file thresholds
  (89/72/77), and CI runs both modes. The measured set is `src/**/*.ts`; the
  `src/client/index.tsx` bundle entry is deliberately out of scope because it
  wires the client plugin and its contract is covered by the bundle test.
- Deterministic protocol fuzz tests for Noise handshake parsing, channel/session
  frame parsing and WebSocket-message envelopes, plus a short soak suite gated by
  `DSH_MESH_SOAK=1` (skipped in normal runs).

### Changed

- Upgraded the toolchain and dependencies to their latest releases: TypeScript 7
  (native compiler), `@types/node` 26, Oxlint 1.93 with `oxlint-tsgolint`
  7.0.2006, tsx 4.23, `ws` 8.22 and `@types/ws` 8.18. CI and release workflows
  now use `actions/checkout@v7`, `actions/setup-node@v7`,
  `pnpm/action-setup@v6`, `actions/upload-artifact@v7`,
  `github/codeql-action@v4` and `softprops/action-gh-release@v3`.
- Added an npm `overrides` entry pinning `minimatch` to the patched 11.x line, so
  the development-only ESLint chain loaded by the Oxlint `@stylistic` plugin no
  longer reports the globbing denial-of-service advisory.
- CI now runs Ubuntu/macOS on Node.js 24 and 26 and Windows on Node 24 in a
  separate job, so a Windows-only failure no longer gates the E2E jobs. Coverage
  runs on Ubuntu for both Node versions (full include-all gate on 26, loaded-file
  fallback on 24); both E2E jobs and the release gate run on Node 26. Added a
  dedicated real paseo-relay E2E job that builds the pinned `v0.1.2` binary and a
  nightly scheduled run that also executes the soak suite. Scheduled runs use
  their own concurrency group so they cannot cancel push/PR runs.
- Repository hygiene: `.gitattributes` (LF line endings) and `.nvmrc` (Node 26)
  added; the changelog now links each release section.

### Fixed

- The relay E2E job keys its cargo cache by the recorded Rust version and uses
  `actions/cache@v6`, so a toolchain upgrade cannot reuse stale build artifacts.
- `npm run check:scripts` runs `node --check` over the build/release scripts and
  is part of CI and `npm run release:check`; Oxlint ignores `.mjs`, so this
  catches a script syntax error before a workflow reaches it.
- The release workflow verifies the `CHANGELOG.md` version section during the
  early tag check, so a missing or unrenamed section fails before the build
  instead of after packing.
- The sidebar host DOM test tears down its mount in a `finally` block, so a
  failing assertion cannot leave the polling interval and store subscription
  alive.
- Corrected the CI/Node and `.nvmrc` wording in the development guide and
  changelog (Windows runs Node 24 only; coverage runs on Node 24 and 26; both
  E2E jobs and the release gate run on Node 26).

## 0.1.0 - 2026-11-12

### Added

- Added a Paseo-style host switcher directly above the sidebar's **Workspaces**
  section: it displays the current host name and lists this host plus paired
  remotes with live status. Selecting a remote host switches the workspace
  region to a **read-only remote mirror** (loading/empty/offline/connecting
  states, refresh/manage/open-control actions, sessions open the remote portal);
  selecting this host restores the native list. "Add host" offers direct
  pairing, paste-link pairing and remote SSH (marked planned). The bar and the
  mirror are DOM-inserted above ui-workspace's section header (with the shipped
  `sectionHeader` class fallback) because the sidebar exposes no slot there.
- Fixed the sidebar remote mirror disappearing about one second after a host
  switch: the rail check measured the hidden native header (0px) and hid the
  mirror; it now measures the native root. Selecting an offline host also
  auto-reconnects it before loading its workspaces.
- Host switching now moves the main column to the Devices context: a selected-host
  card shows status, reconnect, refresh and open-control actions, and indicates
  when a remote-control portal is live. The remote mirror gained a local filter,
  external-link affordances and an explicit "opens remote control" hint. The
  redundant footer entry was removed and Add host is one scan/paste dialog.
- The relay field accepts a bare IP or domain (optional port) and normalizes it
  to `wss://<host>/ws`; no scheme is required. An explicit **Use TLS** switch
  lets a bare plaintext paseo-relay (`ws://host:port`) connect for trusted
  testing; the UI warns and the Host records the choice.
- The Devices panel is management-only: the duplicate workspace section was
  removed because the sidebar host switcher already renders the selected host's
  workspaces.
- A direct `window.open(portalUrl, '_blank', 'noopener,noreferrer')` is the final
  fallback: DSH Desktop's main window routes `http:`/`https:` to
  `shell.openExternal`, while a blank target followed by `location=` was denied.
- Desktop portal opening now falls back to the system browser via the OS opener
  (`open`/`xdg-open`/`start`) when the DSH shell has no right-sidebar surface and
  `window.open` is denied; the portal URL must exactly match a live portal.
- The portal buffers text/JS/CSS/JSON assets before sending headers, so a Mesh
  reconnect during the first asset burst replays the request instead of
  truncating a plugin bundle (the cause of "Failed to load plugins").
- Relay configuration is split: the endpoint is used for outbound controller
  sessions even when **Allow relay control of this device** is off. Previously
  saving a relay always started the local relay daemon; on a shared paseo-relay
  that could displace the peer daemon and produce reconnect loops.
- Portal proxy requests now wait for a reconnect to adopt a fresh session and
  retry once for idempotent GET/HEAD/OPTIONS (and WebSocket upgrades). The first
  SPA asset burst no longer fails with `session closed` while the controller is
  reconnecting.
- The controller now calls `portal.prepare` before returning the portal URL, so
  the daemon's DSH cookie is warm when the browser starts its parallel asset
  burst. This removes the first-load "plugin load failed" state that a refresh
  used to fix; the E2E cold-load case asserts no 4xx/5xx.
- Fixed the portal cookie error inside the center-column iframe: the embed
  surface is Web-only (a `dsh-app:` parent cannot carry the loopback cookie), so
  Desktop opens the system browser, and an iframe auth failure posts
  `auth-failed` to the parent for a top-level fallback.
- Text assets are gzip-compressed by the daemon before crossing the Mesh/relay,
  cutting the plugin bundle from ~7 MB to roughly 1.8–2 MB on the wire; the portal
  caches the compressed bytes and forwards `Content-Encoding: gzip`.
- Immutable GUI assets (hashed `/assets`, `/locales`, `/fonts`, and `/plugins/`
  bundles with `rev=`) are cached under `$DSH_HOME/device-mesh/portal-cache`.
  On open the portal fetches the remote HTML resource list and hashes it into a
  build manifest; cache entries are keyed by that digest plus the asset URL, so
  a remote version update invalidates the old set and never mixes builds.
- The application heartbeat is now advisory: a missed RPC ping no longer tears
  down a healthy relay tunnel. Transport close remains the authoritative signal.
  The previous 10s/30s ping-close loops were truncating portal assets and
  leaving the remote SPA white. The first-load overlay explains a slow load
  instead of spinning forever.
- Entering a remote host now clears any local workspace search before rendering
  the remote inventory; a leftover filter could hide remote workspaces whose
  titles did not match.
- Entering a remote host now bypasses the 60s inventory cache and refreshes its
  workspace/session list, so sessions created while another host was selected
  are not missing on return.
- The remote tree height is now computed from its actual top edge to the shell
  footer instead of a container-query guess; the last rows can no longer render
  below the viewport where scrolling cannot reveal them.
- The remote tree now lives in a height-constrained scroller with native wheel
  handling, so a long remote workspace list is fully reachable instead of being
  clipped after the visible rows.
- Switching hosts no longer forces the Devices panel: each host restores its last
  remote Session (remembered per device), and a workspace's external arrow opens
  its newest Session instead of the remote home. First iframe load replays the
  pending Session with retried postMessages, so the first click lands on the
  target Session even when the remote shell strips the URL query.
- The remote-host sidebar now persists workspace expansion per device, highlights
  the Session currently shown by the embedded remote shell (synced through a
  postMessage), maps awaiting/running/unread states to the leading dot, and hides
  local-only Add workspace / view-options actions while a remote registry is shown.
- The remote-host sidebar now keeps the native Workspaces section header and search
  and renders workspaces/sessions with the shell's own row classes, folder and
  chevron icons, and row actions. Switching hosts looks the same as the local
  browser; only the external ↗ action is remote-specific. Sessions expand and
  collapse under their workspace.
- Reopening a remote workspace/session reuses the live portal and iframe; a
  second click only switches the remote Session via postMessage, so it is not a
  new window and does not reload the 7 MB remote SPA. A loading overlay covers
  the first cold load. Remote workspace rows now use the same folder icon as
  local rows.
- Remote control now embeds the remote DSH shell in the local center column in
  both Web and Desktop. The portal cookie is SameSite=None/Secure, the remote
  sidebars are collapsed by an injected embed stylesheet, and `?dm-session=`
  selects the clicked remote Session (deep link handled by the remote plugin).
- Desktop remote control now mounts a local Session surface and opens the same
  portal in DSH's right-sidebar Browser tab; the system browser remains the
  fallback when no local Session/sidebar is available.
- Remote control now opens the peer GUI as an **iframe over the center column**
  (`dsh-remote-workspace` federation pattern), with the local sidebar still
  usable. Right-sidebar, OS-browser and popup paths remain fallbacks.
- Fixed opening remote control from a workspace/session row: the window is now
  pre-opened inside the click gesture, and a cross-site popup receives a
  same-origin bootstrap page instead of a 303 whose SameSite=Strict cookie the
  browser drops. Clicking a remote row now opens the remote DSH UI.
- Open portals survive a transient mesh reconnect: the broker hands the new
  session to the existing portal so the same remote-control tab recovers.
- Remote control reuses the shell's right-sidebar tab when available and a
  single reusable browser window otherwise; portal WebSockets now carry
  server-side keepalive pings so idle remote-control tabs stay connected.
- Remote workspaces are easier to find from the sidebar: the Devices panel now
  puts the remote-workspaces section at the top and shows a total count; the
  panel icon and footer entry show the number of online remote devices.
- Full bilingual documentation: every document now ships with a Simplified
  Chinese version and a language switcher, and Chinese documents link to the
  Chinese versions of other documents.
- Public documentation set: an English user README, a Chinese README with the
  same structure, a documentation index, contribution guidelines, a security
  policy and this changelog.
- Maintainer documentation: an English development guide
  ([`docs/development.md`](docs/development.md)) covering packaging, the local
  loop, DSH integration and releases, plus
  [ADR 0001](docs/adr/0001-remote-control-in-dsh.md) on the remote-control
  architecture. These replace the development-time research notes.

### Security

- Pairing tickets now validate every endpoint URL before the controller dials it:
  only `ws://`/`wss://`, no embedded credentials, bounded length, and a
  non-loopback relay must use `wss://`. A malicious pairing link can no longer
  point the controller at an arbitrary local or plaintext endpoint.
- The loopback portal bounds concurrent connections and slow client/header
  timeouts, and the direct listener's per-address rate-limit table is capped so
  IPv6 address rotation cannot grow it without bound.
- Documented the threat model, key and pairing-code handling, vulnerability
  reporting process and a deployment hardening checklist.
- Least-privilege enforcement: `view` grants are read-only, workspace allowlists
  filter `workspaces.list`, and portal access requires an unrestricted `control`
  grant. Restricted scopes are rejected at approval instead of being silently
  widened.
- Revocation, forget and grant expiry now close established inbound sessions and
  their portal WebSockets (within the 30 s grant sweep); a rejected or timed-out
  first pairing removes its pinned peer and does not auto-reconnect.
- Portal hardening: exact `Host` authority, same-origin/same-origin-navigation
  checks, portal `Origin` required for WebSocket upgrades, and the capability
  token stripped from every forwarded path. This prevents another loopback port
  from borrowing an open portal's cookie.
- WebSocket-over-portal preserves text/binary opcodes, so DSH's text-only Remote
  stream works; oversized control results now fail with `mesh/busy` instead of
  timing out; WebSocket fragment assembly is bounded (8 MiB).
- Public relays must use `wss://`; inbound sessions are capped at 64 (8 per
  controller); pairing races (approve/deny, concurrent connects, in-flight
  connects during forget/revoke) have deterministic terminal states.
- Pairing token storage is now read-modify-write under the cross-process lock:
  two DSH processes sharing one `$DSH_HOME` can no longer resurrect a consumed
  token or drop each other's tickets.
- A silent peer is closed after 10 s (first Noise frame) instead of holding a
  pre-authentication slot for the full 60 s authentication window.
- Hardened the direct listener and audit trail: per-IP upgrade attempts are
  capped at 60/minute (429), and failed inbound authentication writes a
  reason-code-only `auth.failed` audit entry. The remote sidebar mirror keeps
  its scroll position across the 2.5 s state poll and hides itself in the
  collapsed rail.
- Pairing dials each endpoint with an 8 s budget before falling back to the next
  one, so one unreachable LAN/hotspot address cannot consume the whole approval
  window; Linux hotspot/AP interfaces (`ap0`) and other virtual adapters are
  filtered out of pairing tickets.

### Tests

- Added Oxlint (matching DSH upstream's linter family) with a project config;
  `npm run lint` is part of the CI and release gate. It also enforces the DSH
  `@stylistic` formatting rules (2-space indent, no semicolons, single quotes,
  multiline trailing commas, 140-column limit) and fixes them via
  `npm run lint:fix`. Import hygiene is enforced too: top-level `import type`
  specifiers and no duplicate module imports (declaration sorting is not part of
  the DSH lint contract).

- Added a real-browser UI E2E: headless Chrome opens the portal and boots the
  daemon's actual DSH Web UI, including its text-frame Remote-stream WebSocket
  (`npm run test:ui`; skipped when Chrome is absent).
- Added `RELEASE.md` / `RELEASE.zh.md` and `npm run release:check` as the
  pre-release gate: automated checks plus the manual verification matrix.

### Fixed

- Third-review polish: documented the Fetch Metadata browser support matrix
  (Chromium 88+/Firefox 90+/Safari 16.4+), widened the per-endpoint pairing
  connect budget to cover the 60 s auth window, normalized the relay TLS switch
  from a stored endpoint, and documented the soft cache budget and best-effort
  embed injection.
- Low-severity polish: the Devices panel reports a truncated remote workspace
  listing, identity regeneration is audited as `identity.regenerated`, an
  explicit relay scheme now aligns the TLS switch, the asset-manifest cancel
  wait is bounded, and pairing connect/approval windows have separate constants.
- Portal cookie-authenticated HTTP requests now require `Sec-Fetch-Site`
  (`same-origin` or `none`); a missing header is rejected, closing the gap for
  browsers without Fetch Metadata. Portal cache eviction scans are batched
  instead of running per asset write, and the remote-initiated WebSocket close
  path has a regression test.
- Portal WebSocket streams are now released on a graceful close (both sides), so
  opening/closing remote-control tabs no longer leaks a stream per close or hits
  the 32-stream `mesh/busy` cap (H1).
- Workspace listings are bounded to 100 workspaces / 200 sessions / 60 KiB and
  carry `truncated`, so large profiles no longer fail the RPC with
  `RPC result too large` (H2).
- A pairing ticket advertises relay only while this device serves relay, and a
  peer with no cached endpoint must be re-paired instead of dialing this device's
  own relay `serverId` (H3).
- A pending first-contact request is denied when its controller session closes;
  the controller's approval window now outlives the daemon's request TTL (S4).
- Hardened the portal: `?dm-session=` is HTML/script escaped, the asset-manifest
  read is capped (4 MiB / 5 s), every proxied response carries `nosniff`, and the
  daemon strips the whole DSH-owned `x-dsh-*` header namespace. Paired auth now
  rejects a `pair-token` client message, and relay connect errors redact the
  `serverId`.
- Correctness/hygiene: the store reuses `crypto.ts` and validates identity key
  pairs; the client normalizes `sas`; the sidebar mirror signature tracks session
  state; the relay field no longer mangles `https://` input; duplicate
  `portal.closed` audit rows are gone; the portal asset cache has a disk budget;
  dead code/unused fields were removed.
- Documentation now matches the implementation: `SameSite=None; Secure` portal
  cookie, advisory application heartbeat, implemented best-effort deep links,
  management-only Devices panel, reserved `view` scope, relay ticket rules,
  workspace caps and pairing windows (English and Chinese).

## 0.0.1 - 2026-11-09

First MVP release, verified against DSH `0.2.2-rc.1`.

### Added

- Symmetric DSH device mesh plugin: every install ships a host plugin and a Web
  client plugin, and every device can act as a daemon or a controller.
- Devices panel with a local/remote split, pairing QR code and
  `dsh-mesh://pair?d=…` links, controller-side add/scan/paste flow, pending
  pairing approvals with a 6-digit SAS, paired-device status, remote workspace
  grouping with a **Remote** badge, and portal open/close actions.
- Direct transport over WebSocket on LAN and Tailscale networks, with the
  plugin's own listener (default TCP `45871`) and reachable endpoints embedded
  in the pairing ticket.
- Public transport through paseo-relay v2 (control socket plus one data socket
  per controller), with v1 fallback for older relays.
- `Noise_NK_25519_ChaChaPoly_SHA256` end-to-end encrypted mesh sessions
  (prologue `dsh-mesh/1`), with pinned device keys and application-layer
  authentication.
- One-time pairing tickets with a 10-minute TTL, signed with the daemon identity
  key. The token is reserved and removed from disk at first presentation, before
  local approval; a denied request or a lost prompt needs a fresh link.
- Per-device authorization and revocation, plus an audit log for pairing,
  connection, revocation and portal events.
- Controller-side loopback portal that reverse-proxies the daemon's full DSH Web
  UI over the encrypted mesh, and a daemon-side proxy that keeps the DSH browser
  cookie in memory.
- Local `POST /api/device-mesh` route on the DSH Connection service.
- English and Chinese client dictionaries.

### Security

- End-to-end encryption on both direct and relay transports; the relay only
  forwards opaque frames.
- Pairing requires a one-time token, explicit local approval and a matching SAS;
  silent pairing is off by default.
- Device identity keys are stored in `$DSH_HOME/device-mesh/identity.json` with
  mode `0600`; private keys, tokens and session hashes are never logged.
- The portal binds `127.0.0.1` on an OS-assigned port and requires a 32-byte
  capability token exchanged for an `HttpOnly; SameSite=None; Secure` cookie.
- Revocation disconnects the active session and rejects future handshakes.

### Tests

- Core suite covering Noise NK/NKpsk0 official test vectors, handshake and
  authentication failure paths, RPC/stream multiplexing, store corruption
  recovery, pairing signature/expiry/replay rules, and portal authentication
  and forwarding.
- Transport suite covering direct round trips, limits and Origin checks, plus
  paseo-relay v1/v2 behavior against a real relay binary and mock relay tests.
- End-to-end suite with real `dsh web` instances: plugin load and client bundle
  in the boot graph, two-device direct pairing through SAS approval and portal,
  and a relay-only pairing/portal run with direct listeners disabled.

[Unreleased]: https://github.com/kfxhjz/dsh-device-mesh/compare/v0.1.3...HEAD
[0.1.3]: https://github.com/kfxhjz/dsh-device-mesh/releases/tag/v0.1.3
[0.1.2]: https://github.com/kfxhjz/dsh-device-mesh/releases/tag/v0.1.2
[0.1.1]: https://github.com/kfxhjz/dsh-device-mesh/releases/tag/v0.1.1
[0.1.0]: https://github.com/kfxhjz/dsh-device-mesh/releases/tag/v0.1.0
