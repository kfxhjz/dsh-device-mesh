/**
 * Controller-side portal: a `127.0.0.1` HTTP + WebSocket reverse proxy that
 * forwards a controller browser's requests over the Mesh session to the
 * daemon's own DSH Web UI.
 *
 * Security model (PROTOCOL.md §6.1, §9):
 *   - binds `127.0.0.1` only, on an OS-assigned port;
 *   - every request needs the 32-byte capability cookie; the URL's `?token=`
 *     trades for an `HttpOnly; SameSite=None; Secure` cookie on first
 *     navigation, and the token is stripped before any request is forwarded;
 *   - requests must carry this portal's exact `Host` and, for WebSockets, its
 *     exact `Origin`; cross-site browser requests are rejected so another
 *     loopback port cannot reuse the cookie (ports share the 127.0.0.1 jar);
 *   - only ordinary HTTP methods and WebSocket upgrades are accepted;
 *   - request bodies and concurrent streams are bounded;
 *   - remote `X-Frame-Options` and CSP `frame-ancestors` are stripped so the
 *     controller's own local page can embed the proxy in an iframe;
 *   - the URL token is never logged and dies with the portal.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { once } from 'node:events'
import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocketServer } from 'ws'
import type { WebSocket } from 'ws'

import type { ChunkStream, MeshSession, WsExchangeResult } from '../shared/mesh-session.ts'
import { decodeWsMessage, encodeWsMessage, MeshRpcError } from '../shared/mesh-session.ts'
import { toBase64Url } from '../shared/protocol.ts'
import type { PortalHttpParams } from '../shared/protocol.ts'
import { PORTAL_IDLE_TIMEOUT_MS, PORTAL_MAX_BODY_BYTES, silentLogger } from './config.ts'
import { PortalCache } from './portal-cache.ts'
import { encodePortalWsMessage, gunzipWsPayload } from './ws-compression.ts'
import type { MeshLogger } from './config.ts'

/** Methods a portal forwards (PROTOCOL.md §6.1). */
const ALLOWED_METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'])

/**
 * Server-side WebSocket keepalive. Browser WebSocket clients answer pings
 * automatically; this detects dead tabs and keeps idle portal sockets from
 * being reaped by the OS/browser between user actions.
 */
const PORTAL_WS_HEARTBEAT_MS = 20_000

/** Drop a browser WebSocket whose outbound queue grows past this many bytes. */
const MAX_BROWSER_WS_BUFFERED_BYTES = 8 * 1024 * 1024

/** Cap on concurrent multiplexed streams per portal (PROTOCOL.md §6.2). */
const DEFAULT_MAX_CONCURRENT_STREAMS = 32

/** Hard cap on local HTTP/WebSocket connections held by one portal. */
const PORTAL_MAX_CONNECTIONS = 256

/** Bound on receiving request headers before the socket is dropped. */
const PORTAL_HEADERS_TIMEOUT_MS = 10_000

/** Bound on one local HTTP request before the socket is dropped. */
const PORTAL_REQUEST_TIMEOUT_MS = 30_000

/**
 * Cap on one browser WebSocket message. The portal re-frames larger messages
 * into 32 KiB Mesh stream chunks, so a single local message never needs MiB-scale
 * buffering; the bound limits memory a compromised remote UI can force per tab.
 */
const MAX_BROWSER_WS_MESSAGE_BYTES = 8 * 1024 * 1024

/**
 * Cap on raw browser WebSocket bytes waiting for gzip on one portal socket.
 * `ws` bounds each message; this bounds the aggregate held by the async chain.
 */
const MAX_PENDING_OUTBOUND_COMPRESSION_BYTES = 16 * 1024 * 1024

/** Maximum bytes read from the remote HTML when building the asset manifest. */
const MAX_MANIFEST_BYTES = 4 * 1024 * 1024

/** Bound on building the asset manifest before portal open proceeds without it. */
const MANIFEST_TIMEOUT_MS = 5_000

/** Headers never forwarded from the browser to the daemon. */
const STRIP_REQUEST_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
  'cookie',
  'origin',
  'referer',
  'content-length',
  'if-none-match',
  'if-modified-since',
])

/** Hop-by-hop / credential headers stripped from the daemon's response. */
const STRIP_RESPONSE_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'set-cookie',
  'content-length',
])

const MESH_HEADER_PREFIX = 'x-dsh-mesh-'

/** Maximum number of upstream response headers forwarded to the browser. */
const MAX_RESPONSE_HEADERS = 64

/** Maximum accepted upstream response header value length, in UTF-8 bytes. */
const MAX_RESPONSE_HEADER_VALUE_BYTES = 8192

/** RFC 7230 `token` characters: the only legal HTTP header field names. */
const HEADER_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/u

/**
 * Characters Node rejects in header values: everything except HTAB, visible
 * ASCII and obs-text (latin-1). CR/LF are included.
 */
const INVALID_HEADER_VALUE_PATTERN = /[^\t\u0020-\u007e\u0080-\u00ff]/u

const EMPTY_BODY: ChunkStream = {
  async *[Symbol.asyncIterator](): AsyncGenerator<Uint8Array> {
    // No request body.
  },
}

/**
 * Remove `frame-ancestors` directives from a CSP value, keeping every other
 * directive (both the enforcement and report-only headers are handled).
 * @param csp - raw Content-Security-Policy value.
 * @returns sanitized policy, or an empty string when nothing remains.
 */
export function stripFrameAncestorsDirective(csp: string): string {
  return csp
    .split(';')
    .map(part => part.trim())
    .filter(part => part.length > 0 && !/^frame-ancestors(?:\s|$)/iu.test(part))
    .join('; ')
}

/**
 * Sanitize response headers for embedding the remote DSH UI in a local iframe:
 * drop `X-Frame-Options`, drop CSP `frame-ancestors`, drop hop-by-hop and
 * `Set-Cookie` (the daemon's DSH cookie must never reach the controller).
 * Malformed names/values, oversized values and headers beyond the count cap
 * are dropped so `writeHead()` can never throw on remote data (M-10).
 * @param headers - headers returned by the daemon.
 * @returns sanitized header map.
 */
