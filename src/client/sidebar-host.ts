/**
 * Sidebar host switcher + remote workspace mirror.
 *
 * DSH's native `sidebar.workspaces` region is a single slot owned by
 * ui-workspace, so it always renders local workspaces. A plugin cannot register
 * rows there. This module adds a plain-DOM host bar above the native section
 * header and, while a remote host is selected, hides the native browser and
 * renders a read-only mirror of that host's workspaces in the same place.
 *
 * Vanilla DOM keeps `react-dom` out of the bundle (the plugin contract forbids
 * creating a second React root). Data comes from the shared polling store.
 */
import { getMeshSnapshot, meshApi, refreshMeshState, subscribeMesh } from './api.js'
import { remoteRefreshDue } from './remote-status.js'
import { hideRemotePane, remotePaneDevice, remotePaneSession } from './remote-pane.js'
import { getSelectedHost, requestAddHost, setSelectedHost, subscribeHost } from './host-store.js'
import type { MeshDeviceView, WorkspaceSummary } from '../shared/protocol.js'
import type { Translate } from './types.js'

export interface SidebarHostOptions {
  readonly t: Translate
  /** Select the Devices main panel (management and Add host use it). */
  readonly openDevices: () => void
  /** Open the remote control portal for a paired device. */
  readonly openPortal: (deviceId: string, sessionId?: string) => void
  /** Ask the host to reconnect an offline device. */
  readonly connectDevice: (deviceId: string) => void
}

interface HostView {
  readonly id: string
  readonly name: string
  readonly status: string
  readonly local: boolean
}

const BAR_ATTR = 'data-device-mesh-host-bar'
const TOGGLE_ATTR = 'data-device-mesh-host-toggle'
const MENU_ATTR = 'data-device-mesh-host-menu'
const HOST_ATTR = 'data-dm-host-id'
const ADD_ATTR = 'data-dm-add-host'
const REMOTE_ATTR = 'data-device-mesh-remote-workspaces'
const VIEW_ATTR = 'data-device-mesh-view-options'
const VIEW_MENU_ATTR = 'data-dm-view-menu'
const VIEW_ITEM_ATTR = 'data-dm-view-item'

/** How the remote mirror groups its Sessions. */
export type RemoteGroupBy = 'workspace' | 'flat'

/** How the remote mirror orders Sessions within its groups. */
export type RemoteOrderBy = 'updated' | 'title'

/** Which archived Sessions the remote mirror lists. */
export type RemoteArchivedFilter = 'hide' | 'show' | 'only'

/** Persisted (per remote device) view preferences for the sidebar mirror. */
export interface RemoteViewOptions {
  readonly groupBy: RemoteGroupBy
  readonly orderBy: RemoteOrderBy
  readonly archivedFilter: RemoteArchivedFilter
}

/** Native-like defaults: workspace groups, recent first, archived hidden. */
export const DEFAULT_REMOTE_VIEW: RemoteViewOptions = {
  groupBy: 'workspace',
  orderBy: 'updated',
  archivedFilter: 'hide',
}

/**
 * ui-workspace's header anchor changed across DSH previews: newer builds expose
 * `data-sidebar-workspace-header`, the shipped 0.2.2-rc.1 build only exposes
 * the CSS-module `sectionHeader` class. Support both.
 */
function findWorkspaceHeader(): HTMLElement | null {
  const marked = document.querySelector<HTMLElement>('[data-sidebar-workspace-header]')
  if (marked !== null) return marked
  for (const candidate of Array.from(document.querySelectorAll<HTMLElement>('[class*="sectionHeader"]'))) {
    const label = (candidate.textContent ?? '').trim()
    if (label === 'Workspaces' || label === '工作区' || label === 'Sessions' || label === '会话') return candidate
  }
  return null
}

function hostsOf(snapshot: ReturnType<typeof getMeshSnapshot>): { hosts: readonly HostView[]; selected: string } {
  const state = snapshot.state
  const selected = getSelectedHost()
  if (state === null) return { hosts: [], selected }
  return {
    selected,
    hosts: [
      { id: 'local', name: state.self.name, status: 'online', local: true },
      ...state.devices.map(device => ({
        id: device.deviceId,
        name: device.name,
        status: device.status,
        local: false,
      })),
    ],
  }
}

function span(className: string, value = ''): HTMLSpanElement {
  const element = document.createElement('span')
  element.className = className
  element.textContent = value
  return element
}

function button(className: string, label: string, onClick: () => void): HTMLButtonElement {
  const element = document.createElement('button')
  element.type = 'button'
  element.className = className
  element.textContent = label
  element.addEventListener('click', (event) => { event.stopPropagation(); onClick() })
  return element
}

function pill(className: string, label: string): HTMLSpanElement {
  return span(`dm-pill ${className}`, label)
}

/**
 * Mount the sidebar host bar and the remote workspace mirror.
 * @param options - translation, portal, connect and panel callbacks.
 * @returns teardown (removes every injected node and floating menu).
 */
