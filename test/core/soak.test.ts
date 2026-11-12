/**
 * Optional soak test for host-availability stability.
 *
 * Skipped by default so `npm test` stays fast and deterministic. Enable with:
 *
 * ```sh
 * DSH_MESH_SOAK=1 node --import tsx --test test/core/soak.test.ts
 * # optional: DSH_MESH_SOAK_ROUNDS=100 (capped at 200)
 * ```
 *
 * The job of this file is not cryptographic coverage (the unit suites own
 * that) but repeated lifecycle churn: full Noise handshake + RPC + heartbeat +
 * close cycles, both session endpoints closed at arbitrary points, and bulk
 * open/close of session objects. Any thrown error, unresolved close or
 * unhandled rejection fails the soak.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { DeviceDescriptor, DeviceIdentity, PeerRecord, RpcEvent } from '../../src/shared/protocol.ts'
import type { DaemonSessionHandlers, MeshSession } from '../../src/shared/mesh-session.ts'
import { acceptMeshChannel, connectMeshChannel } from '../../src/host/channel.ts'
import { createSession } from '../../src/host/session.ts'
import type { DaemonMeshSession, MeshSessionImpl, SessionBridge } from '../../src/host/session.ts'
import { deviceDescriptorOf, generateDeviceIdentity } from '../../src/host/crypto.ts'
import { createMemoryTransportPair, flushAsync } from './helpers/memory-transport.ts'

const SOAK_ENABLED = process.env.DSH_MESH_SOAK === '1'
const SOAK_SKIP_MESSAGE = 'set DSH_MESH_SOAK=1 to run the soak tests'

function soakRounds(): number {
  const parsed = Number.parseInt(process.env.DSH_MESH_SOAK_ROUNDS ?? '', 10)
  if (!Number.isFinite(parsed) || parsed <= 0) return 20
  return Math.min(parsed, 200)
}

const ROUNDS = soakRounds()

const controllerIdentity: DeviceIdentity = generateDeviceIdentity({ name: 'soak-controller', platform: 'darwin' })
const daemonIdentity: DeviceIdentity = generateDeviceIdentity({ name: 'soak-daemon', platform: 'linux' })
const daemonDescriptor: DeviceDescriptor = deviceDescriptorOf(daemonIdentity)

function peerRecordOf(identity: DeviceIdentity): PeerRecord {
  return {
    deviceId: identity.deviceId,
    name: identity.name,
    platform: identity.platform,
    signPk: identity.signPk,
    dhPk: identity.dhPk,
    scope: { kind: 'control', workspaces: 'all', expiresAt: null },
    pairedAt: new Date().toISOString(),
    lastSeenAt: null,
    revokedAt: null,
  }
}

function emptyBody(): AsyncIterable<Uint8Array> {
  return (async function* empty(): AsyncGenerator<Uint8Array> {
    // intentionally yields no chunks
  })()
}

function daemonHandlers(): DaemonSessionHandlers {
  return {
    rpc: async (method) => {
      if (method === 'info') {
        return {
          device: { ...daemonDescriptor, appVersion: 'soak' },
          protocol: 1,
          capabilities: ['rpc', 'portal', 'workspaces'],
          hostLabel: 'soak-host',
        }
      }
      return { method }
    },
    http: async () => ({ status: 200, headers: {}, body: emptyBody() }),
    ws: async () => ({
      inbound: emptyBody(),
      outbound: { write: async () => undefined, end: async () => undefined, abort: async () => undefined },
    }),
  }
}

interface ChannelPair {
  readonly controller: MeshSession
  readonly daemon: DaemonMeshSession
}

/** Track unhandled rejections for the duration of one soak test. */
function trackUnhandledRejections(): { readonly seen: readonly unknown[]; stop(): void } {
  const seen: unknown[] = []
  const listener = (reason: unknown): void => {
    seen.push(reason)
  }
  process.on('unhandledRejection', listener)
  return {
    seen,
    stop: () => {
      process.off('unhandledRejection', listener)
    },
  }
}