export function sanitizeControllerResponseHeaders(
  headers: Readonly<Record<string, string>> | undefined,
): Record<string, string> {
  // Always send `nosniff`; it occupies one of the header slots below.
  const result: Record<string, string> = { 'x-content-type-options': 'nosniff' }
  if (headers === undefined) return result
  for (const [rawName, value] of Object.entries(headers)) {
    // Never let a malformed remote header make `writeHead()` throw (M-10):
    // drop it instead of forwarding it.
    if (Object.keys(result).length >= MAX_RESPONSE_HEADERS) break
    if (typeof value !== 'string') continue
    if (!HEADER_NAME_PATTERN.test(rawName)) continue
    if (Buffer.byteLength(value, 'utf8') > MAX_RESPONSE_HEADER_VALUE_BYTES) continue
    if (INVALID_HEADER_VALUE_PATTERN.test(value)) continue
    const name = rawName.toLowerCase()
    if (STRIP_RESPONSE_HEADERS.has(name)) continue
    if (name === 'x-frame-options') continue
    if (name === 'content-security-policy') {
      const sanitized = stripFrameAncestorsDirective(value)
      if (sanitized.length > 0) result[name] = sanitized
      continue
    }
    if (name === 'content-security-policy-report-only') continue
    result[name] = value
  }
  return result
}

/**
 * Filter the browser's request headers down to what the daemon proxy accepts;
 * adds the `X-DSH-Mesh-*` provenance markers required by PROTOCOL.md §6.1.
 * @param headers - Node request headers.
 * @param deviceId - target device id (marker only).
 * @returns header map for `session.http()`.
 */
export function sanitizeControllerRequestHeaders(
  headers: IncomingMessage['headers'],
  deviceId: string,
): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [rawName, rawValue] of Object.entries(headers)) {
    if (rawValue === undefined) continue
    const name = rawName.toLowerCase()
    if (STRIP_REQUEST_HEADERS.has(name)) continue
    if (name.startsWith('sec-fetch-')) continue
    if (name.startsWith(MESH_HEADER_PREFIX)) continue
    if (/^(x-forwarded|x-real-ip|x-original)/u.test(name)) continue
    const value = Array.isArray(rawValue) ? rawValue.join(', ') : rawValue
    if (value.length === 0 || /[\r\n]/u.test(value)) continue
    result[name] = value
  }
  result['x-dsh-mesh-peer'] = deviceId
  result['x-dsh-mesh-version'] = '1'
  return result
}

function cookieNameFor(token: string): string {
  // Ports share a cookie jar for 127.0.0.1, so scope the cookie to this portal
  // instance's token instead of using one fixed name.
  return `dsh-mesh-portal-${toBase64Url(Buffer.from(token, 'utf8')).slice(0, 16)}`
}

function parseCookieHeader(header: string | undefined, name: string): string | undefined {
  if (header === undefined) return undefined
  for (const segment of header.split(';')) {
    const at = segment.indexOf('=')
    if (at === -1) continue
    if (segment.slice(0, at).trim() !== name) continue
    return segment.slice(at + 1).trim()
  }
  return undefined
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, 'utf8')
  const b = Buffer.from(right, 'utf8')
  return a.byteLength === b.byteLength && timingSafeEqual(a, b)
}

function toUint8Array(data: unknown, isBinary: boolean): Uint8Array | undefined {
  if (isBinary) {
    if (data instanceof Uint8Array) return data
    if (data instanceof ArrayBuffer) return new Uint8Array(data)
    return undefined
  }
  if (typeof data === 'string') return Buffer.from(data, 'utf8')
  return data instanceof Uint8Array ? data : undefined
}

function rawHttpResponse(socket: Duplex, status: number, message: string): void {
  const body = `${message}\n`
  try {
    // Flush the reject response, then force the socket closed so a rejected
    // client cannot hold a half-open connection (H-4).
    socket.once('finish', () => {
      socket.destroy()
    })
    socket.end(
      `HTTP/1.1 ${String(status)} ${statusText(status)}\r\n`
      + 'connection: close\r\n'
      + 'content-type: text/plain; charset=utf-8\r\n'
      + 'cache-control: no-store\r\n'
      + `content-length: ${String(Buffer.byteLength(body))}\r\n`
      + '\r\n'
      + body,
    )
  } catch {
    // Socket already gone.
    socket.destroy()
  }
}

function statusText(status: number): string {
  switch (status) {
    case 400: return 'Bad Request'
    case 401: return 'Unauthorized'
    case 403: return 'Forbidden'
    case 404: return 'Not Found'
    case 405: return 'Method Not Allowed'
    case 413: return 'Payload Too Large'
    case 503: return 'Service Unavailable'
    case 502: return 'Bad Gateway'
    default: return 'Error'
  }
}

/**
 * Keep only statuses a Node response can legally carry; anything else becomes
 * `502 Bad Gateway` instead of throwing from `writeHead()`.
 * @param status - status returned by the daemon.
 * @returns a status in the 100–599 range.
 */
function sanitizeResponseStatus(status: number): number {
  return Number.isInteger(status) && status >= 100 && status <= 599 ? status : 502
}

/** Marker + layout override injected into an embedded remote DSH document. */
export function injectEmbedShell(html: string, sessionId?: string): string {
  const css = [
    "html[data-dm-embed='1'] [class$='_frame']{grid-template-columns:minmax(0,1fr)!important}",
    "html[data-dm-embed='1'] [class$='_centerCol']{grid-column:1!important}",
    "html[data-dm-embed='1'] [class$='_sidebarCol'],html[data-dm-embed='1'] [class$='_detailsCol'],html[data-dm-embed='1'] [class$='_rightbarCol']{display:none!important}",
    "html[data-dm-embed='1'] [data-device-mesh-host-bar],html[data-dm-embed='1'] [data-device-mesh-remote-workspaces]{display:none!important}",
  ].join('')
  const remember = sessionId === undefined || sessionId.length === 0
    ? ''
    : `try{sessionStorage.setItem('dsh-device-mesh:dm-session',${scriptJson(sessionId)})}catch{}`
  const injection = `<script>document.documentElement.dataset.dmEmbed='1';${remember}</script><style id="dm-embed-shell">${css}</style>`
  const index = html.search(/<\/head>/iu)
  return index < 0 ? `${injection}${html}` : `${html.slice(0, index)}${injection}${html.slice(index)}`
}

