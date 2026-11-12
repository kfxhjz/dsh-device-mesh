/**
 * Daemon-side portal: proxies Mesh HTTP/WS exchanges to the daemon's own DSH
 * Web server.
 *
 * Credentials: the local DSH Web UI authenticates browsers with a signed
 * `dsh-auth-*` cookie bound to the listener authority. This module obtains that
 * cookie once via `ctx.connection.authenticatedUrl(ctx.webServer.getOrigin())`
 * (the launch-token URL), follows the 303 without redirect (so the `Set-Cookie`
 * is visible), and keeps `name=value` in memory only. The cookie never crosses
 * the Mesh and never appears in logs or on disk.
 *
 * Request hygiene (required by DSH's `/api` fence, see
 * `packages/client/connection/src/api-request-trust.ts`): the proxy dials the
 * exact local origin so `Host` is the cookie authority, rewrites
 * `Origin`/`Referer` to that authority, drops `sec-fetch-*` (cross-site would
 * be rejected), and strips hop-by-hop headers. Responses drop `Set-Cookie`,
 * `Content-Encoding`/`Content-Length` (the body is re-streamed decoded) and
 * hop-by-hop headers.
 */

import { Readable } from 'node:stream'
import { createGzip } from 'node:zlib'

import { WebSocket } from 'ws'

import type { ChunkStream, StreamSink } from '../shared/mesh-session.ts'
import { decodeWsMessage, encodeWsMessage, MeshRpcError } from '../shared/mesh-session.ts'
import type {
  PortalHttpParams,
  PortalPrepareResult,
  PortalWsParams,
} from '../shared/protocol.ts'
import { getHostService, HANDSHAKE_TIMEOUT_MS, isRecord, silentLogger } from './config.ts'
import type { HostContextLike, MeshLogger } from './config.ts'

/** HTTP methods the daemon proxy accepts from a controller portal. */
const PROXY_METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'])

/** Hop-by-hop headers that must never be forwarded in either direction. */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])

/** Request headers worth forwarding to the local DSH Web server. */
const FORWARD_REQUEST_HEADERS = new Set([
  'accept',
  'accept-language',
  'cache-control',
  'content-type',
  'if-match',
  'if-modified-since',
  'if-none-match',
  'pragma',
  'range',
  'user-agent',
  'x-requested-with',
])

/** Headers removed from an upstream HTTP response before it is re-streamed. */
const STRIP_RESPONSE_HEADERS = new Set([
  ...HOP_BY_HOP,
  'set-cookie',
  'content-encoding',
  'content-length',
])

/**
 * DSH-owned header namespace. It includes our `x-dsh-mesh-*` provenance markers
 * and DSH's own `x-dsh-*` headers (`x-dsh-auth-token`, `x-dsh-file`, …); a
 * controller must never be able to supply any of them to the local DSH server.
 */
const DSH_HEADER_PREFIX = 'x-dsh-'

function isBodyless(method: string): boolean {
  return method === 'GET' || method === 'HEAD'
}

function lowerCaseHeaders(
  headers: Readonly<Record<string, string>> | undefined,
): Record<string, string> {
  const result: Record<string, string> = {}
  if (headers === undefined) return result
  for (const [name, value] of Object.entries(headers)) {
    if (typeof value !== 'string') continue
    const key = name.toLowerCase()
    if (key.length === 0 || /[\r\n]/u.test(value)) continue
    result[key] = value
  }
  return result
}

/**
 * Validate a controller-supplied path so it can only address the local DSH
 * origin (no absolute or protocol-relative URL, no CR/LF, no backslashes).
 * @param path - request path including query string.
 * @returns the path unchanged.
 * @throws {MeshRpcError} `mesh/bad-request` for unsafe input.
 */
export function validateProxyPath(path: unknown): string {
  if (typeof path !== 'string' || path.length === 0 || path.length > 8 * 1024) {
    throw new MeshRpcError('mesh/bad-request', 'portal path is missing or too long')
  }
  if (!path.startsWith('/') || path.startsWith('//')) {
    throw new MeshRpcError('mesh/bad-request', 'portal path must be origin-relative')
  }
  if (/[\r\n\\]/u.test(path) || path.includes('\u0000')) {
    throw new MeshRpcError('mesh/bad-request', 'portal path contains control characters')
  }
  return path
}

/**
 * Build the headers sent to the local DSH Web server.
 *
 * `Host` is implied by the request URL (the local origin), `Cookie` carries the
 * in-memory session, and `Origin`/`Referer` are rewritten to the local
 * authority so Connection's fence accepts the request.
 *
 * @param incoming - headers received over the Mesh session.
 * @param origin - local DSH origin, e.g. `http://127.0.0.1:3080`.
 * @param cookie - in-memory `dsh-auth-…=…` cookie pair.
 * @param path - request path (used to build the Referer).
 * @returns sanitized header map.
 */
