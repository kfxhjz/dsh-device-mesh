/**
 * Public-path E2E: both devices are forced onto a real paseo-relay instance
 * (the local Rust relay built from the repo beside this one). Direct LAN
 * listening is disabled on both sides, so pairing, approval, workspace listing
 * and the portal all travel through the relay as opaque encrypted frames.
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { createHomes, ensureBuilt, recordEvidence, startInstance, waitFor } from './helpers/dsh-instance.ts'
import type { DshInstance } from './helpers/dsh-instance.ts'

const RELAY_BIN = process.env.PASEO_RELAY_BIN
  ?? [join(process.cwd(), '.build/bin/paseo-relay'), join(process.cwd(), '.build/paseo-relay-target/release/paseo-relay')]
    .find(candidate => existsSync(candidate))
  ?? join(process.cwd(), '.build/bin/paseo-relay')

/** Raised when the optional local relay binary is not built; the test skips. */
class RelayBinaryMissing extends Error {}

/** Build command for the relay used by this test. */
const RELAY_BUILD_HINT = 'CARGO_TARGET_DIR=<this repo>/.build/paseo-relay-target cargo build --release '
  + '(run in the paseo-relay checkout), or set PASEO_RELAY_BIN'

interface RelayHandle {
  readonly url: string
  stop(): Promise<void>
}

