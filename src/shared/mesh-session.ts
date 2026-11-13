/**
 * The session surface produced by `src/host/channel.ts` (implementation:
 * noise handshake + application authentication + stream multiplexer) and
 * consumed by the broker, the portal proxies and the tests.
 *
 * Keeping this seam explicit lets the host broker, the two portal proxies and
 * the transport layers be built and tested independently of the crypto layer.
 */

import type {
  DeviceDescriptor,
  MeshInfo,
  PortalHttpParams,
  PortalHttpResult,
  PortalWsParams,
  RpcEvent,
} from './protocol.ts'

/**
 * A readable stream of chunks produced by the session multiplexer.
 *
 * For portal WebSocket streams every chunk is one *encoded* WebSocket message
 * (`[kind byte][payload]`, see {@link encodeWsMessage}); plain HTTP streams
 * carry raw body bytes.
 */
export type ChunkStream = AsyncIterable<Uint8Array>

/**
 * Opcode tag carried as the first byte of every portal WebSocket message.
 *
 * The Mesh stream framing (docs/PROTOCOL.md §4.4) is byte-oriented and has no
 * WebSocket opcode, so the portal proxies prepend one application-level kind
 * byte to each message. This keeps the stream flags/protocol version unchanged
 * and lets both ends reconstruct `text` vs `binary` frames exactly.
 *
 * Values 2 and 3 are the same opcodes with a gzip-compressed payload. They are
 * only used after the controller explicitly asks for compression in
 * `portal.ws.open`, so an older peer never receives an unknown tag.
 */
export const WsMessageKind = {
  /** Payload is UTF-8 text (`WebSocket#send(string)`). */
  Text: 0,
  /** Payload is an opaque binary frame (`WebSocket#send(Buffer)`). */
  Binary: 1,
  /** Payload is gzip-compressed text. */
  CompressedText: 2,
  /** Payload is gzip-compressed binary. */
  CompressedBinary: 3,
} as const

/** Decoded portal WebSocket message. */
export interface WsMessage {
  readonly kind: 'text' | 'binary'
  readonly payload: Uint8Array
  /** The payload is still gzip-compressed and must be inflated first. */
  readonly compressed: boolean
}

/**
 * Encode one portal WebSocket message: `[kind byte][payload]`.
 * @param payload - raw message bytes (or gzip bytes when `compressed`).
 * @param kind - `text` or `binary`.
 * @param compressed - whether `payload` is already gzip-compressed.
 * @returns a new buffer starting with the kind byte.
 */
export function encodeWsMessage(
  payload: Uint8Array,
  kind: 'text' | 'binary',
  compressed = false,
): Uint8Array {
  const encoded = new Uint8Array(payload.length + 1)
  encoded[0] = kind === 'text'
    ? (compressed ? WsMessageKind.CompressedText : WsMessageKind.Text)
    : (compressed ? WsMessageKind.CompressedBinary : WsMessageKind.Binary)
  encoded.set(payload, 1)
  return encoded
}

/**
 * Decode one portal WebSocket message (`[kind byte][payload]`).
 *
 * Unknown/absent kind bytes are treated as a legacy unframed binary message so a
 * malformed peer cannot crash the proxy; messages produced by
 * {@link encodeWsMessage} always take the tagged path.
 * @param message - encoded message chunk.
 * @returns kind, compression flag plus a payload view (no copy).
 */
export function decodeWsMessage(message: Uint8Array): WsMessage {
  const kind = message[0]
  if (kind === WsMessageKind.Text) return { kind: 'text', payload: message.subarray(1), compressed: false }
  if (kind === WsMessageKind.Binary) return { kind: 'binary', payload: message.subarray(1), compressed: false }
  if (kind === WsMessageKind.CompressedText) {
    return { kind: 'text', payload: message.subarray(1), compressed: true }
  }
  if (kind === WsMessageKind.CompressedBinary) {
    return { kind: 'binary', payload: message.subarray(1), compressed: true }
  }
  return { kind: 'binary', payload: message, compressed: false }
}

/**
 * Pairing state of an authenticated session (docs/PROTOCOL.md §4.2).
 *
 * `approval === "pending"` means a `pair-token` session is established but the
 * daemon's local user has not decided yet: the only RPC the controller may
 * issue is `pair.status`, and portal streams are refused until approval.
 */
export interface MeshSessionPairing {
  readonly approval: 'none' | 'pending'
  readonly requestId?: string
}

