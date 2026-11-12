/**
 * Local browser API: `POST /api/device-mesh`.
 *
 * DSH's Connection plugin mounts the handler returned here as an exact Fetch
 * route on the shared, cookie-authenticated `/api` channel (the ds-bot
 * convention), so the browser never reaches this code without an owner browser
 * session. Every request is `{ endpoint, payload }` and every answer is the
 * `LocalApiResult` envelope from `src/shared/protocol.ts`:
 *
 *   { ok: true, value } | { ok: false, error: { code, message } }
 *
 * The handler is deliberately pure with respect to DSH: it talks to a
 * {@link WebApiBroker} seam, so it can be tested with a fake broker.
 */

import { createRequire } from 'node:module'

import type {
  AuditEntry,
  LocalApiResult,
  MeshDeviceView,
  MeshHostState,
  PairingScope,
  PairingTicketView,
  WorkspacesResult,
} from '../shared/protocol.ts'
import { LOCAL_API_PATH } from '../shared/protocol.ts'
import { MeshRpcError } from '../shared/mesh-session.ts'
import { ConfigValidationError, isRecord, normalizeRelayEndpoint, silentLogger } from './config.ts'
import type { MeshLogger } from './config.ts'
import { assertSupportedPairingScope, PairingError } from './pairing.ts'

/** Maximum accepted JSON envelope size. */
const MAX_ENVELOPE_BYTES = 64 * 1024

/** Broker surface the local API needs; `DeviceMeshBroker` satisfies it. */
export interface WebApiBroker {
  state(): MeshHostState
  createPairingTicket(): Promise<{ readonly link: string; readonly expiresAt: string }>
  pairWithLink(link: string): Promise<MeshDeviceView>
  approvePairing(
    requestId: string,
    scope?: PairingScope,
  ): { readonly requestId: string; readonly approved: boolean } | Promise<{ readonly requestId: string; readonly approved: boolean }>
  denyPairing(requestId: string): { readonly requestId: string; readonly approved: boolean }
  forgetPeer(deviceId: string): Promise<{ readonly forgot: boolean }>
  revokePeer(deviceId: string): Promise<MeshDeviceView>
  renamePeer(deviceId: string, name: string): Promise<{ readonly renamed: boolean }>
  connectDevice(deviceId: string): Promise<MeshDeviceView>
  disconnectDevice(deviceId: string): Promise<MeshDeviceView>
  refreshWorkspaces(deviceId?: string): Promise<WorkspacesResult>
  openPortal(deviceId: string): Promise<{ readonly url: string }>
  closePortal(deviceId: string): Promise<{ readonly closed: boolean }>
  configureDirect(patch: { readonly enabled?: boolean; readonly port?: number }): Promise<MeshHostState['direct']>
  configureRelay(patch: {
    readonly endpoint?: string | null
    readonly enabled?: boolean
    readonly useTls?: boolean
  }): Promise<MeshHostState['relay']>
  listAudit(limit?: number): Promise<AuditEntry[]>
  diagnostics(): Record<string, unknown>
}

/** Options for {@link createWebApi}. */
export interface WebApiOptions {
  readonly broker: WebApiBroker
  readonly logger?: MeshLogger
  /** Test seam replacing QR generation. */
  readonly renderQr?: (link: string) => string
  /**
   * Desktop-only: open a portal URL in the system browser. The URL must match a
   * live portal from `state().portals`; the client never supplies arbitrary
   * external URLs.
   */
  readonly openExternal?: (url: string) => Promise<boolean>
}

type QrCode = {
  addData(data: string): void
  make(): void
  createSvgTag(options?: { cellSize?: number; margin?: number; scalable?: boolean }): string
}

type QrFactory = (typeNumber: number, errorCorrectionLevel: 'L' | 'M' | 'Q' | 'H') => QrCode

/** Lazily require the CommonJS QR library so a missing dep only disables QR art. */
const nodeRequire = createRequire(import.meta.url)
let cachedQrFactory: QrFactory | undefined | null = null

