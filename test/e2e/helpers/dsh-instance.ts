/**
 * E2E harness: build the plugin, install it into two throw-away DSH homes, boot
 * two `dsh web` instances and drive them over the same-origin local API.
 *
 * Everything lives under the session workspace (`.test/e2e/<run>`), so the real
 * `$DSH_HOME` is never touched. The installed desktop app's bundled CLI is used
 * so the test exercises exactly the runtime users run.
 */
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { accessSync, constants, existsSync, readdirSync, statSync } from 'node:fs'
import { delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'

const execFileAsync = promisify(execFile)
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const testRoot = join(repoRoot, '.test/e2e')

/** Find an executable on PATH (returns its absolute path). */
function findOnPath(name: string): string | undefined {
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    if (directory === '') continue
    const candidate = join(directory, name)
    try {
      accessSync(candidate, constants.X_OK)
      return candidate
    } catch {
      // Keep looking.
    }
  }
  return undefined
}

/**
 * Path of the `dsh` CLI used to boot test instances.
 *
 * Resolution order: `DSH_CLI` (any executable, e.g. a globally installed
 * `@deepseek-ai/dsh`), the macOS desktop app's bundled CLI, then `dsh` on PATH.
 * CI installs `@deepseek-ai/dsh` and sets `DSH_CLI=dsh`.
 */
export function dshCliPath(): string {
  if (process.env.DSH_CLI) return process.env.DSH_CLI
  if (process.platform === 'darwin') {
    const bundled = '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh'
    if (existsSync(bundled)) return bundled
  }
  const onPath = findOnPath(process.platform === 'win32' ? 'dsh.cmd' : 'dsh')
  if (onPath !== undefined) return onPath
  throw new Error(
    'dsh CLI not found: install @deepseek-ai/dsh or set DSH_CLI to the dsh executable',
  )
}

export interface DshInstance {
  readonly home: string
  readonly url: string
  readonly base: string
  readonly cookie: string
  api<T = unknown>(endpoint: string, payload?: unknown): Promise<T>
  fetchRaw(path: string, init?: RequestInit): Promise<Response>
  stop(): Promise<void>
  readonly logs: () => string
}

/**
 * Newest modification time under a directory, recursively.
 * @param directory - directory to scan.
 * @returns the newest `mtimeMs`, or 0 when the tree is empty.
 */
function newestMtimeMs(directory: string): number {
  let newest = 0
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) newest = Math.max(newest, newestMtimeMs(path))
    else if (entry.isFile()) newest = Math.max(newest, statSync(path).mtimeMs)
  }
  return newest
}

/**
 * Make sure `lib/host/index.js` and `client.js` exist and are newer than every
 * source input. A stale artifact would make E2E report a false pass, so compare
 * the oldest output against the newest input (`src/**`, `scripts/build.mjs`,
 * `package.json`) and rebuild when the sources are newer. `DSH_MESH_FORCE_BUILD`
 * overrides the check.
 */
export async function ensureBuilt(): Promise<void> {
  const hostBundle = join(repoRoot, 'lib/host/index.js')
  const clientBundle = join(repoRoot, 'client.js')
  if (!process.env.DSH_MESH_FORCE_BUILD && existsSync(hostBundle) && existsSync(clientBundle)) {
    const newestSource = Math.max(
      newestMtimeMs(join(repoRoot, 'src')),
      statSync(join(repoRoot, 'scripts/build.mjs')).mtimeMs,
      statSync(join(repoRoot, 'package.json')).mtimeMs,
    )
    const oldestArtifact = Math.min(statSync(hostBundle).mtimeMs, statSync(clientBundle).mtimeMs)
    if (oldestArtifact >= newestSource) return
  }
  await execFileAsync(process.execPath, [join(repoRoot, 'scripts/build.mjs')], { cwd: repoRoot })
}

/** A set of disposable homes created together, with its own cleanup scope. */
export interface HomeSet {
  readonly homes: readonly string[]
  /** Remove this run's homes (and template). Other concurrent runs are untouched. */
  cleanup(): Promise<void>
}

/**
 * Create disposable DSH homes with the plugin installed into the `web`
 * profile. The template home is prepared once, then copied so each instance
 * starts from the same composition without repeating the pnpm install.
 */
