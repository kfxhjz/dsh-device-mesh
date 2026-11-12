<!--
Thanks for contributing! Keep one logical change per pull request and read
CONTRIBUTING.md before opening it. Do not open a public pull request for an
unfixed security vulnerability; use GitHub Security Advisories instead.
-->

## Summary

<!-- What changed, why, and anything a reviewer should know up front. -->

## Related issue

<!-- Link the issue this closes, e.g. `Fixes #123`. Write `None` if there is none. -->

## Type of change

- [ ] Bug fix
- [ ] New feature or behaviour change
- [ ] Refactor (no behaviour change)
- [ ] Documentation
- [ ] Build, packaging or CI
- [ ] Tests only
- [ ] Security fix

## How it was verified

<!-- Paste the exact commands you ran and their result. State which platforms and DSH versions were exercised. -->

- [ ] `npm run build`
- [ ] `npm run typecheck`
- [ ] `npm run lint`
- [ ] `npm test`
- [ ] `npm run test:e2e` — say whether the browser and relay cases ran or skipped

Platforms and DSH versions tested:

## Checklist

- [ ] I did not commit build outputs or local state: `lib/`, `client.js`, `node_modules/`, `.test/`, `.build/`, `.npm-cache/`, `.pnpm-store/`, `*.tgz`.
- [ ] The diff contains no pairing link, QR code, `identity.json`, private key, DSH session cookie, portal capability URL or relay `serverId`.
- [ ] Logs and screenshots were redacted (tokens, keys, cookies, `serverId`, device names, LAN addresses and personal paths removed).
- [ ] Behaviour and documentation are in sync; user-visible changes update `CHANGELOG.md` under `[Unreleased]` and any affected `README`/`docs/` page.
- [ ] UI changes include a screenshot or short recording.
- [ ] `git diff --check` passes (no trailing whitespace, no conflict markers).