function loadQrFactory(): QrFactory | undefined {
  if (cachedQrFactory !== null) return cachedQrFactory
  try {
    const loaded: unknown = nodeRequire('qrcode-generator')
    let candidate: unknown = loaded
    if ((typeof candidate !== 'function') && isRecord(candidate)) candidate = candidate.default
    cachedQrFactory = typeof candidate === 'function' ? (candidate as QrFactory) : undefined
  } catch {
    cachedQrFactory = undefined
  }
  return cachedQrFactory
}

/**
 * Render the pairing link as a standalone SVG QR code.
 *
 * The client bundle normally draws its own QR code; this host-side render keeps
 * `PairingTicketView.qrSvg` meaningful for thin clients and for copy/paste
 * diagnostics. Returns an empty string when the optional library is missing.
 *
 * @param link - `dsh-mesh://pair?d=…` URI.
 * @returns SVG markup.
 */
export function renderQrSvg(link: string): string {
  const factory = loadQrFactory()
  if (factory === undefined) return ''
  try {
    const qr = factory(0, 'M')
    qr.addData(link)
    qr.make()
    return qr.createSvgTag({ cellSize: 4, margin: 8, scalable: true })
  } catch {
    return ''
  }
}

function fail(code: string, message: string): { readonly ok: false; readonly error: { readonly code: string; readonly message: string } } {
  return { ok: false, error: { code, message } }
}

function ok<T>(value: T): { readonly ok: true; readonly value: T } {
  return { ok: true, value }
}

function payloadRecord(payload: unknown): Record<string, unknown> {
  return isRecord(payload) ? payload : {}
}

function requireString(payload: Record<string, unknown>, field: string): string {
  const value = payload[field]
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new MeshRpcError('mesh/bad-request', `${field} must be a non-empty string`)
  }
  return value
}

function optionalBoolean(payload: Record<string, unknown>, field: string): boolean | undefined {
  const value = payload[field]
  if (value === undefined) return undefined
  if (typeof value !== 'boolean') throw new MeshRpcError('mesh/bad-request', `${field} must be a boolean`)
  return value
}

function optionalScope(payload: Record<string, unknown>): PairingScope | undefined {
  const raw = payload.scope
  if (raw === undefined || raw === null) return undefined
  if (!isRecord(raw)) throw new MeshRpcError('mesh/bad-request', 'scope must be an object')
  if (raw.kind !== undefined && raw.kind !== 'control' && raw.kind !== 'view') {
    throw new MeshRpcError('mesh/bad-request', 'scope.kind must be control or view')
  }
  let workspaces: PairingScope['workspaces']
  if (raw.workspaces === undefined || raw.workspaces === 'all') {
    workspaces = 'all'
  } else if (Array.isArray(raw.workspaces)) {
    workspaces = raw.workspaces.filter((item): item is string => typeof item === 'string')
  } else {
    throw new MeshRpcError('mesh/bad-request', "scope.workspaces must be 'all' or a string array")
  }
  const expiresAt = typeof raw.expiresAt === 'number' && Number.isFinite(raw.expiresAt)
    ? raw.expiresAt
    : null
  return { kind: raw.kind === 'view' ? 'view' : 'control', workspaces, expiresAt }
}

function codeOf(error: unknown): string {
  if (error instanceof MeshRpcError) return error.code
  if (error instanceof PairingError) return error.code
  // Configuration validation is caused by a bad request from the local UI.
  if (error instanceof ConfigValidationError) return 'mesh/bad-request'
  if (isRecord(error) && typeof error.code === 'string') return error.code
  return 'mesh/internal'
}

function messageOf(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) return error.message
  return String(error)
}

/**
 * Dispatch one local-API envelope against the broker.
 * @param broker - broker seam.
 * @param envelope - `{ endpoint, payload }`.
 * @param options - QR renderer override.
 * @returns the wire envelope; never throws.
 */
