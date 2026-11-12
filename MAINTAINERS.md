# Maintainers

This file names the people responsible for reviewing, releasing and securing
`dsh-device-mesh`, and explains how to reach them.

## Current maintainers

| Maintainer | GitHub | Responsibilities |
|---|---|---|
| `@kfxhjz` | [github.com/kfxhjz](https://github.com/kfxhjz) | Review, release, security triage |

The repository currently has a single maintainer. [.github/CODEOWNERS](.github/CODEOWNERS)
assigns `*` to `@kfxhjz`, so every pull request requests a review from that
account.

## What maintainers do

- **Review** — triage issues and pull requests, keep behaviour, `docs/`,
  `README` and `CHANGELOG.md` in sync, and require the CI gate
  (`npm run build`, `npm run typecheck`, `npm run lint`, `npm test`,
  `npm run test:e2e`) before merging.
- **Release** — follow [RELEASE.md](RELEASE.md): bump the version, add a dated
  `CHANGELOG.md` section, run `npm run release:check`, tag `v0.1.x` from `main`,
  publish the tarball and release notes.
- **Security triage** — monitor GitHub Security Advisories, acknowledge reports
  within 5 business days, coordinate fixes and disclosure under
  [SECURITY.md](SECURITY.md), and make sure no pairing link, key, cookie or
  `serverId` reaches a public issue.

## Reporting a security vulnerability

**Do not open a public issue, discussion or pull request for a vulnerability.**

Use GitHub Security Advisories:

<https://github.com/kfxhjz/dsh-device-mesh/security/advisories/new>

The advisory stays private until a fix and an advisory are ready. If GitHub
Security Advisories are unavailable, contact a maintainer privately through the
contact options on their GitHub profile. Never send a live pairing link, a QR
code screenshot, `identity.json` contents, a private key, a DSH session cookie or
a relay `serverId`; redact them from logs first.

We aim to acknowledge a report within **5 business days** and to agree on a
disclosure timeline after triage, as described in [SECURITY.md](SECURITY.md).

## Bus factor

The bus factor is currently **1**. The project mitigates that with:

- Written, reproducible processes: [RELEASE.md](RELEASE.md) is the release gate,
  [SECURITY.md](SECURITY.md) covers reporting and hardening, and
  [CONTRIBUTING.md](CONTRIBUTING.md) documents the build, packaging and review
  contract.
- CI that runs build, typecheck, lint, unit and end-to-end suites on every pull
  request, plus `npm run release:check` before a release.
- Architecture, protocol and development notes in `docs/`, including the ADRs
  under `docs/adr/`.
- An MIT-licensed, self-contained repository: a release artifact can be rebuilt
  from a clean checkout with `npm ci && npm run build && npm pack`, so no
  maintainer-only infrastructure is needed to ship a fix.
- No shared secrets are required to maintain the project: release and security
  work happen through GitHub permissions tied to the maintainer account, and
  device identities and pairing state are never part of the repository.

## Becoming a maintainer

New maintainers are welcome, and adding one is the direct fix for the bus factor.

We look for a sustained contribution record rather than a single patch:

- several merged pull requests that follow [CONTRIBUTING.md](CONTRIBUTING.md),
  including tests and documentation;
- helpful issue triage, reproduction and review;
- sound judgement on security-sensitive changes (pairing, crypto, transports,
  portal proxy) and on keeping secrets out of public artifacts.

If that describes you, open an issue or ask in
[Discussions](https://github.com/kfxhjz/dsh-device-mesh/discussions) and a
maintainer will follow up. A new maintainer is added to this file and to
[.github/CODEOWNERS](.github/CODEOWNERS) in the same pull request, and gets
triage/review/release access on GitHub.

## Changes to this file

Maintainer changes are ordinary reviewed pull requests. A maintainer may step
down at any time by removing themselves here and from
[.github/CODEOWNERS](.github/CODEOWNERS).
