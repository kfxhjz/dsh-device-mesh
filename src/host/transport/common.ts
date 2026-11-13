/**
 * Shared plumbing for the two Mesh carriers.
 *
 * Everything here is carrier-agnostic: logging (which must never see payloads
 * or routing secrets), close-code hygiene, heartbeat bookkeeping, and the
 * `MeshTransport` wrapper around a raw `ws` socket.
 */

import { WebSocket } from 'ws'
import type { RawData } from 'ws'

import { MAX_MESSAGE_BYTES } from '../../shared/protocol.ts'
import type { MeshTransport, TransportCloseInfo } from '../../shared/transport.ts'

/**
 * Overhead a sealed Mesh frame adds to its plaintext: one message-kind byte
 * plus the 16-byte Noise AEAD tag (`docs/PROTOCOL.md` §3).
 */
export const MESH_SEALED_FRAME_OVERHEAD_BYTES = 1 + 16

/**
 * Maximum WebSocket payload a Mesh peer may send. This is the protocol
 * `MAX_MESSAGE_BYTES` plaintext cap plus the sealing overhead, so a frame at
 * the plaintext boundary is never rejected with close code 1009.
 */
export const MAX_WS_PAYLOAD_BYTES = MAX_MESSAGE_BYTES + MESH_SEALED_FRAME_OVERHEAD_BYTES

/**
 * Minimal logging seam. The host plugin supplies its own logger; tests supply
 * a capturing one. Messages passed here are written by this module and never
 * contain payload bytes or `serverId` values.
 */
export interface TransportLogger {
  debug?(message: string): void
  info?(message: string): void
  warn?(message: string): void
  error?(message: string): void
}

export const silentLogger: TransportLogger = {}

export function logDebug(logger: TransportLogger | undefined, message: string): void {
  logger?.debug?.(message)
}

export function logWarn(logger: TransportLogger | undefined, message: string): void {
  logger?.warn?.(message)
}

export function logInfo(logger: TransportLogger | undefined, message: string): void {
  logger?.info?.(message)
}

/** Remove a bearer secret from a string before it can reach a log or an error. */
export function redactSecret(value: string, secret: string | undefined): string {
  if (!secret) return value
  const encoded = encodeURIComponent(secret)
  return value.split(secret).join('<redacted>').split(encoded).join('<redacted>')
}

/** WebSocket status codes that may legally appear in a close frame we send. */
export function isValidCloseCode(code: number): boolean {
  return (
    (code >= 1000 && code <= 1014 && code !== 1004 && code !== 1005 && code !== 1006) ||
    (code >= 3000 && code <= 4999)
  )
}

/**
 * Map an arbitrary requested code onto something `ws` will transmit. Reserved
 * application codes (`1005`/`1006`) and out-of-range values fall back to 1000.
 */
export function normalizeCloseCode(code: number | undefined): number {
  if (code === undefined) return 1000
  return isValidCloseCode(code) ? code : 1000
}

/** Close reasons are limited to 123 UTF-8 bytes by RFC 6455. */
export function truncateCloseReason(reason: string | undefined): string {
  if (!reason) return ''
  if (Buffer.byteLength(reason) <= 123) return reason
  let truncated = ''
  for (const char of reason) {
    if (Buffer.byteLength(truncated + char) > 123) break
    truncated += char
  }
  return truncated
}

export function toUint8Array(data: RawData): Uint8Array {
  if (Buffer.isBuffer(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
  }
  if (Array.isArray(data)) {
    return new Uint8Array(Buffer.concat(data))
  }
  return new Uint8Array(data)
}

export function abortError(): Error {
  const error = new Error('operation aborted')
  error.name = 'AbortError'
  return error
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
  })
}

/**
 * Send a WS ping every `intervalMs` and terminate the socket when a full
 * interval passes without any inbound traffic (a pong or any message).
 * Returns an idempotent stop function.
 */
export function startHeartbeat(
  ws: WebSocket,
  intervalMs: number,
  onDead: () => void,
): () => void {
  if (!(intervalMs > 0)) return () => {}
  let alive = true
  let stopped = false
  const markAlive = (): void => {
    alive = true
  }
  const timer = setInterval(() => {
    if (stopped) return
    if (ws.readyState !== WebSocket.OPEN) return
    if (!alive) {
      stop()
      onDead()
      return
    }
    alive = false
    try {
      ws.ping()
    } catch {
      // The socket raced us into CLOSING; the close handler will take over.
    }
  }, intervalMs)
  timer.unref?.()
  ws.on('pong', markAlive)
  ws.on('message', markAlive)
  const stop = (): void => {
    if (stopped) return
    stopped = true
    clearInterval(timer)
    ws.off('pong', markAlive)
    ws.off('message', markAlive)
  }
  return stop
}

export interface OpenWebSocketOptions {
  readonly url: string
  readonly protocols?: readonly string[]
  readonly headers?: Record<string, string>
  readonly handshakeTimeoutMs?: number
  readonly maxPayload?: number
  readonly signal?: AbortSignal
  /** Redacted from any error message built here (the relay `serverId`). */
  readonly secret?: string
  readonly logger?: TransportLogger
}

