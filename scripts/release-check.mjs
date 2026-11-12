#!/usr/bin/env node
/**
 * Local release gate. Runs the automated checks from RELEASE.md in order and
 * stops at the first failure. E2E needs a `dsh` CLI (see DSH_CLI); the relay and
 * browser cases skip themselves when their binaries are absent.
 */
import { spawnSync } from 'node:child_process'

const steps = [
  ['build', ['run', 'build'], 'produces lib/host/index.js and client.js'],
  ['typecheck', ['run', 'typecheck'], 'Host and test TypeScript'],
  ['lint', ['run', 'lint'], 'oxlint over src, test and scripts'],
  ['unit tests', ['test'], 'unit, host and client suites'],
  ['coverage', ['run', 'test:coverage'], 'source line/branch/function coverage thresholds'],
  ['end-to-end', ['run', 'test:e2e'], 'DSH CLI required; relay/browser cases may skip'],
  ['package', ['pack', '--dry-run'], 'must list 11 files; no tests or secrets'],
]

let failed = false
for (const [label, args, expectation] of steps) {
  process.stdout.write(`\n=== ${label} (${expectation})\n`)
  const result = spawnSync('npm', args, {
    stdio: 'inherit',
    env: {
      ...process.env,
      // Inside `npm run`, npm exports its own npm_config_cache (usually the
      // global one). Use a workspace-local cache by default so a sandboxed or
      // read-only global cache cannot fail the gate; override with
      // DSH_MESH_NPM_CACHE when a shared cache is wanted.
      npm_config_cache: process.env.DSH_MESH_NPM_CACHE ?? '.npm-cache',
    },
  })
  if (result.status !== 0) {
    process.stderr.write(`\nrelease gate failed at: ${label}\n`)
    failed = true
    break
  }
}
if (failed) process.exit(1)
process.stdout.write('\nRelease gate passed. Continue with RELEASE.md "Manual verification matrix" and "Security sign-off".\n')
