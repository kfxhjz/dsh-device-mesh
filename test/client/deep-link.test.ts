import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'

import { deepLinkedSession, listenForSessionNavigation } from '../../src/client/deep-link.ts'
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
  const ctx = {
    get: (name: string) => name === 'uiWorkspace'
      ? { openSession: (id: unknown) => { opened.push(id) } }
      : undefined,
  } as unknown as ClientContext
  listenForSessionNavigation(ctx)
  assert.ok(handler)

  handler({ source: fakeWindow.parent, data: { source: 'dsh-device-mesh-parent', kind: 'open-session', sessionId: 's9' } })
  assert.deepEqual(opened, ['s9'])

  // A foreign source, an unknown kind and an empty id are ignored.
  handler({ source: {}, data: { source: 'dsh-device-mesh-parent', kind: 'open-session', sessionId: 'bad' } })
  handler({ source: fakeWindow.parent, data: { source: 'dsh-device-mesh-parent', kind: 'other', sessionId: 'bad' } })
  handler({ source: fakeWindow.parent, data: { source: 'dsh-device-mesh-parent', kind: 'open-session', sessionId: '' } })
  assert.deepEqual(opened, ['s9'])
})
