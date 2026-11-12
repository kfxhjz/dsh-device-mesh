/**
 * Portal WebSocket path: a real browser-style upgrade through the loopback
 * portal must reach the daemon's own DSH WebSocket endpoint. DSH's Remote
 * stream requires text frames, so this test also guards the text/binary
 * opcode preservation added for C1 (a binary frame would be closed with 1003).
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import WebSocket from 'ws'
import { createHomes, ensureBuilt, recordEvidence, startInstance, waitFor } from './helpers/dsh-instance.ts'
import type { DshInstance } from './helpers/dsh-instance.ts'

interface HostState {
  self: { deviceId: string }
  devices: Array<{ deviceId: string; status: string }>
  pendingPairings: Array<{ requestId: string; sas: string }>
}

interface PortalLogin {
  readonly origin: string
  readonly cookie: string
}

async function openPortal(dsh: DshInstance, deviceId: string): Promise<PortalLogin> {
  const portal = await dsh.api<{ url: string }>('portal.open', { deviceId })
  const login = await fetch(portal.url, { redirect: 'manual' })
  assert.equal(login.status, 303)
  const cookie = (login.headers.getSetCookie?.() ?? [])
    .map(value => value.split(';', 1)[0])
    .filter(Boolean)
    .join('; ')
  assert.notEqual(cookie, '')
  return { origin: new URL(portal.url).origin, cookie }
}

interface ProbeResult {
  readonly opened: boolean
  readonly status?: number | undefined
  readonly closeCode?: number | undefined
  readonly closeReason?: string | undefined
  readonly stillOpen: boolean
}

/**
 * Open the portal WebSocket and, once open, send one frame. A text frame must
 * reach DSH's text-only Remote-stream gateway (it must not be rejected as a
 * binary frame with 1003); a binary frame is expected to be rejected by DSH,
 * which proves the opcode survived the proxy.
 */
function probe(
  url: string,
  options: { readonly origin: string; readonly cookie: string; readonly frame: 'none' | 'text' | 'binary' },
): Promise<ProbeResult> {
  return new Promise((resolve) => {
    const socket = new WebSocket(url, {
      headers: { cookie: options.cookie, origin: options.origin },
    })
    let opened = false
    let settled = false
    const finish = (result: ProbeResult): void => {
      if (settled) return
      settled = true
      try { socket.close() } catch { /* already closed */ }
      resolve(result)
    }
    socket.on('unexpected-response', (_request, response) => {
      finish({ opened: false, status: response.statusCode, stillOpen: false })
    })
    socket.on('open', () => {
      opened = true
      if (options.frame === 'text') socket.send('{}')
      if (options.frame === 'binary') socket.send(Buffer.from([0x00]))
    })
    socket.on('error', () => { /* the close handler or timer settles */ })
    socket.on('close', (code: number, reason: Buffer) => {
      finish({ opened, closeCode: code, closeReason: reason.toString(), stillOpen: false })
    })
    setTimeout(() =>{  finish({ opened, stillOpen: opened }) }, 2_500).unref?.()
  })
}

test('portal proxies the remote DSH WebSocket with browser Origin and text frames', { timeout: 180_000 }, async (t) => {
  await ensureBuilt()
  const homeSet = await createHomes(2)
  const [deviceA, deviceB] = await Promise.all([
    startInstance(homeSet.homes[0]!, 'ws-a'),
    startInstance(homeSet.homes[1]!, 'ws-b'),
  ])
  t.after(async () => {
    await Promise.all([deviceA.stop(), deviceB.stop()])
    await homeSet.cleanup()
  })

  const stateOf = async (dsh: DshInstance): Promise<HostState> => await dsh.api<HostState>('state')
  const stateA0 = await stateOf(deviceA)
  const stateB0 = await stateOf(deviceB)

  const ticket = await deviceA.api<{ link: string }>('pair.ticket')
  await deviceB.api('pair.complete', { link: ticket.link })
  const pending = await waitFor(async () => (await stateOf(deviceA)).pendingPairings[0], 20_000, () => 'no pairing request')
  await deviceA.api('pair.approve', { requestId: pending.requestId, approved: true })
  await waitFor(async () => {
    const state = await stateOf(deviceB)
    return state.devices.find(item => item.deviceId === stateA0.self.deviceId)?.status === 'online' ? true : undefined
  }, 30_000, () => 'device never came online')

  const portal = await openPortal(deviceB, stateA0.self.deviceId)
  const wsUrl = `${portal.origin.replace(/^http:/u, 'ws:')}/api/remote.mux`

  // The portal must reject an upgrade from another origin: that is what stops
  // another loopback port from borrowing this portal's cookie.
  const foreign = await probe(wsUrl, {
    origin: 'http://127.0.0.1:1',
    cookie: portal.cookie,
    frame: 'none',
  })
  assert.equal(foreign.opened, false, 'a foreign Origin must not open the portal WebSocket')
  assert.ok(foreign.status === 403 || foreign.closeCode === 1006 || foreign.closeCode === 1008,
    `foreign origin should be refused (status=${String(foreign.status)} close=${String(foreign.closeCode)})`)

  // A same-origin browser-style upgrade must reach the daemon's DSH gateway, and
  // a text frame must not be rejected as binary (DSH closes binary with 1003).
  const textProbe = await probe(wsUrl, { origin: portal.origin, cookie: portal.cookie, frame: 'text' })
  assert.equal(textProbe.opened, true, 'same-origin portal WebSocket should open')
  assert.notEqual(textProbe.closeCode, 1003,
    `text frame must not be rejected as binary (close=${String(textProbe.closeCode)})`)

  await recordEvidence('portal-ws', {
    portalOrigin: portal.origin,
    foreignStatus: foreign.status,
    foreignClose: foreign.closeCode,
    textOpened: textProbe.opened,
    textClose: textProbe.closeCode,
    textStillOpen: textProbe.stillOpen,
    online: stateB0.self.deviceId === stateA0.self.deviceId,
  })
})