export function mountSidebarHost(options: SidebarHostOptions): () => void {
  if (typeof document === 'undefined' || typeof window === 'undefined') return () => undefined

  let bar: HTMLDivElement | null = null
  let remoteRoot: HTMLDivElement | null = null
  let nativeRoot: HTMLElement | null = null
  let menu: HTMLElement | null = null
  let viewMenu: HTMLElement | null = null
  let viewButton: HTMLButtonElement | null = null
  let menuOpen = false
  let viewMenuOpen = false
  let disposed = false
  let remoteHost: string | null = null
  let remoteRequestedFor: string | null = null
  let lastRemoteRefreshAt = 0
  let remoteRefreshing = false
  let remoteLoading = false
  let remoteError: string | null = null
  let remoteSignature = ''
  let remoteQuery = ''
  let remoteView: RemoteViewOptions = { ...DEFAULT_REMOTE_VIEW }
  let remoteMutationPending = false
  let remoteNotice: string | null = null
  let remoteActionToken = 0
  let confirmDialog: HTMLDialogElement | HTMLElement | null = null
  const remoteExpanded = new Set<string>()
  let remoteExpandedDevice: string | null = null
  let remoteActiveSession: string | null = null
  const lastSessionKey = (deviceId: string): string => `dsh-device-mesh:remote-session:${deviceId}`
  const remoteViewKey = (deviceId: string): string => `dsh-device-mesh:remote-view:${deviceId}`
  const rememberSession = (deviceId: string, sessionId: string): void => {
    try { localStorage.setItem(lastSessionKey(deviceId), sessionId) } catch { /* storage unavailable */ }
  }
  const lastSession = (deviceId: string): string | null => {
    try {
      const value = localStorage.getItem(lastSessionKey(deviceId))
      return value !== null && value.length > 0 ? value : null
    } catch {
      return null
    }
  }
  const isGroupBy = (value: unknown): value is RemoteGroupBy => value === 'workspace' || value === 'flat'
  const isOrderBy = (value: unknown): value is RemoteOrderBy => value === 'updated' || value === 'title'
  const isArchivedFilter = (value: unknown): value is RemoteArchivedFilter =>
    value === 'hide' || value === 'show' || value === 'only'
  const loadRemoteView = (deviceId: string): void => {
    remoteView = { ...DEFAULT_REMOTE_VIEW }
    try {
      const raw = localStorage.getItem(remoteViewKey(deviceId))
      if (raw === null) return
      const parsed: unknown = JSON.parse(raw)
      if (typeof parsed !== 'object' || parsed === null) return
      const value = parsed as Record<string, unknown>
      remoteView = {
        groupBy: isGroupBy(value.groupBy) ? value.groupBy : DEFAULT_REMOTE_VIEW.groupBy,
        orderBy: isOrderBy(value.orderBy) ? value.orderBy : DEFAULT_REMOTE_VIEW.orderBy,
        archivedFilter: isArchivedFilter(value.archivedFilter)
          ? value.archivedFilter
          : DEFAULT_REMOTE_VIEW.archivedFilter,
      }
    } catch {
      // A corrupt/blocked preference must never blank the mirror.
    }
  }
  const persistRemoteView = (): void => {
    if (remoteHost === null) return
    try {
      localStorage.setItem(remoteViewKey(remoteHost), JSON.stringify(remoteView))
    } catch {
      // storage unavailable
    }
  }

  const clearMenu = (): void => { menu?.remove(); menu = null; menuOpen = false }

  const closeMenu = (): void => {
    menuOpen = false
    if (menu instanceof HTMLDialogElement && menu.open) {
      try { menu.close() } catch { /* already closed */ }
    }
    clearMenu()
    bar?.querySelector<HTMLElement>(`[${TOGGLE_ATTR}]`)?.setAttribute('aria-expanded', 'false')
  }

  const clearViewMenu = (): void => {
    viewMenu?.remove()
    viewMenu = null
    viewMenuOpen = false
  }

  const closeViewMenu = (): void => {
    if (viewMenu instanceof HTMLDialogElement && viewMenu.open) {
      try { viewMenu.close() } catch { /* already closed */ }
    }
    clearViewMenu()
    viewButton?.setAttribute('aria-expanded', 'false')
  }

  const closeConfirmDialog = (): void => {
    if (confirmDialog instanceof HTMLDialogElement && confirmDialog.open) {
      try { confirmDialog.close() } catch { /* already closed */ }
    }
    confirmDialog?.remove()
    confirmDialog = null
  }

  /**
   * Modal confirmation owned by the plugin. `window.confirm` is unreliable in
   * the Desktop shell (and a thrown confirm used to skip the question), so the
   * archive button always gets an explicit, visible decision surface.
   */
  const openConfirmDialog = (input: {
    readonly title: string
    readonly message: string
    readonly confirmLabel: string
    readonly onConfirm: () => void
  }): void => {
    closeConfirmDialog()
    const dialog = document.createElement('dialog')
    const canShowModal = typeof dialog.showModal === 'function'
    const root = canShowModal ? dialog : document.createElement('div')
    confirmDialog = root
    root.className = `dm-confirm-dialog${canShowModal ? ' dm-confirm-dialog-modal' : ' dm-confirm-dialog-fallback'}`
    root.setAttribute('role', 'dialog')
    root.setAttribute('aria-modal', 'true')
    root.setAttribute('aria-label', input.title)
    root.append(
      span('dm-confirm-title', input.title),
      span('dm-confirm-message', input.message),
    )
    const actions = document.createElement('div')
    actions.className = 'dm-confirm-actions'
    actions.append(
      button('dm-remote-action', options.t('common.cancel'), closeConfirmDialog),
      button('dm-remote-action dm-remote-action-primary', input.confirmLabel, () => {
        closeConfirmDialog()
        input.onConfirm()
      }),
    )
    root.append(actions)
    root.addEventListener('cancel', (event) => {
      event.preventDefault()
      closeConfirmDialog()
    })
    root.addEventListener('click', (event) => {
      if (event.target === root) closeConfirmDialog()
    })
    document.body.append(root)
    if (canShowModal) {
      try { dialog.showModal() } catch { /* plain element still renders */ }
    }
  }

  /** Position one floating menu below its anchor, flipping above when short. */
  const positionFloating = (anchor: HTMLElement, target: HTMLElement | null): void => {
    if (target === null) return
    const rect = anchor.getBoundingClientRect()
    const height = target.offsetHeight
    target.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - 300))}px`
    if (window.innerHeight - rect.bottom >= height + 12) {
      target.style.top = `${rect.bottom + 6}px`
      target.style.bottom = 'auto'
    } else {
      target.style.top = 'auto'
      target.style.bottom = `${Math.max(8, window.innerHeight - rect.top + 6)}px`
    }
  }

  const positionMenu = (anchor: HTMLElement): void => { positionFloating(anchor, menu) }

  const viewChoice = (
    group: HTMLElement,
    id: string,
    label: string,
    checked: boolean,
    onPick: () => void,
  ): void => {
    const row = document.createElement('button')
    row.type = 'button'
    row.className = `dm-host-item dm-view-item${checked ? ' dm-host-item-active' : ''}`
    row.setAttribute('role', 'menuitemradio')
    row.setAttribute('aria-checked', String(checked))
    row.setAttribute(VIEW_ITEM_ATTR, id)
    row.append(span('dm-view-check', checked ? '\u2713' : ''), document.createTextNode(label))
    row.addEventListener('click', (event) => {
      event.stopPropagation()
      onPick()
    })
    group.append(row)
  }

  const openViewMenu = (anchor: HTMLElement): void => {
    closeMenu()
    clearViewMenu()
    const dialog = document.createElement('dialog')
    const canShowModal = typeof dialog.showModal === 'function'
    const element = canShowModal ? dialog : document.createElement('div')
    viewMenu = element
    element.className = `dm-host-menu dm-host-menu-floating${canShowModal ? ' dm-host-menu-dialog' : ''} dm-view-menu`
    element.setAttribute(VIEW_MENU_ATTR, '')
    element.setAttribute('role', 'menu')
    element.setAttribute('aria-label', options.t('remote.viewOptions'))
    element.addEventListener('click', (event) => {
      if (event.target === element) closeViewMenu()
    })
    element.addEventListener('cancel', (event) => {
      event.preventDefault()
      closeViewMenu()
    })

    const pick = (patch: Partial<RemoteViewOptions>): void => {
      remoteView = { ...remoteView, ...patch }
      persistRemoteView()
      remoteSignature = ''
      closeViewMenu()
      renderAll()
    }
    const section = (label: string): void => {
      const head = document.createElement('div')
      head.className = 'dm-view-section'
      head.textContent = label
      element.append(head)
    }

    section(options.t('remote.groupBy'))
    viewChoice(element, 'group-workspace', options.t('remote.groupWorkspace'), remoteView.groupBy === 'workspace', () => {
      pick({ groupBy: 'workspace' })
    })
    viewChoice(element, 'group-flat', options.t('remote.groupFlat'), remoteView.groupBy === 'flat', () => {
      pick({ groupBy: 'flat' })
    })

    section(options.t('remote.orderBy'))
    viewChoice(element, 'order-updated', options.t('remote.orderUpdated'), remoteView.orderBy === 'updated', () => {
      pick({ orderBy: 'updated' })
    })
    viewChoice(element, 'order-title', options.t('remote.orderTitle'), remoteView.orderBy === 'title', () => {
      pick({ orderBy: 'title' })
    })

    section(options.t('remote.filterBy'))
    viewChoice(element, 'archived-hide', options.t('remote.hideArchived'), remoteView.archivedFilter === 'hide', () => {
      pick({ archivedFilter: 'hide' })
    })
    viewChoice(element, 'archived-show', options.t('remote.showArchived'), remoteView.archivedFilter === 'show', () => {
      pick({ archivedFilter: 'show' })
    })
    viewChoice(element, 'archived-only', options.t('remote.onlyArchived'), remoteView.archivedFilter === 'only', () => {
      pick({ archivedFilter: 'only' })
    })

    const divider = document.createElement('div')
    divider.className = 'dm-host-divider'
    element.append(divider)
    const open = document.createElement('button')
    open.type = 'button'
    open.className = 'dm-host-add'
    open.append(document.createTextNode(options.t('remote.open')))
    open.addEventListener('click', (event) => {
      event.stopPropagation()
      const deviceId = remoteHost
      closeViewMenu()
      if (deviceId !== null) options.openPortal(deviceId)
    })
    element.append(open)

    document.body.append(element)
    if (canShowModal) {
      try { dialog.showModal() } catch { /* plain element still renders */ }
    }
    positionFloating(anchor, element)
    viewMenuOpen = true
    viewButton?.setAttribute('aria-expanded', 'true')
  }

  const toggleViewMenu = (anchor: HTMLElement): void => {
    if (viewMenuOpen) closeViewMenu()
    else openViewMenu(anchor)
  }

  const openMenu = (anchor: HTMLElement): void => {
    closeViewMenu()
    clearMenu()
    const snapshot = getMeshSnapshot()
    const { hosts, selected } = hostsOf(snapshot)
    const current = hosts.find(host => host.id === selected) ?? hosts[0]
    // A native <dialog> in the top layer is immune to the shell's stacking
    // contexts; older runtimes fall back to a body-level fixed div.
    const dialog = document.createElement('dialog')
    const canShowModal = typeof dialog.showModal === 'function'
    menu = canShowModal ? dialog : document.createElement('div')
    menu.className = `dm-host-menu dm-host-menu-floating${canShowModal ? ' dm-host-menu-dialog' : ''}`
    menu.setAttribute(MENU_ATTR, '')
    menu.setAttribute('role', 'listbox')
    menu.setAttribute('aria-label', options.t('host.section'))
    menu.addEventListener('click', (event) => {
      if (event.target === menu) closeMenu()
    })
    menu.addEventListener('cancel', (event) => {
      // Escape closes the top-layer dialog; mirror that in our state and the
      // host row's aria-expanded attribute.
      event.preventDefault()
      closeMenu()
    })

    for (const host of hosts) {
      const row = document.createElement('button')
      row.type = 'button'
      row.className = `dm-host-item${host.id === current?.id ? ' dm-host-item-active' : ''}`
      row.setAttribute('role', 'option')
      row.setAttribute('aria-selected', String(host.id === current?.id))
      row.setAttribute(HOST_ATTR, host.id)
      const dot = document.createElement('span')
      dot.className = `dm-host-dot dm-host-dot-${host.status}`
      row.append(dot)
      const body = document.createElement('span')
      body.className = 'dm-host-item-text'
      body.append(
        span('dm-host-item-name', host.name),
        span('dm-muted', host.local ? options.t('host.local') : options.t(`status.${host.status}`)),
      )
      row.append(body, pill(host.local ? '' : 'dm-pill-remote', host.local ? options.t('host.local') : options.t('devices.remoteBadge')))
      menu.append(row)
    }

    const divider = document.createElement('div')
    divider.className = 'dm-host-divider'
    menu.append(divider)
    const add = document.createElement('button')
    add.type = 'button'
    add.className = 'dm-host-add'
    add.setAttribute(ADD_ATTR, '')
    add.append(span('dm-host-add-plus', '+'), document.createTextNode(options.t('host.add')))
    menu.append(add)

    document.body.append(menu)
    if (canShowModal) {
      try { dialog.showModal() } catch { /* plain element still renders */ }
    }
    positionMenu(anchor)
    menuOpen = true
  }

  const toggleMenu = (anchor: HTMLElement): void => {
    if (menuOpen) closeMenu()
    else openMenu(anchor)
  }

  const requestRemote = (deviceId: string, force = false): void => {
    if (!force && remoteRequestedFor === deviceId) return
    remoteRequestedFor = deviceId
    lastRemoteRefreshAt = Date.now()
    remoteLoading = true
    remoteError = null
    renderAll()
    void meshApi.refreshWorkspaces(deviceId)
      .then(() => undefined)
      .catch((cause: unknown) => {
        remoteError = cause instanceof Error ? cause.message : String(cause)
      })
      .finally(() => {
        remoteLoading = false
        renderAll()
      })
  }

  /**
   * Keep the selected remote's session status fresh.
   *
   * The Host only refreshes `state.devices[].remoteWorkspaces` when asked, so
   * without this the mirror would show the first listing forever and running /
   * awaiting session state would never change. Throttled by
   * {@link remoteRefreshDue}; failures are silent and retried next window.
   */
  const refreshRemoteStatus = (device: MeshDeviceView): void => {
    if (!remoteRefreshDue({
      now: Date.now(),
      lastRefreshAt: lastRemoteRefreshAt,
      refreshing: remoteRefreshing,
      status: device.status,
    })) return
    lastRemoteRefreshAt = Date.now()
    remoteRefreshing = true
    void meshApi.refreshWorkspaces(device.deviceId)
      .catch(() => undefined)
      .finally(() => { remoteRefreshing = false })
  }

  const renderBar = (hosts: readonly HostView[], selected: string): void => {
    if (bar === null) return
    const current = hosts.find(host => host.id === selected) ?? hosts[0]
    const title = bar.querySelector<HTMLElement>('[data-dm-host-title]')
    const toggle = bar.querySelector<HTMLElement>(`[${TOGGLE_ATTR}]`)
    if (title !== null) title.textContent = options.t('host.section')
    if (viewButton !== null) {
      const remoteSelected = selected !== 'local'
      viewButton.hidden = !remoteSelected
      viewButton.setAttribute('aria-label', options.t('remote.viewOptions'))
      viewButton.setAttribute('title', options.t('remote.viewOptions'))
    }
    if (toggle === null) return
    toggle.textContent = ''
    if (current === undefined) {
      toggle.append(span('dm-sidebar-host-name', options.t('host.local')))
      return
    }
    const dot = document.createElement('span')
    dot.className = `dm-host-dot dm-host-dot-${current.status}`
    toggle.append(dot, span('dm-sidebar-host-name', current.name), span('dm-host-chevron', '\u25BE'))
    toggle.setAttribute('aria-label', options.t('host.switchTo', { name: current.name }))
    toggle.setAttribute('title', options.t('host.switchTo', { name: current.name }))
  }

  const statusCard = (device: MeshDeviceView): HTMLElement => {
    const card = document.createElement('div')
    card.className = 'dm-remote-status'
    const title = document.createElement('div')
    title.className = 'dm-remote-status-title'
    title.textContent = device.status === 'connecting' ? options.t('remote.connecting') : options.t('remote.offline')
    const hint = document.createElement('div')
    hint.className = 'dm-muted'
    hint.textContent = device.statusDetail === undefined ? '' : device.statusDetail
    card.append(title, hint)
    if (device.status !== 'revoked') {
      card.append(button('dm-remote-action', options.t('remote.reconnect'), () => { options.connectDevice(device.deviceId) }))
    }
    card.append(button('dm-remote-action', options.t('remote.manage'), () => { options.openDevices() }))
    return card
  }

  interface NativeRowStyle {
    readonly prefix: string
    readonly group: string
    readonly rootSpan: string
  }

  /** Discover the shell's hashed workspace-row classes at runtime. */
  const discoverRowStyle = (): NativeRowStyle | null => {
    const sample = document.querySelector<HTMLElement>('[class*="_projectRow"]')
    if (sample === null) return null
    const projectClass = Array.from(sample.classList).find(name => name.endsWith('_projectRow'))
    if (projectClass === undefined) return null
    const group = sample.closest<HTMLElement>('[class*="_groupSection"]')
    const rootSpan = sample.parentElement
    if (group === null || rootSpan === null) return null
    return {
      prefix: projectClass.slice(0, -'projectRow'.length),
      group: group.className,
      rootSpan: rootSpan.className,
    }
  }

  const icon = (name: string, size: number, className?: string): SVGSVGElement => {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    svg.setAttribute('width', String(size))
    svg.setAttribute('height', String(size))
    svg.setAttribute('data-icon', name)
    svg.setAttribute('aria-hidden', 'true')
    if (className !== undefined) svg.setAttribute('class', className)
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use')
    use.setAttribute('href', `#${name}`)
    svg.append(use)
    return svg
  }

  const expandedKey = (deviceId: string): string => `dsh-device-mesh:remote-expanded:${deviceId}`

  const loadExpanded = (deviceId: string): void => {
    remoteExpanded.clear()
    try {
      const raw = localStorage.getItem(expandedKey(deviceId))
      if (raw !== null) {
        const parsed = JSON.parse(raw) as unknown
        if (Array.isArray(parsed)) for (const id of parsed) if (typeof id === 'string') remoteExpanded.add(id)
      }
    } catch { /* storage unavailable */ }
    remoteExpandedDevice = deviceId
  }

  const persistExpanded = (): void => {
    if (remoteExpandedDevice === null) return
    try {
      localStorage.setItem(expandedKey(remoteExpandedDevice), JSON.stringify([...remoteExpanded]))
    } catch { /* storage unavailable */ }
  }

  const findRemoteSession = (
    device: MeshDeviceView | undefined,
    sessionId: string,
  ): WorkspaceSummary['sessions'][number] | undefined =>
    device?.remoteWorkspaces?.flatMap(workspace => workspace.sessions).find(session => session.id === sessionId)

  const selectRemoteSession = (device: MeshDeviceView, sessionId: string): void => {
    const target = findRemoteSession(device, sessionId)
    if (target === undefined || target.archived === true) return
    remoteActiveSession = sessionId
    rememberSession(device.deviceId, sessionId)
    const workspace = device.remoteWorkspaces?.find(item => item.sessions.some(session => session.id === sessionId))
    if (workspace !== undefined) {
      remoteExpanded.add(workspace.id)
      persistExpanded()
    }
    remoteSignature = ''
    renderAll()
  }

  const clearRemoteSession = (): void => {
    if (remoteActiveSession === null) return
    remoteActiveSession = null
    remoteSignature = ''
    renderAll()
  }

  /** Small inline archive/unarchive glyph (the shell exposes no archive sprite). */
  const archiveGlyph = (archived: boolean): SVGSVGElement => {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    svg.setAttribute('width', '14')
    svg.setAttribute('height', '14')
    svg.setAttribute('viewBox', '0 0 24 24')
    svg.setAttribute('fill', 'none')
    svg.setAttribute('stroke', 'currentColor')
    svg.setAttribute('stroke-width', '1.8')
    svg.setAttribute('stroke-linecap', 'round')
    svg.setAttribute('stroke-linejoin', 'round')
    svg.setAttribute('aria-hidden', 'true')
    const path = (d: string): void => {
      const node = document.createElementNS('http://www.w3.org/2000/svg', 'path')
      node.setAttribute('d', d)
      svg.append(node)
    }
    path('M3 6h18')
    if (archived) {
      path('M5 6v13a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V6')
      path('M9 11l3 3 3-3')
    } else {
      path('M5 6v13a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V6')
      path('M10 11h4')
    }
    return svg
  }

  /**
   * Archive or restore one Session on the remote device. Running work needs an
   * explicit confirmation because the daemon must stop it before archiving.
   */
  const performRemoteArchive = (
    device: MeshDeviceView,
    session: WorkspaceSummary['sessions'][number],
    stopActivity: boolean,
  ): void => {
    if (remoteMutationPending) return
    const archiving = session.archived !== true
    const token = ++remoteActionToken
    remoteMutationPending = true
    remoteNotice = null
    remoteSignature = ''
    renderAll()
    void meshApi.archiveSession(device.deviceId, session.id, archiving, stopActivity)
      .then(() => {
        if (token !== remoteActionToken || remoteHost !== device.deviceId) return
        remoteNotice = options.t(archiving ? 'remote.archiveSuccess' : 'remote.unarchiveSuccess')
        if (archiving) {
          // Archiving the Session that is currently selected removes its row
          // from the default view; drop the stale selection and remember-key.
          if (remoteActiveSession === session.id) remoteActiveSession = null
          if (lastSession(device.deviceId) === session.id) {
            try { localStorage.removeItem(lastSessionKey(device.deviceId)) } catch { /* storage unavailable */ }
          }
        }
      })
      .catch((cause: unknown) => {
        if (token !== remoteActionToken || remoteHost !== device.deviceId) return
        remoteNotice = options.t('remote.actionFailed', {
          message: cause instanceof Error ? cause.message : String(cause),
        })
      })
      .finally(() => {
        if (token !== remoteActionToken) return
        remoteMutationPending = false
        remoteSignature = ''
        renderAll()
      })
  }

  const toggleRemoteArchive = (
    device: MeshDeviceView,
    session: WorkspaceSummary['sessions'][number],
  ): void => {
    if (remoteMutationPending) return
    const archived = session.archived === true
    const active = session.running === true || session.awaitingUser === true
    if (!archived && active) {
      openConfirmDialog({
        title: options.t('remote.archive'),
        message: options.t('remote.archiveRunningConfirm', {
          title: session.title.length === 0 ? session.id : session.title,
        }),
        confirmLabel: options.t('remote.archive'),
        onConfirm: () => { performRemoteArchive(device, session, true) },
      })
      return
    }
    performRemoteArchive(device, session, false)
  }

  const archiveButton = (
    device: MeshDeviceView,
    prefix: string,
    session: WorkspaceSummary['sessions'][number],
  ): HTMLButtonElement => {
    const archived = session.archived === true
    const label = options.t(archived ? 'remote.unarchive' : 'remote.archive')
    const action = document.createElement('button')
    action.type = 'button'
    action.className = prefix.length > 0
      ? `${prefix}iconButton dm-remote-external-btn dm-remote-archive-btn`
      : 'dm-remote-external-btn dm-remote-archive-btn'
    action.title = label
    action.setAttribute('aria-label', label)
    action.disabled = remoteMutationPending
    action.append(archiveGlyph(archived))
    action.addEventListener('click', (event) => {
      event.stopPropagation()
      toggleRemoteArchive(device, session)
    })
    return action
  }

  const externalButton = (device: MeshDeviceView, prefix: string, sessionId?: string): HTMLButtonElement => {
    const open = document.createElement('button')
    open.type = 'button'
    open.className = prefix.length > 0
      ? `${prefix}iconButton dm-remote-external-btn`
      : 'dm-remote-external-btn'
    open.title = options.t('remote.open')
    open.setAttribute('aria-label', options.t('remote.open'))
    open.textContent = '\u2197'
    open.addEventListener('click', (event) => {
      event.stopPropagation()
      if (sessionId === undefined) clearRemoteSession()
      else selectRemoteSession(device, sessionId)
      options.openPortal(device.deviceId, sessionId)
    })
    return open
  }

  const relativeTime = (iso: string): string => {
    const then = Date.parse(iso)
    if (!Number.isFinite(then)) return ''
    const minutes = Math.max(1, Math.round((Date.now() - then) / 60_000))
    try {
      const locale = document.documentElement.lang.length > 0 ? document.documentElement.lang : 'en'
      const formatter = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' })
      if (minutes < 60) return formatter.format(-minutes, 'minute')
      const hours = Math.round(minutes / 60)
      if (hours < 24) return formatter.format(-hours, 'hour')
      return formatter.format(-Math.round(hours / 24), 'day')
    } catch {
      return `${minutes}m`
    }
  }

  /**
   * Status indicator for a remote session row: a spinner while the session is
   * running (matching the native shell), otherwise a small state dot.
   */
  const sessionIndicator = (session: WorkspaceSummary['sessions'][number]): HTMLElement => {
    if (session.running) {
      const spinner = span('dm-spinner dm-remote-session-spinner', '')
      spinner.setAttribute('role', 'img')
      spinner.title = options.t('remote.running')
      spinner.setAttribute('aria-label', options.t('remote.running'))
      return spinner
    }
    const dot = span('dm-remote-session-dot', '')
    if (session.awaitingUser) {
      dot.classList.add('dm-remote-session-dot-awaiting')
      dot.title = options.t('status.connecting')
    } else if (session.unread) {
      dot.classList.add('dm-remote-session-dot-unread')
    }
    return dot
  }

  const openRemoteSession = (
    device: MeshDeviceView,
    session: WorkspaceSummary['sessions'][number],
  ): void => {
    if (session.archived === true) {
      remoteNotice = options.t('remote.archivedOpenBlocked')
      remoteSignature = ''
      renderAll()
      return
    }
    selectRemoteSession(device, session.id)
    options.openPortal(device.deviceId, session.id)
  }

  const sessionNode = (
    style: NativeRowStyle,
    device: MeshDeviceView,
    session: WorkspaceSummary['sessions'][number],
    workspaceTitle?: string,
  ): HTMLElement => {
    // Prefer a clone of a mounted native session row: it carries the shell's
    // exact slots, status-dot geometry, title/resting/action wrappers and
    // classes. If the local list has no session mounted, build the same shape.
    const template = document.querySelector<HTMLElement>('[class*="_sessionRow"]')
    const row = template?.cloneNode(true) as HTMLElement | undefined
      ?? document.createElement('div')
    row.className = `${style.prefix}sessionRow`
    row.removeAttribute('data-row-key')
    row.removeAttribute('aria-description')
    row.setAttribute('role', 'treeitem')
    row.setAttribute('tabindex', '0')
    const archived = session.archived === true
    if (archived) row.classList.add('dm-remote-session-archived')
    const selected = remoteActiveSession === session.id
    row.setAttribute('aria-selected', String(selected))
    if (selected) row.classList.add(`${style.prefix}selected`)
    row.setAttribute('data-dm-remote-session', session.id)
    row.title = options.t(archived ? 'remote.archivedOpenBlocked' : 'remote.open')
    row.addEventListener('click', (event) => {
      event.stopPropagation()
      openRemoteSession(device, session)
    })
    row.addEventListener('keydown', (event) => {
      // A focused action button owns its own Enter/Space activation.
      if (event.target !== row) return
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault()
        event.stopPropagation()
        openRemoteSession(device, session)
      }
    })
    const time = span('dm-remote-session-time', relativeTime(session.updatedAt))
    time.title = session.updatedAt
    const title = row.querySelector<HTMLElement>(`:scope > .${CSS.escape(`${style.prefix}title`)}`)
      ?? span(`${style.prefix}title`, '')
    title.textContent = session.title.length === 0 ? session.id : session.title
    const slot = row.querySelector<HTMLElement>(`:scope > .${CSS.escape(`${style.prefix}slot`)}`)
      ?? span(`${style.prefix}slot`, '')
    slot.replaceChildren(sessionIndicator(session))
    const resting = row.querySelector<HTMLElement>(`:scope > .${CSS.escape(`${style.prefix}rowResting`)}`)
      ?? span(`${style.prefix}rowResting`, '')
    const restingParts: HTMLElement[] = []
    if (archived) restingParts.push(span('dm-remote-archived-badge', options.t('remote.archivedBadge')))
    if (workspaceTitle !== undefined) {
      const group = span('dm-remote-session-ws', workspaceTitle)
      group.title = workspaceTitle
      restingParts.push(group)
    }
    restingParts.push(time)
    resting.replaceChildren(...restingParts)
    const actions = row.querySelector<HTMLElement>(`:scope > .${CSS.escape(`${style.prefix}rowActions`)}`)
      ?? span(`${style.prefix}rowActions`, '')
    actions.className = `${style.prefix}rowActions dm-remote-actions`
    actions.replaceChildren(
      archiveButton(device, style.prefix, session),
      ...(archived ? [] : [externalButton(device, style.prefix, session.id)]),
    )
    if (!row.contains(slot)) row.append(slot)
    if (!row.contains(title)) row.append(title)
    if (!row.contains(resting)) row.append(resting)
    if (!row.contains(actions)) row.append(actions)
    return row
  }

  /** Fallback row used when no native row is mounted to clone, including flat mode. */
  const fallbackSessionNode = (
    device: MeshDeviceView,
    session: WorkspaceSummary['sessions'][number],
    workspaceTitle?: string,
  ): HTMLElement => {
    const row = document.createElement('div')
    row.className = 'dm-remote-session'
    row.setAttribute('role', 'treeitem')
    row.setAttribute('tabindex', '0')
    row.setAttribute('data-dm-remote-session', session.id)
    const archived = session.archived === true
    if (archived) row.classList.add('dm-remote-session-archived')
    if (remoteActiveSession === session.id) row.classList.add('dm-remote-session-active')
    row.title = options.t(archived ? 'remote.archivedOpenBlocked' : 'remote.open')
    const body: Array<Node | string> = [
      sessionIndicator(session),
      span('dm-remote-session-title', session.title.length === 0 ? session.id : session.title),
    ]
    if (workspaceTitle !== undefined) {
      const group = span('dm-remote-session-ws', workspaceTitle)
      group.title = workspaceTitle
      body.push(group)
    }
    if (archived) body.push(span('dm-remote-archived-badge', options.t('remote.archivedBadge')))
    const actions = span('dm-remote-session-meta', '')
    actions.append(archiveButton(device, '', session))
    if (!archived) actions.append(externalButton(device, '', session.id))
    body.push(actions)
    row.append(...body)
    const activate = (): void => { openRemoteSession(device, session) }
    row.addEventListener('click', (event) => {
      const target = event.target as Element | null
      if (target !== null && target.closest('button') !== null) return
      event.stopPropagation()
      activate()
    })
    row.addEventListener('keydown', (event) => {
      if (event.target !== row) return
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault()
        event.stopPropagation()
        activate()
      }
    })
    return row
  }

  const workspaceNode = (device: MeshDeviceView, workspace: WorkspaceSummary): HTMLElement => {
    const style = discoverRowStyle()
    if (style === null) {
      // No local row is mounted to copy classes from (e.g. a fresh empty
      // controller): keep a readable fallback with the same click contract.
      const fallback = document.createElement('div')
      fallback.className = 'dm-remote-ws'
      const head = document.createElement('div')
      head.className = 'dm-remote-ws-head'
      head.setAttribute('role', 'button')
      head.setAttribute('tabindex', '0')
      head.setAttribute('data-dm-remote-workspace', workspace.id)
      head.append(
        span('dm-remote-ws-title', workspace.title),
        externalButton(device, 'dm-remote-', workspace.sessions.find(session => session.archived !== true)?.id),
      )
      const openWorkspace = (): void => {
        clearRemoteSession()
        options.openPortal(device.deviceId)
      }
      head.addEventListener('click', (event) => {
        const target = event.target as Element | null
        if (target !== null && target.closest('button') !== null) return
        openWorkspace()
      })
      head.addEventListener('keydown', (event) => {
        if (event.target !== head) return
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          openWorkspace()
        }
      })
      fallback.append(head)
      for (const session of workspace.sessions) {
        fallback.append(fallbackSessionNode(device, session))
      }
      return fallback
    }
    const expanded = remoteExpanded.has(workspace.id)
    const group = document.createElement('div')
    group.className = style.group
    group.style.setProperty('--dsh-workspace-indent', '0px')
    const rootSpan = document.createElement('span')
    rootSpan.className = style.rootSpan
    const row = document.createElement('div')
    row.className = `${style.prefix}projectRow`
    row.setAttribute('role', 'treeitem')
    row.setAttribute('tabindex', '0')
    row.setAttribute('aria-expanded', String(expanded))
    row.setAttribute('data-dm-remote-workspace', workspace.id)
    row.title = workspace.title
    row.addEventListener('click', () => {
      // A workspace with no sessions has nothing to expand: open its remote UI.
      if (workspace.sessions.length === 0) {
        clearRemoteSession()
        options.openPortal(device.deviceId)
        return
      }
      if (expanded) remoteExpanded.delete(workspace.id)
      else remoteExpanded.add(workspace.id)
      persistExpanded()
      remoteSignature = ''
      renderAll()
    })
    row.addEventListener('keydown', (event) => {
      if (event.target !== row) return
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault()
        row.click()
      }
    })
    const folder = span(`${style.prefix}slot ${style.prefix}folder${expanded ? ` ${style.prefix}folderActive` : ''}`, '')
    folder.append(icon(expanded ? 'dsw-icon-folder-open-regular' : 'dsw-icon-folder-close-regular', 16))
    const chevron = span(`${style.prefix}slot ${style.prefix}chevron`, '')
    chevron.append(icon('dsw-icon-triangle-right-fill-regular', 14, `${style.prefix}arrow${expanded ? ` ${style.prefix}arrowOpen` : ''}`))
    const text = document.createElement('span')
    text.className = `${style.prefix}projectText`
    const title = span(`${style.prefix}title`, workspace.title)
    text.append(title)
    const actions = span(`${style.prefix}rowActions dm-remote-actions`, '')
    actions.append(externalButton(device, style.prefix, workspace.sessions.find(session => session.archived !== true)?.id))
    row.append(folder, chevron, text, actions)
    rootSpan.append(row)
    group.append(rootSpan)
    if (expanded) {
      for (const session of workspace.sessions) group.append(sessionNode(style, device, session))
    }
    return group
  }

  /** Whether one Session passes the current archived-visibility filter. */
  const archivedVisible = (session: WorkspaceSummary['sessions'][number]): boolean => {
    if (remoteView.archivedFilter === 'show') return true
    if (remoteView.archivedFilter === 'only') return session.archived === true
    return session.archived !== true
  }

  const sessionTime = (session: WorkspaceSummary['sessions'][number]): number => {
    const parsed = Date.parse(session.updatedAt)
    return Number.isFinite(parsed) ? parsed : 0
  }

  /** Apply the mirror's order choice to one session list. */
  const orderedSessions = (
    sessions: readonly WorkspaceSummary['sessions'][number][],
  ): WorkspaceSummary['sessions'][number][] => {
    const list = [...sessions]
    list.sort((left, right) => {
      if (remoteView.orderBy === 'title') {
        const leftTitle = left.title.length === 0 ? left.id : left.title
        const rightTitle = right.title.length === 0 ? right.id : right.title
        return leftTitle.localeCompare(rightTitle)
      }
      return sessionTime(right) - sessionTime(left)
    })
    return list
  }

  /** Apply the search query plus archived filter to the listing. */
  const filterWorkspaces = (
    workspaces: readonly WorkspaceSummary[],
    query: string,
  ): WorkspaceSummary[] => {
    const result: WorkspaceSummary[] = []
    for (const workspace of workspaces) {
      const visibleSessions = workspace.sessions.filter(archivedVisible)
      const titleMatches = query.length > 0 && workspace.title.toLowerCase().includes(query)
      const sessions = query.length === 0 || titleMatches
        ? visibleSessions
        : visibleSessions.filter(session =>
          (session.title.length === 0 ? session.id : session.title).toLowerCase().includes(query))
      if (query.length > 0 && !titleMatches && sessions.length === 0) continue
      // The archived-only view drops groups with nothing archived, like the
      // native tree; the default view keeps empty workspaces so their remote UI
      // stays one click away.
      if (remoteView.archivedFilter === 'only' && sessions.length === 0) continue
      result.push({ ...workspace, sessions: orderedSessions(sessions) })
    }
    return result
  }

  const appendRemoteNotice = (): void => {
    if (remoteRoot === null || remoteNotice === null) return
    const notice = document.createElement('div')
    notice.className = 'dm-remote-status dm-remote-notice'
    notice.append(span('dm-muted', remoteNotice))
    remoteRoot.append(notice)
  }

  const remoteEmptyState = (
    device: MeshDeviceView,
    kind: 'no-match' | 'no-archived' | 'no-sessions' | 'no-visible',
  ): void => {
    if (remoteRoot === null) return
    const empty = document.createElement('div')
    empty.className = 'dm-remote-status'
    const showAll = (filter: RemoteArchivedFilter): void => {
      remoteView = { ...remoteView, archivedFilter: filter }
      persistRemoteView()
      remoteSignature = ''
      renderAll()
    }
    if (kind === 'no-match') {
      empty.append(span('dm-remote-status-title', options.t('remote.noMatches')))
      empty.append(span('dm-muted', options.t('remote.noMatchesHint')))
      remoteRoot.append(empty)
      return
    }
    if (kind === 'no-archived') {
      empty.append(span('dm-remote-status-title', options.t('remote.emptyArchived')))
      empty.append(button(
        'dm-remote-action dm-remote-action-primary',
        options.t('remote.showAll'),
        () => { showAll('hide') },
      ))
      remoteRoot.append(empty)
      return
    }
    if (kind === 'no-visible') {
      empty.append(
        span('dm-remote-status-title', options.t('remote.emptySessions')),
        span('dm-muted', options.t('remote.emptySessionsHint')),
      )
      if (remoteView.archivedFilter === 'hide') {
        // The rows exist but are archived: "show all" must reveal them rather
        // than re-selecting the same filter that produced this state.
        empty.append(button(
          'dm-remote-action dm-remote-action-primary',
          options.t('remote.showAll'),
          () => { showAll('show') },
        ))
      }
      empty.append(button('dm-remote-action', options.t('remote.open'), () => {
        options.openPortal(device.deviceId)
      }))
      remoteRoot.append(empty)
      return
    }
    empty.append(
      span('dm-remote-status-title', options.t('remote.empty')),
      span('dm-muted', options.t('remote.emptyHint')),
    )
    empty.append(button('dm-remote-action dm-remote-action-primary', options.t('remote.open'), () => {
      options.openPortal(device.deviceId)
    }))
    remoteRoot.append(empty)
  }

  const renderRemote = (device: MeshDeviceView | undefined): void => {
    if (remoteRoot === null) return
    if (device === undefined) {
      remoteSignature = ''
      remoteRoot.textContent = ''
      remoteRoot.hidden = true
      return
    }
    const workspaces = device.remoteWorkspaces
    if (workspaces !== undefined && remoteActiveSession !== null) {
      const active = findRemoteSession(device, remoteActiveSession)
      if (active === undefined || active.archived === true) remoteActiveSession = null
    }
    // The mesh store polls every 2.5 s; rebuilding an unchanged list would
    // reset the sidebar scroll position.  Only rebuild when the rendered data
    // actually changes.
    const signature = JSON.stringify([
      device.deviceId,
      device.status,
      device.statusDetail,
      device.remoteWorkspacesTruncated === true,
      workspaces?.map(workspace => [
        workspace.id,
        workspace.title,
        workspace.sessions.map(session => [
          session.id,
          session.title,
          session.updatedAt,
          session.running,
          session.awaitingUser,
          session.unread,
          session.archived === true,
        ]),
      ]),
      [...remoteExpanded].sort(),
      remoteActiveSession,
      remoteQuery,
      remoteLoading,
      remoteError,
      remoteNotice,
      remoteMutationPending,
      remoteView,
    ])
    if (signature === remoteSignature && remoteRoot.childElementCount > 0) return
    remoteSignature = signature
    const previousHost = remoteRoot.dataset.dmHost
    const scrollTop = remoteRoot.scrollTop
    remoteRoot.textContent = ''
    remoteRoot.hidden = false
    remoteRoot.dataset.dmHost = device.deviceId
    remoteRoot.classList.toggle('dm-remote-busy', remoteMutationPending)
    if (device.status !== 'online') {
      remoteRoot.append(statusCard(device))
      return
    }
    if (workspaces === undefined) {
      if (remoteError !== null) {
        const error = document.createElement('div')
        error.className = 'dm-remote-status'
        error.append(span('dm-remote-status-title', options.t('remote.error')), span('dm-muted', remoteError))
        error.append(button('dm-remote-action', options.t('remote.retry'), () => {
          remoteRequestedFor = null
          requestRemote(device.deviceId, true)
        }))
        remoteRoot.append(error)
      } else {
        if (remoteRequestedFor !== device.deviceId) requestRemote(device.deviceId)
        const loading = document.createElement('div')
        loading.className = 'dm-remote-loading'
        loading.textContent = options.t('remote.loading', { name: device.name })
        remoteRoot.append(loading)
      }
      return
    }
    const query = remoteQuery.trim().toLowerCase()
    const visible = filterWorkspaces(workspaces, query)
    // Show action feedback before the list, so a long remote tree cannot push a
    // failure notice below the fold (the old placement looked like "no response").
    appendRemoteNotice()
    if (remoteView.groupBy === 'flat') {
      const flat = visible.flatMap(workspace => workspace.sessions.map(session => ({ workspace, session })))
      flat.sort((left, right) => {
        if (remoteView.orderBy === 'title') {
          const leftTitle = left.session.title.length === 0 ? left.session.id : left.session.title
          const rightTitle = right.session.title.length === 0 ? right.session.id : right.session.title
          return leftTitle.localeCompare(rightTitle)
        }
        return sessionTime(right.session) - sessionTime(left.session)
      })
      if (flat.length === 0) {
        remoteEmptyState(
          device,
          query.length > 0
            ? 'no-match'
            : remoteView.archivedFilter === 'only'
              ? 'no-archived'
              : workspaces.length === 0 ? 'no-sessions' : 'no-visible',
        )
        return
      }
      const style = discoverRowStyle()
      const list = document.createElement('div')
      list.className = 'dm-remote-flat'
      for (const item of flat) {
        list.append(style === null
          ? fallbackSessionNode(device, item.session, item.workspace.title)
          : sessionNode(style, device, item.session, item.workspace.title))
      }
      remoteRoot.append(list)
    } else if (visible.length === 0) {
      remoteEmptyState(
        device,
        query.length > 0
          ? 'no-match'
          : remoteView.archivedFilter === 'only'
            ? 'no-archived'
            : workspaces.length === 0 ? 'no-sessions' : 'no-visible',
      )
      return
    } else {
      for (const workspace of visible) remoteRoot.append(workspaceNode(device, workspace))
    }
    if (device.remoteWorkspacesTruncated === true) {
      const truncated = document.createElement('div')
      truncated.className = 'dm-remote-status'
      truncated.append(span('dm-muted', options.t('remote.truncated')))
      remoteRoot.append(truncated)
    }
    if (remoteLoading) {
      const loading = document.createElement('div')
      loading.className = 'dm-remote-loading'
      loading.textContent = options.t('remote.loading', { name: device.name })
      remoteRoot.append(loading)
    }
    if (previousHost === device.deviceId) remoteRoot.scrollTop = scrollTop
    updateRemoteBounds()
  }

  const updateRemoteBounds = (): void => {
    if (remoteRoot === null || remoteHost === null) return
    const top = remoteRoot.getBoundingClientRect().top
    // Leave room for the shell's footer ("More") and a little breathing space.
    const available = Math.max(200, window.innerHeight - top - 64)
    remoteRoot.style.maxHeight = `${Math.floor(available)}px`
  }

  const syncNativeMode = (): void => {
    if (nativeRoot === null) return
    const active = remoteHost !== null
    // Do not measure the native header here: in remote mode it is hidden by
    // `dm-remote-mode` and would measure 0px, which made the next tick treat
    // the expanded sidebar as a rail and hide the whole mirror. The native
    // root keeps the sidebar width regardless of which children are visible.
    const wide = nativeRoot.getBoundingClientRect().width > 80
    nativeRoot.classList.toggle('dm-remote-mode', active)
    // The sidebar rail is 56px wide; the injected bar/mirror are wide-only.
    if (bar !== null) bar.hidden = !wide
    if (remoteRoot !== null) remoteRoot.hidden = !active
    updateRemoteBounds()
  }

  const renderAll = (): void => {
    if (disposed) return
    const snapshot = getMeshSnapshot()
    const { hosts, selected } = hostsOf(snapshot)
    if (selected !== 'local' && snapshot.state !== null
      && !snapshot.state.devices.some(device => device.deviceId === selected)) {
      // The selected device was forgotten/revoked elsewhere: fall back to this
      // host rather than keeping a stale scope.
      setSelectedHost('local')
      return
    }
    renderBar(hosts, selected)
    const device = selected === 'local'
      ? undefined
      : snapshot.state?.devices.find(item => item.deviceId === selected)
    const previous = remoteHost
    remoteHost = device === undefined ? null : device.deviceId
    if (remoteHost !== previous) {
      lastRemoteRefreshAt = 0
      remoteRefreshing = false
      remoteError = null
      remoteNotice = null
      remoteMutationPending = false
      // Ignore callbacks from an archive request issued for the previous host.
      remoteActionToken += 1
      remoteActiveSession = null
      closeViewMenu()
      closeConfirmDialog()
      if (remoteHost === null) {
        remoteRequestedFor = null
        remoteExpandedDevice = null
        remoteView = { ...DEFAULT_REMOTE_VIEW }
      } else {
        // A local workspace search must not filter the remote inventory; clear
        // both our copy and the native input's controlled state.
        remoteQuery = ''
        remoteNotice = null
        const input = document.querySelector<HTMLInputElement>('input[class*="_searchInput"]')
        if (input !== null && input.value.length > 0) {
          try {
            // oxlint-disable-next-line typescript/unbound-method -- invoked below with .call(input)
            const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
            setter?.call(input, '')
            input.dispatchEvent(new Event('input', { bubbles: true }))
          } catch { /* controlled input rejected the reset */ }
        }
        loadExpanded(remoteHost)
        loadRemoteView(remoteHost)
      }
    }
    syncNativeMode()
    renderRemote(device)
    if (device !== undefined) refreshRemoteStatus(device)
    if (menuOpen && menu !== null) {
      const toggle = bar?.querySelector<HTMLElement>(`[${TOGGLE_ATTR}]`)
      if (toggle !== undefined && toggle !== null) positionMenu(toggle)
    }
    if (viewMenuOpen && viewMenu !== null && viewButton !== null) {
      positionFloating(viewButton, viewMenu)
    }
  }

  const createNodes = (header: HTMLElement): void => {
    const parent = header.parentElement
    if (parent === null) return
    nativeRoot = parent
    if (bar === null || !bar.isConnected) {
      bar = document.createElement('div')
      bar.className = 'dm-sidebar-host'
      bar.setAttribute(BAR_ATTR, '')
      const head = document.createElement('div')
      head.className = 'dm-sidebar-host-head'
      const title = document.createElement('div')
      title.className = 'dm-sidebar-host-title'
      title.setAttribute('data-dm-host-title', '')
      const view = document.createElement('button')
      view.type = 'button'
      view.className = 'dm-sidebar-host-view'
      view.setAttribute(VIEW_ATTR, '')
      view.setAttribute('aria-haspopup', 'menu')
      view.setAttribute('aria-expanded', 'false')
      view.hidden = true
      const sliders = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
      sliders.setAttribute('width', '14')
      sliders.setAttribute('height', '14')
      sliders.setAttribute('viewBox', '0 0 24 24')
      sliders.setAttribute('fill', 'none')
      sliders.setAttribute('stroke', 'currentColor')
      sliders.setAttribute('stroke-width', '1.8')
      sliders.setAttribute('stroke-linecap', 'round')
      sliders.setAttribute('aria-hidden', 'true')
      for (const d of ['M4 7h10', 'M18 7h2', 'M4 17h2', 'M10 17h10', 'M14 5v4', 'M8 15v4']) {
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
        path.setAttribute('d', d)
        sliders.append(path)
      }
      view.append(sliders)
      view.addEventListener('click', (event) => {
        event.stopPropagation()
        toggleViewMenu(view)
      })
      viewButton = view
      head.append(title, view)
      const toggle = document.createElement('button')
      toggle.type = 'button'
      toggle.className = 'dm-sidebar-host-current'
      toggle.setAttribute(TOGGLE_ATTR, '')
      toggle.setAttribute('aria-haspopup', 'listbox')
      toggle.setAttribute('aria-expanded', 'false')
      toggle.addEventListener('click', () => {
        toggleMenu(toggle)
        toggle.setAttribute('aria-expanded', String(menuOpen))
      })
      bar.append(head, toggle)
      parent.insertBefore(bar, header)
    }
    if (remoteRoot === null || !remoteRoot.isConnected) {
      remoteRoot = document.createElement('div')
      remoteRoot.className = 'dm-remote-workspaces'
      remoteRoot.setAttribute(REMOTE_ATTR, '')
      remoteRoot.hidden = true
      header.insertAdjacentElement('afterend', remoteRoot)
    }
    renderAll()
  }

  const ensure = (): void => {
    if (disposed) return
    const header = findWorkspaceHeader()
    if (header === null) return
    if (bar === null || !bar.isConnected || remoteRoot === null || !remoteRoot.isConnected || nativeRoot !== header.parentElement) {
      createNodes(header)
    }
    else {
      // React may reset the native root's className when it re-renders.
      syncNativeMode()
    }
  }

  const ensureStructure = (): void => {
    if (disposed) return
    if (bar !== null && bar.isConnected && remoteRoot !== null && remoteRoot.isConnected && findWorkspaceHeader() !== null) return
    ensure()
  }

  const onClickDocument = (event: MouseEvent): void => {
    const target = event.target as Element | null
    if (target === null) return
    // The floating view menu handles its own item clicks (and Escape/cancel).
    if (target.closest(`[${VIEW_MENU_ATTR}]`) !== null) return
    if (target.closest(`[${BAR_ATTR}]`) !== null || target.closest(`[${MENU_ATTR}]`) !== null) {
      // Any click in the bar other than the sliders control dismisses the menu.
      if (target.closest(`[${VIEW_ATTR}]`) === null) closeViewMenu()
      const hostId = target.closest<HTMLElement>(`[${HOST_ATTR}]`)?.getAttribute(HOST_ATTR)
      if (hostId !== null && hostId !== undefined) {
        const target = getMeshSnapshot().state?.devices.find(device => device.deviceId === hostId)
        if (hostId === 'local') {
          hideRemotePane()
          remoteActiveSession = null
        }
        setSelectedHost(hostId)
        closeMenu()
        renderAll()
        if (hostId !== 'local') {
          // Always refresh the inventory when entering a host; a cached listing
          // may predate sessions created on the remote while another host was
          // selected.
          remoteRequestedFor = null
          requestRemote(hostId, true)
          // Restore this host's last remote view instead of forcing the Devices
          // panel; a first-ever visit leaves the local main column untouched.
          const remembered = lastSession(hostId)
          const targetDevice = getMeshSnapshot().state?.devices.find(device => device.deviceId === hostId)
          if (remembered !== null && targetDevice?.status === 'online'
            && findRemoteSession(targetDevice, remembered)?.archived !== true) {
            options.openPortal(hostId, remembered)
          }
        }
        // An offline host selected from the switcher is expected to come back
        // automatically; the mirror then loads its workspaces when online.
        if (target !== undefined && target.status !== 'online' && !target.revoked) {
          options.connectDevice(target.deviceId)
        }
        return
      }
      if (menu !== null && target === menu) {
        closeMenu()
        return
      }
      if (target.closest(`[${ADD_ATTR}]`) !== null) {
        requestAddHost()
        options.openDevices()
        closeMenu()
        return
      }
      return
    }
    closeViewMenu()
    closeMenu()
  }

  const onSearchInput = (event: Event): void => {
    const target = event.target
    if (!(target instanceof HTMLInputElement)) return
    if (!target.matches('input[class*="_searchInput"]')) return
    if (remoteHost === null || remoteQuery === target.value) return
    remoteQuery = target.value
    remoteSignature = ''
    renderAll()
  }
  document.addEventListener('input', onSearchInput, true)

  const onRemoteWheel = (event: WheelEvent): void => {
    if (remoteHost === null || remoteRoot === null) return
    const target = event.target
    if (!(target instanceof Node) || !remoteRoot.contains(target)) return
    if (event.ctrlKey) return
    const delta = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaY
    if (delta === 0) return
    event.preventDefault()
    remoteRoot.scrollTop += delta
  }
  document.addEventListener('wheel', onRemoteWheel, { capture: true, passive: false })

  const observer = new MutationObserver(() => { ensureStructure() })
  observer.observe(document.body, { childList: true, subtree: true })
  document.addEventListener('click', onClickDocument, true)
  const unsubscribeMesh = subscribeMesh(() => { ensure(); renderAll() })
  const unsubscribeHost = subscribeHost(() => { renderAll() })
  const interval = window.setInterval(() => {
    ensureStructure()
    syncNativeMode()
    updateRemoteBounds()
    // The embedded remote shell reports its own Session changes; mirror that
    // selection in the sidebar so the two stay in sync.
    if (remoteHost !== null && remotePaneDevice() === remoteHost) {
      const sessionId = remotePaneSession()
      if (sessionId !== null && sessionId !== remoteActiveSession) {
        const device = getMeshSnapshot().state?.devices.find(item => item.deviceId === remoteHost)
        if (device !== undefined) selectRemoteSession(device, sessionId)
      }
    }
  }, 1_000)
  void refreshMeshState()
  ensure()
  renderAll()

  return () => {
    disposed = true
    observer.disconnect()
    document.removeEventListener('click', onClickDocument, true)
    document.removeEventListener('input', onSearchInput, true)
    document.removeEventListener('wheel', onRemoteWheel, { capture: true })
    unsubscribeMesh()
    unsubscribeHost()
    window.clearInterval(interval)
    closeMenu()
    closeViewMenu()
    closeConfirmDialog()
    bar?.remove()
    remoteRoot?.remove()
    nativeRoot?.classList.remove('dm-remote-mode')
    bar = null
    remoteRoot = null
    nativeRoot = null
    viewButton = null
  }
}
