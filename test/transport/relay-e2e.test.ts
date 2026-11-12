/**
 * End-to-end tests against a real paseo-relay binary.
 *
 * The binary is discovered from `PASEO_RELAY_BIN` first, then from the usual
 * build locations. When no binary exists the test is skipped and prints how to
 * build one; it never fails just because Rust tooling is unavailable.
 */

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import net from 'node:net'
import { test } from 'node:test'

import { connectRelayClient, startRelayDaemon, startRelayDaemonV1 } from '../../src/host/transport/relay.ts'
import type { MeshTransport } from '../../src/shared/transport.ts'
import { bytes, captureLogs, nextClose, nextMessage, sleep, waitForCondition } from './helpers.ts'

const REPO_ROOT = new URL('../..', import.meta.url).pathname

const CANDIDATE_BINARIES = [
  process.env.PASEO_RELAY_BIN,
  `${REPO_ROOT}.build/bin/paseo-relay`,
  `${REPO_ROOT}.build/paseo-relay-target/release/paseo-relay`,
]

const BUILD_HINT =
  'paseo-relay binary not found. Build it from a paseo-relay checkout with:\n' +
  '  CARGO_TARGET_DIR="$PWD/.build/paseo-relay-target" cargo build --release \\\n' +
  '    --manifest-path <paseo-relay checkout>/Cargo.toml\n' +
  'or point PASEO_RELAY_BIN at an existing binary.'

function findRelayBinary(): string | undefined {
  for (const candidate of CANDIDATE_BINARIES) {
    if (candidate && existsSync(candidate)) return candidate
  }
  return undefined
}

async function freePort(): Promise<number> {
  const server = net.createServer()
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () =>{  resolve() }))
  const address = server.address()
  const port = address !== null && typeof address !== 'string' ? address.port : 0
  await new Promise<void>(resolve => server.close(() =>{  resolve() }))
  if (port === 0) throw new Error('could not allocate a loopback port')
  return port
}

interface RunningRelay {
  readonly url: string
  readonly port: number
  readonly binary: string
  readonly version: string
  readonly relayLogs: string[]
  stop(): Promise<void>
}

