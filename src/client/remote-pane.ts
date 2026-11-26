/**
 * In-shell remote pane.
 *
 * The DSH desktop main window denies `window.open` and has no right-sidebar
 * surface while the Devices panel is open. Following the federation pattern
 * used by dsh-remote-workspace, the peer GUI is shown in an iframe over the
 * official center column; the Host portal proxy republishes the remote DSH UI
 * on loopback, so the iframe never needs a remote credential.
 */
import type { RemoteNewSessionRequest } from './types.js'

const PANE_ATTR = 'data-device-mesh-remote-pane'
const STYLE_ID = 'dm-remote-pane-style'
const CENTER_SELECTOR = '[class$="_centerCol"], [class$="_viewArea"]'

/** Localized copy for the remote pane; the caller supplies it from `t()`. */
export interface RemotePaneStrings {
  readonly title: string
  readonly reload: string
  readonly openExternal: string
  readonly close: string
  readonly loading: string
  readonly slow: string
  readonly ariaLabel: string
}

/** English fallback used by tests and callers without a locale seat. */
const DEFAULT_STRINGS: RemotePaneStrings = {
  title: 'Remote DSH',
  reload: 'Reload',
  openExternal: 'Open in browser',
  close: 'Close',
  loading: 'Loading remote DSH…',
  slow: 'Remote DSH is taking a while: check the session, or press Reload.',
  ariaLabel: 'Remote control',
}

let paneStrings: RemotePaneStrings = DEFAULT_STRINGS
let reloadButton: HTMLButtonElement | null = null
let externalButton: HTMLButtonElement | null = null
let closeButton: HTMLButtonElement | null = null

let root: HTMLElement | null = null
let iframe: HTMLIFrameElement | null = null
let barNode: HTMLElement | null = null
let titleNode: HTMLElement | null = null
let currentDeviceId: string | null = null
let currentPortalOrigin: string | null = null
let loaded = false
let activeSession: string | null = null
let pendingSession: string | null = null
let pendingNewSession: RemoteNewSessionRequest | null = null
let sessionTimers: ReturnType<typeof setTimeout>[] = []
let loadingNode: HTMLElement | null = null
let loadingTimer: ReturnType<typeof setTimeout> | undefined
let keepAlive: ReturnType<typeof setInterval> | undefined
let boundsObserver: ResizeObserver | null = null
let observedHost: Element | null = null
let observedSeat: Element | null = null
let domObserver: MutationObserver | null = null
let domSyncScheduled = false
let resizeBound = false
let messageHandler: ((event: MessageEvent) => void) | null = null

function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  ...children: Array<Node | string>
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value)
  for (const child of children) node.append(child)
  return node
}

function injectStyle(): void {
  if (document.getElementById(STYLE_ID) !== null) return
  const style = h('style', { id: STYLE_ID })
  style.textContent = `
    /* Content, not chrome: stay below the frame's window-chrome seats so the
       collapsed-sidebar opener keeps working (ui-layout leadingSeat z-index 15)
       and above the column drag handles (11) and the right panel (10). */
    [${PANE_ATTR}] { position: fixed; z-index: 14; display: flex; flex-direction: column; background: var(--dsw-alias-bg-base, #fff); }
    [${PANE_ATTR}][hidden] { display: none; }
    .dm-remote-pane-bar { display: flex; align-items: center; gap: 8px; min-height: 40px; padding: 0 12px; border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.2)); font: 13px/1.4 var(--dsw-font-family, system-ui); }
    .dm-remote-pane-title { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .dm-remote-pane-spacer { flex: 1; }
    .dm-remote-pane-btn { border: 1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.25)); background: transparent; color: inherit; border-radius: 6px; padding: 3px 9px; font: inherit; cursor: pointer; }
    .dm-remote-pane-btn:hover { background: var(--dsw-alias-bg-l2, rgba(127,127,127,.12)); }
    .dm-remote-pane-frame { flex: 1; width: 100%; border: 0; background: var(--dsw-alias-bg-base, #fff); }
    .dm-remote-pane-loading { position: absolute; inset: 40px 0 0; display: flex; align-items: center; justify-content: center; gap: 8px; background: var(--dsw-alias-bg-base, #fff); font: 13px/1.5 var(--dsw-font-family, system-ui); color: var(--dsw-alias-text-secondary, #888); }
    .dm-remote-pane-loading[hidden] { display: none; }
  `
  document.head.appendChild(style)
}

/** The portal cookie is SameSite=None/Secure, so the Desktop cross-site iframe works too. */
function canEmbed(): boolean {
  return typeof window !== 'undefined'
}

