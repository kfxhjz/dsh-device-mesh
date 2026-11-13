import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type {
  DeviceDescriptor,
  PairingScope,
  WorkspacesResult,
} from '../../src/shared/protocol.ts'
import type { MeshSession, MeshSessionPairing } from '../../src/shared/mesh-session.ts'
import type { DirectListener, RelayDaemon } from '../../src/shared/transport.ts'
import { DeviceMeshBroker } from '../../src/host/broker.ts'
import type {
  BrokerTransportFactories,
  ControllerConnectOptions,
  DirectStartOptions,
  PortalOpener,
} from '../../src/host/broker.ts'
import { MAX_INBOUND_SESSIONS, MAX_INBOUND_SESSIONS_PER_CONTROLLER } from '../../src/host/config.ts'
import { generateDeviceIdentity } from '../../src/host/crypto.ts'
import { PairingError, PairingService, createPairingTicket } from '../../src/host/pairing.ts'
import { PortalDaemon } from '../../src/host/portal-daemon.ts'
import { MeshStore } from '../../src/host/store.ts'
import { WorkspaceProvider } from '../../src/host/workspaces.ts'
import type { PortalController } from '../../src/host/portal-controller.ts'
import { FakeMeshSession, FakeTransport, flush, makeTempDir, streamOf } from './helpers.ts'

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for a condition')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

/** A promise plus its resolvers, used to hold a fake handshake open. */
function deferred<T = void>(): {
  readonly promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: unknown) => void
} {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((settle, fail) => {
    resolve = settle
    reject = fail
  })
  return { promise, resolve, reject }
}

/** Create a pairing ticket + pending first-contact request for one controller. */
async function beginPendingRequest(
  fixture: BrokerFixture,
  controller: DeviceDescriptor = generateDeviceIdentity({ name: 'Phone' }),
): Promise<{ readonly controller: DeviceDescriptor; readonly requestId: string; readonly decide: Promise<{ approved: boolean }> }> {
  const created = await fixture.broker.createPairingTicket()
  const outcome = await fixture.broker.beginPairToken(
    controller,
    created.ticket.tok,
    new Uint8Array(32).fill(7),
    '123-456',
  )
  assert.equal(outcome.kind, 'pair-approval-required')
  if (outcome.kind !== 'pair-approval-required') throw new Error('unreachable')
  return { controller, requestId: outcome.requestId, decide: outcome.decide }
}

const WORKSPACES: WorkspacesResult = {
  updatedAt: '2026-01-01T00:00:00.000Z',
  workspaces: [{
    id: 'ws',
    title: 'Remote',
    path: '/remote',
    sessions: [{
      id: 'session-x',
      title: 'Archived session',
      updatedAt: '2026-01-01T00:00:00.000Z',
      running: false,
      awaitingUser: false,
      unread: false,
      archived: true,
    }],
  }],
}

interface FakeReply {
  readonly url: string
  readonly open: boolean
  readonly closed: Promise<void>
  readonly status: () => Record<string, unknown>
  close(): Promise<void>
}

function fakePortalController(deviceId: string): FakeReply & PortalController {
  let open = true
  let resolveClosed!: () => void
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve
  })
  const controller = {
    get url() {
      return `http://127.0.0.1:44444/?token=${deviceId}`
    },
    get origin() {
      return 'http://127.0.0.1:44444'
    },
    get port() {
      return 44444
    },
    get open() {
      return open
    },
    get lastError() {
      return undefined
    },
    get closedPromise() {
      return closed
    },
    status: () => ({ deviceId, port: 44444, activeStreams: 0, websockets: 0, idleMs: 0, lastError: null }),
    async close() {
      open = false
      resolveClosed()
    },
  }
  return controller as unknown as FakeReply & PortalController
}

interface BrokerFixture {
  readonly broker: DeviceMeshBroker
  readonly store: MeshStore
  readonly pairing: PairingService
  readonly connected: FakeMeshSession[]
  readonly cleanup: () => Promise<void>
}

async function makeBroker(options: {
  readonly port?: number
  readonly twoEndpoints?: boolean
  readonly relay?: boolean
  readonly workspaceIds?: readonly string[]
  readonly sessionSas?: string
  readonly sessionPairing?: MeshSessionPairing
  /** Gate the fake connector to simulate a slow/delayed handshake. */
  readonly connectDelay?: (options: ControllerConnectOptions) => Promise<void>
  /** Responder used by the fake session's `pair.status`/`info` RPCs. */
  readonly rpc?: (method: string, params: unknown) => unknown
  /** Shorten the pairing request TTL (H2 timeout races). */
  readonly requestTtlMs?: number
  /** Shorten the first-contact approval watcher deadline (H3). */
  readonly pairingApprovalTimeoutMs?: number
} = {}): Promise<BrokerFixture> {
  const temp = await makeTempDir()
  const store = await MeshStore.open({ home: temp.dir })
  const pairing = new PairingService({
    identity: store.getIdentity(),
    store,
    ...(options.requestTtlMs !== undefined ? { requestTtlMs: options.requestTtlMs } : {}),
  })
  await pairing.init()
  const workspaceRows = (options.workspaceIds ?? []).map(id => ({
    id,
    title: `Workspace ${id}`,
    path: `/${id}`,
    sessionIds: [],
  }))
  const workspaces = new WorkspaceProvider({
    getService: name => (name === 'workspaceRegistry' ? { list: () => workspaceRows } : undefined),
  })
  const portalDaemon = new PortalDaemon({
    origin: 'http://127.0.0.1:3080',
    getService: name => (name === 'connection'
      ? { authenticatedUrl: (base: string) => `${base}/?token=test-launch-token` }
      : undefined),
    fetchImpl: async () => new Response(null, {
      status: 303,
      headers: { 'set-cookie': 'dsh-auth-test=portal-cookie; Max-Age=3600; Path=/' },
    }),
  })
  const connected: FakeMeshSession[] = []
  const factories: BrokerTransportFactories = {
    startDirectListener: async (startOptions: DirectStartOptions): Promise<DirectListener> => ({
      port: startOptions.port === 0 ? (options.port ?? 45871) : startOptions.port,
      urls: [`ws://127.0.0.1:${String(startOptions.port === 0 ? (options.port ?? 45871) : startOptions.port)}/mesh`],
      close: async () => {},
    }),
    connectDirect: async (url) => {
      void url
      return new FakeTransport('direct')
    },
    startRelayDaemon: async (): Promise<RelayDaemon> => {
      let connectedFlag = true
      const disconnectListeners: Array<(info: { code?: number; reason?: string; local?: boolean }) => void> = []
      return {
        ready: Promise.resolve(),
        onClient: () => () => {},
        onDisconnect: (listener) => {
          disconnectListeners.push(listener)
          return () => {}
        },
        get connected() {
          return connectedFlag
        },
        async close() {
          connectedFlag = false
          for (const listener of disconnectListeners) listener({ local: true })
        },
      }
    },
    connectRelay: async () => new FakeTransport('relay'),
  }
  const connector = {
    async connect(connectOptions: ControllerConnectOptions): Promise<{ session: MeshSession }> {
      if (options.connectDelay !== undefined) await options.connectDelay(connectOptions)
      const session = new FakeMeshSession({
        ...(options.sessionSas !== undefined ? { sas: options.sessionSas } : {}),
        ...(options.sessionPairing !== undefined ? { pairing: options.sessionPairing } : {}),
      }, (method: string, params: unknown) => {
        if (options.rpc !== undefined) return options.rpc(method, params)
        if (method === 'workspaces.list') return WORKSPACES
        if (method === 'info') return { protocol: 1 }
        return {}
      })
      connected.push(session)
      return { session }
    },
  }
  const portal: PortalOpener = {
    async open(portalOptions) {
      const controller = fakePortalController(portalOptions.deviceId)
      return controller
    },
  }
  const broker = new DeviceMeshBroker({
    store,
    pairing,
    workspaces,
    portalDaemon,
    factories,
    connector,
    portal,
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    appVersion: '9.9.9',
    directHost: '127.0.0.1',
    ...(options.pairingApprovalTimeoutMs !== undefined
      ? { pairingApprovalTimeoutMs: options.pairingApprovalTimeoutMs }
      : {}),
  })
  await broker.start()
  return {
    broker,
    store,
    pairing,
    connected,
    cleanup: async () => {
      await broker.stop()
      await temp.cleanup()
    },
  }
}

