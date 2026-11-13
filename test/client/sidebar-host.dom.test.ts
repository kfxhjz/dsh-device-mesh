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
        }, {
          id: 'sess-archived',
          title: 'Old task',
          updatedAt: '2026-11-11T00:00:00.000Z',
          running: false,
          awaitingUser: false,
          unread: false,
          archived: true,
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
    const localView = bar.querySelector<HTMLButtonElement>('[data-device-mesh-view-options]')
    assert.ok(localView)
    assert.equal(localView.hidden, true, 'view options only apply to a remote mirror')
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

test('remote mirror view options expose archived sessions and archive actions', async () => {
  setupDom()
  const requests: Array<Record<string, unknown>> = []
  setGlobal('fetch', async (_input: unknown, init?: { body?: unknown }) => {
    const request = typeof init?.body === 'string'
      ? JSON.parse(init.body) as Record<string, unknown>
      : {}
    requests.push(request)
    const remote = request.endpoint === 'workspaces.refresh' || request.endpoint === 'session.archive'
    const value = remote ? STATE.devices[0].remoteWorkspaces : STATE
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({ ok: true, value }),
    }
  })
  setSelectedHost('dm_remote')
  await refreshMeshState()

  const opened: string[] = []
  const teardown = mountSidebarHost({
    t: (key: string) => key,
    openDevices: () => {},
    openPortal: (deviceId: string, sessionId?: string) => {
      opened.push(`${deviceId}:${sessionId ?? ''}`)
    },
    connectDevice: () => {},
  })
  try {
    const view = document.querySelector<HTMLButtonElement>('[data-device-mesh-view-options]')
    assert.ok(view, 'remote mode exposes the view options button')
    assert.equal(view.hidden, false)
    // The default view hides archived sessions, matching the native tree.
    assert.equal(document.querySelector('[data-dm-remote-session="sess-archived"]'), null)

    view.dispatchEvent(new window.MouseEvent('click', { bubbles: true }) as unknown as Event)
    const menu = document.querySelector('[data-dm-view-menu]')
    assert.ok(menu, 'view options menu opens')
    assert.equal(menu.getAttribute('role'), 'menu')
    assert.ok(menu.querySelector('[data-dm-view-item="group-workspace"]'))

    const showArchived = menu.querySelector('[data-dm-view-item="archived-show"]')
    assert.ok(showArchived)
    showArchived.dispatchEvent(new window.MouseEvent('click', { bubbles: true }) as unknown as Event)
    const archivedRow = document.querySelector('[data-dm-remote-session="sess-archived"]')
    assert.ok(archivedRow, 'show-archived reveals the archived session')
    assert.ok(archivedRow.classList.contains('dm-remote-session-archived'))

    const unarchive = archivedRow.querySelector<HTMLButtonElement>('.dm-remote-archive-btn')
    assert.ok(unarchive, 'archived rows offer unarchive')
    assert.equal(unarchive.getAttribute('aria-label'), 'remote.unarchive')
    unarchive.dispatchEvent(new window.MouseEvent('click', { bubbles: true }) as unknown as Event)
    await new Promise<void>(resolve => setTimeout(resolve, 10))
    const archiveCall = requests.find(request => request.endpoint === 'session.archive')
    assert.ok(archiveCall, 'the sidebar posts to the archive endpoint')
    assert.deepEqual(archiveCall.payload, {
      deviceId: 'dm_remote',
      sessionId: 'sess-archived',
      archived: false,
    })

    // Clicking an archived row explains instead of opening the remote pane.
    archivedRow.dispatchEvent(new window.MouseEvent('click', { bubbles: true }) as unknown as Event)
    assert.deepEqual(opened, [], 'archived rows are not openable')
    const notice = document.querySelector('.dm-remote-notice')
    assert.ok(notice)
    assert.match(notice.textContent ?? '', /remote\.archivedOpenBlocked/u)

    // Archiving a running session asks in a plugin-owned dialog instead of
    // relying on window.confirm (which is unreliable in the Desktop shell).
    const runningRow = document.querySelector('[data-dm-remote-session="sess-remote"]')
    assert.ok(runningRow)
    const archiveRunning = runningRow.querySelector<HTMLButtonElement>('.dm-remote-archive-btn')
    assert.ok(archiveRunning)
    archiveRunning.dispatchEvent(new window.MouseEvent('click', { bubbles: true }) as unknown as Event)
    const confirm = document.querySelector('.dm-confirm-dialog')
    assert.ok(confirm, 'a confirmation dialog opens for a running session')
    assert.equal(
      requests.filter(request => request.endpoint === 'session.archive').length,
      1,
      'no archive request is sent before confirmation',
    )
    const confirmButton = confirm.querySelector<HTMLButtonElement>('.dm-remote-action-primary')
    assert.ok(confirmButton)
    confirmButton.dispatchEvent(new window.MouseEvent('click', { bubbles: true }) as unknown as Event)
    await new Promise<void>(resolve => setTimeout(resolve, 10))
    const runningArchiveCall = requests
      .filter(request => request.endpoint === 'session.archive')
      .find(request => (request.payload as { sessionId?: string }).sessionId === 'sess-remote')
    assert.ok(runningArchiveCall)
    assert.deepEqual(runningArchiveCall.payload, {
      deviceId: 'dm_remote',
      sessionId: 'sess-remote',
      archived: true,
      stopActivity: true,
    })
    assert.equal(document.querySelector('.dm-confirm-dialog'), null, 'the dialog closes after confirming')
  } finally {
    teardown()
  }
})
