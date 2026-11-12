import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  MAX_SESSIONS_PER_WORKSPACE,
  MAX_TOTAL_SESSIONS_PER_LISTING,
  MAX_WORKSPACES_RESULT_BYTES,
  WorkspaceProvider,
  limitWorkspaceListing,
  mapSessionSummary,
  mapWorkspaceSummary,
} from '../../src/host/workspaces.ts'

interface FakeSession {
  readonly id: string
  readonly header?: { readonly createdAt: number; readonly updatedAt?: number }
  snapshotEvents(): readonly unknown[]
  readonly seq?: number
  eventAt?(seq: number): unknown
}

interface FakeSnapshot {
  readonly header: {
    readonly version?: number
    readonly id: string
    readonly createdAt: number
    readonly isSeeded?: boolean
    readonly title?: string
    readonly updatedAt?: number
  }
  readonly revision: string
  readonly eventCount?: number
  readonly sizeBytes?: number
}

function sessionFacts(id: string, title: string, updatedAt: number, _running = false): FakeSession {
  return {
    id,
    header: { createdAt: updatedAt - 1000 },
    snapshotEvents: () => [
      { type: 'user/message', time: updatedAt - 500, data: { source: { kind: 'user' }, content: [{ type: 'text', text: `first prompt for ${id}` }] } },
      { type: 'session/title', time: updatedAt, data: { title } },
    ],
  }
}

/** Build one real `SessionPersistenceSnapshot`-shaped entry (`{ header }`). */
function persistedSnapshot(id: string, createdAt: number, extra: Partial<FakeSnapshot['header']> = {}): FakeSnapshot {
  return {
    header: { version: 4, id, createdAt, isSeeded: false, ...extra },
    revision: `rev-${id}`,
    eventCount: 2,
    sizeBytes: 128,
  }
}

function makeProvider(
  services: Record<string, unknown>,
  options: { now?: () => number; maxSessionsPerWorkspace?: number; maxFactsPerRefresh?: number } = {},
): WorkspaceProvider {
  return new WorkspaceProvider({
    getService: name => services[name],
    ...(options.now !== undefined ? { now: options.now } : {}),
    ...(options.maxSessionsPerWorkspace !== undefined ? { maxSessionsPerWorkspace: options.maxSessionsPerWorkspace } : {}),
    ...(options.maxFactsPerRefresh !== undefined ? { maxFactsPerRefresh: options.maxFactsPerRefresh } : {}),
  })
}

function baseServices(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const sessions = [
    sessionFacts('session-1', 'Fix login', 1_700_000_100_000, true),
    sessionFacts('session-2', 'Write docs', 1_700_000_200_000),
  ]
  return {
    workspaceRegistry: {
      list: () => [
        { id: 'ws-1', title: 'Project A', path: '/work/a', sessionIds: ['session-1', 'session-2', 'session-persisted'] },
        { id: 'ws-2', title: 'Project B', path: '/work/b', sessionIds: [] },
      ],
    },
    sessions: {
      list: () => sessions,
      get: (id: string) => sessions.find(session => session.id === id),
    },
    sessionTitle: {
      get: (session: FakeSession) => ({ title: session.id === 'session-1' ? 'Fix login' : 'Write docs' }),
    },
    agents: {
      get: (id: string) => ({ status: id === 'session-1' ? 'running' : 'idle' }),
    },
    // Real DSH shape: list() returns snapshots, each wrapping a SessionHeader.
    sessionPersistence: {
      list: async () => [persistedSnapshot('session-persisted', 1_700_000_050_000)],
    },
    // The title/recency of cold sessions comes from DSH's projection cache.
    sessionProjectionCache: {
      cachedSnapshot: (header: { readonly id?: string }) => header.id === 'session-persisted'
        ? {
          asOfSeq: 2,
          values: {
            title: 'Persisted title',
            sessionListMetadata: { blank: false, lastPromptAt: 1_700_000_060_000 },
          },
        }
        : undefined,
    },
    ...overrides,
  }
}