/** Persist a paired daemon peer record so controller flows have a target. */
function daemonRecord(descriptor: DeviceDescriptor, endpoints: Array<{ k: 'direct'; url: string }>) {
  return {
    deviceId: descriptor.deviceId,
    name: descriptor.name,
    platform: descriptor.platform,
    signPk: descriptor.signPk,
    dhPk: descriptor.dhPk,
    scope: { kind: 'control' as const, workspaces: 'all' as const, expiresAt: null },
    pairedAt: '2026-01-01T00:00:00.000Z',
    lastSeenAt: null,
    revokedAt: null,
    endpoints,
  }
}

describe('broker: daemon role and state', () => {
  it('starts the direct listener and advertises a pairing ticket', async () => {
    const fixture = await makeBroker()
    try {
      const state = fixture.broker.state()
      assert.equal(state.self.appVersion, '9.9.9')
      assert.equal(state.direct.enabled, true)
      assert.equal(state.direct.port, 45871)
      assert.equal(state.direct.urls.length, 1)

      const created = await fixture.broker.createPairingTicket()
      assert.match(created.link, /^dsh-mesh:\/\/pair\?d=/u)
      assert.equal(created.ticket.eps.length, 1)
      assert.equal(created.ticket.eps[0]?.k, 'direct')
      assert.equal(created.ticket.id, fixture.store.getIdentity().deviceId)
    } finally {
      await fixture.cleanup()
    }
  })

  it('advertises a relay endpoint only while this device serves relay (H3)', async () => {
    const fixture = await makeBroker()
    try {
      await fixture.store.updateSettings({ relay: { endpoint: 'wss://relay.example.com/ws', enabled: false } })
      await fixture.store.ensureRelayServerId(() => 'relay-sid')
      const before = await fixture.broker.createPairingTicket()
      assert.equal(
        before.ticket.eps.some(endpoint => endpoint.k === 'relay'),
        false,
        'an endpoint used only for outbound controller sessions must not be advertised',
      )

      await fixture.store.updateSettings({ relay: { enabled: true } })
      const after = await fixture.broker.createPairingTicket()
      const relay = after.ticket.eps.find(endpoint => endpoint.k === 'relay')
      assert.ok(relay !== undefined)
      assert.equal(relay.sid, 'relay-sid')
    } finally {
      await fixture.cleanup()
    }
  })

  it('never dials the local relay route for a peer with no cached endpoint (H3)', async () => {
    const fixture = await makeBroker()
    try {
      await fixture.store.updateSettings({ relay: { endpoint: 'wss://relay.example.com/ws', enabled: true } })
      await fixture.store.ensureRelayServerId(() => 'local-relay-sid')
      const daemonIdentity = generateDeviceIdentity({ name: 'Server' })
      await fixture.store.upsertPeer('daemons', daemonRecord(daemonIdentity, []))

      await assert.rejects(
        () => fixture.broker.connectDevice(daemonIdentity.deviceId),
        (error: unknown) => (error as { code?: string }).code === 'mesh/not-found',
      )
      const view = fixture.broker.state().devices.find(device => device.deviceId === daemonIdentity.deviceId)
      assert.match(view?.statusDetail ?? '', /no cached endpoint/u)
    } finally {
      await fixture.cleanup()
    }
  })

  it('cancels a first-contact request when its controller session closes (S4)', async () => {
    const fixture = await makeBroker()
    try {
      const pending = await beginPendingRequest(fixture)
      assert.equal(fixture.broker.state().pendingPairings.length, 1)
      let close!: () => void
      const session = {
        closed: new Promise<void>((resolve) => {
          close = resolve
        }),
      } as unknown as MeshSession
      fixture.broker.trackPendingPairing(pending.requestId, session)
      close()
      await waitFor(() => fixture.broker.state().pendingPairings.length === 0)
      assert.deepEqual(await pending.decide, { approved: false })
      assert.equal(fixture.pairing.getStatus(pending.requestId).state, 'denied')
    } finally {
      await fixture.cleanup()
    }
  })

  it('exposes the daemon RPC handlers with scope and pairing gates', async () => {
    const fixture = await makeBroker()
    try {
      const handlers = fixture.broker.createDaemonHandlers('dm_controller000000000001')
      // No peer record yet → everything except pair.status is unauthorized.
      await assert.rejects(
        () => handlers.rpc('workspaces.list', {}, new AbortController().signal),
        (error: unknown) => error instanceof Error && (error as { code?: string }).code === 'mesh/unauthorized',
      )

      const controllerIdentity = generateDeviceIdentity({ name: 'Pixel' })
      const paired = {
        ...daemonRecord(controllerIdentity, []),
        deviceId: 'dm_controller000000000001',
        signPk: controllerIdentity.signPk,
        dhPk: controllerIdentity.dhPk,
      }
      await fixture.store.upsertPeer('controllers', paired)
      const info = await handlers.rpc('info', {}, new AbortController().signal) as { protocol: number }
      assert.equal(info.protocol, 1)
      const workspaces = await handlers.rpc('workspaces.list', { refresh: true }, new AbortController().signal) as WorkspacesResult
      assert.equal(workspaces.workspaces.length, 0)
      const prepare = await handlers.rpc('portal.prepare', {}, new AbortController().signal) as { ok: boolean }
      assert.equal(prepare.ok, true)
      await assert.rejects(
        () => handlers.rpc('nope', {}, new AbortController().signal),
        (error: unknown) => (error as { code?: string }).code === 'mesh/not-found',
      )
    } finally {
      await fixture.cleanup()
    }
  })

  it('runs the first-contact pairing approval flow', async () => {
    const fixture = await makeBroker()
    try {
      const created = await fixture.broker.createPairingTicket()
      const controller = generateDeviceIdentity({ name: 'Pixel' })
      const outcome = await fixture.broker.beginPairToken(
        controller,
        created.ticket.tok,
        new Uint8Array(32).fill(1),
        '123-456',
      )
      assert.equal(outcome.kind, 'pair-approval-required')
      if (outcome.kind !== 'pair-approval-required') return
      const pending = fixture.broker.state().pendingPairings
      assert.equal(pending.length, 1)
      assert.equal(pending[0]?.sas, '123-456')
      assert.equal(pending[0]?.peer.deviceId, controller.deviceId)

      const status = fixture.pairing.getStatus(outcome.requestId)
      assert.equal(status.state, 'pending')
      fixture.broker.approvePairing(outcome.requestId)
      assert.deepEqual(await outcome.decide, { approved: true })
      await waitFor(() => fixture.store.findPeer('controllers', controller.deviceId) !== undefined)
      const record = fixture.store.findPeer('controllers', controller.deviceId)
      assert.ok(record)
      assert.equal(record.scope.kind, 'control')
      assert.equal(fixture.broker.state().pendingPairings.length, 0)
    } finally {
      await fixture.cleanup()
    }
  })
})

