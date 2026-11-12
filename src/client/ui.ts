/**
 * Small view helpers shared by the device panel, pairing dialog and sidebar
 * entry points. Components are written with `createElement` rather than JSX:
 * the repository tsconfig intentionally leaves the `jsx` option to esbuild, and
 * this keeps `tsc --noEmit` able to check the plugin's own logic.
 */
import { createElement, useEffect, useRef, useState } from 'react'
import type { MeshDeviceView, PairingScope } from '../shared/protocol.js'
import type { Translate } from './types.js'
import { MeshApiError } from './api.js'

/** One rendered child (React node). */
export type UiChild = unknown

/** `createElement` with the loose typing this UI needs. */
export function el(
  // `any` here is the component-boundary escape hatch of this UI layer: local
  // components declare precise prop interfaces while `createElement`'s runtime
  // contract only needs the object.
  // oxlint-disable-next-line typescript/no-explicit-any -- deliberate component-boundary escape hatch
  type: string | ((props: any) => UiChild),
  props?: Record<string, unknown> | null,
  ...children: UiChild[]
): UiChild {
  return createElement(type, props ?? null, ...children)
}

/** Join truthy class names. */
export function cx(...values: readonly (string | false | null | undefined)[]): string {
  return values.filter((value): value is string => typeof value === 'string' && value.length > 0).join(' ')
}

/** Translate a key against a component's locale seat, falling back to the key. */
export function translateOf(props: { readonly t?: Translate }): Translate {
  return props.t ?? ((key: string) => key)
}

/** Inline vector icon: no icon library dependency, colour follows `currentColor`. */
export function Glyph(options: {
  readonly size?: number
  readonly viewBox?: string
  readonly children: UiChild
  readonly className?: string | undefined
}): UiChild {
  const size = options.size ?? 16
  return el(
    'svg',
    {
      width: size,
      height: size,
      viewBox: options.viewBox ?? '0 0 16 16',
      fill: 'none',
      'aria-hidden': 'true',
      focusable: 'false',
      className: options.className,
    },
    options.children,
  )
}

/** Two linked device outlines: the plugin's identity glyph. */
export function DeviceMeshGlyph(props: { readonly size?: number; readonly className?: string }): UiChild {
  return Glyph({
    size: props.size ?? 16,
    className: props.className,
    children: [
      el('rect', { key: 'a', x: '1', y: '3', width: '6', height: '5', rx: '1.2', stroke: 'currentColor', strokeWidth: '1.2' }),
      el('rect', { key: 'b', x: '9', y: '8', width: '6', height: '5', rx: '1.2', stroke: 'currentColor', strokeWidth: '1.2' }),
      el('path', { key: 'c', d: 'M7 5.5h2.5M6.5 10.5H9', stroke: 'currentColor', strokeWidth: '1.2', strokeLinecap: 'round' }),
    ],
  })
}

/** Copy glyph. */
export function CopyGlyph(props: { readonly size?: number }): UiChild {
  return Glyph({
    size: props.size ?? 14,
    children: [
      el('rect', { key: 'a', x: '5.5', y: '5.5', width: '8', height: '8', rx: '1.5', stroke: 'currentColor', strokeWidth: '1.2' }),
      el('path', { key: 'b', d: 'M10.5 3.5h-7a1 1 0 0 0-1 1v7', stroke: 'currentColor', strokeWidth: '1.2', strokeLinecap: 'round' }),
    ],
  })
}

/** Refresh glyph. */
export function RefreshGlyph(props: { readonly size?: number }): UiChild {
  return Glyph({
    size: props.size ?? 14,
    children: [
      el('path', {
        key: 'a',
        d: 'M13 8a5 5 0 1 1-1.7-3.8M13 2.5V6h-3.5',
        stroke: 'currentColor',
        strokeWidth: '1.2',
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
      }),
    ],
  })
}

