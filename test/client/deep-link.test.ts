import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'

import { deepLinkedNewSession, deepLinkedSession, listenForSessionNavigation, openDeepLinkedSession } from '../../src/client/deep-link.ts'
import type { ClientContext } from '../../src/client/types.ts'

function registerWindow(fake: unknown): void {
  Object.defineProperty(globalThis, 'window', { value: fake, configurable: true, writable: true })
}

afterEach(() => {
  Reflect.deleteProperty(globalThis, 'window')
})

test('reads ?dm-session from the URL first', () => {
  registerWindow({
    location: { search: '?dm-session=session-1' },
    sessionStorage: { getItem: () => 'session-from-storage', removeItem: () => {} },
  })
  assert.equal(deepLinkedSession(), 'session-1')
})

test('falls back to sessionStorage and consumes it once', () => {
  let stored: string | null = 'session-2'
  registerWindow({
    location: { search: '' },
    sessionStorage: {
      getItem: () => stored,
      removeItem: () => { stored = null },
    },
  })
  assert.equal(deepLinkedSession(), 'session-2')
  assert.equal(stored, null)
  assert.equal(deepLinkedSession(), null)
})

test('returns null when neither source names a session', () => {
  registerWindow({
    location: { search: '?other=1&dm-session=' },
    sessionStorage: { getItem: () => null, removeItem: () => {} },
  })
  assert.equal(deepLinkedSession(), null)
})

test('reads and consumes a one-shot new-Session URL request', () => {
  let replaced = ''
  registerWindow({
    location: {
      search: '?dm-new-session=ws-1&dm-new-session-request=req-1&dm-embed=1',
      href: 'http://127.0.0.1:9/?dm-new-session=ws-1&dm-new-session-request=req-1&dm-embed=1',
    },
    sessionStorage: { getItem: () => null, removeItem: () => {} },
    history: {
      replaceState: (_state: unknown, _title: string, url: string) => { replaced = url },
    },
  })
  assert.deepEqual(deepLinkedNewSession(), { workspaceId: 'ws-1', requestId: 'req-1' })
  assert.equal(replaced.includes('dm-new-session'), false, 'the one-shot params are consumed')
  assert.equal(replaced.includes('dm-embed=1'), true, 'unrelated params stay')
})

test('falls back to the portal-populated new-Session storage', () => {
  let stored: string | null = JSON.stringify({ workspaceId: 'ws-2', requestId: 'req-2' })
  registerWindow({
    location: { search: '' },
    sessionStorage: {
      getItem: () => stored,
      removeItem: () => { stored = null },
    },
  })
  assert.deepEqual(deepLinkedNewSession(), { workspaceId: 'ws-2', requestId: 'req-2' })
  assert.equal(stored, null)
  assert.equal(deepLinkedNewSession(), null)
})

test('boot starts a new Session from a one-shot URL request', () => {
  registerWindow({
    location: {
      search: '?dm-new-session=ws-boot&dm-new-session-request=req-boot',
      href: 'http://127.0.0.1:9/?dm-new-session=ws-boot&dm-new-session-request=req-boot',
    },
    sessionStorage: { getItem: () => null, removeItem: () => {} },
    history: { replaceState: () => {} },
  })
  const started: unknown[] = []
  const ctx = {
    get: (name: string) => name === 'uiWorkspace'
      ? { startSession: (workspaceId: unknown) => { started.push(workspaceId) } }
      : undefined,
  } as unknown as ClientContext
  openDeepLinkedSession(ctx)
  assert.deepEqual(started, ['ws-boot'])
})

test('session navigation accepts only a valid parent-shell message', () => {
  let handler: ((event: unknown) => void) | undefined
  const fakeWindow: {
    addEventListener: (name: string, listener: (event: unknown) => void) => void
    parent: unknown
  } = {
    addEventListener: (_name, listener) => { handler = listener },
    parent: {},
  }
  fakeWindow.parent = fakeWindow
  registerWindow(fakeWindow)

  const opened: unknown[] = []
  const started: unknown[] = []
  const ctx = {
    get: (name: string) => name === 'uiWorkspace'
      ? {
        openSession: (id: unknown) => { opened.push(id) },
        startSession: (workspaceId: unknown) => { started.push(workspaceId) },
      }
      : undefined,
  } as unknown as ClientContext
  listenForSessionNavigation(ctx)
  assert.ok(handler)

  handler({ source: fakeWindow.parent, data: { source: 'dsh-device-mesh-parent', kind: 'open-session', sessionId: 's9' } })
  assert.deepEqual(opened, ['s9'])

  // New-Session requests are idempotent per request id (URL and postMessage
  // delivery can both arrive).
  handler({
    source: fakeWindow.parent,
    data: { source: 'dsh-device-mesh-parent', kind: 'new-session', workspaceId: 'ws-1', requestId: 'req-1' },
  })
  handler({
    source: fakeWindow.parent,
    data: { source: 'dsh-device-mesh-parent', kind: 'new-session', workspaceId: 'ws-1', requestId: 'req-1' },
  })
  assert.deepEqual(started, ['ws-1'])

  // A foreign source, an unknown kind and an empty id are ignored.
  handler({ source: {}, data: { source: 'dsh-device-mesh-parent', kind: 'open-session', sessionId: 'bad' } })
  handler({ source: fakeWindow.parent, data: { source: 'dsh-device-mesh-parent', kind: 'other', sessionId: 'bad' } })
  handler({ source: fakeWindow.parent, data: { source: 'dsh-device-mesh-parent', kind: 'open-session', sessionId: '' } })
  handler({ source: fakeWindow.parent, data: { source: 'dsh-device-mesh-parent', kind: 'new-session', workspaceId: '', requestId: 'bad' } })
  assert.deepEqual(opened, ['s9'])
  assert.deepEqual(started, ['ws-1'])
})
