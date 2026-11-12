import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type {
  AuditEntry,
  MeshDeviceView,
  MeshHostState,
  PairingScope,
  WorkspacesResult,
} from '../../src/shared/protocol.ts'
import { MeshRpcError } from '../../src/shared/mesh-session.ts'
import { createWebApi, dispatchLocalApi, renderQrSvg } from '../../src/host/web-api.ts'
import type { WebApiBroker } from '../../src/host/web-api.ts'

const STATE: MeshHostState = {
  self: {
    deviceId: 'dm_self00000000000000001',
    name: 'Self',
    platform: 'darwin',
    signPk: 'pk',
    dhPk: 'dh',
    appVersion: '0.0.1',
  },
  protocol: 1,
  direct: { enabled: true, port: 45871, urls: ['ws://127.0.0.1:45871/mesh'] },
  relay: { configured: false, endpoint: null, connected: false, useTls: true },
  devices: [],
  pendingPairings: [],
  portals: [],
}

const DEVICE: MeshDeviceView = {
  deviceId: 'dm_peer00000000000000001',
  name: 'Peer',
  platform: 'linux',
  direction: 'daemon',
  pairedAt: '2026-01-01T00:00:00.000Z',
  lastSeenAt: null,
  revoked: false,
  scope: { kind: 'control', workspaces: 'all', expiresAt: null },
  status: 'online',
}

const WORKSPACES: WorkspacesResult = {
  updatedAt: '2026-01-01T00:00:00.000Z',
  workspaces: [{ id: 'ws', title: 'W', path: '/w', sessions: [] }],
}

class FakeBroker implements WebApiBroker {
  readonly calls: Array<{ readonly name: string; readonly args: unknown[] }> = []
  throwOn: { readonly name: string; readonly error: unknown } | undefined

  private record(name: string, ...args: unknown[]): void {
    this.calls.push({ name, args })
    if (this.throwOn?.name === name) throw this.throwOn.error
  }

  state(): MeshHostState {
    this.record('state')
    return STATE
  }

  async createPairingTicket(): Promise<{ readonly link: string; readonly expiresAt: string }> {
    this.record('createPairingTicket')
    return { link: 'dsh-mesh://pair?d=abc', expiresAt: '2026-01-01T00:10:00.000Z' }
  }

  async pairWithLink(link: string): Promise<MeshDeviceView> {
    this.record('pairWithLink', link)
    return DEVICE
  }

  approvePairing(requestId: string, scope?: PairingScope): { readonly requestId: string; readonly approved: boolean } {
    this.record('approvePairing', requestId, scope)
    return { requestId, approved: true }
  }

  denyPairing(requestId: string): { readonly requestId: string; readonly approved: boolean } {
    this.record('denyPairing', requestId)
    return { requestId, approved: false }
  }

  async forgetPeer(deviceId: string): Promise<{ readonly forgot: boolean }> {
    this.record('forgetPeer', deviceId)
    return { forgot: true }
  }

  async revokePeer(deviceId: string): Promise<MeshDeviceView> {
    this.record('revokePeer', deviceId)
    return { ...DEVICE, revoked: true, status: 'revoked' }
  }

  async renamePeer(deviceId: string, name: string): Promise<{ readonly renamed: boolean }> {
    this.record('renamePeer', deviceId, name)
    return { renamed: true }
  }

  async connectDevice(deviceId: string): Promise<MeshDeviceView> {
    this.record('connectDevice', deviceId)
    return DEVICE
  }

  async disconnectDevice(deviceId: string): Promise<MeshDeviceView> {
    this.record('disconnectDevice', deviceId)
    return { ...DEVICE, status: 'offline' }
  }

  async refreshWorkspaces(deviceId?: string): Promise<WorkspacesResult> {
    this.record('refreshWorkspaces', deviceId)
    return WORKSPACES
  }

  async openPortal(deviceId: string): Promise<{ readonly url: string }> {
    this.record('openPortal', deviceId)
    return { url: 'http://127.0.0.1:40000/?token=x' }
  }

  async closePortal(deviceId: string): Promise<{ readonly closed: boolean }> {
    this.record('closePortal', deviceId)
    return { closed: true }
  }

  async configureDirect(patch: { readonly enabled?: boolean; readonly port?: number }): Promise<MeshHostState['direct']> {
    this.record('configureDirect', patch)
    return { enabled: patch.enabled ?? true, port: patch.port ?? 45871, urls: [] }
  }