async function startRelay(binary: string): Promise<RunningRelay> {
  const port = await freePort()
  const relayLogs: string[] = []
  const child: ChildProcess = spawn(binary, [], {
    env: {
      ...process.env,
      PASEO_RELAY_HOST: '127.0.0.1',
      PASEO_RELAY_PORT: String(port),
      PASEO_RELAY_LOG: 'warn',
      PASEO_RELAY_LOG_FORMAT: 'text',
      // Keep the no-data-route test fast (relay default is 15 s) and its
      // graceful drain short so the suite stays quick.
      PASEO_RELAY_DATA_ATTACH_TIMEOUT_MS: '500',
      PASEO_RELAY_SHUTDOWN_GRACE_MS: '500',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout?.on('data', (chunk: Buffer) => relayLogs.push(chunk.toString()))
  child.stderr?.on('data', (chunk: Buffer) => relayLogs.push(chunk.toString()))

  const version = await new Promise<string>((resolve) => {
    const probe = spawn(binary, ['--version'], { stdio: ['ignore', 'pipe', 'ignore'] })
    let out = ''
    probe.stdout?.on('data', (chunk: Buffer) => {
      out += chunk.toString()
    })
    probe.once('close', () =>{  resolve(out.trim()) })
  })

  const deadline = Date.now() + 20_000
  let ready = false
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`paseo-relay exited early (code ${child.exitCode}): ${relayLogs.join('')}`)
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/ready`)
      if (response.ok) {
        ready = true
        break
      }
    } catch {
      // Not listening yet.
    }
    await sleep(25)
  }
  if (!ready) {
    child.kill('SIGKILL')
    throw new Error(`paseo-relay did not become ready: ${relayLogs.join('')}`)
  }

  let stopped = false
  return {
    url: `ws://127.0.0.1:${port}/ws`,
    port,
    binary,
    version,
    relayLogs,
    async stop(): Promise<void> {
      if (stopped) return
      stopped = true
      if (child.exitCode !== null || child.signalCode !== null) return
      const exited = new Promise<void>(resolve => child.once('exit', () =>{  resolve() }))
      child.kill('SIGTERM')
      const graceful = await Promise.race([exited.then(() => true), sleep(5_000).then(() => false)])
      if (!graceful) {
        child.kill('SIGKILL')
        await Promise.race([exited, sleep(1_000)])
      }
    },
  }
}

function newServerId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}_e2e`
}

test(
  'e2e relay v2: daemon control+data through the real relay binary',
  { timeout: 120_000 },
  async (context) => {
    const binary = findRelayBinary()
    if (!binary) {
      console.warn(`[relay-e2e] skipped: ${BUILD_HINT}`)
      context.skip(BUILD_HINT)
      return
    }

    const relay = await startRelay(binary)
    const logs = captureLogs()
    const serverId = newServerId('srv_e2e_v2')
    const clients: Array<{ transport: MeshTransport; connectionId: string }> = []
    const daemon = startRelayDaemon(
      {
        url: relay.url,
        serverId,
        version: 2,
        heartbeatMs: 500,
        minBackoffMs: 100,
        maxBackoffMs: 500,
        logger: logs.logger,
      },
      (transport, connectionId) => clients.push({ transport, connectionId }),
    )
    let client: MeshTransport | undefined
    try {
      await daemon.ready
      assert.equal(daemon.connected, true)

      client = await connectRelayClient({
        url: relay.url,
        serverId,
        version: 2,
        heartbeatMs: 500,
      })
      await waitForCondition(() => clients.length === 1, 5_000, 'daemon data socket')
      const entry = clients[0]
      assert.ok(entry)
      assert.match(entry.connectionId, /^conn_[0-9a-f]{16}$/)

      const up = bytes(64 * 1024, 41)
      const daemonGot = nextMessage(entry.transport)
      client.send(up)
      assert.deepEqual(Array.from(await daemonGot), Array.from(up))

      const down = bytes(64 * 1024, 43)
      const clientGot = nextMessage(client)
      entry.transport.send(down)
      assert.deepEqual(Array.from(await clientGot), Array.from(down))

      // WS heartbeat survives several intervals on real relay sockets.
      await sleep(1_200)
      assert.equal(daemon.connected, true)

      // Controller close -> relay closes the daemon data socket with 1001.
      const closed = nextClose(entry.transport)
      client.close(4000, 'e2e done')
      const info = await closed
      assert.equal(info.code, 1001)
      assert.equal(info.reason, 'Client disconnected')
      client = undefined

      // No daemon for this serverId: the relay shed the client with 1013.
      const orphan = await connectRelayClient({
        url: relay.url,
        serverId: newServerId('srv_e2e_orphan'),
        version: 2,
        heartbeatMs: 0,
      })
      try {
        const orphanClosed = nextClose(orphan)
        orphan.send(bytes(16, 1))
        const orphanInfo = await orphanClosed
        assert.equal(orphanInfo.code, 1013)
        assert.equal(orphanInfo.reason, 'Data route unavailable')
      } finally {
        orphan.close(1000, 'test done')
      }

      console.log(
        `[relay-e2e] v2 OK relay=${relay.binary} version="${relay.version}" ` +
          `connectionId=${entry.connectionId}`,
      )
    } finally {
      client?.close(1000, 'test done')
      await daemon.close()
      await relay.stop()
      assert.equal(logs.messages.some(message => message.includes(serverId)), false)
    }
  },
)

test(
  'e2e relay v1 fallback: single socket through the real relay binary',
  { timeout: 120_000 },
  async (context) => {
    const binary = findRelayBinary()
    if (!binary) {
      console.warn(`[relay-e2e] skipped: ${BUILD_HINT}`)
      context.skip(BUILD_HINT)
      return
    }

    const relay = await startRelay(binary)
    const logs = captureLogs()
    const serverId = newServerId('srv_e2e_v1')
    const clients: Array<{ transport: MeshTransport; connectionId: string }> = []
    const daemon = startRelayDaemonV1(
      {
        url: relay.url,
        serverId,
        heartbeatMs: 500,
        minBackoffMs: 100,
        maxBackoffMs: 500,
        logger: logs.logger,
      },
      (transport, connectionId) => clients.push({ transport, connectionId }),
    )
    const controller = await connectRelayClient({
      url: relay.url,
      serverId,
      version: 1,
      heartbeatMs: 500,
    })
    try {
      await daemon.ready
      await waitForCondition(() => clients.length === 1, 5_000, 'v1 daemon socket')
      const entry = clients[0]
      assert.ok(entry)
      assert.equal(entry.connectionId, 'v1')

      const up = bytes(64 * 1024, 47)
      const daemonGot = nextMessage(entry.transport)
      controller.send(up)
      assert.deepEqual(Array.from(await daemonGot), Array.from(up))

      const down = bytes(32 * 1024, 49)
      const controllerGot = nextMessage(controller)
      entry.transport.send(down)
      assert.deepEqual(Array.from(await controllerGot), Array.from(down))

      console.log(
        `[relay-e2e] v1 OK relay=${relay.binary} version="${relay.version}"`,
      )
    } finally {
      controller.close(1000, 'test done')
      await daemon.close()
      await relay.stop()
      assert.equal(logs.messages.some(message => message.includes(serverId)), false)
    }
  },
)
