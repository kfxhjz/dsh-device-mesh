/**
 * Real-browser UI E2E: pair two stock DSH instances, open the controller's
 * portal in headless Chrome, and assert that the daemon's actual DSH Web UI
 * boots through the encrypted mesh — including the text-frame WebSocket that the
 * Remote stream requires.
 *
 * The test skips when no Chrome/Chromium is installed. Set `CHROME_PATH` to
 * override the executable; CI runners usually ship Google Chrome.
 */
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import test from 'node:test'
import { chromium } from 'playwright-core'
import { createHomes, ensureBuilt, recordEvidence, startInstance, waitFor } from './helpers/dsh-instance.ts'
import type { DshInstance } from './helpers/dsh-instance.ts'

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter((value): value is string => typeof value === 'string' && value.length > 0)

function chromePath(): string | undefined {
  return CHROME_CANDIDATES.find(candidate => existsSync(candidate))
}

interface HostState {
  self: { deviceId: string }
  devices: Array<{ deviceId: string; status: string }>
  pendingPairings: Array<{ requestId: string }>
}

/** Pair two fresh instances the same way a user would (link → approval). */
async function pair(daemon: DshInstance, controller: DshInstance): Promise<string> {
  const daemonState = await daemon.api<HostState>('state')
  const ticket = await daemon.api<{ link: string }>('pair.ticket')
  await controller.api('pair.complete', { link: ticket.link })
  const pending = await waitFor(async () => (await daemon.api<HostState>('state')).pendingPairings[0], 20_000, () => 'no pairing request')
  await daemon.api('pair.approve', { requestId: pending.requestId, approved: true })
  await waitFor(async () => {
    const state = await controller.api<HostState>('state')
    return state.devices.find(device => device.deviceId === daemonState.self.deviceId)?.status === 'online'
      ? true
      : undefined
  }, 30_000, () => 'device never came online')
  return daemonState.self.deviceId
}

test('the remote DSH UI boots through the portal in a real browser', { timeout: 180_000 }, async (t) => {
  const executablePath = chromePath()
  if (executablePath === undefined) {
    t.skip('Chrome/Chromium not installed; set CHROME_PATH to run the browser UI E2E')
    return
  }
  await ensureBuilt()
  const homeSet = await createHomes(2)
  const [daemon, controller] = await Promise.all([
    startInstance(homeSet.homes[0]!, 'ui-daemon'),
    startInstance(homeSet.homes[1]!, 'ui-controller'),
  ])
  const browser = await chromium.launch({ executablePath, headless: true })
  t.after(async () => {
    await browser.close().catch(() => undefined)
    await Promise.all([daemon.stop(), controller.stop()])
    await homeSet.cleanup()
  })

  const deviceId = await pair(daemon, controller)
  const portal = await controller.api<{ url: string }>('portal.open', { deviceId })

  const page = await browser.newPage()
  const sockets: string[] = []
  const failures: string[] = []
  page.on('websocket', socket => sockets.push(socket.url()))
  page.on('pageerror', error => failures.push(`pageerror: ${error.message}`))
  page.on('console', (message) => {
    if (message.type() !== 'error') return
    const text = message.text()
    // The DSH shell may log unrelated resource warnings; only protocol defects
    // that would indicate a broken relay are fatal for this assertion.
    if (/text messages required|invalid Remote stream frame|WebSocket/i.test(text)) failures.push(`console: ${text}`)
  })

  // The token URL performs the 303 + capability-cookie exchange, then the shell
  // boots the daemon's own DSH Web UI inside the portal origin.
  await page.goto(portal.url, { waitUntil: 'domcontentloaded', timeout: 30_000 })

  await page.waitForFunction(
    () => (document.querySelectorAll('#root *').length ?? 0) > 50,
    { timeout: 30_000 },
  )
  const title = await page.title()
  assert.match(title, /DeepSeek Harness|DSH/u)

  const bodyText = await page.evaluate(() => document.body.innerText)
  assert.match(bodyText, /New Session/u, 'the daemon DSH shell should render its main navigation')

  // The DSH Remote stream requires text frames; this WebSocket only works when
  // the portal preserves the text/binary opcode across the mesh.
  await waitFor(() => (sockets.some(url => url.includes('/api/remote.mux')) ? true : undefined),
    15_000, () => `no /api/remote.mux WebSocket opened (sockets: ${JSON.stringify(sockets)})`)

  assert.deepEqual(failures, [], `the remote DSH page reported protocol errors: ${failures.join(' | ')}`)

  await page.screenshot({ path: '.test/e2e/evidence/portal-ui.png', fullPage: true }).catch(() => undefined)
  await recordEvidence('portal-ui', {
    portal: portal.url,
    title,
    rootNodes: await page.evaluate(() => document.querySelectorAll('#root *').length),
    sockets,
  })
})
