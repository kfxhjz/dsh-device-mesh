/**
 * Public-relay carrier: daemon = one v2 control socket plus one data socket per
 * controller; controller = one v2 client socket. The relay only forwards
 * opaque frames; liveness, reconciliation and reconnect semantics live here.
 *
 * The relay `serverId` is a bearer secret: it is appended to the URL only and
 * never logged or embedded in error messages.
 */

import { WebSocket } from 'ws'
import type { RawData } from 'ws'

import type {
  MeshTransport,
  RelayClientOptions,
  RelayDaemon,
  RelayDaemonOptions,
  TransportCloseInfo,
} from '../../shared/transport.ts'
import {
  abortError,
  delay,
  logDebug,
  logInfo,
  logWarn,
  MAX_WS_PAYLOAD_BYTES,
  openWebSocket,
  terminateQuietly,
  WebSocketMeshTransport,
} from './common.ts'
import type { TransportLogger } from './common.ts'

/** WS ping interval for control and data sockets. */
export const RELAY_HEARTBEAT_MS = 10_000
/** v2 control frames are capped at 64 KiB by the relay; keep headroom. */
const CONTROL_MAX_PAYLOAD = 128 * 1024
/** Default reconnect floor/ceiling from PROTOCOL.md §3.2 and the task. */
const DEFAULT_MIN_BACKOFF_MS = 1_000
const DEFAULT_MAX_BACKOFF_MS = 30_000
const DEFAULT_DATA_RETRY_LIMIT = 3

export interface RelayDaemonExtraOptions extends RelayDaemonOptions {
  /** WS ping interval in milliseconds; `0` disables it. Default 10_000. */
  readonly heartbeatMs?: number
  /** HTTP upgrade timeout; default 15_000. */
  readonly handshakeTimeoutMs?: number
  /** Reconnect jitter as a fraction of the delay; default 0.2. */
  readonly backoffJitter?: number
  readonly logger?: TransportLogger
}

export interface ConnectRelayClientOptions extends RelayClientOptions {
  readonly signal?: AbortSignal
  readonly handshakeTimeoutMs?: number
  readonly heartbeatMs?: number
  readonly logger?: TransportLogger
}

/** Callback invoked once per attached controller data socket (or once per v1 socket). */
export type RelayDaemonClientHandler = (transport: MeshTransport, connectionId: string) => void

/** Connection id reported for the single v1 daemon socket. */
export const RELAY_V1_CONNECTION_ID = 'v1'

/**
 * Build a relay `/ws` URL. `serverId` is a bearer secret, so validation errors
 * never echo it back. Duplicate query keys are avoided because the relay is
 * last-wins.
 */
export function buildRelayUrl(
  options: RelayClientOptions,
  role: 'server' | 'client',
  connectionId?: string,
): string {
  if (!/^wss?:\/\//i.test(options.url)) {
    throw new TypeError('relay URL must be a ws:// or wss:// URL')
  }
  const serverId = options.serverId
  if (
    serverId.length === 0 ||
    serverId.length > 256 ||
    /[\u0000-\u0020\u007f]/.test(serverId)
  ) {
    throw new TypeError('invalid relay serverId')
  }
  const url = new URL(options.url)
  if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
    throw new TypeError('relay URL must be a ws:// or wss:// URL')
  }
  url.searchParams.set('serverId', serverId)
  url.searchParams.set('role', role)
  url.searchParams.set('v', String(options.version))
  if (connectionId !== undefined) {
    url.searchParams.set('connectionId', connectionId)
  }
  return url.toString()
}

/**
 * Start the daemon side of a relay session. v2 (control+data) is preferred;
 * `version: 1` falls back to the single-socket v1 protocol with identical
 * reconnect semantics.
 *
 * `onClient` is an optional alternative to `daemon.onClient(...)`; both are
 * supported so the host broker can pick its preferred style.
 */
export function startRelayDaemon(
  options: RelayDaemonExtraOptions,
  onClient?: RelayDaemonClientHandler,
): RelayDaemon {
  const daemon =
    options.version === 1
      ? new RelayDaemonV1Impl(options)
      : new RelayDaemonV2Impl(options)
  if (onClient) daemon.onClient(onClient)
  daemon.start()
  return daemon
}

