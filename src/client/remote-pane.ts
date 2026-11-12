/**
 * In-shell remote pane.
 *
 * The DSH desktop main window denies `window.open` and has no right-sidebar
 * surface while the Devices panel is open. Following the federation pattern
 * used by dsh-remote-workspace, the peer GUI is shown in an iframe over the
 * official center column; the Host portal proxy republishes the remote DSH UI
 * on loopback, so the iframe never needs a remote credential.
 */
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
let titleNode: HTMLElement | null = null
let currentDeviceId: string | null = null
let loaded = false
let activeSession: string | null = null
let pendingSession: string | null = null
let sessionTimers: ReturnType<typeof setTimeout>[] = []
let loadingNode: HTMLElement | null = null
let loadingTimer: ReturnType<typeof setTimeout> | undefined
let keepAlive: ReturnType<typeof setInterval> | undefined

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
    [${PANE_ATTR}] { position: fixed; z-index: 40; display: flex; flex-direction: column; background: var(--dsw-alias-bg-base, #fff); }
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

function embedUrl(url: string): string {
  try {
    const parsed = new URL(url)
    parsed.searchParams.set('dm-embed', '1')
    return parsed.toString()
  } catch {
    return url
  }
}

function centerHost(): Element | null {
  return document.querySelector(CENTER_SELECTOR)
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
}

function mount(): boolean {
  injectStyle()
  const host = centerHost()
  if (root === null) {
    titleNode = h('span', { class: 'dm-remote-pane-title' })
    reloadButton = h('button', { class: 'dm-remote-pane-btn', type: 'button' }, paneStrings.reload)
    reloadButton.addEventListener('click', () => { if (iframe !== null) iframe.src = iframe.src })
    externalButton = h('button', { class: 'dm-remote-pane-btn', type: 'button' }, paneStrings.openExternal)
    externalButton.addEventListener('click', () => {
      if (iframe === null) return
      try { window.open(iframe.src, '_blank', 'noopener,noreferrer') } catch { /* ignore */ }
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
      if (pendingSession !== null) {
        for (const timer of sessionTimers) clearTimeout(timer)
        sessionTimers = [0, 300, 1_000, 2_000].map(delay => setTimeout(() => {
          const sessionId = pendingSession
          if (sessionId === null || iframe === null) return
          try {
            iframe.contentWindow?.postMessage({
              source: 'dsh-device-mesh-parent',
              kind: 'open-session',
              sessionId,
            }, '*')
          } catch { /* ignore */ }
        }, delay))
      }
    })
    loadingNode = h('div', { class: 'dm-remote-pane-loading', role: 'status' }, paneStrings.loading)
    root = h('div', { [PANE_ATTR]: '', role: 'region', 'aria-label': paneStrings.ariaLabel },
      h('div', { class: 'dm-remote-pane-bar' }, titleNode, h('span', { class: 'dm-remote-pane-spacer' }), reloadButton, externalButton, closeButton),
      iframe,
      loadingNode)
    window.addEventListener('message', (event) => {
      if (event.source !== iframe?.contentWindow) return
      const data = event.data as { source?: unknown; kind?: unknown; sessionId?: unknown } | null
      if (data?.source === 'dsh-device-mesh-remote' && data.kind === 'session-changed'
        && typeof data.sessionId === 'string' && data.sessionId.length > 0) {
        activeSession = data.sessionId
        return
      }
      if (data?.source !== 'dsh-device-mesh-portal' || data.kind !== 'auth-failed') return
      const url = iframe?.src
      hideRemotePane()
      if (url !== undefined && url.length > 0) {
        try { window.open(url, '_blank', 'noopener,noreferrer') } catch { /* ignore */ }
      }
    })
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
): boolean {
  paneStrings = strings
  if (!canEmbed()) return false
  if (!mount() || root === null || iframe === null || titleNode === null) return false
  iframe.title = paneStrings.title
  root.setAttribute('aria-label', paneStrings.ariaLabel)
  if (reloadButton !== null) reloadButton.textContent = paneStrings.reload
  if (externalButton !== null) externalButton.textContent = paneStrings.openExternal
  if (closeButton !== null) closeButton.textContent = paneStrings.close
  const sameDevice = currentDeviceId === deviceId && loaded
  if (currentDeviceId !== deviceId) activeSession = null
  currentDeviceId = deviceId
  titleNode.textContent = deviceName
  if (sameDevice) {
    // Keep the already-loaded remote SPA; only switch the Session inside it.
    if (sessionId !== undefined && sessionId.length > 0) {
      try {
        iframe.contentWindow?.postMessage({
          source: 'dsh-device-mesh-parent',
          kind: 'open-session',
          sessionId,
        }, '*')
      } catch { /* ignore */ }
    }
  } else {
    loaded = false
    pendingSession = sessionId !== undefined && sessionId.length > 0 ? sessionId : null
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
  if (keepAlive === undefined) {
    keepAlive = setInterval(() => {
      if (root !== null && root.hidden === false) {
        if (!root.isConnected) mount()
        else updateBounds()
      }
    }, 500)
  }
  return true
}

/** Hide the remote pane (the iframe is kept for a quick re-open). */
export function hideRemotePane(): void {
  if (root !== null) root.hidden = true
  if (keepAlive !== undefined) {
    clearInterval(keepAlive)
    keepAlive = undefined
  }
}

/** The device currently shown in the pane, if any. */
export function remotePaneDevice(): string | null {
  return root !== null && root.hidden === false ? currentDeviceId : null
}


/** Session the embedded remote shell currently shows, if reported. */
export function remotePaneSession(): string | null {
  return activeSession
}