/** Whether the center-column iframe surface is currently available in the DOM. */
export function canShowRemotePane(): boolean {
  return canEmbed() && typeof document !== 'undefined' && centerHost() !== null
}

function originOf(url: string): string | null {
  try {
    return new URL(url).origin
  } catch {
    return null
  }
}

function embedUrl(url: string): string {
  try {
    const parsed = new URL(url)
    parsed.searchParams.set('dm-embed', '1')
    return parsed.toString()
  } catch {
    return url
  }
}

/** Drop one-shot new-Session params before reloading inside the embedded pane. */
function reloadUrl(url: string): string {
  try {
    const parsed = new URL(url)
    parsed.searchParams.delete('dm-new-session')
    parsed.searchParams.delete('dm-new-session-request')
    return parsed.toString()
  } catch {
    return url
  }
}

/** Strip embed-only and one-shot params so an external browser tab shows the full remote UI. */
export function externalPortalUrl(url: string): string {
  try {
    const parsed = new URL(url)
    parsed.searchParams.delete('dm-embed')
    parsed.searchParams.delete('dm-new-session')
    parsed.searchParams.delete('dm-new-session-request')
    return parsed.toString()
  } catch {
    return url
  }
}

function centerHost(): Element | null {
  return document.querySelector(CENTER_SELECTOR)
}

/**
 * Keep the pane's own bar clear of the frame's window-chrome seat.
 *
 * With the sidebar fully hidden on macOS, ui-layout mounts the sidebar opener
 * over the centre column's top-left corner. The pane deliberately sits below
 * that seat, so the bar's title has to move aside instead of sitting under the
 * controls.
 * @param hostRect - the centre column the pane covers.
 */
function syncBarInset(hostRect: DOMRect): void {
  if (barNode === null) return
  let inset = 12
  const seat = document.querySelector('[data-shell-leading]')
  if (seat !== null) {
    const rect = seat.getBoundingClientRect()
    if (rect.width > 0 && rect.height > 0) {
      inset = Math.max(inset, Math.round(rect.right - hostRect.left) + 12)
    }
  }
  barNode.style.paddingLeft = `${inset}px`
}

function updateBounds(): void {
  if (root === null) return
  const host = centerHost()
  if (host === null) return
  const rect = host.getBoundingClientRect()
  if (rect.width <= 0 || rect.height <= 0) return
  root.style.left = `${Math.round(rect.left)}px`
  root.style.top = `${Math.round(rect.top)}px`
  root.style.width = `${Math.round(rect.width)}px`
  root.style.height = `${Math.round(rect.height)}px`
  syncBarInset(rect)
}

function postNewSession(request: RemoteNewSessionRequest): void {
  if (iframe === null) return
  try {
    iframe.contentWindow?.postMessage({
      source: 'dsh-device-mesh-parent',
      kind: 'new-session',
      workspaceId: request.workspaceId,
      requestId: request.requestId,
    }, currentPortalOrigin ?? '*')
  } catch { /* ignore */ }
}

/**
 * Deliver the pending navigation to the remote shell.
 *
 * The URL/sessionStorage path is sufficient on a cold load, but the remote SPA
 * may strip the query before its plugin boots. Retry the postMessage briefly;
 * new-Session requests carry a request id, so duplicates are harmless.
 */
function scheduleSessionMessages(): void {
  for (const timer of sessionTimers) clearTimeout(timer)
  sessionTimers = []
  if (pendingSession === null && pendingNewSession === null) return
  sessionTimers = [0, 300, 1_000, 2_000].map(delay => setTimeout(() => {
    if (pendingNewSession !== null) {
      postNewSession(pendingNewSession)
      // Stop retrying after the last attempt so a later manual iframe reload
      // cannot create another blank Session.
      if (delay === 2_000) pendingNewSession = null
      return
    }
    if (pendingSession === null || iframe === null) return
    try {
      iframe.contentWindow?.postMessage({
        source: 'dsh-device-mesh-parent',
        kind: 'open-session',
        sessionId: pendingSession,
      }, currentPortalOrigin ?? '*')
    } catch { /* ignore */ }
  }, delay))
}

function syncBoundsObserver(): void {
  if (boundsObserver === null) return
  const host = centerHost()
  const seat = document.querySelector('[data-shell-leading]')
  if (host === observedHost && seat === observedSeat) return
  boundsObserver.disconnect()
  if (host !== null) boundsObserver.observe(host)
  if (seat !== null) boundsObserver.observe(seat)
  observedHost = host
  observedSeat = seat
}