/** Explicit v1 fallback entry point; same object shape as the v2 daemon. */
export function startRelayDaemonV1(
  options: Omit<RelayDaemonExtraOptions, 'version'> & { readonly version?: 1 },
  onClient?: RelayDaemonClientHandler,
): RelayDaemon {
  return startRelayDaemon({ ...options, version: 1 }, onClient)
}

/**
 * Connect the controller side of a relay session. For v2 the relay attaches a
 * data route for this client; if no daemon data socket shows up within its
 * timeout the relay closes us with `1013` `Data route unavailable`, which
 * surfaces through `onClose`.
 */
export async function connectRelayClient(
  options: ConnectRelayClientOptions,
): Promise<MeshTransport> {
  const url = buildRelayUrl(options, 'client')
  const ws = await openWebSocket({
    url,
    handshakeTimeoutMs: options.handshakeTimeoutMs ?? 15_000,
    maxPayload: MAX_WS_PAYLOAD_BYTES,
    // The relay URL carries the bearer `serverId`; keep it out of error text.
    secret: options.serverId,
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.protocols ? { protocols: options.protocols } : {}),
    ...(options.logger ? { logger: options.logger } : {}),
  })
  if (options.signal?.aborted) {
    terminateQuietly(ws)
    throw abortError()
  }
  const relayHost = new URL(options.url).host
  return new WebSocketMeshTransport(ws, {
    kind: 'relay',
    remoteLabel: `relay:${relayHost}`,
    ...(options.logger ? { logger: options.logger } : {}),
    heartbeatMs: options.heartbeatMs ?? RELAY_HEARTBEAT_MS,
  })
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

interface Deferred<T> {
  readonly promise: Promise<T>
  resolve(value: T): void
  reject(error: Error): void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  // Callers may only consume `ready` after construction; avoid unhandled
  // rejections when the daemon is closed before the first sync.
  promise.catch(() => {})
  return { promise, resolve, reject }
}

function waitTransportClosed(transport: MeshTransport): Promise<void> {
  return new Promise<void>((resolve) => {
    let done = false
    const finish = (): void => {
      if (done) return
      done = true
      resolve()
    }
    transport.onClose(finish)
  })
}

function waitSocketClosed(ws: WebSocket): Promise<void> {
  if (ws.readyState === WebSocket.CLOSED) return Promise.resolve()
  return new Promise<void>((resolve) => {
    ws.once('close', () =>{  resolve() })
  })
}

function closeReason(reason: Buffer): string {
  return reason.toString('utf8')
}

abstract class RelayDaemonBase implements RelayDaemon {
  readonly ready: Promise<void>
  protected readonly options: RelayDaemonExtraOptions
  protected readonly logger: TransportLogger | undefined
  protected readonly heartbeatMs: number
  protected readonly handshakeTimeoutMs: number
  protected readonly minBackoffMs: number
  protected readonly maxBackoffMs: number
  protected readonly backoffJitter: number
  protected readonly readyDeferred = deferred<void>()
  protected readonly clientListeners = new Set<RelayDaemonClientHandler>()
  protected readonly disconnectListeners = new Set<(info: TransportCloseInfo) => void>()
  protected closed = false
  protected closePromise: Promise<void> | undefined
  protected reconnectTimer: NodeJS.Timeout | undefined
  protected backoffAttempt = 0

  constructor(options: RelayDaemonExtraOptions) {
    this.options = options
    this.logger = options.logger
    this.heartbeatMs = options.heartbeatMs ?? RELAY_HEARTBEAT_MS
    this.handshakeTimeoutMs = options.handshakeTimeoutMs ?? 15_000
    this.minBackoffMs = options.minBackoffMs ?? DEFAULT_MIN_BACKOFF_MS
    this.maxBackoffMs = Math.max(this.minBackoffMs, options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS)
    this.backoffJitter = Math.max(0, Math.min(1, options.backoffJitter ?? 0.2))
    this.ready = this.readyDeferred.promise
  }

  abstract start(): void
  abstract get connected(): boolean
  abstract close(): Promise<void>

  onClient(listener: RelayDaemonClientHandler): () => void {
    this.clientListeners.add(listener)
    return () => {
      this.clientListeners.delete(listener)
    }
  }

  onDisconnect(listener: (info: TransportCloseInfo) => void): () => void {
    this.disconnectListeners.add(listener)
    return () => {
      this.disconnectListeners.delete(listener)
    }
  }