/** Close glyph. */
export function CloseGlyph(props: { readonly size?: number }): UiChild {
  return Glyph({
    size: props.size ?? 14,
    children: [
      el('path', { key: 'a', d: 'M4 4l8 8M12 4l-8 8', stroke: 'currentColor', strokeWidth: '1.4', strokeLinecap: 'round' }),
    ],
  })
}

/** Camera / scan glyph. */
export function ScanGlyph(props: { readonly size?: number }): UiChild {
  return Glyph({
    size: props.size ?? 14,
    children: [
      el('path', {
        key: 'a',
        d: 'M2 5V3.5A1.5 1.5 0 0 1 3.5 2H5M11 2h1.5A1.5 1.5 0 0 1 14 3.5V5M14 11v1.5a1.5 1.5 0 0 1-1.5 1.5H11M5 14H3.5A1.5 1.5 0 0 1 2 12.5V11M5 8h6',
        stroke: 'currentColor',
        strokeWidth: '1.2',
        strokeLinecap: 'round',
      }),
    ],
  })
}

/** External-link glyph. */
export function ExternalGlyph(props: { readonly size?: number }): UiChild {
  return Glyph({
    size: props.size ?? 14,
    children: [
      el('path', {
        key: 'a',
        d: 'M9 3h4v4M13 3 7.5 8.5M11.5 9.5V12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5.5a1 1 0 0 1 1-1h2.5',
        stroke: 'currentColor',
        strokeWidth: '1.2',
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
      }),
    ],
  })
}

/** Spinner shown inside pending buttons. */
export function Spinner(): UiChild {
  return el('span', { className: 'dm-spinner', 'aria-hidden': 'true' })
}

/** Button variants used by this plugin. */
export interface ButtonOptions {
  readonly children: UiChild
  readonly onClick?: () => void
  readonly disabled?: boolean
  readonly busy?: boolean
  readonly title?: string
  readonly ariaLabel?: string
  readonly variant?: 'default' | 'primary' | 'danger' | 'ghost'
  readonly small?: boolean
  readonly type?: 'button' | 'submit'
}

/** Themed button with a guaranteed ≥40px touch target. */
export function Button(options: ButtonOptions): UiChild {
  const variant = options.variant ?? 'default'
  return el(
    'button',
    {
      type: options.type ?? 'button',
      className: cx(
        'dm-btn',
        variant === 'primary' && 'dm-btn-primary',
        variant === 'danger' && 'dm-btn-danger',
        variant === 'ghost' && 'dm-btn-ghost',
        options.small === true && 'dm-btn-sm',
      ),
      disabled: options.disabled === true || options.busy === true,
      title: options.title,
      'aria-label': options.ariaLabel,
      'aria-busy': options.busy === true ? 'true' : undefined,
      onClick: options.onClick,
      key: undefined,
    },
    options.busy === true ? Spinner() : null,
    options.children,
  )
}

/** Icon-only button (always 40×40). */
export function IconButton(options: {
  readonly children: UiChild
  readonly label: string
  readonly onClick?: () => void
  readonly disabled?: boolean
}): UiChild {
  return el(
    'button',
    {
      type: 'button',
      className: 'dm-icon-btn',
      'aria-label': options.label,
      title: options.label,
      disabled: options.disabled === true,
      onClick: options.onClick,
    },
    options.children,
  )
}

/** Key/value pair used in the "this device" grid. */
export function KeyValue(props: { readonly label: string; readonly children: UiChild }): UiChild {
  return el('dl', { className: 'dm-kv' }, el('dt', null, props.label), el('dd', null, props.children))
}

/** Status dot + localized status label. */
export function StatusLine(props: { readonly status: MeshDeviceView['status']; readonly label: string }): UiChild {
  return el(
    'span',
    { className: 'dm-status', 'data-status': props.status },
    el('span', { className: 'dm-dot', 'aria-hidden': 'true' }),
    props.label,
  )
}

