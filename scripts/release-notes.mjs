#!/usr/bin/env node
/**
 * Build `release-body.md` for a tagged GitHub release.
 *
 * The body is generated from the version's `CHANGELOG.md` section so the release
 * page and the changelog cannot drift. It also embeds the tarball SHA-256 and the
 * install command, which `RELEASE.md` requires in every release note.
 *
 * Usage: node scripts/release-notes.mjs [--tarball <path>]
 * Reads:  package.json, CHANGELOG.md
 * Writes: release-body.md
 */
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { basename } from 'node:path'

const pkg = JSON.parse(await readFile('package.json', 'utf8'))
const version = pkg.version
const tag = process.env.GITHUB_REF_NAME
const checkTagOnly = process.argv.includes('--check-tag')
if (checkTagOnly && (typeof tag !== 'string' || tag.length === 0)) {
  console.error('GITHUB_REF_NAME is not set; cannot verify the release tag')
  process.exit(1)
}
if (typeof tag === 'string' && tag.length > 0 && tag !== `v${version}`) {
  console.error(`release tag ${tag} does not match package.json version v${version}`)
  process.exit(1)
}
const changelog = await readFile('CHANGELOG.md', 'utf8')
const lines = changelog.split('\n')
const start = lines.findIndex(line => line.startsWith(`## ${version} `) || line === `## ${version}`)
if (checkTagOnly) {
  if (start === -1) {
    console.error(`CHANGELOG.md has no "## ${version} - <date>" section`)
    process.exit(1)
  }
  process.stdout.write(`release tag v${version} matches package.json and CHANGELOG.md has its section\n`)
  process.exit(0)
}
if (start === -1) {
  console.error(`CHANGELOG.md has no "## ${version} - <date>" section`)
  process.exit(1)
}
let end = lines.length
for (let index = start + 1; index < lines.length; index += 1) {
  if (lines[index]?.startsWith('## ')) {
    end = index
    break
  }
}
const section = lines.slice(start + 1, end).join('\n').trim()

let tarball = `dsh-device-mesh-${version}.tgz`
let checksum = ''
const tarballFlag = process.argv.indexOf('--tarball')
if (tarballFlag !== -1) {
  const value = process.argv[tarballFlag + 1]
  if (value === undefined) {
    console.error('--tarball needs a path')
    process.exit(1)
  }
  tarball = basename(value)
  const bytes = await readFile(value)
  checksum = createHash('sha256').update(bytes).digest('hex')
}

const body = `## dsh-device-mesh ${version}

Install the attached tarball into a DSH profile; no build step is needed:

\`\`\`sh
dsh plugin --profile <profile> add ./${tarball}
\`\`\`

Rebuild and restart DSH after installing. Device identity and pairings under
\`$DSH_HOME/device-mesh/\` are preserved across upgrades. Requirements, pairing
and relay setup: https://github.com/kfxhjz/dsh-device-mesh/blob/main/README.md

${checksum === '' ? '' : `**SHA-256:** \`${checksum}\`\n\n`}### Tested platform matrix

- Linux desktop and Linux server: direct (LAN/Tailscale) and paseo-relay
- macOS desktop: direct and paseo-relay
- Windows: not in the tested matrix
- Android / iOS / HarmonyOS: no build yet; the controller half is a Web client

### Changes

${section}

### Known limitations

See [RELEASE.md](https://github.com/kfxhjz/dsh-device-mesh/blob/main/RELEASE.md#5-known-limitations-to-repeat-in-every-release-note).
This project has not undergone an independent third-party security audit; review
the threat model and hardening checklist in
[SECURITY.md](https://github.com/kfxhjz/dsh-device-mesh/blob/main/SECURITY.md)
before exposing a device to an untrusted network.
`

await writeFile('release-body.md', body)
process.stdout.write(`wrote release-body.md for v${version}${checksum === '' ? '' : ` (sha256 ${checksum})`}\n`)
