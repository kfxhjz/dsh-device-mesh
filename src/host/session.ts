/**
 * Mesh session: RPC, events, application heartbeat and stream multiplexing on
 * top of an authenticated, encrypted channel (see `channel.ts`).
 *
 * Wire format (docs/PROTOCOL.md §4.4):
 *
 * ```
 * sealed plaintext = 0x10 || UTF-8 JSON            control: RPC / event / ping
 *                  | 0x11 || u32 streamId || u8 flags || payload   stream frame
 * ```
 *
 * Stream ids are allocated by the side that opens the stream: the controller
 * uses odd ids, the daemon even ids (v1 only the controller opens streams, so
 * every portal stream id is odd). A stream is bidirectional: the request body
 * travels controller→daemon and the response body daemon→controller on the
 * same id.
 *
 * This module never touches the transport or crypto directly; the channel
 * provides a `SessionBridge` whose `sendPlaintext` seals one message and whose
 * transport-close subscription finishes the session. That keeps the multiplexer
 * unit-testable without any Noise state.
 */

import {
  MAX_MESSAGE_BYTES,
  MAX_STREAM_CHUNK_BYTES,
  MessageKind,
  StreamFlag,
} from '../shared/protocol.ts'
import type {
  DeviceDescriptor,
  MeshErrorCode,
  MeshInfo,
  PortalHttpParams,
  PortalWsParams,
  RpcEvent,
} from '../shared/protocol.ts'
import { MeshRpcError } from '../shared/mesh-session.ts'
import type {
  ChunkStream,
  DaemonSessionHandlers,
  HttpExchangeResult,
  MeshSession,
  MeshSessionPairing,
  StreamSink,
  WsExchangeResult,
} from '../shared/mesh-session.ts'

// ---------------------------------------------------------------------------
// Close codes and error helpers
// ---------------------------------------------------------------------------

/** WebSocket close codes used by the Mesh channel (docs/PROTOCOL.md §4). */
export const MeshCloseCode = {
  /** Normal closure / session finished. */
  Normal: 1000,
  /** Malformed framing, unexpected handshake or control message. */
  ProtocolError: 4400,
  /** AEAD authentication failure (tamper / replay / reorder). */
  CryptoError: 4401,
  /** The peer is not authorized (unknown / revoked / bad signature). */
  Unauthorized: 4403,
  /** Application authentication did not finish in time. */
  Timeout: 4408,
} as const

/** Default per-RPC timeout. */
export const DEFAULT_RPC_TIMEOUT_MS = 30_000
/** Default maximum number of concurrently open streams per session. */
export const DEFAULT_MAX_CONCURRENT_STREAMS = 32
/** Default maximum bytes buffered for one inbound stream before it is aborted. */
export const DEFAULT_MAX_INBOUND_QUEUE_BYTES = 8 * 1024 * 1024
/** Default transport `bufferedAmount` above which writers wait. */
export const DEFAULT_BACKPRESSURE_HIGH_WATER = 1024 * 1024
/** Default cap on outstanding controller RPCs on the daemon side. */
export const DEFAULT_MAX_PENDING_RPC = 64
/** Default concurrency cap for daemon RPC handlers. */
export const DEFAULT_MAX_RPC_HANDLER_CONCURRENCY = 32

const STREAM_HEADER_BYTES = 6
const MAX_CONTROL_ERROR_MESSAGE = 500

/** Bridge implemented by `channel.ts`; the only way the session reaches the wire. */
export interface SessionBridge {
  readonly role: 'controller' | 'daemon'
  /** Peer descriptor authenticated by the channel. */
  readonly remote: DeviceDescriptor
  readonly sas: string | undefined
  /**
   * Pairing snapshot authenticated during the handshake. `requestId` is only
   * meaningful while the session is pending; {@link isPairingPending} decides
   * whether the pending state is still current.
   */
  readonly pairing: MeshSessionPairing | undefined
  /**
   * Live pairing state for a daemon session: returns `true` until the local
   * user approves (or denies) the first-contact request. Omitted on controller
   * sessions, whose pairing state is the authenticated snapshot.
   */
  readonly isPairingPending?: (() => boolean) | undefined
  /** Seal and send one plaintext session message. Throws when the channel is closed. */
  sendPlaintext(bytes: Uint8Array): void
  /** Subscribe to transport close; returns an unsubscribe function. */
  onTransportClose(listener: (info: { readonly code?: number; readonly reason?: string; readonly local?: boolean }) => void): () => void
  /** Close the underlying transport (idempotent). */
  closeTransport(code?: number, reason?: string): void
  /** Current transport buffered amount (bytes). */
  bufferedAmount(): number
}

export interface MeshSessionOptions {
  readonly info?: MeshInfo
  /** Handlers for a daemon session. Required for `role === 'daemon'`. */
  readonly handlers?: DaemonSessionHandlers
  /** Per-RPC timeout in milliseconds. */
  readonly rpcTimeoutMs?: number
  /** Maximum concurrently open streams (default 32). */
  readonly maxConcurrentStreams?: number
  /** Inbound per-stream buffer cap in bytes before the stream is aborted. */
  readonly maxInboundQueueBytes?: number
  /** Transport bufferedAmount level at which writers wait. */
  readonly backpressureHighWaterBytes?: number
  /** Maximum outstanding RPC requests accepted by a daemon (default 64). */
  readonly maxPendingRpc?: number
  /** Maximum concurrently executing RPC handlers on a daemon (default 32). */
  readonly maxRpcHandlerConcurrency?: number
  /**
   * Daemon-side authorization hook evaluated for every inbound RPC. Returns a
   * `MeshErrorCode` to reject the call (used to gate everything except
   * `pair.status` until a pairing request is approved).
   */
  readonly authorizeRpc?: (method: string) => MeshErrorCode | undefined
}

/** Daemon sessions can push events to the controller (`workspaces.changed`, …). */
export interface DaemonMeshSession extends MeshSession {
  /** Push an event to the controller. No-op after close. */
  emit(event: string, data?: unknown): void
}

interface RpcPending {
  readonly method: string
  readonly resolve: (value: unknown) => void
  readonly reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout> | null
  readonly signal?: AbortSignal | undefined
  onAbort?: (() => void) | undefined
}

interface PingPending {
  readonly resolve: (value: number) => void
  readonly reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout> | null
}

interface StreamRecord {
  readonly id: number
  readonly input: InputStream
  readonly abortController: AbortController
  readonly kind: 'http-request' | 'http-response' | 'ws'
  inboundDone: boolean
  outboundDone: boolean
  /** Set when the peer aborted or the exchange failed; suppresses further sends. */
  aborted: boolean
  readonly onInputCancel?: (() => void) | undefined
  readonly onPeerAbort?: ((code: string) => void) | undefined
  readonly onPeerEnd?: (() => void) | undefined
}

// ---------------------------------------------------------------------------
// Inbound chunk/message stream
// ---------------------------------------------------------------------------