export function sanitizeProxyRequestHeaders(
  incoming: Readonly<Record<string, string>> | undefined,
  origin: string,
  cookie: string,
  path: string,
): Record<string, string> {
  const source = lowerCaseHeaders(incoming)
  const headers: Record<string, string> = {}
  for (const [name, value] of Object.entries(source)) {
    if (HOP_BY_HOP.has(name)) continue
    if (name.startsWith(DSH_HEADER_PREFIX)) continue
    if (name === 'host' || name === 'cookie' || name === 'origin' || name === 'referer') continue
    if (name.startsWith('sec-fetch-')) continue
    if (name.startsWith('x-') && !FORWARD_REQUEST_HEADERS.has(name)) {
      // x-* headers are allowed by PROTOCOL.md §6.2, but never anything that
      // could rewrite the transport (connection-like) or leak credentials.
      if (/^(x-forwarded|x-real-ip|x-http-method|x-original)/u.test(name)) continue
      headers[name] = value
      continue
    }
    if (FORWARD_REQUEST_HEADERS.has(name) || !name.startsWith('x-')) {
      if (FORWARD_REQUEST_HEADERS.has(name)) headers[name] = value
    }
  }
  // The upstream fetch/lookup path must never be transport-compressed.
  headers['accept-encoding'] = 'identity'
  headers.cookie = cookie
  headers.origin = origin
  headers.referer = `${origin}${path}`
  headers['sec-fetch-site'] = 'same-origin'
  return headers
}

/**
 * Strip headers from an upstream response that would corrupt or leak the local
 * Web session when re-streamed to the controller.
 * @param headers - upstream headers.
 * @returns sanitized header map.
 */
export function sanitizeUpstreamResponseHeaders(
  headers: Readonly<Record<string, string>> | undefined,
): Record<string, string> {
  const source = lowerCaseHeaders(headers)
  const result: Record<string, string> = {}
  for (const [name, value] of Object.entries(source)) {
    if (STRIP_RESPONSE_HEADERS.has(name)) continue
    result[name] = value
  }
  return result
}

/**
 * Rewrite a same-origin absolute `Location` redirect into a path-relative one
 * so the controller's browser stays on the portal origin.
 * @param location - upstream Location value.
 * @param origin - local DSH origin.
 * @returns rewritten location.
 */
export function rewriteLocation(location: string, origin: string): string {
  try {
    const target = new URL(location)
    const local = new URL(origin)
    if (target.origin === local.origin) return `${target.pathname}${target.search}${target.hash}`
    return location
  } catch {
    return location
  }
}

/** Default cap on bytes buffered for one inbound portal WebSocket stream. */
export const MAX_INBOUND_WS_QUEUE_BYTES = 8 * 1024 * 1024

/** Options for {@link ChunkQueue}. */
export interface ChunkQueueOptions {
  /** Maximum bytes retained for a stalled consumer (default 8 MiB). */
  readonly maxQueuedBytes?: number
  /** Invoked once when the cap is exceeded (used to tear down the local socket). */
  readonly onOverflow?: ((error: MeshRpcError) => void) | undefined
}

interface ChunkQueueWaiter {
  readonly resolve: (result: IteratorResult<Uint8Array>) => void
  readonly reject: (error: Error) => void
}

/** An async queue that adapts push-style WebSocket events to `ChunkStream`. */
export class ChunkQueue implements AsyncIterable<Uint8Array> {
  private readonly values: Uint8Array[] = []
  private readonly waiters: ChunkQueueWaiter[] = []
  private readonly maxQueuedBytes: number
  private readonly onOverflow: ((error: MeshRpcError) => void) | undefined
  private queuedBytes = 0
  private ended = false
  private failure: Error | null = null

  constructor(options: ChunkQueueOptions = {}) {
    this.maxQueuedBytes = options.maxQueuedBytes ?? MAX_INBOUND_WS_QUEUE_BYTES
    this.onOverflow = options.onOverflow
  }

  /** Push one chunk (ignored after the queue ended or failed). */
  push(chunk: Uint8Array): void {
    if (this.ended || this.failure) return
    // A single local message larger than the cap is rejected even when a
    // consumer is already waiting: the Mesh stream would otherwise carry an
    // oversized WebSocket message straight to the controller.
    if (chunk.byteLength > this.maxQueuedBytes) {
      const error = new MeshRpcError('mesh/busy', 'websocket message too large')
      this.fail(error)
      this.onOverflow?.(error)
      return
    }
    const waiter = this.waiters.shift()
    if (waiter !== undefined) {
      waiter.resolve({ value: chunk, done: false })
      return
    }
    // A stalled consumer must not let the daemon retain unbounded local
    // WebSocket traffic. Each push is one complete WebSocket message.
    if (this.queuedBytes + chunk.byteLength > this.maxQueuedBytes) {
      const error = new MeshRpcError('mesh/busy', 'websocket message too large')
      this.fail(error)
      this.onOverflow?.(error)
      return
    }
    this.values.push(chunk)
    this.queuedBytes += chunk.byteLength
  }

