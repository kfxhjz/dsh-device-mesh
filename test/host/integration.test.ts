import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { MeshSession, DaemonAuthOutcome } from '../../src/shared/mesh-session.ts'
import type { DeviceDescriptor } from '../../src/shared/protocol.ts'
import { acceptMeshChannel, connectMeshChannel } from '../../src/host/channel.ts'
import { deviceDescriptorOf } from '../../src/host/crypto.ts'
import { DeviceMeshBroker } from '../../src/host/broker.ts'
import { PairingService } from '../../src/host/pairing.ts'
import { PortalDaemon } from '../../src/host/portal-daemon.ts'
import { PortalController } from '../../src/host/portal-controller.ts'
import { MeshStore } from '../../src/host/store.ts'
import { WorkspaceProvider } from '../../src/host/workspaces.ts'
import { makeTempDir, pairedTransports } from './helpers.ts'

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for a condition')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

interface Side {
  readonly store: MeshStore
  readonly pairing: PairingService
  readonly portalDaemon: PortalDaemon
  readonly broker: DeviceMeshBroker
  readonly stop: () => Promise<void>
}

async function makeSide(options: {
  readonly origin?: string
  readonly fetchImpl?: typeof fetch
  readonly getService?: (name: string) => unknown
} = {}): Promise<Side> {
  const temp = await makeTempDir()
  const store = await MeshStore.open({ home: temp.dir })
  const pairing = new PairingService({ identity: store.getIdentity(), store })
  await pairing.init()
  const workspaces = new WorkspaceProvider({ getService: () => undefined })
  const portalDaemon = new PortalDaemon({
    ...(options.origin !== undefined ? { origin: options.origin } : {}),
    getService: options.getService ?? (() => undefined),
    ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}),
  })
  const broker = new DeviceMeshBroker({
    store,
    pairing,
    workspaces,
    portalDaemon,
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    appVersion: 'it-test',
    offline: true,
  })
  await broker.start()
  return {
    store,
    pairing,
    portalDaemon,
    broker,
    stop: async () => {
      await broker.stop()
      await store.close()
      await temp.cleanup()
    },
  }
}

function fakeDshFetch(): typeof fetch {
  return (async (input: string | URL | Request) => {
    const text = typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.href
        : input.url
    const url = new URL(text)
    if (url.searchParams.has('token')) {
      return new Response(null, {
        status: 303,
        headers: { 'set-cookie': 'dsh-auth-it=portal-cookie; Max-Age=3600; Path=/; HttpOnly' },
      })
    }
    return new Response('<html>remote dsh ui</html>', {
      status: 200,
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'x-frame-options': 'DENY',
        'content-security-policy': "default-src 'self'; frame-ancestors 'none'",
        'set-cookie': 'should-not-leak=1',
      },
    })
  })
}