/**
 * Terminate a socket without ever letting the resulting `error` event become
 * uncaught. `ws` aborts a pending handshake by emitting `error` on the next
 * tick ("WebSocket was closed before the connection was established"), so a
 * listener must already be attached when `terminate()` runs. A socket that is
 * still CONNECTING has no owner yet; without this sink that event kills the
 * whole host process.
 */
export function terminateQuietly(ws: WebSocket): void {
  if (ws.listenerCount('error') === 0) ws.on('error', () => {})
  try {
    ws.terminate()
  } catch {
    // Already gone.
  }
}

/**
 * Open a client WebSocket and resolve once the handshake completed. Rejects on
 * transport error, non-101 HTTP status, abort, or handshake timeout. A sink
 * `error` listener stays attached for the socket's lifetime so an abandoned
 * handshake can never surface as an uncaught exception; the caller should
 * still attach its own listener for diagnostics.
 */
export function openWebSocket(options: OpenWebSocketOptions): Promise<WebSocket> {
  return new Promise<WebSocket>((resolve, reject) => {
    const { signal } = options
    if (signal?.aborted) {
      reject(abortError())
      return
    }

    let ws: WebSocket
    try {
      ws = new WebSocket(
        options.url,
        options.protocols ? [...options.protocols] : undefined,
        {
          handshakeTimeout: options.handshakeTimeoutMs ?? 10_000,
          maxPayload: options.maxPayload ?? MAX_WS_PAYLOAD_BYTES,
          perMessageDeflate: false,
          ...(options.headers ? { headers: options.headers } : {}),
        },
      )
    } catch (error) {
      reject(sanitizeConnectError(error, options.secret))
      return
    }

    let settled = false
    const cleanup = (): void => {
      ws.off('open', onOpen)
      ws.off('unexpected-response', onUnexpectedResponse)
      signal?.removeEventListener('abort', onAbort)
      // Keep `onError` attached: aborting a CONNECTING socket emits `error`
      // asynchronously, and an unhandled event here would take down the host.
    }
    const fail = (error: Error): void => {
      if (settled) return
      settled = true
      cleanup()
      terminateQuietly(ws)
      reject(error)
    }
    const onOpen = (): void => {
      if (settled) return
      settled = true
      cleanup()
      resolve(ws)
    }
    const onError = (error: Error): void => {
      if (settled) return
      fail(sanitizeConnectError(error, options.secret))
    }
    const onUnexpectedResponse = (
      _request: unknown,
      response: { statusCode?: number },
    ): void => {
      fail(
        new Error(
          redactSecret(
            `websocket upgrade rejected with HTTP ${response.statusCode ?? 0}`,
            options.secret,
          ),
        ),
      )
    }
    const onAbort = (): void => {
      fail(abortError())
    }

    ws.once('open', onOpen)
    ws.on('error', onError)
    ws.on('unexpected-response', onUnexpectedResponse)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

function sanitizeConnectError(error: unknown, secret: string | undefined): Error {
  const message = error instanceof Error ? error.message : String(error)
  return new Error(redactSecret(`websocket connect failed: ${message}`, secret))
}

export interface WebSocketMeshTransportOptions {
  readonly kind: 'direct' | 'relay'
  readonly remoteLabel: string
  readonly logger?: TransportLogger
  /** WS ping interval; `0` disables the heartbeat. Defaults are per carrier. */
  readonly heartbeatMs?: number
  /** Invoked exactly once after the underlying socket closed. */
  readonly onClosed?: () => void
}

const MAX_BUFFERED_INBOUND_BYTES = 4 * 64 * 1024

/**
 * A `MeshTransport` backed by one `ws` socket: one binary message in, one
 * binary message out, close metadata preserved on both directions.
 */
export class WebSocketMeshTransport implements MeshTransport {
  readonly kind: 'direct' | 'relay'
  readonly remoteLabel: string

  private readonly ws: WebSocket
  private readonly logger: TransportLogger | undefined
  private readonly onClosedCleanup: (() => void) | undefined
  private readonly messageListeners = new Set<(bytes: Uint8Array) => void>()
  private readonly closeListeners = new Set<(info: TransportCloseInfo) => void>()
  private readonly pendingMessages: Uint8Array[] = []
  private pendingBytes = 0
  private flushScheduled = false
  private closeInfo: TransportCloseInfo | undefined
  private requestedClose: { readonly code: number; readonly reason: string } | undefined
  private readonly stopHeartbeat: () => void

  constructor(ws: WebSocket, options: WebSocketMeshTransportOptions) {
    this.ws = ws
    this.kind = options.kind
    this.remoteLabel = options.remoteLabel
    this.logger = options.logger
    this.onClosedCleanup = options.onClosed

    ws.on('message', this.handleMessage)
    ws.on('close', this.handleClose)
    // A late transport error must never become an uncaught 'error' event.
    ws.on('error', this.handleError)
    this.stopHeartbeat = startHeartbeat(ws, options.heartbeatMs ?? 0, () => {
      logWarn(this.logger, `${this.kind} transport heartbeat timed out`)
      this.terminate()
    })

    if (ws.readyState === WebSocket.CLOSED) {
      this.handleClose(1006, Buffer.alloc(0))
    }
  }

  get bufferedAmount(): number {
    return this.ws.bufferedAmount
  }

  get closed(): boolean {
    return this.closeInfo !== undefined
  }

  send(bytes: Uint8Array): void {
    if (this.closeInfo) {
      throw new Error(`${this.kind} transport is closed`)
    }
    if (this.ws.readyState !== WebSocket.OPEN) {
      throw new Error(`${this.kind} transport is not open`)
    }
    this.ws.send(bytes, { binary: true }, (error) => {
      if (error) logWarn(this.logger, `${this.kind} transport send failed`)
    })
  }

  onMessage(listener: (bytes: Uint8Array) => void): () => void {
    this.messageListeners.add(listener)
    if (this.messageListeners.size === 1 && this.pendingMessages.length > 0) {
      // Flush outside the subscribe call: a listener that calls its own
      // unsubscribe function would otherwise observe it before assignment.
      // Ordering stays intact because inbound messages queue behind the
      // pending batch until the microtask runs.
      this.flushScheduled = true
      queueMicrotask(() => {
        if (!this.flushScheduled) return
        this.flushScheduled = false
        this.flushPending()
      })
    }
    return () => {
      this.messageListeners.delete(listener)
    }
  }

  onClose(listener: (info: TransportCloseInfo) => void): () => void {
    if (this.closeInfo) {
      const info = this.closeInfo
      queueMicrotask(() =>{  listener(info) })
      return () => {}
    }
    this.closeListeners.add(listener)
    return () => {
      this.closeListeners.delete(listener)
    }
  }

  close(code?: number, reason?: string): void {
    if (this.closeInfo) return
    const wireCode = normalizeCloseCode(code)
    const wireReason = truncateCloseReason(reason)
    this.requestedClose = { code: code ?? wireCode, reason: wireReason }
    if (this.ws.readyState === WebSocket.CONNECTING) {
      this.terminate()
      return
    }
    try {
      this.ws.close(wireCode, wireReason)
    } catch {
      this.terminate()
      return
    }
    // Do not let a peer that never answers the close handshake keep us alive.
    const timer = setTimeout(() => {
      if (!this.closeInfo) this.terminate()
    }, 2_000)
    timer.unref?.()
  }

  /** Drop the socket without a close handshake (heartbeat death, shutdown). */
  terminate(): void {
    terminateQuietly(this.ws)
  }

  private readonly handleMessage = (data: RawData, isBinary: boolean): void => {
    if (!isBinary) {
      logWarn(this.logger, `${this.kind} transport ignored a text frame`)
      return
    }
    const bytes = toUint8Array(data)
    if (this.messageListeners.size === 0 || this.flushScheduled) {
      if (this.pendingBytes + bytes.byteLength > MAX_BUFFERED_INBOUND_BYTES) {
        logWarn(this.logger, `${this.kind} transport inbound buffer overflow`)
        this.close(1009, 'inbound buffer overflow')
        return
      }
      this.pendingMessages.push(bytes)
      this.pendingBytes += bytes.byteLength
      return
    }
    this.deliver(bytes)
  }

  private flushPending(): void {
    // Everyone unsubscribed between the microtask being queued and running;
    // keep the batch for the next subscriber instead of dropping it.
    if (this.messageListeners.size === 0) return
    const queued = this.pendingMessages.splice(0)
    this.pendingBytes = 0
    for (const bytes of queued) this.deliver(bytes)
  }

  private deliver(bytes: Uint8Array): void {
    for (const listener of [...this.messageListeners]) {
      try {
        listener(bytes)
      } catch (error) {
        logWarn(
          this.logger,
          `${this.kind} transport message listener threw: ${
            error instanceof Error ? error.name : 'unknown'
          }`,
        )
      }
    }
  }

  private readonly handleError = (): void => {
    logWarn(this.logger, `${this.kind} transport socket error`)
  }

  private readonly handleClose = (code: number, reason: Buffer): void => {
    if (this.closeInfo) return
    this.stopHeartbeat()
    this.ws.off('message', this.handleMessage)
    this.ws.off('error', this.handleError)
    this.pendingMessages.length = 0
    this.pendingBytes = 0
    const requested = this.requestedClose
    this.closeInfo = requested
      ? { code: requested.code, reason: requested.reason, local: true }
      : { code, reason: reason.toString('utf8'), local: false }
    const info = this.closeInfo
    for (const listener of [...this.closeListeners]) {
      try {
        listener(info)
      } catch (error) {
        logWarn(
          this.logger,
          `${this.kind} transport close listener threw: ${
            error instanceof Error ? error.name : 'unknown'
          }`,
        )
      }
    }
    this.closeListeners.clear()
    this.onClosedCleanup?.()
  }
}
