import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { ensureSessionSurface } from '../../src/client/session-surface.ts'
import type { ClientContext } from '../../src/client/types.ts'

function context(services: Record<string, unknown>): ClientContext {
  return { get: (name: string) => services[name] } as unknown as ClientContext
}

describe('ensureSessionSurface', () => {
  it('opens the current local session when one is available', () => {
    const opened: unknown[] = []
    const ctx = context({
      uiWorkspace: { openSession: (target: unknown) => { opened.push(target) } },
      sessions: { list: { getSnapshot: () => ({ byId: { s1: {}, s2: {} }, current: 's2' }) } },
    })
    assert.equal(ensureSessionSurface(ctx), true)
    assert.deepEqual(opened, ['s2'])
  })

  it('falls back to the first known session and tolerates a missing current', () => {
    const opened: unknown[] = []
    const ctx = context({
      uiWorkspace: { openSession: (target: unknown) => { opened.push(target) } },
      sessions: { list: { getSnapshot: () => ({ byId: { only: {} } }) } },
    })
    assert.equal(ensureSessionSurface(ctx), true)
    assert.deepEqual(opened, ['only'])
  })

  it('reports false when no session or no workspace service exists', () => {
    assert.equal(ensureSessionSurface(context({ uiWorkspace: { openSession: () => {} } })), false)
    assert.equal(ensureSessionSurface(context({ sessions: { list: { getSnapshot: () => ({ byId: { s: {} } }) } } })), false)
  })
})