interface InputStreamOptions {
  /** When true, received chunks are assembled into WebSocket messages. */
  readonly messageBoundaries: boolean
  readonly maxQueuedBytes: number
  readonly onOverflow: () => void
  readonly onCancel?: (() => void) | undefined
}

/**
 * Async iterable fed by the session demultiplexer. For `http` it yields raw
 * chunks; for `ws` it yields complete WebSocket messages (`messageBoundaries`).
 */
class InputStream implements ChunkStream {
  readonly messageBoundaries: boolean
  private readonly chunks: Uint8Array[] = []
  private readonly waiters: Array<() => void> = []
  private message: Uint8Array[] = []
  private messageBytes = 0
  private queuedBytes = 0
  private ended = false
  private failure: MeshRpcError | null = null
  private cancelled = false
  private readonly maxQueuedBytes: number
  private readonly onOverflow: () => void
  private readonly onCancel: (() => void) | undefined

  constructor(options: InputStreamOptions) {
    this.messageBoundaries = options.messageBoundaries
    this.maxQueuedBytes = options.maxQueuedBytes
    this.onOverflow = options.onOverflow
    this.onCancel = options.onCancel
  }

  /** Deliver one data chunk (a complete message when messageBoundaries is true). */
  push(chunk: Uint8Array, messageEnd = false): void {
    if (this.ended || this.failure) return
    if (this.messageBoundaries) {
      if (chunk.length > 0) {
        // A WebSocket message is assembled from many stream frames. Bound the
        // *accumulated* message, not just the completed-message queue: without
        // this a peer can stream an endless message and bypass the cap.
        if (this.messageBytes + chunk.length > this.maxQueuedBytes) {
          this.fail('mesh/busy', 'websocket message too large')
          this.onOverflow()
          return
        }
        this.message.push(chunk)
        this.messageBytes += chunk.length
      }
      if (messageEnd) {
        const whole = this.message.length === 1 && this.message[0] ? this.message[0] : concatChunks(this.message)
        this.message = []
        this.messageBytes = 0
        this.enqueue(whole)
      }
      return
    }
    this.enqueue(chunk)
  }

  /** Signal end of stream. */
  end(): void {
    if (this.ended || this.failure) return
    this.flushPartialMessage()
    this.ended = true
    this.wakeAll()
  }

  /** Abort the stream with a stable Mesh error code. */
  fail(code: string, message?: string): void {
    if (this.failure || this.ended) return
    this.failure = new MeshRpcError(code, message ?? code)
    this.flushPartialMessage()
    // The iterator throws on `failure` before looking at queued chunks, so drop
    // them (and their accounting) instead of retaining an aborted stream's data.
    this.chunks.length = 0
    this.queuedBytes = 0
    this.wakeAll()
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<Uint8Array> {
    try {
      for (;;) {
        if (this.failure) throw this.failure
        const next = this.chunks.shift()
        if (next !== undefined) {
          this.queuedBytes -= next.length
          yield next
          continue
        }
        if (this.ended) return
        await new Promise<void>((resolve) => {
          this.waiters.push(resolve)
        })
      }
    } finally {
      if (!this.ended && !this.cancelled && !this.failure) {
        this.cancelled = true
        this.onCancel?.()
      }
    }
  }

  private enqueue(chunk: Uint8Array): void {
    this.queuedBytes += chunk.length
    this.chunks.push(chunk)
    if (this.queuedBytes > this.maxQueuedBytes) {
      this.fail('mesh/busy', 'inbound stream buffer overflow')
      this.onOverflow()
      return
    }
    this.wakeAll()
  }

  private flushPartialMessage(): void {
    if (this.messageBytes > 0) {
      this.message = []
      this.messageBytes = 0
    }
  }

  private wakeAll(): void {
    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift()
      waiter?.()
    }
  }
}

function concatChunks(chunks: readonly Uint8Array[]): Uint8Array {
  if (chunks.length === 0) return new Uint8Array(0)
  if (chunks.length === 1) return chunks[0] ?? new Uint8Array(0)
  let total = 0
  for (const chunk of chunks) total += chunk.length
  const result = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    result.set(chunk, offset)
    offset += chunk.length
  }
  return result
}

// ---------------------------------------------------------------------------
// Outbound stream sink
// ---------------------------------------------------------------------------

class OutboundStream implements StreamSink {
  private chain: Promise<void> = Promise.resolve()
  private readonly session: MeshSessionImpl
  private readonly streamId: number

  constructor(session: MeshSessionImpl, streamId: number) {
    this.session = session
    this.streamId = streamId
  }

  write(chunk: Uint8Array): Promise<void> {
    return this.enqueue(async () => {
      await this.session.writeStreamChunk(this.streamId, chunk)
    })
  }

  end(): Promise<void> {
    return this.enqueue(async () => {
      await this.session.endStream(this.streamId)
    })
  }

  abort(code: string): Promise<void> {
    return this.enqueue(async () => {
      await this.session.abortStream(this.streamId, code)
    })
  }

  /** One complete WebSocket message (WS exchange only). */
  sendMessage(message: Uint8Array): Promise<void> {
    return this.enqueue(async () => {
      await this.session.writeStreamMessage(this.streamId, message)
    })
  }

  /** One complete WebSocket message: alias used by both sides' sink. */
  writeMessage(message: Uint8Array): Promise<void> {
    return this.sendMessage(message)
  }

  /** Close the remote WebSocket with an optional close code/reason. */
  close(code?: number, reason?: string): Promise<void> {
    return this.enqueue(async () => {
      await this.session.endStream(this.streamId, encodeWsClose(code, reason))
    })
  }

  private enqueue(task: () => Promise<void>): Promise<void> {
    const run = this.chain.then(task, task)
    this.chain = run.catch(() => {
      // Keep the chain alive after failures; the error is surfaced to the caller.
    })
    return run
  }
}

function encodeWsClose(code?: number, reason?: string): Uint8Array {
  if (code === undefined && reason === undefined) return new Uint8Array(0)
  return new TextEncoder().encode(JSON.stringify({ code: code ?? 1000, reason: sanitizeText(reason ?? '') }))
}

// ---------------------------------------------------------------------------
// Frame helpers
// ---------------------------------------------------------------------------

function encodeStreamFrame(streamId: number, flags: number, payload: Uint8Array): Uint8Array {
  const frame = new Uint8Array(STREAM_HEADER_BYTES + payload.length)
  frame[0] = MessageKind.Stream
  const view = new DataView(frame.buffer)
  view.setUint32(1, streamId)
  frame[5] = flags
  frame.set(payload, STREAM_HEADER_BYTES)
  return frame
}

function encodeControlJson(value: unknown): Uint8Array {
  const json = JSON.stringify(value)
  if (typeof json !== 'string') throw new MeshRpcError('mesh/internal', 'control message is not JSON serializable')
  const body = new TextEncoder().encode(json)
  const out = new Uint8Array(1 + body.length)
  out[0] = MessageKind.Control
  out.set(body, 1)
  return out
}

