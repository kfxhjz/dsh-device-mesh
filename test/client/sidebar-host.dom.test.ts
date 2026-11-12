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
    remoteWorkspaces: {
      updatedAt: '2026-11-12T00:00:00.000Z',
      workspaces: [{
        id: 'ws-remote',
        title: 'Remote Demo Workspace',
        path: '/tmp/remote-demo',
        sessions: [{
          id: 'sess-remote',
          title: 'Running task',
          updatedAt: '2026-11-12T00:00:00.000Z',
          running: true,
          awaitingUser: false,
          unread: false,
        }],
      }],
    },
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
  setGlobal('fetch', async (_input: unknown, init?: { body?: unknown }) => {
    const request = typeof init?.body === 'string'
      ? JSON.parse(init.body) as { endpoint?: string }
      : {}
    const value = request.endpoint === 'workspaces.refresh'
      ? STATE.devices[0].remoteWorkspaces
      : STATE
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({ ok: true, value }),
    }
  })
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

  try {
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
  } finally {
    // Always tear down the interval, MutationObserver and store subscription,
    // even when an assertion above fails, so a failing test cannot hang CI.
    teardown()
  }

  assert.equal(document.querySelector('[data-device-mesh-host-bar]'), null)
  assert.equal(document.querySelector('[data-device-mesh-remote-workspaces]'), null)
})

test('renders the remote mirror with a spinner for a running remote session', async () => {
  setupDom()
  setSelectedHost('dm_remote')
  await refreshMeshState()

  const teardown = mountSidebarHost({
    t: (key: string) => key,
    openDevices: () => {},
    openPortal: () => {},
    connectDevice: () => {},
  })
  try {
    const remoteRoot = document.querySelector('[data-device-mesh-remote-workspaces]')
    assert.ok(remoteRoot)
    assert.equal((remoteRoot as HTMLElement).hidden, false)
    const session = remoteRoot.querySelector('[data-dm-remote-session="sess-remote"]')
    assert.ok(session)
    const spinner = session.querySelector('.dm-spinner.dm-remote-session-spinner')
    assert.ok(spinner, 'running session shows a spinner')
    assert.equal(spinner.getAttribute('title'), 'remote.running')
  } finally {
    teardown()
  }
})
