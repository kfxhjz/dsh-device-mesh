#!/usr/bin/env node
/**
 * Source coverage gate.
 *
 * Node >= 26 can include source files that were never loaded
 * (`--test-coverage-include-all`), which is what makes the gate cover the client
 * half instead of only the modules the suites happen to import. Node 24 does not
 * have that flag, so it falls back to loaded-file thresholds; CI runs both
 * (Node 26 full gate, Node 24 fallback).
 *
 * The measured set is the `.ts` sources under `src/`. `src/client/index.tsx`
 * is deliberately out
 * of scope: it wires the client plugin (panel, sidebar entries, styles) and its
 * contract is covered by the bundle test in `test/client/static.test.ts`; the
 * include glob above is `.ts`-only. Keep it and this comment in sync.
 */
import { spawnSync } from 'node:child_process'

/** Node major version; the include-all flag has been available since Node 26. */
const nodeMajor = Number.parseInt(process.versions.node.split('.')[0] ?? '0', 10)

/** `DSH_MESH_COVERAGE_LEGACY=1` forces the loaded-file mode (used to test the fallback). */
const forcedLegacy = process.env.DSH_MESH_COVERAGE_LEGACY === '1'
const supportsIncludeAll = !forcedLegacy && nodeMajor >= 26

const args = [
  '--import', 'tsx',
  '--experimental-test-coverage',
  '--test-coverage-include=src/**/*.ts',
  '--test-coverage-exclude=src/**/*.d.ts',
]

if (supportsIncludeAll) {
  args.push(
    '--test-coverage-include-all',
    '--test-coverage-lines=80',
    '--test-coverage-branches=72',
    '--test-coverage-functions=77',
  )
} else {
  process.stderr.write(
    `[coverage] include-all disabled (${forcedLegacy ? 'DSH_MESH_COVERAGE_LEGACY=1' : `Node ${process.versions.node}`}); `
    + 'enforcing loaded-file thresholds. Run Node >= 26 for the full source gate.\n',
  )
  args.push(
    '--test-coverage-lines=89',
    '--test-coverage-branches=72',
    '--test-coverage-functions=77',
  )
}

args.push(
  '--test',
  'test/core/*.test.ts',
  'test/transport/*.test.ts',
  'test/host/*.test.ts',
  'test/client/*.test.ts',
)

const result = spawnSync(process.execPath, args, { stdio: 'inherit' })
if (result.error !== undefined) {
  console.error(`[coverage] failed to start the test runner: ${result.error.message}`)
  process.exit(1)
}
if (result.signal !== null && result.signal !== undefined) {
  console.error(`[coverage] test runner terminated by ${result.signal}`)
  process.exit(1)
}
process.exit(result.status ?? 1)