function sanitizeText(value: string, limit = MAX_CONTROL_ERROR_MESSAGE): string {
  const cleaned = value.replace(/[\u0000-\u001f\u007f]+/gu, ' ')
  return cleaned.length > limit ? `${cleaned.slice(0, limit)}…` : cleaned
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isRpcId(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= 0x7fffffff
}

function meshFailure(error: unknown): { readonly code: string; readonly message: string } {
  if (error instanceof MeshRpcError) {
    return { code: error.code, message: sanitizeText(error.message) }
  }
  if (isPlainObject(error) && typeof error.code === 'string' && /^[a-z][a-z0-9-]*\/[a-z0-9-]+$/u.test(error.code)) {
    const message = typeof error.message === 'string' ? error.message : error.code
    return { code: error.code, message: sanitizeText(message) }
  }
  return { code: 'mesh/internal', message: 'internal error' }
}

function errorCodeOf(error: unknown): string {
  return meshFailure(error).code
}

// ---------------------------------------------------------------------------
// Session implementation
// ---------------------------------------------------------------------------

export class MeshSessionImpl implements DaemonMeshSession {
  readonly role: 'controller' | 'daemon'
  readonly remote: DeviceDescriptor
  readonly sas: string | undefined

  private readonly bridge: SessionBridge
  private readonly pairingSnapshot: MeshSessionPairing | undefined
  private readonly isPairingPending: (() => boolean) | undefined
  private readonly handlers: DaemonSessionHandlers | undefined
  private readonly rpcTimeoutMs: number
  private readonly maxConcurrentStreams: number
  private readonly maxInboundQueueBytes: number
  private readonly backpressureHighWaterBytes: number
  private readonly maxPendingRpc: number
  private readonly maxRpcHandlerConcurrency: number
  private readonly authorizeRpc: ((method: string) => MeshErrorCode | undefined) | undefined
  private readonly unsubscribeTransportClose: () => void

  private openState = true
  private infoValue: MeshInfo | undefined
  private readonly closedPromise: Promise<void>
  private resolveClosed!: () => void
  private readonly eventListeners = new Set<(event: RpcEvent) => void>()

  private nextRpcId = 1
  private readonly pendingRpcs = new Map<number, RpcPending>()
  private nextPingId = 1
  private readonly pendingPings = new Map<number, PingPending>()

  private nextStreamId: number
  private readonly streams = new Map<number, StreamRecord>()
  private readonly sessionAbort = new AbortController()
  private pendingRpcHandlers = 0
  private pendingInboundRpc = 0

  constructor(bridge: SessionBridge, options: MeshSessionOptions = {}) {
    this.role = bridge.role
    this.remote = bridge.remote
    this.sas = bridge.sas
    this.pairingSnapshot = bridge.pairing
    this.isPairingPending = bridge.isPairingPending
    this.bridge = bridge
    this.handlers = options.handlers
    this.rpcTimeoutMs = options.rpcTimeoutMs ?? DEFAULT_RPC_TIMEOUT_MS
    this.maxConcurrentStreams = options.maxConcurrentStreams ?? DEFAULT_MAX_CONCURRENT_STREAMS
    this.maxInboundQueueBytes = options.maxInboundQueueBytes ?? DEFAULT_MAX_INBOUND_QUEUE_BYTES
    this.backpressureHighWaterBytes = options.backpressureHighWaterBytes ?? DEFAULT_BACKPRESSURE_HIGH_WATER
    this.maxPendingRpc = options.maxPendingRpc ?? DEFAULT_MAX_PENDING_RPC
    this.maxRpcHandlerConcurrency = options.maxRpcHandlerConcurrency ?? DEFAULT_MAX_RPC_HANDLER_CONCURRENCY
    this.authorizeRpc = options.authorizeRpc
    this.infoValue = options.info
    this.nextStreamId = this.role === 'controller' ? 1 : 2
    this.closedPromise = new Promise<void>((resolve) => {
      this.resolveClosed = resolve
    })
    this.unsubscribeTransportClose = bridge.onTransportClose(() => {
      this.finish(MeshCloseCode.Normal, 'transport closed', false)
    })
  }

  // -- MeshSession surface --------------------------------------------------

  get info(): MeshInfo | undefined {
    return this.infoValue
  }

  /**
   * Pairing state of this session.
   *
   * Daemon sessions report it live: once the local user approves the request,
   * `isPairingPending()` flips and this getter reports `{ approval: 'none' }`
   * instead of the stale handshake snapshot. Controller sessions (and test
   * bridges without a live predicate) keep the authenticated snapshot.
   */
  get pairing(): MeshSessionPairing | undefined {
    if (this.isPairingPending === undefined) return this.pairingSnapshot
    if (!this.isPairingPending()) return { approval: 'none' }
    const requestId = this.pairingSnapshot?.requestId
    return requestId === undefined ? { approval: 'pending' } : { approval: 'pending', requestId }
  }

  get open(): boolean {
    return this.openState
  }

  get closed(): Promise<void> {
    return this.closedPromise
  }

  rpc<T = unknown>(method: string, params?: unknown, options: { readonly signal?: AbortSignal } = {}): Promise<T> {
    if (this.role !== 'controller') {
      return Promise.reject(new MeshRpcError('mesh/unsupported', 'daemon sessions cannot call RPC methods'))
    }
    if (!this.openState) return Promise.reject(new MeshRpcError('mesh/internal', 'session closed'))
    if (typeof method !== 'string' || method.length === 0 || method.length > 128) {
      return Promise.reject(new MeshRpcError('mesh/bad-request', 'invalid RPC method'))
    }
    if (options.signal?.aborted) {
      return Promise.reject(new MeshRpcError('mesh/internal', 'request aborted'))
    }
    const id = this.nextRpcId
    this.nextRpcId = this.nextRpcId >= 0x7fffffff ? 1 : this.nextRpcId + 1
    return new Promise<T>((resolve, reject) => {
      const settleReject = (error: Error): void => {
        this.clearRpcPending(id)
        reject(error)
      }
      const pending: RpcPending = {
        method,
        resolve: (value) => {
          this.clearRpcPending(id)
          if (method === 'info') this.rememberInfo(value)
          resolve(value as T)
        },
        reject: settleReject,
        timer: setTimeout(() => {
          this.clearRpcPending(id)
          reject(new MeshRpcError('mesh/internal', 'RPC timed out'))
        }, this.rpcTimeoutMs),
        signal: options.signal,
        onAbort: undefined,
      }
      if (options.signal) {
        const onAbort = (): void => {
          this.pendingRpcs.delete(id)
          this.clearTimer(pending)
          reject(new MeshRpcError('mesh/internal', 'request aborted'))
        }
        pending.onAbort = onAbort
        options.signal.addEventListener('abort', onAbort, { once: true })
      }
      this.pendingRpcs.set(id, pending)
      try {
        this.sendControl({ id, method, ...(params === undefined ? {} : { params }) })
      } catch (error) {
        this.clearRpcPending(id)
        reject(error instanceof MeshRpcError ? error : new MeshRpcError('mesh/internal', 'send failed'))
      }
    })
  }

  onEvent(listener: (event: RpcEvent) => void): () => void {
    this.eventListeners.add(listener)
    return () => {
      this.eventListeners.delete(listener)
    }
  }

  async http(params: Omit<PortalHttpParams, 'streamId'>, body?: ChunkStream): Promise<HttpExchangeResult> {
    if (this.role !== 'controller') throw new MeshRpcError('mesh/unsupported', 'only controllers open portal streams')
    this.assertOpen()
    this.assertStreamCapacity()
    const streamId = this.allocateStreamId()
    const input = this.createInput(streamId, false)
    const record = this.registerStream(streamId, input, 'http-response', {
      onInputCancel: () => {
        void this.abortStream(streamId, 'portal/upstream-error').catch(() => {})
      },
    })
    try {
      // The RPC request frame must go out before the body stream frames, but
      // the body pump must not wait for the response headers: the daemon's
      // handler may consume the request body before replying (§6.2 step 2).
      const resultPromise = this.rpc<{ streamId: number; status: number; headers: Record<string, string> }>(
        'portal.http',
        {
          streamId,
          method: params.method,
          path: params.path,
          headers: params.headers,
        },
      )
      if (body) {
        void this.pumpRequestBody(streamId, body, record)
      } else {
        void this.endStreamSafe(streamId)
      }
      const result = await resultPromise
      if (!isPlainObject(result) || typeof result.status !== 'number' || !isPlainObject(result.headers)) {
        throw new MeshRpcError('mesh/bad-request', 'invalid portal.http result')
      }
      return {
        streamId,
        status: result.status,
        headers: normalizeHeaders(result.headers),
        body: input,
      }
    } catch (error) {
      const code = errorCodeOf(error)
      // The RPC failed (`mesh/busy`, `portal/unavailable`, closed, …): stop the
      // concurrent body pump instead of streaming the whole browser body to a
      // stream that is already gone (M14).
      record.aborted = true
      this.removeStream(streamId)
      input.fail(code, error instanceof Error ? error.message : undefined)
      void this.sendAbortFrame(streamId, code)
      throw error
    }
  }

  async ws(params: Omit<PortalWsParams, 'streamId'>): Promise<WsExchangeResult> {
    if (this.role !== 'controller') throw new MeshRpcError('mesh/unsupported', 'only controllers open portal streams')
    this.assertOpen()
    this.assertStreamCapacity()
    const streamId = this.allocateStreamId()
    const input = this.createInput(streamId, true)
    this.registerStream(streamId, input, 'ws', {
      onInputCancel: () => {
        void this.abortStream(streamId, 'portal/upstream-error').catch(() => {})
      },
    })
    try {
      const result = await this.rpc<{ streamId: number; protocol?: string }>('portal.ws.open', {
        streamId,
        path: params.path,
        headers: params.headers,
        ...(params.protocols === undefined ? {} : { protocols: params.protocols }),
      })
      if (!isPlainObject(result) || result.streamId !== streamId) {
        throw new MeshRpcError('mesh/bad-request', 'invalid portal.ws.open result')
      }
      const sink = new OutboundStream(this, streamId) as OutboundStream & {
        sendMessage(message: Uint8Array): Promise<void>
        close(code?: number, reason?: string): Promise<void>
      }
      const protocol = typeof result.protocol === 'string' ? result.protocol : undefined
      return {
        ...(protocol === undefined ? {} : { protocol }),
        messages: input as ChunkStream & { readonly messageBoundaries: true },
        sink,
      }
    } catch (error) {
      this.removeStream(streamId)
      input.fail(errorCodeOf(error), error instanceof Error ? error.message : undefined)
      throw error
    }
  }

  ping(timeoutMs = 10_000): Promise<number> {
    if (!this.openState) return Promise.reject(new MeshRpcError('mesh/internal', 'session closed'))
    const id = this.nextPingId
    this.nextPingId = this.nextPingId >= 0x7fffffff ? 1 : this.nextPingId + 1
    return new Promise<number>((resolve, reject) => {
      const pending: PingPending = {
        resolve: (value) => {
          this.clearPingPending(id)
          resolve(value)
        },
        reject: (error) => {
          this.clearPingPending(id)
          reject(error)
        },
        timer: setTimeout(() => {
          this.pendingPings.delete(id)
          reject(new MeshRpcError('mesh/internal', 'ping timed out'))
        }, timeoutMs),
      }
      this.pendingPings.set(id, pending)
      try {
        this.sendControl({ ping: id })
      } catch (error) {
        this.clearPingPending(id)
        reject(error instanceof MeshRpcError ? error : new MeshRpcError('mesh/internal', 'send failed'))
      }
    })
  }

  close(): void {
    this.finish(MeshCloseCode.Normal, 'session closed', true)
  }

  /** Daemon-only: push an event to the controller. */
  emit(event: string, data?: unknown): void {
    if (this.role !== 'daemon') return
    if (!this.openState) return
    if (typeof event !== 'string' || event.length === 0 || event.length > 128) return
    try {
      this.sendControl({ event, ...(data === undefined ? {} : { data }) })
    } catch {
      // A closed/failed session must not throw into the caller's event loop.
    }
  }

  // -- Inbound dispatch (called by channel.ts) ------------------------------

  /** Handle one decrypted session message. Framing errors close the session. */
  handlePlaintext(bytes: Uint8Array): void {
    if (!this.openState) return
    if (bytes.length === 0) {
      this.protocolViolation('empty session message')
      return
    }
    const kind = bytes[0]
    try {
      if (kind === MessageKind.Control) {
        this.handleControlBytes(bytes.subarray(1))
        return
      }
      if (kind === MessageKind.Stream) {
        this.handleStreamBytes(bytes)
        return
      }
      this.protocolViolation('unknown session message type')
    } catch (error) {
      // Never let a malformed frame/handler crash the transport read loop.
      if (error instanceof MeshRpcError && error.code === 'mesh/bad-request') {
        this.protocolViolation(error.message)
      } else {
        this.finish(MeshCloseCode.ProtocolError, 'mesh/bad-request', true)
      }
    }
  }

  // -- Control messages -----------------------------------------------------

  private handleControlBytes(body: Uint8Array): void {
    let parsed: unknown
    try {
      parsed = JSON.parse(new TextDecoder().decode(body))
    } catch {
      this.protocolViolation('invalid control JSON')
      return
    }
    if (!isPlainObject(parsed)) {
      this.protocolViolation('control message must be an object')
      return
    }
    const message = parsed
    if (typeof message.ping === 'number' && Number.isFinite(message.ping)) {
      this.replyPong(message.ping)
      return
    }
    if (typeof message.pong === 'number' && Number.isFinite(message.pong)) {
      this.resolvePong(message.pong)
      return
    }
    if (typeof message.event === 'string') {
      if (this.role === 'controller') this.dispatchEvent({ event: message.event, data: message.data })
      return
    }
    if (typeof message.method === 'string') {
      this.handleRpcRequest(message)
      return
    }
    if ((typeof message.result !== 'undefined' || typeof message.error !== 'undefined') && typeof message.id === 'number') {
      this.handleRpcResponse(message)
      return
    }
    this.protocolViolation('unrecognized control message')
  }

  private dispatchEvent(event: RpcEvent): void {
    for (const listener of [...this.eventListeners]) {
      try {
        listener(event)
      } catch {
        // Listeners are isolated: one broken subscriber must not kill the session.
      }
    }
  }

  private replyPong(value: number): void {
    try {
      this.sendControl({ pong: value })
    } catch {
      // transport already gone
    }
  }

  private resolvePong(value: number): void {
    const pending = this.pendingPings.get(value)
    if (pending) pending.resolve(value)
  }

  private handleRpcResponse(message: Record<string, unknown>): void {
    if (this.role !== 'controller') return
    const id = message.id
    if (!isRpcId(id)) return
    const pending = this.pendingRpcs.get(id)
    if (!pending) return
    if (typeof message.error === 'object' && message.error !== null) {
      const errorRecord = message.error as Record<string, unknown>
      const code = typeof errorRecord.code === 'string' ? errorRecord.code : 'mesh/internal'
      const text = typeof errorRecord.message === 'string' ? errorRecord.message : code
      pending.reject(new MeshRpcError(code, sanitizeText(text)))
      return
    }
    pending.resolve(message.result)
  }

  private handleRpcRequest(message: Record<string, unknown>): void {
    if (this.role !== 'daemon') return
    const id = message.id
    const method = message.method
    if (!isRpcId(id) || typeof method !== 'string' || method.length === 0 || method.length > 128) {
      this.protocolViolation('invalid RPC request')
      return
    }
    if (this.pendingInboundRpc >= this.maxPendingRpc) {
      this.sendFailure(id, 'mesh/busy', 'too many pending requests')
      return
    }
    const params = message.params
    this.pendingInboundRpc += 1
    void this.dispatchRpcRequest(id, method, params).finally(() => {
      this.pendingInboundRpc -= 1
    })
  }

  private async dispatchRpcRequest(id: number, method: string, params: unknown): Promise<void> {
    const unauthorized = this.authorizeRpc?.(method)
    if (unauthorized !== undefined) {
      this.sendFailure(id, unauthorized, 'not authorized yet')
      return
    }
    if (method === 'portal.http') {
      await this.handlePortalHttp(id, params)
      return
    }
    if (method === 'portal.ws.open') {
      await this.handlePortalWs(id, params)
      return
    }
    const handlers = this.handlers
    if (!handlers) {
      this.sendFailure(id, 'mesh/unsupported', 'no handlers registered')
      return
    }
    if (this.pendingRpcHandlers >= this.maxRpcHandlerConcurrency) {
      this.sendFailure(id, 'mesh/busy', 'too many concurrent handlers')
      return
    }
    this.pendingRpcHandlers += 1
    try {
      const result = await handlers.rpc(method, params, this.sessionAbort.signal)
      this.sendSuccess(id, result)
    } catch (error) {
      const failure = meshFailure(error)
      this.sendFailure(id, failure.code, failure.message)
    } finally {
      this.pendingRpcHandlers -= 1
    }
  }

  // -- Portal HTTP ----------------------------------------------------------

  private async handlePortalHttp(id: number, params: unknown): Promise<void> {
    const parsed = parsePortalHttpParams(params)
    if (!parsed) {
      this.sendFailure(id, 'mesh/bad-request', 'invalid portal.http parameters')
      return
    }
    const handlers = this.handlers
    if (!handlers) {
      this.sendFailure(id, 'mesh/unsupported', 'no handlers registered')
      return
    }
    if (this.streams.size >= this.maxConcurrentStreams) {
      this.sendFailure(id, 'mesh/busy', 'too many concurrent streams')
      return
    }
    if (this.streams.has(parsed.streamId)) {
      this.sendFailure(id, 'mesh/bad-request', 'duplicate stream id')
      return
    }
    const streamId = parsed.streamId
    const input = this.createInput(streamId, false)
    this.registerStream(streamId, input, 'http-request')
    const record = this.streams.get(streamId)
    try {
      const response = await handlers.http(
        { method: parsed.method, path: parsed.path, headers: parsed.headers },
        input,
        record?.abortController.signal ?? this.sessionAbort.signal,
      )
      if (!this.sendSuccess(id, { streamId, status: response.status, headers: response.headers })) {
        // The headers could not be delivered (closed session / oversize result):
        // do not start streaming a response nobody will consume.
        this.failPortalStream(streamId, 'mesh/busy')
        return
      }
      void this.pumpHttpResponse(streamId, response.body)
    } catch (error) {
      const failure = meshFailure(error)
      this.sendFailure(id, failure.code, failure.message)
      this.failPortalStream(streamId, failure.code)
    }
  }

  private async pumpHttpResponse(streamId: number, body: ChunkStream): Promise<void> {
    try {
      for await (const chunk of body) {
        // The controller may have cancelled the exchange meanwhile; stop
        // producing response frames for a stream nobody owns any more.
        if (!this.streams.has(streamId)) return
        await this.writeStreamChunk(streamId, chunk)
      }
      if (!this.streams.has(streamId)) return
      await this.endStream(streamId)
    } catch (error) {
      const code = errorCodeOf(error)
      await this.sendAbortFrame(streamId, code)
      this.removeStream(streamId)
    }
  }

  private async pumpRequestBody(streamId: number, body: ChunkStream, record: StreamRecord): Promise<void> {
    const iterator = body[Symbol.asyncIterator]()
    try {
      for (;;) {
        // Stop consuming the browser body as soon as the exchange is gone: a
        // failed RPC (H1/M14), a peer abort or a closed session must not keep
        // reading and sending a multi-megabyte upload.
        if (record.aborted || !this.openState) {
          await this.cancelBody(iterator)
          return
        }
        const next = await iterator.next()
        if (next.done === true) break
        if (record.aborted || !this.openState) {
          await this.cancelBody(iterator)
          return
        }
        await this.writeStreamChunk(streamId, next.value)
      }
      await this.endStream(streamId)
    } catch (error) {
      const code = errorCodeOf(error)
      await this.sendAbortFrame(streamId, code)
      record.aborted = true
      this.removeStream(streamId)
      await this.cancelBody(iterator)
    }
  }

  /** Release a request-body iterator without surfacing its teardown error. */
  private async cancelBody(iterator: AsyncIterator<Uint8Array>): Promise<void> {
    try {
      await iterator.return?.(undefined)
    } catch {
      // The body source may already be destroyed.
    }
  }

  // -- Portal WebSocket -----------------------------------------------------

  private async handlePortalWs(id: number, params: unknown): Promise<void> {
    const parsed = parsePortalWsParams(params)
    if (!parsed) {
      this.sendFailure(id, 'mesh/bad-request', 'invalid portal.ws.open parameters')
      return
    }
    const handlers = this.handlers
    if (!handlers) {
      this.sendFailure(id, 'mesh/unsupported', 'no handlers registered')
      return
    }
    if (this.streams.size >= this.maxConcurrentStreams) {
      this.sendFailure(id, 'mesh/busy', 'too many concurrent streams')
      return
    }
    if (this.streams.has(parsed.streamId)) {
      this.sendFailure(id, 'mesh/bad-request', 'duplicate stream id')
      return
    }
    const streamId = parsed.streamId
    const input = this.createInput(streamId, true)
    this.registerStream(streamId, input, 'ws')
    const record = this.streams.get(streamId)
    try {
      const exchange = await handlers.ws(
        {
          path: parsed.path,
          headers: parsed.headers,
          ...(parsed.protocols === undefined ? {} : { protocols: parsed.protocols }),
        },
        record?.abortController.signal ?? this.sessionAbort.signal,
      )
      if (!this.sendSuccess(id, { streamId, ...(exchange.protocol === undefined ? {} : { protocol: exchange.protocol }) })) {
        // Nothing will consume the WebSocket exchange; abort it so the handler's
        // upstream socket is closed instead of leaking (M2/M3).
        this.failPortalStream(streamId, 'mesh/busy')
        return
      }
      this.pumpDuplexWs(streamId, input, exchange.inbound, exchange.outbound, record)
    } catch (error) {
      const failure = meshFailure(error)
      this.sendFailure(id, failure.code, failure.message)
      this.failPortalStream(streamId, failure.code)
    }
  }

  private pumpDuplexWs(
    streamId: number,
    input: InputStream,
    inbound: ChunkStream,
    outbound: StreamSink,
    record: StreamRecord | undefined,
  ): void {
    const exchangeAbort = new AbortController()
    let remaining = 2
    /** Exactly one terminal frame may reach the peer; the first one wins. */
    let terminal: 'end' | 'abort' | undefined
    const sendTerminal = async (mode: 'end' | 'abort', code?: string): Promise<void> => {
      if (terminal !== undefined) return
      terminal = mode
      try {
        if (mode === 'end') await this.endStream(streamId)
        else await this.sendAbortFrame(streamId, code ?? 'mesh/internal')
      } catch {
        // A closed session cannot deliver the terminal frame; the transport
        // close already tears down the peer's stream.
      }
    }
    const settle = (): void => {
      remaining -= 1
      // One direction finished/aborted: stop the other via the handler signal.
      exchangeAbort.abort()
      record?.abortController.abort()
      if (remaining > 0) return
      // Both directions are done. A graceful browser close must still release
      // the peer's stream record, so send a terminal frame when the sibling
      // direction could not (e.g. the upstream socket never emitted End).
      if (terminal === undefined && record?.aborted !== true) void sendTerminal('end')
      this.removeStream(streamId)
    }

    const controllerToLocal = async (): Promise<void> => {
      try {
        for await (const message of input) {
          if (exchangeAbort.signal.aborted) break
          await outbound.write(message)
        }
        // The peer ended its half; close the local socket and acknowledge with
        // End immediately. Waiting for a possibly-stuck upstream socket would
        // leave the peer's stream record alive, and the peer is closing anyway.
        if (!exchangeAbort.signal.aborted) {
          await outbound.end()
          await sendTerminal('end')
        }
      } catch (error) {
        const code = errorCodeOf(error)
        try {
          await outbound.abort(code)
        } catch {
          // handler sink already gone
        }
        if (record?.aborted !== true) await sendTerminal('abort', code)
        this.abortStreamLocal(streamId, code)
      } finally {
        settle()
      }
    }

    const localToController = async (): Promise<void> => {
      try {
        for await (const message of inbound) {
          if (exchangeAbort.signal.aborted) break
          await this.writeStreamMessage(streamId, message)
        }
        // Send End even when the sibling direction cancelled this pump: the
        // controller needs the terminal frame to release its own record.
        await sendTerminal('end')
      } catch (error) {
        const code = errorCodeOf(error)
        if (record?.aborted !== true) await sendTerminal('abort', code)
        this.abortStreamLocal(streamId, code)
      } finally {
        settle()
      }
    }

    void controllerToLocal()
    void localToController()
  }

  /** Abort a portal stream locally and tell the peer with an abort frame. */
  private failPortalStream(streamId: number, code: string): void {
    this.abortStreamLocal(streamId, code)
    void this.sendAbortFrame(streamId, code)
    this.removeStream(streamId)
  }

  // -- Stream frames --------------------------------------------------------

  private handleStreamBytes(bytes: Uint8Array): void {
    if (bytes.length < STREAM_HEADER_BYTES) {
      this.protocolViolation('stream frame too short')
      return
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    const streamId = view.getUint32(1)
    const flags = bytes[5] ?? 0
    const payload = bytes.subarray(STREAM_HEADER_BYTES)
    if (payload.length > MAX_STREAM_CHUNK_BYTES) {
      this.protocolViolation('stream chunk too large')
      return
    }
    const knownFlags = StreamFlag.Data | StreamFlag.End | StreamFlag.Abort | StreamFlag.MessageEnd
    if ((flags & ~knownFlags) !== 0) {
      this.protocolViolation('unknown stream flags')
      return
    }
    const hasData = (flags & StreamFlag.Data) !== 0
    const hasEnd = (flags & StreamFlag.End) !== 0
    const hasAbort = (flags & StreamFlag.Abort) !== 0
    const messageEnd = (flags & StreamFlag.MessageEnd) !== 0
    if (hasEnd && hasAbort) {
      this.protocolViolation('stream frame cannot end and abort at once')
      return
    }
    if (!hasData && !hasEnd && !hasAbort) {
      this.protocolViolation('stream frame without data/end/abort')
      return
    }
    const record = this.streams.get(streamId)
    if (!record) {
      // Stale or unknown stream ids are ignored: a race after abort must not
      // let the peer kill an unrelated session (isolation).
      return
    }
    if (hasAbort) {
      const code = sanitizeText(new TextDecoder().decode(payload), 128) || 'mesh/internal'
      record.aborted = true
      record.input.fail(code, code)
      record.abortController.abort()
      record.onPeerAbort?.(code)
      this.removeStream(streamId)
      return
    }
    if (hasData) {
      record.input.push(payload, messageEnd)
    }
    if (hasEnd) {
      record.input.end()
      record.inboundDone = true
      record.onPeerEnd?.()
      this.maybeFinishStream(streamId)
    }
  }

  async writeStreamChunk(streamId: number, chunk: Uint8Array): Promise<void> {
    if (!this.openState) throw new MeshRpcError('mesh/internal', 'session closed')
    if (chunk.length === 0) {
      await this.sendStreamFrame(streamId, StreamFlag.Data, new Uint8Array(0))
      return
    }
    let offset = 0
    while (offset < chunk.length) {
      const end = Math.min(offset + MAX_STREAM_CHUNK_BYTES, chunk.length)
      await this.sendStreamFrame(streamId, StreamFlag.Data, chunk.subarray(offset, end))
      offset = end
    }
  }

  async writeStreamMessage(streamId: number, message: Uint8Array): Promise<void> {
    if (message.length === 0) {
      await this.sendStreamFrame(streamId, StreamFlag.Data | StreamFlag.MessageEnd, new Uint8Array(0))
      return
    }
    let offset = 0
    while (offset < message.length) {
      const end = Math.min(offset + MAX_STREAM_CHUNK_BYTES, message.length)
      const last = end >= message.length
      await this.sendStreamFrame(
        streamId,
        StreamFlag.Data | (last ? StreamFlag.MessageEnd : 0),
        message.subarray(offset, end),
      )
      offset = end
    }
  }

  async endStream(streamId: number, payload: Uint8Array = new Uint8Array(0)): Promise<void> {
    await this.sendStreamFrame(streamId, StreamFlag.End, payload)
    this.markOutboundDone(streamId)
  }

  async abortStream(streamId: number, code: string): Promise<void> {
    await this.sendAbortFrame(streamId, code)
    this.abortStreamLocal(streamId, code)
    this.removeStream(streamId)
  }

  private async sendAbortFrame(streamId: number, code: string): Promise<void> {
    if (!this.openState) return
    try {
      await this.sendStreamFrame(streamId, StreamFlag.Abort, new TextEncoder().encode(sanitizeText(code, 128)))
    } catch {
      // session closed concurrently
    }
  }

  private abortStreamLocal(streamId: number, code: string): void {
    const record = this.streams.get(streamId)
    if (!record) return
    record.aborted = true
    record.input.fail(code, code)
    record.abortController.abort()
  }

  private async sendStreamFrame(streamId: number, flags: number, payload: Uint8Array): Promise<void> {
    if (payload.length > MAX_STREAM_CHUNK_BYTES) {
      throw new MeshRpcError('mesh/bad-request', 'stream chunk too large')
    }
    await this.waitForDrain()
    this.sendPlaintext(encodeStreamFrame(streamId, flags, payload))
  }

  private async endStreamSafe(streamId: number): Promise<void> {
    try {
      await this.endStream(streamId)
    } catch {
      this.removeStream(streamId)
    }
  }

  private markOutboundDone(streamId: number): void {
    const record = this.streams.get(streamId)
    if (!record) return
    record.outboundDone = true
    this.maybeFinishStream(streamId)
  }

  private maybeFinishStream(streamId: number): void {
    const record = this.streams.get(streamId)
    if (!record) return
    if (record.aborted || (record.inboundDone && record.outboundDone)) {
      this.removeStream(streamId)
    }
  }

  private removeStream(streamId: number): void {
    this.streams.delete(streamId)
  }

  // -- Stream registry ------------------------------------------------------

  private allocateStreamId(): number {
    const limit = 0x7ffffff0
    for (let attempt = 0; attempt < this.maxConcurrentStreams + 2; attempt += 1) {
      const id = this.nextStreamId
      this.nextStreamId = this.nextStreamId + 2 > limit ? (this.role === 'controller' ? 1 : 2) : this.nextStreamId + 2
      if (!this.streams.has(id)) return id
    }
    throw new MeshRpcError('mesh/busy', 'no free stream id')
  }

  private createInput(streamId: number, messageBoundaries: boolean): InputStream {
    return new InputStream({
      messageBoundaries,
      maxQueuedBytes: this.maxInboundQueueBytes,
      onOverflow: () => {
        void this.abortStream(streamId, 'mesh/busy').catch(() => {})
      },
      onCancel: () => {
        this.streams.get(streamId)?.onInputCancel?.()
      },
    })
  }

  private registerStream(
    streamId: number,
    input: InputStream,
    kind: StreamRecord['kind'],
    hooks: {
      readonly onInputCancel?: (() => void) | undefined
      readonly onPeerAbort?: ((code: string) => void) | undefined
      readonly onPeerEnd?: (() => void) | undefined
    } = {},
  ): StreamRecord {
    const record: StreamRecord = {
      id: streamId,
      input,
      kind,
      abortController: new AbortController(),
      inboundDone: false,
      outboundDone: false,
      aborted: false,
      onInputCancel: hooks.onInputCancel,
      onPeerAbort: hooks.onPeerAbort,
      onPeerEnd: hooks.onPeerEnd,
    }
    this.streams.set(streamId, record)
    return record
  }

  // -- Sending control messages --------------------------------------------

  private assertOpen(): void {
    if (!this.openState) throw new MeshRpcError('mesh/internal', 'session closed')
  }

  private assertStreamCapacity(): void {
    if (this.streams.size >= this.maxConcurrentStreams) {
      throw new MeshRpcError('mesh/busy', 'too many concurrent streams')
    }
  }

  private sendControl(value: unknown): void {
    if (!this.openState) throw new MeshRpcError('mesh/internal', 'session closed')
    this.sendPlaintext(encodeControlJson(value))
  }

  /**
   * Reply with a successful result.
   * @returns `true` when the reply was sent; `false` when a failure reply was
   * sent instead (oversize result, unserializable result, closed session), so
   * stream-opening callers know not to start pumping a body.
   */
  private sendSuccess(id: number, result: unknown): boolean {
    if (!this.openState) return false
    let body: Uint8Array
    try {
      // Round-trip through JSON so unserializable results fail before sending.
      const json = JSON.stringify({ id, result: result === undefined ? null : result })
      if (typeof json !== 'string') {
        this.sendFailure(id, 'mesh/internal', 'result is not JSON serializable')
        return false
      }
      body = new TextEncoder().encode(json)
    } catch {
      this.sendFailure(id, 'mesh/internal', 'result is not JSON serializable')
      return false
    }
    // A result larger than one sealed message used to be dropped silently: the
    // caller then waited for the 30 s RPC timeout with no diagnostic (H1).
    // Surface a stable failure instead (the control frame is 1 kind byte + JSON).
    if (1 + body.length > MAX_MESSAGE_BYTES) {
      this.sendFailure(id, 'mesh/busy', 'RPC result too large')
      return false
    }
    const frame = new Uint8Array(1 + body.length)
    frame[0] = MessageKind.Control
    frame.set(body, 1)
    try {
      this.sendPlaintext(frame)
      return true
    } catch {
      // `sendPlaintext` also enforces the limit; map an oversize race to the
      // same typed failure instead of swallowing it.
      if (this.openState) this.sendFailure(id, 'mesh/busy', 'RPC result too large')
      return false
    }
  }

  private sendFailure(id: number, code: string, message: string): void {
    if (!this.openState) return
    try {
      this.sendControl({ id, error: { code, message: sanitizeText(message) } })
    } catch {
      // closed
    }
  }

  private sendPlaintext(bytes: Uint8Array): void {
    if (!this.openState) throw new MeshRpcError('mesh/internal', 'session closed')
    if (bytes.length > MAX_MESSAGE_BYTES) {
      throw new MeshRpcError('mesh/bad-request', 'message too large')
    }
    try {
      this.bridge.sendPlaintext(bytes)
    } catch {
      this.finish(MeshCloseCode.CryptoError, 'mesh/internal', false)
      throw new MeshRpcError('mesh/internal', 'session closed')
    }
  }

  private async waitForDrain(): Promise<void> {
    let rounds = 0
    while (this.openState && this.bridge.bufferedAmount() > this.backpressureHighWaterBytes) {
      rounds += 1
      if (rounds > 20_000) throw new MeshRpcError('mesh/busy', 'transport backpressure did not clear')
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 5)
      })
    }
  }

  private rememberInfo(value: unknown): void {
    if (!isPlainObject(value)) return
    if (typeof value.protocol !== 'number' || !isPlainObject(value.device)) return
    this.infoValue = value as unknown as MeshInfo
  }

  private clearRpcPending(id: number): void {
    const pending = this.pendingRpcs.get(id)
    if (!pending) return
    this.pendingRpcs.delete(id)
    this.clearTimer(pending)
    if (pending.signal && pending.onAbort) pending.signal.removeEventListener('abort', pending.onAbort)
  }

  private clearTimer(pending: RpcPending): void {
    if (pending.timer) {
      clearTimeout(pending.timer)
      pending.timer = null
    }
  }

  private clearPingPending(id: number): void {
    const pending = this.pendingPings.get(id)
    if (!pending) return
    this.pendingPings.delete(id)
    if (pending.timer) clearTimeout(pending.timer)
  }

  // -- Lifecycle ------------------------------------------------------------

  private protocolViolation(detail: string): void {
    // Only the stable error detail is used as the close reason; never payloads.
    this.finish(MeshCloseCode.ProtocolError, `mesh/bad-request: ${sanitizeText(detail, 80)}`, true)
  }

  private finish(code: number, reason: string, notifyTransport: boolean): void {
    if (!this.openState) return
    this.openState = false
    this.unsubscribeTransportClose()
    this.sessionAbort.abort()
    for (const [id, pending] of [...this.pendingRpcs]) {
      this.clearRpcPending(id)
      pending.reject(new MeshRpcError('mesh/internal', 'session closed'))
    }
    this.pendingRpcs.clear()
    for (const [id, pending] of [...this.pendingPings]) {
      this.clearPingPending(id)
      pending.reject(new MeshRpcError('mesh/internal', 'session closed'))
    }
    this.pendingPings.clear()
    for (const [streamId, record] of [...this.streams]) {
      record.aborted = true
      record.input.fail('mesh/internal', 'session closed')
      record.abortController.abort()
      this.streams.delete(streamId)
    }
    this.eventListeners.clear()
    if (notifyTransport) {
      try {
        this.bridge.closeTransport(code, reason)
      } catch {
        // transport may already be gone
      }
    }
    this.resolveClosed()
  }
}