function syncVisiblePane(): void {
  if (root === null || root.hidden !== false) return
  if (!root.isConnected) mount()
  syncBoundsObserver()
  updateBounds()
}

function startBoundsTracking(): void {
  if (typeof window !== 'undefined' && !resizeBound) {
    window.addEventListener('resize', syncVisiblePane)
    resizeBound = true
  }
  const host = centerHost()
  if (typeof ResizeObserver === 'function' && host !== null) {
    if (boundsObserver === null) {
      boundsObserver = new ResizeObserver(syncVisiblePane)
    }
    syncBoundsObserver()
    if (domObserver === null && typeof MutationObserver === 'function'
      && typeof document !== 'undefined' && document.body !== null) {
      domObserver = new MutationObserver(() => {
        if (domSyncScheduled || root === null || root.hidden !== false) return
        if (root.isConnected && observedHost !== null && observedHost.isConnected
          && observedSeat !== null && observedSeat.isConnected) {
          return
        }
        domSyncScheduled = true
        queueMicrotask(() => {
          domSyncScheduled = false
          if (root === null || root.hidden !== false) return
          const latestHost = centerHost()
          const latestSeat = document.querySelector('[data-shell-leading]')
          if (root.isConnected && latestHost === observedHost && latestSeat === observedSeat) return
          syncVisiblePane()
        })
      })
      domObserver.observe(document.body, { childList: true, subtree: true })
    }
    return
  }
  if (keepAlive === undefined) {
    keepAlive = setInterval(syncVisiblePane, 500)
  }
}

function stopBoundsTracking(): void {
  if (boundsObserver !== null) {
    boundsObserver.disconnect()
    boundsObserver = null
  }
  if (domObserver !== null) {
    domObserver.disconnect()
    domObserver = null
  }
  observedHost = null
  observedSeat = null
  domSyncScheduled = false
  if (resizeBound && typeof window !== 'undefined') {
    window.removeEventListener('resize', syncVisiblePane)
    resizeBound = false
  }
  if (keepAlive !== undefined) {
    clearInterval(keepAlive)
    keepAlive = undefined
  }
}

function mount(): boolean {
  injectStyle()
  const host = centerHost()
  if (root === null) {
    titleNode = h('span', { class: 'dm-remote-pane-title' })
    reloadButton = h('button', { class: 'dm-remote-pane-btn', type: 'button' }, paneStrings.reload)
    reloadButton.addEventListener('click', () => {
      if (iframe !== null) iframe.src = reloadUrl(iframe.src)
    })
    externalButton = h('button', { class: 'dm-remote-pane-btn', type: 'button' }, paneStrings.openExternal)
    externalButton.addEventListener('click', () => {
      if (iframe === null) return
      try { window.open(externalPortalUrl(iframe.src), '_blank', 'noopener,noreferrer') } catch { /* ignore */ }
    })
    closeButton = h('button', { class: 'dm-remote-pane-btn', type: 'button' }, paneStrings.close)
    closeButton.addEventListener('click', () => { hideRemotePane() })
    iframe = h('iframe', { class: 'dm-remote-pane-frame', title: paneStrings.title, allow: 'clipboard-read; clipboard-write' })
    iframe.addEventListener('load', () => {
      loaded = true
      if (loadingTimer !== undefined) clearTimeout(loadingTimer)
      if (loadingNode !== null) loadingNode.hidden = true
      // The remote shell may strip the URL query before its plugin boots; a
      // message sent when the document loads can still arrive before the
      // plugin's listener is installed, so retry briefly.
      scheduleSessionMessages()
    })
    loadingNode = h('div', { class: 'dm-remote-pane-loading', role: 'status' }, paneStrings.loading)
    barNode = h('div', { class: 'dm-remote-pane-bar' }, titleNode, h('span', { class: 'dm-remote-pane-spacer' }), reloadButton, externalButton, closeButton)
    root = h('div', { [PANE_ATTR]: '', role: 'region', 'aria-label': paneStrings.ariaLabel },
      barNode,
      iframe,
      loadingNode)
    messageHandler = (event: MessageEvent): void => {
      if (event.source !== iframe?.contentWindow) return
      if (currentPortalOrigin !== null && event.origin !== currentPortalOrigin) return
      const data = event.data as {
        source?: unknown
        kind?: unknown
        sessionId?: unknown
        message?: unknown
      } | null
      if (data?.source === 'dsh-device-mesh-remote' && data.kind === 'session-changed'
        && typeof data.sessionId === 'string' && data.sessionId.length > 0) {
        activeSession = data.sessionId
        return
      }
      if (data?.source === 'dsh-device-mesh-remote' && data.kind === 'new-session-failed') {
        console.warn('[device-mesh] remote new session failed:', data.message)
        return
      }
      if (data?.source !== 'dsh-device-mesh-portal' || data.kind !== 'auth-failed') return
      const url = iframe?.src
      hideRemotePane()
      if (url !== undefined && url.length > 0) {
        try { window.open(externalPortalUrl(url), '_blank', 'noopener,noreferrer') } catch { /* ignore */ }
      }
    }
    window.addEventListener('message', messageHandler)
  }
  if (host === null) return false
  if (!root.isConnected) document.body.appendChild(root)
  updateBounds()
  return true
}

