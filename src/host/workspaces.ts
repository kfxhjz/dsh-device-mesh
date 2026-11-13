/**
 * Local workspace / session discovery for the device mesh.
 *
 * The host plugin runs inside the DSH Node process, so it reads the same
 * `ctx.workspaceRegistry`, `ctx.sessions`, `ctx.sessionTitle`, `ctx.agents` and
 * (optionally) `ctx.sessionPersistence` services the built-in UI reads. This
 * module is deliberately *defensive*: any service may be missing, renamed, or
 * throwing (e.g. a profile that composes a reduced DSH surface), and the answer
 * degrades to an empty list with a logged warning instead of breaking the
 * plugin or the DSH host.
 *
 * Results are cached for {@link WORKSPACE_CACHE_MS} (60 s); callers pass
 * `refresh: true` to bypass the cache.
 */

import type {
  SessionSummary,
  WorkspaceSummary,
  WorkspacesResult,
} from '../shared/protocol.ts'
import { MeshRpcError } from '../shared/mesh-session.ts'
import { getHostService, isRecord, serviceMethod, silentLogger, WORKSPACE_CACHE_MS } from './config.ts'
import type { HostContextLike, MeshLogger } from './config.ts'

/** Maximum sessions reported per workspace (protects the wire/frame budget; PROTOCOL §7.1). */
export const MAX_SESSIONS_PER_WORKSPACE = 200

/** Maximum workspaces in one listing (keeps a huge profile under the wire cap). */
export const MAX_WORKSPACES_PER_LISTING = 100

/**
 * Maximum sessions across the whole listing. One RPC result must fit a single
 * sealed message (64 KiB), so the per-workspace cap alone is not enough.
 */
export const MAX_TOTAL_SESSIONS_PER_LISTING = 200

/** Serialized-size budget for the listing, leaving room for the RPC envelope. */
export const MAX_WORKSPACES_RESULT_BYTES = 60 * 1024

/**
 * Maximum expensive session-fact lookups (live log folds, persistence cache
 * reads) one refresh may perform across every workspace. Sessions beyond the
 * budget still appear, but with conservative placeholder facts, so a huge
 * profile cannot block the host's event loop for an unbounded time.
 */
export const MAX_SESSION_FACTS_PER_REFRESH = 2_000

/** Conservative recency key for one session summary. */
function sessionRecency(summary: SessionSummary): number {
  const time = Date.parse(summary.updatedAt)
  return Number.isFinite(time) ? time : 0
}

/**
 * Bound a workspace listing so its JSON fits one Mesh control frame.
 *
 * The listing keeps the globally most-recent sessions first (so a cap does not
 * always starve the workspaces that sort last), then drops the least-recent
 * session until the serialized size fits. Workspaces stay visible even when all
 * of their sessions are trimmed. A single oversized workspace title/path is
 * dropped as a last resort.
 *
 * @param workspaces - fully mapped listing, already sorted per workspace.
 * @param options - caps; defaults are the wire-budget constants above.
 * @returns the bounded listing plus whether anything was dropped.
 */