describe('workspaces: mapping', () => {
  it('maps registry facts and real persistence snapshots to the wire shape', async () => {
    const result = await makeProvider(baseServices()).list()
    assert.equal(result.workspaces.length, 2)
    const projectA = result.workspaces[0]
    assert.ok(projectA)
    assert.equal(projectA.id, 'ws-1')
    assert.equal(projectA.title, 'Project A')
    assert.equal(projectA.path, '/work/a')
    // Newest session first: live event time, then live event time, then the
    // persisted row's projection `lastPromptAt` (not its header.createdAt).
    assert.deepEqual(projectA.sessions.map(session => session.id), ['session-2', 'session-1', 'session-persisted'])
    const first = projectA.sessions[0]
    assert.equal(first?.title, 'Write docs')
    assert.equal(first?.running, false)
    assert.equal(first?.awaitingUser, false)
    assert.equal(first?.unread, false)
    assert.equal(first?.updatedAt, new Date(1_700_000_200_000).toISOString())
    const running = projectA.sessions[1]
    assert.equal(running?.running, true)
    assert.equal(running?.title, 'Fix login')
    const persisted = projectA.sessions[2]
    // M9: the snapshot's header is nested, and the projection supplies title +
    // lastPromptAt; the row must not fall back to `Session <id>` / now.
    assert.equal(persisted?.title, 'Persisted title')
    assert.equal(persisted?.running, false)
    assert.equal(persisted?.updatedAt, new Date(1_700_000_060_000).toISOString())
  })

  it('accepts both nested snapshots and a bare legacy header', async () => {
    const services = baseServices({
      workspaceRegistry: {
        list: () => [{ id: 'ws', title: 'W', path: '/w', sessionIds: ['session-nested', 'session-bare'] }],
      },
      sessions: { list: () => [] },
      sessionTitle: {},
      agents: {},
      sessionProjectionCache: {},
      sessionPersistence: {
        list: async () => [
          persistedSnapshot('session-nested', 1_700_000_010_000),
          // Reduced/older stores may still return the header itself.
          { id: 'session-bare', createdAt: 1_700_000_020_000 },
        ],
      },
    })
    const result = await makeProvider(services).list()
    const sessions = result.workspaces[0]?.sessions ?? []
    assert.deepEqual(sessions.map(session => session.id), ['session-bare', 'session-nested'])
    assert.equal(sessions[0]?.updatedAt, new Date(1_700_000_020_000).toISOString())
    assert.equal(sessions[1]?.updatedAt, new Date(1_700_000_010_000).toISOString())
    // No title source: degrade to a readable placeholder, never drop the row.
    assert.equal(sessions[0]?.title, 'Session bare')
    assert.equal(sessions[1]?.title, 'Session nested')
  })

  it('prefers a live session over the persisted snapshot for the same id', async () => {
    const services = baseServices({
      workspaceRegistry: {
        list: () => [{ id: 'ws', title: 'W', path: '/w', sessionIds: ['session-1'] }],
      },
      sessionPersistence: {
        list: async () => [persistedSnapshot('session-1', 1_600_000_000_000, { title: 'Stale persisted title' })],
      },
      sessionProjectionCache: {
        cachedSnapshot: () => ({ asOfSeq: 1, values: { title: 'Stale cached title' } }),
      },
    })
    const result = await makeProvider(services).list()
    const session = result.workspaces[0]?.sessions[0]
    assert.equal(session?.title, 'Fix login')
    assert.equal(session?.updatedAt, new Date(1_700_000_100_000).toISOString())
    assert.equal(session?.running, true)
  })

  it('uses header createdAt when no projection/cache recency exists', async () => {
    const services = baseServices({
      workspaceRegistry: {
        list: () => [{ id: 'ws', title: 'W', path: '/w', sessionIds: ['session-persisted'] }],
      },
      sessions: { list: () => [] },
      sessionTitle: {},
      agents: {},
      sessionProjectionCache: {},
    })
    const result = await makeProvider(services).list()
    const session = result.workspaces[0]?.sessions[0]
    assert.equal(session?.updatedAt, new Date(1_700_000_050_000).toISOString())
    assert.equal(session?.title, 'Session persisted')
  })

  it('exposes awaitingUser from the live agent status/flag when present', async () => {
    const services = baseServices({
      workspaceRegistry: {
        list: () => [{ id: 'ws', title: 'W', path: '/w', sessionIds: ['session-1'] }],
      },
      agents: { get: () => ({ status: 'running', awaitingUser: true }) },
    })
    const result = await makeProvider(services).list()
    assert.equal(result.workspaces[0]?.sessions[0]?.awaitingUser, true)
    assert.equal(result.workspaces[0]?.sessions[0]?.running, true)
  })

  it('falls back to the first user message when no title event exists', async () => {
    const services = baseServices({
      sessionTitle: {},
      agents: {},
      sessions: {
        list: () => [{
          id: 'session-titleless',
          header: { createdAt: 1_700_000_000_000 },
          snapshotEvents: () => [
            { type: 'user/message', time: 1_700_000_001_000, data: { source: { kind: 'user' }, content: 'hello there world' } },
          ],
        }],
      },
      workspaceRegistry: {
        list: () => [{ id: 'ws', title: 'W', path: '/w', sessionIds: ['session-titleless'] }],
      },
    })
    const result = await makeProvider(services).list()
    assert.equal(result.workspaces[0]?.sessions[0]?.title, 'hello there world')
    assert.equal(
      result.workspaces[0]?.sessions[0]?.updatedAt,
      new Date(1_700_000_001_000).toISOString(),
    )
  })

  it('maps sessions without a title to a readable default', () => {
    const summary = mapSessionSummary('session-abcdef', undefined, '2026-01-01T00:00:00.000Z')
    assert.equal(summary.id, 'session-abcdef')
    assert.match(summary.title, /Session abcdef/u)
  })

  it('caps the number of sessions per workspace', () => {
    const workspace = {
      id: 'ws',
      title: 'W',
      path: '/w',
      sessionIds: Array.from({ length: MAX_SESSIONS_PER_WORKSPACE + 10 }, (_, index) => `s-${index}`),
    }
    const summary = mapWorkspaceSummary(workspace, () => undefined, { maxSessions: 3 })
    assert.equal(summary.sessions.length, 3)
  })
})