  protected notifyClient(transport: MeshTransport, connectionId: string): void {
    for (const listener of [...this.clientListeners]) {
      try {
        listener(transport, connectionId)
      } catch (error) {
        logWarn(
          this.logger,
          `relay client handler threw: ${error instanceof Error ? error.name : 'unknown'}`,
        )
        transport.close(1011, 'accept handler failed')
      }
    }
  }

  protected notifyDisconnect(info: TransportCloseInfo): void {
    for (const listener of [...this.disconnectListeners]) {
      try {
        listener(info)
      } catch (error) {
        logWarn(
          this.logger,
          `relay disconnect handler threw: ${error instanceof Error ? error.name : 'unknown'}`,
        )
      }
    }
  }

  protected scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer) return
    const attempt = this.backoffAttempt
    this.backoffAttempt = Math.min(attempt + 1, 20)
    const base = Math.min(this.maxBackoffMs, this.minBackoffMs * 2 ** attempt)
    const jitter = base * this.backoffJitter * (Math.random() * 2 - 1)
    const delayMs = Math.max(1, Math.round(base + jitter))
    logInfo(this.logger, `relay reconnecting in ${delayMs}ms (attempt ${attempt + 1})`)
    const timer = setTimeout(() => {
      this.reconnectTimer = undefined
      if (!this.closed) this.start()
    }, delayMs)
    timer.unref?.()
    this.reconnectTimer = timer
  }

  protected resetBackoff(): void {
    this.backoffAttempt = 0
  }
}

// ---------------------------------------------------------------------------
// v2 daemon
// ---------------------------------------------------------------------------

class RelayDaemonV2Impl extends RelayDaemonBase {
  private control: WebSocket | undefined
  private stopControlHeartbeat: (() => void) | undefined
  private synced = false
  private hadControl = false
  private readonly dataTransports = new Map<string, WebSocketMeshTransport>()
  private readonly pendingData = new Map<string, WebSocket>()
  private readonly dataRetryTimers = new Map<string, NodeJS.Timeout>()
  private readonly dataRetryAttempts = new Map<string, number>()
  private readonly knownIds = new Set<string>()

  start(): void {
    if (this.closed || this.control || this.reconnectTimer) return
    let url: string
    try {
      url = buildRelayUrl({ ...this.options, version: 2 }, 'server')
    } catch (error) {
      logWarn(
        this.logger,
        `relay daemon refused to start: ${error instanceof Error ? error.message : 'invalid options'}`,
      )
      this.readyDeferred.reject(new Error('relay daemon has invalid options'))
      return
    }

    let ws: WebSocket
    try {
      ws = new WebSocket(url, undefined, {
        handshakeTimeout: this.handshakeTimeoutMs,
        maxPayload: CONTROL_MAX_PAYLOAD,
        perMessageDeflate: false,
      })
    } catch {
      this.scheduleReconnect()
      return
    }
    this.control = ws
    logDebug(this.logger, 'relay control socket dialing')

    ws.once('open', () => {
      if (this.control !== ws) return
      this.hadControl = true
      this.stopControlHeartbeat = startRelayHeartbeat(ws, this.heartbeatMs, this.logger)
      logDebug(this.logger, 'relay control socket open, waiting for sync')
    })
    ws.on('message', (data, isBinary) => {
      if (this.control !== ws) return
      this.handleControlMessage(data, isBinary)
    })
    ws.once('unexpected-response', (_request, response) => {
      logWarn(
        this.logger,
        `relay control upgrade rejected with HTTP ${response.statusCode ?? 0}`,
      )
      terminateQuietly(ws)
    })
    ws.on('error', () => {
      // The close event that follows carries the lifecycle decision.
      logDebug(this.logger, 'relay control socket error')
    })
    ws.once('close', (code, reason) => {
      if (this.control !== ws) return
      this.handleControlClose(code, closeReason(reason))
    })
  }

  get connected(): boolean {
    return this.synced && this.control?.readyState === WebSocket.OPEN
  }

  async close(): Promise<void> {
    if (this.closePromise) return this.closePromise
    this.closePromise = this.doClose()
    return this.closePromise
  }

  private async doClose(): Promise<void> {
    this.closed = true
    this.synced = false
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = undefined
    }
    for (const timer of this.dataRetryTimers.values()) clearTimeout(timer)
    this.dataRetryTimers.clear()
    for (const ws of this.pendingData.values()) safeTerminate(ws)
    this.pendingData.clear()