export function limitWorkspaceListing(
  workspaces: readonly WorkspaceSummary[],
  options: {
    readonly maxWorkspaces?: number
    readonly maxSessions?: number
    readonly maxBytes?: number
  } = {},
): { readonly workspaces: WorkspaceSummary[]; readonly truncated: boolean } {
  const maxWorkspaces = options.maxWorkspaces ?? MAX_WORKSPACES_PER_LISTING
  const maxSessions = options.maxSessions ?? MAX_TOTAL_SESSIONS_PER_LISTING
  const maxBytes = options.maxBytes ?? MAX_WORKSPACES_RESULT_BYTES
  let truncated = workspaces.length > maxWorkspaces
  let limited: WorkspaceSummary[] = workspaces
    .slice(0, maxWorkspaces)
    .map(workspace => ({ ...workspace, sessions: [...workspace.sessions] }))

  const ranked: Array<{ readonly workspace: number; readonly session: SessionSummary }> = []
  limited.forEach((workspace, index) => {
    for (const session of workspace.sessions) ranked.push({ workspace: index, session })
  })
  ranked.sort((left, right) => sessionRecency(right.session) - sessionRecency(left.session))
  if (ranked.length > maxSessions) truncated = true
  const kept = new Map<number, SessionSummary[]>()
  for (const entry of ranked.slice(0, maxSessions)) {
    const list = kept.get(entry.workspace) ?? []
    list.push(entry.session)
    kept.set(entry.workspace, list)
  }
  limited = limited.map((workspace, index) => ({
    ...workspace,
    sessions: (kept.get(index) ?? []).sort((left, right) => sessionRecency(right) - sessionRecency(left)),
  }))

  const bytes = (value: readonly WorkspaceSummary[]): number =>
    new TextEncoder().encode(JSON.stringify(value)).byteLength
  while (bytes(limited) > maxBytes) {
    let target = -1
    let oldest = Number.POSITIVE_INFINITY
    limited.forEach((workspace, index) => {
      const last = workspace.sessions[workspace.sessions.length - 1]
      if (last === undefined) return
      const time = sessionRecency(last)
      if (time < oldest) {
        oldest = time
        target = index
      }
    })
    if (target < 0) break
    limited = limited.map((workspace, index) => index === target
      ? { ...workspace, sessions: workspace.sessions.slice(0, -1) }
      : workspace)
    truncated = true
  }
  while (bytes(limited) > maxBytes && limited.length > 0) {
    limited = limited.slice(0, -1)
    truncated = true
  }
  return { workspaces: limited, truncated }
}

/** Facts extracted from one DSH session. */
export interface SessionFacts {
  readonly title?: string
  readonly updatedAt?: string
  readonly running?: boolean
  readonly awaitingUser?: boolean
  readonly unread?: boolean
  readonly archived?: boolean
}

/** Facts extracted from one DSH workspace. */
export interface WorkspaceFacts {
  readonly id: string
  readonly title: string
  readonly path: string
  readonly sessionIds: readonly string[]
}

/** Build one wire `SessionSummary`. */
export function mapSessionSummary(
  id: string,
  facts: SessionFacts | undefined,
  fallbackUpdatedAt: string,
): SessionSummary {
  return {
    id,
    title: facts?.title !== undefined && facts.title.length > 0 ? facts.title : defaultSessionTitle(id),
    updatedAt: facts?.updatedAt ?? fallbackUpdatedAt,
    running: facts?.running ?? false,
    awaitingUser: facts?.awaitingUser ?? false,
    unread: facts?.unread ?? false,
    ...(facts?.archived === true ? { archived: true } : {}),
  }
}

/** Build one wire `WorkspaceSummary` from facts plus a session lookup. */
export function mapWorkspaceSummary(
  workspace: WorkspaceFacts,
  sessionFacts: (sessionId: string) => SessionFacts | undefined,
  options: { readonly now?: () => number; readonly maxSessions?: number } = {},
): WorkspaceSummary {
  const limit = options.maxSessions ?? MAX_SESSIONS_PER_WORKSPACE
  const fallback = new Date((options.now ?? Date.now)()).toISOString()
  const sessions = workspace.sessionIds
    .slice(0, limit)
    .map(sessionId => mapSessionSummary(sessionId, sessionFacts(sessionId), fallback))
    .sort((left, right) => {
      const byTime = Date.parse(right.updatedAt) - Date.parse(left.updatedAt)
      return Number.isFinite(byTime) && byTime !== 0 ? byTime : left.id.localeCompare(right.id)
    })
  return {
    id: workspace.id,
    title: workspace.title.length > 0 ? workspace.title : workspace.path,
    path: workspace.path,
    sessions,
  }
}

/** Short fallback title for a session with no readable title event. */
function defaultSessionTitle(id: string): string {
  return id.startsWith('session-') ? `Session ${id.slice('session-'.length)}` : id
}

// ---------------------------------------------------------------------------
// Defensive extraction from DSH objects (structural, no DSH imports)
// ---------------------------------------------------------------------------

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function isoFromMillis(value: unknown): string | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString()
}