describe('workspaces: real service contract and degradation', () => {
  it('returns an empty list when workspaceRegistry is missing', async () => {
    const provider = makeProvider({})
    const result = await provider.list()
    assert.deepEqual(result.workspaces, [])
    assert.match(provider.lastError ?? '', /workspaceRegistry/u)
    assert.equal(typeof result.updatedAt, 'string')
  })

  it('returns an empty list when workspaceRegistry.list throws', async () => {
    const provider = makeProvider({
      workspaceRegistry: {
        list: () => {
          throw new Error('storage is down')
        },
      },
    })
    const result = await provider.list()
    assert.deepEqual(result.workspaces, [])
    assert.match(provider.lastError ?? '', /storage is down/u)
  })

  it('still lists workspaces when sessions are unavailable', async () => {
    const provider = makeProvider({
      workspaceRegistry: {
        list: () => [{ id: 'ws', title: 'W', path: '/w', sessionIds: ['session-x'] }],
      },
    })
    const result = await provider.list()
    assert.equal(result.workspaces.length, 1)
    // The id is still accounted for, with a readable placeholder title.
    assert.equal(result.workspaces[0]?.sessions.length, 1)
    assert.equal(result.workspaces[0]?.sessions[0]?.id, 'session-x')
    assert.equal(result.workspaces[0]?.sessions[0]?.title, 'Session x')
    assert.equal(provider.partial, false)
  })

  it('skips malformed workspace rows without failing', async () => {
    const provider = makeProvider({
      workspaceRegistry: {
        list: () => [
          null,
          42,
          { id: 'ok', title: 'OK', path: '/ok', sessionIds: 'not-an-array' },
        ],
      },
    })
    const result = await provider.list()
    assert.equal(result.workspaces.length, 1)
    assert.deepEqual(result.workspaces[0]?.sessions, [])
  })

  it('degrades to live facts when persistence/projection/title/agent services throw', async () => {
    const services = baseServices({
      workspaceRegistry: {
        list: () => [{ id: 'ws', title: 'W', path: '/w', sessionIds: ['session-1'] }],
      },
      sessionPersistence: {
        list: async () => {
          throw new Error('persistence unavailable')
        },
      },
      sessionProjectionCache: {
        cachedSnapshot: () => {
          throw new Error('cache unavailable')
        },
      },
      sessionTitle: {
        get: () => {
          throw new Error('title unavailable')
        },
      },
      agents: {
        get: () => {
          throw new Error('agent unavailable')
        },
      },
    })
    const provider = makeProvider(services)
    const result = await provider.list()
    const session = result.workspaces[0]?.sessions[0]
    assert.equal(session?.id, 'session-1')
    // Title falls back to the log, updatedAt to its event time, running false.
    assert.equal(session?.title, 'Fix login')
    assert.equal(session?.updatedAt, new Date(1_700_000_100_000).toISOString())
    assert.equal(session?.running, false)
    assert.equal(provider.partial, true)
  })

  it('skips malformed persistence snapshots without failing', async () => {
    const services = baseServices({
      workspaceRegistry: {
        list: () => [{ id: 'ws', title: 'W', path: '/w', sessionIds: ['session-good'] }],
      },
      sessions: { list: () => [] },
      sessionTitle: {},
      agents: {},
      sessionProjectionCache: {},
      sessionPersistence: {
        list: async () => [
          null,
          'nope',
          { header: 'not-a-record' },
          { header: { createdAt: 1 } },
          persistedSnapshot('session-good', 1_700_000_030_000),
        ],
      },
    })
    const result = await makeProvider(services).list()
    const sessions = result.workspaces[0]?.sessions ?? []
    assert.equal(sessions.length, 1)
    assert.equal(sessions[0]?.id, 'session-good')
  })
})