    const waiters: Promise<void>[] = []
    for (const transport of this.dataTransports.values()) {
      waiters.push(waitTransportClosed(transport))
      transport.close(1000, 'relay daemon closed')
    }
    this.dataTransports.clear()

    const control = this.control
    this.control = undefined
    this.stopControlHeartbeat?.()
    this.stopControlHeartbeat = undefined
    if (control) {
      waiters.push(waitSocketClosed(control))
      safeClose(control, 1000, 'daemon closed')
    }

    this.readyDeferred.reject(new Error('relay daemon closed before the first sync'))
    await Promise.race([Promise.all(waiters), delay(2_000)])
    if (control) safeTerminate(control)
  }

  private handleControlMessage(data: RawData, isBinary: boolean): void {
    if (isBinary) {
      logDebug(this.logger, 'relay control ignored a binary frame')
      return
    }
    let parsed: unknown
    try {
      const text = Array.isArray(data)
        ? Buffer.concat(data).toString()
        : data instanceof ArrayBuffer
          ? new TextDecoder().decode(data)
          : data.toString()
      parsed = JSON.parse(text)
    } catch {
      // Never log the frame: it is relay/user data, not a secret exactly, but
      // keeping payloads out of logs is a hard rule.
      logWarn(this.logger, 'relay control sent invalid JSON')
      return
    }
    if (parsed === null || typeof parsed !== 'object') return
    const record = parsed as { readonly type?: unknown; readonly connectionId?: unknown }
    switch (record.type) {
      case 'sync': {
        const rawIds = (parsed as { readonly connectionIds?: unknown }).connectionIds
        const ids = new Set<string>()
        if (Array.isArray(rawIds)) {
          for (const value of rawIds) {
            if (typeof value === 'string' && value.length > 0) ids.add(value)
          }
        }
        this.synced = true
        this.resetBackoff()
        this.readyDeferred.resolve()
        this.reconcile(ids)
        break
      }
      case 'connected': {
        if (typeof record.connectionId !== 'string' || record.connectionId.length === 0) return
        this.knownIds.add(record.connectionId)
        this.attachData(record.connectionId)
        break
      }
      case 'disconnected': {
        if (typeof record.connectionId !== 'string') return
        this.knownIds.delete(record.connectionId)
        this.cancelDataRetry(record.connectionId)
        const transport = this.dataTransports.get(record.connectionId)
        if (transport) {
          this.dataTransports.delete(record.connectionId)
          transport.close(1001, 'Client disconnected')
        }
        const pending = this.pendingData.get(record.connectionId)
        if (pending) {
          this.pendingData.delete(record.connectionId)
          safeTerminate(pending)
        }
        break
      }
      case 'ping': {
        this.sendControlJson({ type: 'pong', ts: Date.now() })
        break
      }
      default:
        logDebug(this.logger, `relay control ignored type ${String(record.type)}`)
    }
  }

  private reconcile(ids: ReadonlySet<string>): void {
    this.knownIds.clear()
    for (const id of ids) this.knownIds.add(id)

    for (const [id, transport] of [...this.dataTransports]) {
      if (!ids.has(id)) {
        this.dataTransports.delete(id)
        transport.close(1001, 'relay sync reconcile')
      }
    }
    for (const [id, ws] of [...this.pendingData]) {
      if (!ids.has(id)) {
        this.pendingData.delete(id)
        safeTerminate(ws)
      }
    }
    for (const id of [...this.dataRetryTimers.keys()]) {
      if (!ids.has(id)) this.cancelDataRetry(id)
    }
    for (const id of ids) this.attachData(id)
    logDebug(this.logger, `relay synced with ${ids.size} connection(s)`)
  }

  private attachData(connectionId: string): void {
    if (this.closed) return
    if (this.dataTransports.has(connectionId) || this.pendingData.has(connectionId)) return
    if (!this.controlOpen() || !this.knownIds.has(connectionId)) return

    let url: string
    try {
      url = buildRelayUrl({ ...this.options, version: 2 }, 'server', connectionId)
    } catch {
      logWarn(this.logger, 'relay data socket skipped: invalid relay options')
      return
    }

    let ws: WebSocket
    try {
      ws = new WebSocket(url, undefined, {
        handshakeTimeout: this.handshakeTimeoutMs,
        maxPayload: MAX_WS_PAYLOAD_BYTES,
        perMessageDeflate: false,
      })
    } catch {
      this.scheduleDataRetry(connectionId)
      return
    }
    this.pendingData.set(connectionId, ws)

    ws.once('open', () => {
      if (this.pendingData.get(connectionId) !== ws) {
        safeTerminate(ws)
        return
      }
      this.pendingData.delete(connectionId)
      if (this.closed || !this.controlOpen() || !this.knownIds.has(connectionId)) {
        safeClose(ws, 1000, 'route gone')
        return
      }
      const transport = new WebSocketMeshTransport(ws, {
        kind: 'relay',
        remoteLabel: this.remoteLabel,
        ...(this.logger ? { logger: this.logger } : {}),
        heartbeatMs: this.heartbeatMs,
        onClosed: () => {
          if (transport && this.dataTransports.get(connectionId) === transport) {
            this.dataTransports.delete(connectionId)
          }
        },
      })
      this.dataTransports.set(connectionId, transport)
      this.dataRetryAttempts.delete(connectionId)
      logDebug(this.logger, 'relay data socket attached')
      this.notifyClient(transport, connectionId)
    })
    ws.on('error', () => {
      logDebug(this.logger, 'relay data socket error')
    })
    ws.once('close', () => {
      if (this.pendingData.get(connectionId) === ws) {
        this.pendingData.delete(connectionId)
        this.scheduleDataRetry(connectionId)
      }
    })
  }

  private scheduleDataRetry(connectionId: string): void {
    if (this.closed || !this.synced || !this.knownIds.has(connectionId)) return
    if (this.dataRetryTimers.has(connectionId)) return
    const attempts = (this.dataRetryAttempts.get(connectionId) ?? 0) + 1
    if (attempts > DEFAULT_DATA_RETRY_LIMIT) {
      logWarn(this.logger, 'relay data socket failed repeatedly; waiting for the next sync')
      return
    }
    this.dataRetryAttempts.set(connectionId, attempts)
    const timer = setTimeout(() => {
      this.dataRetryTimers.delete(connectionId)
      if (this.closed || !this.synced || !this.knownIds.has(connectionId)) return
      this.attachData(connectionId)
    }, Math.min(1_000 * attempts, 5_000))
    timer.unref?.()
    this.dataRetryTimers.set(connectionId, timer)
  }

  private cancelDataRetry(connectionId: string): void {
    const timer = this.dataRetryTimers.get(connectionId)
    if (timer) {
      clearTimeout(timer)
      this.dataRetryTimers.delete(connectionId)
    }
    this.dataRetryAttempts.delete(connectionId)
  }

  private handleControlClose(code: number, reason: string): void {
    this.control = undefined
    this.stopControlHeartbeat?.()
    this.stopControlHeartbeat = undefined
    this.synced = false

    for (const timer of this.dataRetryTimers.values()) clearTimeout(timer)
    this.dataRetryTimers.clear()
    this.dataRetryAttempts.clear()
    for (const ws of this.pendingData.values()) safeTerminate(ws)
    this.pendingData.clear()
    for (const transport of this.dataTransports.values()) {
      transport.close(1012, 'relay control disconnected')
    }
    this.dataTransports.clear()

    const wasConnected = this.hadControl
    this.hadControl = false
    if (wasConnected) {
      logWarn(this.logger, 'relay control socket closed')
      this.notifyDisconnect({ code, reason, local: false })
    }
    this.scheduleReconnect()
  }

  private sendControlJson(payload: { readonly type: 'pong'; readonly ts: number }): void {
    const ws = this.control
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    try {
      ws.send(JSON.stringify(payload))
    } catch {
      logDebug(this.logger, 'relay control pong send failed')
    }
  }

  private controlOpen(): boolean {
    return this.control?.readyState === WebSocket.OPEN
  }

  private get remoteLabel(): string {
    try {
      return `relay:${new URL(this.options.url).host}`
    } catch {
      return 'relay'
    }
  }
}