function isoFromTimestamp(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    return Number.isNaN(parsed) ? undefined : new Date(parsed).toISOString()
  }
  return isoFromMillis(value)
}

/**
 * Extract readable text from a DSH message content value (string or content
 * block array). Used only as a title fallback before the title service runs.
 */
function messageText(content: unknown): string | undefined {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return undefined
  const parts: string[] = []
  for (const block of content) {
    if (typeof block === 'string') {
      parts.push(block)
    } else if (isRecord(block) && typeof block.text === 'string') {
      parts.push(block.text)
    }
  }
  const text = parts.join(' ').replace(/\s+/gu, ' ').trim()
  return text.length > 0 ? text : undefined
}

function truncate(text: string, max = 80): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`
}

function readEvents(session: unknown): readonly unknown[] {
  if (!isRecord(session) && typeof session !== 'object') return []
  if (session === null) return []
  const snapshot = Reflect.get(session, 'snapshotEvents')
  if (typeof snapshot !== 'function') return []
  try {
    const events: unknown = snapshot.call(session)
    return Array.isArray(events) ? events : []
  } catch {
    return []
  }
}

function eventTime(event: unknown): number | undefined {
  if (!isRecord(event)) return undefined
  const time = event.time
  return typeof time === 'number' && Number.isFinite(time) ? time : undefined
}

function eventType(event: unknown): string | undefined {
  if (!isRecord(event)) return undefined
  return typeof event.type === 'string' ? event.type : undefined
}

function eventData(event: unknown): Record<string, unknown> | undefined {
  if (!isRecord(event)) return undefined
  const data = event.data
  return isRecord(data) ? data : undefined
}

/** Facts folded from one session event log in a single pass. */
interface FoldedEvents {
  /** Latest `session/title` text, if the log carries one. */
  readonly title?: string
  /** First human message text, used only when no title event exists. */
  readonly firstUserMessage?: string
  /** Latest event timestamp as an ISO string. */
  readonly updatedAt?: string
}

/**
 * Fold a session log once for the three facts the workspace list needs.
 *
 * The previous implementation walked the same event array three separate times
 * (reverse title scan, forward first-message scan, forward timestamp scan).
 * One pass keeps a refresh proportional to the log size with a small constant.
 * @param events - detached session event array (`Session.snapshotEvents()`).
 * @returns title/fallback/updatedAt facts.
 */
function foldEvents(events: readonly unknown[]): FoldedEvents {
  let title: string | undefined
  let firstUserMessage: string | undefined
  let latestTime: number | undefined
  for (const event of events) {
    const time = eventTime(event)
    if (time !== undefined && (latestTime === undefined || time > latestTime)) latestTime = time
    const type = eventType(event)
    if (type === 'session/title') {
      const data = eventData(event)
      const candidate = data !== undefined ? stringOrUndefined(data.title) : undefined
      if (candidate !== undefined) title = candidate
    } else if (type === 'user/message' && firstUserMessage === undefined) {
      const data = eventData(event)
      if (data === undefined) continue
      const source = data.source
      if (isRecord(source) && typeof source.kind === 'string' && source.kind !== 'user') continue
      const text = messageText(data.content)
      if (text !== undefined) firstUserMessage = truncate(text)
    }
  }
  const updatedAt = isoFromMillis(latestTime)
  return {
    ...(title !== undefined ? { title } : {}),
    ...(firstUserMessage !== undefined ? { firstUserMessage } : {}),
    ...(updatedAt !== undefined ? { updatedAt } : {}),
  }
}

/** Read `session.header` as a plain record. */
function headerOf(session: unknown): Record<string, unknown> | undefined {
  if (!isRecord(session)) return undefined
  const header = session.header
  return isRecord(header) ? header : undefined
}

/** Read `session.header.createdAt` as an ISO timestamp. */
function headerCreatedAt(session: unknown): string | undefined {
  const header = headerOf(session)
  return header === undefined ? undefined : isoFromTimestamp(header.createdAt)
}

/** Read the first timestamp-shaped field present on one record. */
function firstTimestamp(record: Record<string, unknown> | undefined, names: readonly string[]): string | undefined {
  if (record === undefined) return undefined
  for (const name of names) {
    const value = isoFromTimestamp(record[name])
    if (value !== undefined) return value
  }
  return undefined
}

/**
 * Read the last event timestamp without materializing the whole log when the
 * Session exposes `seq`/`eventAt` (the real DSH Session does).
 * @param session - live session-like object.
 * @returns ISO timestamp of the final event, or undefined when unavailable.
 */
function lastEventTimestampO1(session: unknown): string | undefined {
  if (!isRecord(session)) return undefined
  const seq = session.seq
  const eventAt = session.eventAt
  if (typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq <= 0) return undefined
  if (typeof eventAt !== 'function') return undefined
  try {
    return isoFromMillis(eventTime(eventAt.call(session, seq - 1)))
  } catch {
    return undefined
  }
}

/** Read a live title through `sessionTitle.get`, tolerating a reduced service. */
function titleFromService(
  getTitle: ((...args: unknown[]) => unknown) | undefined,
  session: unknown,
): string | undefined {
  if (getTitle === undefined) return undefined
  try {
    const snapshot: unknown = getTitle(session)
    return isRecord(snapshot) ? stringOrUndefined(snapshot.title) : undefined
  } catch {
    return undefined
  }
}

/** Read a session id from a DSH session object. */
function sessionIdOf(session: unknown): string | undefined {
  if (!isRecord(session)) return undefined
  return stringOrUndefined(session.id)
}

/**
 * Read the registry-global archive set. A reduced composition or a renamed
 * service yields an empty set: the listing still works and simply reports no
 * archived sessions instead of failing.
 */
function archivedIdsOf(registry: unknown): Set<string> {
  const ids = new Set<string>()
  if (registry === undefined || registry === null) return ids
  let value: unknown
  try {
    value = Reflect.get(registry, 'archivedSessionIds')
  } catch {
    return ids
  }
  if (!Array.isArray(value)) return ids
  for (const id of value) {
    if (typeof id === 'string' && id.length > 0) ids.add(id)
  }
  return ids
}

// ---------------------------------------------------------------------------
// Persisted session snapshots (ctx.sessionPersistence.list)
// ---------------------------------------------------------------------------

/**
 * Facts retained from one `SessionPersistenceSnapshot`.
 *
 * Real DSH `list()` returns `readonly SessionPersistenceSnapshot[]`, where each
 * snapshot is `{ header: SessionHeader, revision, ... }` and `SessionHeader`
 * carries `id`/`createdAt`/`cwd` but no title or update time. The title and
 * recency supplied by DSH's own session list come from projections
 * (`sessionProjectionCache`); we read those defensively when composed, and
 * otherwise degrade to createdAt + a readable placeholder title.
 */
interface PersistedSessionFacts {
  readonly createdAt?: string
  readonly updatedAt?: string
  readonly title?: string
}

/** Normalize one `list()` item to its header, accepting a bare header too. */
function persistedHeaderOf(item: unknown): Record<string, unknown> | undefined {
  if (!isRecord(item)) return undefined
  const nested = item.header
  if (isRecord(nested)) return nested
  // Compatibility with reduced/older stores that returned the header itself.
  return item
}

/** Read projection-cache title/metadata without letting cache faults escape. */
function projectionFacts(
  header: Record<string, unknown>,
  cachedSnapshot: ((...args: unknown[]) => unknown) | undefined,
  cachedPredecessorTitle: ((...args: unknown[]) => unknown) | undefined,
): { readonly title?: string; readonly updatedAt?: string } {
  let title: string | undefined
  let updatedAt: string | undefined
  if (cachedSnapshot !== undefined) {
    try {
      const block: unknown = cachedSnapshot(header)
      if (isRecord(block) && isRecord(block.values)) {
        const values = block.values
        title = stringOrUndefined(values.title)
        const metadata = values.sessionListMetadata
        if (isRecord(metadata)) updatedAt = isoFromTimestamp(metadata.lastPromptAt)
      }
    } catch {
      // Projection cache is an optimization; persistence facts still work without it.
    }
  }
  if (title === undefined && cachedPredecessorTitle !== undefined) {
    try {
      const block: unknown = cachedPredecessorTitle(header)
      if (isRecord(block) && isRecord(block.values)) {
        title = stringOrUndefined(block.values.title)
      }
    } catch {
      // A stale/incompatible checkpoint must not hide the session.
    }
  }
  return {
    ...(title !== undefined ? { title } : {}),
    ...(updatedAt !== undefined ? { updatedAt } : {}),
  }
}

/** Extract persisted facts from one snapshot plus optional projection cache. */
function persistedFactsOf(
  header: Record<string, unknown>,
  snapshot: Record<string, unknown> | undefined,
  projection: { readonly title?: string; readonly updatedAt?: string },
): PersistedSessionFacts {
  const createdAt = firstTimestamp(header, ['createdAt'])
    ?? (snapshot !== undefined && snapshot !== header ? firstTimestamp(snapshot, ['createdAt']) : undefined)
  const directUpdatedAt = firstTimestamp(header, ['updatedAt', 'lastActivityAt', 'lastPromptAt'])
    ?? (snapshot !== undefined && snapshot !== header
      ? firstTimestamp(snapshot, ['updatedAt', 'lastActivityAt', 'lastPromptAt'])
      : undefined)
  const directTitle = stringOrUndefined(header.title)
    ?? (snapshot !== undefined && snapshot !== header ? stringOrUndefined(snapshot.title) : undefined)
  const title = directTitle ?? projection.title
  const updatedAt = directUpdatedAt ?? projection.updatedAt ?? createdAt
  return {
    ...(createdAt !== undefined ? { createdAt } : {}),
    ...(updatedAt !== undefined ? { updatedAt } : {}),
    ...(title !== undefined ? { title } : {}),
  }
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

/** Options for {@link WorkspaceProvider}. */
export interface WorkspaceProviderOptions {
  /** Cordis host context (preferred: reads services through `ctx.get`). */
  readonly ctx?: HostContextLike
  /** Test seam replacing `ctx.get`. */
  readonly getService?: (name: string) => unknown
  readonly logger?: MeshLogger
  readonly now?: () => number
  readonly cacheMs?: number
  readonly maxSessionsPerWorkspace?: number
  /** Maximum workspaces in one listing (default {@link MAX_WORKSPACES_PER_LISTING}). */
  readonly maxWorkspaces?: number
  /** Maximum sessions across the listing (default {@link MAX_TOTAL_SESSIONS_PER_LISTING}). */
  readonly maxTotalSessions?: number
  /** Serialized-size budget for the listing (default {@link MAX_WORKSPACES_RESULT_BYTES}). */
  readonly maxResultBytes?: number
  /** Cap on expensive session-fact lookups per refresh (default {@link MAX_SESSION_FACTS_PER_REFRESH}). */
  readonly maxFactsPerRefresh?: number
}

interface CacheEntry {
  readonly at: number
  readonly value: WorkspacesResult
}

/**
 * Lists local DSH workspaces and their sessions for the mesh `workspaces.list`
 * RPC and the local `workspaces.refresh` endpoint.
 */
export class WorkspaceProvider {
  private readonly getService: (name: string) => unknown
  private readonly logger: MeshLogger
  private readonly now: () => number
  private readonly cacheMs: number
  private readonly maxSessions: number
  private readonly maxWorkspaces: number
  private readonly maxTotalSessions: number
  private readonly maxResultBytes: number
  private readonly maxFacts: number
  private cache: CacheEntry | undefined
  private lastErrorValue: string | undefined
  private partialValue = false

  constructor(options: WorkspaceProviderOptions = {}) {
    const getter = options.getService
    this.getService = getter ?? ((name: string) => getHostService(options.ctx, name))
    this.logger = options.logger ?? silentLogger
    this.now = options.now ?? Date.now
    this.cacheMs = options.cacheMs ?? WORKSPACE_CACHE_MS
    this.maxSessions = options.maxSessionsPerWorkspace ?? MAX_SESSIONS_PER_WORKSPACE
    this.maxWorkspaces = options.maxWorkspaces ?? MAX_WORKSPACES_PER_LISTING
    this.maxTotalSessions = options.maxTotalSessions ?? MAX_TOTAL_SESSIONS_PER_LISTING
    this.maxResultBytes = options.maxResultBytes ?? MAX_WORKSPACES_RESULT_BYTES
    this.maxFacts = options.maxFactsPerRefresh ?? MAX_SESSION_FACTS_PER_REFRESH
  }

  /** Last collection error (diagnostics only; never secrets). */
  get lastError(): string | undefined {
    return this.lastErrorValue
  }

  /** True when at least one session/workspace datum was dropped while collecting. */
  get partial(): boolean {
    return this.partialValue
  }

  /** Age of the current cache in milliseconds, if any. */
  get cacheAgeMs(): number | undefined {
    return this.cache === undefined ? undefined : this.now() - this.cache.at
  }

  /** Drop the cached answer (e.g. after the plugin notices a workspace change). */
  invalidate(): void {
    this.cache = undefined
  }

  /**
   * Resolve the workspace that currently accounts for one Session.
   *
   * Used to enforce a controller's workspace allowlist for mutations without
   * depending on the bounded/truncated listing. Returns undefined when the
   * Session is unknown or the registry is unavailable.
   * @param sessionId - Session to look up.
   */
  async workspaceIdOf(sessionId: string): Promise<string | undefined> {
    const registry = this.service('workspaceRegistry')
    const listWorkspaces = serviceMethod(registry, 'list')
    if (listWorkspaces === undefined) return undefined
    let raw: unknown
    try {
      raw = await listWorkspaces()
    } catch {
      return undefined
    }
    if (!Array.isArray(raw)) return undefined
    for (const workspace of raw) {
      if (!isRecord(workspace)) continue
      const id = stringOrUndefined(workspace.id)
      const sessionIds = Array.isArray(workspace.sessionIds) ? workspace.sessionIds : []
      if (id !== undefined && sessionIds.includes(sessionId)) return id
    }
    return undefined
  }

  /**
   * Add one Session to the daemon's registry-global archive set.
   *
   * The archive set is the same one the native DSH sidebar uses, so a remote
   * archive action is visible to the daemon's local user immediately.
   * @param sessionId - Session to archive.
   * @param options - `stopActivity` stops running work before archiving.
   */
  async archiveSession(sessionId: string, options: { readonly stopActivity?: boolean } = {}): Promise<void> {
    await this.mutateArchive('archiveSession', sessionId, options)
  }

  /** Remove one Session from the daemon's archive set (idempotent). */
  async unarchiveSession(sessionId: string): Promise<void> {
    await this.mutateArchive('unarchiveSession', sessionId, {})
  }

  private async mutateArchive(
    method: 'archiveSession' | 'unarchiveSession',
    sessionId: string,
    options: { readonly stopActivity?: boolean },
  ): Promise<void> {
    const registry = this.service('workspaceRegistry')
    const mutate = serviceMethod(registry, method)
    if (mutate === undefined) {
      throw new MeshRpcError(
        'mesh/unsupported',
        `workspaceRegistry.${method} is unavailable on this host`,
      )
    }
    try {
      await mutate(sessionId, options)
    } catch (error) {
      // DSH's domain errors carry stable names but no wire code, so preserve
      // them here; otherwise the controller only sees a generic mesh/internal.
      if (error instanceof Error) {
        if (error.name === 'WorkspaceActiveSessionError') {
          throw new MeshRpcError('workspace/session-active', error.message)
        }
        if (error.name === 'WorkspaceUnknownSessionError') {
          throw new MeshRpcError('session/not-found', error.message)
        }
      }
      throw error
    } finally {
      // Even a refused archive can change activity state; never serve a stale
      // archived flag on the next listing.
      this.invalidate()
    }
  }

  /**
   * List workspaces and session summaries.
   * @param options - `refresh` bypasses the 60 s cache.
   * @returns wire result; never throws.
   */
  async list(options: { readonly refresh?: boolean } = {}): Promise<WorkspacesResult> {
    const now = this.now()
    if (options.refresh !== true && this.cache !== undefined && now - this.cache.at < this.cacheMs) {
      return this.cache.value
    }
    let value: WorkspacesResult
    try {
      value = await this.collect()
    } catch (error) {
      this.lastErrorValue = error instanceof Error ? error.message : String(error)
      this.logger.warn(`device-mesh: workspace listing failed: ${this.lastErrorValue}`)
      value = { updatedAt: new Date(now).toISOString(), workspaces: [] }
    }
    this.cache = { at: now, value }
    return value
  }

  private async collect(): Promise<WorkspacesResult> {
    this.partialValue = false
    const updatedAt = new Date(this.now()).toISOString()
    const registry = this.service('workspaceRegistry')
    const listWorkspaces = serviceMethod(registry, 'list')
    if (listWorkspaces === undefined) {
      this.lastErrorValue = 'workspaceRegistry service is unavailable'
      return { updatedAt, workspaces: [] }
    }
    const archivedSessionIds = archivedIdsOf(registry)
    let rawWorkspaces: unknown
    try {
      rawWorkspaces = await listWorkspaces()
    } catch (error) {
      this.lastErrorValue = error instanceof Error ? error.message : String(error)
      this.logger.warn(`device-mesh: workspaceRegistry.list failed: ${this.lastErrorValue}`)
      return { updatedAt, workspaces: [] }
    }
    if (!Array.isArray(rawWorkspaces)) return { updatedAt, workspaces: [] }

    const sessions = this.service('sessions')
    const liveById = new Map<string, unknown>()
    const listSessions = serviceMethod(sessions, 'list')
    if (listSessions !== undefined) {
      try {
        const live: unknown = await listSessions()
        if (Array.isArray(live)) {
          for (const session of live) {
            const id = sessionIdOf(session)
            if (id !== undefined) liveById.set(id, session)
          }
        }
      } catch (error) {
        this.partialValue = true
        this.logger.warn(`device-mesh: sessions.list failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }

    // Resolve the projection cache once; a lookup per persisted session would
    // dominate a large listing.
    const projectionCache = this.service('sessionProjectionCache')
    const cachedSnapshot = serviceMethod(projectionCache, 'cachedSnapshot')
    const cachedPredecessorTitle = serviceMethod(projectionCache, 'cachedPredecessorTitle')

    // Persisted snapshots cover sessions that exist on disk but are not live
    // (e.g. closed tabs). Real DSH `list()` returns
    // `{ header: SessionHeader, revision, ... }`, not a bare header; reading
    // `item.id` directly silently discarded every persisted row.
    const persistedById = new Map<string, PersistedSessionFacts>()
    const persistence = this.service('sessionPersistence')
    const listPersisted = serviceMethod(persistence, 'list')
    if (listPersisted !== undefined) {
      try {
        const snapshots: unknown = await listPersisted()
        if (Array.isArray(snapshots)) {
          for (const item of snapshots) {
            const header = persistedHeaderOf(item)
            const id = header !== undefined ? stringOrUndefined(header.id) : undefined
            if (header === undefined || id === undefined) continue
            persistedById.set(id, persistedFactsOf(
              header,
              isRecord(item) ? item : undefined,
              projectionFacts(header, cachedSnapshot, cachedPredecessorTitle),
            ))
          }
        }
      } catch {
        // Persistence is optional; live sessions are enough for a degraded answer.
        this.partialValue = true
      }
    }

    const titleService = this.service('sessionTitle')
    const getTitle = serviceMethod(titleService, 'get')
    const agents = this.service('agents')
    const getAgent = serviceMethod(agents, 'get')

    const factsCache = new Map<string, SessionFacts | undefined>()
    let factsBudget = this.maxFacts
    const factsFor = (sessionId: string): SessionFacts | undefined => {
      if (factsCache.has(sessionId)) return factsCache.get(sessionId)
      const archived = archivedSessionIds.has(sessionId)
      const live = liveById.get(sessionId)
      const persisted = persistedById.get(sessionId)
      if (live === undefined && persisted === undefined) {
        const facts = archived ? { archived: true } : undefined
        factsCache.set(sessionId, facts)
        return facts
      }
      if (factsBudget <= 0) {
        // The row still renders with placeholder facts; signal degraded data.
        this.partialValue = true
        const facts = archived ? { archived: true } : undefined
        factsCache.set(sessionId, facts)
        return facts
      }
      factsBudget -= 1

      let facts: SessionFacts
      if (live !== undefined) {
        // `sessionTitle.get` folds the log itself; only scan once when it does
        // not answer, and derive recency from a single terminal-event read when
        // the Session exposes seq/eventAt.
        let title = titleFromService(getTitle, live)
        let folded: FoldedEvents | undefined
        if (title === undefined) {
          folded = foldEvents(readEvents(live))
          title = folded.title ?? folded.firstUserMessage
        }
        const header = headerOf(live)
        let updatedAt = firstTimestamp(header, ['updatedAt', 'lastActivityAt', 'lastPromptAt'])
        updatedAt ??= lastEventTimestampO1(live)
        if (updatedAt === undefined) {
          folded ??= foldEvents(readEvents(live))
          updatedAt = folded.updatedAt
        }
        updatedAt ??= headerCreatedAt(live)
        let running = false
        let awaitingUser = false
        if (getAgent !== undefined) {
          try {
            const agent: unknown = getAgent(sessionId)
            if (isRecord(agent)) {
              running = agent.status === 'running'
              awaitingUser = agent.awaitingUser === true
                || agent.status === 'awaiting-user'
                || agent.status === 'awaiting_user'
            }
          } catch {
            // Agent registry failures leave the row usable.
          }
        }
        facts = {
          ...(title !== undefined ? { title } : {}),
          ...(updatedAt !== undefined ? { updatedAt } : {}),
          running,
          awaitingUser,
          unread: false,
          ...(archived ? { archived: true } : {}),
        }
      } else {
        facts = {
          ...(persisted?.title !== undefined ? { title: persisted.title } : {}),
          ...(persisted?.updatedAt !== undefined ? { updatedAt: persisted.updatedAt } : {}),
          running: false,
          awaitingUser: false,
          unread: false,
          ...(archived ? { archived: true } : {}),
        }
      }
      factsCache.set(sessionId, facts)
      return facts
    }

    const workspaces: WorkspaceSummary[] = []
    for (const raw of rawWorkspaces) {
      if (!isRecord(raw)) continue
      const id = stringOrUndefined(raw.id)
      if (id === undefined) continue
      const path = stringOrUndefined(raw.path) ?? ''
      const title = stringOrUndefined(raw.title) ?? path
      const sessionIds = Array.isArray(raw.sessionIds)
        ? raw.sessionIds.filter((item): item is string => typeof item === 'string')
        : []
      workspaces.push(mapWorkspaceSummary(
        { id, title, path, sessionIds },
        factsFor,
        { now: this.now, maxSessions: this.maxSessions },
      ))
    }
    const limited = limitWorkspaceListing(workspaces, {
      maxWorkspaces: this.maxWorkspaces,
      maxSessions: this.maxTotalSessions,
      maxBytes: this.maxResultBytes,
    })
    if (limited.truncated) this.partialValue = true
    this.lastErrorValue = undefined
    return {
      updatedAt,
      workspaces: limited.workspaces,
      ...(limited.truncated ? { truncated: true } : {}),
    }
  }

  private service(name: string): unknown {
    try {
      return this.getService(name)
    } catch (error) {
      this.logger.debug(`device-mesh: service ${name} lookup failed: ${error instanceof Error ? error.message : String(error)}`)
      return undefined
    }
  }

  /** Stop any pending work (currently none; the provider is synchronous). */
  dispose(): void {
    this.cache = undefined
  }
}

/**
 * Convenience factory: build a provider bound to a Cordis host context.
 * @param ctx - host context.
 * @param logger - warning sink.
 * @returns provider instance.
 */
export function createWorkspaceProvider(
  ctx: HostContextLike,
  logger?: MeshLogger,
): WorkspaceProvider {
  return new WorkspaceProvider({ ctx, ...(logger !== undefined ? { logger } : {}) })
}
