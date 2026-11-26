/**
 * Pairing surfaces: the "add remote device" dialog (paste link + optional
 * in-page QR scan), the pending-request banner inside the Devices panel, and a
 * frame-wide overlay card so a request is visible even when the panel is
 * closed.
 */
import { useEffect, useRef, useState } from 'react'
import type { PairingRequest, MeshDeviceView } from '../shared/protocol.js'
import type { BarcodeDetectorConstructor, BarcodeDetectorLike, Translate, WindowWithBarcodeDetector } from './types.js'
import { extractPairingLink, meshApi, refreshMeshState, useMeshSnapshot } from './api.js'
import {
  Button, CloseGlyph, IconButton, ScanGlyph, Spinner, describeError, describeStatusDetail, el, formatSas,
  platformLabel, translateOf,
} from './ui.js'
import type { UiChild } from './ui.js'

interface PairingActionState {
  readonly busyId: string | null
  readonly error: string | null
  readonly approve: (requestId: string) => void
  readonly deny: (requestId: string) => void
}

/** Shared approve/deny state for the panel banner and the frame overlay. */
function usePendingActions(t: Translate): PairingActionState {
  const [busyId, setBusyId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const run = (requestId: string, action: (id: string) => Promise<void>): void => {
    setBusyId(requestId)
    setError(null)
    void action(requestId)
      .catch((cause: unknown) => { setError(describeError(cause, t)) })
      .finally(() => { setBusyId(null) })
  }
  return {
    busyId,
    error,
    approve: (requestId) => { run(requestId, id => meshApi.approvePairing(id)) },
    deny: (requestId) => { run(requestId, id => meshApi.denyPairing(id)) },
  }
}

/** In-panel list of incoming pairing requests. */
export function PendingPairingsCard(props: {
  readonly t?: Translate
  readonly requests: readonly PairingRequest[]
}): ReturnType<typeof el> {
  const t = translateOf(props)
  const actions = usePendingActions(t)
  if (props.requests.length === 0) return null
  const items = props.requests.map((request) => {
    const busy = actions.busyId === request.requestId
    return el('div', { key: request.requestId, className: 'dm-pending-item' },
      el('div', { className: 'dm-banner-text' },
        el('span', { className: 'dm-banner-title' }, request.peer.name),
        el('span', { className: 'dm-card-sub' }, t('pending.desc', {
          name: request.peer.name,
          platform: platformLabel(request.peer.platform, t),
        })),
        el('span', { className: 'dm-row' },
          el('span', { className: 'dm-muted' }, t('pending.sas')),
          el('span', { className: 'dm-sas' }, formatSas(request.sas)))),
      el('div', { className: 'dm-banner-actions' },
        Button({
          variant: 'primary',
          busy,
          onClick: () => { actions.approve(request.requestId) },
          children: t('pending.allow'),
        }),
        Button({
          variant: 'ghost',
          disabled: busy,
          onClick: () => { actions.deny(request.requestId) },
          children: t('pending.deny'),
        })))
  })
  return el(
    'section',
    { className: 'dm-card', 'aria-label': t('pending.title') },
    el('div', { className: 'dm-card-head' },
      el('h2', { className: 'dm-card-title' }, t('pending.title')),
      el('span', { className: 'dm-pill dm-pill-count' }, String(props.requests.length))),
    actions.error === null
      ? null
      : el('div', { className: 'dm-banner dm-banner-error', role: 'alert' },
        el('div', { className: 'dm-banner-text' }, actions.error)),
    ...items,
  )
}

/** Frame-wide overlay: visible while the Devices panel is closed. */
export function PendingPairingOverlay(props: {
  readonly t?: Translate
  readonly openDevices?: () => void
}): ReturnType<typeof el> {
  const t = translateOf(props)
  const snapshot = useMeshSnapshot()
  const actions = usePendingActions(t)
  const requests = snapshot.state?.pendingPairings ?? []
  if (requests.length === 0) return null
  const visible = requests.slice(0, 2)
  const hidden = requests.length - visible.length
  const cards = visible.map((request) => {
    const busy = actions.busyId === request.requestId
    return el('div', { key: request.requestId, className: 'dm-overlay-card' },
      el('div', { className: 'dm-overlay-head' },
        el('strong', null, t('pending.title')),
        el('span', { className: 'dm-muted' }, t('pending.count', { count: requests.length }))),
      el('div', { className: 'dm-banner-text' },
        el('span', null, t('pending.desc', {
          name: request.peer.name,
          platform: platformLabel(request.peer.platform, t),
        })),
        el('span', { className: 'dm-row' },
          el('span', { className: 'dm-muted' }, t('pending.sas')),
          el('span', { className: 'dm-sas' }, formatSas(request.sas)))),
      actions.error === null
        ? null
        : el('span', { className: 'dm-muted', role: 'alert' }, actions.error),
      el('div', { className: 'dm-overlay-actions' },
        Button({
          variant: 'primary',
          small: true,
          busy,
          onClick: () => { actions.approve(request.requestId) },
          children: t('pending.allow'),
        }),
        Button({
          variant: 'ghost',
          small: true,
          disabled: busy,
          onClick: () => { actions.deny(request.requestId) },
          children: t('pending.deny'),
        }),
        props.openDevices === undefined
          ? null
          : Button({
            variant: 'ghost',
            small: true,
            onClick: props.openDevices,
            children: t('overlay.open'),
          })))
  })
  const extra = hidden > 0
    ? el('div', { className: 'dm-overlay-card' },
      el('span', { className: 'dm-muted' }, t('pending.more', { count: hidden })))
    : null
  return el(
    'div',
    { className: 'dm-overlay', role: 'status', 'aria-live': 'polite' },
    ...cards,
    extra,
  )
}

/** Feature-detect the Chromium-only `BarcodeDetector` API. */
function barcodeDetector(): BarcodeDetectorConstructor | null {
  if (typeof window === 'undefined') return null
  const ctor = (window as WindowWithBarcodeDetector).BarcodeDetector
  return typeof ctor === 'function' ? ctor : null
}

/**
 * Explicit second confirmation before the controller dials a plaintext relay.
 *
 * Kept hook-free (and exported for the view test) so it can be rendered by
 * calling it directly; {@link AddDeviceDialog} owns the state and the retry.
 */
export function InsecureRelayWarning(props: {
  readonly t: Translate
  readonly name: string
  readonly endpoints: readonly string[]
  readonly onCancel: () => void
  readonly onConfirm: () => void
}): UiChild {
  return el('div',
    {
      className: 'dm-modal-backdrop dm-modal-backdrop-nested',
      onClick: (event: { target: unknown; currentTarget: unknown }) => {
        if (event.target === event.currentTarget) props.onCancel()
      },
    },
    el('div', {
      className: 'dm-modal dm-modal-narrow',
      role: 'dialog',
      'aria-modal': 'true',
      'aria-label': props.t('pairing.insecureTitle'),
      onClick: (event: { target: unknown; currentTarget: unknown; stopPropagation: () => void }) => { event.stopPropagation() },
    },
    el('div', { className: 'dm-modal-head' },
      el('h2', { className: 'dm-modal-title' }, props.t('pairing.insecureTitle'))),
    el('div', { className: 'dm-modal-body' },
      el('p', { className: 'dm-card-sub' }, props.t('pairing.insecureDesc', { name: props.name })),
      el('ul', { className: 'dm-url-list' },
        ...props.endpoints.map(url => el('li', { key: url, className: 'dm-mono' }, url))),
      el('div', { className: 'dm-banner dm-banner-warn', role: 'status' },
        el('div', { className: 'dm-banner-text' }, props.t('pairing.insecureHint')))),
    el('div', { className: 'dm-modal-actions' },
      // Focus the safe choice: a stray Enter must cancel, not authorize a
      // plaintext relay. Proceeding stays an explicit click/Tab.
      Button({ variant: 'ghost', autoFocus: true, onClick: props.onCancel, children: props.t('common.cancel') }),
      Button({
        variant: 'primary',
        onClick: props.onConfirm,
        children: props.t('pairing.insecureContinue'),
      }))))
}

/** "Add remote device" modal: paste a pairing link or scan a QR code. */
export function AddDeviceDialog(props: {
  readonly t?: Translate
  readonly onClose: () => void
  readonly onPaired: (device: MeshDeviceView) => void
}): ReturnType<typeof el> {
  const t = translateOf(props)
  const [text, setText] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [awaitingDevice, setAwaitingDevice] = useState<MeshDeviceView | null>(null)
  const [awaitingReady, setAwaitingReady] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Set when `pair.inspect` reports a plaintext relay on a non-loopback host.
  // Nothing is pinned or dialed until the operator confirms these URLs.
  const [insecure, setInsecure] = useState<{
    readonly link: string
    readonly name: string
    readonly endpoints: readonly string[]
  } | null>(null)
  const [scanning, setScanning] = useState(false)
  // True while getUserMedia is pending, so the button can cancel the request
  // before the stream exists (permission prompt) instead of starting another.
  const [starting, setStarting] = useState(false)
  const [scanError, setScanError] = useState<string | null>(null)
  const snapshot = useMeshSnapshot()
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  // Every stream ever acquired, so a superseded/late-permission stream cannot
  // leak a live camera track when it loses the single-stream race.
  const streamsRef = useRef<Set<MediaStream>>(new Set())
  // Generation token: any start/stop/unmount bumps it, and a permission result
  // whose generation is stale is stopped instead of attached.
  const startTokenRef = useRef(0)
  // Synchronous in-flight guard: state updates are async, a double click is not.
  const startingRef = useRef(false)
  const detectorRef = useRef<BarcodeDetectorLike | null>(null)
  const mounted = useRef(true)
  const awaitingIdRef = useRef<string | null>(null)
  const seenAwaitingRef = useRef(false)
  const seenSasRef = useRef(false)

  /** Stop every acquired stream and detach the video element. */
  const stopStreams = (): void => {
    for (const stream of streamsRef.current) {
      for (const track of stream.getTracks()) track.stop()
    }
    streamsRef.current.clear()
    streamRef.current = null
    const video = videoRef.current
    if (video !== null) video.srcObject = null
  }

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      // Invalidate a pending getUserMedia and stop every stream, including one
      // that permission resolution may attach after this cleanup.
      startTokenRef.current += 1
      startingRef.current = false
      detectorRef.current = null
      stopStreams()
    }
  }, [])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      // Escape backs out of the plaintext-relay warning first, so one keystroke
      // cannot discard a link that the operator may still want to inspect.
      if (insecure !== null) {
        setInsecure(null)
        return
      }
      props.onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => { window.removeEventListener('keydown', onKeyDown) }
  }, [props, insecure])

  // `pair.complete` returns immediately; the controlled device still has to
  // approve. Watch `state` until that device turns online, reports an error,
  // or is rolled back after a denied/unreachable first-contact attempt.
  useEffect(() => {
    if (awaitingDevice === null) return
    const clearAwaiting = (): void => {
      seenAwaitingRef.current = false
      seenSasRef.current = false
      awaitingIdRef.current = null
      setAwaitingReady(false)
      setAwaitingDevice(null)
    }
    const live = snapshot.state?.devices.find(device => device.deviceId === awaitingDevice.deviceId)
    if (live === undefined) {
      // Only treat absence as rollback/denial after a fresh successful
      // post-pair state poll has settled (ignoring `loading: true`, transient
      // fetch errors, and pre-pair background polls) or once observed live.
      if ((seenAwaitingRef.current || awaitingReady) && !snapshot.loading && snapshot.error === null && snapshot.state !== null) {
        const hadSas = seenSasRef.current
        clearAwaiting()
        setError(t('pairing.failed', {
          message: hadSas ? t('pairing.denied') : t('devices.detail.deviceUnreachable'),
        }))
      }
      return
    }
    seenAwaitingRef.current = true
    if (live.sas !== undefined) seenSasRef.current = true
    if (live.status === 'online') {
      clearAwaiting()
      props.onPaired(live)
      return
    }
    if (live.status === 'error' || live.status === 'revoked') {
      clearAwaiting()
      const detail = describeStatusDetail(live.statusDetail, t)
      setError(t('pairing.failed', { message: detail ?? t('pairing.denied') }))
      return
    }
    // The first `pair.complete` response may precede the Noise handshake; the
    // polled state adds the SAS once the session exists, so merge it in.
    if (live.status === 'connecting' && live.sas !== undefined && live.sas !== awaitingDevice.sas) {
      setAwaitingDevice({ ...awaitingDevice, sas: live.sas })
    }
  }, [snapshot, awaitingDevice, awaitingReady, props, t])

  useEffect(() => {
    if (!scanning) return
    const video = videoRef.current
    const stream = streamRef.current
    const Detector = barcodeDetector()
    if (video === null || stream === null || Detector === null) return
    video.srcObject = stream
    const playing = video.play()
    if (playing !== undefined) void playing.catch(() => { /* autoplay hint only */ })
    const detector = new Detector({ formats: ['qr_code'] })
    detectorRef.current = detector
    let stopped = false
    let frameTimer: ReturnType<typeof setTimeout> | null = null
    const tick = async (): Promise<void> => {
      if (stopped) return
      try {
        const codes = await detector.detect(video)
        const raw = codes[0]?.rawValue
        if (typeof raw === 'string' && raw.length > 0) {
          const link = extractPairingLink(raw)
          if (link !== null) {
            stopped = true
            setScanning(false)
            setText(link)
            void submit(link)
            return
          }
        }
      } catch {
        // Transient decode failures are expected between frames.
      }
      frameTimer = setTimeout(() => { void tick() }, 250)
    }
    frameTimer = setTimeout(() => { void tick() }, 250)
    return () => {
      stopped = true
      if (frameTimer !== null) clearTimeout(frameTimer)
      // Unbind the detector and the video element, then release exactly the
      // stream this scan generation attached.
      if (detectorRef.current === detector) detectorRef.current = null
      video.srcObject = null
      const media = streamRef.current
      streamRef.current = null
      if (media !== null) {
        for (const track of media.getTracks()) track.stop()
        streamsRef.current.delete(media)
      }
    }
    // `submit` is stable in behaviour; re-arming on every render would restart the camera.
  }, [scanning])

  const stopCamera = (): void => {
    // Bump the generation first so a permission prompt that resolves after
    // this call cannot attach (and re-open) the camera.
    startTokenRef.current += 1
    startingRef.current = false
    setStarting(false)
    detectorRef.current = null
    stopStreams()
    setScanning(false)
  }

  const startCamera = async (): Promise<void> => {
    setScanError(null)
    setError(null)
    // Synchronous guard: a double click must not issue two getUserMedia calls.
    if (startingRef.current) return
    const media = typeof navigator === 'undefined' ? undefined : navigator.mediaDevices
    if (media === undefined || typeof media.getUserMedia !== 'function' || barcodeDetector() === null) {
      setScanError(t('pairing.scanUnsupported'))
      return
    }
    startingRef.current = true
    const generation = startTokenRef.current + 1
    startTokenRef.current = generation
    setStarting(true)
    try {
      const stream = await media.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false })
      // The dialog may have unmounted, or the operator may have pressed Stop,
      // while the permission prompt was pending: never keep that late stream.
      if (!mounted.current || generation !== startTokenRef.current || !startingRef.current) {
        for (const track of stream.getTracks()) track.stop()
        return
      }
      // Defensive single-stream invariant: release any previous stream before
      // attaching the new one.
      stopStreams()
      streamsRef.current.add(stream)
      streamRef.current = stream
      startingRef.current = false
      setStarting(false)
      setScanning(true)
    } catch (cause) {
      if (generation !== startTokenRef.current) return
      startingRef.current = false
      setStarting(false)
      const name = cause instanceof DOMException ? cause.name : ''
      setScanError(name === 'NotAllowedError' || name === 'SecurityError' ? t('pairing.cameraDenied') : t('pairing.cameraFailed'))
    }
  }

  const submit = async (
    input: string,
    options: { readonly confirmInsecure?: boolean } = {},
  ): Promise<void> => {
    const link = extractPairingLink(input)
    if (link === null) {
      setError(t('pairing.invalidLink'))
      return
    }
    stopCamera()
    setError(null)
    setSubmitting(true)
    try {
      if (options.confirmInsecure !== true) {
        // Ask the Host to verify the ticket before anything is pinned: a
        // plaintext non-loopback relay must be confirmed by the operator first.
        // The preflight is advisory: a Host from before `pair.inspect` existed
        // (bundle refreshed, process not restarted yet) must still pair safe
        // tickets, and it enforces the previous `wss://` rule by itself. A
        // genuine ticket error is reported by `pair.complete` below either way.
        let warning: { readonly name: string; readonly endpoints: readonly string[] } | null = null
        try {
          const inspection = await meshApi.inspectPairing(link)
          if (inspection.insecureEndpoints.length > 0) {
            warning = {
              name: inspection.name.length > 0 ? inspection.name : inspection.deviceId,
              endpoints: inspection.insecureEndpoints,
            }
          }
        } catch {
          // Preflight unavailable; `pair.complete` remains the authority.
        }
        if (warning !== null) {
          if (mounted.current) setInsecure({ link, ...warning })
          return
        }
      }
      const result = await meshApi.completePairing(link, {
        confirmInsecure: options.confirmInsecure === true,
      })
      if (!mounted.current) return
      if (result.pairing) {
        // Non-blocking: the daemon still has to approve; the panel shows the
        // waiting state and the dialog follows `state` until it settles.
        seenAwaitingRef.current = false
        seenSasRef.current = result.device.sas !== undefined
        awaitingIdRef.current = result.device.deviceId
        setAwaitingReady(false)
        setAwaitingDevice(result.device)
        // `completePairing` already queued a forced refresh via `mutate()`;
        // awaiting `refreshMeshState()` joins that post-mutation fetch without
        // issuing a redundant second `state` request.
        void refreshMeshState().finally(() => {
          if (mounted.current && awaitingIdRef.current === result.device.deviceId) {
            setAwaitingReady(true)
          }
        })
      } else {
        props.onPaired(result.device)
      }
    } catch (cause) {
      if (mounted.current) setError(t('pairing.failed', { message: messageOf(cause) }))
    } finally {
      if (mounted.current) setSubmitting(false)
    }
  }

  const cancelInsecure = (): void => { setInsecure(null) }

  const confirmInsecure = (): void => {
    if (insecure === null) return
    const link = insecure.link
    setInsecure(null)
    void submit(link, { confirmInsecure: true })
  }

  const busy = submitting || awaitingDevice !== null
  // `starting` keeps the same Stop affordance while the permission prompt is
  // open, so pressing it cancels instead of issuing a second stream request.
  const cameraActive = scanning || starting

  return el(
    'div',
    {
      className: 'dm-modal-backdrop',
      onClick: (event: { target: unknown; currentTarget: unknown }) => {
        if (event.target === event.currentTarget) props.onClose()
      },
    },
    el('div', {
      className: 'dm-modal',
      role: 'dialog',
      'aria-modal': 'true',
      'aria-label': t('addHost.title'),
      onClick: (event: { target: unknown; currentTarget: unknown; stopPropagation: () => void }) => { event.stopPropagation() },
    },
    el('div', { className: 'dm-modal-head' },
      el('h2', { className: 'dm-modal-title' }, t('addHost.title')),
      IconButton({ label: t('common.close'), onClick: props.onClose, children: CloseGlyph({ size: 14 }) })),
    el('div', { className: 'dm-modal-body' },
      el('p', { className: 'dm-card-sub' }, t('pairing.desc')),
      error === null ? null : el('div', { className: 'dm-banner dm-banner-error', role: 'alert' }, el('div', { className: 'dm-banner-text' }, error)),
      busy
        ? el('div', { className: 'dm-banner dm-banner-warn', role: 'status' },
          el('div', { className: 'dm-banner-text' },
            el('span', { className: 'dm-banner-title dm-row' }, Spinner(),
              awaitingDevice === null ? t('pairing.waiting') : t('pairing.waitingFor', { name: awaitingDevice.name })),
            el('span', { className: 'dm-muted' }, t('pairing.waitingHint')),
            awaitingDevice?.sas === undefined || awaitingDevice.sas.trim().length === 0
              ? null
              : el('span', { className: 'dm-sas' }, t('pairing.waitingSas', { sas: formatSas(awaitingDevice.sas) }))))
        : null,
      el('label', { className: 'dm-field' },
        el('span', { className: 'dm-label' }, t('pairing.manual')),
        el('textarea', {
          className: 'dm-input',
          rows: 3,
          value: text,
          placeholder: t('pairing.linkPlaceholder'),
          spellcheck: 'false',
          disabled: busy,
          autoFocus: true,
          onInput: (event: { target: { value: string } }) => { setText(event.target.value) },
        })),
      scanning
        ? el('div', { className: 'dm-video-wrap' },
          el('video', {
            ref: (node: HTMLVideoElement | null) => { videoRef.current = node },
            className: 'dm-video',
            playsInline: true,
            muted: true,
            autoPlay: true,
          }),
          el('div', { className: 'dm-scan-hint' }, t('pairing.scanHint')))
        : null,
      scanError === null ? null : el('div', { className: 'dm-banner dm-banner-warn', role: 'status' }, el('div', { className: 'dm-banner-text' }, scanError)),
      el('div', { className: 'dm-modal-actions' },
        Button({
          onClick: cameraActive ? stopCamera : () => { void startCamera() },
          disabled: busy,
          children: [ScanGlyph({ size: 14 }), el('span', { key: 'label' }, cameraActive ? t('pairing.stopScan') : t('pairing.scan'))],
        })),
    ),
    el('div', { className: 'dm-modal-actions' },
      Button({ variant: 'ghost', onClick: props.onClose, children: t('common.cancel') }),
      Button({
        variant: 'primary',
        busy,
        // A warning that is already open owns the decision: the underlying
        // form must not start another attempt (e.g. via Enter on a focused
        // button) until the operator answers it.
        disabled: busy || insecure !== null || text.trim().length === 0,
        onClick: () => { void submit(text) },
        children: t('pairing.startPairing'),
      }))),
    insecure === null
      ? null
      : InsecureRelayWarning({
        t,
        name: insecure.name,
        endpoints: insecure.endpoints,
        onCancel: cancelInsecure,
        onConfirm: confirmInsecure,
      }),
  )
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