  async configureRelay(patch: {
    readonly endpoint?: string | null
    readonly enabled?: boolean
    readonly useTls?: boolean
  }): Promise<MeshHostState['relay']> {
    this.record('configureRelay', patch)
    return { configured: patch.endpoint != null, endpoint: patch.endpoint ?? null, connected: false, useTls: patch.useTls !== false }
  }

  async listAudit(limit?: number): Promise<AuditEntry[]> {
    this.record('listAudit', limit)
    return []
  }

  diagnostics(): Record<string, unknown> {
    this.record('diagnostics')
    return { ok: true }
  }
}

describe('web-api: endpoints', () => {
  it('answers state with the MeshHostState shape', async () => {
    const broker = new FakeBroker()
    const result = await dispatchLocalApi(broker, { endpoint: 'state' })
    assert.equal(result.ok, true)
    if (result.ok) assert.deepEqual(result.value, STATE)
  })

  it('renders a pairing ticket with a QR svg', async () => {
    const broker = new FakeBroker()
    const result = await dispatchLocalApi(broker, { endpoint: 'pair.ticket' })
    assert.equal(result.ok, true)
    if (result.ok) {
      const view = result.value as { link: string; expiresAt: string; qrSvg: string }
      assert.equal(view.link, 'dsh-mesh://pair?d=abc')
      assert.match(view.qrSvg, /<svg/u)
    }
  })

  it('returns {deviceId, device} from pair.complete', async () => {
    const broker = new FakeBroker()
    const result = await dispatchLocalApi(broker, {
      endpoint: 'pair.complete',
      payload: { link: 'dsh-mesh://pair?d=abc' },
    })
    assert.equal(result.ok, true)
    if (result.ok) {
      const value = result.value as { deviceId: string; device: MeshDeviceView }
      assert.equal(value.deviceId, DEVICE.deviceId)
      assert.equal(value.device.name, 'Peer')
    }
    assert.deepEqual(broker.calls[0], { name: 'pairWithLink', args: ['dsh-mesh://pair?d=abc'] })
  })

  it('routes every documented endpoint to the broker', async () => {
    const broker = new FakeBroker()
    const cases: Array<{ endpoint: string; payload?: unknown; name: string; args: unknown[] }> = [
      { endpoint: 'pair.approve', payload: { requestId: 'r1' }, name: 'approvePairing', args: ['r1', undefined] },
      { endpoint: 'pair.deny', payload: { requestId: 'r2' }, name: 'denyPairing', args: ['r2'] },
      { endpoint: 'pair.approve', payload: { requestId: 'r3', approved: false }, name: 'denyPairing', args: ['r3'] },
      { endpoint: 'pair.forget', payload: { deviceId: 'd1' }, name: 'forgetPeer', args: ['d1'] },
      { endpoint: 'peer.revoke', payload: { deviceId: 'd2' }, name: 'revokePeer', args: ['d2'] },
      { endpoint: 'peer.rename', payload: { deviceId: 'd3', name: 'New' }, name: 'renamePeer', args: ['d3', 'New'] },
      { endpoint: 'device.connect', payload: { deviceId: 'd4' }, name: 'connectDevice', args: ['d4'] },
      { endpoint: 'device.disconnect', payload: { deviceId: 'd5' }, name: 'disconnectDevice', args: ['d5'] },
      { endpoint: 'workspaces.refresh', payload: { deviceId: 'd6' }, name: 'refreshWorkspaces', args: ['d6'] },
      { endpoint: 'workspaces.refresh', payload: {}, name: 'refreshWorkspaces', args: [undefined] },
      { endpoint: 'portal.open', payload: { deviceId: 'd7' }, name: 'openPortal', args: ['d7'] },
      { endpoint: 'portal.close', payload: { deviceId: 'd8' }, name: 'closePortal', args: ['d8'] },
      { endpoint: 'audit.list', payload: { limit: 5 }, name: 'listAudit', args: [5] },
      { endpoint: 'diagnostics', name: 'diagnostics', args: [] },
    ]
    for (const entry of cases) {
      broker.calls.length = 0
      const result = await dispatchLocalApi(broker, { endpoint: entry.endpoint, payload: entry.payload })
      assert.equal(result.ok, true, `${entry.endpoint} should succeed`)
      assert.equal(broker.calls.length, 1)
      assert.equal(broker.calls[0]?.name, entry.name)
      const expectedArgs = entry.args.map(arg => arg === undefined ? undefined : arg)
      const actual = broker.calls[0]?.args.map(arg => arg === undefined ? undefined : arg)
      assert.deepEqual(actual, expectedArgs, `${entry.endpoint} args`)
    }
  })

  it('normalizes direct and relay configuration payloads', async () => {
    const broker = new FakeBroker()
    await dispatchLocalApi(broker, {
      endpoint: 'direct.configure',
      payload: { enabled: false, port: 5000 },
    })
    assert.deepEqual(broker.calls.at(-1)?.args, [{ enabled: false, port: 5000 }])

    await dispatchLocalApi(broker, {
      endpoint: 'relay.configure',
      payload: { endpoint: 'relay.example.com', enabled: true, useTls: true },
    })
    assert.deepEqual(broker.calls.at(-1)?.args, [{
      endpoint: 'wss://relay.example.com/ws',
      enabled: true,
      useTls: true,
    }])

    await dispatchLocalApi(broker, {
      endpoint: 'relay.configure',
      payload: { endpoint: null, enabled: false },
    })
    assert.deepEqual(broker.calls.at(-1)?.args, [{ endpoint: null, enabled: false }])
  })
})

