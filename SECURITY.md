# Security Policy

[简体中文](SECURITY.zh.md) | English

## Supported versions

DSH Device Mesh is pre-1.0. Security fixes are made on the latest `0.0.x`
release; older `0.0.x` builds and unreleased commits are not supported.

| Version | Supported |
|---|---|
| `0.0.x` (latest release) | ✅ |
| Older `0.0.x` releases | ❌ |
| Unreleased branches / forks | ❌ |

The plugin targets DSH `>=0.2.2-rc.1 <0.3.0`. A DSH version outside that range is
rejected at load time rather than run with an unknown security contract.

## Reporting a vulnerability

**Do not open a public issue, discussion or pull request for a vulnerability.**

Use GitHub Security Advisories:

<https://github.com/kfxhjz/dsh-device-mesh/security/advisories/new>

The advisory form is private until a fix is ready. If GitHub Advisories are
unavailable, contact a maintainer privately through the repository.

Please include:

- affected version or commit, DSH version and platform;
- a description of the impact and the attacker's position (LAN, public
  internet, malicious relay, local process, stolen device);
- minimal reproduction steps or a proof of concept;
- relevant logs with tokens, keys, cookies, pairing links, `serverId` values and
  personal paths removed.

**Never attach** a live pairing link or QR screenshot, a private key,
`identity.json`, `peers.json`, a DSH session cookie or a portal capability URL.
If a secret may already be compromised, say so in the report instead of sending
it.

We aim to acknowledge a report within 5 business days, agree on a disclosure
timeline after triage, and credit reporters who want credit. Please give us a
reasonable window (typically 90 days) before public disclosure.

## Threat model summary

### Assets

- Remote **owner-level control** of a DSH device (conversations, approvals,
  terminal, files, settings).
- Device identity keys (Ed25519 signing key, X25519 static key).
- Pairing tickets, one-time tokens and the SAS approval decision.
- The daemon's DSH browser session cookie.
- Audit records and the list of paired devices.

### Adversaries considered

- A network attacker on the LAN, Tailscale or public internet.
- A malicious or compromised **relay** operator.
- Someone who obtains a pairing link, QR screenshot or device backup.
- A stolen or lost device that was previously paired.
- A malicious paired controller acting after approval.
- A local unprivileged process on the controller or daemon host.

### Trust boundaries and guarantees

- **DSH host plugins are trusted code.** A host plugin runs in-process in the DSH
  Node.js runtime, outside the agent workspace sandbox. Installing a plugin is
  equivalent to running its code. This plugin does not sandbox other plugins.
- **The relay is untrusted.** Every transport runs
  `Noise_NK_25519_ChaChaPoly_SHA256` end to end. The relay sees connection
  metadata, frame sizes and timing, and can drop or delay traffic, but cannot
  read or undetectably modify mesh frames.
- **Device identities are pinned.** The daemon's Ed25519/X25519 public keys are
  distributed out of band in the pairing ticket and pinned by the controller;
  the daemon pins the controller's keys after approval. A key change requires
  re-pairing and is surfaced as an identity warning.
- **Pairing requires a human.** A one-time token proves possession of the
  ticket; a local approval dialog and a 6-digit SAS bind the cryptographic
  session to the person at the daemon. The default is never silent approval.
- **The portal is loopback-only.** The controller-side portal binds
  `127.0.0.1` on an OS-assigned port and requires a 32-byte capability token
  exchanged for an `HttpOnly; SameSite=None; Secure` cookie. Cookie-authenticated
  HTTP requests must carry `Sec-Fetch-Site: same-origin` or `none`; a missing
  header is rejected, so browsers without Fetch Metadata cannot use the portal.
  The DSH Web cookie stays
  in the daemon's memory and is never sent over the mesh.
- **Revocation is immediate; expiry is bounded.** Revoking or forgetting a
  device disconnects its live sessions and rejects future handshakes. Grant
  expiry is re-checked on every RPC and by a 30-second sweep, so an
  already-established session closes within 30 seconds of `expiresAt`.

### Non-goals and residual risk

- A paired controller is intentionally equivalent to the device owner. There is
  no per-feature RBAC in the MVP (`control` is the implemented scope).
- The relay can deny service, correlate traffic or observe metadata even though
  it cannot read content. `serverId` leakage enables availability attacks.
- A compromised host, a malicious plugin in the same DSH process, or an attacker
  with the user's OS session can control the device regardless of this plugin.
- The portal binds loopback and requires a capability token, but cookies are
  host-scoped rather than port-scoped: another local HTTP server that the user
  visits can read the portal cookie server-side and reuse it. Treat local
  processes as partially trusted, close unused portal tabs, and do not run
  untrusted local web services while a remote-control tab is open. The remote UI
  itself executes in the portal's loopback origin and may reach other loopback
  services; DSH's `/api` fence blocks the DSH API, other services may not be
  defended.
- The portal is not a defense against a process that can read the user's browser
  memory or files.
- Screenshots, screen recording and clipboard tools are outside the mesh's
  control.

## Key and pairing-code handling

- **Device identity** lives in `$DSH_HOME/device-mesh/identity.json` with mode
  `0600`. Private keys never leave the device, never appear in a QR code and are
  never logged. Protect `$DSH_HOME` like an SSH key directory and exclude it from
  backups you do not control.
- **A pairing link is a bearer credential.** It contains the daemon's public
  keys, endpoints and a one-time token, and is valid for 10 minutes. Anyone who
  scans it can *request* control; the daemon still requires local approval and a
  matching SAS. Treat the QR code and link like a password: do not paste them
  into chat, tickets, screenshots or logs.