// ---------------------------------------------------------------------------
// v2 daemon helper: heartbeat + safe socket operations
// ---------------------------------------------------------------------------

function startRelayHeartbeat(
  ws: WebSocket,
  intervalMs: number,
  logger: TransportLogger | undefined,
): () => void {
  if (!(intervalMs > 0)) return () => {}
  let alive = true
  let stopped = false
  const markAlive = (): void => {
    alive = true
  }
  const timer = setInterval(() => {
    if (stopped || ws.readyState !== WebSocket.OPEN) return
    if (!alive) {
      logWarn(logger, 'relay control heartbeat timed out')
      safeTerminate(ws)
      return
    }
    alive = false
    try {
      ws.ping()
    } catch {
      // Raced into CLOSING; the close handler owns the lifecycle.
    }
  }, intervalMs)
  timer.unref?.()
  ws.on('pong', markAlive)
  ws.on('message', markAlive)
  return (): void => {
    if (stopped) return
    stopped = true
    clearInterval(timer)
    ws.off('pong', markAlive)
    ws.off('message', markAlive)
  }
}

function safeClose(ws: WebSocket, code: number, reason: string): void {
  try {
    ws.close(code, reason)
  } catch {
    safeTerminate(ws)
  }
}

function safeTerminate(ws: WebSocket): void {
  terminateQuietly(ws)
}

