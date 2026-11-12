/**
 * The Devices main panel: this device (direct/relay), daemon-side pairing QR,
 * paired devices with remote-control/portal actions, and remote workspaces
 * grouped by device.
 *
 * The panel never receives the Cordis context. Its data comes from the polling
 * store in `api.ts` and the only capability it needs from `apply` — opening a
 * URL in the right sidebar — arrives through the slot `inject` face as
 * `openRemoteTab`.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { MeshDeviceView, MeshHostState } from '../shared/protocol.js'
import type { PairingTicket } from './api.js'
import { meshApi, refreshMeshState, useMeshSnapshot } from './api.js'
import { consumeAddHostRequest, setSelectedHost, useAddHostRequests, useSelectedHost } from './host-store.js'
import { AddDeviceDialog, PendingPairingsCard } from './pairing.js'
import { qrDataUrl } from './qr.js'
import { relayTlsForInput } from './relay-endpoint.js'
import type { Translate } from './types.js'
import {
  Button, CopyButton, DeviceMeshGlyph, ExternalGlyph, KeyValue, RefreshGlyph, Spinner, StatusLine,
  describeError, describeStatusDetail, el, formatCountdown, formatRelativeTime,
  navigatePortalWindow, openBlankPortalWindow, openExternalBrowser, openPortalWindow, platformLabel,
  scopeLabel, translateOf, useNow, useTransientNotice,
} from './ui.js'
import type { UiChild } from './ui.js'

/** Props the plugin injects into the main panel registration. */
export interface DevicesPanelProps {
  readonly t?: Translate
  /**
   * Open a portal URL in the right sidebar's Browser tab. Present only when the
   * `sidebarRight` service is composed; returns false when it is unavailable.
   */
  readonly openRemoteTab?: (url: string) => boolean | Promise<boolean>
  /** Show the peer GUI in an iframe over the center column. */
  readonly openRemotePane?: (deviceId: string, deviceName: string, url: string, sessionId?: string) => boolean
}