describe('host integration: two devices over a real Mesh channel', () => {
  it('pairs, authenticates, runs RPCs and proxies the remote DSH page through a portal', async () => {
    // B = controller, A = daemon. Both run the real channel + session layer.
    const controllerSide = await makeSide()
    const daemonSide = await makeSide({
      origin: 'http://127.0.0.1:3080',
      fetchImpl: fakeDshFetch(),
      getService: name => (name === 'connection'
        ? { authenticatedUrl: (base: string) => `${base}/?token=launch-token` }
        : undefined),
    })
    let controllerSession: MeshSession | undefined
    let daemonSession: MeshSession | undefined
    let portal: PortalController | undefined
    try {
      const pairTicket = await daemonSide.pairing.createTicket([{
        k: 'direct',
        url: 'ws://in-memory.test/mesh',
      }])
      const daemonDescriptor: DeviceDescriptor = deviceDescriptorOf(daemonSide.store.getIdentity())
      const controllerDescriptor: DeviceDescriptor = deviceDescriptorOf(controllerSide.store.getIdentity())

      const [daemonTransport, controllerTransport] = pairedTransports()
      const authenticated: { deviceId: string | undefined } = { deviceId: undefined }
      const handlers = daemonSide.broker.createDaemonHandlers(() => authenticated.deviceId)

      const daemonPromise = acceptMeshChannel({
        transport: daemonTransport,
        identity: daemonSide.store.getIdentity(),
        appVersion: 'it-test',
        capabilities: ['rpc', 'portal', 'workspaces', 'pairing', 'relay'],
        hostLabel: 'daemon',
        handlers,
        authenticate: async (context): Promise<DaemonAuthOutcome> => {
          authenticated.deviceId = context.client.controller.deviceId
          const auth = context.client.auth
          if (auth.kind === 'paired') {
            const peer = daemonSide.broker.lookupPairedController(context.client.controller.deviceId)
            if (peer === undefined) throw new Error('unknown controller')
            return { kind: 'paired', peer }
          }
          return daemonSide.broker.beginPairToken(
            context.client.controller,
            auth.token,
            context.handshakeHash,
            context.sas,
          )
        },
      })
      const controllerPromise = connectMeshChannel({
        transport: controllerTransport,
        identity: controllerSide.store.getIdentity(),
        daemon: daemonDescriptor,
        auth: {
          kind: 'pair-token',
          daemonId: daemonDescriptor.deviceId,
          token: pairTicket.ticket.tok,
        },
        appVersion: 'it-test',
        capabilities: ['rpc', 'portal', 'workspaces', 'pairing', 'relay'],
        hostLabel: 'controller',
      })
      const [acceptedDaemon, connected] = await Promise.all([daemonPromise, controllerPromise])
      daemonSession = acceptedDaemon
      controllerSession = connected
      assert.equal(connected.pairing?.approval, 'pending')
      assert.equal(typeof connected.sas, 'string')

      const pending = daemonSide.broker.state().pendingPairings
      assert.equal(pending.length, 1)
      assert.equal(pending[0]?.peer.deviceId, controllerDescriptor.deviceId)
      assert.equal(pending[0]?.sas, connected.sas)
      daemonSide.broker.approvePairing(pending[0]?.requestId ?? '')
      await waitFor(() => daemonSide.store.findPeer('controllers', controllerDescriptor.deviceId) !== undefined)

      const requestId = connected.pairing?.requestId ?? ''
      let status = await connected.rpc<{ state: string }>('pair.status', { requestId })
      for (let attempt = 0; attempt < 50 && status.state !== 'approved'; attempt += 1) {
        await new Promise(resolve => setTimeout(resolve, 10))
        status = await connected.rpc<{ state: string }>('pair.status', { requestId })
      }
      assert.equal(status.state, 'approved')

      // The daemon flips its authorization gate a microtask after the decision.
      let info: { device: { deviceId: string }; protocol: number } | undefined
      for (let attempt = 0; attempt < 40; attempt += 1) {
        try {
          info = await connected.rpc<{ device: { deviceId: string }; protocol: number }>('info')
          break
        } catch (error) {
          if ((error as { code?: string }).code !== 'mesh/unauthorized') throw error
          await new Promise(resolve => setTimeout(resolve, 10))
        }
      }
      assert.ok(info)
      assert.equal(info.protocol, 1)
      assert.equal(info.device.deviceId, daemonDescriptor.deviceId)

      const workspaces = await connected.rpc<{ workspaces: unknown[] }>('workspaces.list', { refresh: true })
      assert.deepEqual(workspaces.workspaces, [])

      // Full portal path: browser → controller local proxy → Mesh HTTP stream →
      // daemon proxy → (fake) local DSH Web server.
      portal = await PortalController.open({
        session: connected,
        deviceId: daemonDescriptor.deviceId,
        token: 'integration-token',
        idleTimeoutMs: 60_000,
      })
      const first = await fetch(portal.url, { redirect: 'manual' })
      assert.equal(first.status, 303)
      const cookie = first.headers.getSetCookie()[0]?.split(';')[0] ?? ''
      assert.ok(cookie.length > 0)
      const page = await fetch(`${portal.origin}/`, { headers: { cookie, 'sec-fetch-site': 'same-origin' } })
      assert.equal(page.status, 200)
      assert.equal(await page.text(), '<html>remote dsh ui</html>')
      assert.equal(page.headers.get('x-frame-options'), null)
      assert.equal(page.headers.get('content-security-policy'), "default-src 'self'")
      assert.equal(page.headers.get('set-cookie'), null)

      // Revocation is enforced on the next daemon RPC.
      await daemonSide.broker.revokePeer(controllerDescriptor.deviceId)
      await assert.rejects(
        () => connected.rpc('workspaces.list', {}),
        (error: unknown) => (error as { code?: string }).code === 'mesh/revoked'
          || (error as { code?: string }).code === 'mesh/unauthorized',
      )
    } finally {
      await portal?.close().catch(() => {})
      controllerSession?.close()
      daemonSession?.close()
      await controllerSide.stop()
      await daemonSide.stop()
    }
  })
})