describe('web-api: validation and errors', () => {
  it('rejects unknown endpoints and malformed envelopes', async () => {
    const broker = new FakeBroker()
    const unknown = await dispatchLocalApi(broker, { endpoint: 'nope' })
    assert.equal(unknown.ok, false)
    if (!unknown.ok) assert.equal(unknown.error.code, 'mesh/bad-request')

    const notObject = await dispatchLocalApi(broker, 'state')
    assert.equal(notObject.ok, false)

    const noEndpoint = await dispatchLocalApi(broker, {})
    assert.equal(noEndpoint.ok, false)
  })

  it('validates required payload fields', async () => {
    const broker = new FakeBroker()
    for (const endpoint of ['pair.complete', 'pair.approve', 'device.connect', 'portal.open', 'peer.revoke']) {
      const result = await dispatchLocalApi(broker, { endpoint, payload: {} })
      assert.equal(result.ok, false, `${endpoint} should require payload`)
      if (!result.ok) assert.equal(result.error.code, 'mesh/bad-request')
    }
    const badPort = await dispatchLocalApi(broker, {
      endpoint: 'direct.configure',
      payload: { port: 70000 },
    })
    assert.equal(badPort.ok, false)
  })

  it('rejects restricted pairing scopes before calling the broker', async () => {
    const broker = new FakeBroker()
    for (const scope of [
      { kind: 'view', workspaces: 'all', expiresAt: null },
      { kind: 'control', workspaces: ['ws-a'], expiresAt: null },
    ]) {
      const result = await dispatchLocalApi(broker, {
        endpoint: 'pair.approve',
        payload: { requestId: 'r1', scope },
      })
      assert.equal(result.ok, false)
      if (!result.ok) assert.equal(result.error.code, 'mesh/unsupported')
    }
    assert.equal(broker.calls.length, 0, 'a restricted scope must not reach the broker')
  })

  it('maps insecure relay endpoints to mesh/bad-request and keeps loopback ws', async () => {
    const broker = new FakeBroker()
    const insecure = await dispatchLocalApi(broker, {
      endpoint: 'relay.configure',
      payload: { endpoint: 'ws://relay.example.com/ws', enabled: true },
    })
    assert.equal(insecure.ok, false)
    if (!insecure.ok) assert.equal(insecure.error.code, 'mesh/bad-request')

    const loopback = await dispatchLocalApi(broker, {
      endpoint: 'relay.configure',
      payload: { endpoint: 'ws://127.0.0.1:45871/ws', enabled: true },
    })
    assert.equal(loopback.ok, true)
    assert.deepEqual(broker.calls.at(-1)?.args, [{
      endpoint: 'ws://127.0.0.1:45871/ws',
      enabled: true,
    }])

    const secure = await dispatchLocalApi(broker, {
      endpoint: 'relay.configure',
      payload: { endpoint: 'wss://relay.example.com/ws', enabled: true },
    })
    assert.equal(secure.ok, true)

    // Explicit opt-in (TLS switch off) is the only way a public plain ws URL
    // reaches the broker; the UI shows a warning for this state.
    const insecureOptIn = await dispatchLocalApi(broker, {
      endpoint: 'relay.configure',
      payload: { endpoint: 'ws://relay.example.com/ws', enabled: true, useTls: false },
    })
    assert.equal(insecureOptIn.ok, true)
    assert.deepEqual(broker.calls.at(-1)?.args, [{
      endpoint: 'ws://relay.example.com/ws',
      enabled: true,
      useTls: false,
    }])
  })

  it('opens only a live portal URL through the external opener', async () => {
    const portalUrl = 'http://127.0.0.1:5555/?token=abc'
    const broker = new FakeBroker()
    ;(broker as unknown as { state: () => MeshHostState }).state = () => ({
      ...STATE,
      portals: [{ deviceId: DEVICE.deviceId, url: portalUrl }],
    })
    const opened: string[] = []
    const result = await dispatchLocalApi(
      broker,
      { endpoint: 'portal.external', payload: { url: portalUrl } },
      { openExternal: async (url) => { opened.push(url); return true } },
    )
    assert.equal(result.ok, true)
    if (result.ok) assert.deepEqual(result.value, { opened: true })
    assert.deepEqual(opened, [portalUrl])

    const foreign = await dispatchLocalApi(
      broker,
      { endpoint: 'portal.external', payload: { url: 'http://127.0.0.1:5555/?token=other' } },
      { openExternal: async () => true },
    )
    assert.equal(foreign.ok, false)
    if (!foreign.ok) assert.equal(foreign.error.code, 'mesh/bad-request')

    const noOpener = await dispatchLocalApi(broker, { endpoint: 'portal.external', payload: { url: portalUrl } })
    assert.equal(noOpener.ok, true)
    if (noOpener.ok) assert.deepEqual(noOpener.value, { opened: false })
  })

  it('maps mesh and unknown errors into the envelope', async () => {
    const broker = new FakeBroker()
    broker.throwOn = { name: 'openPortal', error: new MeshRpcError('mesh/not-found', 'device is not connected') }
    const result = await dispatchLocalApi(broker, { endpoint: 'portal.open', payload: { deviceId: 'd' } })
    assert.equal(result.ok, false)
    if (!result.ok) {
      assert.equal(result.error.code, 'mesh/not-found')
      assert.equal(result.error.message, 'device is not connected')
    }

    broker.throwOn = { name: 'diagnostics', error: new Error('boom') }
    const generic = await dispatchLocalApi(broker, { endpoint: 'diagnostics' })
    assert.equal(generic.ok, false)
    if (!generic.ok) {
      assert.equal(generic.error.code, 'mesh/internal')
      assert.equal(generic.error.message, 'boom')
    }
  })
})