describe('workspaces: collection cost (M13)', () => {
  it('folds each live log once and memoizes facts across workspaces', async () => {
    let scans = 0
    const live: FakeSession = {
      id: 'session-shared',
      header: { createdAt: 1_700_000_000_000 },
      snapshotEvents: () => {
        scans += 1
        return [
          { type: 'user/message', time: 1_700_000_001_000, data: { source: { kind: 'user' }, content: 'shared prompt' } },
        ]
      },
    }
    const services = {
      workspaceRegistry: {
        list: () => [
          { id: 'ws-a', title: 'A', path: '/a', sessionIds: ['session-shared'] },
          { id: 'ws-b', title: 'B', path: '/b', sessionIds: ['session-shared'] },
        ],
      },
      sessions: { list: () => [live] },
      sessionTitle: {},
      agents: {},
    }
    const result = await makeProvider(services).list({ refresh: true })
    assert.equal(scans, 1, 'the shared session log must be folded once per refresh')
    assert.equal(result.workspaces[0]?.sessions[0]?.title, 'shared prompt')
    assert.equal(result.workspaces[1]?.sessions[0]?.title, 'shared prompt')
  })

  it('uses seq/eventAt for recency instead of materializing the event log', async () => {
    let scans = 0
    const events = [
      { type: 'session/title', time: 1_700_000_010_000, data: { title: 'Served title' } },
      { type: 'assistant/message', time: 1_700_000_020_000, data: {} },
    ]
    const live: FakeSession = {
      id: 'session-o1',
      header: { createdAt: 1_700_000_000_000 },
      seq: events.length,
      eventAt: (seq: number) => events[seq],
      snapshotEvents: () => {
        scans += 1
        return events
      },
    }
    const services = {
      workspaceRegistry: {
        list: () => [{ id: 'ws', title: 'W', path: '/w', sessionIds: ['session-o1'] }],
      },
      sessions: { list: () => [live] },
      sessionTitle: { get: () => ({ title: 'Served title' }) },
      agents: {},
    }
    const result = await makeProvider(services).list({ refresh: true })
    assert.equal(scans, 0, 'title service + eventAt should avoid a full log fold')
    assert.equal(result.workspaces[0]?.sessions[0]?.title, 'Served title')
    assert.equal(result.workspaces[0]?.sessions[0]?.updatedAt, new Date(1_700_000_020_000).toISOString())
  })

  it('caps expensive fact lookups per refresh and still lists every row', async () => {
    let scans = 0
    const sessions = Array.from({ length: 40 }, (_, index) => ({
      id: `session-${index}`,
      header: { createdAt: 1_700_000_000_000 + index },
      snapshotEvents: () => {
        scans += 1
        return [{ type: 'user/message', time: 1_700_000_000_500 + index, data: { source: { kind: 'user' }, content: `prompt ${index}` } }]
      },
    }))
    const services = {
      workspaceRegistry: {
        list: () => [{
          id: 'ws',
          title: 'W',
          path: '/w',
          sessionIds: sessions.map(session => session.id),
        }],
      },
      sessions: { list: () => sessions },
      sessionTitle: {},
      agents: {},
    }
    const provider = makeProvider(services, { maxFactsPerRefresh: 10, maxSessionsPerWorkspace: 100 })
    const result = await provider.list({ refresh: true })
    assert.equal(result.workspaces[0]?.sessions.length, 40)
    assert.ok(scans <= 10, `expected at most 10 log folds, saw ${scans}`)
    assert.equal(provider.partial, true, 'truncated facts must be reported as partial')
  })

  it('caps the session rows collected per workspace before folding logs', async () => {
    let scans = 0
    const sessions = Array.from({ length: 10 }, (_, index) => ({
      id: `session-${index}`,
      header: { createdAt: 1_700_000_000_000 + index },
      snapshotEvents: () => {
        scans += 1
        return []
      },
    }))
    const services = {
      workspaceRegistry: {
        list: () => [{ id: 'ws', title: 'W', path: '/w', sessionIds: sessions.map(session => session.id) }],
      },
      sessions: { list: () => sessions },
      sessionTitle: {},
      agents: {},
    }
    const result = await makeProvider(services, {
      maxSessionsPerWorkspace: 3,
      maxFactsPerRefresh: 100,
    }).list({ refresh: true })
    assert.equal(result.workspaces[0]?.sessions.length, 3)
    assert.equal(scans, 3)
  })
})