async function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not settle within ${ms} ms`)), ms)
    timer.unref?.()
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

type Settled<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: unknown }

async function settle<T>(promise: Promise<T>): Promise<Settled<T>> {
  try {
    return { ok: true, value: await promise }
  } catch (error) {
    return { ok: false, error }
  }
}

async function establishPair(rpcTimeoutMs: number): Promise<ChannelPair> {
  const transports = createMemoryTransportPair()
  const [controller, daemon] = await withTimeout(
    Promise.all([
      connectMeshChannel({
        transport: transports.a,
        identity: controllerIdentity,
        daemon: daemonDescriptor,
        appVersion: 'soak',
        authTimeoutMs: 5_000,
        session: { rpcTimeoutMs },
      }),
      acceptMeshChannel({
        transport: transports.b,
        identity: daemonIdentity,
        authenticate: () => ({ kind: 'paired', peer: peerRecordOf(controllerIdentity) }),
        handlers: daemonHandlers(),
        appVersion: 'soak',
        authTimeoutMs: 5_000,
        session: { rpcTimeoutMs },
      }),
    ]),
    5_000,
    'soak handshake',
  )
  return { controller, daemon }
}

/** Crypto-free session factory used for open/close churn. */
function createChurnSession(role: 'controller' | 'daemon'): MeshSessionImpl {
  const bridge: SessionBridge = {
    role,
    remote: {
      deviceId: 'dm_soakpeer000000000000',
      name: 'soak-peer',
      platform: 'unknown',
      signPk: 'A'.repeat(43),
      dhPk: 'A'.repeat(43),
    },
    sas: undefined,
    pairing: undefined,
    sendPlaintext: () => undefined,
    onTransportClose: () => () => undefined,
    closeTransport: () => undefined,
    bufferedAmount: () => 0,
  }
  return createSession(bridge, {
    rpcTimeoutMs: 50,
    ...(role === 'daemon' ? { handlers: daemonHandlers() } : {}),
  })
}

describe('soak (optional, DSH_MESH_SOAK=1)', () => {
  it('repeated handshake + RPC + heartbeat + close cycles stay stable', async (t) => {
    if (!SOAK_ENABLED) {
      t.skip(SOAK_SKIP_MESSAGE)
      return
    }
    const tracker = trackUnhandledRejections()
    const events: RpcEvent[] = []
    try {
      for (let round = 0; round < ROUNDS; round += 1) {
        const pair = await establishPair(500)
        try {
          assert.ok(pair.controller.sas !== undefined)
          assert.equal(pair.controller.sas, pair.daemon.sas)
          assert.equal(pair.controller.remote.deviceId, daemonIdentity.deviceId)
          assert.equal(pair.daemon.remote.deviceId, controllerIdentity.deviceId)

          const info = await pair.controller.rpc<{ device: { deviceId: string } }>('info')
          assert.equal(info.device.deviceId, daemonIdentity.deviceId)
          assert.equal(await pair.controller.ping(1_000), 1)

          const received: RpcEvent[] = []
          const unsubscribe = pair.controller.onEvent(event => received.push(event))
          pair.daemon.emit('soak.tick', { round })
          await flushAsync(1)
          unsubscribe()
          events.push(...received)
        } finally {
          pair.controller.close()
          pair.daemon.close()
        }
        await withTimeout(pair.controller.closed, 2_000, 'controller close')
        await withTimeout(pair.daemon.closed, 2_000, 'daemon close')
        assert.equal(pair.controller.open, false)
        assert.equal(pair.daemon.open, false)
      }

      // Tear a handshake down at a random point: both endpoints must settle
      // (resolve or reject) without an unhandled rejection.
      for (let index = 0; index < 5; index += 1) {
        const transports = createMemoryTransportPair()
        const connecting = settle(connectMeshChannel({
          transport: transports.a,
          identity: controllerIdentity,
          daemon: daemonDescriptor,
          appVersion: 'soak',
          authTimeoutMs: 5_000,
        }))
        const accepting = settle(acceptMeshChannel({
          transport: transports.b,
          identity: daemonIdentity,
          authenticate: () => ({ kind: 'paired', peer: peerRecordOf(controllerIdentity) }),
          handlers: daemonHandlers(),
          appVersion: 'soak',
          authTimeoutMs: 5_000,
        }))
        transports.a.close(1006, 'soak-abort')
        const [connected, accepted] = await withTimeout(
          Promise.all([connecting, accepting]),
          5_000,
          'aborted handshake settlement',
        )
        for (const result of [connected, accepted]) {
          if (result.ok) result.value.close()
        }
      }
    } finally {
      tracker.stop()
    }
    assert.deepEqual(tracker.seen, [], 'soak must not leave unhandled rejections')
    t.diagnostic(`completed ${ROUNDS} handshake/RPC/close cycles, ${events.length} events observed`)
  })

  it('session open/close churn never throws and always resolves closed', async (t) => {
    if (!SOAK_ENABLED) {
      t.skip(SOAK_SKIP_MESSAGE)
      return
    }
    const tracker = trackUnhandledRejections()
    const opened: MeshSessionImpl[] = []
    try {
      const cycles = Math.max(ROUNDS * 10, 200)
      for (let index = 0; index < cycles; index += 1) {
        const session = createChurnSession(index % 2 === 0 ? 'controller' : 'daemon')
        assert.equal(session.open, true)
        session.close()
        assert.equal(session.open, false)
        opened.push(session)
      }
      await withTimeout(Promise.all(opened.map(session => session.closed)), 2_000, 'churn close')
      assert.ok(opened.every(session => !session.open))
      const heapMb = process.memoryUsage().heapUsed / (1024 * 1024)
      t.diagnostic(`completed ${cycles} open/close cycles, heap ${heapMb.toFixed(1)} MiB`)
    } finally {
      tracker.stop()
    }
    assert.deepEqual(tracker.seen, [], 'churn must not leave unhandled rejections')
  })
})