export async function dispatchLocalApi(
  broker: WebApiBroker,
  envelope: unknown,
  options: {
    readonly renderQr?: (link: string) => string
    readonly openExternal?: (url: string) => Promise<boolean>
  } = {},
): Promise<LocalApiResult<unknown>> {
  try {
    if (!isRecord(envelope)) return fail('mesh/bad-request', 'request body must be a JSON object')
    const endpoint = envelope.endpoint
    if (typeof endpoint !== 'string' || endpoint.length === 0) {
      return fail('mesh/bad-request', 'endpoint must be a non-empty string')
    }
    const payload = payloadRecord(envelope.payload)
    const result = await runEndpoint(broker, endpoint, payload, options)
    return ok(result)
  } catch (error) {
    return fail(codeOf(error), messageOf(error))
  }
}

async function runEndpoint(
  broker: WebApiBroker,
  endpoint: string,
  payload: Record<string, unknown>,
  options: {
    readonly renderQr?: (link: string) => string
    readonly openExternal?: (url: string) => Promise<boolean>
  },
): Promise<unknown> {
  switch (endpoint) {
    case 'state':
      return broker.state()
    case 'pair.ticket': {
      const created = await broker.createPairingTicket()
      const view: PairingTicketView = {
        link: created.link,
        expiresAt: created.expiresAt,
        qrSvg: (options.renderQr ?? renderQrSvg)(created.link),
      }
      return view
    }
    case 'pair.complete': {
      const link = requireString(payload, 'link')
      const device = await broker.pairWithLink(link)
      // Non-blocking contract: the ticket is pinned immediately and the
      // connection/approval progresses in the background (`state` shows it).
      return {
        deviceId: device.deviceId,
        pairing: device.status === 'connecting',
        device,
      }
    }
    case 'pair.approve': {
      const requestId = requireString(payload, 'requestId')
      // The client may send the whole `PairingApproval` shape; `approved: false`
      // is accepted as a denial so one endpoint can serve both buttons.
      if (payload.approved === false) return broker.denyPairing(requestId)
      const scope = optionalScope(payload)
      // Fail closed: v1 cannot enforce view/workspace-limited grants, and
      // pretending otherwise would authorize more than the UI promised.
      assertSupportedPairingScope(scope)
      return broker.approvePairing(requestId, scope)
    }
    case 'pair.deny': {
      const requestId = requireString(payload, 'requestId')
      return broker.denyPairing(requestId)
    }
    case 'pair.forget':
      return broker.forgetPeer(requireString(payload, 'deviceId'))
    case 'peer.revoke':
      return broker.revokePeer(requireString(payload, 'deviceId'))
    case 'peer.rename':
      return broker.renamePeer(requireString(payload, 'deviceId'), requireString(payload, 'name'))
    case 'device.connect':
      return broker.connectDevice(requireString(payload, 'deviceId'))
    case 'device.disconnect':
      return broker.disconnectDevice(requireString(payload, 'deviceId'))
    case 'workspaces.refresh': {
      const deviceId = typeof payload.deviceId === 'string' && payload.deviceId.length > 0
        ? payload.deviceId
        : undefined
      return broker.refreshWorkspaces(deviceId)
    }
    case 'portal.open':
      return broker.openPortal(requireString(payload, 'deviceId'))
    case 'portal.close':
      return broker.closePortal(requireString(payload, 'deviceId'))
    case 'direct.configure': {
      const enabled = optionalBoolean(payload, 'enabled')
      const port = payload.port
      if (port !== undefined && (typeof port !== 'number' || !Number.isSafeInteger(port) || port < 0 || port > 65535)) {
        throw new MeshRpcError('mesh/bad-request', 'port must be an integer in 0..65535')
      }
      return broker.configureDirect({
        ...(enabled !== undefined ? { enabled } : {}),
        ...(typeof port === 'number' ? { port } : {}),
      })
    }
    case 'relay.configure': {
      const rawEndpoint = payload.endpoint
      if (rawEndpoint !== null && rawEndpoint !== undefined && typeof rawEndpoint !== 'string') {
        throw new MeshRpcError('mesh/bad-request', 'endpoint must be a string or null')
      }
      const enabled = optionalBoolean(payload, 'enabled')
      const useTls = optionalBoolean(payload, 'useTls')
      const endpoint = normalizeRelayEndpoint(rawEndpoint, {
        allowInsecure: useTls === false,
        ...(useTls === undefined ? {} : { useTls }),
      })
      return broker.configureRelay({
        endpoint,
        ...(enabled !== undefined ? { enabled } : {}),
        ...(useTls !== undefined ? { useTls } : {}),
      })
    }
    case 'portal.external': {
      const url = requireString(payload, 'url')
      if (!/^http:\/\/127\.0\.0\.1:\d+\//u.test(url)
        || !broker.state().portals.some(portal => portal.url === url)) {
        throw new MeshRpcError('mesh/bad-request', 'unknown portal URL')
      }
      if (options.openExternal === undefined) return { opened: false }
      return { opened: await options.openExternal(url) }
    }
    case 'audit.list': {
      const limit = typeof payload.limit === 'number' && Number.isSafeInteger(payload.limit)
        ? payload.limit
        : undefined
      return broker.listAudit(limit)
    }
    case 'diagnostics':
      return broker.diagnostics()
    default:
      throw new MeshRpcError('mesh/bad-request', `unknown endpoint ${JSON.stringify(endpoint)}`)
  }
}