/**
 * JSON that is safe inside an inline `<script>` element.
 *
 * `JSON.stringify` does not escape `<`, so a peer-controlled string such as
 * `</script><script>…` would close the script element and execute markup in the
 * portal origin. Escaping the HTML-significant characters keeps the value pure
 * data (`\u003c` is still valid JSON/JS).
 */
function scriptJson(value: unknown): string {
  return JSON.stringify(value)
    .replaceAll('<', '\\u003c')
    .replaceAll('>', '\\u003e')
    .replaceAll('&', '\\u0026')
}

function statusForError(error: unknown): number {
  if (error instanceof MeshRpcError) {
    switch (error.code) {
      case 'mesh/bad-request':
      case 'portal/bad-request':
        return 400
      case 'mesh/unauthorized':
      case 'mesh/revoked':
        return 403
      case 'mesh/not-found':
        return 404
      case 'mesh/busy':
        return 503
      case 'portal/unavailable':
        return 503
      case 'portal/upstream-error':
        return 502
      default:
        return 502
    }
  }
  return 502
}

/** Options for {@link PortalController}. */
export interface PortalControllerOptions {
  readonly session: MeshSession
  readonly deviceId: string
  readonly logger?: MeshLogger
  /** Bind address; always loopback. Default `127.0.0.1`. */
  readonly host?: string
  /** Bind port; `0` lets the OS choose. Default `0`. */
  readonly port?: number
  readonly maxBodyBytes?: number
  readonly maxConcurrentStreams?: number
  readonly idleTimeoutMs?: number
  readonly now?: () => number
  /** Test seam: fixed capability token instead of 32 random bytes. */
  readonly token?: string
  /** Persist immutable GUI assets across portal opens/restarts. */
  readonly cacheDir?: string
  /** Called exactly once when the portal closes (idle timeout or {@link close}). */
  readonly onClose?: () => void
}

type AuthResult =
  | { readonly kind: 'ok' }
  | { readonly kind: 'reject'; readonly status: 401 | 403; readonly message: string }
  | { readonly kind: 'redirect'; readonly location: string }

/**
 * One controller-side portal instance. Create with `PortalController.open()`
 * and expose `url` to the client plugin; call {@link close} when the user
 * closes the remote control tab.
 */
export class PortalController {
  private session: MeshSession
  private readonly deviceId: string
  private readonly logger: MeshLogger
  private readonly host: string
  private readonly requestedPort: number
  private readonly maxBodyBytes: number
  private readonly maxConcurrentStreams: number
  private readonly idleTimeoutMs: number
  private readonly now: () => number
  private readonly onCloseCallback: (() => void) | undefined
  private readonly tokenValue: string
  private readonly cookieName: string
  private readonly cache: PortalCache | undefined

  private server: Server | undefined
  private wss: WebSocketServer | undefined
  private actualPort = 0
  private activeStreams = 0
  private clients = new Set<WebSocket>()
  private lastActivity = 0
  private idleTimer: NodeJS.Timeout | undefined
  private closed = false
  private closeWaiters: Array<() => void> = []
  private lastErrorValue: string | undefined
  private assetManifestKey: string | undefined

  private constructor(options: PortalControllerOptions) {
    this.session = options.session
    this.deviceId = options.deviceId
    this.logger = options.logger ?? silentLogger
    this.host = options.host ?? '127.0.0.1'
    this.requestedPort = options.port ?? 0
    this.maxBodyBytes = options.maxBodyBytes ?? PORTAL_MAX_BODY_BYTES
    this.maxConcurrentStreams = options.maxConcurrentStreams ?? DEFAULT_MAX_CONCURRENT_STREAMS
    this.idleTimeoutMs = options.idleTimeoutMs ?? PORTAL_IDLE_TIMEOUT_MS
    this.now = options.now ?? Date.now
    this.onCloseCallback = options.onClose
    this.tokenValue = options.token ?? toBase64Url(randomBytes(32))
    this.cookieName = cookieNameFor(this.tokenValue)
    this.cache = options.cacheDir === undefined ? undefined : new PortalCache(options.cacheDir)
  }

  /**
   * Start the loopback proxy.
   * @param options - session, device id and limits.
   * @returns listening controller.
   */
  static async open(options: PortalControllerOptions): Promise<PortalController> {
    const controller = new PortalController(options)
    await controller.start()
    // Fetch the remote resource list before returning the URL: the digest keys
    // the local asset cache, so a remote build update cannot reuse stale files.
    await controller.loadAssetManifest().catch(() => undefined)
    return controller
  }

  /** Local URL to hand to the browser, containing the one-time capability token. */
  get url(): string {
    if (this.actualPort === 0) throw new Error('device-mesh: portal is not listening yet')
    return `${this.portalOrigin()}/?token=${this.tokenValue}`
  }

  /** Local origin of the portal (used for iframe `src` and cookie scope). */
  get origin(): string {
    if (this.actualPort === 0) throw new Error('device-mesh: portal is not listening yet')
    return this.portalOrigin()
  }

  /** Bound port (OS assigned unless configured). */
  get port(): number {
    return this.actualPort
  }

  /** True while the proxy accepts traffic. */
  get open(): boolean {
    return !this.closed && this.server !== undefined
  }

  /** Last proxy error (never contains tokens/cookies). */
  get lastError(): string | undefined {
    return this.lastErrorValue
  }

  /** Resolves once the portal has fully closed. */
  get closedPromise(): Promise<void> {
    if (this.closed) return Promise.resolve()
    return new Promise(resolve => this.closeWaiters.push(resolve))
  }

  /** Diagnostics snapshot. */
  status(): {
    readonly deviceId: string
    readonly port: number
    readonly activeStreams: number
    readonly websockets: number
    readonly idleMs: number
    readonly lastError: string | null
  } {
    return {
      deviceId: this.deviceId,
      port: this.actualPort,
      activeStreams: this.activeStreams,
      websockets: this.clients.size,
      idleMs: Math.max(0, this.now() - this.lastActivity),
      lastError: this.lastErrorValue ?? null,
    }
  }