/** Live "now" clock for countdowns; ticks once per second while mounted. */
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => { setNow(Date.now()) }, intervalMs)
    return () => { clearInterval(timer) }
  }, [intervalMs])
  return now
}

/** Localized platform name. */
export function platformLabel(platform: string, t: Translate): string {
  const key = `platform.${platform}`
  const known = ['darwin', 'linux', 'win32', 'android', 'ios', 'web']
  return known.includes(platform) ? t(key) : t('platform.unknown')
}

/** Localized scope summary. */
export function scopeLabel(scope: PairingScope | undefined, t: Translate): string {
  if (scope === undefined) return t('common.unknown')
  const kind = scope.kind === 'control' ? t('scope.control') : t('scope.view')
  const workspaces = scope.workspaces === 'all'
    ? t('scope.all')
    : t('scope.limited', { count: scope.workspaces.length })
  return `${kind} · ${workspaces}`
}

/** Human relative time with localized units. */
export function formatRelativeTime(iso: string | null | undefined, t: Translate, now = Date.now()): string {
  if (iso === null || iso === undefined) return t('common.never')
  const then = Date.parse(iso)
  if (Number.isNaN(then)) return t('time.unknown')
  const diff = Math.max(0, now - then)
  const seconds = Math.floor(diff / 1000)
  if (seconds < 10) return t('time.justNow')
  if (seconds < 60) return t('time.secondsAgo', { count: seconds })
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return t('time.minutesAgo', { count: minutes })
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return t('time.hoursAgo', { count: hours })
  const days = Math.floor(hours / 24)
  return t('time.daysAgo', { count: days })
}

/** mm:ss countdown, clamped at zero. */
export function formatCountdown(deadlineMs: number, now: number): string {
  const remaining = Math.max(0, deadlineMs - now)
  const totalSeconds = Math.ceil(remaining / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
}

/** Format a six-digit SAS as `123-456` (already-formatted input passes through). */
export function formatSas(sas: string): string {
  const digits = sas.replace(/\D/gu, '')
  if (digits.length === 6) return `${digits.slice(0, 3)}-${digits.slice(3)}`
  return sas
}

/** Translate an API failure into a readable, localized line. */
export function describeError(error: unknown, t: Translate): string {
  if (error instanceof MeshApiError) {
    if (error.code === 'client/network') return t('error.network')
    return t('error.actionFailed', { message: error.message })
  }
  if (error instanceof Error) return t('error.actionFailed', { message: error.message })
  return t('error.actionFailed', { message: String(error) })
}

/**
 * Turn a host `statusDetail` into a readable, localized line.
 *
 * The Host reports the pairing lifecycle through `status`/`statusDetail`
 * (e.g. `connecting` + "waiting for the controlled device to approve
 * pairing"). Known phrases are localized; unknown detail passes through
 * verbatim so information is never lost.
 */
export function describeStatusDetail(detail: string | undefined, t: Translate): string | null {
  if (detail === undefined || detail.length === 0) return null
  // The Host guarantees these prefixes (see the statusDetail contract); match
  // on the prefix and keep everything else verbatim so dynamic lower-level
  // messages are still readable.
  const lower = detail.toLowerCase()
  const pairingFailed = 'pairing failed: '
  if (lower.startsWith(pairingFailed)) {
    return t('devices.detail.pairingConnectionFailed', { detail: detail.slice(pairingFailed.length) })
  }
  if (lower.startsWith('waiting for the controlled device to approve pairing')) return t('devices.waitingApproval')
  if (lower.startsWith('no endpoint was reachable')) return t('devices.detail.deviceUnreachable')
  if (lower.startsWith('pairing was denied on the controlled device')) return t('pairing.denied')
  if (lower.startsWith('pairing approval timed out')) return t('pairing.timeout')
  if (lower.startsWith('pairing was approved but the session did not become authorized')) {
    return t('devices.detail.approvedNotAuthorized')
  }
  if (lower.startsWith('no cached endpoint')) return t('devices.detail.noCachedEndpoint')
  if (lower.startsWith('session layer is unavailable')) return t('devices.detail.sessionUnavailable')
  return detail
}

/** Clipboard write with a legacy fallback; never throws. */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard !== undefined) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // fall through to the legacy path
  }
  try {
    if (typeof document === 'undefined') return false
    const area = document.createElement('textarea')
    area.value = text
    area.setAttribute('readonly', '')
    area.style.position = 'fixed'
    area.style.opacity = '0'
    document.body.appendChild(area)
    area.select()
    // oxlint-disable-next-line typescript/no-deprecated -- clipboard fallback for non-secure LAN contexts
    const ok = document.execCommand('copy')
    area.remove()
    return ok
  } catch {
    return false
  }
}