describe('workspaces: wire budget (H2)', () => {
  it('keeps the most recent sessions and stays under the serialized budget', () => {
    const iso = (offset: number): string => new Date(1_700_000_000_000 - offset * 1000).toISOString()
    const workspaces = Array.from({ length: 12 }, (_, workspaceIndex) => ({
      id: `ws-${workspaceIndex}`,
      title: `Workspace ${workspaceIndex}`,
      path: `/workspace/${workspaceIndex}`,
      sessions: Array.from({ length: 200 }, (_, sessionIndex) => {
        const id = `s-${workspaceIndex}-${sessionIndex}`
        return mapSessionSummary(id, { title: `A descriptive session title for ${id}`, updatedAt: iso(workspaceIndex * 200 + sessionIndex) }, iso(0))
      }),
    }))
    const limited = limitWorkspaceListing(workspaces)
    assert.equal(limited.truncated, true)
    assert.equal(limited.workspaces.length, 12)
    const total = limited.workspaces.reduce((sum, workspace) => sum + workspace.sessions.length, 0)
    assert.ok(total <= MAX_TOTAL_SESSIONS_PER_LISTING, `kept ${total} sessions`)
    assert.ok(
      new TextEncoder().encode(JSON.stringify(limited.workspaces)).byteLength <= MAX_WORKSPACES_RESULT_BYTES,
      'listing exceeded the serialized budget',
    )
    // The globally newest session survives the cap.
    assert.equal(limited.workspaces[0]?.sessions[0]?.id, 's-0-0')
  })

  it('provider results fit one sealed RPC message for a large profile', async () => {
    const workspaces = Array.from({ length: 5 }, (_, workspaceIndex) => {
      const sessionIds = Array.from({ length: 100 }, (_, sessionIndex) => `s-${workspaceIndex}-${sessionIndex}`)
      return { id: `ws-${workspaceIndex}`, title: `Workspace ${workspaceIndex}`, path: `/workspace/${workspaceIndex}`, sessionIds }
    })
    const sessions = workspaces.flatMap((workspace, workspaceIndex) => workspace.sessionIds.map((id, sessionIndex) =>
      sessionFacts(
        id,
        `A deliberately long session title for ${id} that makes the listing payload larger`,
        1_700_000_000_000 - (workspaceIndex * 100 + sessionIndex) * 1000,
      )))
    const provider = makeProvider({
      workspaceRegistry: { list: () => workspaces },
      sessions: { list: () => sessions },
    })
    const result = await provider.list({ refresh: true })
    assert.equal(result.truncated, true)
    const total = result.workspaces.reduce((sum, workspace) => sum + workspace.sessions.length, 0)
    assert.ok(total <= MAX_TOTAL_SESSIONS_PER_LISTING, `kept ${total} sessions`)
    assert.ok(provider.partial, 'truncation must be reported through diagnostics')
    const envelopeBytes = new TextEncoder().encode(JSON.stringify({ id: 1, result })).byteLength
    assert.ok(envelopeBytes < 64 * 1024, `envelope was ${envelopeBytes} bytes`)
  })
})

describe('workspaces: cache', () => {
  it('caches for 60 s and refreshes on demand', async () => {
    let clock = 1_000_000
    let listCalls = 0
    const services = baseServices({
      workspaceRegistry: {
        list: () => {
          listCalls += 1
          return []
        },
      },
    })
    const provider = makeProvider(services, { now: () => clock })
    await provider.list()
    await provider.list()
    assert.equal(listCalls, 1)
    clock += 59_000
    await provider.list()
    assert.equal(listCalls, 1)
    clock += 2_000
    await provider.list()
    assert.equal(listCalls, 2)
    await provider.list({ refresh: true })
    assert.equal(listCalls, 3)
    assert.ok((provider.cacheAgeMs ?? 0) >= 0)
  })
})