async function startRelay(): Promise<RelayHandle> {
  if (!existsSync(RELAY_BIN)) {
    throw new RelayBinaryMissing(RELAY_BIN)
  }
  const port = 41000 + Math.floor(Math.random() * 2000)
  const child = spawn(RELAY_BIN, [], {
    env: { ...process.env, PASEO_RELAY_HOST: '127.0.0.1', PASEO_RELAY_PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stderr = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk: string) => { stderr += chunk })
  const base = `http://127.0.0.1:${String(port)}`
  await waitFor(async () => {
    try {
      const response = await fetch(`${base}/health`)
      return response.ok
    } catch {
      return undefined
    }
  }, 15_000, () => `paseo-relay did not become healthy: ${stderr.slice(-800)}`, 100)

  return {
    url: `ws://127.0.0.1:${String(port)}/ws`,
    async stop() {
      if (child.exitCode !== null) return
      child.kill('SIGTERM')
      await new Promise<void>((resolveStop) => {
        const timer = setTimeout(() => { child.kill('SIGKILL'); resolveStop() }, 5_000)
        child.once('exit', () => { clearTimeout(timer); resolveStop() })
      })
    },
  }
}

interface HostState {
  self: { deviceId: string }
  direct: { enabled: boolean }
  relay: { configured: boolean; connected: boolean; endpoint: string | null }
  devices: Array<{ deviceId: string; status: string; statusDetail?: string }>
  pendingPairings: Array<{ requestId: string; sas: string; peer: { deviceId: string } }>
}

test('pair and control a device through a real paseo-relay', { timeout: 180_000 }, async (t) => {
  await ensureBuilt()
  let relay: RelayHandle
  try {
    relay = await startRelay()
  } catch (error) {
    if (error instanceof RelayBinaryMissing) {
      t.skip(`paseo-relay binary not built at ${error.message}; ${RELAY_BUILD_HINT}`)
      return
    }
    throw error
  }
  const homeSet = await createHomes(2)
  const homes = [...homeSet.homes]
  const [deviceA, deviceB] = await Promise.all([
    startInstance(homes[0]!, 'relay-a'),
    startInstance(homes[1]!, 'relay-b'),
  ])
  t.after(async () => {
    await Promise.all([deviceA.stop(), deviceB.stop()])
    await relay.stop()
    await homeSet.cleanup()
  })

  const stateOf = async (dsh: DshInstance): Promise<HostState> => await dsh.api<HostState>('state')

  // Force relay-only on both sides: no direct endpoint can leak into the ticket.
  for (const dsh of [deviceA, deviceB]) {
    await dsh.api('direct.configure', { enabled: false, port: 0 })
    await dsh.api('relay.configure', { endpoint: relay.url, enabled: true, useTls: false })
  }
  const stateA0 = await stateOf(deviceA)
  const stateB0 = await stateOf(deviceB)
  assert.equal(stateA0.direct.enabled, false)
  assert.equal(stateA0.relay.configured, true)
  assert.equal(stateA0.relay.connected, true)

  for (const [label, dsh] of [['A', deviceA], ['B', deviceB]] as const) {
    await waitFor(async () => {
      const state = await stateOf(dsh)
      return state.relay.connected ? true : undefined
    }, 20_000, () => `device ${label} relay daemon never connected (logs: ${dsh.logs()})`)
  }

  // The ticket must advertise the relay endpoint only.
  const ticket = await deviceA.api<{ link: string }>('pair.ticket')
  const encoded = /^dsh-mesh:\/\/pair\?d=([A-Za-z0-9_-]+)$/u.exec(ticket.link)
  assert.ok(encoded, 'pairing link shape')
  const parsed = JSON.parse(Buffer.from(encoded[1]!, 'base64url').toString('utf8')) as {
    eps: Array<{ k: string; url: string; sid?: string; v?: number }>
  }
  assert.ok(parsed.eps.length > 0)
  assert.ok(parsed.eps.every(endpoint => endpoint.k === 'relay'), 'ticket must be relay-only')
  const relayEndpoint = parsed.eps[0]!
  assert.equal(relayEndpoint.url, relay.url)
  assert.match(relayEndpoint.sid ?? '', /^[A-Za-z0-9_-]{16,}$/u)

  const completed = await deviceB.api<{ deviceId: string; pairing: boolean }>('pair.complete', {
    link: ticket.link,
  })
  assert.equal(completed.deviceId, stateA0.self.deviceId)
  assert.equal(completed.pairing, true)

  const pending = await waitFor(async () => {
    const state = await stateOf(deviceA)
    return state.pendingPairings[0]
  }, 20_000, () => 'daemon never received the relay pairing request')
  assert.equal(pending.peer.deviceId, stateB0.self.deviceId)
  assert.match(pending.sas, /^\d{3}-\d{3}$/u)
  await deviceA.api('pair.approve', { requestId: pending.requestId, approved: true })

  await waitFor(async () => {
    const state = await stateOf(deviceB)
    const device = state.devices.find(item => item.deviceId === stateA0.self.deviceId)
    if (device?.status === 'error') throw new Error(`relay pairing failed: ${device.statusDetail ?? ''}`)
    return device?.status === 'online' ? true : undefined
  }, 30_000, () => 'device B never reported the relay daemon online')

  const workspaces = await deviceB.api<{ workspaces: unknown[] }>('workspaces.refresh', {
    deviceId: stateA0.self.deviceId,
  })
  assert.ok(Array.isArray(workspaces.workspaces))

  // Portal page over the relay: 303 mint cookie, then the DSH shell.
  const portal = await deviceB.api<{ url: string }>('portal.open', { deviceId: stateA0.self.deviceId })
  const login = await fetch(portal.url, { redirect: 'manual' })
  assert.equal(login.status, 303)
  const cookie = (login.headers.getSetCookie?.() ?? [])
    .map(value => value.split(';', 1)[0])
    .filter(Boolean)
    .join('; ')
  const root = `${new URL(portal.url).origin}/`
  const page = await fetch(root, { headers: { cookie, 'sec-fetch-site': 'same-origin' }, redirect: 'manual' })
  const html = await page.text()
  assert.equal(page.status, 200)
  assert.match(html, /__DSH_BOOT__|DeepSeek Harness/u)

  await recordEvidence('relay', {
    relay: relay.url,
    sid: relayEndpoint.sid,
    sas: pending.sas,
    portalBytes: html.length,
  })
})