describe('web-api: HTTP handler', () => {
  const api = createWebApi({ broker: new FakeBroker(), renderQr: () => '<svg data-test="qr"/>' })

  it('answers POST JSON with the result envelope', async () => {
    const response = await api.handle(new Request('http://127.0.0.1/api/device-mesh', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ endpoint: 'state' }),
    }))
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('cache-control'), 'no-store')
    const body = await response.json() as { ok: boolean }
    assert.equal(body.ok, true)
  })

  it('rejects non-POST methods', async () => {
    const response = await api.handle(new Request('http://127.0.0.1/api/device-mesh'))
    assert.equal(response.status, 405)
    const body = await response.json() as { ok: boolean; error: { code: string } }
    assert.equal(body.ok, false)
    assert.equal(body.error.code, 'mesh/bad-request')
  })

  it('rejects invalid JSON without throwing', async () => {
    const response = await api.handle(new Request('http://127.0.0.1/api/device-mesh', {
      method: 'POST',
      body: '{not json',
    }))
    assert.equal(response.status, 200)
    const body = await response.json() as { ok: boolean; error: { code: string } }
    assert.equal(body.ok, false)
    assert.equal(body.error.code, 'mesh/bad-request')
  })

  it('exposes the DSH route path', () => {
    assert.equal(api.path, '/api/device-mesh')
    assert.equal(api.dispatch, api.dispatch)
  })

  it('renders a non-empty QR fallback in-process', () => {
    assert.match(renderQrSvg('dsh-mesh://pair?d=abc'), /<svg/u)
  })
})