/** Best-effort destructive-action confirmation. */
function confirmAction(message: string): boolean {
  try {
    if (typeof window === 'undefined') return true
    return window.confirm(message)
  } catch {
    return true
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** A responsive, always-≥40px-height switch. */
function Switch(props: {
  readonly label: string
  readonly checked: boolean
  readonly disabled?: boolean
  readonly onChange: (next: boolean) => void
}): UiChild {
  return el(
    'label',
    { className: 'dm-switch' },
    el('input', {
      type: 'checkbox',
      checked: props.checked,
      disabled: props.disabled === true,
      'aria-label': props.label,
      onChange: (event: { target: { checked: boolean } }) => { props.onChange(event.target.checked) },
    }),
    el('span', { className: 'dm-switch-track', 'aria-hidden': 'true' }),
    el('span', { className: 'dm-switch-label' }, props.label),
  )
}

/** One QR image, generated locally from the pairing link. */
function QrPlate(props: {
  readonly link: string
  readonly fallbackSvg?: string
  readonly alt: string
}): UiChild {
  const dataUrl = useMemo(() => {
    try {
      return qrDataUrl(props.link)
    } catch {
      return null
    }
  }, [props.link])
  if (dataUrl !== null) return el('img', { src: dataUrl, alt: props.alt })
  if (props.fallbackSvg !== undefined) return el('span', { dangerouslySetInnerHTML: { __html: props.fallbackSvg } })
  return el('span', { className: 'dm-qr-placeholder' }, props.alt)
}

/** Section header shared by the panel's cards. */
function CardHead(props: {
  readonly title: string
  readonly children?: UiChild
}): UiChild {
  return el(
    'div',
    { className: 'dm-card-head' },
    el('h2', { className: 'dm-card-title' }, props.title),
    props.children === undefined ? null : el('div', { className: 'dm-row' }, props.children),
  )
}

/** Readable error banner. */
function ErrorBanner(props: { readonly message: string; readonly onDismiss?: () => void; readonly t: Translate }): UiChild {
  return el(
    'div',
    { className: 'dm-banner dm-banner-error', role: 'alert' },
    el('div', { className: 'dm-banner-text' }, props.message),
    props.onDismiss === undefined ? null : Button({
      variant: 'ghost',
      small: true,
      onClick: props.onDismiss,
      children: props.t('error.dismiss'),
    }),
  )
}

/** Success / status banner. */
function NoticeBanner(props: { readonly message: string }): UiChild {
  return el(
    'div',
    { className: 'dm-banner dm-banner-success', role: 'status', 'aria-live': 'polite' },
    el('div', { className: 'dm-banner-text' }, props.message),
  )
}

/** Panel header with the two top-level actions. */
function PanelHeader(props: {
  readonly t: Translate
  readonly state: MeshHostState | null
  readonly loading: boolean
  readonly onRefresh: () => void
  readonly onAdd: () => void
}): UiChild {
  const online = props.state === null ? 0 : props.state.devices.filter(device => device.status === 'online').length
  const total = props.state === null ? 0 : props.state.devices.length
  return el(
    'header',
    { className: 'dm-header' },
    el('div', { className: 'dm-header-text' },
      el('h1', { className: 'dm-title dm-row' }, DeviceMeshGlyph({ size: 20 }), props.t('panel.title')),
      el('p', { className: 'dm-subtitle' }, props.t('panel.subtitle')),
      props.state === null ? null : el('div', { className: 'dm-row' },
        el('span', { className: 'dm-pill' }, `${props.t('devices.online')} ${online}/${total}`),
        props.state.pendingPairings.length === 0 ? null : el('span', { className: 'dm-pill dm-pill-count' }, props.t('pending.count', { count: props.state.pendingPairings.length })))),
    el('div', { className: 'dm-header-actions' },
      Button({
        onClick: props.onRefresh,
        busy: props.loading,
        ariaLabel: props.t('common.refresh'),
        children: [RefreshGlyph({ size: 14 }), el('span', { key: 'label' }, props.t('common.refresh'))],
      }),
      Button({ variant: 'primary', onClick: props.onAdd, children: props.t('devices.add') })),
  )
}

/** Show the stored relay URL as just the host[:port] the user typed. */
function relayHostDisplay(endpoint: string | null): string {
  if (endpoint === null) return ''
  try {
    return new URL(endpoint).host
  } catch {
    return endpoint
  }
}

/** Context card shown when a remote host is selected in the sidebar. */
function SelectedHostCard(props: {
  readonly t: Translate
  readonly device: MeshDeviceView
  readonly busyKey: string | null
  readonly controlling: boolean
  readonly onOpen: () => void
  readonly onRefresh: () => void
  readonly onConnect: () => void
}): UiChild {
  const t = props.t
  const device = props.device
  return el('section',
    { className: 'dm-card dm-selected-host', 'aria-label': t('panel.selectedHost') },
    el('div', { className: 'dm-card-head' },
      el('h2', { className: 'dm-section-title dm-row' },
        DeviceMeshGlyph({ size: 16 }),
        el('span', { className: 'dm-truncate' }, device.name)),
      el('div', { className: 'dm-row' },
        StatusLine({ status: device.status, label: t(`status.${device.status}`) }),
        el('span', { className: 'dm-pill dm-pill-remote' }, t('devices.remoteBadge')),
        props.controlling ? el('span', { className: 'dm-pill' }, t('panel.controlActive')) : null)),
    el('p', { className: 'dm-card-sub' }, t('panel.selectedHostHint')),
    el('div', { className: 'dm-device-actions' },
      Button({
        variant: 'primary',
        disabled: device.status !== 'online' || device.revoked,
        onClick: props.onOpen,
        children: [ExternalGlyph({ size: 14 }), el('span', { key: 'label' }, t('panel.openRemote'))],
      }),
      Button({
        small: true,
        busy: props.busyKey === `${device.deviceId}:workspaces`,
        disabled: device.status !== 'online',
        onClick: props.onRefresh,
        children: t('panel.refreshWorkspaces'),
      }),
      device.status === 'online' ? null : Button({
        small: true,
        busy: props.busyKey === `${device.deviceId}:connect`,
        disabled: device.revoked,
        onClick: props.onConnect,
        children: t('devices.connect'),
      })))
}

/** "This device" card: identity, direct listener and relay switch configuration. */
function SelfCard(props: {
  readonly t: Translate
  readonly state: MeshHostState
  readonly busy: boolean
  readonly onToggleDirect: (enabled: boolean) => void
  readonly onSaveRelay: (endpoint: string, enabled: boolean, useTls: boolean) => void
}): UiChild {
  const t = props.t
  const { self, direct, relay } = props.state
  // The field accepts an IP/domain (optionally host:port); the Host normalizes
  // it to wss://<host>/ws, so editing shows the bare host instead of a URL.
  const [relayEndpoint, setRelayEndpoint] = useState(relayHostDisplay(relay.endpoint))
  // A legacy/imported endpoint may already carry an explicit secure scheme even
  // when the stored `useTls` flag is false; show the effective choice.
  const [relayUseTls, setRelayUseTls] = useState(() => relayTlsForInput(relay.endpoint ?? '', relay.useTls))
  const [relayServe, setRelayServe] = useState(relay.configured)
  useEffect(() => {
    setRelayEndpoint(relayHostDisplay(relay.endpoint))
    setRelayUseTls(relay.useTls)
    setRelayServe(relay.configured)
  }, [relay.endpoint, relay.useTls, relay.configured])
  const trimmed = relayEndpoint.trim()
  const directBlock = el('div', { className: 'dm-field' },
    el('span', { className: 'dm-label' }, t('self.direct')),
    el('div', { className: 'dm-row' },
      StatusLine({
        status: direct.enabled ? 'online' : 'offline',
        label: direct.enabled ? t('self.directOn', { port: direct.port }) : t('self.directOff'),
      }),
      Switch({
        label: direct.enabled ? t('self.directDisable') : t('self.directEnable'),
        checked: direct.enabled,
        disabled: props.busy,
        onChange: (next) => { props.onToggleDirect(next) },
      })),
    el('span', { className: 'dm-muted' }, t('self.directUrls')),
    direct.urls.length === 0
      ? el('span', { className: 'dm-muted' }, t('self.directNoUrls'))
      : el('ul', { className: 'dm-url-list' },
        ...direct.urls.map(url => el('li', { key: url, className: 'dm-mono' }, url))))

  const relayStatus = relay.connected ? t('self.relayOn') : relay.configured ? t('self.relayOff') : t('self.relayNotConfigured')
  const relayBlock = el('div', { className: 'dm-field' },
    el('span', { className: 'dm-label' }, t('self.relay')),
    el('div', { className: 'dm-row' },
      StatusLine({
        status: relay.connected ? 'online' : relay.configured ? 'connecting' : 'offline',
        label: relayStatus,
      }),
      relay.configured && !relay.connected
        ? el('span', { className: 'dm-muted' }, t('self.relayNotConnectedHint'))
        : null),
    relay.endpoint === null ? null : el('span', { className: 'dm-mono dm-muted' }, relay.endpoint),
    el('label', { className: 'dm-field' },
      el('span', { className: 'dm-muted' }, t('self.relayEndpoint')),
      el('input', {
        className: 'dm-input',
        type: 'text',
        value: relayEndpoint,
        placeholder: t('self.relayPlaceholder'),
        spellcheck: 'false',
        autocomplete: 'off',
        disabled: props.busy,
        onInput: (event: { target: { value: string } }) => { setRelayEndpoint(event.target.value) },
      }),
      el('span', { className: 'dm-muted' }, t('self.relayHint')),
      Switch({
        label: t('self.relayTls'),
        checked: relayUseTls,
        disabled: props.busy,
        onChange: (next) => { setRelayUseTls(next) },
      }),
      Switch({
        label: t('self.relayServe'),
        checked: relayServe,
        disabled: props.busy,
        onChange: (next) => { setRelayServe(next) },
      }),
      el('span', { className: 'dm-muted' }, t('self.relayServeHint')),
      relayUseTls
        ? null
        : el('span', { className: 'dm-banner dm-banner-warn', role: 'status' },
          el('div', { className: 'dm-banner-text' }, t('self.relayInsecure')))),
    el('div', { className: 'dm-row' },
      Button({
        variant: 'primary',
        disabled: props.busy || trimmed.length === 0,
        busy: props.busy,
        onClick: () => {
          // Pass the user's text through untouched: the Host normalizes a bare
          // host, `//host`, `ws(s)://`, and `http(s)://` (mapping HTTP(S) to
          // WS(S)) and applies the TLS choice. Stripping schemes here mangled a
          // pasted `https://relay.example.com/ws` into `wss://https:`.
          // `relayServe` is separate: a controller only needs the endpoint for
          // outbound sessions, while enabling it also lets others control this
          // device through the relay (and starts the local relay daemon).
          const effectiveTls = relayTlsForInput(trimmed, relayUseTls)
          if (effectiveTls !== relayUseTls) setRelayUseTls(effectiveTls)
          props.onSaveRelay(trimmed, relayServe, effectiveTls)
        },
        children: t('self.relaySave'),
      }),
      relay.configured
        ? Button({
          variant: 'ghost',
          disabled: props.busy,
          onClick: () => { props.onSaveRelay(relay.endpoint ?? trimmed, false, relayTlsForInput(relay.endpoint ?? trimmed, relayUseTls)) },
          children: t('self.relayDisable'),
        })
        : null))

  return el('section',
    { className: 'dm-card', 'aria-label': t('self.title') },
    el(CardHead, {
      title: t('self.title'),
      children: el('span', { className: 'dm-pill dm-mono', title: t('self.deviceId') }, self.deviceId),
    }),
    el('div', { className: 'dm-grid' },
      KeyValue({ label: t('self.name'), children: self.name }),
      KeyValue({ label: t('self.platform'), children: platformLabel(self.platform, t) }),
      KeyValue({ label: t('self.version'), children: self.appVersion.length === 0 ? t('common.unknown') : self.appVersion })),
    el('div', { className: 'dm-grid' }, directBlock, relayBlock))
}

/** Pairing-as-daemon card with the locally generated QR code. */
function PairingCard(props: {
  readonly t: Translate
  readonly ticket: PairingTicket | null
  readonly loading: boolean
  readonly error: string | null
  readonly onRefresh: () => void
}): UiChild {
  const t = props.t
  const now = useNow(1000)
  const deadline = props.ticket === null ? Number.NaN : Date.parse(props.ticket.expiresAt)
  const expired = Number.isFinite(deadline) && deadline <= now

  const plate = props.loading
    ? el('span', { className: 'dm-qr-placeholder' }, Spinner(), el('span', null, t('pairing.loading')))
    : props.ticket === null || expired
      ? el('span', { className: 'dm-qr-placeholder' }, t('pairing.expired'))
      : el(QrPlate, {
        link: props.ticket.link,
        alt: t('pairing.qrAlt'),
        ...(props.ticket.qrSvg === undefined ? {} : { fallbackSvg: props.ticket.qrSvg }),
      })

  const expiryLine = props.ticket === null
    ? null
    : el('span', { className: expired ? 'dm-countdown dm-countdown-expired' : 'dm-countdown' },
      expired
        ? t('pairing.expired')
        : Number.isFinite(deadline)
          ? t('pairing.expiresIn', { time: formatCountdown(deadline, now) })
          : t('time.unknown'))

  const linkLine = props.ticket === null
    ? Button({ variant: 'primary', onClick: props.onRefresh, busy: props.loading, children: t('pairing.generate') })
    : el('div', { className: 'dm-link-box' },
      el('code', { className: 'dm-link-text', title: t('pairing.linkLabel') }, props.ticket.link),
      el(CopyButton, { text: props.ticket.link, t, label: t('pairing.copyLink'), small: true }))

  return el('section',
    { className: 'dm-card', 'aria-label': t('pairing.title') },
    el(CardHead, {
      title: t('pairing.title'),
      children: Button({
        small: true,
        onClick: props.onRefresh,
        busy: props.loading,
        children: [RefreshGlyph({ size: 14 }), el('span', { key: 'label' }, t('pairing.refresh'))],
      }),
    }),
    props.error === null ? null : ErrorBanner({ t, message: props.error }),
    el('div', { className: 'dm-qr-layout' },
      el('div', { className: 'dm-qr-plate' }, plate),
      el('div', { className: 'dm-qr-side' },
        el('p', { className: 'dm-card-sub' }, t('pairing.desc')),
        expiryLine,
        expired ? el('span', { className: 'dm-muted' }, t('pairing.expiredHint')) : null,
        linkLine)))
}

/**
 * Render the Host's `statusDetail` for a device in the right tone:
 * `connecting` is the pairing/approval lifecycle (informational), `error` is a
 * readable failure banner rather than a thrown exception.
 */
function statusDetailLine(device: MeshDeviceView, t: Translate): UiChild {
  const detail = describeStatusDetail(device.statusDetail, t)
  if (device.status === 'connecting') {
    return el('div', { className: 'dm-banner dm-banner-warn', role: 'status' },
      el('div', { className: 'dm-banner-text dm-row' }, Spinner(), el('span', null, detail ?? t('devices.connecting'))))
  }
  if (detail === null) return null
  if (device.status === 'error') {
    return el('div', { className: 'dm-banner dm-banner-error', role: 'status' },
      el('div', { className: 'dm-banner-text' }, detail))
  }
  return el('span', { className: 'dm-muted' }, detail)
}

interface DeviceActions {
  readonly onConnect: (device: MeshDeviceView) => void
  readonly onDisconnect: (device: MeshDeviceView) => void
  readonly onOpenRemote: (device: MeshDeviceView) => void
  readonly onOpenRemoteTab: ((device: MeshDeviceView) => void) | undefined
  readonly onClosePortal: (device: MeshDeviceView) => void
  readonly onRevoke: (device: MeshDeviceView) => void
  readonly onForget: (device: MeshDeviceView) => void
}

/** One paired-device card. */
function DeviceCard(props: {
  readonly t: Translate
  readonly device: MeshDeviceView
  readonly busyKey: string | null
  readonly portalUrl: string | undefined
  readonly actions: DeviceActions
}): UiChild {
  const t = props.t
  const device = props.device
  const key = device.deviceId
  const busy = (suffix: string): boolean => props.busyKey === `${key}:${suffix}`
  const anyBusy = props.busyKey !== null && props.busyKey.startsWith(`${key}:`)
  const openDisabled = anyBusy || busy('portal')
  const connectionButton = (): UiChild => {
    if (device.status === 'online') {
      return Button({
        busy: busy('disconnect'),
        disabled: anyBusy,
        onClick: () => { props.actions.onDisconnect(device) },
        children: t('devices.disconnect'),
      })
    }
    if (device.status === 'connecting') {
      return Button({ busy: true, disabled: true, children: t('devices.connecting') })
    }
    return Button({
      variant: 'primary',
      busy: busy('connect'),
      disabled: anyBusy || device.status === 'revoked',
      onClick: () => { props.actions.onConnect(device) },
      children: t('devices.connect'),
    })
  }
  return el(
    'article',
    { className: 'dm-device', 'aria-label': device.name },
    el('div', { className: 'dm-device-head' },
      el('div', { className: 'dm-device-name' },
        DeviceMeshGlyph({ size: 16 }),
        el('span', { className: 'dm-truncate' }, device.name),
        el('span', { className: 'dm-pill dm-pill-remote' }, t('devices.remoteBadge'))),
      StatusLine({ status: device.status, label: t(`status.${device.status}`) })),
    el('div', { className: 'dm-device-meta' },
      el('span', null, platformLabel(device.platform, t)),
      el('span', null, `${t('devices.scope')}: ${scopeLabel(device.scope, t)}`),
      el('span', null, `${t('devices.lastSeen')}: ${formatRelativeTime(device.lastSeenAt, t)}`),
      el('span', { className: 'dm-mono', title: device.deviceId }, device.deviceId)),
    statusDetailLine(device, t),
    el('div', { className: 'dm-device-actions' },
      connectionButton(),
      Button({
        variant: 'primary',
        busy: busy('portal') || busy('tab'),
        disabled: openDisabled || device.revoked,
        onClick: () => { props.actions.onOpenRemote(device) },
        children: [ExternalGlyph({ size: 14 }), el('span', { key: 'label' }, t('devices.openRemote'))],
      }),
      props.actions.onOpenRemoteTab === undefined
        ? null
        : Button({
          small: true,
          busy: busy('tab'),
          disabled: anyBusy || device.revoked,
          onClick: () => { (props.actions.onOpenRemoteTab as (d: MeshDeviceView) => void)(device) },
          children: t('devices.openInTab'),
        }),
      Button({
        variant: 'danger',
        small: true,
        disabled: anyBusy || device.revoked,
        onClick: () => { props.actions.onRevoke(device) },
        children: t('devices.revoke'),
      }),
      Button({
        variant: 'ghost',
        small: true,
        disabled: anyBusy,
        onClick: () => { props.actions.onForget(device) },
        children: t('devices.forget'),
      })),
    props.portalUrl === undefined
      ? null
      : el('div', { className: 'dm-portal-box' },
        el('span', { className: 'dm-muted' }, t('devices.portalReady')),
        el('div', { className: 'dm-link-box' },
          el('code', { className: 'dm-link-text' }, props.portalUrl),
          el(CopyButton, { text: props.portalUrl, t, small: true }),
          Button({
            variant: 'ghost',
            small: true,
            onClick: () => { props.actions.onClosePortal(device) },
            children: t('devices.closePortal'),
          }))),
  )
}

/** The Devices main panel. */
export function DevicesPanel(props: DevicesPanelProps): UiChild {
  const t = translateOf(props)
  const snapshot = useMeshSnapshot()
  const state = snapshot.state
  const { notice, setNotice } = useTransientNotice()
  const [error, setError] = useState<string | null>(null)
  const [busyKey, setBusyKey] = useState<string | null>(null)
  const [ticket, setTicket] = useState<PairingTicket | null>(null)
  const [ticketLoading, setTicketLoading] = useState(false)
  const [ticketError, setTicketError] = useState<string | null>(null)
  const [addOpen, setAddOpen] = useState(false)
  const [portalUrls, setPortalUrls] = useState<Readonly<Record<string, string>>>({})
  const selectedHost = useSelectedHost()
  const addHostRequests = useAddHostRequests()
  useEffect(() => {
    if (consumeAddHostRequest()) setAddOpen(true)
  }, [addHostRequests])
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  const loadTicket = (): void => {
    setTicketLoading(true)
    setTicketError(null)
    void meshApi.ticket()
      .then((value) => { if (mounted.current) setTicket(value) })
      .catch((cause: unknown) => { if (mounted.current) setTicketError(describeError(cause, t)) })
      .finally(() => { if (mounted.current) setTicketLoading(false) })
  }

  // A ticket is cheap and expires quickly: fetch one whenever the panel opens.
  useEffect(() => {
    loadTicket()
  }, [])


  const runAction = (key: string, action: () => Promise<void>, success?: string): void => {
    setBusyKey(key)
    setError(null)
    void action()
      .then(() => { if (success !== undefined) setNotice(success) })
      .catch((cause: unknown) => { setError(describeError(cause, t)) })
      .finally(() => { setBusyKey(null) })
  }

  const savePortalUrl = (deviceId: string, url: string): void => {
    setPortalUrls(previous => ({ ...previous, [deviceId]: url }))
  }

  const openRemote = (device: MeshDeviceView): void => {
    const key = `${device.deviceId}:portal`
    setBusyKey(key)
    setError(null)
    // Pre-open inside the click gesture; post-RPC window.open stays blank.
    const pending = openBlankPortalWindow()
    void meshApi.openPortal(device.deviceId)
      .then(async (url) => {
        savePortalUrl(device.deviceId, url)
        if (props.openRemotePane?.(device.deviceId, device.name, url) === true) return
        let opened = props.openRemoteTab === undefined ? false : await props.openRemoteTab(url)
        if (opened) {
          try { pending?.close() } catch { /* already gone */ }
        } else {
          opened = await meshApi.openPortalExternally(url).catch(() => false)
          if (opened) {
            try { pending?.close() } catch { /* already gone */ }
          }
        }
        if (!opened && pending !== null) opened = navigatePortalWindow(pending, url)
        if (!opened) opened = openExternalBrowser(url)
        if (!opened) opened = openPortalWindow(url)
        if (!opened) {
          try { pending?.close() } catch { /* already gone */ }
          setError(t('devices.portalBlocked'))
        }
      })
      .catch((cause: unknown) => {
        try { pending?.close() } catch { /* already gone */ }
        setError(t('devices.portalFailed', { message: messageOf(cause) }))
      })
      .finally(() => { setBusyKey(null) })
  }

  const openRemoteInTab = (device: MeshDeviceView): void => {
    const key = `${device.deviceId}:tab`
    setBusyKey(key)
    setError(null)
    void meshApi.openPortal(device.deviceId)
      .then(async (url) => {
        savePortalUrl(device.deviceId, url)
        const opened = props.openRemoteTab === undefined ? false : await props.openRemoteTab(url)
        if (!opened) setError(t('devices.portalBlocked'))
      })
      .catch((cause: unknown) => { setError(t('devices.portalFailed', { message: messageOf(cause) })) })
      .finally(() => { setBusyKey(null) })
  }

  const actions: DeviceActions = {
    onConnect: (device) => {
      runAction(`${device.deviceId}:connect`, async () => { await meshApi.connectDevice(device.deviceId) },
        t('devices.connectedNotice', { name: device.name }))
    },
    onDisconnect: (device) => {
      runAction(`${device.deviceId}:disconnect`, async () => { await meshApi.disconnectDevice(device.deviceId) })
    },
    onOpenRemote: openRemote,
    onOpenRemoteTab: props.openRemoteTab === undefined ? undefined : openRemoteInTab,
    onClosePortal: (device) => {
      runAction(`${device.deviceId}:portal`, async () => {
        await meshApi.closePortal(device.deviceId)
        setPortalUrls(previous => Object.fromEntries(
          Object.entries(previous).filter(([deviceId]) => deviceId !== device.deviceId),
        ))
      })
    },
    onRevoke: (device) => {
      if (!confirmAction(t('devices.confirmRevoke'))) return
      runAction(`${device.deviceId}:revoke`, async () => { await meshApi.revokeDevice(device.deviceId) },
        t('devices.revokedNotice', { name: device.name }))
    },
    onForget: (device) => {
      if (!confirmAction(t('devices.confirmForget'))) return
      runAction(`${device.deviceId}:forget`, async () => { await meshApi.forgetDevice(device.deviceId) },
        t('devices.removed', { name: device.name }))
    },
  }

  if (state === null) {
    return el('div', { className: 'dm-root' },
      el('header', { className: 'dm-header' },
        el('div', { className: 'dm-header-text' },
          el('h1', { className: 'dm-title dm-row' }, DeviceMeshGlyph({ size: 20 }), t('panel.title')),
          el('p', { className: 'dm-subtitle' }, t('panel.subtitle')))),
      snapshot.error === null
        ? el('div', { className: 'dm-card' }, el('div', { className: 'dm-row' }, Spinner(), t('common.loading')))
        : el('div', { className: 'dm-card' },
          el('h2', { className: 'dm-section-title' }, t('error.title')),
          el('p', { className: 'dm-card-sub' }, describeError(snapshot.error, t)),
          el('div', { className: 'dm-row' },
            Button({ variant: 'primary', onClick: () => { void refreshMeshState() }, children: t('common.retry') }))))
  }

  const devices = state.devices
  const selectedDevice = selectedHost === 'local'
    ? undefined
    : devices.find(device => device.deviceId === selectedHost)
  return el('div', { className: 'dm-root' },
    el(PanelHeader, {
      t,
      state,
      loading: snapshot.loading,
      onRefresh: () => { void refreshMeshState() },
      onAdd: () => { setAddOpen(true) },
    }),
    error === null ? null : ErrorBanner({ t, message: error, onDismiss: () => { setError(null) } }),
    snapshot.error === null ? null : el('div', { className: 'dm-banner dm-banner-warn', role: 'status' },
      el('div', { className: 'dm-banner-text' }, describeError(snapshot.error, t)),
      Button({ variant: 'ghost', small: true, onClick: () => { void refreshMeshState() }, children: t('common.retry') })),
    notice === null ? null : NoticeBanner({ message: notice }),
    el(PendingPairingsCard, { t, requests: state.pendingPairings }),
    selectedDevice === undefined ? null : el(SelectedHostCard, {
      t,
      device: selectedDevice,
      busyKey,
      controlling: state.portals.some(portal => portal.deviceId === selectedDevice.deviceId),
      onOpen: () => { openRemote(selectedDevice) },
      onRefresh: () => {
        runAction(`${selectedDevice.deviceId}:workspaces`, async () => {
          const result = await meshApi.refreshWorkspaces(selectedDevice.deviceId)
          if (result.truncated === true) setNotice(t('remote.truncated'))
        })
      },
      onConnect: () => {
        runAction(`${selectedDevice.deviceId}:connect`, async () => {
          await meshApi.connectDevice(selectedDevice.deviceId)
        }, t('devices.connectedNotice', { name: selectedDevice.name }))
      },
    }),
    el(SelfCard, {
      t,
      state,
      busy: busyKey === 'self',
      onToggleDirect: (enabled: boolean) => {
        runAction('self', async () => { await meshApi.configureDirect(enabled) })
      },
      onSaveRelay: (endpoint: string, enabled: boolean, useTls: boolean) => {
        runAction('self', async () => { await meshApi.configureRelay(endpoint, enabled, useTls) })
      },
    }),
    el(PairingCard, { t, ticket, loading: ticketLoading, error: ticketError, onRefresh: loadTicket }),
    el('section', { className: 'dm-card', 'aria-label': t('devices.title') },
      el(CardHead, {
        title: t('devices.title'),
        children: el('span', { className: 'dm-pill' }, `${devices.length}`),
      }),
      devices.length === 0
        ? el('div', { className: 'dm-empty' },
          el('span', { className: 'dm-empty-title' }, t('devices.empty')),
          el('span', { className: 'dm-muted' }, t('devices.emptyHint')),
          Button({ variant: 'primary', onClick: () => { setAddOpen(true) }, children: t('devices.add') }))
        : el('div', { className: 'dm-device-list' }, ...devices.map(device => el(DeviceCard, {
          key: device.deviceId,
          t,
          device,
          busyKey,
          portalUrl: portalUrls[device.deviceId],
          actions,
        })))),
    addOpen
      ? el(AddDeviceDialog, {
        t,
        onClose: () => { setAddOpen(false) },
        onPaired: (device: MeshDeviceView) => {
          setAddOpen(false)
          setNotice(t('pairing.approved', { name: device.name }))
          // Switch the host view to the new device and load its workspaces
          // immediately; the switcher then reflects what the user is looking at.
          setSelectedHost(device.deviceId)
          void meshApi.refreshWorkspaces(device.deviceId).catch(() => undefined)
        },
      })
      : null,
  )
}