  /** Stop listening, close proxied sockets, and fire `onClose` once. */
  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    if (this.idleTimer !== undefined) clearInterval(this.idleTimer)
    for (const client of this.clients) {
      try {
        client.terminate()
      } catch {
        // Already closed.
      }
    }
    this.clients.clear()
    const wss = this.wss
    this.wss = undefined
    if (wss !== undefined) {
      await new Promise<void>((resolve) => { wss.close(() => { resolve() }) })
    }
    const server = this.server
    this.server = undefined
    if (server !== undefined) {
      const done = new Promise<void>(resolve => server.close(() =>{  resolve() }))
      server.closeAllConnections?.()
      await done.catch(() => {})
    }
    try {
      this.onCloseCallback?.()
    } catch {
      // Never let a callback break shutdown.
    }
    for (const resolve of this.closeWaiters.splice(0)) resolve()
  }

  private async start(): Promise<void> {
    const server = createServer((request, response) => {
      void this.handleRequest(request, response)
    })
    server.on('upgrade', (request, socket, head) => {
      void this.handleUpgrade(request, socket, head)
    })
    server.on('clientError', (_error, socket) => {
      socket.destroy()
    })
    // The portal is loopback-only, but an unbounded local listener is still a
    // leftover resource for local processes. Bound connections and slow clients.
    server.maxConnections = PORTAL_MAX_CONNECTIONS
    server.headersTimeout = PORTAL_HEADERS_TIMEOUT_MS
    server.requestTimeout = PORTAL_REQUEST_TIMEOUT_MS
    this.wss = new WebSocketServer({
      noServer: true,
      perMessageDeflate: false,
      maxPayload: MAX_BROWSER_WS_MESSAGE_BYTES,
    })
    this.lastActivity = this.now()
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        server.off('listening', onListening)
        reject(new Error(`device-mesh: portal failed to listen on ${this.host}: ${error.message}`))
      }
      const onListening = (): void => {
        server.off('error', onError)
        resolve()
      }
      server.once('error', onError)
      server.once('listening', onListening)
      server.listen(this.requestedPort, this.host)
    })
    this.server = server
    const address = server.address()
    if (address === null || typeof address === 'string') {
      await this.close()
      throw new Error('device-mesh: portal did not bind a TCP port')
    }
    this.actualPort = address.port
    this.idleTimer = setInterval(() => {
      if (this.closed) return
      if (this.now() - this.lastActivity >= this.idleTimeoutMs) {
        this.logger.debug('device-mesh: closing idle portal')
        void this.close()
      }
    }, Math.min(30_000, Math.max(1_000, Math.floor(this.idleTimeoutMs / 2))))
    this.idleTimer.unref?.()
  }

  /**
   * Point an already-open portal at the reconnect that replaced its Mesh
   * session. The capability URL and cookie stay valid, so a remote-control tab
   * can recover from a transient network drop without being reopened.
   * @param session - newly adopted, authenticated controller session.
   */
  adoptSession(session: MeshSession): void {
    if (this.closed) return
    this.session = session
    this.touch()
    void this.loadAssetManifest().catch(() => undefined)
  }

  private touch(): void {
    this.lastActivity = this.now()
  }

  /** `host:port` authority the browser must use; IPv6 hosts get brackets. */
  private hostAuthority(): string {
    const host = this.host.includes(':') && !this.host.startsWith('[')
      ? `[${this.host}]`
      : this.host
    return `${host}:${String(this.actualPort)}`
  }

  private portalOrigin(): string {
    return `http://${this.hostAuthority()}`
  }

  /**
   * Cookies on `127.0.0.1` are shared by port (the cookie key has no port), so
   * another loopback port — including another portal's daemon UI — could
   * otherwise ride this portal's cookie. Require the exact authority (H-4).
   */
  private checkHost(request: IncomingMessage): AuthResult {
    if (request.headers.host !== this.hostAuthority()) {
      return { kind: 'reject', status: 403, message: 'portal Host is not valid' }
    }
    return { kind: 'ok' }
  }

  /**
   * Browser traversal signals: WebSocket handshakes must carry exactly this
   * portal's origin; HTTP requests may come from a top-level navigation
   * (`Sec-Fetch-Site: none`) but never from another site/origin. Non-browser
   * clients without either header stay allowed because the capability
   * token/cookie already bounds them.
   */
  private checkBrowserContext(request: IncomingMessage, upgrade: boolean, tokenEntry = false): AuthResult {
    const origin = request.headers.origin
    if (upgrade) {
      if (origin === undefined || origin !== this.portalOrigin()) {
        return { kind: 'reject', status: 403, message: 'portal WebSocket Origin is missing or not valid' }
      }
      return { kind: 'ok' }
    }
    const site = request.headers['sec-fetch-site']
    // A capability-token navigation is the intended entry point, even when it
    // comes from another loopback origin (the token itself is the capability).
    // The response is a same-origin bootstrap page; every cookie-authenticated
    // request must still prove a same-origin/top-level browser context.
    if (site !== undefined && site !== 'same-origin' && site !== 'none' && !tokenEntry) {
      return { kind: 'reject', status: 403, message: 'cross-site request to the portal is not allowed' }
    }
    // `SameSite=None` means a cross-site request would carry the cookie. A
    // browser without Fetch Metadata (or a non-browser client) sends no
    // `Sec-Fetch-Site`, so a cookie-authenticated request must not rely on the
    // header being absent: require an explicit same-origin/top-level value.
    const hasCookie = parseCookieHeader(request.headers.cookie, this.cookieName) !== undefined
    if (hasCookie && !tokenEntry && site !== 'same-origin' && site !== 'none') {
      return { kind: 'reject', status: 403, message: 'portal cookie requests require same-origin Fetch Metadata' }
    }
    if (origin !== undefined && origin !== this.portalOrigin()) {
      return { kind: 'reject', status: 403, message: 'portal request Origin is not valid' }
    }
    return { kind: 'ok' }
  }

  /**
   * Parse the request target defensively. Browsers may send `//` as a
   * protocol-relative-looking path (e.g. after URL rewrites), which the WHATWG
   * URL constructor rejects when used as a relative reference; normalise it to
   * an ordinary absolute path before resolving against the portal origin.
   */
  private targetUrl(request: IncomingMessage): URL {
    const raw = request.url ?? '/'
    const normalized = raw.startsWith('//')
      ? raw.slice(1)
      : raw.startsWith('/')
        ? raw
        : `/${raw}`
    return new URL(normalized, this.portalOrigin())
  }

  private authorize(request: IncomingMessage, url: URL, upgrade = false): AuthResult {
    const token = url.searchParams.get('token')
    if (token !== null) {
      if (!safeEqual(token, this.tokenValue)) {
        return { kind: 'reject', status: 403, message: 'portal token is not valid' }
      }
      // The capability token must never reach the daemon (M-1): strip it from
      // every forwarded path, not only the GET/HEAD redirect branch.
      url.searchParams.delete('token')
      // Upgrade requests cannot follow a redirect, so a valid token admits the
      // WebSocket directly (the browser page has the cookie by then anyway).
      if (!upgrade && (request.method === 'GET' || request.method === 'HEAD')) {
        const search = url.searchParams.toString()
        const location = `${url.pathname}${search.length > 0 ? `?${search}` : ''}`
        return { kind: 'redirect', location }
      }
      return { kind: 'ok' }
    }
    const cookie = parseCookieHeader(request.headers.cookie, this.cookieName)
    if (cookie === undefined || !safeEqual(cookie, this.tokenValue)) {
      return { kind: 'reject', status: 403, message: 'portal capability cookie is missing or invalid' }
    }
    return { kind: 'ok' }
  }

  /**
   * Cross-site entry (popup/iframes opened from another loopback origin) cannot
   * rely on the browser applying a portal cookie from a redirect, so serve a
   * tiny same-origin bootstrap that stores the cookie and performs a same-origin
   * navigation instead.
   */
  private writeBootstrapRedirect(response: ServerResponse, location: string): void {
    const body = `<!doctype html><html><head><meta charset="utf-8"><title>Opening remote control…</title></head><body><script>location.replace(${scriptJson(location)})</script></body></html>`
    response.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
      'content-security-policy': "default-src 'none'; script-src 'unsafe-inline'",
      'set-cookie': this.cookieSetHeader(),
    })
    response.end(body)
  }

  /**
   * An iframe cannot show useful text for a failed capability exchange, and the
   * parent shell is cross-origin to it. Hand the failure to the parent instead,
   * which can fall back to a top-level window where first-party cookies apply.
   */
  private rejectIframeAuth(response: ServerResponse, message: string): void {
    const body = `<!doctype html><meta charset="utf-8"><p>portal authentication failed</p><script>parent.postMessage({source:'dsh-device-mesh-portal',kind:'auth-failed',message:${scriptJson(message)}},'*')</script>`
    response.writeHead(403, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'content-security-policy': "default-src 'none'; script-src 'unsafe-inline'",
    })
    response.end(body)
  }

  private rejectHttp(response: ServerResponse, status: 401 | 403, message: string): void {
    response.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
    response.end(`${message}\n`)
  }

  private cookieSetHeader(): string {
    // The Desktop renderer is a `dsh-app:` document, so its iframe is cross-site.
    // SameSite=None + Secure lets Chromium carry the cookie into that frame
    // (loopback is a secure context); the request fence still rejects every
    // cross-site cookie request, so only the portal's own same-origin frames use it.
    return `${this.cookieName}=${this.tokenValue}; Path=/; HttpOnly; SameSite=None; Secure`
  }

  private async handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const hostCheck = this.checkHost(request)
    if (hostCheck.kind === 'reject') {
      this.rejectHttp(response, hostCheck.status, hostCheck.message)
      return
    }
    const target = this.targetUrl(request)
    const tokenEntry = target.searchParams.get('token') !== null
    const contextCheck = this.checkBrowserContext(request, false, tokenEntry)
    if (contextCheck.kind === 'reject') {
      if (request.headers['sec-fetch-dest'] === 'iframe') {
        this.rejectIframeAuth(response, contextCheck.message)
        return
      }
      this.rejectHttp(response, contextCheck.status, contextCheck.message)
      return
    }
    const method = (request.method ?? 'GET').toUpperCase()
    if (!ALLOWED_METHODS.has(method)) {
      response.writeHead(405, { allow: [...ALLOWED_METHODS].join(', '), 'content-type': 'text/plain' })
      response.end('method not allowed\n')
      return
    }
    let counted = false
    try {
      const url = target
      const auth = this.authorize(request, url)
      if (auth.kind === 'reject') {
        if (request.headers['sec-fetch-dest'] === 'iframe') {
          this.rejectIframeAuth(response, auth.message)
          return
        }
        this.rejectHttp(response, auth.status, auth.message)
        return
      }
      if (auth.kind === 'redirect') {
        const site = request.headers['sec-fetch-site']
        const crossSite = site !== undefined && site !== 'same-origin' && site !== 'none'
        if (crossSite) {
          this.writeBootstrapRedirect(response, auth.location)
          return
        }
        response.writeHead(303, {
          location: auth.location,
          'set-cookie': this.cookieSetHeader(),
          'cache-control': 'no-store',
          'referrer-policy': 'no-referrer',
        })
        response.end()
        return
      }
      this.touch()
      const manifest = this.assetManifestKey
      const cacheable = method === 'GET' && this.cache !== undefined && manifest !== undefined
      if (cacheable) {
        const cached = await this.cache.get(this.deviceId, manifest, url.pathname, url.search)
        if (cached !== undefined) {
          response.writeHead(200, {
            'content-type': cached.contentType,
            ...(cached.contentEncoding !== undefined ? { 'content-encoding': cached.contentEncoding } : {}),
            'content-length': String(cached.body.byteLength),
            'x-dm-cache': 'hit',
            'x-content-type-options': 'nosniff',
            'cache-control': 'private, max-age=31536000, immutable',
          })
          response.end(cached.body)
          return
        }
      }
      if (this.activeStreams >= this.maxConcurrentStreams) {
        response.writeHead(503, { 'content-type': 'text/plain; charset=utf-8', 'retry-after': '1' })
        response.end('portal is busy\n')
        return
      }
      const declaredLength = Number(request.headers['content-length'] ?? '')
      if (Number.isFinite(declaredLength) && declaredLength > this.maxBodyBytes) {
        response.writeHead(413, { 'content-type': 'text/plain; charset=utf-8' })
        response.end('request body too large\n')
        return
      }
      this.activeStreams += 1
      counted = true
      const body = method === 'GET' || method === 'HEAD'
        ? EMPTY_BODY
        : this.readRequestBody(request)
      const headers = sanitizeControllerRequestHeaders(request.headers, this.deviceId)
      const params = { method, path: `${url.pathname}${url.search}`, headers }
      const replayable = method === 'GET' || method === 'HEAD' || method === 'OPTIONS'
      const exchange: {
        readonly status: number
        readonly headers: Record<string, string>
        readonly bytes?: Uint8Array
        readonly body?: ChunkStream
      } = replayable
        ? await this.proxyAsset(params, body)
        : await this.session.http(params, body)
      const responseHeaders = sanitizeControllerResponseHeaders(exchange.headers)
      const status = sanitizeResponseStatus(exchange.status)
      if (exchange.bytes !== undefined) {
        const html = /text\/html/iu.test(exchange.headers['content-type'] ?? '')
        const bytes = html && url.searchParams.get('dm-embed') === '1'
          ? Buffer.from(injectEmbedShell(
            Buffer.from(exchange.bytes).toString('utf8'),
            url.searchParams.get('dm-session') ?? undefined,
          ), 'utf8')
          : exchange.bytes
        if (cacheable && status === 200) {
          await this.cache?.put(
            this.deviceId,
            manifest,
            url.pathname,
            url.search,
            bytes,
            exchange.headers['content-type'] ?? 'application/octet-stream',
            exchange.headers['content-encoding'],
          )
        }
        response.writeHead(status, {
          ...responseHeaders,
          'content-length': String(bytes.byteLength),
        })
        response.end(bytes)
        return
      }
      response.writeHead(status, responseHeaders)
      if (method === 'HEAD') {
        response.end()
        return
      }
      let aborted = false
      request.once('aborted', () => {
        aborted = true
      })
      try {
        for await (const chunk of exchange.body as ChunkStream) {
          if (aborted || response.destroyed) break
          if (!response.write(chunk)) await once(response, 'drain')
        }
      } finally {
        response.end()
      }
    } catch (error) {
      this.lastErrorValue = error instanceof Error ? error.message : String(error)
      const code = (error as { code?: unknown }).code
      this.logger.warn(`device-mesh: portal request failed (${typeof code === 'string' ? code : 'error'}): ${this.lastErrorValue}`)
      if (!response.headersSent) {
        const status = statusForError(error)
        response.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
        response.end(`${this.lastErrorValue}\n`)
      } else {
        response.destroy()
      }
    } finally {
      if (counted) this.activeStreams = Math.max(0, this.activeStreams - 1)
      this.touch()
    }
  }

  private async *readRequestBody(request: IncomingMessage): AsyncGenerator<Uint8Array> {
    let total = 0
    for await (const chunk of request) {
      const bytes = chunk instanceof Uint8Array ? chunk : Buffer.from(String(chunk))
      total += bytes.byteLength
      if (total > this.maxBodyBytes) {
        request.destroy()
        throw new MeshRpcError('mesh/bad-request', 'portal request body exceeds the configured limit')
      }
      yield bytes
    }
  }

  /**
   * Fetch the remote DSH HTML and turn its referenced immutable assets into a
   * manifest digest. The URL hash remains the per-asset key; the digest makes a
   * build update invalidate the whole set even if a URL were reused.
   */
  private async loadAssetManifest(): Promise<void> {
    if (this.cache === undefined) return
    if (!this.session.open) await this.waitForOpenSession()
    if (!this.session.open) return
    const exchange = await this.session.http({ method: 'GET', path: '/', headers: {} }, EMPTY_BODY)
    const html = await readLimitedText(exchange.body, MAX_MANIFEST_BYTES, MANIFEST_TIMEOUT_MS)
    if (html === undefined) {
      // A huge or stalled manifest is only an optimization loss: portal open
      // still proceeds, and the remote UI can be loaded without the cache.
      this.assetManifestKey = undefined
      return
    }
    const urls = new Set<string>()
    const pattern = /(?:src|href)="([^"]+)"/gu
    for (const match of html.matchAll(pattern)) {
      const raw = match[1]
      if (raw === undefined) continue
      let candidate = raw.replaceAll('&amp;', '&').replace(/^\.\//u, '')
      if (!candidate.startsWith('/')) candidate = `/${candidate}`
      if (/^\/(?:assets|plugins|locales|fonts)\//u.test(candidate)) urls.add(candidate)
    }
    if (urls.size === 0) {
      this.assetManifestKey = undefined
      return
    }
    this.assetManifestKey = createHash('sha256').update([...urls].sort().join('\n')).digest('hex')
  }

  /** Wait briefly for a reconnect to adopt a fresh Mesh session. */
  private async waitForOpenSession(timeoutMs = 5_000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs
    while (!this.closed && !this.session.open && Date.now() < deadline) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 50)
        timer.unref?.()
      })
    }
    return this.session.open
  }

  /** Buffer small text/JS assets so a mid-transfer reconnect never truncates them. */
  private async proxyAsset(
    params: Omit<PortalHttpParams, 'streamId'>,
    body: ChunkStream,
  ): Promise<{
    readonly status: number
    readonly headers: Record<string, string>
    readonly bytes?: Uint8Array
    readonly body?: ChunkStream
  }> {
    const limit = 12 * 1024 * 1024
    let lastError: unknown
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (!this.session.open) await this.waitForOpenSession()
      try {
        const exchange = await this.session.http(params, body)
        if (params.method === 'HEAD') {
          return { status: exchange.status, headers: exchange.headers, bytes: new Uint8Array(0) }
        }
        const contentType = exchange.headers['content-type'] ?? ''
        const bufferable = /(?:javascript|ecmascript|text\/css|text\/html|application\/json)/iu.test(contentType)
          || /^\/(?:assets|plugins|locales|fonts)\//u.test(params.path)
        if (!bufferable) {
          return { status: exchange.status, headers: exchange.headers, body: exchange.body }
        }
        const chunks: Uint8Array[] = []
        let total = 0
        for await (const chunk of exchange.body) {
          total += chunk.byteLength
          if (total > limit) {
            throw new MeshRpcError('portal/upstream-error', 'portal asset exceeds the buffer limit')
          }
          chunks.push(chunk)
        }
        return {
          status: exchange.status,
          headers: exchange.headers,
          bytes: chunks.length === 1 ? (chunks[0] ?? new Uint8Array(0)) : Buffer.concat(chunks.map(chunk => Buffer.from(chunk))),
        }
      } catch (error) {
        lastError = error
        if (attempt >= 2 || !await this.waitForOpenSession()) break
      }
    }
    throw lastError
  }

  private async handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    let exchange: WsExchangeResult | undefined
    // `session.ws()` can take a while (RPC + upstream DSH dial). If the browser
    // goes away meanwhile, the exchange must be aborted as soon as it exists (M3).
    let browserGone = false
    const onBrowserGone = (): void => {
      browserGone = true
    }
    let counted = false
    let handedOff = false
    const release = (): void => {
      if (!counted) return
      counted = false
      this.activeStreams = Math.max(0, this.activeStreams - 1)
    }
    const abortExchange = (reason: string): void => {
      const current = exchange
      if (current === undefined) return
      exchange = undefined
      void current.sink.abort(reason).catch(() => {})
      // Cancel the inbound iteration so the session stream is released even when
      // the peer never sends another frame.
      const iterator = current.messages[Symbol.asyncIterator]()
      void iterator.return?.(undefined)?.catch(() => {})
    }
    try {
      const hostCheck = this.checkHost(request)
      if (hostCheck.kind === 'reject') {
        rawHttpResponse(socket, hostCheck.status, hostCheck.message)
        return
      }
      const contextCheck = this.checkBrowserContext(request, true)
      if (contextCheck.kind === 'reject') {
        rawHttpResponse(socket, contextCheck.status, contextCheck.message)
        return
      }
      const url = this.targetUrl(request)
      const auth = this.authorize(request, url, true)
      if (auth.kind === 'reject') {
        rawHttpResponse(socket, auth.status, auth.message)
        return
      }
      if (auth.kind === 'redirect') {
        // WebSocket clients do not follow a redirect to set a cookie.
        rawHttpResponse(socket, 403, 'open the portal page before connecting its WebSocket')
        return
      }
      if (this.wss === undefined || this.closed) {
        rawHttpResponse(socket, 503, 'portal is closed')
        return
      }
      if (this.activeStreams >= this.maxConcurrentStreams) {
        rawHttpResponse(socket, 503, 'portal is busy')
        return
      }
      const protocols = (request.headers['sec-websocket-protocol'] ?? '')
        .split(',')
        .map(item => item.trim())
        .filter(item => item.length > 0)
        .slice(0, 8)
      this.touch()
      // WebSocket exchanges hold a stream slot until the browser socket ends, so
      // they must count against the same concurrency cap as HTTP requests (M3).
      this.activeStreams += 1
      counted = true
      socket.on('close', onBrowserGone)
      // Keep the listener attached: a late raw-socket error after a failed
      // upgrade must never surface as an unhandled 'error' event.
      socket.on('error', onBrowserGone)
      const wsParams = {
        path: `${url.pathname}${url.search}`,
        headers: sanitizeControllerRequestHeaders(request.headers, this.deviceId),
        ...(protocols.length > 0 ? { protocols } : {}),
        // Large session-history snapshots travel over this WebSocket; ask the
        // daemon to gzip them before they enter the Mesh. An older daemon ignores
        // the flag and reports no `compressed`, so both sides stay compatible.
        compress: true,
      }
      try {
        if (!this.session.open) await this.waitForOpenSession()
        try {
          exchange = await this.session.ws(wsParams)
        } catch (error) {
          // One retry when a reconnect adopted a fresh session meanwhile.
          if (!await this.waitForOpenSession()) throw error
          exchange = await this.session.ws(wsParams)
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'remote portal WebSocket failed'
        this.lastErrorValue = message
        rawHttpResponse(socket, statusForError(error), message)
        return
      }
      if (browserGone || socket.destroyed) {
        abortExchange('portal ws client disconnected')
        return
      }
      // The daemon already negotiated with the local DSH; the browser must get
      // the same subprotocol, not simply its first offer (M1).
      const negotiated = typeof exchange.protocol === 'string' && protocols.includes(exchange.protocol)
        ? exchange.protocol
        : undefined
      this.selectWsProtocol(negotiated)
      const wss = this.wss
      try {
        await new Promise<void>((resolve, reject) => {
          let callbackCalled = false
          try {
            wss.handleUpgrade(request, socket, head, (client) => {
              callbackCalled = true
              // Ownership of the stream slot moves to the client teardown path
              // (`release` is called from `attachWebSocket`'s dispose).
              handedOff = true
              this.attachWebSocket(client, exchange as WsExchangeResult, release)
              resolve()
            })
          } catch (error) {
            reject(error instanceof Error ? error : new Error(String(error)))
            return
          }
          if (!callbackCalled) {
            // `ws` destroys the socket without invoking the callback for an
            // invalid/closed handshake; do not leave the promise (or the
            // exchange) hanging.
            reject(new Error('portal WebSocket upgrade failed'))
          }
        })
      } catch (error) {
        const message = error instanceof Error ? error.message : 'portal WebSocket upgrade failed'
        this.lastErrorValue = message
        abortExchange('portal ws upgrade failed')
        try {
          socket.destroy()
        } catch {
          // Already gone.
        }
      }
    } catch (error) {
      this.lastErrorValue = error instanceof Error ? error.message : String(error)
      abortExchange('portal ws upgrade failed')
      try {
        socket.destroy()
      } catch {
        // Already gone.
      }
    } finally {
      socket.off('close', onBrowserGone)
      if (!handedOff) release()
    }
  }

  /**
   * Select the subprotocol written into the local 101 response for the next
   * `handleUpgrade` call. `ws` reads `options.handleProtocols` synchronously
   * while writing the handshake, so setting it immediately before the call is
   * race-free (the interleaving window is synchronous).
   * @param protocol - protocol the remote negotiated, or `undefined` for none.
   */
  private selectWsProtocol(protocol: string | undefined): void {
    const wss = this.wss
    if (wss === undefined) return
    wss.options.handleProtocols = protocol === undefined
      // Explicitly decline so `ws` does not fall back to the first browser offer.
      ? () => false
      : () => protocol
  }

  private attachWebSocket(
    client: WebSocket,
    exchange: WsExchangeResult,
    release: () => void,
  ): void {
    this.clients.add(client)
    this.touch()
    let disposed = false
    let alive = true
    const heartbeat = setInterval(() => {
      if (client.readyState !== client.OPEN) return
      if (!alive) {
        client.terminate()
        return
      }
      alive = false
      try { client.ping() } catch { /* socket already gone */ }
    }, PORTAL_WS_HEARTBEAT_MS)
    heartbeat.unref?.()
    client.on('pong', () => { alive = true })
    const dispose = (): void => {
      if (disposed) return
      disposed = true
      clearInterval(heartbeat)
      this.clients.delete(client)
      release()
      this.touch()
    }
    // Browser messages are usually small, but a paste or file chunk can be
    // large. Keep their order while gzip runs, and let close/abort wait for the
    // chain so a trailing frame cannot overtake the close on the Mesh.
    const compress = exchange.compressed === true
    let outboundChain: Promise<void> = Promise.resolve()
    let pendingOutboundBytes = 0
    const failClient = (): void => {
      try {
        client.terminate()
      } catch {
        // Already gone.
      }
    }
    client.on('message', (data: unknown, isBinary: boolean) => {
      const bytes = toUint8Array(data, isBinary)
      if (bytes === undefined) return
      this.touch()
      // Carry the opcode across the byte-oriented Mesh framing (C1).
      const kind = isBinary ? 'binary' : 'text'
      if (!compress) {
        void exchange.sink.sendMessage(encodeWsMessage(bytes, kind)).catch(failClient)
        return
      }
      pendingOutboundBytes += bytes.byteLength
      if (pendingOutboundBytes > MAX_PENDING_OUTBOUND_COMPRESSION_BYTES) {
        pendingOutboundBytes -= bytes.byteLength
        failClient()
        return
      }
      outboundChain = outboundChain.then(async () => {
        try {
          await exchange.sink.sendMessage(await encodePortalWsMessage(bytes, kind, true))
        } finally {
          pendingOutboundBytes -= bytes.byteLength
        }
      }).catch(() => {
        pendingOutboundBytes = 0
        failClient()
      })
    })
    client.on('close', (code: number, reason: Buffer) => {
      dispose()
      if (code === 1006) {
        // Abnormal loss (killed tab / dropped TCP): abort so the daemon closes
        // the upstream DSH socket instead of waiting for a graceful End.
        void outboundChain.then(
          () => exchange.sink.abort('portal ws client disconnected'),
          () => undefined,
        ).catch(() => undefined)
        return
      }
      void outboundChain.then(
        () => exchange.sink.close(code, reason.toString('utf8')),
        () => undefined,
      ).catch(() => undefined)
    })
    client.on('error', () => {
      dispose()
      void outboundChain.then(
        () => exchange.sink.abort('portal ws client error'),
        () => undefined,
      ).catch(() => undefined)
    })
    void (async () => {
      try {
        for await (const message of exchange.messages) {
          if (client.readyState !== client.OPEN) break
          // A stalled tab must not grow the server-side send queue without bound.
          if (client.bufferedAmount > MAX_BROWSER_WS_BUFFERED_BYTES) {
            client.terminate()
            break
          }
          const decoded = decodeWsMessage(message)
          if (decoded.compressed && !compress) {
            throw new MeshRpcError('mesh/bad-request', 'compressed portal message was not negotiated')
          }
          const payload = decoded.compressed ? await gunzipWsPayload(decoded.payload) : decoded.payload
          if (decoded.kind === 'text') client.send(new TextDecoder().decode(payload))
          else client.send(Buffer.from(payload))
          this.touch()
        }
        if (client.readyState === client.OPEN) client.close(1000, 'remote closed')
      } catch {
        try {
          client.terminate()
        } catch {
          // Already gone.
        }
      } finally {
        dispose()
      }
    })()
  }
}

