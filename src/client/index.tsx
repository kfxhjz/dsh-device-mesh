/**
 * dsh-device-mesh — browser half.
 *
 * Registers the Devices main panel, its sidebar panel-list entry and a frame
 * overlay for pending pairing requests. Everything
 * the components need is either pulled from the same-origin local API
 * (`api.ts`) or injected by `apply` through the slot `inject` face — components
 * never receive the Cordis context. See docs/development.md §7 for the slot
 * catalogue and the bundle contract.
 */
import type { ClientContext, SidebarRightService } from './types.js'
import { NS, en, zh } from './locale.js'
import { STYLE_ELEMENT_ID, styles } from './styles.js'
import { DevicesPanel } from './devices-panel.js'
import { PendingPairingOverlay } from './pairing.js'
import { getMeshSnapshot, meshApi, useMeshSnapshot } from './api.js'
import { mountSidebarHost } from './sidebar-host.js'
import type { UiChild } from './ui.js'
import { DeviceMeshGlyph, el, navigatePortalWindow, openBlankPortalWindow, openExternalBrowser, openPortalWindow } from './ui.js'
import type { RemotePaneStrings } from './remote-pane.js'
import { showRemotePane } from './remote-pane.js'
import { ensureSessionSurface } from './session-surface.js'
import { listenForSessionNavigation, openDeepLinkedSession, reportRemoteSession } from './deep-link.js'

/** Keyed `main` panel id; the sidebar panel-list id must be identical. */
export const PANEL_ID = 'device-mesh'

/** Required Cordis services. Optional ones are looked up reflectively. */
export const inject = ['slots', 'locale', 'layout']

/** Pending count rendered on both sidebar entry points. */
function pendingBadge(pending: number, className: string): UiChild {
  if (pending <= 0) return null
  return el('span', { className, 'aria-hidden': 'true' }, pending > 9 ? '9+' : String(pending))
}

/** Online paired-device count shown when there is no pending request. */
function onlineBadge(online: number, className: string): UiChild {
  if (online <= 0) return null
  return el('span', { className: `${className} ${className}-online`, 'aria-hidden': 'true' }, online > 9 ? '9+' : String(online))
}

/** Device glyph with the pending-request badge, used by the sidebar panel list. */
function DevicesPanelIcon(props: { readonly size?: number }): UiChild {
  const snapshot = useMeshSnapshot()
  const pending = snapshot.state?.pendingPairings.length ?? 0
  const online = snapshot.state?.devices.filter(device => device.status === 'online').length ?? 0
  return el(
    'span',
    { className: 'dm-icon-wrap' },
    DeviceMeshGlyph({ size: props.size ?? 16 }),
    pending > 0 ? pendingBadge(pending, 'dm-panel-badge') : onlineBadge(online, 'dm-panel-badge'),
  )
}

/** Inject the plugin stylesheet for the plugin's lifetime (and HMR reloads). */
function installStyles(ctx: ClientContext): void {
  ctx.effect(() => {
    if (typeof document === 'undefined') return
    const previous = document.getElementById(STYLE_ELEMENT_ID)
    if (previous !== null) previous.remove()
    const style = document.createElement('style')
    style.id = STYLE_ELEMENT_ID
    style.setAttribute('data-plugin', 'dsh-device-mesh')
    style.textContent = styles
    document.head.appendChild(style)
    return () => { style.remove() }
  }, 'device-mesh: stylesheet')
}

/** Find the optional right-sidebar service regardless of how it is exposed. */
function sidebarRightService(ctx: ClientContext): SidebarRightService | null {
  let candidate: unknown
  try {
    candidate = typeof ctx.get === 'function' ? ctx.get('sidebarRight') : undefined
  } catch {
    candidate = undefined
  }
  if (candidate === undefined || candidate === null) {
    candidate = (ctx as unknown as { sidebarRight?: unknown }).sidebarRight
  }
  if (candidate === undefined || candidate === null || typeof candidate !== 'object') return null
  const service = candidate as Partial<SidebarRightService>
  return typeof service.openTab === 'function' ? service as SidebarRightService : null
}

