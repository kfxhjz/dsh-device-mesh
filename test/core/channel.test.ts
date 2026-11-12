/**
 * Channel tests: real Noise NK handshake + ClientAuth/ServerAuth over the
 * in-memory transport. Covers success, pinning, revocation, signatures,
 * pending pairing approval, timeouts, tamper/replay/order and framing errors.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import type {
  ClientAuthMessage,
  DeviceDescriptor,
  DeviceIdentity,
  MeshInfo,
  PeerRecord,
} from '../../src/shared/protocol.ts'
import type { MeshTransport } from '../../src/shared/transport.ts'
import { MeshRpcError } from '../../src/shared/mesh-session.ts'
import type { DaemonAuthOutcome, DaemonSessionHandlers, MeshSession } from '../../src/shared/mesh-session.ts'
import {
  MeshChannelError,
  NonceReplayCache,
  acceptMeshChannel,
  connectMeshChannel,
} from '../../src/host/channel.ts'
import type { DaemonMeshSession } from '../../src/host/session.ts'
import {
  deviceDescriptorOf,
  generateDeviceIdentity,
  randomBytes,
  encodeBase64Url,
  decodeBase64Url,
} from '../../src/host/crypto.ts'
import { NoiseNkHandshake } from '../../src/host/noise.ts'
import type { CipherState } from '../../src/host/noise.ts'
import { createMemoryTransportPair, delay, flushAsync } from './helpers/memory-transport.ts'
import type { MemoryTransport } from './helpers/memory-transport.ts'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const controllerIdentity = generateDeviceIdentity({ name: 'controller-mac', platform: 'darwin' })
const daemonIdentity = generateDeviceIdentity({ name: 'daemon-linux', platform: 'linux' })
const daemonDescriptor = deviceDescriptorOf(daemonIdentity)

const daemonInfo: MeshInfo = {
  device: { ...daemonDescriptor, appVersion: '1.0.0-test' },
  protocol: 1,
  capabilities: ['rpc', 'portal', 'workspaces'],
  hostLabel: 'daemon-host',
}

function peerRecordOf(identity: DeviceIdentity, overrides: Partial<PeerRecord> = {}): PeerRecord {
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
    ...overrides,
  }
}

function makeHandlers(overrides: Partial<DaemonSessionHandlers> = {}): DaemonSessionHandlers {
  return {
    rpc: async (method, params) => {
      if (method === 'info') return daemonInfo
      if (method === 'pair.status') return { state: 'pending' }
      if (method === 'workspaces.list') return { updatedAt: new Date().toISOString(), workspaces: [] }
      return { method, params }
    },
    http: async () => ({ status: 200, headers: {}, body: emptyBody() }),
    ws: async () => ({ protocol: 'test', inbound: emptyBody(), outbound: captureSink() }),
    ...overrides,
  }
}

function emptyBody(): AsyncIterable<Uint8Array> {
  return (async function* empty(): AsyncGenerator<Uint8Array> {
    // no chunks
  })()
}

function captureSink() {
  const messages: Uint8Array[] = []
  return {
    messages,
    write: async (chunk: Uint8Array) => {
      messages.push(chunk)
    },
    end: async () => undefined,
    abort: async () => undefined,
  }
}

interface ConnectOptions {
  readonly daemonAuth?: DaemonOutcomeFactory
  readonly controllerAuth?: { readonly kind: 'paired' } | { readonly kind: 'pair-token'; readonly daemonId: string; readonly token: string }
  readonly daemon?: DeviceDescriptor
  readonly authTimeoutMs?: number
  readonly nonceCache?: NonceReplayCache
  readonly handlers?: DaemonSessionHandlers
  readonly rpcTimeoutMs?: number
}

type DaemonOutcomeFactory = (context: {
  readonly sas: string
  readonly clientNonce: Uint8Array
}) => Promise<DaemonAuthOutcome> | DaemonAuthOutcome

async function establishPair(options: ConnectOptions = {}): Promise<{
  controller: MeshSession
  daemon: DaemonMeshSession
  controllerTransport: MemoryTransport
  daemonTransport: MemoryTransport
  sas: string
}> {
  const transportPair = createMemoryTransportPair()
  let sasSeen = ''
  const authenticate = options.daemonAuth ?? (() => ({ kind: 'paired', peer: peerRecordOf(controllerIdentity) }))
  const wrappedAuth: DaemonOutcomeFactory = async (context) => {
    sasSeen = context.sas
    return authenticate(context)
  }
  const [controller, daemon] = await Promise.all([
    connectMeshChannel({
      transport: transportPair.a,
      identity: controllerIdentity,
      daemon: options.daemon ?? daemonDescriptor,
      auth: options.controllerAuth ?? { kind: 'paired' },
      appVersion: '1.0.0-test',
      authTimeoutMs: options.authTimeoutMs ?? 2_000,
      session: { rpcTimeoutMs: options.rpcTimeoutMs ?? 1_000 },
    }),
    acceptMeshChannel({
      transport: transportPair.b,
      identity: daemonIdentity,
      authenticate: wrappedAuth,
      handlers: options.handlers ?? makeHandlers(),
      appVersion: '1.0.0-test',
      authTimeoutMs: options.authTimeoutMs ?? 2_000,
      ...(options.nonceCache === undefined ? {} : { nonceCache: options.nonceCache }),
      session: { rpcTimeoutMs: options.rpcTimeoutMs ?? 1_000 },
    }),
  ])
  return {
    controller,
    daemon: daemon,
    controllerTransport: transportPair.a,
    daemonTransport: transportPair.b,
    sas: sasSeen,
  }
}

function settle<T>(promise: Promise<T>): Promise<
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: unknown }
> {
  return promise.then(
    value => ({ ok: true as const, value }),
    error => ({ ok: false as const, error }),
  )
}

async function expectChannelError(promise: Promise<unknown>, code: string): Promise<MeshChannelError> {
  try {
    await promise
  } catch (error) {
    assert.ok(error instanceof MeshChannelError, `expected MeshChannelError, got ${String(error)}`)
    assert.equal(error.code, code)
    return error
  }
  assert.fail(`expected rejection with ${code}`)
}

function closedWithin(session: MeshSession, ms = 1_000): Promise<void> {
  return Promise.race([
    session.closed,
    delay(ms).then(() => {
      throw new Error('session did not close')
    }),
  ])
}

// ---------------------------------------------------------------------------
// Rogue controller (manual Noise state machine) for negative protocol tests
// ---------------------------------------------------------------------------

class FrameQueue {
  private readonly queue: Uint8Array[] = []
  private readonly waiters: Array<(frame: Uint8Array) => void> = []
  private stopped = false

  constructor(transport: MeshTransport) {
    transport.onMessage((frame) => {
      const copy = new Uint8Array(frame)
      const waiter = this.waiters.shift()
      if (waiter) waiter(copy)
      else this.queue.push(copy)
    })
    transport.onClose(() => {
      this.stopped = true
    })
  }

  next(timeoutMs = 1_000): Promise<Uint8Array> {
    const queued = this.queue.shift()
    if (queued) return Promise.resolve(queued)
    if (this.stopped) return Promise.reject(new Error('transport closed'))
    return new Promise<Uint8Array>((resolve, reject) => {
      const timer = setTimeout(() =>{  reject(new Error('frame timeout')) }, timeoutMs)
      this.waiters.push((frame) => {
        clearTimeout(timer)
        resolve(frame)
      })
    })
  }

  push(frame: Uint8Array): void {
    const waiter = this.waiters.shift()
    if (waiter) waiter(new Uint8Array(frame))
    else this.queue.push(new Uint8Array(frame))
  }
}

interface RogueClient {
  readonly identity: DeviceIdentity
  readonly handshakeHash: Uint8Array
  readonly tx: CipherState
  readonly rx: CipherState
  readonly frames: FrameQueue
  sendSealed(plaintext: Uint8Array): void
  readSealed(timeoutMs?: number): Promise<Uint8Array>
  sendRaw(frame: Uint8Array): void
}

async function startRogue(
  transport: MeshTransport,
  daemon: DeviceDescriptor,
  identity: DeviceIdentity,
  options: { readonly handshakePayload?: Uint8Array } = {},
): Promise<RogueClient> {
  const frames = new FrameQueue(transport)
  const handshake = new NoiseNkHandshake({
    role: 'initiator',
    remoteStaticPublicKey: decodeBase64Url(daemon.dhPk),
  })
  const message1 = handshake.writeMessage(options.handshakePayload ?? new Uint8Array(0))
  const frame1 = new Uint8Array(1 + message1.length)
  frame1[0] = 0x01
  frame1.set(message1, 1)
  transport.send(frame1)
  const frame2 = await frames.next()
  assert.equal(frame2[0], 0x01, 'expected a Noise handshake frame')
  handshake.readMessage(frame2.subarray(1))
  const handshakeHash = handshake.handshakeHash
  const { tx, rx } = handshake.split()
  handshake.destroy()
  const client: RogueClient = {
    identity,
    handshakeHash,
    tx,
    rx,
    frames,
    sendRaw: (frame) =>{  transport.send(frame) },
    sendSealed: (plaintext) => {
      const sealed = tx.encryptWithAd(new Uint8Array(0), plaintext)
      const frame = new Uint8Array(1 + sealed.length)
      frame[0] = 0x02
      frame.set(sealed, 1)
      transport.send(frame)
    },
    readSealed: async (timeoutMs) => {
      const frame = await frames.next(timeoutMs)
      assert.equal(frame[0], 0x02, 'expected a sealed frame')
      return rx.decryptWithAd(new Uint8Array(0), frame.subarray(1))
    },
  }
  return client
}

function controlFrame(message: unknown): Uint8Array {
  const body = new TextEncoder().encode(JSON.stringify(message))
  const frame = new Uint8Array(1 + body.length)
  frame[0] = 0x10
  frame.set(body, 1)
  return frame
}

function clientAuthMessage(
  identity: DeviceIdentity,
  options: {
    readonly version?: number
    readonly nonce?: Uint8Array
    readonly auth?: ClientAuthMessage['auth']
  } = {},
): ClientAuthMessage {
  return {
    t: 'client_auth',
    v: (options.version ?? 1) as 1,
    controller: deviceDescriptorOf(identity),
    nonce: encodeBase64Url(options.nonce ?? randomBytes(32)),
    auth: options.auth ?? { kind: 'paired', sig: 'A'.repeat(86) },
  }
}

// ---------------------------------------------------------------------------
// Success paths
// ---------------------------------------------------------------------------

test('paired controller and daemon complete the Noise + application authentication', async () => {
  const pair = await establishPair()
  try {
    assert.equal(pair.controller.role, 'controller')
    assert.equal(pair.daemon.role, 'daemon')
    assert.equal(pair.controller.remote.deviceId, daemonIdentity.deviceId)
    assert.equal(pair.daemon.remote.deviceId, controllerIdentity.deviceId)
    assert.equal(pair.controller.open, true)
    assert.equal(pair.daemon.open, true)
    assert.equal(pair.controller.pairing?.approval, 'none')
    assert.equal(pair.daemon.pairing?.approval, 'none')
    assert.match(pair.sas, /^\d{3}-\d{3}$/u)
    assert.equal(pair.controller.sas, pair.sas)
    assert.equal(pair.daemon.sas, pair.sas)
    assert.equal(pair.controller.sas, pair.daemon.sas)

    // RPC + info learning + events.
    const info = await pair.controller.rpc<MeshInfo>('info')
    assert.equal(info.protocol, 1)
    assert.equal(pair.controller.info?.device.deviceId, daemonIdentity.deviceId)
    const events: unknown[] = []
    pair.controller.onEvent(event => events.push(event))
    pair.daemon.emit('workspaces.changed', { updatedAt: 'now' })
    await flushAsync()
    assert.deepEqual(events, [{ event: 'workspaces.changed', data: { updatedAt: 'now' } }])

    // Application heartbeat both ways.
    assert.equal(await pair.controller.ping(500), 1)
    assert.equal(await pair.daemon.ping(500), 1)

    // Still open, then explicit close resolves `closed`.
    assert.equal(pair.controller.open, true)
    pair.controller.close()
    await closedWithin(pair.controller)
    await closedWithin(pair.daemon)
    assert.equal(pair.controller.open, false)
    assert.equal(pair.daemon.open, false)
  } finally {
    pair.controller.close()
    pair.daemon.close()
  }
})

test('a paired outcome cannot authorize a pair-token client_auth (S6)', async () => {
  const token = encodeBase64Url(randomBytes(32))
  await expectChannelError(establishPair({
    controllerAuth: { kind: 'pair-token', daemonId: daemonDescriptor.deviceId, token },
    daemonAuth: () => ({ kind: 'paired', peer: peerRecordOf(controllerIdentity) }),
  }), 'mesh/unauthorized')
})

test('pair-token session is gated until the local user approves', async () => {
  let decide: (decision: { approved: boolean }) => void = () => {}
  const decision = new Promise<{ approved: boolean }>((resolve) => {
    decide = resolve
  })
  const token = randomBytes(32)
  const pair = await establishPair({
    controllerAuth: { kind: 'pair-token', daemonId: daemonIdentity.deviceId, token: encodeBase64Url(token) },
    daemonAuth: () => ({
      kind: 'pair-approval-required',
      requestId: 'pair-req-1',
      decide: decision,
    }),
  })
  try {
    assert.equal(pair.controller.pairing?.approval, 'pending')
    assert.equal(pair.controller.pairing?.requestId, 'pair-req-1')
    assert.equal(pair.daemon.pairing?.approval, 'pending')
    assert.equal(pair.controller.sas, pair.daemon.sas)

    // Everything except pair.status is rejected while pending.
    await assert.rejects(pair.controller.rpc('workspaces.list'), (error: unknown) => {
      return error instanceof MeshRpcError && error.code === 'mesh/unauthorized'
    })
    await assert.rejects(pair.controller.http({ method: 'GET', path: '/', headers: {} }), (error: unknown) => {
      return error instanceof MeshRpcError && error.code === 'mesh/unauthorized'
    })
    const status = await pair.controller.rpc<{ state: string }>('pair.status', { requestId: 'pair-req-1' })
    assert.equal(status.state, 'pending')

    decide({ approved: true })
    await flushAsync()
    // The daemon's pairing view is live: approval flips it to `none` without
    // a reconnect (the controller keeps its authenticated snapshot).
    assert.equal(pair.daemon.pairing?.approval, 'none')
    const result = await pair.controller.rpc<{ workspaces: unknown[] }>('workspaces.list')
    assert.deepEqual(result.workspaces, [])
    assert.equal(pair.controller.open, true)
  } finally {
    pair.controller.close()
    pair.daemon.close()
  }
})

test('denying a pairing request closes both sessions', async () => {
  let decide: (decision: { approved: boolean }) => void = () => {}
  const decision = new Promise<{ approved: boolean }>((resolve) => {
    decide = resolve
  })
  const pair = await establishPair({
    controllerAuth: {
      kind: 'pair-token',
      daemonId: daemonIdentity.deviceId,
      token: encodeBase64Url(randomBytes(32)),
    },
    daemonAuth: () => ({ kind: 'pair-approval-required', requestId: 'pair-req-2', decide: decision }),
  })
  decide({ approved: false })
  await closedWithin(pair.controller)
  await closedWithin(pair.daemon)
  assert.equal(pair.controller.open, false)
  assert.equal(pair.daemon.open, false)
})

test('scope expiry and revocation are rejected', async () => {
  await expectChannelError(
    establishPair({
      daemonAuth: () => ({
        kind: 'paired',
        peer: peerRecordOf(controllerIdentity, { scope: { kind: 'control', workspaces: 'all', expiresAt: 1 } }),
      }),
    }),
    'mesh/unauthorized',
  )
  await expectChannelError(
    establishPair({
      daemonAuth: () => ({
        kind: 'paired',
        peer: peerRecordOf(controllerIdentity, { revokedAt: new Date().toISOString() }),
      }),
    }),
    'mesh/revoked',
  )
})

test('unknown controller, changed keys and pinned-daemon mismatch are rejected', async () => {
  // Daemon rejects the controller outright (no pairing record).
  await expectChannelError(
    establishPair({
      daemonAuth: () => {
        throw new MeshRpcError('mesh/unauthorized', 'unknown controller')
      },
    }),
    'mesh/unauthorized',
  )

  // Pairing record has different signing keys -> identity change.
  const other = generateDeviceIdentity({ name: 'impostor' })
  await expectChannelError(
    establishPair({ daemonAuth: () => ({ kind: 'paired', peer: peerRecordOf(other) }) }),
    'mesh/unauthorized',
  )

  // Controller pins a descriptor whose signing key differs from the daemon
  // that answers. The X25519 static key stays the same so Noise NK still
  // completes; the mismatch must then be caught on the ServerAuth identity.
  const foreignDaemon: DeviceDescriptor = {
    ...deviceDescriptorOf(generateDeviceIdentity({ name: 'foreign-daemon', platform: 'linux' })),
    dhPk: daemonDescriptor.dhPk,
  }
  const transportPair = createMemoryTransportPair()
  const controllerOutcome = settle(connectMeshChannel({
    transport: transportPair.a,
    identity: controllerIdentity,
    daemon: foreignDaemon,
    appVersion: 'test',
    authTimeoutMs: 2_000,
  }))
  const daemonOutcome = settle(acceptMeshChannel({
    transport: transportPair.b,
    identity: daemonIdentity,
    authenticate: () => ({ kind: 'paired', peer: peerRecordOf(controllerIdentity) }),
    handlers: makeHandlers(),
    appVersion: 'test',
    authTimeoutMs: 2_000,
  }))
  const controllerResult = await controllerOutcome
  assert.equal(controllerResult.ok, false)
  const controllerError = controllerResult.ok ? undefined : controllerResult.error
  assert.ok(controllerError instanceof MeshChannelError)
  assert.equal(controllerError.code, 'mesh/unauthorized')
  await daemonOutcome
  await flushAsync()
  assert.equal(transportPair.a.closed, true)
  assert.equal(transportPair.a.closeInfo?.code, 4403)
})

test('errors never contain the pairing token or key material', async () => {
  const token = encodeBase64Url(randomBytes(32))
  const error = await expectChannelError(
    establishPair({
      controllerAuth: { kind: 'pair-token', daemonId: daemonIdentity.deviceId, token },
      daemonAuth: () => {
        throw new MeshRpcError('mesh/unauthorized', 'token rejected')
      },
    }),
    'mesh/unauthorized',
  )
  assert.equal(error.message.includes(token), false)
  assert.equal(error.message.includes(controllerIdentity.signSk.slice(0, 16)), false)
})

// ---------------------------------------------------------------------------
// Timeouts, transport failures and invalid local input
// ---------------------------------------------------------------------------

test('authentication times out after authTimeoutMs with a stable code', async () => {
  const transportPair = createMemoryTransportPair()
  const started = Date.now()
  await expectChannelError(
    connectMeshChannel({
      transport: transportPair.a,
      identity: controllerIdentity,
      daemon: daemonDescriptor,
      appVersion: 'test',
      authTimeoutMs: 40,
    }),
    'mesh/unauthorized',
  )
  assert.ok(Date.now() - started >= 30, 'must actually wait for the deadline')
  await flushAsync()
  assert.equal(transportPair.a.closeInfo?.code, 4408)
})

test('transport close during authentication rejects cleanly', async () => {
  const transportPair = createMemoryTransportPair()
  const connecting = connectMeshChannel({
    transport: transportPair.a,
    identity: controllerIdentity,
    daemon: daemonDescriptor,
    appVersion: 'test',
    authTimeoutMs: 2_000,
  })
  await flushAsync(1)
  transportPair.a.close(1006, 'dropped')
  await expectChannelError(connecting, 'mesh/internal')
})

test('invalid local pairing token is rejected before touching the transport', async () => {
  const transportPair = createMemoryTransportPair()
  await expectChannelError(
    connectMeshChannel({
      transport: transportPair.a,
      identity: controllerIdentity,
      daemon: daemonDescriptor,
      auth: { kind: 'pair-token', daemonId: daemonIdentity.deviceId, token: 'AAAA' },
      appVersion: 'test',
    }),
    'mesh/unauthorized',
  )
  assert.equal(transportPair.a.closed, false)
})

// ---------------------------------------------------------------------------
// Protocol violations on the wire
// ---------------------------------------------------------------------------

test('sealed frame before the Noise handshake closes with 4400', async () => {
  const transportPair = createMemoryTransportPair()
  const acceptance = acceptMeshChannel({
    transport: transportPair.b,
    identity: daemonIdentity,
    authenticate: () => ({ kind: 'paired', peer: peerRecordOf(controllerIdentity) }),
    handlers: makeHandlers(),
    appVersion: 'test',
    authTimeoutMs: 2_000,
  })
  await flushAsync(1)
  transportPair.b.deliver(new Uint8Array([0x02, 1, 2, 3]))
  await expectChannelError(acceptance, 'mesh/bad-request')
  assert.equal(transportPair.b.closeInfo?.code, 4400)
})

test('a silent peer is closed by the first-frame timeout (4408)', async () => {
  const transportPair = createMemoryTransportPair()
  const startedAt = Date.now()
  const acceptance = acceptMeshChannel({
    transport: transportPair.b,
    identity: daemonIdentity,
    authenticate: () => ({ kind: 'paired', peer: peerRecordOf(controllerIdentity) }),
    handlers: makeHandlers(),
    appVersion: 'test',
    authTimeoutMs: 2_000,
    firstFrameTimeoutMs: 60,
  })
  await expectChannelError(acceptance, 'mesh/unauthorized')
  assert.ok(Date.now() - startedAt < 1_500, 'first-frame timeout must fire long before the auth timeout')
  assert.equal(transportPair.b.closeInfo?.code, 4408)
})

test('non-empty Noise handshake payload is rejected', async () => {
  const transportPair = createMemoryTransportPair()
  const acceptance = settle(acceptMeshChannel({
    transport: transportPair.b,
    identity: daemonIdentity,
    authenticate: () => ({ kind: 'paired', peer: peerRecordOf(controllerIdentity) }),
    handlers: makeHandlers(),
    appVersion: 'test',
    authTimeoutMs: 1_000,
  }))
  const handshake = new NoiseNkHandshake({
    role: 'initiator',
    remoteStaticPublicKey: decodeBase64Url(daemonDescriptor.dhPk),
  })
  const message1 = handshake.writeMessage(new Uint8Array([1, 2, 3]))
  const frame = new Uint8Array(1 + message1.length)
  frame[0] = 0x01
  frame.set(message1, 1)
  transportPair.a.send(frame)
  const outcome = await acceptance
  assert.equal(outcome.ok, false)
  const error = outcome.ok ? undefined : outcome.error
  assert.ok(error instanceof MeshChannelError)
  assert.equal(error.code, 'mesh/bad-request')
  await flushAsync()
  assert.equal(transportPair.b.closeInfo?.code, 4400)
})

test('a 0x01 frame after the handshake is a protocol error (4400)', async () => {
  const transportPair = createMemoryTransportPair()
  const acceptance = acceptMeshChannel({
    transport: transportPair.b,
    identity: daemonIdentity,
    authenticate: () => ({ kind: 'paired', peer: peerRecordOf(controllerIdentity) }),
    handlers: makeHandlers(),
    appVersion: 'test',
    authTimeoutMs: 1_000,
  })
  const rogue = await startRogue(transportPair.a, daemonDescriptor, controllerIdentity)
  rogue.sendRaw(new Uint8Array([0x01, 0x00]))
  await expectChannelError(acceptance, 'mesh/bad-request')
  assert.equal(transportPair.b.closeInfo?.code, 4400)
})

test('protocol version mismatch is rejected with mesh/version-mismatch', async () => {
  const transportPair = createMemoryTransportPair()
  const acceptance = acceptMeshChannel({
    transport: transportPair.b,
    identity: daemonIdentity,
    authenticate: () => ({ kind: 'paired', peer: peerRecordOf(controllerIdentity) }),
    handlers: makeHandlers(),
    appVersion: 'test',
    authTimeoutMs: 1_000,
  })
  const rogue = await startRogue(transportPair.a, daemonDescriptor, controllerIdentity)
  rogue.sendSealed(controlFrame(clientAuthMessage(controllerIdentity, { version: 2 })))
  await expectChannelError(acceptance, 'mesh/version-mismatch')
  assert.equal(transportPair.b.closeInfo?.code, 4400)
})

test('client nonce replay across sessions is rejected', async () => {
  const nonceCache = new NonceReplayCache()
  const nonce = randomBytes(32)
  const token = encodeBase64Url(randomBytes(32))
  const runOnce = async (): Promise<MeshSession> => {
    const transportPair = createMemoryTransportPair()
    const acceptance = acceptMeshChannel({
      transport: transportPair.b,
      identity: daemonIdentity,
      authenticate: () => ({
        kind: 'pair-approval-required',
        requestId: 'replay-test',
        decide: new Promise(() => {}),
      }),
      handlers: makeHandlers(),
      appVersion: 'test',
      authTimeoutMs: 1_000,
      nonceCache,
    })
    const rogue = await startRogue(transportPair.a, daemonDescriptor, controllerIdentity)
    rogue.sendSealed(
      controlFrame(
        clientAuthMessage(controllerIdentity, {
          nonce,
          auth: { kind: 'pair-token', daemonId: daemonIdentity.deviceId, token },
        }),
      ),
    )
    await rogue.readSealed()
    const session = await acceptance
    session.close()
    return session
  }
  const first = await runOnce()
  await closedWithin(first)

  const transportPair = createMemoryTransportPair()
  const acceptance = acceptMeshChannel({
    transport: transportPair.b,
    identity: daemonIdentity,
    authenticate: () => ({ kind: 'paired', peer: peerRecordOf(controllerIdentity) }),
    handlers: makeHandlers(),
    appVersion: 'test',
    authTimeoutMs: 1_000,
    nonceCache,
  })
  const rogue = await startRogue(transportPair.a, daemonDescriptor, controllerIdentity)
  rogue.sendSealed(
    controlFrame(
      clientAuthMessage(controllerIdentity, {
        nonce,
        auth: { kind: 'pair-token', daemonId: daemonIdentity.deviceId, token },
      }),
    ),
  )
  await expectChannelError(acceptance, 'mesh/unauthorized')
  assert.equal(transportPair.b.closeInfo?.code, 4403)
})

test('tampered sealed frames close the session with 4401', async () => {
  const pair = await establishPair()
  let tampered = false
  pair.controllerTransport.outboundHook = (frame) => {
    if (!tampered && frame[0] === 0x02) {
      tampered = true
      const copy = new Uint8Array(frame)
      copy[copy.length - 1] = (copy[copy.length - 1] ?? 0) ^ 0x01
      return copy
    }
    return frame
  }
  const ping = pair.controller.ping(500).catch(() => undefined)
  await ping
  await closedWithin(pair.controller)
  await closedWithin(pair.daemon)
  assert.equal(pair.daemonTransport.closeInfo?.code, 4401)
  assert.equal(pair.controller.open, false)
  assert.equal(pair.daemon.open, false)
})

test('replayed sealed frames close the session with 4401', async () => {
  const pair = await establishPair()
  let captured: Uint8Array | undefined
  pair.controllerTransport.outboundHook = (frame) => {
    if (!captured && frame[0] === 0x02) captured = new Uint8Array(frame)
    return frame
  }
  await pair.controller.ping(500)
  assert.ok(captured)
  await flushAsync()
  pair.daemonTransport.deliver(captured)
  await closedWithin(pair.daemon)
  assert.equal(pair.daemonTransport.closeInfo?.code, 4401)
})

test('unsealed frames after authentication close with 4400', async () => {
  const pair = await establishPair()
  // A raw 0x11 frame is not a Noise transport frame: the channel must treat it
  // as a framing violation, not as stream data.
  pair.daemonTransport.deliver(new Uint8Array([0x11, 0x00, 0x00, 0x00, 0xfd, 0x01, 0x2a]))
  await closedWithin(pair.daemon)
  assert.equal(pair.daemon.open, false)
  assert.equal(pair.daemonTransport.closeInfo?.code, 4400)
})

test('handshake frame size and message caps are enforced', async () => {
  const transportPair = createMemoryTransportPair()
  const acceptance = acceptMeshChannel({
    transport: transportPair.b,
    identity: daemonIdentity,
    authenticate: () => ({ kind: 'paired', peer: peerRecordOf(controllerIdentity) }),
    handlers: makeHandlers(),
    appVersion: 'test',
    authTimeoutMs: 1_000,
  })
  await flushAsync(1)
  const oversized = new Uint8Array(5 * 1024)
  oversized[0] = 0x01
  transportPair.b.deliver(oversized)
  await expectChannelError(acceptance, 'mesh/bad-request')
  assert.equal(transportPair.b.closeInfo?.code, 4400)
})
