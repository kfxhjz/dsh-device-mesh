# Contributing to DSH Device Mesh

[简体中文](CONTRIBUTING.zh.md) | English

Thanks for taking the time to contribute. This document covers the development
environment, the plugin packaging contract, the review rules and the tests we
expect before a pull request is merged. [docs/development.md](docs/development.md)
is the deeper maintainer guide: packaging, host/UI seams, testing and releases.

By participating you agree to keep discussions technical and respectful, and to
license your contributions under the repository's [MIT license](LICENSE).

## Development environment

| Requirement | Notes |
|---|---|
| Node.js `>=24.9.0` | The host bundle targets `node24`; Node 26 is recommended for the full source-coverage gate (`.nvmrc`). |
| npm | The repository uses `package-lock.json`; `npm ci` is fine for clean installs. |
| pnpm | `dsh plugin add`/`remove` forwards to pnpm, so the DSH CLI needs pnpm on `PATH`; CI uses pnpm 11. |
| DSH `0.2.2-rc.2` | The plugin is built and tested against this baseline (`engines.dsh` is `>=0.2.2-rc.1 <0.3.0`). |
| Optional: paseo-relay | Only needed for the relay end-to-end test and for manual public-path testing. |

```sh
git clone <repo-url> dsh-device-mesh
cd dsh-device-mesh
npm ci
npm run build
npm run typecheck
npm test
```

## Commands

| Command | What it does |
|---|---|
| `npm run build` | Builds both halves: `lib/host/index.js` and `client.js`. |
| `npm run build:host` | Host bundle only. |
| `npm run build:client` | Client bundle only (use while working on UI). |
| `npm run watch` | Rebuilds on change. |
| `npm run typecheck` | `tsc -p tsconfig.json --noEmit`. |
| `npm test` | Core, transport, host and client suites. |
| `npm run test:coverage` | The same suites with source line/branch/function coverage thresholds. |
| `npm run test:core` / `test:transport` / `test:host` | One suite at a time. |
| `npm run lint` | Oxlint (the same linter family as DSH upstream) over `src`, `test` and `scripts`, including the DSH `@stylistic` formatting rules and import hygiene (`import type` at top level, no duplicate module imports). |
| `npm run check:scripts` | `node --check` over `scripts/` (Oxlint ignores `.mjs` files, so this catches syntax errors before a workflow runs). |
| `npm run test:e2e` | Boots real `dsh web` instances; see below. |

The development-only ESLint chain loaded by the Oxlint `@stylistic` plugin is
pinned through the `overrides` entry in `package.json` (`minimatch` 11.x) because
the range ESLint declares still carries a globbing denial-of-service advisory.
Revisit the override when ESLint ships a compatible range.

To try a change in a real DSH profile, build and reinstall the checkout into a
throw-away profile, then restart DSH:

```sh
npm run build
dsh plugin --profile desktop add "$PWD"
```

Use an isolated `DSH_HOME` when experimenting so you do not disturb your real
device identity and pairings.

## Repository layout

```text
src/shared/   wire types, transport and session interfaces (no Node dependencies)
src/host/     host plugin: Noise/channel/session, transports, store, pairing,
              workspaces, portal controller/daemon, DSH wiring
src/client/   Web client plugin: Devices panel, pairing QR, remote workspaces
scripts/      build script
docs/         design, protocol, development guide and ADRs
test/         core, transport, host, client and end-to-end suites
```

The host plugin is trusted in-process Node.js code. It may open sockets, make
outbound connections and read `$DSH_HOME`; keep that power narrow and auditable.
The client plugin runs in the DSH browser shell and talks only to the local host
plugin through the same-origin `/api/device-mesh` route.

## Plugin packaging contract

These points are easy to break and hard to debug. Read them before changing
`package.json`, `cordis.patch.yml` or `scripts/build.mjs`.

### Bundle manifest

- `package.json` must keep `dsh.bundle.patch` pointing at `cordis.patch.yml`,
  and `dsh.client.platform` must stay `"web"`.
- `prepack` rebuilds both halves, so `npm pack` from a clean checkout always
  contains `client.js` and `lib/host/index.js`. Keep it; `prepublishOnly` alone
  does not run for `npm pack`.
- A package that declares `dsh.client` **must** export `./client`; otherwise the
  DSH composition step rejects the package.
- `cordis.patch.yml` inserts one bare-package loader row. Do not write the client
  half into the patch: DSH discovers it from the package manifest.
- Keep `engines.dsh` accurate. A wrong range causes DSH to skip the bundle (it is
  reported in `skippedBundles`, not silently ignored).

### Client bundle format

`client.js` is not a plain browser bundle. It must be a lazy CommonJS factory
wrapped exactly like this:

```js
window.__ModuleLoader__.load({
  id: 'dsh-device-mesh',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    // bundled client code
    return module.exports
  },
})
```

- The `id` must equal the package name (`dsh-device-mesh`), otherwise the shell
  reports `loaded without registering "<id>" via __ModuleLoader__.load`.
- Registration must be side-effect free until the factory runs; UI slots and
  effects belong in the plugin's `apply`.