/** Writable side of a multiplexed stream. */
export interface StreamSink {
  /** Send one chunk; resolves after it is queued on the transport. */
  write(chunk: Uint8Array): Promise<void>
  /** Mark the stream ended (no payload). */
  end(): Promise<void>
  /** Abort the stream with a UTF-8 error code. */
  abort(code: string): Promise<void>
}

export interface HttpExchangeResult extends PortalHttpResult {
  readonly body: ChunkStream
}

export interface WsExchangeResult {
  readonly protocol?: string
  /** Message payloads may be gzip-compressed; see {@link decodeWsMessage}. */
  readonly compressed?: boolean
  /**
   * Inbound WebSocket messages, one `Uint8Array` per message. Each chunk is a
   * `[kind byte][payload]` envelope: use {@link decodeWsMessage} to recover the
   * original `text`/`binary` opcode.
   */
  readonly messages: ChunkStream & { readonly messageBoundaries: true }
  readonly sink: StreamSink & {
    /**
     * Send one complete WebSocket message, encoded with
     * {@link encodeWsMessage} so the far side can restore its opcode.
     */
    sendMessage(message: Uint8Array): Promise<void>
    /** Close the remote socket. */
    close(code?: number, reason?: string): Promise<void>
  }
}

/** An authenticated, encrypted Mesh session. */
export interface MeshSession {
  readonly role: 'controller' | 'daemon'
  /** Peer device descriptor as authenticated by the session. */
  readonly remote: DeviceDescriptor
  /** Health/version facts learned from `info` (controller keeps it fresh). */
  readonly info: MeshInfo | undefined
  /**
   * Six-digit SAS (`123-456`, docs/PROTOCOL.md §4.2 rule 4) both parties show
   * during pairing. Available once application authentication completed.
   */
  readonly sas: string | undefined
  /**
   * Pairing state; observed by the host broker for the `pair.status` flow.
   *
   * Live on daemon sessions: it changes from `pending` to `none` once the
   * local user approves (or denies) the request, without reconnecting.
   */
  readonly pairing: MeshSessionPairing | undefined
  /** True while the underlying transport and crypto state are usable. */
  readonly open: boolean
  /** Resolves once the session is closed; never rejects. */
  readonly closed: Promise<void>

  /** Unary RPC. Rejects with a `MeshRpcError` carrying `code`. */
  rpc<T = unknown>(method: string, params?: unknown, options?: { readonly signal?: AbortSignal }): Promise<T>
  /** Subscribe to daemon-pushed events. Returns an unsubscribe function. */
  onEvent(listener: (event: RpcEvent) => void): () => void

  /** Open an HTTP exchange through the portal channel (controller side). */
  http(params: Omit<PortalHttpParams, 'streamId'>, body?: ChunkStream): Promise<HttpExchangeResult>
  /** Open a WebSocket exchange through the portal channel (controller side). */
  ws(params: Omit<PortalWsParams, 'streamId'>): Promise<WsExchangeResult>

  /** Send an application heartbeat and wait for the matching pong. */
  ping(timeoutMs?: number): Promise<number>

  close(): void
}

/** RPC failure surfaced to callers. */
export class MeshRpcError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'MeshRpcError'
  }
}

/** Inbound handlers a daemon registers for a session. */
export interface DaemonSessionHandlers {
  /** Handle a unary RPC. Throwing `MeshRpcError` maps to the wire error code. */
  rpc(method: string, params: unknown, signal: AbortSignal): Promise<unknown>
  /** Open a proxied HTTP exchange to the daemon's local DSH web server. */
  http(
    params: Omit<PortalHttpParams, 'streamId'>,
    body: ChunkStream,
    signal: AbortSignal,
  ): Promise<{ readonly status: number; readonly headers: Record<string, string>; readonly body: ChunkStream }>
  /**
   * Open a proxied WebSocket exchange to the daemon's local DSH web server.
   *
   * `inbound` yields and `outbound.write` accepts `[kind byte][payload]`
   * envelopes (see {@link encodeWsMessage}) so text frames stay text on the
   * wire in both directions.
   */
  ws(
    params: Omit<PortalWsParams, 'streamId'>,
    signal: AbortSignal,
  ): Promise<{
    readonly protocol?: string
    readonly compressed?: boolean
    readonly inbound: ChunkStream
    readonly outbound: StreamSink
  }>
}

/** Application-authentication outcome for a daemon-side inbound session. */
export type DaemonAuthOutcome =
  | { readonly kind: 'paired'; readonly peer: import('./protocol.ts').PeerRecord }
  | {
    readonly kind: 'pair-approval-required'
    readonly requestId: string
    /** Resume with the approval decision; resolve only after the local user decides. */
    readonly decide: Promise<{ readonly approved: boolean }>
  }