/** Copy-to-clipboard button owning its transient "copied" state. */
export function CopyButton(props: {
  readonly text: string
  readonly t: Translate
  readonly label?: string
  readonly small?: boolean
}): UiChild {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle')
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => {
    if (timer.current !== null) clearTimeout(timer.current)
  }, [])
  const onCopy = (): void => {
    void copyText(props.text).then((ok) => {
      setState(ok ? 'copied' : 'failed')
      if (timer.current !== null) clearTimeout(timer.current)
      timer.current = setTimeout(() => { setState('idle') }, 2000)
    })
  }
  const label = state === 'copied' ? props.t('common.copied') : state === 'failed' ? props.t('common.copyFailed') : (props.label ?? props.t('common.copy'))
  return Button({
    onClick: onCopy,
    small: props.small === true,
    ariaLabel: label,
    children: [CopyGlyph({ size: 14 }), el('span', { key: 'label', className: props.small === true ? 'dm-truncate' : undefined }, label)],
  })
}

const PORTAL_WINDOW_NAME = 'dsh-device-mesh-remote-control'

/**
 * Open/reuse the remote-control window synchronously inside the click gesture.
 * Browsers and Electron only allow popups during user activation; calling this
 * after awaiting `portal.open` returns a blank window that cannot navigate.
 */
export function openBlankPortalWindow(): Window | null {
  try {
    if (typeof window === 'undefined') return null
    return window.open('', PORTAL_WINDOW_NAME)
  } catch {
    return null
  }
}

/** Navigate a pre-opened portal window with a cleared opener. */
export function navigatePortalWindow(win: Window, url: string): boolean {
  try {
    win.opener = null
    win.location.href = url
    return true
  } catch {
    try {
      win.location.replace(url)
      return true
    } catch {
      return false
    }
  }
}

/**
 * Ask the shell to open the URL externally. DSH Desktop's main-window
 * `setWindowOpenHandler` routes `http:`/`https:` through `shell.openExternal`
 * and denies the in-app window, so a null return value still means the system
 * browser was asked to open it. Plain Web uses this as a popup fallback.
 */
export function openExternalBrowser(url: string): boolean {
  try {
    if (typeof window === 'undefined') return false
    window.open(url, '_blank', 'noopener,noreferrer')
    return true
  } catch {
    return false
  }
}

/** Open or reuse one browser window for remote control. */
export function openPortalWindow(url: string): boolean {
  const opened = openBlankPortalWindow()
  return opened !== null && navigatePortalWindow(opened, url)
}

/** Stable `aria-live` region text for notices. */
export function useTransientNotice(initial: string | null = null): {
  readonly notice: string | null
  readonly setNotice: (value: string | null) => void
} {
  const [notice, setNotice] = useState<string | null>(initial)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => {
    if (timer.current !== null) clearTimeout(timer.current)
  }, [])
  const update = (value: string | null): void => {
    setNotice(value)
    if (timer.current !== null) clearTimeout(timer.current)
    if (value !== null) timer.current = setTimeout(() => { setNotice(null) }, 6000)
  }
  return { notice, setNotice: update }
}