export async function createHomes(count = 2): Promise<HomeSet> {
  await mkdir(testRoot, { recursive: true })
  const run = join(testRoot, randomUUID())
  await mkdir(run, { recursive: true })

  const template = join(run, 'home-template')
  await mkdir(template, { recursive: true })
  const env = { ...process.env, DSH_HOME: template }

  // `dsh plugin add` on a cold profile only knows `@deepseek-ai/dsh-base`; the
  // Web half of the product (webServer/connection services the plugin injects)
  // lives in the shipped `web` profile template. Preparing that template first
  // makes this test use the same composition as a real `dsh web` install.
  await execFileAsync(dshCliPath(), ['web', '--help'], { env, cwd: repoRoot,
    maxBuffer: 16 * 1024 * 1024 })
  await execFileAsync(dshCliPath(), ['plugin', '--profile', 'web', 'add', repoRoot], {
    env,
    cwd: repoRoot,
    maxBuffer: 16 * 1024 * 1024,
  })

  // The plugin declares a bare-package Loader row, so installing it as a bundle
  // must have appended it to the profile's bundle list.
  const profilePkg = JSON.parse(
    await readFile(join(template, 'profiles/web/package.json'), 'utf8'),
  ) as { dsh?: { profile?: { bundles?: string[] } } }
  const bundles = profilePkg.dsh?.profile?.bundles ?? []
  if (!bundles.includes('dsh-device-mesh')) {
    throw new Error(`plugin was not added to profile bundles: ${JSON.stringify(bundles)}`)
  }

  const homes: string[] = []
  for (let index = 0; index < count; index += 1) {
    const home = join(run, `home-${index}`)
    await cp(template, home, { recursive: true })
    homes.push(home)
  }
  return {
    homes,
    async cleanup() {
      await rm(run, { recursive: true, force: true }).catch(() => undefined)
    },
  }
}

/** Boot one `dsh web` instance on an OS-assigned port. */
export async function startInstance(home: string, label: string): Promise<DshInstance> {
  const child = spawn(dshCliPath(), ['web', '--no-open', '--port', '0'], {
    env: { ...process.env, DSH_HOME: home },
    cwd: repoRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  let errorOutput = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => { output += chunk })
  child.stderr.on('data', (chunk: string) => { errorOutput += chunk })

  const logs = (): string => `--- ${label} stdout ---\n${output}\n--- ${label} stderr ---\n${errorOutput}`

  const launchUrl = await waitFor(() => {
    const match = /dsh web: (http:\/\/\S+)/u.exec(output)
    return match?.[1]
  }, 30_000, () => `dsh web did not announce a URL\n${logs()}`, 100)

  // Exchange the process launch token for the browser session cookie.
  const first = await fetch(launchUrl, { redirect: 'manual' })
  const setCookie = first.headers.getSetCookie?.() ?? []
  const cookie = setCookie.map(value => value.split(';', 1)[0]).filter(Boolean).join('; ')
  if (cookie === '') {
    throw new Error(`no session cookie from launch URL: status=${String(first.status)}\n${logs()}`)
  }
  const base = new URL(launchUrl).origin

  const instance: DshInstance = {
    home,
    url: launchUrl,
    base,
    cookie,
    logs,
    async fetchRaw(path, init = {}) {
      const headers = new Headers(init.headers)
      headers.set('cookie', cookie)
      return await fetch(new URL(path, base), { ...init, headers, redirect: init.redirect ?? 'manual' })
    },
    async api<T>(endpoint: string, payload?: unknown): Promise<T> {
      const response = await instance.fetchRaw('/api/device-mesh', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ endpoint, payload }),
      })
      const text = await response.text()
      if (response.status !== 200) {
        throw new Error(`local API ${endpoint}: HTTP ${String(response.status)} ${text.slice(0, 400)}`)
      }
      const parsed = JSON.parse(text) as { ok?: boolean; value?: T; error?: { code?: string; message?: string } }
      if (parsed.ok !== true) {
        throw new Error(`local API ${endpoint} failed: ${parsed.error?.code ?? '?'} ${parsed.error?.message ?? ''}`)
      }
      return parsed.value as T
    },
    async stop() {
      if (child.exitCode !== null) return
      child.kill('SIGTERM')
      await new Promise<void>((resolveStop) => {
        const timer = setTimeout(() => { child.kill('SIGKILL'); resolveStop() }, 8_000)
        child.once('exit', () => { clearTimeout(timer); resolveStop() })
      })
    },
  }
  return instance
}

/** Poll `producer` until it returns a truthy value or the timeout elapses. */
export async function waitFor<T>(
  producer: () => T | undefined | Promise<T | undefined>,
  timeoutMs: number,
  fail: () => string,
  intervalMs = 100,
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await producer()
    if (value !== undefined && value !== null && value !== false) return value
    if (Date.now() > deadline) throw new Error(fail())
    await new Promise(resolveDelay => setTimeout(resolveDelay, intervalMs))
  }
}

/** Remove the whole `.test/e2e` tree, ignoring failures (Windows file locks). */
export async function cleanupTestRoot(): Promise<void> {
  await rm(testRoot, { recursive: true, force: true }).catch(() => undefined)
}

/** Small convenience for tests that need raw JSON. */
export async function jsonOf<T>(response: Response): Promise<T> {
  return await response.json() as T
}

/** Write a marker file used by CI to keep evidence of a run. */
export async function recordEvidence(name: string, value: unknown): Promise<void> {
  const dir = join(testRoot, 'evidence')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, `${name}.json`), JSON.stringify(value, null, 2))
}