  /** End the stream after already queued chunks are consumed. */
  end(): void {
    if (this.ended) return
    this.ended = true
    for (const waiter of this.waiters.splice(0)) waiter.resolve({ value: undefined, done: true })
  }

  /** Abort the stream: pending and future reads reject with `error`. */
  fail(error: Error): void {
    if (this.failure || this.ended) return
    this.failure = error
    this.values.length = 0
    this.queuedBytes = 0
    for (const waiter of this.waiters.splice(0)) waiter.reject(error)
  }

  /** Drop queued chunks and end the stream. */
  clear(): void {
    this.values.length = 0
    this.queuedBytes = 0
    this.end()
  }

  [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
    return {
      next: (): Promise<IteratorResult<Uint8Array>> => {
        if (this.failure !== null) return Promise.reject(this.failure)
        const value = this.values.shift()
        if (value !== undefined) {
          this.queuedBytes -= value.byteLength
          return Promise.resolve({ value, done: false })
        }
        if (this.ended) return Promise.resolve({ value: undefined, done: true })
        return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }))
      },
      return: (): Promise<IteratorResult<Uint8Array>> => {
        this.clear()
        return Promise.resolve({ value: undefined, done: true })
      },
    }
  }
}

/** Structural view of `ws` used by the proxy (tests may supply a stand-in). */
export interface PortalWebSocket {
  readonly readyState: number
  readonly protocol: string
  readonly bufferedAmount: number
  send(data: Uint8Array | string): void
  close(code?: number, reason?: string): void
  terminate(): void
  /** Present on real `ws` sockets; optional so test doubles stay minimal. */
  ping?(): void
  on(event: 'message', listener: (data: unknown, isBinary: boolean) => void): void
  on(event: 'close', listener: (code: number, reason: Buffer) => void): void
  on(event: 'error', listener: (error: Error) => void): void
  on(event: 'pong', listener: () => void): void
  on(event: 'unexpected-response', listener: (request: unknown, response: { statusCode?: number; headers: Record<string, string | string[] | undefined> }) => void): void
  on(event: 'open', listener: () => void): void
}

/** Options for {@link PortalDaemon}. */
export interface PortalDaemonOptions {
  /** Cordis host context (preferred). */
  readonly ctx?: HostContextLike
  /** Test seam replacing `ctx.get`. */
  readonly getService?: (name: string) => unknown
  /** Explicit local DSH origin override (tests). */
  readonly origin?: string | (() => string | undefined)
  readonly logger?: MeshLogger
  readonly now?: () => number
  readonly fetchImpl?: typeof fetch
  /** Test seam replacing the `ws` client constructor. */
  readonly openWebSocket?: (
    url: string,
    options: {
      readonly headers: Readonly<Record<string, string>>
      readonly protocols?: readonly string[]
      readonly signal: AbortSignal
    },
  ) => Promise<PortalWebSocket>
  readonly prepareTimeoutMs?: number
  readonly requestTimeoutMs?: number
  readonly cookieFallbackMaxAgeMs?: number
  /** Maximum bytes buffered to make a request body replayable after a 401. */
  readonly replayBufferLimit?: number
}

interface CookieState {
  readonly pair: string
  readonly authority: string
  readonly obtainedAt: number
  readonly expiresAt: number
}

/** Result of `portal.ws.open` on the daemon side. */
export interface DaemonWsExchange {
  readonly protocol?: string
  readonly inbound: ChunkStream
  readonly outbound: StreamSink
}

function parseCookieExpiry(setCookie: string, now: number, fallbackMs: number): number {
  const maxAge = /(?:^|;)\s*max-age=(-?\d+)/iu.exec(setCookie)
  if (maxAge !== null && maxAge[1] !== undefined) {
    const seconds = Number.parseInt(maxAge[1], 10)
    if (Number.isFinite(seconds)) return now + Math.max(0, seconds) * 1000
  }
  const expires = /(?:^|;)\s*expires=([^;]+)/iu.exec(setCookie)
  if (expires !== null && expires[1] !== undefined) {
    const parsed = Date.parse(expires[1])
    if (!Number.isNaN(parsed)) return parsed
  }
  return now + fallbackMs
}

function cookiePairOf(setCookie: string): string | undefined {
  const first = setCookie.split(';')[0]?.trim()
  if (first === undefined || first.length === 0) return undefined
  const at = first.indexOf('=')
  if (at <= 0) return undefined
  const name = first.slice(0, at)
  if (!/^dsh-auth-[A-Za-z0-9_-]+$/u.test(name)) return undefined
  return first
}

