# Documentation

[简体中文](README.zh.md) | English

This index points at the specification, design, development and decision
documents for `dsh-device-mesh`. Start with the top-level [README](../README.md)
if you want to install and use the plugin; the documents here are for people
reviewing, extending or operating it.

## Specifications

| Document | Language | Contents |
|---|---|---|
| [PROTOCOL.md](PROTOCOL.md) | English | Wire protocol v1: identities, pairing tickets, transport framing, Noise handshake, RPC methods, portal proxy, paseo-relay reuse and the security checklist. |
| [PROTOCOL.zh.md](zh/PROTOCOL.zh.md) | Chinese | Chinese translation of the protocol specification. |
| [DESIGN.md](DESIGN.md) | English | Architecture: goals and constraints, component layout, transports, pairing, portal, state, threat model, local/remote UI approach, platform matrix, testing strategy and roadmap. |
| [DESIGN.zh.md](zh/DESIGN.zh.md) | Chinese | Chinese translation of the design document. |

The protocol is the normative document. When the implementation and the
specification disagree, treat that as a bug: update the code and the protocol in
the same change, or record the deviation explicitly. Incompatible wire changes
must bump the protocol version.

## Development and decisions

| Document | Contents |
|---|---|
| [development.md](development.md) · [中文](zh/development.zh.md) | Maintainer guide: version baseline, repository layout, DSH packaging and client-bundle contracts, local loop, host/UI integration points, testing, debugging and release policy. |
| [adr/0001-remote-control-in-dsh.md](adr/0001-remote-control-in-dsh.md) · [中文](zh/adr/0001-remote-control-in-dsh.zh.md) | Why the MVP uses a host-side device mesh plus a loopback portal instead of a second DSH client tree, and what changes in Phase 2. |

Architectural decisions are recorded as ADRs under [`adr/`](adr/); add a new ADR
rather than rewriting an accepted one.

## Project documents

| Document | Contents |
|---|---|
| [README.md](../README.md) · [README.zh.md](../README.zh.md) | User-facing overview, installation, pairing and relay setup. |
| [CONTRIBUTING.md](../CONTRIBUTING.md) · [中文](../CONTRIBUTING.zh.md) | Development environment, commands, bundle contract, pull-request rules and test requirements. |
| [SECURITY.md](../SECURITY.md) · [中文](../SECURITY.zh.md) | Supported versions, private vulnerability reporting, threat model and deployment hardening. |
| [MAINTAINERS.md](../MAINTAINERS.md) | Current maintainers, review/release duties, security triage route and bus-factor notes. |
| [CODE_OF_CONDUCT.md](../CODE_OF_CONDUCT.md) · [中文](../CODE_OF_CONDUCT.zh.md) | Community behaviour expectations and enforcement. |
| [CHANGELOG.md](../CHANGELOG.md) · [中文](../CHANGELOG.zh.md) | Release history in Keep a Changelog format. |
| [RELEASE.md](../RELEASE.md) · [中文](../RELEASE.zh.md) | Release gate: automated checks, manual verification matrix and known limitations. |
| [LICENSE](../LICENSE) | MIT license. |

## Suggested reading order

1. [README](../README.md) — what the plugin does and how to try it.
2. [DESIGN.md](DESIGN.md) — why it is built this way, and where the boundaries are.
3. [PROTOCOL.md](PROTOCOL.md) — the exact wire behavior, for implementers and
   security reviewers.
4. [SECURITY.md](../SECURITY.md) — what is guaranteed, what is not, and how to
   deploy it safely.
5. [development.md](development.md) — how to build, extend and release the
   plugin; then [ADR 0001](adr/0001-remote-control-in-dsh.md) for the
   architecture decision behind the portal-first design.
