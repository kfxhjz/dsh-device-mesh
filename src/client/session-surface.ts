/**
 * Mount a local conversation surface so `sidebarRight.openTab('browser', …)`
 * becomes available. DSH's right sidebar is per Session; the devices panel has
 * no Session of its own. Opening an existing local Session first is the
 * supported way to get an in-DSH Browser tab for the remote portal (whose
 * webview guest carries the loopback cookie as a top-level context).
 */
import type { ClientContext } from './types.js'

export interface SessionsSnapshotLike {
  readonly byId?: Record<string, unknown>
  readonly current?: string
}

/** Open an existing local Session; returns false when none is available. */
export function ensureSessionSurface(ctx: ClientContext): boolean {
  const ui = ctx.get?.('uiWorkspace') as { openSession?: (target: unknown) => void } | undefined
  if (typeof ui?.openSession !== 'function') return false
  const sessions = ctx.get?.('sessions') as {
    list?: { getSnapshot?: () => SessionsSnapshotLike }
  } | undefined
  const snapshot = sessions?.list?.getSnapshot?.()
  const byId = snapshot?.byId ?? {}
  const current = snapshot?.current
  const id = typeof current === 'string' && Object.hasOwn(byId, current)
    ? current
    : Object.keys(byId)[0]
  if (typeof id !== 'string' || id.length === 0) return false
  try {
    ui.openSession(id)
    return true
  } catch {
    return false
  }
}