/** Resolve with `undefined` when `promise` does not settle within `ms`. */
async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() =>{  resolve(undefined) }, Math.max(1, ms))
    timer.unref?.()
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/**
 * Read a bounded amount of text from a chunk stream within a deadline.
 *
 * Used for the remote HTML asset manifest: a paired peer must not be able to
 * grow controller memory without bound or keep `portal.open` waiting forever.
 *
 * @param body - stream to read.
 * @param maxBytes - hard byte cap.
 * @param timeoutMs - wall-clock cap.
 * @returns decoded text, or `undefined` on overflow/timeout.
 * @internal
 */
export async function readLimitedText(
  body: ChunkStream,
  maxBytes: number,
  timeoutMs: number,
): Promise<string | undefined> {
  const iterator = body[Symbol.asyncIterator]()
  const chunks: Uint8Array[] = []
  let total = 0
  const deadline = Date.now() + timeoutMs
  try {
    for (;;) {
      const remaining = deadline - Date.now()
      if (remaining <= 0) return undefined
      const next = await withTimeout(iterator.next(), remaining)
      if (next === undefined) return undefined
      if (next.done === true) break
      total += next.value.byteLength
      if (total > maxBytes) return undefined
      chunks.push(next.value)
    }
  } finally {
    // Cancel the upstream body, but do not let a stalled generator block this
    // helper: a bounded wait gives the normal InputStream cancel path a chance
    // to release the stream slot without reintroducing an unbounded hang.
    try {
      const cancelled = iterator.return?.(undefined)
      if (cancelled !== undefined) {
        await withTimeout(cancelled.then(() => undefined, () => undefined), 100)
      }
    } catch {
      // The body source may already be destroyed.
    }
  }
  return Buffer.concat(chunks.map(chunk => Buffer.from(chunk))).toString('utf8')
}

/** Default limits re-exported for the broker / tests. */
export const PORTAL_DEFAULTS = {
  host: '127.0.0.1',
  maxBodyBytes: PORTAL_MAX_BODY_BYTES,
  maxConcurrentStreams: DEFAULT_MAX_CONCURRENT_STREAMS,
  idleTimeoutMs: PORTAL_IDLE_TIMEOUT_MS,
} as const
