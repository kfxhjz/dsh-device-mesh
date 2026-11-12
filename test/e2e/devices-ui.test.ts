/**
 * Real-browser test for the host switcher / add-host interaction. Starts one
 * stock DSH instance with the plugin built into its `web` profile, opens the DSH
 * UI, selects the plugin panel and drives the switcher and add-host dialog.
 *
 * Skips when Chrome is not installed (set CHROME_PATH to override).
 */
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import test from 'node:test'
import { chromium } from 'playwright-core'
import { createHomes, ensureBuilt, startInstance } from './helpers/dsh-instance.ts'

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

test('the host switcher and add-host dialog work in the real DSH UI', { timeout: 180_000 }, async (t) => {
  const executablePath = chromePath()
  if (executablePath === undefined) {
    t.skip('Chrome/Chromium not installed; set CHROME_PATH to run the browser UI E2E')
    return
  }
  await ensureBuilt()
  const homeSet = await createHomes(1)
  const instance = await startInstance(homeSet.homes[0]!, 'devices-ui')
  const browser = await chromium.launch({ executablePath, headless: true })
  t.after(async () => {
    await browser.close().catch(() => undefined)
    await instance.stop()
    await homeSet.cleanup()
  })

  const state = await instance.api<{ self: { name: string } }>('state')
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } })
  const failures: string[] = []
  page.on('pageerror', error => failures.push(`pageerror: ${error.message}`))
  page.on('console', (message) => {
    if (message.type() === 'error' && /device-mesh|slots|Invalid hook/i.test(message.text())) {
      failures.push(`console: ${message.text()}`)
    }
  })

  await page.goto(instance.url, { waitUntil: 'domcontentloaded', timeout: 30_000 })
  await page.waitForFunction(() => document.querySelectorAll('#root *').length > 50, { timeout: 30_000 })

  // A fresh DSH home shows the preview notice; while it is open the sidebar is
  // inert. Dismiss it before interacting.
  const previewContinue = page.getByRole('button', { name: /^(继续|Continue)$/u }).first()
  await previewContinue.waitFor({ state: 'visible', timeout: 8_000 }).catch(() => undefined)
  if (await previewContinue.isVisible().catch(() => false)) {
    await previewContinue.click()
    await page.waitForTimeout(800)
  }
  // A fresh home is not signed in, so the "Get started" modal follows; close it.
  const authClose = page.locator('button[aria-label="Close"]:visible').first()
  await authClose.waitFor({ state: 'visible', timeout: 5_000 }).catch(() => undefined)
  if (await authClose.count() > 0) await authClose.click().catch(() => undefined)
  await page.waitForTimeout(600)
  const remainingClose = page.locator('button[aria-label="Close"]:visible').first()
  if (await remainingClose.count() > 0) await remainingClose.click().catch(() => undefined)
  const clearMasks = async (): Promise<void> => {
    await page.evaluate(() => {
      document.querySelectorAll('div[class*="_mask_"]').forEach((element) => { element.remove() })
    })
  }
  await clearMasks()

  // The host bar is injected directly above the native Workspaces header and
  // shows the current host without opening the panel.
  const hostBar = page.locator('[data-device-mesh-host-bar]')
  await hostBar.waitFor({ state: 'visible', timeout: 15_000 })
  const hostBarText = (await hostBar.innerText()).replace(/\s+/gu, ' ')
  assert.ok(hostBarText.includes(state.self.name), `host bar should show the current host, got: ${hostBarText}`)
  assert.match(hostBarText, /主机|Hosts/u)
  const position = await page.evaluate(() => {
    const bar = document.querySelector('[data-device-mesh-host-bar]')
    const header = document.querySelector('[data-sidebar-workspace-header]') ?? document.querySelector('[class*="sectionHeader"]')
    if (bar === null || header === null) return 'missing'
    return (bar.compareDocumentPosition(header) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0 ? 'before' : 'after'
  })
  assert.equal(position, 'before', 'the host bar must sit above the native Workspaces header')

  await clearMasks()
  await page.locator('[data-device-mesh-host-toggle]').click()
  const menu = page.locator('[data-device-mesh-host-menu]')
  await menu.waitFor({ state: 'visible', timeout: 10_000 })
  assert.ok((await menu.innerText()).includes(state.self.name))
  const menuStyle = await menu.evaluate((element) => {
    const computed = getComputedStyle(element)
    const rect = element.getBoundingClientRect()
    return { position: computed.position, zIndex: computed.zIndex, x: rect.x, y: rect.y, width: rect.width, height: rect.height }
  })
  assert.equal(menuStyle.position, 'fixed', 'the floating host menu must be fixed-positioned')
  assert.ok(menuStyle.x >= 0 && menuStyle.y >= 0 && menuStyle.width > 100, `host menu must be on screen: ${JSON.stringify(menuStyle)}`)
  await page.screenshot({ path: '.test/e2e/evidence/devices-host-menu.png', fullPage: false }).catch(() => undefined)
  // Onboarding can re-open while the panel is still fresh; clear any mask again.
  await clearMasks()
  await page.locator('[data-dm-add-host]').click()
  await page.waitForTimeout(500)

  // One pairing surface: paste a link or scan the controller QR.
  await page.getByPlaceholder(/dsh-mesh:\/\/pair|粘贴|paste/iu).first()
    .waitFor({ state: 'visible', timeout: 10_000 })
  await page.getByRole('button', { name: /开始配对|Start pairing/u }).first()
    .waitFor({ state: 'visible', timeout: 10_000 })
  assert.equal(await page.getByText(/远程 SSH|Remote SSH/u).count(), 0)
  await page.screenshot({ path: '.test/e2e/evidence/devices-host-switcher.png', fullPage: true }).catch(() => undefined)
  assert.deepEqual(failures, [], `the panel reported runtime errors: ${failures.join(' | ')}`)
})