- The DSH shell provides a fixed baseline of shared modules. They must stay
  **external** and must never be bundled, or the page ends up with a second
  React instance and hooks fail:

  `react`, `react/jsx-runtime`, `react-dom`, `react-dom/client`,
  `@deepseek-ai/cordis`, `zod`, `@tanstack/react-virtual`, `dsh-client-store`,
  `@deepseek-ai/dsh-client-ui-slots`, `@deepseek-ai/dsh-client-ui-primitives`,
  `@deepseek-ai/dsh-client-ui-dockkit`.

- Other libraries are inlined into the bundle. Do not add them to
  `dsh.client.external` unless they are genuinely shell-provided
  infrastructure.
- Slot names and service contracts track the DSH version. When you use a new
  slot, verify it exists on the supported DSH baseline and degrade cleanly when
  it is absent. See [docs/development.md](docs/development.md#7-client-ui-integration-map)
  and [docs/DESIGN.md §8.3](docs/DESIGN.md#83-local-vs-remote-workspaces).

### What not to commit

The following are generated, local or secret and are ignored by `.gitignore`:

- `node_modules/`, `lib/`, `client.js` (build outputs)
- `.test/`, `.build/`, `.npm-cache/`, `.pnpm-store/`, `*.tgz`
- local `$DSH_HOME` state, profiles, device identities and pairing records
- pairing links, one-time tokens, private keys, cookies, audit dumps from a real
  device

If you need a fixture, generate it at test time under a temporary directory. Do
not paste real device names, LAN addresses, hostnames or user paths into source,
tests, docs or screenshots.

## Coding conventions

- TypeScript, ES modules, two-space indentation, no semicolon-free style change.
- Keep `src/shared/` free of Node.js imports so it stays reusable by the browser
  half.
- Prefer the existing structural service access (`ctx.get`) and fail soft when
  an optional DSH service is missing.
- Never log pairing tokens, private keys, session hashes, cookies or message
  bodies. Log device ids only when the message needs them.
- New protocol behavior is a spec change: update
  [docs/PROTOCOL.md](docs/PROTOCOL.md) in the same pull request and bump the
  protocol version for incompatible changes.
- Keep user-visible strings in `src/client/locale.ts`; every key needs both
  `zh` and `en` copy.

## Commit and pull request conventions

- Use Conventional Commit-style subjects: `feat:`, `fix:`, `docs:`, `test:`,
  `refactor:`, `chore:`. Imperative mood, 72 characters or fewer.
- One logical change per pull request. Split unrelated refactors, vendor bumps
  and behavior changes.
- The body should explain **why**, not restate the diff. Reference issues with
  `Fixes #123` when applicable.
- Update [CHANGELOG.md](CHANGELOG.md) under `[Unreleased]` for user-visible
  changes (`Added`, `Security`, `Tests`).
- Pull requests should state:
  - what changed and why;
  - which platforms/DSH versions were exercised;
  - the exact commands run and their result;
  - any unverified behavior (desktop window UI, camera scanning, mobile builds
    for Android / iOS / HarmonyOS, …).
- Run `git diff --check` before pushing; do not commit conflict markers or
  trailing whitespace.

## Testing requirements

### Unit and transport tests

Run `npm test`. A pull request that changes protocol, crypto, pairing,
persistence or the portal proxy needs:

- positive coverage for the new path;
- negative coverage for tampering, replay, expiry, wrong scope and oversized
  frames where applicable;
- updated Noise test vectors when the handshake implementation changes
  (`test/core/vectors/`).

### End-to-end tests

`npm run test:e2e` starts two isolated DSH homes and drives them through the
local `/api/device-mesh` route. It needs a DSH CLI:

- Set `DSH_CLI` to the `dsh` executable, for example
  `DSH_CLI="$(command -v dsh)"` after installing `@deepseek-ai/dsh`.
- If `DSH_CLI` is unset, the harness tries the macOS packaged CLI and then
  `dsh` on `PATH`.
- The browser UI case launches headless Chrome (Playwright drives the installed
  Chrome, no browser download). Set `CHROME_PATH` if it is not in a standard
  location; the case skips otherwise.
- Run `npm run release:check` before a release; it runs `RELEASE.md`'s automated
  gate (build, typecheck, unit, E2E, pack).
- The relay case needs a paseo-relay binary. Set `PASEO_RELAY_BIN` to its path,
  or place a build under `.build/`. When it is absent the relay case is skipped,
  not failed.
- `DSH_MESH_FORCE_BUILD=1` forces a rebuild first.

The harness creates disposable homes under `.test/e2e/`; it never reads or
writes your real `$DSH_HOME`.

### Manual checks

For UI changes, install the build into a throw-away DSH profile and check the
Devices panel, pairing dialog, remote workspace list and portal in a real
browser. For desktop changes, note explicitly that the Electron window and
right-sidebar behavior were (or were not) checked by hand — this area is not
covered by automation.

## Security

Do not open a public issue for a vulnerability. Follow
[SECURITY.md](SECURITY.md). When in doubt, redact first: remove tokens, keys,
cookies, `serverId` values, pairing links and private paths from logs and
screenshots.

## License

Contributions are accepted under the [MIT license](LICENSE).