// ---------------------------------------------------------------------------
// Parameter parsing
// ---------------------------------------------------------------------------

const HTTP_METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'])

function normalizeHeaders(value: Record<string, unknown>): Record<string, string> {
  const headers: Record<string, string> = {}
  for (const [key, headerValue] of Object.entries(value)) {
    if (typeof headerValue === 'string' && key.length > 0 && key.length <= 256) headers[key] = headerValue
  }
  return headers
}

function parseHeaders(value: unknown): Record<string, string> | undefined {
  if (!isPlainObject(value)) return undefined
  const entries = Object.entries(value)
  if (entries.length > 64) return undefined
  const headers: Record<string, string> = {}
  for (const [key, headerValue] of entries) {
    if (typeof headerValue !== 'string' || key.length === 0 || key.length > 256 || headerValue.length > 8192) {
      return undefined
    }
    if (/[\u0000-\u001f\u007f]/u.test(key) || /[\u0000-\u001f\u007f]/u.test(headerValue)) return undefined
    headers[key] = headerValue
  }
  return headers
}

function parseStreamId(value: unknown, role: 'controller' | 'daemon'): number | undefined {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0 || value > 0x7fffffff) return undefined
  // The side that opens a stream uses its own parity: controller odd, daemon even.
  const expectedParity = role === 'controller' ? 1 : 0
  if (value % 2 !== expectedParity) return undefined
  return value
}