function toUint8Array(data: unknown, isBinary: boolean): Uint8Array | undefined {
  if (isBinary) {
    if (data instanceof Uint8Array) return data
    if (data instanceof ArrayBuffer) return new Uint8Array(data)
    if (Array.isArray(data)) return Buffer.concat(data.map(item => Buffer.from(item as Uint8Array)))
    return undefined
  }
  if (typeof data === 'string') return Buffer.from(data, 'utf8')
  return toUint8Array(data, true)
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
  })
}

/**
 * Daemon-side local DSH Web proxy. Create one per host process; `prepare()`
 * happens lazily on the first proxied request.
 */
export class PortalDaemon {
  private readonly getService: (name: string) => unknown
  private readonly explicitOrigin: (() => string | undefined) | undefined
  private readonly logger: MeshLogger
  private readonly now: () => number
  private readonly fetchImpl: typeof fetch
  private readonly openSocket: NonNullable<PortalDaemonOptions['openWebSocket']>
  private readonly prepareTimeoutMs: number
  private readonly requestTimeoutMs: number
  private readonly cookieFallbackMaxAgeMs: number
  private readonly replayBufferLimit: number

  private cookie: CookieState | undefined
  private preparePromise: Promise<CookieState> | undefined
  private lastErrorValue: string | undefined
  private requestCount = 0
  private readonly sockets = new Set<PortalWebSocket>()