- **SAS comparison is mandatory in practice.** The 6-digit code
  (`123-456`) is derived from the Noise handshake hash and both public keys.
  If the controller and daemon show different codes, deny the request.
- **Relay `serverId` is a routing secret.** It is not an authentication
  credential, but knowing it lets an attacker attach to or disrupt the relay
  session. Generate it randomly, keep it out of logs and rotate it if a pairing
  ticket leaks.
- **The DSH Web cookie** obtained by the daemon for its own loopback DSH server
  is kept in memory only and is never forwarded to the controller.
- **The portal URL** contains a capability token. Anyone with the URL and access
  to the loopback port can control the remote device. Do not share it, and close
  the tab when finished.
- **Cross-site token entry.** Opening remote control from the DSH shell produces a
  cross-site popup; the portal serves a same-origin bootstrap for that one
  capability-token navigation, then fences every cookie-authenticated request to
  same-origin. The token remains the only cross-site capability.
- **Plaintext relay opt-in.** The relay field defaults to `wss://`. Turning
  **Use TLS** off accepts a public `ws://` endpoint only as an explicit user
  choice; the relay then sees control metadata and can tamper with frames. Use
  it only on trusted networks and never for a public deployment.
- **Connection churn:** the direct listener accepts at most 60 upgrade attempts
  per IP per minute (429 after that) and caps 16 live connections, half per IP.
  Keep the direct port on trusted networks or behind a firewall; use the relay
  when the device is exposed to the public internet.
- **Failed authentication is audited.** `audit.jsonl` records the reason code
  (`auth.failed`) and the controller id when known; tokens and keys never appear.
- **Lost or stolen devices:** revoke the device from every peer, rotate the
  device identity (remove/regenerate `identity.json` after understanding the
  re-pairing impact) and rotate the relay `serverId`. Revocation alone does not
  erase data already on the lost device.

## Deployment hardening checklist

### TLS

- [ ] Public relays are reached over `wss://` only. Never expose a plain `ws://`
      relay to the internet; `ws://` is acceptable only for a relay bound to
      loopback on the same host.
- [ ] The DSH Web UI is served over HTTPS (directly with DSH TLS flags or behind
      a TLS-terminating reverse proxy) whenever it is reachable beyond loopback.
- [ ] Certificates are valid and renewed automatically.

### Relay

- [ ] Use the published paseo-relay image and a pinned version/digest.
- [ ] Run the container read-only, non-root, with all capabilities dropped and
      `no-new-privileges`.
- [ ] Keep the relay port bound to loopback behind the TLS proxy; publish only
      `443` (and `80` for ACME).
- [ ] Rate-limit connections and set sane `PASEO_RELAY_MAX_*` limits for the host
      memory.
- [ ] Multi-node deployments hash consistently on the `serverId` query
      parameter.
- [ ] Expose `/health` and `/ready` to the probe; do not expose `/metrics`
      publicly.
- [ ] Scrub query strings (`serverId`) and payloads from access logs.
- [ ] Monitor unusual attach/replacement rates, bound concurrent inbound
      sessions, and rotate `serverId` after a suspected leak.

### Direct listener

- [ ] The plugin's direct listener defaults to TCP `45871`. On a public host,
      disable it (**Devices → This device → Direct listener**) and use relay-only
      mode, or firewall the port to the LAN/Tailscale interface.
- [ ] Never port-forward `45871` from the public internet.
- [ ] Bind the direct listener to a specific interface where possible rather
      than every interface.

### Portal

- [ ] Keep the portal on `127.0.0.1`. Never reverse-proxy, port-forward or bind
      it to `0.0.0.0`.
- [ ] Treat the printed portal URL as a secret; it contains the capability token.
      The portal requires the exact `Host` authority, permits only same-origin
      browser HTTP requests (or a top-level navigation), and requires the portal's
      `Origin` on WebSocket upgrades.
- [ ] Keep the capability token out of forwarded requests: the portal strips
      `?token=` from every proxied path, so it never reaches the daemon or its
      `Referer`/access logs.
- [ ] Close idle portals; the default idle timeout is 30 minutes.

### Revocation and audit

- [ ] Review **Paired devices** regularly and revoke devices you no longer use.
- [ ] After a lost device or a leaked pairing link, revoke first, then rotate
      the identity and relay `serverId`.
- [ ] Keep `$DSH_HOME/device-mesh/audit.jsonl` on a filesystem only the DSH user
      can read; forward it to a protected log sink if you need retention.
- [ ] Verify that revocation disconnects an active session, not only future
      handshakes. Grant expiry is enforced on the next RPC and by a 30-second
      sweep; revoke explicitly when immediate termination is required.

### Logging and data handling

- [ ] Never enable debug logging on a shared host without checking that tokens,
      keys, cookies and message bodies stay out of the output.
- [ ] Remove pairing links, `serverId`, device names and private paths from bug
      reports and screenshots.
- [ ] Do not commit `$DSH_HOME` state, device identities or pairing records to
      the repository.

### Updates

- [ ] Track the supported DSH line (`>=0.2.2-rc.1 <0.3.0`) and upgrade the
      plugin and DSH together.
- [ ] Treat a protocol-version mismatch as a fail-closed condition and re-pair
      rather than forcing compatibility.

## Scope

This policy covers the `dsh-device-mesh` plugin in this repository. It does not
cover:

- **DSH core** — report DSH issues to the DeepSeek Harness project.
- **paseo-relay** — report relay issues to the
  [paseo-relay project](https://github.com/kfxhjz/paseo-relay) and follow its
  security policy.
- Third-party dependencies — report to their upstream projects; we will update
  the pinned version when a fix is available.