// ---------------------------------------------------------------------------
// v1 daemon fallback: exactly one relay socket for the daemon role
// ---------------------------------------------------------------------------

class RelayDaemonV1Impl extends RelayDaemonBase {
  private socket: WebSocket | undefined
  private transport: WebSocketMeshTransport | undefined
  private hadSocket = false

  start(): void {
    if (this.closed || this.socket || this.reconnectTimer) return
    let url: string
    try {
      url = buildRelayUrl({ ...this.options, version: 1 }, 'server')
    } catch {
      logWarn(this.logger, 'relay v1 daemon refused to start: invalid relay options')
      this.readyDeferred.reject(new Error('relay daemon has invalid options'))
      return
    }

    let ws: WebSocket
    try {
      ws = new WebSocket(url, undefined, {
        handshakeTimeout: this.handshakeTimeoutMs,
        maxPayload: MAX_WS_PAYLOAD_BYTES,
        perMessageDeflate: false,
      })
    } catch {
      this.scheduleReconnect()
      return
    }
    this.socket = ws

    ws.once('open', () => {
      if (this.socket !== ws) return
      this.hadSocket = true
      this.resetBackoff()
      const transport = new WebSocketMeshTransport(ws, {
        kind: 'relay',
        remoteLabel: this.remoteLabel,
        ...(this.logger ? { logger: this.logger } : {}),
        heartbeatMs: this.heartbeatMs,
        onClosed: () => {
          if (this.transport === transport) this.transport = undefined
        },
      })
      this.transport = transport
      this.readyDeferred.resolve()
      logDebug(this.logger, 'relay v1 socket attached')
      this.notifyClient(transport, RELAY_V1_CONNECTION_ID)
    })
    ws.once('unexpected-response', (_request, response) => {
      logWarn(
        this.logger,
        `relay v1 upgrade rejected with HTTP ${response.statusCode ?? 0}`,
      )
      safeTerminate(ws)
    })
    ws.on('error', () => {
      logDebug(this.logger, 'relay v1 socket error')
    })
    ws.once('close', (code, reason) => {
      if (this.socket !== ws) return
      this.socket = undefined
      this.transport = undefined
      const wasConnected = this.hadSocket
      this.hadSocket = false
      if (wasConnected) {
        this.notifyDisconnect({ code, reason: closeReason(reason), local: false })
      }
      this.scheduleReconnect()
    })
  }

  get connected(): boolean {
    return this.socket?.readyState === WebSocket.OPEN
  }

  async close(): Promise<void> {
    if (this.closePromise) return this.closePromise
    this.closed = true
    this.closePromise = (async () => {
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer)
        this.reconnectTimer = undefined
      }
      const socket = this.socket
      this.socket = undefined
      const transport = this.transport
      this.transport = undefined
      const waiters: Promise<void>[] = []
      if (transport) {
        waiters.push(waitTransportClosed(transport))
        transport.close(1000, 'relay daemon closed')
      }
      if (socket) {
        waiters.push(waitSocketClosed(socket))
        safeClose(socket, 1000, 'daemon closed')
      }
      this.readyDeferred.reject(new Error('relay daemon closed before the first sync'))
      await Promise.race([Promise.all(waiters), delay(2_000)])
      if (socket) safeTerminate(socket)
    })()
    return this.closePromise
  }

  private get remoteLabel(): string {
    try {
      return `relay:${new URL(this.options.url).host}`
    } catch {
      return 'relay'
    }
  }
}
