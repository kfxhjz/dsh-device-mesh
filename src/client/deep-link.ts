/**
 * Deep links between the parent shell and the remote DSH UI.
 *
 * The parent embeds the remote DSH GUI in an iframe and can ask it to open a
 * particular Session or create a new one in a Workspace. DSH's SPA has no URL
 * router for Sessions, so the remote copy of this plugin performs the
 * navigation once the Workspace service is available. Both sides run the same
 * package; a local shell without the parameters is untouched.
 *
 * New-Session requests carry a request id because they are delivered twice: in
 * the portal URL/sessionStorage at boot and as retried postMessages while the
 * iframe settles. The id makes the two delivery paths idempotent.
 */
import type { ClientContext, RemoteNewSessionRequest } from './types.js'

/** sessionStorage key populated by the portal's injected embed shell. */
const NEW_SESSION_KEY = 'dsh-device-mesh:dm-new-session'

/** Request ids already handed to `uiWorkspace.startSession`. */
const handledNewSessionIds = new Set<string>()
/** Request ids waiting for `uiWorkspace` to become available. */
const pendingNewSessionIds = new Set<string>()

/** Bound the dedupe set; request ids are short-lived navigation tokens. */
function rememberHandledNewSession(requestId: string): void {
  if (handledNewSessionIds.size >= 100) handledNewSessionIds.clear()
  handledNewSessionIds.add(requestId)
}

/** Validate one navigation id without accepting unbounded peer input. */
function requestValue(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > 256) return null
  return value
}

/** Build a new-session request from two untyped fields. */
function newSessionRequest(workspaceId: unknown, requestId: unknown): RemoteNewSessionRequest | null {
  const workspace = requestValue(workspaceId)
  const request = requestValue(requestId)
  return workspace === null || request === null
    ? null
    : { workspaceId: workspace, requestId: request }
}

/** Report a failure the parent can surface; the remote shell itself has no notice. */
function reportNewSessionFailure(requestId: string, cause: unknown): void {
  if (typeof window === 'undefined' || window.parent === window) return
  try {
    window.parent.postMessage({
      source: 'dsh-device-mesh-remote',
      kind: 'new-session-failed',
      requestId,
      message: (cause instanceof Error ? cause.message : String(cause)).slice(0, 300),
    }, '*')
  } catch { /* parent is gone */ }
}

type WorkspaceNavigation = {
  readonly openSession?: (target: unknown) => void
  readonly startSession?: (workspaceId?: unknown) => void
}

function workspaceNavigation(ctx: ClientContext): WorkspaceNavigation | undefined {
  return ctx.get?.('uiWorkspace') as WorkspaceNavigation | undefined
}

/**
 * Start one Session if the Workspace service is ready.
 * @returns true when the service handled the call (or it was already handled).
 */
function startSessionNow(ctx: ClientContext, request: RemoteNewSessionRequest): boolean {
  const ui = workspaceNavigation(ctx)
  if (typeof ui?.startSession !== 'function') return false
  if (handledNewSessionIds.has(request.requestId)) return true
  rememberHandledNewSession(request.requestId)
  try {
    ui.startSession(request.workspaceId)
  } catch (cause) {
    reportNewSessionFailure(request.requestId, cause)
  }
  return true
}

/**
 * Start a new Session once `uiWorkspace` is available. Idempotent per request id.
 * @param ctx - client context.
 * @param request - Workspace and dedupe id.
 */
export function startRemoteSession(ctx: ClientContext, request: RemoteNewSessionRequest): void {
  if (handledNewSessionIds.has(request.requestId) || pendingNewSessionIds.has(request.requestId)) return
  if (startSessionNow(ctx, request)) return
  pendingNewSessionIds.add(request.requestId)
  let attempts = 0
  const timer = setInterval(() => {
    attempts += 1
    if (startSessionNow(ctx, request)) {
      pendingNewSessionIds.delete(request.requestId)
      clearInterval(timer)
      return
    }
    if (attempts >= 100) {
      pendingNewSessionIds.delete(request.requestId)
      clearInterval(timer)
    }
  }, 100)
  timer.unref?.()
}

