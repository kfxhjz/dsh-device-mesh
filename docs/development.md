# Development and Maintenance Guide
[简体中文](zh/development.zh.md) | English

Status: applies to plugin `0.1.5` against DSH `0.2.2-rc.2`. This guide is for people who build, extend, review
or release the plugin. It covers the repository layout, DSH packaging and client-bundle contracts, the local
loop, host and UI integration seams, testing, debugging and releases.

The wire contract is normative in [PROTOCOL.md](PROTOCOL.md); architecture, security rationale and roadmap are
in [DESIGN.md](DESIGN.md). This guide explains how to work on the code and links to those documents instead of
restating them.

## Contents
1. [Scope and version baseline](#1-scope-and-version-baseline)
2. [Repository layout](#2-repository-layout)
3. [Plugin packaging contract](#3-plugin-packaging-contract)
4. [Client bundle contract](#4-client-bundle-contract)
5. [Local development loop](#5-local-development-loop)
6. [Host integration points](#6-host-integration-points)
7. [Client UI integration map](#7-client-ui-integration-map)
8. [Testing strategy](#8-testing-strategy)
9. [Debugging checklist](#9-debugging-checklist)
10. [Release and version policy](#10-release-and-version-policy)
11. [Related docs](#11-related-docs)

## 1. Scope and version baseline

- **DSH baseline:** `0.2.2-rc.2`; `package.json` declares
  `"engines": { "dsh": ">=0.2.2-rc.1 <0.3.0", "node": ">=24.9.0" }`.
- **Node:** 24.9+ to build and run `dsh web`; the desktop app ships its own
  runtime, so this matters mainly for development and CI.
- **pnpm:** `dsh plugin add`/`remove` forwards to pnpm. The desktop app's bundled
  CLI still needs pnpm on `PATH`; CI installs pnpm 11.
- **npm:** used for `npm ci`, the build, tests and `npm pack`.
- **DSH status:** developer preview. The manifest schema, client module loader,
  slot catalogue, Connection and WebServer services are not semver contracts.
  Treat a DSH upgrade as a code change, not a dependency bump.

`engines.dsh` is an admission check, not a sandbox. When a bundle declares `engines.dsh`, the Loader checks
only that range; without it, it checks the `@deepseek-ai/dsh*` peer ranges. A bundle outside the range is
skipped and reported in `skippedBundles`, never silently degraded. Version exemptions exist, but they are an
explicit risk decision and do not make incompatible code safe.

Every DSH upgrade needs the same regression pass: `npm ci && npm run build && npm run typecheck && npm test`;
`DSH_CLI=<dsh> npm run test:e2e`; install into a throwaway profile and check the boot graph, Devices panel,
pairing, remote workspace list and a portal tab; re-read the DSH slot catalogue and client-module docs for
every slot and service used here (§6–§7). Only then widen `engines.dsh`; never in advance.

## 2. Repository layout

```text
src/shared/   Wire types, RPC/session interfaces and transport seams. No
              node: imports, no DSH imports: the browser bundle inlines it.
src/host/     Host plugin: identity/store, pairing, broker, Noise channel,
              RPC/streams, transports, portal controller/daemon, workspaces,
              local Web API and DSH wiring.
src/client/   Browser plugin: Devices panel, pairing QR/link UI, overlay,
              remote workspace groups, styles and dictionaries.
scripts/      build.mjs: esbuild for the host bundle and the client wrapper.
docs/         Protocol, design, this guide and ADRs.
test/         core/, transport/, host/, client/ and e2e/ suites.
```

Rules that keep the split honest:

- `src/shared/` is the only code imported by both halves; it must stay free of
  Node built-ins and DSH packages so it can be inlined into `client.js`.
- The host half is trusted in-process Node code. It owns sockets, `$DSH_HOME`
  state, pairing, crypto and the portal, and must use `ctx.get(...)` so a missing
  optional service degrades to "feature unavailable".
- The client half is not a network peer. It never sees device keys, pairing
  tokens or the daemon's DSH cookie; it talks to its own host through
  `POST /api/device-mesh`, and all cross-device work happens in the host.
- `index.js` only re-exports `lib/host/index.js` so the package `main` resolves
  without rewriting `package.json` after a build.

## 3. Plugin packaging contract

`package.json` is the contract with the DSH Loader. Only these keys matter to DSH; everything else is ordinary
npm metadata.

| Key | Value here | Why it matters |
|---|---|---|
| `main` / `exports["."]` | `index.js` | Loader entry for the host half. |
| `exports["./client"]` | `./client.js` | Required whenever `dsh.client` is declared; missing it rejects the package at composition time. |
| `dsh.bundle.patch` | `./cordis.patch.yml` | Declares the package as a bundle and names its profile layer. |
| `dsh.client.platform` | `"web"` | The only browser platform DSH consumes. |
| `engines.dsh` | `>=0.2.2-rc.1 <0.3.0` | Loader admission range. |
| `files` | `index.js`, `client.js`, `lib/`, `cordis.patch.yml`, `locale/`, `icon.svg`, `README.md`, `LICENSE` | What `npm pack` publishes. `README.zh.md` is not listed but npm always includes it, so the tarball has 11 files. |

`cordis.patch.yml` inserts one bare-package Loader row:

```yaml
- insert:
    - id: device-mesh
      name: dsh-device-mesh
      config: {}
```

One row is enough. The client half is **not** a second row: DSH scans the Loader entry, finds the nearest
`package.json`, reads `dsh.client` and serves `exports["./client"]`. A second client row duplicates the graph
entry and is a common cause of a blank page.

Composition order matters. Later layers override earlier rows: profile `dsh.profile.bundles` in list order,
then the profile's own `cordis.patch.yml`, then the machine-level patch, then `--patch` overlays. A new bundle
is appended to the list, so it does not automatically win against an existing patch. Inspect the resolved
layer with `dsh --profile <profile> --dump-config`; never edit profile files by hand.

| Install surface | Command | Notes |
|---|---|---|
| npm registry | `dsh plugin --profile <profile> add dsh-device-mesh` | Recommended for users once the version is published; installs prebuilt files, no build approval. |
| Release tarball | `dsh plugin --profile <profile> add ./dsh-device-mesh-<version>.tgz` | Prebuilt fallback; a supported artifact. |
| Local checkout | `dsh plugin --profile <profile> add "$PWD"` | Appends the bundle and links the checkout; the development loop. |
| Desktop GUI / agent tool | Settings → Plugins / `plugin_manager` | Same pnpm operation; installs a local directory. The agent tool needs `danger-full-access` or per-call approval. |

### DSH profiles

A DSH **profile** is a named, ordered stack of plugin-bundle patch layers under
`$DSH_HOME/profiles/<name>/`. It owns its `package.json` (the `dsh.profile.bundles`
list and dependencies) and its `cordis.patch.yml`, so a bundle installed into one
profile is invisible to another. `dsh plugin --profile <name> add …` runs pnpm in
that profile directory and appends the bundle to its list; `--profile` is
required, and a profile is initialized on first use.

| You start | Install into |
|---|---|
| DSH Desktop | `desktop` |
| `dsh web` | `web` |
| `dsh headless` | `headless` |
| `dsh tui` | `tui` |
| `dsh --profile <name>` | `<name>` |

```sh
# Desktop app
dsh plugin --profile desktop add dsh-device-mesh

# Headless server running `dsh web`
dsh plugin --profile web add dsh-device-mesh

# A custom profile created from the shipped web template
dsh --from-default-profile web --profile edge --dump-config
dsh plugin --profile edge add dsh-device-mesh

# Inspect without booting
dsh plugin --profile desktop list --depth 0
dsh --profile desktop --dump-config
```

`$DSH_HOME` defaults to `~/.dsh`, so profiles live under `~/.dsh/profiles/`.

A linked directory is not filtered by `files`, so a rebuild is picked up without reinstalling; `files` applies
to `npm pack`. A git install runs against sources, so a `prepare` script needs approval in the profile's pnpm
settings; an npm package or `.tgz` avoids that step.

For the DSH side, see the official
[plugin development guide](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/index.md),
[publishing guide](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/publish.md)
and [client modules reference](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/client-modules.md).

## 4. Client bundle contract

`client.js` is not a normal browser bundle. It must be a lazy CommonJS factory:

```js
window.__ModuleLoader__.load({
  id: 'dsh-device-mesh',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    return module.exports
  },
})
```

- `id` must equal the package name; a mismatch fails with
  `loaded without registering "<id>" via __ModuleLoader__.load`.
- Script execution registers the factory only. Slots, styles and listeners belong
  in the exported Cordis plugin's `apply`, which runs at materialization. The
  factory returns that plugin: a function, object or class with `apply` and
  optional `inject`.

The DSH web shell freezes a baseline of shared modules. They must stay **external**; bundling React creates a
second React instance and breaks hooks.

```text
react, react/jsx-runtime, react-dom, react-dom/client, @deepseek-ai/cordis, zod,
@tanstack/react-virtual, dsh-client-store, @deepseek-ai/dsh-client-ui-slots,
@deepseek-ai/dsh-client-ui-primitives, @deepseek-ai/dsh-client-ui-dockkit
```

`dsh.client.external` is only for additional shell-provided infrastructure. Ordinary libraries are inlined
into `client.js`; do not mark them external.

`scripts/build.mjs` is a thin esbuild wrapper:

- **Host:** `src/host/index.ts` → `lib/host/index.js`, ESM, `node24`,
  `packages: 'external'` so `ws`, `@noble/ciphers` and Node built-ins resolve from
  the profile's `node_modules`.
- **Client:** `src/client/index.tsx` → `client.js`, CJS, `es2022`,
  `jsx: 'automatic'`, the baseline external list, plus banner/footer strings
  that produce the wrapper above.

Do not post-process `client.js`; change the TypeScript source or the build script and rebuild both halves.

HMR applies to the client bundle only. DSH watches the served `client.js` (mtime, ctime and size, polled
roughly every 500 ms), pushes a `rebuilt` event, and the browser re-materializes the module. It does not run
this repository's build: use `npm run watch`. A changed `package.json`, `cordis.patch.yml` or host bundle
still needs a DSH restart, because those change the composition or the Node process.

## 5. Local development loop

```sh
npm ci
npm run build          # host + client
npm run typecheck      # tsc --noEmit
npm test               # core + transport + host + client
npm run watch          # rebuild on change
```

To use a build in a real DSH instance, install the checkout into a throwaway profile and restart DSH once:

```sh
npm run build
dsh plugin --profile <profile> add "$PWD"
```

Use a separate `DSH_HOME` for experiments so a development identity, pairing records and audit log never touch
your real devices:

```sh
export DSH_HOME="$(mktemp -d)"
dsh web --no-open --port 0
```

The command prints `http://127.0.0.1:<port>/?token=…`. Exchange the launch token for the browser cookie by
opening that URL once, then use the browser normally. For headless probing, keep the cookie jar and call
`/api/device-mesh` with `{ "endpoint": "...", "payload": ... }`.

Desktop DSH reads only the reserved `desktop` profile; `dsh web` uses the profile you pass (commonly `web`).
Installing into the wrong profile is the most common "the plugin is not there" report.

| Change | Action |
|---|---|
| `client.js` / `src/client/**` | Rebuild; HMR swaps the bundle. Refresh if the page opened before HMR was active. |
| `lib/host/index.js` / `src/host/**` | Rebuild and restart DSH; host code runs in the Node process. |
| `package.json`, `cordis.patch.yml`, `locale/*.json` metadata | Reinstall/restart; the Loader composition changed. |
| `scripts/build.mjs` | Rebuild; restart only if the host bundle changed. |

End-to-end tests use these environment variables:

| Variable | Purpose |
|---|---|
| `DSH_CLI` | `dsh` executable for isolated instances; fallback is the macOS packaged CLI, then `dsh` on `PATH`. |
| `PASEO_RELAY_BIN` | paseo-relay binary for the relay E2E case; fallbacks `.build/bin/paseo-relay` and `.build/paseo-relay-target/release/paseo-relay`. Skipped if absent. |
| `DSH_MESH_FORCE_BUILD` | Set to `1` to rebuild before the run instead of reusing artifacts. |

The harness creates disposable homes under `.test/e2e/`; it never reads or writes the real `$DSH_HOME`. To
exercise a local relay, run `CARGO_TARGET_DIR="$PWD/.build/paseo-relay-target" cargo build --release` in a
paseo-relay checkout, or point `PASEO_RELAY_BIN` at an existing binary.

## 6. Host integration points

The host entry declares `inject = ['webServer', 'connection']`. Both services are composed by the shipped Web
and Desktop profiles. Everything else — workspace registry, sessions, titles, agents — is looked up
defensively and may be absent in a reduced composition. The architectural rationale is in
[DESIGN.md §8](DESIGN.md#8-dsh-integration).

1. **Local browser API.** During `apply` the plugin calls
   `ctx.connection.fetch.register({ path: '/api/device-mesh', methods: ['POST'], requestBody: 'buffered', fetch })`.
   This mounts the handler on DSH's cookie-authenticated `/api` channel: only a DSH owner session can reach it.
   It is a same-machine control channel, not a cross-device API.
2. **Local DSH origin.** `ctx.webServer.getOrigin()` returns the real scheme,
   host and port of the running DSH instance; the portal must not guess
   `127.0.0.1:3080`.
3. **Local DSH authentication.** `ctx.connection.authenticatedUrl(origin)`
   returns a launch URL that sets a `dsh-auth-*` browser cookie. The daemon
   follows the `303` manually (automatic redirects hide `Set-Cookie`), keeps only
   the `dsh-auth-*` value in memory, and refreshes it near expiry or after an
   upstream `401`. It is never written to disk, logged or sent over the Mesh.

The portal splits cookie handling. The browser talks to `127.0.0.1:<portal-port>` with a portal-scoped
`HttpOnly; SameSite=None; Secure` cookie, while the daemon injects its own DSH cookie upstream. Loopback
cookies are host-scoped, not port-scoped, so the request fence (exact `Host`, same-origin `Sec-Fetch-Site`,
WebSocket `Origin`) stops another loopback page from *using* the cookie, but cannot stop another local HTTP
server from reading it server-side. Cookie-authenticated HTTP requests must carry `Sec-Fetch-Site`
(`same-origin` or `none`); a missing header is rejected, so non-browser cookie clients are unsupported. Hop-by-hop headers, `Host`, `Cookie`, `Origin`, `Referer`, `sec-fetch-*` and
the whole DSH-owned `x-dsh-*` namespace are stripped at the trust boundary and reconstructed on the daemon side;
`Set-Cookie`, `X-Frame-Options` and CSP `frame-ancestors` are removed (and `X-Content-Type-Options: nosniff`
added) so the local page can embed the remote UI. Full rules:
[PROTOCOL.md §7](PROTOCOL.md#7-portal-forwarding).

These interfaces are version sensitive even though they are public services. `connection.fetch.register`,
`webServer.getOrigin`, `authenticatedUrl` and the `/api` trust fence are internal product contracts, not a
semver API. A DSH upgrade can change a signature, cookie attribute, Origin rule or header name. Re-run the
portal E2E and manual checks after every upgrade; a green typecheck is not enough.

## 7. Client UI integration map

The client bundle is a normal Cordis plugin using `ctx.slots.inject` and `ctx.slots.register`. It uses four
slots:

| Slot | Kind | What this plugin registers |
|---|---|---|
| `main` | keyed | The Devices panel, key `device-mesh`. The `sidebar.panellist` id must match, and the panel must register before `ctx.layout.selectPanel` can succeed. |
| `sidebar.panellist` | list | The Devices icon row, with the pending-pairing badge. |
| `shell.overlay` | list | The click-through overlay that keeps pending pairing requests visible while the panel is closed. |

The host switcher above **Workspaces** is deliberately not a slot registration:
ui-sidebar exposes no slot between the panel list and `sidebar.workspaces`
(a single slot owned by ui-workspace). `src/client/sidebar-host.ts` inserts a
small plain-DOM bar before ui-workspace's section header
(`data-sidebar-workspace-header`, with the shipped `sectionHeader` class as a
fallback), re-inserts it after re-renders, and hides it in the 56px rail. Keep
it dependency-free (no `react-dom`) and fail-soft: if the anchor changes, the
panel-list entry and the Devices panel remain the fallback entrance.

Every registration follows one pattern:

```ts
ctx.slots.inject('main', () => ctx.slots.register({
  name: 'main', key: 'device-mesh', locale: NS,
  inject: () => ({ openRemoteTab }),
}, DevicesPanel))
```

- Wait for the slot declaration; never register directly at apply time.
- A `list` slot needs an `id` and should set `order` and `locale`; a `single`
  slot is claimed by priority.
- Components do not receive `ctx`; data and callbacks arrive through `inject`
  hooks/props or the local API module, and `apply` looks up services. Style,
  locale and effect registrations return disposers via `ctx.effect`.

The Devices panel is the **management** surface: **This device** (identity, direct listener, relay) and
**Remote devices** (pairing, status, open/revoke/forget). Workspaces are not repeated in the panel: a
plain-DOM **host switcher above the native Workspaces header** selects the host and mirrors its workspaces and
sessions in place of the native list (read-only; rows open the remote portal). DSH's native
`sidebar.workspaces` is a single slot owned by `ui-workspace`, and native workspace rows expose no third-party
slot. Injecting remote rows would mean replacing that tree and duplicating search, grouping, drag-and-drop,
hover cards and session creation.
[DESIGN.md §8.3](DESIGN.md#83-local-vs-remote-workspaces) records this boundary.

The clean final form is a small upstream `ui-workspace` slot, `sidebar.workspace.row.trailing`, so a plugin
can render a device badge on a native workspace row and use the native tree for both scopes. That is a roughly
30-line upstream change, not a protocol dependency, and it is not part of the MVP. Do not patch `ui-workspace`
in this repository.

Mobile and scanning limits: the controller is a Web client and works in a mobile browser or WebView, but the
DSH mobile layout still applies (drawer sidebar, hover gated on `@media (hover: hover)`, coarse-pointer
targets). Portal cookie authentication requires Fetch Metadata (`Sec-Fetch-Site`; Chromium 88+,
Firefox 90+, Safari 16.4+); older browsers can only pair/manage, not open the remote UI. QR scanning uses `BarcodeDetector`, available on Chromium-based browsers (including Android Chrome)
in a secure context; Safari on iOS does not provide it and HarmonyOS browser support is unverified, so keep the
paste-link fallback. There is no mobile application or native camera integration; background keep-alive,
permissions and a native shell for Android / iOS / HarmonyOS are separate work. Deep links are best effort:
the controller appends `?dm-session=<id>&dm-embed=1` to the portal URL; the portal stores the id and the remote
copy of this plugin opens that Session (`uiWorkspace.openSession`) once the shell is ready, falling back to the
remote home page when DSH's UI surface changes.

## 8. Testing strategy

Run `npm run lint` (Oxlint + the DSH `@stylistic` formatting rules), `npm test` before every pull request and `npm run test:e2e` for changes that touch transport, pairing, the
portal, DSH wiring or the client boot graph.

| Suite | Command | Covers |
|---|---|---|
| Core | `npm run test:core` | Noise NK/NKpsk0 vectors, crypto, channel authentication (including the paired-vs-pair-token invariant), RPC/stream multiplexing, portal WebSocket close accounting, tamper/replay failures. |
| Transport | `npm run test:transport` | Direct listener/client, Origin rejection, limits, relay v1/v2 against a mock and a real relay. |
| Host | `npm run test:host` | Store atomicity/recovery and identity key-pair validation, pairing signatures/TTL/replay, broker (including relay-ticket gating and pending-request cancellation), workspace mapping plus the 64 KiB listing budget, portal controller/daemon, local Web API. |
| Client | `npm test` | Direct unit tests for the client store, normalizers, i18n dictionaries, QR and deep-link helpers, a happy-dom test for the sidebar host bar/switcher, plus static checks that the bundle registers the expected slots and has no host-only imports. |
| Coverage | `npm run test:coverage` | The same suites over `src/**/*.ts`. On Node 26 `--test-coverage-include-all` counts never-loaded files and enforces 80/72/77 line/branch/function thresholds; Node 24 falls back to loaded-file thresholds (89/72/77), and CI runs both modes on Ubuntu. The `src/client/index.tsx` bundle entry is deliberately out of scope (the include glob is `.ts`-only); its wiring contract is covered by the bundle test. |
| End-to-end | `npm run test:e2e` | Two isolated `dsh web` instances: plugin load and local API; direct pairing, SAS approval, workspace list and portal; relay-only pairing and portal; portal WebSocket text frames. |
| Browser UI | `npm run test:ui` (part of `test:e2e`) | Headless Chrome opens the portal and boots the daemon's real DSH UI, including its text-frame Remote stream WebSocket; skips without Chrome. |

The real paseo-relay case is optional. Set `PASEO_RELAY_BIN`, or build the relay under `.build/`; without the
binary the case is skipped, not failed. Mock-relay tests still run, so transport regressions are caught in a
plain checkout.

Use `npm run release:check` before tagging: it runs the build, typecheck, unit and E2E suites plus `npm pack --dry-run`,
matching the automated half of [`RELEASE.md`](../RELEASE.md).

CI runs `npm ci`, `npm run build`, `npm run typecheck`, `npm run lint` and `npm test` on Ubuntu and macOS
for Node.js 24 and 26, and the same unit gate on Windows for Node.js 24 in a separate job (a Windows-only
failure does not gate the E2E jobs). Coverage runs on Ubuntu for both Node versions: the full include-all gate
on Node 26 and the loaded-file fallback on Node 24. Both E2E jobs and the release gate run on Node 26;
`npm run test:e2e` uses `DSH_CLI=dsh` with DSH `0.2.2-rc.2` installed globally. A separate `e2e-relay` job
builds the pinned paseo-relay `v0.1.2` binary and runs `test/transport/relay-e2e.test.ts` plus
`test/e2e/relay.test.ts` against it. The nightly schedule repeats the full run and also executes the soak suite.

The release workflow (`.github/workflows/release.yml`) runs the same gate through `npm run release:check`,
verifies that the `v*` tag matches `package.json`, writes `SHA256SUMS`, and publishes the tarball with release
notes generated from `CHANGELOG.md` by `scripts/release-notes.mjs`.

Tests must not require a real `$DSH_HOME`, a network peer or a camera. Generate fixtures at test time under a
temporary directory. Never paste real device names, LAN addresses, host IDs, pairing links or tokens into a
fixture.

## 9. Debugging checklist

| Symptom | Likely cause | Check or fix |
|---|---|---|
| Blank page or plugin missing | Bundle not registered, wrong `id`, missing `exports["./client"]`, or wrong profile | Read the boot audit and host log; check `exports` and the Loader row; confirm the surface's profile (`desktop` vs `web`). |
| `require("x") missed the module table` | Baseline bundled, or a non-baseline module marked external | Keep the §4 baseline external; inline other libraries; do not invent `dsh.client.external` entries. |
| Invalid hook call / two Reacts | React or `react-dom` was bundled | Rebuild with the baseline external list; check the esbuild options, not just imports. |
| Slot registration throws | Undeclared slot, duplicate `id`, or a conflicting `single` claim | Inspect the slot catalogue for the DSH version; confirm the slot, props and id shape. |
| Plugin listed in `skippedBundles` | `engines.dsh`/peer range mismatch, or `dsh.bundle.platforms` excludes the host | Print the skipped reason; widen the range only after the regression pass, or add an explicit exemption. |
| Loader row present but ineffective | A higher patch layer overrides/disables the row, or an override replaces the whole `config` | `dsh --profile <profile> --dump-config`; restate the full config in the override. |
| `client.js` changed but page did not | HMR disabled, timestamp/size unchanged, or the manifest changed | Confirm `client-hmr` is active; touch the built file; restart after manifest/patch changes. |
| Portal 403/401 or login loop | Origin/Host fence, missing trusted authority, expired DSH cookie, or cookie attribute | Verify loopback, `getOrigin()`, `authenticatedUrl()`, `--trusted-host`, TLS and the portal cookie; see §6. |
| Relay never connects | Wrong endpoint, TLS/Origin allowlist, `serverId` mismatch, or unreachable relay | Check `wss://…/ws`, the certificate and relay logs; confirm both ends share `serverId`; repeated `1013` is capacity/admission, not protocol. |
| Direct connection times out | Firewall blocks the plugin port, or the ticket advertised an unreachable interface | Allow TCP `45871` (or configured port); prefer Tailscale; check the ticket endpoint list. |
| Desktop portal window/right sidebar looks wrong | This path is not automated | Verify manually in Electron and note the result in the pull request. |

When a failure is security relevant, redact first: remove tokens, keys, cookies, `serverId` values, pairing
links and private paths from logs and screenshots.

## 10. Release and version policy

`prepack` runs `npm run build`, so `npm pack` and `npm publish` always include
`client.js` and `lib/`; `prepublishOnly` additionally runs `npm test`. A release
starts from a clean checkout, not a working tree:

1. Run `npm ci`, `npm run typecheck`, `npm run lint`, `npm test`,
   `npm run test:coverage` and `npm run test:e2e` (with a DSH CLI, plus a real
   paseo-relay if relay behavior changed); `npm run release:check` runs the same
   automated gate.
2. Run `npm run build`; inspect `lib/host/index.js` and confirm `client.js`
   starts with the generated `__ModuleLoader__.load` banner.
3. Run `npm pack --dry-run`; the tarball must contain the 11 expected files:
   `index.js`, `client.js`, `lib/host/index.js`, `cordis.patch.yml`,
   `locale/en.json`, `locale/zh.json`, `icon.svg`, `README.md`, `README.zh.md`,
   `LICENSE` and `package.json`.
4. Install the tarball into a throwaway profile, repeat the smoke test, update
   [CHANGELOG.md](../CHANGELOG.md) and tag the release.

Never commit build outputs or local state: `lib/`, `client.js`, `node_modules/`, `.test/`, `.build/`, `*.tgz`,
`.pnpm-store/`, `$DSH_HOME` profiles, device identities, pairing records, tokens, private keys or audit dumps.
`.gitignore` covers the usual paths; check `git status --short` before staging.

Version policy: the plugin version is independent of the wire version. A release that keeps protocol `1` does
not require re-pairing; an incompatible wire change bumps `PROTOCOL_VERSION` and does. `engines.dsh` is part
of the release contract: do not publish a range you have not tested; DSH skips the bundle rather than
degrading. Security and protocol changes follow [SECURITY.md](../SECURITY.md) and [PROTOCOL.md](PROTOCOL.md)
and update both with the code. Do not publish `private` packages, and do not rely on a git install to run a
build: publish the artifact or document the `prepare`/approval step.

## 11. Related docs

- [README](../README.md) — installation, pairing and operation.
- [CONTRIBUTING](../CONTRIBUTING.md) — workflow, commands and PR expectations.
- [DESIGN](DESIGN.md) — architecture, threat model, DSH integration and roadmap.
- [PROTOCOL](PROTOCOL.md) — wire format, RPC, portal and relay rules.
- [ADR 0001](adr/0001-remote-control-in-dsh.md) — why the MVP uses a host-side
  mesh plus a loopback portal instead of a second client tree.
- [SECURITY](../SECURITY.md) — reporting and deployment hardening.
- DSH reference: [client modules](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/client-modules.md),
  [slots](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/slots.md),
  [web server](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/web-server.md),
  [web client](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/web-client.md).