describe('broker: controller role', () => {
  it('pairs from a link, connects, lists remote workspaces and opens a portal', async () => {
    const fixture = await makeBroker()
    try {
      const daemonSide = generateDeviceIdentity({ name: 'Remote daemon' })
      const remoteTicket = createPairingTicket({
        identity: daemonSide,
        endpoints: [{ k: 'direct', url: 'ws://192.0.2.1:45871/mesh' }],
        token: Buffer.alloc(32, 5).toString('base64url'),
        now: Date.now(),
      })

      const view = await fixture.broker.pairWithLink(remoteTicket.link)
      assert.equal(view.deviceId, daemonSide.deviceId)
      // `pair.complete` is non-blocking: the record is pinned immediately and
      // the handshake finishes in the background.
      assert.ok(view.status === 'connecting' || view.status === 'online')
      assert.equal(view.direction, 'daemon')
      assert.ok(fixture.store.findPeer('daemons', daemonSide.deviceId))
      await waitFor(() => fixture.broker.state().devices
        .find(device => device.deviceId === daemonSide.deviceId)?.status === 'online')
      const online = fixture.broker.state().devices.find(device => device.deviceId === daemonSide.deviceId)
      assert.equal(online?.status, 'online')

      const workspaces = await fixture.broker.refreshWorkspaces(daemonSide.deviceId)
      assert.deepEqual(workspaces, WORKSPACES)
      // The controller-side sanitizer must preserve the archive flag; dropping
      // it makes the remote mirror's archive filter and unarchive action inert.
      assert.equal(workspaces.workspaces[0]?.sessions[0]?.archived, true)
      const stateWithWorkspaces = fixture.broker.state().devices.find(device => device.deviceId === daemonSide.deviceId)
      assert.equal(stateWithWorkspaces?.remoteWorkspaces?.length, 1)

      // Archive flows through the daemon RPC and then refreshes the listing.
      const archived = await fixture.broker.archiveSession(daemonSide.deviceId, 'session-x', true, true)
      assert.deepEqual(archived, WORKSPACES)
      const archiveCall = fixture.connected[0]?.rpcCalls.find(call => call.method === 'session.archive')
      assert.deepEqual(archiveCall?.params, { sessionId: 'session-x', stopActivity: true })

      const portal = await fixture.broker.openPortal(daemonSide.deviceId)
      assert.match(portal.url, /^http:\/\/127\.0\.0\.1:44444\//u)
      assert.equal(fixture.broker.state().portals.length, 1)
      const closed = await fixture.broker.closePortal(daemonSide.deviceId)
      assert.equal(closed.closed, true)
      assert.equal(fixture.broker.state().portals.length, 0)

      // A transient mesh loss keeps the portal alive so its capability URL can
      // be adopted by the reconnect instead of forcing the tab to be reopened.
      await fixture.broker.openPortal(daemonSide.deviceId)
      assert.equal(fixture.broker.state().portals.length, 1)
      fixture.connected[0]?.close()
      await waitFor(() => fixture.broker.state().devices
        .find(device => device.deviceId === daemonSide.deviceId)?.status !== 'online')
      assert.equal(fixture.broker.state().portals.length, 1)
    } finally {
      await fixture.cleanup()
    }
  })

  it('disconnects and reconnects a paired device', async () => {
    const fixture = await makeBroker()
    try {
      const daemonIdentity = generateDeviceIdentity({ name: 'Remote' })
      await fixture.store.upsertPeer('daemons', daemonRecord(daemonIdentity, [
        { k: 'direct', url: 'ws://192.0.2.9:45871/mesh' },
      ]))
      const connected = await fixture.broker.connectDevice(daemonIdentity.deviceId)
      assert.equal(connected.status, 'online')
      const disconnected = await fixture.broker.disconnectDevice(daemonIdentity.deviceId)
      assert.equal(disconnected.status, 'offline')
      assert.equal(fixture.connected[0]?.open, false)
    } finally {
      await fixture.cleanup()
    }
  })

  it('rejects an unknown device and a revoked one', async () => {
    const fixture = await makeBroker()
    try {
      await assert.rejects(
        () => fixture.broker.connectDevice('dm_unknown'),
        (error: unknown) => (error as { code?: string }).code === 'mesh/not-found',
      )
      const daemonIdentity = generateDeviceIdentity({ name: 'Remote' })
      await fixture.store.upsertPeer('daemons', daemonRecord(daemonIdentity, []))
      await fixture.broker.revokePeer(daemonIdentity.deviceId)
      await assert.rejects(
        () => fixture.broker.connectDevice(daemonIdentity.deviceId),
        (error: unknown) => (error as { code?: string }).code === 'mesh/revoked',
      )
      const revoked = fixture.broker.state().devices.find(device => device.deviceId === daemonIdentity.deviceId)
      assert.equal(revoked?.status, 'revoked')
      assert.equal(revoked?.revoked, true)
      const forgot = await fixture.broker.forgetPeer(daemonIdentity.deviceId)
      assert.equal(forgot.forgot, true)
    } finally {
      await fixture.cleanup()
    }
  })
})

describe('broker: settings and diagnostics', () => {
  it('reconfigures the direct listener and relay at runtime', async () => {
    const fixture = await makeBroker()
    try {
      const direct = await fixture.broker.configureDirect({ enabled: false })
      assert.equal(direct.enabled, false)
      assert.equal(fixture.broker.state().direct.enabled, false)

      const relay = await fixture.broker.configureRelay({
        endpoint: 'wss://relay.example.com/ws',
        enabled: true,
      })
      assert.equal(relay.configured, true)
      await flush()
      assert.equal(fixture.broker.state().relay.connected, true)
      assert.equal(fixture.broker.state().relay.endpoint, 'wss://relay.example.com/ws')
    } finally {
      await fixture.cleanup()
    }
  })

  it('reports diagnostics without any secret material', async () => {
    const fixture = await makeBroker()
    try {
      const created = await fixture.broker.createPairingTicket()
      const diagnostics = JSON.stringify(fixture.broker.diagnostics())
      assert.equal(diagnostics.includes(created.ticket.tok), false)
      assert.equal(diagnostics.includes(fixture.store.getIdentity().signSk), false)
      const audit = await fixture.broker.listAudit(10)
      assert.ok(Array.isArray(audit))
    } finally {
      await fixture.cleanup()
    }
  })

  it('closes inbound controller sessions when the controller is revoked', async () => {
    const fixture = await makeBroker()
    try {
      const controllerIdentity = generateDeviceIdentity({ name: 'Phone' })
      const descriptor: DeviceDescriptor = {
        deviceId: controllerIdentity.deviceId,
        name: controllerIdentity.name,
        platform: controllerIdentity.platform,
        signPk: controllerIdentity.signPk,
        dhPk: controllerIdentity.dhPk,
      }
      await fixture.store.upsertPeer('controllers', daemonRecord(descriptor, []))
      const session = new FakeMeshSession({ remote: descriptor })
      fixture.broker.noteInboundOpened(descriptor.deviceId, session)
      const online = fixture.broker.state().devices.find(device => device.deviceId === descriptor.deviceId)
      assert.equal(online?.status, 'online')

      await fixture.broker.revokePeer(descriptor.deviceId)

      assert.equal(session.open, false, 'revocation must close the inbound session')
      const revoked = fixture.broker.state().devices.find(device => device.deviceId === descriptor.deviceId)
      assert.equal(revoked?.status, 'revoked')
    } finally {
      await fixture.cleanup()
    }
  })
})

/** Persist a controller peer record with an explicit grant. */
function controllerRecord(descriptor: DeviceDescriptor, scope: PairingScope) {
  return { ...daemonRecord(descriptor, []), scope }
}

describe('broker: authorization model', () => {
  it('enforces view grants and workspace allowlists for controllers', async () => {
    const fixture = await makeBroker({ workspaceIds: ['ws-a', 'ws-b'] })
    try {
      const signal = new AbortController().signal
      const viewer = generateDeviceIdentity({ name: 'Viewer' })
      await fixture.store.upsertPeer('controllers', controllerRecord(viewer, {
        kind: 'view',
        workspaces: 'all',
        expiresAt: null,
      }))
      const viewHandlers = fixture.broker.createDaemonHandlers(viewer.deviceId)

      // Read-only RPCs stay available to a view grant.
      const info = await viewHandlers.rpc('info', {}, signal) as { protocol: number }
      assert.equal(info.protocol, 1)
      const viewed = await viewHandlers.rpc('workspaces.list', {}, signal) as WorkspacesResult
      assert.deepEqual(viewed.workspaces.map(workspace => workspace.id), ['ws-a', 'ws-b'])

      // Everything that can drive the device must be refused.
      for (const call of [
        () => viewHandlers.rpc('portal.prepare', {}, signal),
        () => viewHandlers.rpc('session.archive', { sessionId: 's1' }, signal),
        () => viewHandlers.rpc('session.unarchive', { sessionId: 's1' }, signal),
        () => viewHandlers.http({ method: 'GET', path: '/', headers: {} }, streamOf(), signal),
        () => viewHandlers.ws({ path: '/', headers: {} }, signal),
      ]) {
        await assert.rejects(call, (error: unknown) => (error as { code?: string }).code === 'mesh/unauthorized')
      }

      const limited = generateDeviceIdentity({ name: 'Limited' })
      await fixture.store.upsertPeer('controllers', controllerRecord(limited, {
        kind: 'control',
        workspaces: ['ws-a'],
        expiresAt: null,
      }))
      const limitedHandlers = fixture.broker.createDaemonHandlers(limited.deviceId)
      const allowed = await limitedHandlers.rpc('workspaces.list', { refresh: true }, signal) as WorkspacesResult
      assert.deepEqual(allowed.workspaces.map(workspace => workspace.id), ['ws-a'])
      // A portal exposes the whole origin, so it cannot be workspace-limited.
      await assert.rejects(
        () => limitedHandlers.rpc('portal.prepare', {}, signal),
        (error: unknown) => (error as { code?: string }).code === 'mesh/unauthorized',
      )
    } finally {
      await fixture.cleanup()
    }
  })

  it('rejects restricted pairing scopes instead of downgrading them', async () => {
    const fixture = await makeBroker()
    try {
      const created = await fixture.broker.createPairingTicket()
      const controller = generateDeviceIdentity({ name: 'Phone' })
      const outcome = await fixture.broker.beginPairToken(
        controller,
        created.ticket.tok,
        new Uint8Array(32).fill(2),
        '111-222',
      )
      assert.equal(outcome.kind, 'pair-approval-required')
      if (outcome.kind !== 'pair-approval-required') return

      for (const scope of [
        { kind: 'view', workspaces: 'all', expiresAt: null },
        { kind: 'control', workspaces: ['ws-a'], expiresAt: null },
      ] as const) {
        await assert.rejects(
          () => fixture.broker.approvePairing(outcome.requestId, scope),
          (error: unknown) => error instanceof PairingError && error.code === 'mesh/unsupported',
        )
        assert.equal(
          fixture.store.findPeer('controllers', controller.deviceId),
          undefined,
          'a rejected scope must not persist a controller record',
        )
      }
      // The request is still pending and a full grant can still approve it.
      assert.equal(fixture.broker.state().pendingPairings.length, 1)
      const approved = await fixture.broker.approvePairing(outcome.requestId)
      assert.equal(approved.approved, true)
      assert.equal(
        fixture.store.findPeer('controllers', controller.deviceId)?.scope.kind,
        'control',
      )
    } finally {
      await fixture.cleanup()
    }
  })

  it('refuses to re-pair a revoked controller until it is forgotten', async () => {
    const fixture = await makeBroker()
    try {
      const created = await fixture.broker.createPairingTicket()
      const controller = generateDeviceIdentity({ name: 'Phone' })
      await fixture.store.upsertPeer('controllers', {
        ...controllerRecord(controller, { kind: 'control', workspaces: 'all', expiresAt: null }),
        revokedAt: '2026-01-02T00:00:00.000Z',
      })

      await assert.rejects(
        () => fixture.broker.beginPairToken(
          controller,
          created.ticket.tok,
          new Uint8Array(32).fill(3),
          '333-444',
        ),
        (error: unknown) => error instanceof PairingError && error.code === 'mesh/revoked',
      )
      // The rejection happens before the one-time token is claimed.
      assert.equal(fixture.store.findPeer('controllers', controller.deviceId)?.revokedAt !== null, true)

      assert.equal((await fixture.broker.forgetPeer(controller.deviceId)).forgot, true)
      const outcome = await fixture.broker.beginPairToken(
        controller,
        created.ticket.tok,
        new Uint8Array(32).fill(3),
        '333-444',
      )
      assert.equal(outcome.kind, 'pair-approval-required')
    } finally {
      await fixture.cleanup()
    }
  })
})

describe('broker: inbound sessions', () => {
  it('exposes the pending SAS in the connecting controller-side view', async () => {
    const fixture = await makeBroker({
      sessionSas: '123-456',
      sessionPairing: { approval: 'pending' },
    })
    try {
      const daemonSide = generateDeviceIdentity({ name: 'Remote daemon' })
      const ticket = createPairingTicket({
        identity: daemonSide,
        endpoints: [{ k: 'direct', url: 'ws://192.0.2.1:45871/mesh' }],
        token: Buffer.alloc(32, 5).toString('base64url'),
        now: Date.now(),
      })
      const view = await fixture.broker.pairWithLink(ticket.link)
      assert.equal(view.status, 'connecting')
      await waitFor(() => fixture.broker.state().devices
        .find(device => device.deviceId === daemonSide.deviceId)?.sas === '123-456')
      const connecting = fixture.broker.state().devices.find(device => device.deviceId === daemonSide.deviceId)
      assert.equal(connecting?.status, 'connecting')
      assert.equal(connecting?.sas, '123-456')
    } finally {
      await fixture.cleanup()
    }
  })

  it('does not prune a first-contact pairing session that is still pending', async () => {
    const fixture = await makeBroker()
    try {
      const session = new FakeMeshSession({ pairing: { approval: 'pending' } })
      fixture.broker.noteInboundOpened('dm_pendingcontroller00001', session)
      prune(fixture.broker)
      assert.equal(session.open, true, 'a pending first pairing must survive the grant sweep')
    } finally {
      await fixture.cleanup()
    }
  })

  it('prunes a pending session once its controller is revoked', async () => {
    const fixture = await makeBroker()
    try {
      const controller = generateDeviceIdentity({ name: 'Phone' })
      await fixture.store.upsertPeer('controllers', {
        ...controllerRecord(controller, { kind: 'control', workspaces: 'all', expiresAt: null }),
        revokedAt: '2026-01-02T00:00:00.000Z',
      })
      const session = new FakeMeshSession({
        remote: controller,
        pairing: { approval: 'pending' },
      })
      fixture.broker.noteInboundOpened(controller.deviceId, session)
      prune(fixture.broker)
      assert.equal(session.open, false, 'revocation outranks a stale pending pairing state')
    } finally {
      await fixture.cleanup()
    }
  })

  it('prunes inbound sessions whose grant expired', async () => {
    const fixture = await makeBroker()
    try {
      const controller = generateDeviceIdentity({ name: 'Phone' })
      await fixture.store.upsertPeer('controllers', controllerRecord(controller, {
        kind: 'control',
        workspaces: 'all',
        expiresAt: Math.floor(Date.now() / 1000) - 60,
      }))
      const session = new FakeMeshSession({ remote: controller })
      fixture.broker.noteInboundOpened(controller.deviceId, session)
      prune(fixture.broker)
      assert.equal(session.open, false, 'an expired grant must close the established session')
    } finally {
      await fixture.cleanup()
    }
  })

  it('caps inbound sessions globally and per controller', async () => {
    const fixture = await makeBroker()
    try {
      assert.equal(fixture.broker.canAcceptInbound(), true)
      const controllerIds = Array.from(
        { length: Math.ceil(MAX_INBOUND_SESSIONS / MAX_INBOUND_SESSIONS_PER_CONTROLLER) },
        (_, index) => `dm_capcontroller${String(index).padStart(4, '0')}`,
      )
      for (const controllerId of controllerIds) {
        for (let index = 0; index < MAX_INBOUND_SESSIONS_PER_CONTROLLER; index += 1) {
          const session = new FakeMeshSession()
          fixture.broker.noteInboundOpened(controllerId, session)
          assert.equal(session.open, true, 'sessions below both caps are admitted')
        }
      }
      assert.equal(fixture.broker.canAcceptInbound(), false)

      const perController = new FakeMeshSession()
      fixture.broker.noteInboundOpened(controllerIds[0] as string, perController)
      assert.equal(perController.open, false, 'the per-controller cap closes the extra session')

      const total = new FakeMeshSession()
      fixture.broker.noteInboundOpened('dm_newcontroller000001', total)
      assert.equal(total.open, false, 'the global cap closes the extra session')
    } finally {
      await fixture.cleanup()
    }
  })

  it('closes inbound sessions when the controller is forgotten', async () => {
    const fixture = await makeBroker()
    try {
      const controller = generateDeviceIdentity({ name: 'Phone' })
      await fixture.store.upsertPeer('controllers', controllerRecord(controller, {
        kind: 'control',
        workspaces: 'all',
        expiresAt: null,
      }))
      const session = new FakeMeshSession({ remote: controller })
      fixture.broker.noteInboundOpened(controller.deviceId, session)
      assert.equal((await fixture.broker.forgetPeer(controller.deviceId)).forgot, true)
      assert.equal(session.open, false, 'forgetting a controller must close its inbound sessions')
    } finally {
      await fixture.cleanup()
    }
  })
})

describe('broker: pairing approval correctness (H2)', () => {
  it('does not approve when persisting the controller fails', async () => {
    const fixture = await makeBroker()
    try {
      const pending = await beginPendingRequest(fixture)
      const upsert = fixture.store.upsertPeer.bind(fixture.store)
      ;(fixture.store as unknown as { upsertPeer: typeof upsert }).upsertPeer = async () => {
        throw new Error('simulated disk failure')
      }
      try {
        await assert.rejects(
          () => fixture.broker.approvePairing(pending.requestId),
          /simulated disk failure/u,
        )
      } finally {
        ;(fixture.store as unknown as { upsertPeer: typeof upsert }).upsertPeer = upsert
      }
      assert.equal(fixture.store.findPeer('controllers', pending.controller.deviceId), undefined)
      assert.equal(fixture.pairing.getStatus(pending.requestId).state, 'pending')
      // The request was never approved, so it is still visible and deniable.
      assert.equal(fixture.broker.state().pendingPairings.length, 1)
      fixture.broker.denyPairing(pending.requestId)
    } finally {
      await fixture.cleanup()
    }
  })

  it('rolls the controller record back when a concurrent deny wins the race', async () => {
    const fixture = await makeBroker()
    try {
      const pending = await beginPendingRequest(fixture)
      const upsert = fixture.store.upsertPeer.bind(fixture.store)
      let denied = false
      ;(fixture.store as unknown as { upsertPeer: typeof upsert }).upsertPeer = async (kind, record) => {
        const result = await upsert(kind, record)
        if (!denied) {
          denied = true
          fixture.broker.denyPairing(pending.requestId)
        }
        return result
      }
      try {
        await assert.rejects(
          () => fixture.broker.approvePairing(pending.requestId),
          (error: unknown) => (error as { code?: string }).code === 'mesh/unauthorized',
        )
      } finally {
        ;(fixture.store as unknown as { upsertPeer: typeof upsert }).upsertPeer = upsert
      }
      assert.equal(denied, true)
      assert.equal(
        fixture.store.findPeer('controllers', pending.controller.deviceId),
        undefined,
        'an unapproved controller must not remain persisted',
      )
      assert.equal(fixture.broker.state().pendingPairings.length, 0)
      assert.deepEqual(await pending.decide, { approved: false })
    } finally {
      await fixture.cleanup()
    }
  })

  it('rolls back when the request timed out during persistence', async () => {
    const fixture = await makeBroker({ requestTtlMs: 100 })
    try {
      const pending = await beginPendingRequest(fixture)
      const upsert = fixture.store.upsertPeer.bind(fixture.store)
      ;(fixture.store as unknown as { upsertPeer: typeof upsert }).upsertPeer = async (kind, record) => {
        await new Promise(resolve => setTimeout(resolve, 200))
        return upsert(kind, record)
      }
      try {
        await assert.rejects(
          () => fixture.broker.approvePairing(pending.requestId),
          (error: unknown) => (error as { code?: string }).code === 'mesh/unauthorized',
        )
      } finally {
        ;(fixture.store as unknown as { upsertPeer: typeof upsert }).upsertPeer = upsert
      }
      assert.equal(fixture.store.findPeer('controllers', pending.controller.deviceId), undefined)
      assert.equal(fixture.pairing.getStatus(pending.requestId).state, 'denied')
      assert.deepEqual(await pending.decide, { approved: false })
    } finally {
      await fixture.cleanup()
    }
  })

  it('allows only one of two concurrent approvals and keeps the peer', async () => {
    const fixture = await makeBroker()
    try {
      const pending = await beginPendingRequest(fixture)
      const [first, second] = await Promise.allSettled([
        fixture.broker.approvePairing(pending.requestId),
        fixture.broker.approvePairing(pending.requestId),
      ])
      assert.equal(first.status, 'fulfilled')
      assert.equal(second.status, 'rejected')
      if (second.status === 'rejected') {
        assert.equal((second.reason as { code?: string }).code, 'mesh/unauthorized')
      }
      assert.ok(fixture.store.findPeer('controllers', pending.controller.deviceId))
      assert.deepEqual(await pending.decide, { approved: true })
    } finally {
      await fixture.cleanup()
    }
  })
})

describe('broker: first-contact terminal states (H3)', () => {
  it('cleans up the pinned peer and stops reconnecting when pairing is denied', async () => {
    const fixture = await makeBroker({
      sessionPairing: { approval: 'pending', requestId: 'req-denied' },
      rpc: method => (method === 'pair.status' ? { state: 'denied' } : { protocol: 1 }),
    })
    try {
      const daemonSide = generateDeviceIdentity({ name: 'Remote daemon' })
      const ticket = createPairingTicket({
        identity: daemonSide,
        endpoints: [{ k: 'direct', url: 'ws://192.0.2.1:45871/mesh' }],
        token: Buffer.alloc(32, 5).toString('base64url'),
        now: Date.now(),
      })
      const view = await fixture.broker.pairWithLink(ticket.link)
      assert.equal(view.status, 'connecting')
      await waitFor(() => fixture.store.findPeer('daemons', daemonSide.deviceId) === undefined)
      await waitFor(() => fixture.connected[0]?.open === false)
      assert.equal(
        fixture.broker.state().devices.some(device => device.deviceId === daemonSide.deviceId),
        false,
        'denied first contact must not remain visible as connecting',
      )
      // No automatic reconnect after the terminal failure (min backoff is 1 s).
      await new Promise(resolve => setTimeout(resolve, 1_200))
      assert.equal(fixture.connected.length, 1, 'a denied pairing must not dial again')
      const audit = await fixture.broker.listAudit(50)
      assert.ok(audit.some(entry => entry.action === 'session.closed' && entry.detail === 'pairing-denied'))
    } finally {
      await fixture.cleanup()
    }
  })

  it('cleans up and stays terminal when approval times out', async () => {
    const fixture = await makeBroker({
      pairingApprovalTimeoutMs: 25,
      sessionPairing: { approval: 'pending', requestId: 'req-timeout' },
      rpc: method => (method === 'pair.status' ? { state: 'pending' } : { protocol: 1 }),
    })
    try {
      const daemonSide = generateDeviceIdentity({ name: 'Remote daemon' })
      const ticket = createPairingTicket({
        identity: daemonSide,
        endpoints: [{ k: 'direct', url: 'ws://192.0.2.1:45871/mesh' }],
        token: Buffer.alloc(32, 6).toString('base64url'),
        now: Date.now(),
      })
      await fixture.broker.pairWithLink(ticket.link)
      await waitFor(() => fixture.connected[0]?.open === false, 3_000)
      await waitFor(() => fixture.store.findPeer('daemons', daemonSide.deviceId) === undefined)
      assert.equal(
        fixture.broker.state().devices.some(device => device.deviceId === daemonSide.deviceId),
        false,
      )
      await new Promise(resolve => setTimeout(resolve, 1_200))
      assert.equal(fixture.connected.length, 1, 'a timed-out pairing must not dial again')
      const audit = await fixture.broker.listAudit(50)
      assert.ok(audit.some(entry => entry.action === 'session.closed' && entry.detail === 'pairing-timeout'))
    } finally {
      await fixture.cleanup()
    }
  })
})

describe('broker: connection generations (H4/H5)', () => {
  it('single-flights concurrent connectDevice calls', async () => {
    const gate = deferred()
    let connectorCalls = 0
    const fixture = await makeBroker({
      connectDelay: async () => {
        connectorCalls += 1
        await gate.promise
      },
    })
    try {
      const daemonIdentity = generateDeviceIdentity({ name: 'Remote' })
      await fixture.store.upsertPeer('daemons', daemonRecord(daemonIdentity, [
        { k: 'direct', url: 'ws://192.0.2.9:45871/mesh' },
      ]))
      const first = fixture.broker.connectDevice(daemonIdentity.deviceId)
      const second = fixture.broker.connectDevice(daemonIdentity.deviceId)
      await waitFor(() => connectorCalls === 1)
      gate.resolve()
      const [firstView, secondView] = await Promise.all([first, second])
      assert.equal(connectorCalls, 1, 'duplicate connects must share one attempt')
      assert.equal(fixture.connected.length, 1)
      assert.equal(firstView.status, 'online')
      assert.equal(secondView.status, 'online')
    } finally {
      await fixture.cleanup()
    }
  })

  it('supersedes an in-flight pairWithLink and closes its late session', async () => {
    const firstGate = deferred()
    const secondGate = deferred()
    let connectorCalls = 0
    const fixture = await makeBroker({
      connectDelay: async () => {
        connectorCalls += 1
        await (connectorCalls === 1 ? firstGate.promise : secondGate.promise)
      },
    })
    try {
      const daemonSide = generateDeviceIdentity({ name: 'Remote daemon' })
      const ticket = createPairingTicket({
        identity: daemonSide,
        endpoints: [{ k: 'direct', url: 'ws://192.0.2.1:45871/mesh' }],
        token: Buffer.alloc(32, 7).toString('base64url'),
        now: Date.now(),
      })
      await fixture.broker.pairWithLink(ticket.link)
      await waitFor(() => connectorCalls === 1)
      await fixture.broker.pairWithLink(ticket.link)
      await waitFor(() => connectorCalls === 2)
      firstGate.resolve()
      secondGate.resolve()
      await waitFor(() => fixture.broker.state().devices
        .find(device => device.deviceId === daemonSide.deviceId)?.status === 'online')
      assert.equal(fixture.connected.length, 2)
      assert.equal(fixture.connected[0]?.open, false, 'the superseded session must be closed')
      assert.equal(fixture.connected[1]?.open, true, 'only the current generation stays live')
    } finally {
      await fixture.cleanup()
    }
  })

  it('closes the previous session when a newer one is adopted', async () => {
    const fixture = await makeBroker()
    try {
      const daemonIdentity = generateDeviceIdentity({ name: 'Remote' })
      await fixture.store.upsertPeer('daemons', daemonRecord(daemonIdentity, [
        { k: 'direct', url: 'ws://192.0.2.9:45871/mesh' },
      ]))
      await fixture.broker.connectDevice(daemonIdentity.deviceId)
      assert.equal(fixture.connected.length, 1)
      const ticket = createPairingTicket({
        identity: daemonIdentity,
        endpoints: [{ k: 'direct', url: 'ws://192.0.2.9:45871/mesh' }],
        token: Buffer.alloc(32, 8).toString('base64url'),
        now: Date.now(),
      })
      await fixture.broker.pairWithLink(ticket.link)
      await waitFor(() => fixture.connected.length === 2)
      await waitFor(() => fixture.connected[1]?.open === true)
      assert.equal(fixture.connected[0]?.open, false, 'adopting a new session must close the old one')
    } finally {
      await fixture.cleanup()
    }
  })

  it('discards a handshake that completes after forgetPeer', async () => {
    const gate = deferred()
    let observedSignal: AbortSignal | undefined
    let connectorCalls = 0
    const fixture = await makeBroker({
      connectDelay: async (connectOptions) => {
        connectorCalls += 1
        observedSignal = connectOptions.signal
        await gate.promise
      },
    })
    try {
      const daemonIdentity = generateDeviceIdentity({ name: 'Remote' })
      await fixture.store.upsertPeer('daemons', daemonRecord(daemonIdentity, [
        { k: 'direct', url: 'ws://192.0.2.9:45871/mesh' },
      ]))
      const connecting = fixture.broker.connectDevice(daemonIdentity.deviceId)
      await waitFor(() => connectorCalls === 1)
      assert.equal((await fixture.broker.forgetPeer(daemonIdentity.deviceId)).forgot, true)
      assert.equal(observedSignal?.aborted, true, 'forget must abort the in-flight dial')
      gate.resolve()
      await connecting.catch(() => undefined)
      await waitFor(() => fixture.connected.length === 1)
      assert.equal(fixture.connected[0]?.open, false, 'a late handshake must not stay connected')
      assert.equal(fixture.store.findPeer('daemons', daemonIdentity.deviceId), undefined)
      assert.equal(
        fixture.broker.state().devices.some(device => device.deviceId === daemonIdentity.deviceId),
        false,
      )
    } finally {
      await fixture.cleanup()
    }
  })

  it('keeps the device offline when a handshake completes after disconnectDevice', async () => {
    const gate = deferred()
    let connectorCalls = 0
    const fixture = await makeBroker({
      connectDelay: async () => {
        connectorCalls += 1
        await gate.promise
      },
    })
    try {
      const daemonIdentity = generateDeviceIdentity({ name: 'Remote' })
      await fixture.store.upsertPeer('daemons', daemonRecord(daemonIdentity, [
        { k: 'direct', url: 'ws://192.0.2.9:45871/mesh' },
      ]))
      const connecting = fixture.broker.connectDevice(daemonIdentity.deviceId)
      await waitFor(() => connectorCalls === 1)
      const disconnected = await fixture.broker.disconnectDevice(daemonIdentity.deviceId)
      assert.equal(disconnected.status, 'offline')
      gate.resolve()
      await connecting.catch(() => undefined)
      await new Promise(resolve => setTimeout(resolve, 100))
      assert.equal(fixture.connected[0]?.open, false, 'disconnect must win against the late handshake')
      const view = fixture.broker.state().devices.find(device => device.deviceId === daemonIdentity.deviceId)
      assert.equal(view?.status, 'offline')
    } finally {
      await fixture.cleanup()
    }
  })

  it('keeps a revoked device closed when a handshake completes after revokePeer', async () => {
    const gate = deferred()
    let connectorCalls = 0
    const fixture = await makeBroker({
      connectDelay: async () => {
        connectorCalls += 1
        await gate.promise
      },
    })
    try {
      const daemonIdentity = generateDeviceIdentity({ name: 'Remote' })
      await fixture.store.upsertPeer('daemons', daemonRecord(daemonIdentity, [
        { k: 'direct', url: 'ws://192.0.2.9:45871/mesh' },
      ]))
      const connecting = fixture.broker.connectDevice(daemonIdentity.deviceId)
      await waitFor(() => connectorCalls === 1)
      const revoked = await fixture.broker.revokePeer(daemonIdentity.deviceId)
      assert.equal(revoked.status, 'revoked')
      gate.resolve()
      await connecting.catch(() => undefined)
      await waitFor(() => fixture.connected.length === 1)
      assert.equal(fixture.connected[0]?.open, false)
      const view = fixture.broker.state().devices.find(device => device.deviceId === daemonIdentity.deviceId)
      assert.equal(view?.status, 'revoked')
    } finally {
      await fixture.cleanup()
    }
  })
})

describe('broker: revoke/forget cancel pending pairing (M8)', () => {
  it('cancels a pending request on revoke so it can no longer be approved', async () => {
    const fixture = await makeBroker()
    try {
      const controller = generateDeviceIdentity({ name: 'Phone' })
      await fixture.store.upsertPeer('controllers', controllerRecord(controller, {
        kind: 'control',
        workspaces: 'all',
        expiresAt: null,
      }))
      const created = await fixture.broker.createPairingTicket()
      const outcome = await fixture.broker.beginPairToken(
        controller,
        created.ticket.tok,
        new Uint8Array(32).fill(9),
        '999-000',
      )
      assert.equal(outcome.kind, 'pair-approval-required')
      if (outcome.kind !== 'pair-approval-required') return
      assert.equal(fixture.broker.state().pendingPairings.length, 1)

      await fixture.broker.revokePeer(controller.deviceId)

      assert.equal(fixture.broker.state().pendingPairings.length, 0)
      await assert.rejects(
        () => fixture.broker.approvePairing(outcome.requestId),
        (error: unknown) => {
          const code = (error as { code?: string }).code
          return code === 'mesh/unauthorized' || code === 'mesh/not-found'
        },
      )
      assert.notEqual(fixture.store.findPeer('controllers', controller.deviceId)?.revokedAt, null)
      assert.deepEqual(await outcome.decide, { approved: false })
    } finally {
      await fixture.cleanup()
    }
  })

  it('cancels a pending request on forget so it cannot recreate the peer', async () => {
    const fixture = await makeBroker()
    try {
      const controller = generateDeviceIdentity({ name: 'Phone' })
      await fixture.store.upsertPeer('controllers', controllerRecord(controller, {
        kind: 'control',
        workspaces: 'all',
        expiresAt: null,
      }))
      const created = await fixture.broker.createPairingTicket()
      const outcome = await fixture.broker.beginPairToken(
        controller,
        created.ticket.tok,
        new Uint8Array(32).fill(10),
        '888-111',
      )
      assert.equal(outcome.kind, 'pair-approval-required')
      if (outcome.kind !== 'pair-approval-required') return

      assert.equal((await fixture.broker.forgetPeer(controller.deviceId)).forgot, true)
      assert.equal(fixture.broker.state().pendingPairings.length, 0)
      await assert.rejects(
        () => fixture.broker.approvePairing(outcome.requestId),
        (error: unknown) => {
          const code = (error as { code?: string }).code
          return code === 'mesh/unauthorized' || code === 'mesh/not-found'
        },
      )
      assert.equal(fixture.store.findPeer('controllers', controller.deviceId), undefined)
      assert.deepEqual(await outcome.decide, { approved: false })
    } finally {
      await fixture.cleanup()
    }
  })
})

/** Invoke the broker's private 30 s sweep directly (timers are not faked here). */
function prune(broker: DeviceMeshBroker): void {
  ;(broker as unknown as { pruneInboundSessions(): void }).pruneInboundSessions()
}