function parsePortalHttpParams(value: unknown):
  | { streamId: number; method: string; path: string; headers: Record<string, string> }
  | undefined {
  if (!isPlainObject(value)) return undefined
  const streamId = parseStreamId(value.streamId, 'controller')
  if (streamId === undefined) return undefined
  if (typeof value.method !== 'string' || !HTTP_METHODS.has(value.method)) return undefined
  if (typeof value.path !== 'string' || !value.path.startsWith('/') || value.path.length > 8192) return undefined
  if (/[\u0000-\u001f\u007f]/u.test(value.path)) return undefined
  const headers = parseHeaders(value.headers)
  if (!headers) return undefined
  return { streamId, method: value.method, path: value.path, headers }
}

function parsePortalWsParams(
  value: unknown,
): { streamId: number; path: string; headers: Record<string, string>; protocols?: readonly string[] } | undefined {
  if (!isPlainObject(value)) return undefined
  const streamId = parseStreamId(value.streamId, 'controller')
  if (streamId === undefined) return undefined
  if (typeof value.path !== 'string' || !value.path.startsWith('/') || value.path.length > 8192) return undefined
  if (/[\u0000-\u001f\u007f]/u.test(value.path)) return undefined
  const headers = parseHeaders(value.headers)
  if (!headers) return undefined
  let protocols: readonly string[] | undefined
  if (value.protocols !== undefined) {
    if (!Array.isArray(value.protocols) || value.protocols.length > 16) return undefined
    const list: string[] = []
    for (const protocol of value.protocols) {
      if (typeof protocol !== 'string' || protocol.length === 0 || protocol.length > 256) return undefined
      if (/[\u0000-\u001f\u007f]/u.test(protocol)) return undefined
      list.push(protocol)
    }
    protocols = list
  }
  return { streamId, path: value.path, headers, ...(protocols === undefined ? {} : { protocols }) }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a session on top of an authenticated channel bridge. Called by
 * `channel.ts` after Noise + application authentication succeeded; the caller
 * then forwards decrypted messages via `handlePlaintext`.
 */
export function createSession(bridge: SessionBridge, options: MeshSessionOptions = {}): MeshSessionImpl & DaemonMeshSession {
  if (bridge.role === 'daemon' && options.handlers === undefined) {
    throw new Error('daemon sessions require DaemonSessionHandlers')
  }
  return new MeshSessionImpl(bridge, options)
}

/**
 * Internal type used by `channel.ts` to drive the decrypted message stream.
 * Exported so the channel can type its hand-off (the extra method is not part
 * of the shared `MeshSession` contract).
 */
export interface SessionInternals {
  handlePlaintext(bytes: Uint8Array): void
}
