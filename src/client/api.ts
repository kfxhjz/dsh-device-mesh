/**
 * Same-origin local API client plus the plugin's polling store.
 *
 * The browser half never talks to remote devices directly: it posts
 * `{ endpoint, payload }` to its own Host plugin at `LOCAL_API_PATH`, which
 * holds every mesh connection. The envelope and endpoint names are defined in
 * `src/shared/protocol.ts`; the concrete payload/response shapes were agreed
 * with the Host implementation and are normalized here defensively so a small
 * host-side shape change degrades gracefully instead of blanking the UI.
 */
import type {
  MeshDeviceView,
  MeshHostState,
  PairingRequest,
  PairingScope,
  WorkspaceSummary,
  WorkspacesResult,
} from '../shared/protocol.js'
import { LOCAL_API_PATH, PAIRING_URI_PREFIX } from '../shared/protocol.js'
import { useEffect, useState } from 'react'

/** One typed failure from the local API. */
export class MeshApiError extends Error {
  /** Machine-readable code (`mesh/…`, `client/…`, `http/…`). */
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'MeshApiError'
    this.code = code
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function text(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function optionalText(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

const PLATFORMS = new Set(['darwin', 'linux', 'win32', 'android', 'ios', 'web', 'unknown'])
const STATUSES = new Set(['online', 'connecting', 'offline', 'revoked', 'error'])

function platformOf(value: unknown): MeshDeviceView['platform'] {
  return typeof value === 'string' && PLATFORMS.has(value) ? value as MeshDeviceView['platform'] : 'unknown'
}

function statusOf(value: unknown): MeshDeviceView['status'] {
  return typeof value === 'string' && STATUSES.has(value) ? value as MeshDeviceView['status'] : 'offline'
}

/** Normalize the `workspaces.refresh` / `state.devices[].remoteWorkspaces` payload. */
export function normalizeWorkspaces(value: unknown): WorkspacesResult {
  const workspaces = Array.isArray(value)
    ? value
    : isRecord(value) && Array.isArray(value.workspaces) ? value.workspaces : []
  return {
    updatedAt: isRecord(value) && typeof value.updatedAt === 'string' ? value.updatedAt : new Date().toISOString(),
    workspaces: workspaces.map(normalizeWorkspace).filter((item): item is WorkspaceSummary => item !== null),
    ...(isRecord(value) && value.truncated === true ? { truncated: true } : {}),
  }
}

function normalizeWorkspace(value: unknown): WorkspaceSummary | null {
  if (!isRecord(value)) return null
  const id = text(value.id)
  if (id.length === 0) return null
  const sessions = Array.isArray(value.sessions) ? value.sessions : []
  return {
    id,
    title: text(value.title, id),
    path: text(value.path),
    sessions: sessions.filter(isRecord).map(session => ({
      id: text(session.id),
      title: text(session.title),
      updatedAt: text(session.updatedAt),
      running: session.running === true,
      awaitingUser: session.awaitingUser === true,
      unread: session.unread === true,
      ...(session.archived === true ? { archived: true } : {}),
    })).filter(session => session.id.length > 0),
  }
}

function normalizeScope(value: unknown): PairingScope {
  if (!isRecord(value)) return { kind: 'control', workspaces: 'all', expiresAt: null }
  const workspaces = Array.isArray(value.workspaces)
    ? value.workspaces.filter((item): item is string => typeof item === 'string')
    : 'all'
  return {
    kind: value.kind === 'view' ? 'view' : 'control',
    workspaces,
    expiresAt: typeof value.expiresAt === 'number' ? value.expiresAt : null,
  }
}

/** Normalize one device entry from `state`. */
export function normalizeDevice(value: unknown): MeshDeviceView {
  const raw = isRecord(value) ? value : {}
  const remoteResult = raw.remoteWorkspaces === undefined
    ? undefined
    : normalizeWorkspaces(raw.remoteWorkspaces)
  const remote = remoteResult?.workspaces
  const statusDetail = optionalText(raw.statusDetail)
  const sas = optionalText(raw.sas)
  const remoteWorkspacesAt = optionalText(raw.remoteWorkspacesAt)
  return {
    deviceId: text(raw.deviceId),
    name: text(raw.name, text(raw.deviceId)),
    platform: platformOf(raw.platform),
    direction: raw.direction === 'daemon' ? 'daemon' : 'controller',
    pairedAt: text(raw.pairedAt),
    lastSeenAt: typeof raw.lastSeenAt === 'string' ? raw.lastSeenAt : null,
    revoked: raw.revoked === true,
    scope: normalizeScope(raw.scope),
    status: statusOf(raw.status),
    ...(statusDetail === undefined ? {} : { statusDetail }),
    ...(sas === undefined ? {} : { sas }),
    ...(remote === undefined ? {} : { remoteWorkspaces: remote }),
    ...(remoteWorkspacesAt === undefined ? {} : { remoteWorkspacesAt }),
    ...(raw.remoteWorkspacesTruncated === true || remoteResult?.truncated === true
      ? { remoteWorkspacesTruncated: true }
      : {}),
  }
}

function normalizePairingRequest(value: unknown): PairingRequest | null {
  if (!isRecord(value)) return null
  const requestId = text(value.requestId)
  const peer = isRecord(value.peer) ? value.peer : {}
  if (requestId.length === 0) return null
  return {
    requestId,
    peer: {
      deviceId: text(peer.deviceId),
      name: text(peer.name, text(peer.deviceId)),
      platform: platformOf(peer.platform),
      signPk: text(peer.signPk),
      dhPk: text(peer.dhPk),
    },
    sas: text(value.sas),
    createdAt: text(value.createdAt),
  }
}

/** Normalize `state` (tolerates partial host startup snapshots). */
export function normalizeState(value: unknown): MeshHostState {
  const raw = isRecord(value) ? value : {}
  const rawSelf = isRecord(raw.self) ? raw.self : {}
  const direct = isRecord(raw.direct) ? raw.direct : {}
  const relay = isRecord(raw.relay) ? raw.relay : {}
  const devices = Array.isArray(raw.devices) ? raw.devices : []
  const pending = Array.isArray(raw.pendingPairings) ? raw.pendingPairings : []
  const portals = Array.isArray(raw.portals) ? raw.portals : []
  return {
    self: {
      deviceId: text(rawSelf.deviceId),
      name: text(rawSelf.name, text(rawSelf.deviceId)),
      platform: platformOf(rawSelf.platform),
      signPk: text(rawSelf.signPk),
      dhPk: text(rawSelf.dhPk),
      appVersion: text(rawSelf.appVersion),
    },
    protocol: 1,
    direct: {
      enabled: direct.enabled === true,
      port: numberOr(direct.port, 0),
      urls: Array.isArray(direct.urls) ? direct.urls.filter((item): item is string => typeof item === 'string') : [],
    },
    relay: {
      configured: relay.configured === true,
      endpoint: typeof relay.endpoint === 'string' ? relay.endpoint : null,
      connected: relay.connected === true,
      useTls: relay.useTls !== false,
    },
    devices: devices.map(normalizeDevice),
    pendingPairings: pending.map(normalizePairingRequest).filter((item): item is PairingRequest => item !== null),
    portals: portals.filter(isRecord).map(portal => ({
      deviceId: text(portal.deviceId),
      url: text(portal.url),
    })).filter(portal => portal.deviceId.length > 0 && portal.url.length > 0),
  }
}

/** A pairing ticket returned by `pair.ticket`. */
export interface PairingTicket {
  readonly link: string
  readonly expiresAt: string
  readonly qrSvg?: string
}

/** Normalize a `pair.ticket` response. */
export function normalizeTicket(value: unknown): PairingTicket {
  const raw = isRecord(value) ? value : {}
  const link = text(raw.link)
  if (link.length === 0) throw new MeshApiError('client/bad-ticket', 'Host returned an empty pairing link')
  return {
    link,
    expiresAt: text(raw.expiresAt),
    ...(optionalText(raw.qrSvg) === undefined ? {} : { qrSvg: optionalText(raw.qrSvg) as string }),
  }
}

/** Normalize `portal.open`: `{ url }`, a bare string, or `{ value: { url } }`. */
export function normalizePortalUrl(value: unknown): string {
  if (typeof value === 'string' && value.length > 0) return value
  if (isRecord(value)) {
    const nested = isRecord(value.value) ? value.value : undefined
    const url = text(value.url, nested === undefined ? '' : text(nested.url))
    if (url.length > 0) return url
  }
  throw new MeshApiError('client/bad-portal', 'Host returned no portal URL')
}

/** Result of `pair.complete`. */
export interface PairedDeviceResult {
  readonly deviceId: string
  /**
   * True while the controlled device still has to approve the pairing. The
   * client then watches `state` until that device becomes `online` or `error`.
   * Missing (older hosts) means pairing already finished.
   */
  readonly pairing: boolean
  readonly device: MeshDeviceView
}

/**
 * Normalize `pair.complete`: `{ deviceId, pairing, device }`; a bare device
 * shape is tolerated for compatibility with pre-non-blocking hosts.
 */
export function normalizePairedDevice(value: unknown): PairedDeviceResult {
  const raw = isRecord(value) ? value : {}
  const nested = isRecord(raw.device) ? raw.device : raw
  const device = normalizeDevice(nested)
  return { deviceId: text(raw.deviceId, device.deviceId), pairing: raw.pairing === true, device }
}

/**
 * Extract a `dsh-mesh://pair?d=…` link from pasted or scanned text.
 *
 * @returns the canonical link, or `null` when the text carries none.
 */
export function extractPairingLink(input: string): string | null {
  const trimmed = input.trim()
  if (trimmed.length === 0) return null
  const index = trimmed.indexOf(PAIRING_URI_PREFIX)
  if (index < 0) return null
  const tail = trimmed.slice(index + PAIRING_URI_PREFIX.length)
  const payload = tail.split(/[\s"'<>]/u)[0] ?? ''
  if (payload.length === 0) return null
  return `${PAIRING_URI_PREFIX}${payload}`
}

/** POST one endpoint and unwrap the `{ ok, value } | { ok, error }` envelope. */
export async function callEndpoint<T>(endpoint: string, payload?: unknown): Promise<T> {
  let response: Response
  const request: { endpoint: string; payload?: unknown } = { endpoint }
  if (payload !== undefined) request.payload = payload
  try {
    if (typeof fetch !== 'function') throw new Error('fetch is unavailable in this environment')
    response = await fetch(LOCAL_API_PATH, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request),
    })
  } catch (error) {
    throw new MeshApiError('client/network', error instanceof Error ? error.message : String(error))
  }
  let body: unknown
  try {
    body = await response.json()
  } catch {
    throw new MeshApiError(`http/${response.status}`, `Host API returned a non-JSON response (${response.status})`)
  }
  if (isRecord(body) && body.ok === true) return body.value as T
  if (isRecord(body) && body.ok === false) {
    const apiError = isRecord(body.error) ? body.error : {}
    throw new MeshApiError(text(apiError.code, `http/${response.status}`), text(apiError.message, response.statusText))
  }
  throw new MeshApiError(`http/${response.status}`, `Unexpected Host API response (${response.status})`)
}

/** One immutable view of the polling store. */
export interface MeshSnapshot {
  readonly state: MeshHostState | null
  readonly loading: boolean
  readonly error: MeshApiError | null
  readonly updatedAt: number | null
}

let snapshot: MeshSnapshot = { state: null, loading: false, error: null, updatedAt: null }
const listeners = new Set<() => void>()
let consumers = 0
let timer: ReturnType<typeof setInterval> | null = null
let inFlight: Promise<void> | null = null

function notify(): void {
  for (const listener of listeners) {
    try {
      listener()
    } catch {
      // a broken subscriber must not stop the others
    }
  }
}

function publish(next: MeshSnapshot): void {
  snapshot = next
  notify()
}

/** Current store snapshot (stable between refreshes). */
export function getMeshSnapshot(): MeshSnapshot {
  return snapshot
}

/** Refresh `state` from the Host; never rejects (errors land in the snapshot). */
export function refreshMeshState(): Promise<void> {
  if (inFlight !== null) return inFlight
  publish({ ...snapshot, loading: true })
  inFlight = (async () => {
    try {
      const value = await callEndpoint<unknown>('state')
      publish({ state: normalizeState(value), loading: false, error: null, updatedAt: Date.now() })
    } catch (error) {
      const apiError = error instanceof MeshApiError ? error : new MeshApiError('client/unknown', String(error))
      publish({ ...snapshot, loading: false, error: apiError })
    } finally {
      inFlight = null
    }
  })()
  return inFlight
}

function stopTimer(): void {
  if (timer !== null) {
    clearInterval(timer)
    timer = null
  }
}

function ensureTimer(): void {
  if (timer !== null) return
  timer = setInterval(() => {
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
    void refreshMeshState()
  }, 2500)
}

/** Subscribe to the store; the first subscriber starts polling (2.5s). */
export function subscribeMesh(listener: () => void): () => void {
  listeners.add(listener)
  consumers += 1
  ensureTimer()
  if (snapshot.state === null && snapshot.error === null && !snapshot.loading) void refreshMeshState()
  return () => {
    listeners.delete(listener)
    consumers -= 1
    if (consumers <= 0) stopTimer()
  }
}

/** React hook over the polling store; also triggers an immediate refresh. */
export function useMeshSnapshot(): MeshSnapshot {
  const [value, setValue] = useState<MeshSnapshot>(getMeshSnapshot)
  useEffect(() => {
    const unsubscribe = subscribeMesh(() => { setValue(getMeshSnapshot()) })
    setValue(getMeshSnapshot())
    void refreshMeshState()
    return unsubscribe
  }, [])
  return value
}

/** Refresh after a mutation without surfacing a second error path. */
async function mutate<T>(endpoint: string, payload?: unknown): Promise<T> {
  const value = await callEndpoint<T>(endpoint, payload)
  void refreshMeshState()
  return value
}

/**
 * Publish a fresh remote listing immediately instead of waiting for the next
 * `state` poll. A failed archive/unarchive already refreshes through
 * {@link mutate}; this only keeps the successful path snappy.
 */
function installRemoteWorkspaces(deviceId: string, result: WorkspacesResult): void {
  const state = snapshot.state
  if (state === null) return
  let changed = false
  const devices = state.devices.map((device) => {
    if (device.deviceId !== deviceId) return device
    changed = true
    const next: MeshDeviceView = {
      ...device,
      remoteWorkspaces: result.workspaces,
      remoteWorkspacesAt: result.updatedAt,
    }
    if (result.truncated === true) return { ...next, remoteWorkspacesTruncated: true }
    const withoutTruncation = { ...next }
    delete (withoutTruncation as { remoteWorkspacesTruncated?: boolean }).remoteWorkspacesTruncated
    return withoutTruncation
  })
  if (changed) publish({ ...snapshot, state: { ...state, devices } })
}

/** Typed wrappers over every endpoint the UI uses. */
export const meshApi = {
  async ticket(): Promise<PairingTicket> {
    return normalizeTicket(await callEndpoint<unknown>('pair.ticket'))
  },
  async completePairing(link: string): Promise<PairedDeviceResult> {
    return normalizePairedDevice(await mutate<unknown>('pair.complete', { link }))
  },
  async approvePairing(requestId: string, scope?: PairingScope): Promise<void> {
    await mutate<unknown>('pair.approve', scope === undefined ? { requestId } : { requestId, scope })
  },
  async denyPairing(requestId: string): Promise<void> {
    await mutate<unknown>('pair.deny', { requestId })
  },
  async forgetDevice(deviceId: string): Promise<void> {
    await mutate<unknown>('pair.forget', { deviceId })
  },
  async revokeDevice(deviceId: string): Promise<MeshDeviceView> {
    return normalizeDevice(await mutate<unknown>('peer.revoke', { deviceId }))
  },
  async connectDevice(deviceId: string): Promise<MeshDeviceView> {
    return normalizeDevice(await mutate<unknown>('device.connect', { deviceId }))
  },
  async disconnectDevice(deviceId: string): Promise<MeshDeviceView> {
    return normalizeDevice(await mutate<unknown>('device.disconnect', { deviceId }))
  },
  /**
   * Read workspaces from a paired device, or from this host when `deviceId` is
   * omitted (the host caches local results for 60 s; `refresh` bypasses it).
   */
  async refreshWorkspaces(deviceId?: string): Promise<WorkspacesResult> {
    const result = normalizeWorkspaces(await mutate<unknown>('workspaces.refresh', {
      ...(deviceId === undefined ? {} : { deviceId }),
      refresh: true,
    }))
    if (deviceId !== undefined) installRemoteWorkspaces(deviceId, result)
    return result
  },
  /**
   * Archive or restore one Session on a paired device. Returns the refreshed
   * remote listing so the sidebar can update without waiting for the next poll.
   */
  async archiveSession(
    deviceId: string,
    sessionId: string,
    archived: boolean,
    stopActivity = false,
  ): Promise<WorkspacesResult> {
    const result = normalizeWorkspaces(await mutate<unknown>('session.archive', {
      deviceId,
      sessionId,
      archived,
      ...(stopActivity ? { stopActivity: true } : {}),
    }))
    installRemoteWorkspaces(deviceId, result)
    return result
  },
  async openPortalExternally(url: string): Promise<boolean> {
    const result = await mutate<unknown>('portal.external', { url })
    return isRecord(result) && result.opened === true
  },
  async openPortal(deviceId: string): Promise<string> {
    return normalizePortalUrl(await mutate<unknown>('portal.open', { deviceId }))
  },
  async closePortal(deviceId: string): Promise<void> {
    await mutate<unknown>('portal.close', { deviceId })
  },
  async configureDirect(enabled: boolean, port?: number): Promise<void> {
    await mutate<unknown>('direct.configure', port === undefined ? { enabled } : { enabled, port })
  },
  async configureRelay(endpoint: string, enabled: boolean, useTls?: boolean): Promise<void> {
    await mutate<unknown>('relay.configure', {
      endpoint,
      enabled,
      ...(useTls === undefined ? {} : { useTls }),
    })
  },
}

/** Re-exported for components that need to inspect the current device list. */
export type { MeshDeviceView, MeshHostState, PairingRequest, PairingScope, WorkspaceSummary, WorkspacesResult }
