/**
 * Open a Session carried by `?dm-session=` at boot.
 *
 * The parent shell embeds the remote DSH GUI in an iframe and asks it to show a
 * particular remote Session. DSH's SPA has no URL router for Sessions, so the
 * remote copy of this plugin performs the navigation once the Workspace service
 * is available. Both sides run the same package; a local shell without the
 * parameter is untouched.
 */
import type { ClientContext } from './types.js'

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

/** Navigate to the deep-linked Session once uiWorkspace is ready. */
export function openDeepLinkedSession(ctx: ClientContext): void {
  const sessionId = deepLinkedSession()
  if (sessionId === null) return
  let attempts = 0
  const timer = setInterval(() => {
    attempts += 1
    const ui = ctx.get?.('uiWorkspace') as { openSession?: (target: unknown) => void } | undefined
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
    const data = event.data as { source?: unknown; kind?: unknown; sessionId?: unknown } | null
    if (data?.source !== 'dsh-device-mesh-parent' || data.kind !== 'open-session'
      || typeof data.sessionId !== 'string' || data.sessionId.length === 0) return
    const ui = ctx.get?.('uiWorkspace') as { openSession?: (target: unknown) => void } | undefined
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
