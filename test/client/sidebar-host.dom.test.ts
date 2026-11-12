import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'

import { Window } from 'happy-dom'

import { getMeshSnapshot, refreshMeshState } from '../../src/client/api.ts'
import { setSelectedHost } from '../../src/client/host-store.ts'
import { mountSidebarHost } from '../../src/client/sidebar-host.ts'

const STATE = {
  self: {
    deviceId: 'dm_self',
    name: 'Laptop',
    platform: 'linux',
    signPk: '',
    dhPk: '',
    appVersion: '0.1.0',
  },
  protocol: 1,
  direct: { enabled: true, port: 45871, urls: [] },
  relay: { configured: false, endpoint: null, connected: false, useTls: true },
  devices: [{
    deviceId: 'dm_remote',
    name: 'Studio',
    platform: 'linux',
    direction: 'daemon',
    pairedAt: '2026-11-12T00:00:00.000Z',
    lastSeenAt: null,
    revoked: false,
    scope: { kind: 'control', workspaces: 'all', expiresAt: null },
    status: 'online',
  }],
  pendingPairings: [],
  portals: [],
} as const

let window: Window
let undoGlobals: Array<() => void> = []

/** Install a browser global for one test and remember how to restore it. */
function setGlobal(name: string, value: unknown): void {
  const previous = Object.getOwnPropertyDescriptor(globalThis, name)
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true })
  undoGlobals.push(() => {
    if (previous === undefined) Reflect.deleteProperty(globalThis, name)
    else Object.defineProperty(globalThis, name, previous)
  })
}

function setupDom(): void {
  window = new Window({ url: 'http://127.0.0.1:9/' })
  setGlobal('window', window)
  setGlobal('document', window.document)
  setGlobal('localStorage', window.localStorage)
  setGlobal('MutationObserver', window.MutationObserver)
  setGlobal('HTMLElement', window.HTMLElement)
  setGlobal('HTMLInputElement', window.HTMLInputElement)
  setGlobal('HTMLDialogElement', window.HTMLDialogElement)
  setGlobal('Node', window.Node)
  setGlobal('fetch', async () => ({
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => ({ ok: true, value: STATE }),
  }))
  window.document.body.innerHTML = '<div class="native-root"><div class="sectionHeader">Workspaces</div></div>'
  setSelectedHost('local')
}

afterEach(() => {
  for (const undo of undoGlobals.reverse()) undo()
  undoGlobals = []
  window.close()
})

test('mounts the host bar above the native header and drives the switcher menu', async () => {
  setupDom()
  await refreshMeshState()
  assert.notEqual(getMeshSnapshot().state, null)

  const opened: string[] = []
  const teardown = mountSidebarHost({
    t: (key: string) => key,
    openDevices: () => { opened.push('devices') },
    openPortal: () => { opened.push('portal') },
    connectDevice: () => { opened.push('connect') },
  })

  const bar = document.querySelector('[data-device-mesh-host-bar]')
  assert.ok(bar)
  const header = document.querySelector('.sectionHeader')
  assert.ok(header)
  assert.equal(bar.nextElementSibling, header)
  assert.equal(bar.querySelector('[data-dm-host-title]')?.textContent, 'host.section')
  assert.ok(bar.querySelector('[data-device-mesh-host-toggle]')?.textContent?.includes('Laptop'))
  assert.ok(document.querySelector('[data-device-mesh-remote-workspaces]'))

  const toggle = bar.querySelector('[data-device-mesh-host-toggle]')
  assert.ok(toggle)
  toggle.dispatchEvent(new window.MouseEvent('click', { bubbles: true }) as unknown as Event)
  const menu = document.querySelector('[data-device-mesh-host-menu]')
  assert.ok(menu)
  assert.ok(menu.textContent?.includes('Laptop'))
  assert.ok(menu.textContent?.includes('Studio'))
  assert.equal(toggle.getAttribute('aria-expanded'), 'true')

  const add = menu.querySelector('[data-dm-add-host]')
  assert.ok(add)
  add.dispatchEvent(new window.MouseEvent('click', { bubbles: true }) as unknown as Event)
  assert.deepEqual(opened, ['devices'])
  assert.equal(document.querySelector('[data-device-mesh-host-menu]'), null)

  teardown()
  assert.equal(document.querySelector('[data-device-mesh-host-bar]'), null)
  assert.equal(document.querySelector('[data-device-mesh-remote-workspaces]'), null)
})