/** Show the remote DSH UI for a device in the center column. */
export function showRemotePane(
  deviceId: string,
  deviceName: string,
  url: string,
  sessionId?: string,
  strings: RemotePaneStrings = DEFAULT_STRINGS,
  newSession?: RemoteNewSessionRequest,
): boolean {
  paneStrings = strings
  if (!canEmbed()) return false
  if (!mount() || root === null || iframe === null || titleNode === null) return false
  iframe.title = paneStrings.title
  root.setAttribute('aria-label', paneStrings.ariaLabel)
  if (reloadButton !== null) reloadButton.textContent = paneStrings.reload
  if (externalButton !== null) externalButton.textContent = paneStrings.openExternal
  if (closeButton !== null) closeButton.textContent = paneStrings.close
  const nextOrigin = originOf(url)
  const sameDevice = currentDeviceId === deviceId
    && loaded
    && currentPortalOrigin !== null
    && currentPortalOrigin === nextOrigin
  if (currentDeviceId !== deviceId) activeSession = null
  currentDeviceId = deviceId
  titleNode.textContent = deviceName
  if (sameDevice) {
    // Keep the already-loaded remote SPA; only switch the Session inside it.
    if (newSession !== undefined) {
      pendingNewSession = newSession
      pendingSession = null
      scheduleSessionMessages()
    } else {
      pendingNewSession = null
      if (sessionId !== undefined && sessionId.length > 0) {
        for (const timer of sessionTimers) clearTimeout(timer)
        sessionTimers = []
        try {
          iframe.contentWindow?.postMessage({
            source: 'dsh-device-mesh-parent',
            kind: 'open-session',
            sessionId,
          }, currentPortalOrigin ?? '*')
        } catch { /* ignore */ }
      }
    }
  } else {
    currentPortalOrigin = nextOrigin
    loaded = false
    pendingSession = newSession === undefined && sessionId !== undefined && sessionId.length > 0
      ? sessionId
      : null
    pendingNewSession = newSession ?? null
    if (loadingNode !== null) {
      loadingNode.hidden = false
      loadingNode.textContent = paneStrings.loading
    }
    if (loadingTimer !== undefined) clearTimeout(loadingTimer)
    loadingTimer = setTimeout(() => {
      if (!loaded && loadingNode !== null) {
        loadingNode.textContent = paneStrings.slow
      }
    }, 30_000)
    iframe.src = embedUrl(url)
  }
  root.hidden = false
  updateBounds()
  startBoundsTracking()
  return true
}

/** Hide the remote pane (the iframe is kept for a quick re-open). */
export function hideRemotePane(): void {
  // Do not let an unconsumed navigation leak into a later re-open/load.
  pendingNewSession = null
  for (const timer of sessionTimers) clearTimeout(timer)
  sessionTimers = []
  if (root !== null) root.hidden = true
  stopBoundsTracking()
}

/** Tear down all DOM nodes, observers and listeners owned by the remote pane. */
export function disposeRemotePane(): void {
  hideRemotePane()
  if (loadingTimer !== undefined) {
    clearTimeout(loadingTimer)
    loadingTimer = undefined
  }
  if (messageHandler !== null && typeof window !== 'undefined') {
    window.removeEventListener('message', messageHandler)
    messageHandler = null
  }
  root?.remove()
  if (typeof document !== 'undefined') {
    document.getElementById(STYLE_ID)?.remove()
  }
  root = null
  iframe = null
  barNode = null
  titleNode = null
  reloadButton = null
  externalButton = null
  closeButton = null
  loadingNode = null
  currentDeviceId = null
  currentPortalOrigin = null
  loaded = false
  activeSession = null
  pendingSession = null
}

/** The device currently shown in the pane, if any. */
export function remotePaneDevice(): string | null {
  return root !== null && root.hidden === false ? currentDeviceId : null
}


/** Session the embedded remote shell currently shows, if reported. */
export function remotePaneSession(): string | null {
  return activeSession
}