  constructor(options: PortalDaemonOptions = {}) {
    const getter = options.getService
    this.getService = getter ?? ((name: string) => getHostService(options.ctx, name))
    const originOption = options.origin
    this.explicitOrigin = typeof originOption === 'function'
      ? originOption
      : originOption !== undefined
        ? () => originOption
        : undefined
    this.logger = options.logger ?? silentLogger
    this.now = options.now ?? Date.now
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init))
    // oxlint-disable-next-line typescript/unbound-method -- static factory carries no receiver state
    this.openSocket = options.openWebSocket ?? PortalDaemon.defaultOpenWebSocket
    this.prepareTimeoutMs = options.prepareTimeoutMs ?? 10_000
    this.requestTimeoutMs = options.requestTimeoutMs ?? 120_000
    this.cookieFallbackMaxAgeMs = options.cookieFallbackMaxAgeMs ?? 30 * 24 * 60 * 60 * 1000
    this.replayBufferLimit = options.replayBufferLimit ?? 1024 * 1024
  }

  /** Default `ws` client opener used in production. */
  private static async defaultOpenWebSocket(
    url: string,
    options: {
      readonly headers: Readonly<Record<string, string>>
      readonly protocols?: readonly string[]
      readonly signal: AbortSignal
    },
  ): Promise<PortalWebSocket> {
    const protocols = options.protocols ?? []
    const socket = new WebSocket(
      url,
      protocols.length > 0 ? [...protocols] : undefined,
      {
        headers: { ...options.headers },
        handshakeTimeout: HANDSHAKE_TIMEOUT_MS,
        maxPayload: 16 * 1024 * 1024,
        perMessageDeflate: false,
      },
    ) as unknown as PortalWebSocket
    return new Promise<PortalWebSocket>((resolve, reject) => {
      const onAbort = (): void => {
        try {
          socket.terminate()
        } catch {
          // Ignore: the socket may already be gone.
        }
        reject(new MeshRpcError('portal/unavailable', 'portal WebSocket dial was cancelled'))
      }
      if (options.signal.aborted) {
        onAbort()
        return
      }
      options.signal.addEventListener('abort', onAbort, { once: true })
      socket.on('open', () => {
        options.signal.removeEventListener('abort', onAbort)
        resolve(socket)
      })
      socket.on('error', (error: Error) => {
        options.signal.removeEventListener('abort', onAbort)
        reject(new MeshRpcError('portal/unavailable', `local DSH WebSocket failed: ${error.message}`))
      })
      socket.on('unexpected-response', (_request, response) => {
        options.signal.removeEventListener('abort', onAbort)
        reject(new MeshRpcError(
          'portal/unavailable',
          `local DSH WebSocket upgrade was rejected (status ${String(response.statusCode ?? 'unknown')})`,
        ))
      })
    })
  }

  /** Last proxy error safe for diagnostics (never a token/cookie). */
  get lastError(): string | undefined {
    return this.lastErrorValue
  }

  /** Initialize the local DSH browser session eagerly. */
  async prepare(): Promise<PortalPrepareResult> {
    await this.ensureCookie(false)
    return { ok: true }
  }

  /**
   * Proxy one HTTP exchange to the local DSH Web server.
   * @param params - method/path/headers from the controller.
   * @param body - request body stream (empty for GET/HEAD).
   * @param signal - session-scoped cancellation.
   * @returns status, sanitized headers and a body stream.
   */
  async http(
    params: Omit<PortalHttpParams, 'streamId'>,
    body: ChunkStream,
    signal: AbortSignal,
  ): Promise<{ readonly status: number; readonly headers: Record<string, string>; readonly body: ChunkStream }> {
    const method = typeof params.method === 'string' ? params.method.toUpperCase() : ''
    if (!PROXY_METHODS.has(method)) {
      throw new MeshRpcError('mesh/bad-request', `portal method ${JSON.stringify(method)} is not allowed`)
    }
    const path = validateProxyPath(params.path)
    const origin = this.requireOrigin()
    this.requestCount += 1
    const cookie = await this.ensureCookie(false)

    const requestBody = isBodyless(method) ? undefined : await this.bufferOrStream(body)
    const headers = sanitizeProxyRequestHeaders(params.headers, origin, cookie.pair, path)

    const baseInit: RequestInit = { method, headers, redirect: 'manual', signal }
    const init = this.applyBody(baseInit, requestBody)
    let response = await this.fetchWithTimeout(`${origin}${path}`, init)
    if (response.status === 401) {
      // The browser session expired (or the process rotated its secret).
      await response.body?.cancel().catch(() => {})
      if (requestBody === undefined || requestBody.replay !== undefined) {
        const refreshed = await this.ensureCookie(true)
        const retryHeaders = sanitizeProxyRequestHeaders(params.headers, origin, refreshed.pair, path)
        const retryInit: RequestInit = { method, headers: retryHeaders, redirect: 'manual', signal }
        response = await this.fetchWithTimeout(
          `${origin}${path}`,
          this.applyBody(retryInit, requestBody),
        )
      }
    }

    const status = response.status
    const resultHeaders: Record<string, string> = {}
    response.headers.forEach((value, name) => {
      resultHeaders[name] = name === 'location' ? rewriteLocation(value, origin) : value
    })
    const sanitized = sanitizeUpstreamResponseHeaders(resultHeaders)
    let resultBody: ChunkStream = this.streamFromWeb(response)
    if (status === 200 && this.compressible(sanitized['content-type'])) {
      resultBody = Readable.from(resultBody).pipe(createGzip({ level: 6 }))
      sanitized['content-encoding'] = 'gzip'
    }
    this.lastErrorValue = undefined
    return { status, headers: sanitized, body: resultBody }
  }

  /**
   * Proxy one WebSocket exchange to the local DSH Web server.
   * @param params - path/headers/protocols from the controller.
   * @param signal - session-scoped cancellation.
   * @returns negotiated protocol, inbound message stream and outbound sink.
   */
  async ws(
    params: Omit<PortalWsParams, 'streamId'>,
    signal: AbortSignal,
  ): Promise<DaemonWsExchange> {
    const path = validateProxyPath(params.path)
    const origin = this.requireOrigin()
    this.requestCount += 1
    const cookie = await this.ensureCookie(false)
    const wsOrigin = origin.replace(/^http:/u, 'ws:').replace(/^https:/u, 'wss:')
    const protocols = Array.isArray(params.protocols)
      ? params.protocols.filter((item): item is string => typeof item === 'string').slice(0, 8)
      : undefined

    const connect = async (cookiePair: string): Promise<PortalWebSocket> => {
      const headers = sanitizeProxyRequestHeaders(params.headers, origin, cookiePair, path)
      const controller = new AbortController()
      const relayAbort = (): void =>{  controller.abort() }
      signal.addEventListener('abort', relayAbort, { once: true })
      const timeout = setTimeout(() =>{  controller.abort() }, HANDSHAKE_TIMEOUT_MS)
      timeout.unref?.()
      try {
        return await this.openSocket(`${wsOrigin}${path}`, {
          headers,
          ...(protocols !== undefined && protocols.length > 0 ? { protocols } : {}),
          signal: controller.signal,
        })
      } finally {
        clearTimeout(timeout)
        signal.removeEventListener('abort', relayAbort)
      }
    }

    let socket: PortalWebSocket
    try {
      socket = await connect(cookie.pair)
    } catch (error) {
      // Mirror the HTTP path: one cookie refresh on a rejected upgrade.
      if (error instanceof MeshRpcError && /status 401/u.test(error.message)) {
        const refreshed = await this.ensureCookie(true)
        socket = await connect(refreshed.pair)
      } else {
        this.lastErrorValue = error instanceof Error ? error.message : String(error)
        throw error instanceof MeshRpcError
          ? error
          : new MeshRpcError('portal/upstream-error', this.lastErrorValue ?? 'portal WebSocket failed')
      }
    }

    this.sockets.add(socket)
    // Keep the loopback DSH WebSocket warm for long-lived remote-control tabs.
    let alive = true
    const heartbeat = typeof socket.ping === 'function'
      ? setInterval(() => {
        if (socket.readyState !== 1) return
        if (!alive) {
          socket.terminate()
          return
        }
        alive = false
        try { socket.ping?.() } catch { /* socket already gone */ }
      }, 20_000)
      : undefined
    heartbeat?.unref?.()
    socket.on('pong', () => { alive = true })
    const stopHeartbeat = (): void => { if (heartbeat !== undefined) clearInterval(heartbeat) }
    const queue = new ChunkQueue({
      onOverflow: () => {
        // The session's duplex pump turns the rejection into an abort frame for
        // this stream; close the local socket so it stops producing messages.
        try {
          socket.close(1009, 'message too large')
        } catch {
          socket.terminate()
        }
      },
    })
    // The stream's abort signal covers the whole exchange, not only the dial:
    // a session close / controller abort must terminate the upstream DSH
    // WebSocket instead of leaving it (and a stream slot) behind (M2).
    const onStreamAbort = (): void => {
      signal.removeEventListener('abort', onStreamAbort)
      stopHeartbeat()
      this.sockets.delete(socket)
      if (socket.readyState >= 2) {
        // The local socket was already closing gracefully (`outbound.end()`
        // ran first): let the inbound direction drain instead of turning a
        // clean close into an abort frame.
        queue.end()
        return
      }
      queue.fail(new MeshRpcError('mesh/internal', 'portal WebSocket stream was cancelled'))
      try {
        socket.close(1011, 'mesh stream aborted')
      } catch {
        socket.terminate()
      }
    }
    socket.on('message', (data: unknown, isBinary: boolean) => {
      const chunk = toUint8Array(data, isBinary)
      // Preserve the local DSH opcode across the byte-oriented Mesh framing (C1).
      if (chunk !== undefined) queue.push(encodeWsMessage(chunk, isBinary ? 'binary' : 'text'))
    })
    socket.on('close', () => {
      signal.removeEventListener('abort', onStreamAbort)
      stopHeartbeat()
      this.sockets.delete(socket)
      queue.end()
    })
    socket.on('error', (error: Error) => {
      signal.removeEventListener('abort', onStreamAbort)
      stopHeartbeat()
      this.lastErrorValue = error.message
      this.sockets.delete(socket)
      queue.end()
    })
    if (signal.aborted) {
      onStreamAbort()
    } else {
      signal.addEventListener('abort', onStreamAbort, { once: true })
    }

    const outbound: StreamSink = {
      write: async (chunk: Uint8Array): Promise<void> => {
        const message = decodeWsMessage(chunk)
        while (socket.bufferedAmount > 8 * 1024 * 1024) await delay(10)
        // Text frames must stay text on the local DSH wire; binary frames must
        // not be coerced to UTF-8 (C1).
        if (message.kind === 'text') socket.send(new TextDecoder().decode(message.payload))
        else socket.send(Buffer.from(message.payload))
      },
      end: async (): Promise<void> => {
        try {
          socket.close(1000)
        } catch {
          // Already closed.
        }
      },
      abort: async (code: string): Promise<void> => {
        try {
          socket.close(1011, code.slice(0, 120))
        } catch {
          socket.terminate()
        }
      },
    }

    return {
      ...(socket.protocol.length > 0 ? { protocol: socket.protocol } : {}),
      inbound: queue,
      outbound,
    }
  }

  /** Diagnostics snapshot: origin authority only, never the token or cookie. */
  status(): {
    readonly origin: string | null
    readonly cookiePresent: boolean
    readonly cookieAgeMs: number | null
    readonly requestCount: number
    readonly lastError: string | null
  } {
    let origin: string | null = null
    try {
      origin = this.originAuthority(this.requireOrigin())
    } catch {
      origin = null
    }
    const cookie = this.cookie
    return {
      origin,
      cookiePresent: cookie !== undefined,
      cookieAgeMs: cookie === undefined ? null : this.now() - cookie.obtainedAt,
      requestCount: this.requestCount,
      lastError: this.lastErrorValue ?? null,
    }
  }

  /** Forget the in-memory cookie and terminate proxied WebSockets. */
  close(): void {
    this.cookie = undefined
    this.preparePromise = undefined
    for (const socket of this.sockets) {
      try {
        socket.terminate()
      } catch {
        // Already closed.
      }
    }
    this.sockets.clear()
  }

  // -- internals ------------------------------------------------------------

  private originAuthority(origin: string): string {
    try {
      const url = new URL(origin)
      return url.host
    } catch {
      return 'invalid'
    }
  }

  private service(name: string): unknown {
    try {
      return this.getService(name)
    } catch {
      return undefined
    }
  }

  /** Resolve the local DSH Web origin from the host services. */
  private resolveOrigin(): string | undefined {
    if (this.explicitOrigin !== undefined) {
      try {
        const explicit = this.explicitOrigin()
        if (explicit !== undefined && explicit.length > 0) return explicit
      } catch {
        // Fall through to the host services.
      }
    }
    const webServer = this.service('webServer')
    if (isRecord(webServer) || typeof webServer === 'object') {
      const getOrigin = serviceFunction(webServer, 'getOrigin')
      if (getOrigin !== undefined) {
        try {
          const origin = getOrigin()
          if (typeof origin === 'string' && origin.length > 0) return origin
        } catch {
          // Listener not bound yet; fall back to protocol/port/host getters.
        }
      }
      const protocolValue = readProperty(webServer, 'protocol')
      const portValue = readProperty(webServer, 'port')
      const hostValue = readProperty(webServer, 'host')
      const protocol = protocolValue === 'https:' ? 'https:' : 'http:'
      if (typeof portValue === 'number' && Number.isSafeInteger(portValue) && portValue > 0) {
        const host = typeof hostValue === 'string' && hostValue.length > 0
          ? (hostValue.includes(':') ? `[${hostValue}]` : hostValue)
          : '127.0.0.1'
        return `${protocol}//${host}:${portValue}`
      }
    }
    return undefined
  }

  private requireOrigin(): string {
    const origin = this.resolveOrigin()
    if (origin === undefined) {
      throw new MeshRpcError('portal/unavailable', 'local DSH Web origin is unavailable')
    }
    return origin
  }

  /** Ensure a fresh in-memory local DSH browser cookie exists. */
  private async ensureCookie(force: boolean): Promise<CookieState> {
    const existing = this.cookie
    if (!force && existing !== undefined && this.now() < existing.expiresAt - 60_000) {
      return existing
    }
    if (this.preparePromise !== undefined) return this.preparePromise
    const promise = this.acquireCookie().finally(() => {
      if (this.preparePromise === promise) this.preparePromise = undefined
    })
    this.preparePromise = promise
    return promise
  }

  private async acquireCookie(): Promise<CookieState> {
    const origin = this.requireOrigin()
    const connection = this.service('connection')
    const authenticatedUrl = serviceFunction(connection, 'authenticatedUrl')
    if (authenticatedUrl === undefined) {
      throw new MeshRpcError('portal/unavailable', 'DSH connection.authenticatedUrl is unavailable')
    }
    let authUrl: string
    try {
      const value = authenticatedUrl(origin)
      if (typeof value !== 'string' || value.length === 0) {
        throw new Error('authenticatedUrl returned no URL')
      }
      authUrl = value
    } catch (error) {
      throw new MeshRpcError(
        'portal/unavailable',
        `could not build the local DSH login URL: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
    const controller = new AbortController()
    const timeout = setTimeout(() =>{  controller.abort() }, this.prepareTimeoutMs)
    timeout.unref?.()
    let response: Response
    try {
      response = await this.fetchImpl(authUrl, {
        method: 'GET',
        redirect: 'manual',
        headers: { accept: 'text/html' },
        signal: controller.signal,
      })
      await response.body?.cancel().catch(() => {})
    } catch (error) {
      throw new MeshRpcError(
        'portal/unavailable',
        `could not log in to the local DSH Web server: ${error instanceof Error ? error.message : String(error)}`,
      )
    } finally {
      clearTimeout(timeout)
    }
    const setCookies = response.headers.getSetCookie().length > 0
      ? response.headers.getSetCookie()
      : (response.headers.get('set-cookie') !== null ? [response.headers.get('set-cookie') as string] : [])
    let pair: string | undefined
    let expiresAt = this.now() + this.cookieFallbackMaxAgeMs
    for (const setCookie of setCookies) {
      const candidate = cookiePairOf(setCookie)
      if (candidate === undefined) continue
      pair = candidate
      expiresAt = parseCookieExpiry(setCookie, this.now(), this.cookieFallbackMaxAgeMs)
      break
    }
    if (pair === undefined) {
      this.lastErrorValue = `local DSH login did not set a session cookie (status ${response.status})`
      this.logger.warn(`device-mesh: ${this.lastErrorValue}`)
      throw new MeshRpcError('portal/unavailable', this.lastErrorValue)
    }
    let authority: string
    try {
      authority = new URL(origin).host
    } catch {
      throw new MeshRpcError('portal/unavailable', 'local DSH origin is not a URL')
    }
    const state: CookieState = { pair, authority, obtainedAt: this.now(), expiresAt }
    this.cookie = state
    this.lastErrorValue = undefined
    this.logger.debug(`device-mesh: acquired local DSH portal cookie for ${authority}`)
    return state
  }

  private async fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController()
    const timeout = setTimeout(() =>{  controller.abort() }, this.requestTimeoutMs)
    timeout.unref?.()
    const caller = init.signal
    const onCallerAbort = (): void =>{  controller.abort() }
    if (caller !== undefined && caller !== null) {
      if (caller.aborted) controller.abort()
      else caller.addEventListener('abort', onCallerAbort, { once: true })
    }
    try {
      return await this.fetchImpl(url, { ...init, signal: controller.signal })
    } catch (error) {
      if (caller?.aborted === true) {
        throw new MeshRpcError('mesh/internal', 'portal request was cancelled')
      }
      this.lastErrorValue = error instanceof Error ? error.message : String(error)
      this.logger.warn(`device-mesh: local DSH portal request failed: ${this.lastErrorValue}`)
      throw new MeshRpcError('portal/upstream-error', `local DSH request failed: ${this.lastErrorValue}`)
    } finally {
      clearTimeout(timeout)
      caller?.removeEventListener('abort', onCallerAbort)
    }
  }

  /** Buffer a replayable request body, or stream it when it is large. */
  private async bufferOrStream(body: ChunkStream): Promise<{
    readonly replay?: Uint8Array
    readonly stream?: ChunkStream
  }> {
    const iterator = body[Symbol.asyncIterator]()
    const chunks: Uint8Array[] = []
    let total = 0
    for (;;) {
      const next = await iterator.next()
      if (next.done === true) break
      const chunk = next.value
      if (!(chunk instanceof Uint8Array)) continue
      chunks.push(chunk)
      total += chunk.byteLength
      if (total > this.replayBufferLimit) {
        return { stream: concatStream(chunks, iterator) }
      }
    }
    return { replay: Buffer.concat(chunks.map(chunk => Buffer.from(chunk))) }
  }

  /** Attach a replayable body (bytes) or a streamed body to a fetch init. */
  private applyBody(
    init: RequestInit,
    requestBody: { readonly replay?: Uint8Array; readonly stream?: ChunkStream } | undefined,
  ): RequestInit {
    if (requestBody?.replay !== undefined) {
      init.body = requestBody.replay as unknown as BodyInit
    } else if (requestBody?.stream !== undefined) {
      init.body = this.readableFrom(requestBody.stream)
      ;(init as RequestInit & { duplex: 'half' }).duplex = 'half'
    }
    return init
  }

  private readableFrom(stream: ChunkStream): ReadableStream<Uint8Array> {
    const iterator = stream[Symbol.asyncIterator]()
    return new ReadableStream<Uint8Array>({
      pull: async (controller) => {
        const next = await iterator.next()
        if (next.done === true) controller.close()
        else controller.enqueue(next.value)
      },
      cancel: async () => {
        await iterator.return?.(undefined).catch?.(() => {})
      },
    })
  }

  /**
   * Compress text assets before they cross the Mesh/relay. The upstream request
   * deliberately uses `identity`, so this is the only compression in the path;
   * it cuts a ~7 MB plugin bundle to roughly 2 MB on the wire. HTML is left
   * uncompressed because the controller injects the embed stylesheet into it.
   */
  private compressible(contentType: string | undefined): boolean {
    if (contentType === undefined) return false
    if (/text\/html/iu.test(contentType)) return false
    return /(?:javascript|ecmascript|text\/css|text\/plain|application\/json|image\/svg)/iu.test(contentType)
  }

  private async *streamFromWeb(response: Response): AsyncGenerator<Uint8Array> {
    const body = response.body
    if (body === null) return
    const reader = body.getReader()
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) return
        if (value !== undefined) yield value
      }
    } finally {
      await reader.cancel().catch(() => {})
    }
  }
}

/** Read one function property off an unknown service object, bound. */
function serviceFunction(service: unknown, name: string): ((...args: unknown[]) => unknown) | undefined {
  if ((typeof service !== 'object' && typeof service !== 'function') || service === null) return undefined
  try {
    const value = Reflect.get(service, name)
    return typeof value === 'function'
      ? (value as (...args: unknown[]) => unknown).bind(service)
      : undefined
  } catch {
    return undefined
  }
}

/** Read one data property off an unknown service object. */
function readProperty(service: unknown, name: string): unknown {
  if ((typeof service !== 'object' && typeof service !== 'function') || service === null) return undefined
  try {
    return Reflect.get(service, name)
  } catch {
    return undefined
  }
}

/** Concatenate already-read chunks and continue with the live iterator. */
async function* concatStream(
  chunks: readonly Uint8Array[],
  iterator: AsyncIterator<Uint8Array>,
): AsyncGenerator<Uint8Array> {
  for (const chunk of chunks) yield chunk
  for (;;) {
    const next = await iterator.next()
    if (next.done === true) return
    yield next.value
  }
}