/** Local API object mounted by the host plugin. */
export interface WebApi {
  /** Path this handler is registered under. */
  readonly path: string
  /** Fetch handler for the DSH Connection route. */
  handle(request: Request): Promise<Response>
  /** Direct envelope dispatch (tests / internal callers). */
  dispatch(envelope: unknown): Promise<LocalApiResult<unknown>>
}

/**
 * Build the local API handler.
 * @param options - broker plus optional logger/QR seam.
 * @returns handler object.
 */
export function createWebApi(options: WebApiOptions): WebApi {
  const logger = options.logger ?? silentLogger
  const renderQr = options.renderQr
  return {
    path: LOCAL_API_PATH,
    async dispatch(envelope: unknown): Promise<LocalApiResult<unknown>> {
      return dispatchLocalApi(options.broker, envelope, {
        ...(renderQr !== undefined ? { renderQr } : {}),
        ...(options.openExternal !== undefined ? { openExternal: options.openExternal } : {}),
      })
    },
    async handle(request: Request): Promise<Response> {
      if (request.method !== 'POST') {
        return new Response(JSON.stringify(fail('mesh/bad-request', 'method not allowed')), {
          status: 405,
          headers: { 'content-type': 'application/json; charset=utf-8', allow: 'POST', 'cache-control': 'no-store' },
        })
      }
      // Reject an oversized declared body before buffering it. DSH's
      // `requestBody: 'buffered'` route has already read the wire body, but the
      // check still protects direct/embedded callers and keeps the contract.
      const declared = Number(request.headers.get('content-length') ?? '')
      if (Number.isFinite(declared) && declared > MAX_ENVELOPE_BYTES) {
        return jsonResponse(fail('mesh/bad-request', 'request body is too large'), 413)
      }
      let text: string
      try {
        text = await request.text()
      } catch {
        return jsonResponse(fail('mesh/bad-request', 'could not read request body'))
      }
      if (Buffer.byteLength(text, 'utf8') > MAX_ENVELOPE_BYTES) {
        return jsonResponse(fail('mesh/bad-request', 'request body is too large'), 413)
      }
      let envelope: unknown
      try {
        envelope = JSON.parse(text) as unknown
      } catch {
        return jsonResponse(fail('mesh/bad-request', 'request body is not JSON'))
      }
      const result = await dispatchLocalApi(
        options.broker,
        envelope,
        renderQr !== undefined ? { renderQr } : {},
      )
      if (!result.ok) logger.debug(`device-mesh: local API ${String((envelope as { endpoint?: unknown }).endpoint)} failed: ${result.error.code}`)
      return jsonResponse(result)
    },
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}