/** Read the deep-linked Session id, if any. */
export function deepLinkedSession(): string | null {
  try {
    const fromUrl = new URLSearchParams(window.location.search).get('dm-session')
    if (fromUrl !== null && fromUrl.length > 0) return fromUrl
  } catch { /* location unavailable */ }
  try {
    const fromStorage = window.sessionStorage.getItem('dsh-device-mesh:dm-session')
    if (fromStorage !== null && fromStorage.length > 0) {
      window.sessionStorage.removeItem('dsh-device-mesh:dm-session')
      return fromStorage
    }
  } catch { /* storage unavailable */ }
  return null
}

/** Read and consume a one-shot new-Session request, if any. */
export function deepLinkedNewSession(): RemoteNewSessionRequest | null {
  let fromUrl: RemoteNewSessionRequest | null = null
  try {
    const params = new URLSearchParams(window.location.search)
    fromUrl = newSessionRequest(
      params.get('dm-new-session'),
      params.get('dm-new-session-request'),
    )
  } catch { /* location unavailable */ }

  let fromStorage: RemoteNewSessionRequest | null = null
  try {
    const raw = window.sessionStorage.getItem(NEW_SESSION_KEY)
    if (raw !== null) {
      window.sessionStorage.removeItem(NEW_SESSION_KEY)
      const parsed: unknown = JSON.parse(raw)
      if (typeof parsed === 'object' && parsed !== null) {
        const value = parsed as Record<string, unknown>
        fromStorage = newSessionRequest(value.workspaceId, value.requestId)
      }
    }
  } catch { /* storage unavailable or malformed */ }

  // Consume the URL parameters too: a manual iframe reload must not create a
  // second blank Session from the same navigation gesture.
  if (fromUrl !== null) {
    try {
      const url = new URL(window.location.href)
      url.searchParams.delete('dm-new-session')
      url.searchParams.delete('dm-new-session-request')
      window.history.replaceState(null, '', url.toString())
    } catch { /* history unavailable */ }
  }
  return fromUrl ?? fromStorage
}

/** Navigate to the deep-linked Session or new-Session target once ready. */
export function openDeepLinkedSession(ctx: ClientContext): void {
  const sessionId = deepLinkedSession()
  const newSession = deepLinkedNewSession()
  if (newSession !== null) {
    startRemoteSession(ctx, newSession)
    return
  }
  if (sessionId === null) return
  let attempts = 0
  const timer = setInterval(() => {
    attempts += 1
    const ui = workspaceNavigation(ctx)
    if (typeof ui?.openSession === 'function') {
      clearInterval(timer)
      try { ui.openSession(sessionId) } catch { /* the Session may be gone */ }
      return
    }
    if (attempts >= 100) clearInterval(timer)
  }, 100)
  timer.unref?.()
}

/** Switch the embedded remote shell to a Session requested by the parent pane. */
export function listenForSessionNavigation(ctx: ClientContext): void {
  if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return
  window.addEventListener('message', (event) => {
    if (event.source !== window.parent) return
    const data = event.data as {
      source?: unknown
      kind?: unknown
      sessionId?: unknown
      workspaceId?: unknown
      requestId?: unknown
    } | null
    if (data?.source !== 'dsh-device-mesh-parent') return
    if (data.kind === 'new-session') {
      const request = newSessionRequest(data.workspaceId, data.requestId)
      if (request !== null) startRemoteSession(ctx, request)
      return
    }
    if (data.kind !== 'open-session'
      || typeof data.sessionId !== 'string' || data.sessionId.length === 0) return
    const ui = workspaceNavigation(ctx)
    if (typeof ui?.openSession !== 'function') return
    try { ui.openSession(data.sessionId) } catch { /* the remote Session may be gone */ }
  })
}

/** Tell the parent shell which remote Session is on screen. */
export function reportRemoteSession(ctx: ClientContext): void {
  if (typeof window === 'undefined' || window.parent === window) return
  let last: string | undefined
  const timer = setInterval(() => {
    const sessions = ctx.get?.('sessions') as { list?: { getSnapshot?: () => { current?: string } } } | undefined
    const current = sessions?.list?.getSnapshot?.().current
    if (typeof current !== 'string' || current.length === 0 || current === last) return
    last = current
    try {
      window.parent.postMessage({
        source: 'dsh-device-mesh-remote',
        kind: 'session-changed',
        sessionId: current,
      }, '*')
    } catch { /* parent is gone */ }
  }, 500)
  timer.unref?.()
}
