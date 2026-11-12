# Release checklist

[简体中文](RELEASE.zh.md) | English

This document is the release gate for `dsh-device-mesh`. It assumes DSH
`0.2.2-rc.2` and plugin `0.1.x` (developer preview). Do not tag a release while
any item below is unchecked.

## 1. Automated gate

Run from a clean checkout with `node >= 24.9`:

```sh
npm ci
npm run build
npm run typecheck
npm test
npm run test:coverage               # source coverage thresholds
npm run test:e2e       # needs a dsh CLI; optional relay binary; Chrome for the browser test
npm pack --dry-run     # must list 11 files (lib/, client.js, cordis.patch.yml, locale, icon, READMEs, LICENSE)
```

| Check | Expected |
|---|---|
| `npm run build` | `lib/host/index.js` and `client.js` produced |
| `npm run typecheck` | no errors |
| `npm test` | all unit/host/client tests pass |
| `npm run test:coverage` | source line/branch/function thresholds pass (full gate on Node 26, fallback on Node 24) |
| `npm run test:e2e` | plugin load, direct pairing + portal, portal WebSocket text frames, real paseo-relay path, real-browser remote UI; browser test skips without Chrome |
| `npm pack --dry-run` | 11 files, no tests/docs/`node_modules`/secrets |
| `git status --short` | empty |

Optional environment for the E2E suite:

- `DSH_CLI=/path/to/dsh` — defaults to the desktop app's bundled CLI, then `dsh` on `PATH`.
- `PASEO_RELAY_BIN=/path/to/paseo-relay` — enables the relay-only case; otherwise it skips.
- `CHROME_PATH=/path/to/chrome` — enables the real-browser UI case; otherwise it skips.

## 2. Manual verification matrix

The automated suite proves the protocol and that the remote DSH shell boots in
Chrome. Before tagging, perform this matrix on real devices (one column per
device class; record the OS/DSH version actually used).

| Scenario | A: Linux desktop | B: Linux server | C: macOS desktop | D: mobile browser |
|---|---|---|---|---|
| Build + `dsh plugin --profile <profile> add <dir>` | ☐ | ☐ | ☐ | — |
| Restart DSH, **Devices** entry visible, plugin listed in Settings | ☐ | ☐ | ☐ | — |
| Daemon shows pairing QR; controller scans or pastes the link | ☐ | ☐ | ☐ | ☐ paste |
| Both screens show the same SAS; daemon approves | ☐ | ☐ | ☐ | ☐ |
| Remote UI opens through the portal and a prompt/response works | ☐ | ☐ | ☐ | ☐ |
| Remote approvals, terminal and file preview work | ☐ | ☐ | ☐ | ☐ |
| `Open in right sidebar` behaves on the desktop shell | ☐ | n/a | ☐ | n/a |
| Relay-only run (direct disabled, public relay) | ☐ | ☐ | ☐ | ☐ |
| Revoke on the daemon closes the controller session immediately | ☐ | ☐ | ☐ | ☐ |
| Direct LAN/Tailscale run without relay | ☐ | ☐ | ☐ | — |

Note any failure with device, DSH version, logs (tokens removed) and the exact
step; a single failed “remote prompt/approval” item blocks the release.

## 3. Security sign-off

- [ ] The security review findings classified Critical/High are fixed and their
      regression tests pass.
- [ ] No pairing link, `identity.json`, `peers.json`, DSH cookie or portal
      capability URL appears in logs, issues, screenshots or the release notes.
- [ ] `SECURITY.md` points at a real private reporting channel.
- [ ] Public deployments use `wss://` for the relay and never expose the portal
      port; deployment hardening in `SECURITY.md` was read.
- [ ] The release notes state the remaining known risks in the
      “Known limitations” section.

## 4. Repository and package

- [ ] Version in `package.json` matches `CHANGELOG.md` (`0.1.x`).
- [ ] `CHANGELOG.md` has a dated section for the release; no dead links.
- [ ] Git history is the intended public history (no secrets, no personal
      machine paths; author identity is deliberate).
- [ ] `npm pack` tarball installed into a throwaway `DSH_HOME` and booted once:

  ```sh
  DSH_HOME=$(mktemp -d) dsh plugin --profile web add ./dsh-device-mesh-0.1.2.tgz
  DSH_HOME=... dsh web --no-open --port 0
  ```

- [ ] Tag `v0.1.x` and publish release notes (install command, checksum,
      platform matrix, known limitations). The tag pushes
      `.github/workflows/release.yml`, which verifies the tag against
      `package.json`, reruns the gate, writes `SHA256SUMS`, and generates the
      release body from `CHANGELOG.md`. Publishing to npm is optional; the `.tgz`
      is a supported artifact.

## 5. Known limitations to repeat in every release note

- Developer preview: DSH plugin/slot/service contracts can change between
  versions; rerun this checklist for each DSH upgrade.
- Windows is not part of the tested matrix. Android/iOS/HarmonyOS have no build
  yet (the controller is a Web client bundle).
- Revocation and grant expiry close sessions immediately on revoke and within a
  30-second sweep for expiry; the close code for revocation is `1000`, not
  `4403`.
- One-time pairing tokens are consumed on first presentation: a denied or timed
  out attempt needs a fresh ticket.
- The portal proxies the daemon's complete DSH Web UI; it is owner-level control
  of that device. Only pair devices you trust.
- The sidebar host bar and the read-only remote workspace mirror are inserted as
  plain DOM above ui-workspace's section header (there is no plugin slot at that
  position). Remote rows only open the remote control portal; workspace/session
  management stays in the remote UI. If a DSH upgrade changes the sidebar DOM the
  bar/mirror hide themselves and the Devices panel-list entry remains the fallback.
- The portal cookie is host-scoped, not port-scoped: another local web server the
  user visits can read it server-side. Cookie-authenticated portal requests also
  require browser Fetch Metadata (`Sec-Fetch-Site`), so browsers that do not send
  it cannot open the remote UI. Local processes are only partially trusted;
  close unused portal tabs. The remote UI also runs in the portal's loopback origin
  and can reach other loopback services (DSH's `/api` Origin fence protects the DSH
  API, other services may not be defended).
- Remote workspace listings are capped at 100 workspaces / 200 sessions and are
  marked truncated when trimmed; large profiles should use the remote UI directly.
- The controller waits up to ~5.5 minutes for pairing approval (longer than the
  daemon's 5-minute request window); a closed controller session denies its pending
  request. A pairing ticket advertises relay only while this device serves relay.
