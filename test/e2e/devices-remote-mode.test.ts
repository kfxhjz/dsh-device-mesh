/**
 * Real-browser test for the remote workspace mirror: pair two DSH instances,
 * open the controller UI, switch the sidebar host to the remote device, and
 * assert the native workspace browser is hidden while the remote mirror shows
 * the remote host (or its empty state). Switching back restores the native list.
 *
 * Skips when Chrome is not installed (set CHROME_PATH to override).
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { chromium } from 'playwright-core'
import type { Page } from 'playwright-core'
import { createHomes, ensureBuilt, startInstance, waitFor } from './helpers/dsh-instance.ts'

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

async function dismissOnboarding(page: Page): Promise<void> {
  const previewContinue = page.getByRole('button', { name: /^(继续|Continue)$/u }).first()
  await previewContinue.waitFor({ state: 'visible', timeout: 8_000 }).catch(() => undefined)
  if (await previewContinue.isVisible().catch(() => false)) {
    await previewContinue.click()
    await page.waitForTimeout(800)
  }
  const authClose = page.locator('button[aria-label="Close"]:visible').first()
  await authClose.waitFor({ state: 'visible', timeout: 5_000 }).catch(() => undefined)
  if (await authClose.count() > 0) await authClose.click().catch(() => undefined)
  await page.waitForTimeout(600)
  const remainingClose = page.locator('button[aria-label="Close"]:visible').first()
  if (await remainingClose.count() > 0) await remainingClose.click().catch(() => undefined)
  await page.evaluate(() => {
    document.querySelectorAll('div[class*="_mask_"]').forEach((element) => { element.remove() })
  })
}

interface HostState {
  self: { name: string; deviceId: string }
  devices: Array<{ deviceId: string; name: string; status: string }>
  pendingPairings: Array<{ requestId: string }>
}

test('switching to a remote host mirrors its workspaces in the sidebar', { timeout: 240_000 }, async (t) => {
  const executablePath = chromePath()
  if (executablePath === undefined) {
    t.skip('Chrome/Chromium not installed; set CHROME_PATH to run the browser UI E2E')
    return
  }
  await ensureBuilt()
  const homeSet = await createHomes(2)
  // Seed one workspace in the daemon home so the mirror has a real row, not
  // just the empty state.
  const daemonHome = homeSet.homes[0]!
  const remotePath = join(daemonHome, 'remote-demo-workspace')
  mkdirSync(remotePath, { recursive: true })
  mkdirSync(join(daemonHome, 'storages'), { recursive: true })
  const workspaceId = randomUUID()
  const now = new Date().toISOString()
  const workspaceIds = [workspaceId]
  const workspaceRows: Record<string, unknown> = {
    [workspaceId]: { path: remotePath, title: 'Remote Demo Workspace', sessionIds: [], createdAt: now, updatedAt: now },
  }
  for (let index = 0; index < 16; index += 1) {
    const id = randomUUID()
    const path = join(daemonHome, `remote-workspace-${index}`)
    mkdirSync(path, { recursive: true })
    workspaceIds.push(id)
    workspaceRows[id] = { path, title: `Remote Workspace ${index}`, sessionIds: [], createdAt: now, updatedAt: now }
  }
  writeFileSync(join(daemonHome, 'storages', 'workspace.json'), JSON.stringify({
    unit: { name: 'workspace', version: 2 },
    global: { initialized: true, workspaceIds, archivedSessionIds: [], pinnedSessionIds: [] },
    tables: { workspaces: workspaceRows },
  }))
  // Seed a local workspace in the controller home too: remote rows copy the
  // shell's hashed workspace-row classes from a mounted local row.
  const controllerHome = homeSet.homes[1]!
  const localPath = join(controllerHome, 'local-demo-workspace')
  mkdirSync(localPath, { recursive: true })
  mkdirSync(join(controllerHome, 'storages'), { recursive: true })
  const localWorkspaceId = randomUUID()
  writeFileSync(join(controllerHome, 'storages', 'workspace.json'), JSON.stringify({
    unit: { name: 'workspace', version: 2 },
    global: { initialized: true, workspaceIds: [localWorkspaceId], archivedSessionIds: [], pinnedSessionIds: [] },
    tables: {
      workspaces: {
        [localWorkspaceId]: { path: localPath, title: 'Local Demo Workspace', sessionIds: [], createdAt: now, updatedAt: now },
      },
    },
  }))
  const [daemon, controller] = await Promise.all([
    startInstance(homeSet.homes[0]!, 'mirror-daemon'),
    startInstance(homeSet.homes[1]!, 'mirror-controller'),
  ])
  const browser = await chromium.launch({ executablePath, headless: true })
  t.after(async () => {
    await browser.close().catch(() => undefined)
    await Promise.all([daemon.stop(), controller.stop()])
    await homeSet.cleanup()
  })

  // Pair: link -> controller -> daemon approval -> online.
  const daemonState = await daemon.api<HostState>('state')
  const controllerState = await controller.api<HostState>('state')
  const ticket = await daemon.api<{ link: string }>('pair.ticket')
  await controller.api('pair.complete', { link: ticket.link })
  const pending = await waitFor(async () => (await daemon.api<HostState>('state')).pendingPairings[0],
    20_000, () => 'no pairing request')
  await daemon.api('pair.approve', { requestId: pending.requestId, approved: true })
  const device = await waitFor(async () => {
    const state = await controller.api<HostState>('state')
    const entry = state.devices.find(item => item.deviceId === daemonState.self.deviceId)
    return entry?.status === 'online' ? entry : undefined
  }, 30_000, () => 'remote device never came online')

  // Create a real Session through the daemon GUI so the remote sidebar has a
  // native session row to mirror (the workspace registry only lists real ones).
  const daemonPage = await browser.newPage({ viewport: { width: 1200, height: 800 } })
  try {
    await daemonPage.goto(daemon.url, { waitUntil: 'domcontentloaded', timeout: 30_000 })
    await daemonPage.waitForFunction(() => document.querySelectorAll('#root *').length > 50, { timeout: 30_000 })
    await dismissOnboarding(daemonPage)
    // The daemon's switcher lists only hosts it can control: the paired
    // controller must not appear as a remote host (selecting one used to open a
    // mirror that could only fail with "could not load remote workspaces").
    await daemonPage.locator('[data-device-mesh-host-toggle]').click()
    await daemonPage.locator('[data-device-mesh-host-menu]').waitFor({ state: 'visible', timeout: 10_000 })
    assert.equal(
      await daemonPage.locator(`[data-dm-host-id="${controllerState.self.deviceId}"]`).count(),
      0,
      'the daemon must not offer its controller as a remote host',
    )
    assert.equal(await daemonPage.locator('[data-dm-host-id="local"]').count(), 1)
    await daemonPage.keyboard.press('Escape')
    const newSession = daemonPage.getByRole('button', { name: /^(New Session|新会话)$/u }).first()
    if (await newSession.isVisible().catch(() => false)) {
      await newSession.click()
      await daemonPage.waitForTimeout(1_500)
    }
  } catch { /* best effort: the mirror can still be tested without sessions */ }
  await daemonPage.close().catch(() => undefined)

  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } })
  const failures: string[] = []
  page.on('pageerror', error => failures.push(`pageerror: ${error.message}`))
  page.on('console', (message) => {
    if (message.type() === 'error' && /device-mesh|slots|Invalid hook/i.test(message.text())) {
      failures.push(`console: ${message.text()}`)
    }
  })
  await page.goto(controller.url, { waitUntil: 'domcontentloaded', timeout: 30_000 })
  await page.waitForFunction(() => document.querySelectorAll('#root *').length > 50, { timeout: 30_000 })
  await dismissOnboarding(page)

  const bar = page.locator('[data-device-mesh-host-bar]')
  await bar.waitFor({ state: 'visible', timeout: 20_000 })
  const nativeHeader = page.locator('[data-sidebar-workspace-header], [class*="sectionHeader"]').first()
  const headerVisible = async (): Promise<boolean> =>
    await nativeHeader.evaluate(element => getComputedStyle(element).display !== 'none').catch(() => false)
  assert.equal(await headerVisible(), true, 'the native workspace header is visible in local mode')

  // Switch to the paired host through the sidebar dropdown.
  await page.locator('[data-device-mesh-host-toggle]').click()
  await page.locator(`[data-dm-host-id="${device.deviceId}"]`).click()
  const remote = page.locator('[data-device-mesh-remote-workspaces]')
  await remote.waitFor({ state: 'visible', timeout: 20_000 })
  // The native section header (search/actions) stays visible in remote mode:
  // the remote host is expected to look like the local workspace browser.
  assert.equal(await headerVisible(), true, 'the native workspace header must stay visible in remote mode')
  // Regression: the periodic rail check used to measure the now-hidden native
  // header (0px) and hide the mirror on the next tick.
  await page.waitForTimeout(1_500)
  assert.equal(await remote.isVisible(), true, 'the remote mirror must survive the rail check')
  const remoteText = (await remote.innerText()).replace(/\s+/gu, ' ')
  assert.ok(remoteText.includes('Remote Demo Workspace'), `remote mirror should list the seeded workspace, got: ${remoteText}`)
  // The seeded remote workspace must be mirrored in the sidebar.
  await page.getByText('Remote Demo Workspace').first().waitFor({ state: 'visible', timeout: 20_000 })
  const workspaceRow = page.locator('[data-dm-remote-workspace]').first()
  await workspaceRow.click()
  const remoteSession = page.locator('[data-dm-remote-session]').first()
  if (await remoteSession.count() > 0) {
    await remoteSession.waitFor({ state: 'visible', timeout: 10_000 })
  }
  if (process.env.DSH_MESH_E2E_VERBOSE === '1') {
    console.log('LIST_METRICS', JSON.stringify(await remote.evaluate(el => ({
      rows: el.querySelectorAll('[data-dm-remote-workspace]').length,
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
      overflow: getComputedStyle(el).overflowY,
    }))))
  }
  const bottom = await remote.evaluate((element) => {
    element.scrollTop = element.scrollHeight
    return { top: element.scrollTop, height: element.clientHeight, total: element.scrollHeight }
  })
  assert.ok(bottom.top + bottom.height >= bottom.total - 2, `remote tree did not reach the bottom: ${JSON.stringify(bottom)}`)
  const lastWorkspace = page.locator('[data-dm-remote-workspace]').last()
  assert.equal(await lastWorkspace.isVisible(), true, 'the last remote workspace must be reachable after scrolling')
  const lastRect = await lastWorkspace.evaluate(element => element.getBoundingClientRect().toJSON())
  const viewport = await page.evaluate(() => window.innerHeight)
  assert.ok(lastRect.bottom <= viewport, `last remote workspace is clipped below the viewport: ${JSON.stringify(lastRect)} > ${viewport}`)
  await page.screenshot({ path: '.test/e2e/evidence/sidebar-remote-mode.png', fullPage: false }).catch(() => undefined)

  // Clicking a remote session must open that session on the first attempt.
  if (await remoteSession.count() > 0) {
    await remoteSession.click()
    await waitFor(async () => {
      const selected = await page.locator('[data-dm-remote-session][aria-selected="true"]').count()
      return selected > 0 ? true : undefined
    }, 10_000, () => 'remote session was not marked selected')
  } else {
    await workspaceRow.click()
  }
  const pane = page.locator('[data-device-mesh-remote-pane]')
  await pane.waitFor({ state: 'visible', timeout: 20_000 })
  const frame = await waitFor(async () => {
    const found = page.frames().find(item => item !== page.mainFrame() && /^http:\/\/127\.0\.0\.1:\d+\//u.test(item.url()))
    if (found === undefined) return undefined
    const text = await found.evaluate(() => document.body?.innerText ?? '').catch(() => '')
    return text.length > 0 ? found : undefined
  }, 30_000, () => 'remote pane iframe stayed blank')
  const frameText = (await frame.evaluate(() => document.body.innerText).catch(() => '')).replace(/\s+/gu, ' ')
  assert.ok(!frameText.includes('cross-site request'), `remote pane hit the portal fence: ${frameText.slice(0, 200)}`)

  // The embedded remote shell still renders its right-sidebar control. It must
  // actually open the pane's right sidebar instead of doing nothing because the
  // embed CSS hides the column.
  const rightbarWidth = async (): Promise<number> => await frame.evaluate(() => {
    const col = document.querySelector('[class$="_rightbarCol"]')
    return col instanceof HTMLElement ? col.getBoundingClientRect().width : -1
  })
  await waitFor(async () => await frame.evaluate(
    () => document.querySelector('[class$="_rightbarCol"]') !== null ? true : undefined,
  ), 20_000, () => 'the embedded remote layout did not mount')
  await frame.evaluate(() => {
    document.querySelectorAll('[class*="_mask_"]').forEach((element) => { element.remove() })
  })
  assert.equal(await rightbarWidth(), 0, 'the remote right sidebar starts closed')
  await waitFor(async () => await frame.evaluate(
    () => document.querySelector('[data-sidebar-right-expand]') !== null ? true : undefined,
  ), 10_000, () => 'the embedded remote UI did not render its right-sidebar control')
  const clickedRightbar = await frame.evaluate(() => {
    const button = document.querySelector('[data-sidebar-right-expand]')
    if (!(button instanceof HTMLElement)) return false
    button.click()
    return true
  })
  assert.equal(clickedRightbar, true, 'the embedded remote UI must render its right-sidebar control')
  await waitFor(async () => (await rightbarWidth()) > 0 ? true : undefined,
    10_000, () => 'the remote right sidebar did not open after clicking its control')
  await page.screenshot({ path: '.test/e2e/evidence/remote-pane.png', fullPage: false }).catch(() => undefined)

  // macOS desktop hides the collapsed sidebar completely and moves the sidebar
  // opener into the frame's window-chrome seat, over the centre column the pane
  // covers. Regression: the pane used to paint above that seat (z-index 40 vs
  // 15), so collapsing the sidebar left no visible way to open it again.
  await page.evaluate(() => {
    document.documentElement.dataset.platform = 'darwin'
    document.documentElement.setAttribute('data-fullscreen', '')
  })
  await page.locator('[data-sidebar-toggle]').first().click()
  await waitFor(async () => (await page.locator('[data-sidebar-opener]').count()) > 0 ? true : undefined,
    10_000, () => 'the collapsed macOS sidebar did not mount its opener')
  // Bounds follow the centre column on the pane's own 500ms tick; wait for the
  // pane to reach the collapsed edge before judging what is on top.
  const paneLeft = async (): Promise<number> => await page.evaluate(() => {
    const pane = document.querySelector<HTMLElement>('[data-device-mesh-remote-pane]')
    return pane === null ? -1 : pane.getBoundingClientRect().left
  })
  await waitFor(async () => (await paneLeft()) < 1 ? true : undefined,
    5_000, () => 'the remote pane did not expand over the collapsed sidebar')
  const openerHit = await page.evaluate(() => {
    const opener = document.querySelector('[data-sidebar-opener]')
    if (!(opener instanceof HTMLElement)) return 'missing'
    const rect = opener.getBoundingClientRect()
    const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)
    return hit === null ? 'none' : `${hit.tagName}.${typeof (hit as HTMLElement).className === 'string' ? (hit as HTMLElement).className : ''}`
  })
  assert.ok(!openerHit.includes('dm-remote-pane'), `the remote pane covers the sidebar opener: ${openerHit}`)
  await page.locator('[data-sidebar-opener]').click({ timeout: 5_000 })
  const sidebarWidth = async (): Promise<number> => await page.evaluate(() => {
    const column = document.querySelector<HTMLElement>('[class$="_sidebarCol"]')
    return column?.getBoundingClientRect().width ?? 0
  })
  await waitFor(async () => (await sidebarWidth()) > 100 ? true : undefined,
    5_000, () => 'the sidebar opener did not reopen the sidebar over the remote pane')
  await page.evaluate(() => {
    delete document.documentElement.dataset.platform
    document.documentElement.removeAttribute('data-fullscreen')
  })

  // Switch back to this host: the native browser must return.
  await page.locator('[data-device-mesh-host-toggle]').click()
  await page.locator('[data-dm-host-id="local"]').click()
  await waitFor(async () => (await headerVisible()) ? true : undefined,
    10_000, () => 'native workspace header did not return for the local host')
  assert.equal(await remote.isVisible().catch(() => false), false, 'the remote mirror must be hidden in local mode')

  // First top-level portal load must not race the daemon's cold DSH cookie:
  // a 4xx/5xx asset burst leaves the shell stuck on "plugin load failed" until
  // a manual refresh, so the host warms `portal.prepare` before returning URL.
  const first = await controller.api<{ url: string }>('portal.open', { deviceId: device.deviceId })
  const fresh = await browser.newContext()
  try {
    const cold = await fresh.newPage()
    const bad: string[] = []
    cold.on('response', (response) => {
      if (response.status() >= 400) bad.push(`${response.status()} ${response.url()}`)
    })
    await cold.goto(first.url, { waitUntil: 'domcontentloaded', timeout: 30_000 })
    const coldText = await waitFor(async () => {
      const text = (await cold.evaluate(() => document.body?.innerText ?? '').catch(() => '')).trim()
      return text.length > 0 ? text : undefined
    }, 30_000, () => 'cold portal rendered no text')
    assert.ok(!/加载插件异常|加载插件失败|plugin load failed/iu.test(coldText),
      `cold portal showed a plugin load failure: ${coldText.slice(0, 300)}`)
    assert.deepEqual(bad, [], `cold portal load had failed requests: ${bad.join(' | ')}`)
  } finally {
    await fresh.close().catch(() => undefined)
  }

  // New Session from the remote mirror: the workspace row's + asks the remote
  // shell to create a blank Session; the mirrored listing must pick it up.
  await page.locator('[data-device-mesh-host-toggle]').click()
  await page.locator(`[data-dm-host-id="${device.deviceId}"]`).click()
  await remote.waitFor({ state: 'visible', timeout: 20_000 })
  const emptyWorkspace = page.locator('[data-dm-remote-workspace]').nth(1)
  await emptyWorkspace.waitFor({ state: 'visible', timeout: 20_000 })
  const sessionsBefore = await page.locator('[data-dm-remote-session]').count()
  await emptyWorkspace.hover()
  await emptyWorkspace.locator('.dm-remote-new-btn').click()
  await page.waitForTimeout(4_500)
  if (await emptyWorkspace.getAttribute('aria-expanded') !== 'true') await emptyWorkspace.click()
  await waitFor(
    async () => (await page.locator('[data-dm-remote-session]').count()) > sessionsBefore,
    10_000,
    () => 'the new remote Session did not appear in the sidebar',
  )

  assert.deepEqual(failures, [], `the sidebar reported runtime errors: ${failures.join(' | ')}`)
})
