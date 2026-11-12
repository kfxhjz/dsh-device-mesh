/**
 * End-to-end pairing + remote-control test.
 *
 * Two isolated DSH homes, each running a stock `dsh web` with this plugin
 * installed. Device A shows a pairing ticket, device B consumes it, A approves
 * locally (SAS flow), then B lists A's workspaces and opens a portal that
 * proxies A's own DSH Web UI back through the encrypted mesh.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { createHomes, ensureBuilt, recordEvidence, startInstance, waitFor } from './helpers/dsh-instance.ts'
import type { DshInstance } from './helpers/dsh-instance.ts'

interface HostState {
  self: { deviceId: string; name: string; platform: string }
  direct: { enabled: boolean; port: number; urls: string[] }
  relay: { configured: boolean; endpoint: string | null; connected: boolean }
  devices: Array<{
    deviceId: string
    name: string
    status: string
    statusDetail?: string
    scope: unknown
    remoteWorkspaces?: Array<{ id: string; title: string; sessions: unknown[] }>
  }>
  pendingPairings: Array<{ requestId: string; peer: { deviceId: string; name: string }; sas: string }>
  portals: Array<{ deviceId: string; url: string }>
}

interface TicketView {
  link: string
  expiresAt: string
}

interface WorkspacesView {
  updatedAt: string
  workspaces: Array<{ id: string; title: string; path: string; sessions: unknown[] }>
}

test('pair two devices, list remote workspaces and open the remote portal', { timeout: 180_000 }, async (t) => {
  await ensureBuilt()
  const homeSet = await createHomes(2)
  const homes = [...homeSet.homes]
  const [deviceA, deviceB] = await Promise.all([
    startInstance(homes[0]!, 'device-a'),
    startInstance(homes[1]!, 'device-b'),
  ])
  t.after(async () => {
    await Promise.all([deviceA.stop(), deviceB.stop()])
    await homeSet.cleanup()
  })

  const stateOf = async (dsh: DshInstance): Promise<HostState> => await dsh.api<HostState>('state')

  const stateA0 = await stateOf(deviceA)
  const stateB0 = await stateOf(deviceB)
  assert.notEqual(stateA0.self.deviceId, stateB0.self.deviceId)
  assert.equal(stateA0.devices.length, 0)
  assert.ok(stateA0.direct.enabled, 'direct listener should be enabled by default')
  assert.ok(stateA0.direct.urls.length > 0, 'direct listener should advertise at least one URL')

  // A (daemon) produces a one-time pairing ticket.
  const ticket = await deviceA.api<TicketView>('pair.ticket')
  assert.match(ticket.link, /^dsh-mesh:\/\/pair\?d=/u)
  assert.ok(Date.parse(ticket.expiresAt) > Date.now())

  // B (controller) consumes the ticket. The call must return quickly: approval
  // happens on A while B polls its own state, so a blocking call would deadlock.
  const completed = await deviceB.api<{ deviceId?: string; pairing?: boolean }>('pair.complete', {
    link: ticket.link,
  })
  if (completed.deviceId !== undefined) assert.equal(completed.deviceId, stateA0.self.deviceId)

  // A must ask its local user to approve, exposing the same SAS.
  const pending = await waitFor(async () => {
    const state = await stateOf(deviceA)
    return state.pendingPairings[0]
  }, 15_000, () => 'device A never asked for pairing approval')
  assert.equal(pending.peer.deviceId, stateB0.self.deviceId)
  assert.match(pending.sas, /^\d{3}-\d{3}$/u)

  await deviceA.api('pair.approve', { requestId: pending.requestId, approved: true })

  // B eventually sees A online.
  const connected = await waitFor(async () => {
    const state = await stateOf(deviceB)
    const device = state.devices.find(item => item.deviceId === stateA0.self.deviceId)
    if (device?.status === 'error') throw new Error(`pairing failed on B: ${device.statusDetail ?? ''}`)
    return device?.status === 'online' ? device : undefined
  }, 30_000, () => 'device B never reported device A online')

  // Remote workspace metadata flows over the mesh RPC.
  const workspaces = await deviceB.api<WorkspacesView>('workspaces.refresh', {
    deviceId: stateA0.self.deviceId,
  })
  assert.equal(typeof workspaces.updatedAt, 'string')
  assert.ok(Array.isArray(workspaces.workspaces))
  assert.ok(Array.isArray(connected.remoteWorkspaces ?? []) ||
    (connected.remoteWorkspaces === undefined))

  // Portal: open the remote DSH UI through the encrypted mesh.
  const portal = await deviceB.api<{ url: string }>('portal.open', { deviceId: stateA0.self.deviceId })
  assert.match(portal.url, /^http:\/\/127\.0\.0\.1:\d+\//u)

  // The portal redirects the one-time capability token into an HttpOnly cookie.
  const login = await fetch(portal.url, { redirect: 'manual' })
  assert.equal(login.status, 303, 'portal should redirect after minting its cookie')
  const cookie = (login.headers.getSetCookie?.() ?? [])
    .map(value => value.split(';', 1)[0])
    .filter(Boolean)
    .join('; ')
  assert.notEqual(cookie, '')

  const page = await fetch(portal.url.replace(/\?.*$/u, '/'), {
    headers: { cookie, 'sec-fetch-site': 'same-origin' },
    redirect: 'manual',
  })
  assert.equal(page.status, 200, 'portal should serve the remote DSH index')
  const html = await page.text()
  assert.match(html, /__DSH_BOOT__|DeepSeek Harness/u, 'portal should serve the DSH shell')

  // Revocation on the daemon must tear down the controller's live session, not
  // merely refuse the next RPC (PROTOCOL.md §9).
  await deviceA.api('peer.revoke', { deviceId: stateB0.self.deviceId })
  const revokedView = await waitFor(async () => {
    const state = await stateOf(deviceB)
    const device = state.devices.find(item => item.deviceId === stateA0.self.deviceId)
    return device !== undefined && (device.status === 'offline' || device.status === 'error')
      ? device
      : undefined
  }, 15_000, () => 'controller did not observe the revocation')
  assert.ok(['offline', 'error'].includes(revokedView.status))

  await recordEvidence('pairing', {
    deviceA: stateA0.self,
    deviceB: stateB0.self,
    sas: pending.sas,
    workspaces: workspaces.workspaces.length,
    portal: portal.url,
    portalBytes: html.length,
    revokedStatus: revokedView.status,
  })
})
