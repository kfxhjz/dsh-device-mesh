#!/usr/bin/env node
/**
 * Source coverage gate.
 *
 * Node >= 26 can include source files that were never loaded
 * (`--test-coverage-include-all`), which is what makes the gate cover the client
 * half instead of only the modules the suites happen to import. Node 24 does not
 * have that flag, so it falls back to loaded-file thresholds; CI runs the full
 * gate on Node 26.
 */
import { spawnSync } from 'node:child_process'

/** Node >= 26 flag; `DSH_MESH_COVERAGE_LEGACY=1` forces the loaded-file mode. */
const forcedLegacy = process.env.DSH_MESH_COVERAGE_LEGACY === '1'
const supportsIncludeAll = !forcedLegacy
  && process.allowedNodeEnvironmentFlags.has('--test-coverage-include-all')

const args = [
  '--import', 'tsx',
  '--experimental-test-coverage',
  '--test-coverage-include=src/**/*.ts',
  '--test-coverage-exclude=src/**/*.d.ts',
]

if (supportsIncludeAll) {
  args.push(
    '--test-coverage-include-all',
    '--test-coverage-lines=82',
    '--test-coverage-branches=73',
    '--test-coverage-functions=78',
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
process.exit(result.status ?? 1)