/** Plugin entry: register every slot inside `ctx.slots.inject`. */
export function apply(ctx: ClientContext): void {
  installStyles(ctx)
  openDeepLinkedSession(ctx)
  listenForSessionNavigation(ctx)
  reportRemoteSession(ctx)
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'device-mesh: dictionaries')
  const t = ctx.locale.bind(NS)
  const remotePaneStrings = (): RemotePaneStrings => ({
    title: t('remote.paneTitle'),
    reload: t('remote.paneReload'),
    openExternal: t('remote.paneExternal'),
    close: t('remote.paneClose'),
    loading: t('remote.paneLoading'),
    slow: t('remote.paneSlow'),
    ariaLabel: t('remote.paneAria'),
  })

  const openDevices = (): void => {
    try {
      ctx.layout.selectPanel(PANEL_ID)
    } catch (error) {
      console.warn('[device-mesh] could not select the Devices panel', error)
    }
  }

  /**
   * Open a device's portal. The preferred surface is an iframe over the center
   * column (dsh-remote-workspace federation pattern); right-sidebar tabs,
   * the system browser and a popup remain fallbacks.
   */
  const openRemotePortal = (deviceId: string, sessionId?: string): void => {
    const target = getMeshSnapshot().state?.devices.find(device => device.deviceId === deviceId)
    // Pre-open synchronously: the portal URL is only known after an RPC, and a
    // post-await window.open loses user activation and stays blank.
    const pending = openBlankPortalWindow()
    void meshApi.openPortal(deviceId)
      .then(async (url) => {
        let targetUrl = url
        if (sessionId !== undefined && sessionId.length > 0) {
          try {
            const deep = new URL(url)
            deep.searchParams.set('dm-session', sessionId)
            targetUrl = deep.toString()
          } catch { /* keep the plain portal URL */ }
        }
        if (showRemotePane(deviceId, target?.name ?? t('remote.paneAria'), targetUrl, sessionId, remotePaneStrings())) {
          try { pending?.close() } catch { /* already gone */ }
          return
        }
        if (await openRemoteInShell(targetUrl)) {
          try { pending?.close() } catch { /* already gone */ }
          return
        }
        const external = await meshApi.openPortalExternally(targetUrl).catch(() => false)
        if (external) {
          try { pending?.close() } catch { /* already gone */ }
          return
        }
        if (pending !== null && navigatePortalWindow(pending, targetUrl)) return
        // DSH Desktop denies the in-app window but its handler calls
        // shell.openExternal, so this opens the system browser.
        if (openExternalBrowser(targetUrl)) {
          try { pending?.close() } catch { /* already gone */ }
          return
        }
        if (!openPortalWindow(targetUrl)) {
          try { pending?.close() } catch { /* already gone */ }
          console.warn('[device-mesh] could not open the remote control window')
        }
      })
      .catch((error: unknown) => {
        try { pending?.close() } catch { /* already gone */ }
        console.warn('[device-mesh] could not create the remote portal', error)
      })
  }

  const connectDevice = (deviceId: string): void => {
    void meshApi.connectDevice(deviceId).catch((error: unknown) => {
      console.warn('[device-mesh] could not reconnect the device', error)
    })
  }

  const openRemoteTab = (url: string): boolean => {
    const service = sidebarRightService(ctx)
    if (service === null) return false
    try {
      service.openTab('browser', { params: { url } })
      return true
    } catch (error) {
      console.warn('[device-mesh] right-sidebar browser tab is unavailable', error)
      return false
    }
  }

  /**
   * The right sidebar is per Session. If the Devices panel is showing, mount an
   * existing local Session first, then retry the Browser tab. This keeps remote
   * control inside DSH on the Desktop shell (a top-level webview guest, so the
   * loopback portal cookie is first-party).
   */
  const openRemoteInShell = async (url: string): Promise<boolean> => {
    if (openRemoteTab(url)) return true
    if (!ensureSessionSurface(ctx)) return false
    for (let attempt = 0; attempt < 15; attempt += 1) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 100)
        timer.unref?.()
      })
      if (openRemoteTab(url)) return true
    }
    return false
  }

  // The native sidebar has no slot between the panel list and ui-workspace's
  // section, so the host bar anchors to ui-workspace's stable
  // `data-sidebar-workspace-header` element and follows the shared store.
  ctx.effect(
    () => mountSidebarHost({ t, openDevices, openPortal: openRemotePortal, connectDevice }),
    'device-mesh: sidebar host bar',
  )

  // Main panel (keyed). Registered before any selectPanel call can succeed.
  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main',
    key: PANEL_ID,
    locale: NS,
    inject: () => ({
      openRemoteTab: openRemoteInShell,
      openRemotePane: (deviceId: string, deviceName: string, url: string, sessionId?: string): boolean =>
        showRemotePane(deviceId, deviceName, url, sessionId, remotePaneStrings()),
    }),
  }, DevicesPanel))

  // Sidebar panel list: the icon factory for the main panel above.
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist',
    id: PANEL_ID,
    order: 40,
    locale: NS,
    label: () => t('panel'),
  }, DevicesPanelIcon))

  // Frame-wide overlay: pending pairing requests stay visible while the panel
  // is closed. The overlay layer is click-through; the card opts back in.
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'device-mesh.pending',
    order: 60,
    locale: NS,
    inject: () => ({ openDevices }),
  }, PendingPairingOverlay))
}
