/**
 * Secure Mesh channel: Noise NK handshake + application authentication.
 *
 * Responsibilities (`docs/PROTOCOL.md` §3-§4):
 *
 * 1. Run `Noise_NK_25519_ChaChaPoly_SHA256` over a `MeshTransport`:
 *    controller sends `0x01 || msg1`, daemon replies `0x01 || msg2`.
 * 2. Exchange the *encrypted* application authentication messages:
 *    - controller → daemon `ClientAuthMessage` (`paired` signature or one-time
 *      `pair-token`, as produced by the pairing flow);
 *    - daemon → controller `ServerAuthMessage` (pinned identity + Ed25519
 *      signature over `h || "server_auth" || controllerNonce`).
 * 3. Hand a live `MeshSession` (session multiplexer) to the caller.
 *
 * Authentication policy is injected: this module never reads files, never
 * knows about `peers.json` and never validates pairing tokens itself. A daemon
 * passes a `DaemonAuthenticator` callback returning the shared
 * `DaemonAuthOutcome`; the broker owns persistence, revocation, token stores
 * and the local approval UI. The controller passes the pinned daemon
 * descriptor plus either `{kind:'paired'}` or the one-time token.
 *
 * Security invariants enforced here:
 * - only `node:crypto` primitives (via `noise.ts` / `crypto.ts`);
 * - handshake and application-auth frames obey strict size limits;
 * - a `0x02` frame before the handshake, or a `0x01` frame after it, closes
 *   the transport with `4400`;
 * - any AEAD failure closes with `4401` and stops sending;
 * - controller verifies the daemon's pinned keys (identity change → close);
 * - daemon verifies the controller signature against its pairing record and
 *   rejects duplicate client nonces (10 minute replay cache);
 * - 60 s authentication deadline from the first frame to `ServerAuth`;
 * - no error message or log ever contains keys, tokens, nonces or `h`.
 */

import { fromBase64Url, toBase64Url, MessageKind, PROTOCOL_VERSION } from '../shared/protocol.ts'
import type {
  ClientAuthMessage,
  DeviceDescriptor,
  DeviceIdentity,
  MeshCapability,
  MeshInfo,
  ServerAuthMessage,
} from '../shared/protocol.ts'
import type { MeshTransport, TransportCloseInfo } from '../shared/transport.ts'
import { MeshRpcError } from '../shared/mesh-session.ts'
import type { DaemonAuthOutcome, DaemonSessionHandlers, MeshSession } from '../shared/mesh-session.ts'
import {
  NOISE_MAX_HANDSHAKE_MESSAGE,
  NOISE_TAG_LEN,
  NoiseError,
  NoiseNkHandshake,
} from './noise.ts'
import type { CipherState } from './noise.ts'
import {
  computeSas,
  deviceDescriptorOf,
  parseDeviceDescriptor,
  randomBytes,
  signClientAuth,
  signServerAuth,
  validateIdentityShape,
  verifyClientAuth,
  verifyServerAuth,
} from './crypto.ts'
import { MeshCloseCode, createSession } from './session.ts'
import type { DaemonMeshSession, MeshSessionImpl, MeshSessionOptions, SessionBridge } from './session.ts'

/** Default application-authentication deadline (docs/PROTOCOL.md §4.3). */
export const DEFAULT_AUTH_TIMEOUT_MS = 60_000
/** The first Noise frame must arrive within this window (pre-auth idle bound). */
export const DEFAULT_FIRST_FRAME_TIMEOUT_MS = 10_000
/** Maximum size of an encrypted `ClientAuth`/`ServerAuth` JSON message. */
export const MAX_APP_AUTH_MESSAGE_BYTES = 16 * 1024
/** Default lifetime of the daemon-side client nonce replay cache. */
export const NONCE_CACHE_TTL_MS = 10 * 60_000

const EMPTY = new Uint8Array(0)

/** Error type for channel establishment failures. */
export class MeshChannelError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly closeCode: number = MeshCloseCode.ProtocolError,
  ) {
    super(message)
    this.name = 'MeshChannelError'
  }
}

/** Controller credentials for the application-authentication exchange. */
export type ControllerAuth =
  | { readonly kind: 'paired' }
  | {
    /** First-contact pairing: one-time token from the QR code / pairing link. */
    readonly kind: 'pair-token'
    readonly daemonId: string
    readonly token: string
  }

export interface ControllerChannelOptions {
  readonly transport: MeshTransport
  /** This device's identity (private keys are used, never transmitted). */
  readonly identity: DeviceIdentity
  /** Pinned daemon identity from the pairing record / pairing ticket. */
  readonly daemon: DeviceDescriptor
  /** Defaults to `{ kind: 'paired' }`. */
  readonly auth?: ControllerAuth
  /** App version advertised on the wire (no need to be a secret). */
  readonly appVersion: string
  readonly capabilities?: readonly MeshCapability[]
  readonly hostLabel?: string
  readonly authTimeoutMs?: number
  /** Bound for the first inbound Noise frame; defaults to 10 s. */
  readonly firstFrameTimeoutMs?: number
  /** Extra session knobs (timeouts, limits); handlers are ignored. */
  readonly session?: Pick<
    MeshSessionOptions,
    'rpcTimeoutMs' | 'maxConcurrentStreams' | 'maxInboundQueueBytes' | 'backpressureHighWaterBytes'
  >
  /** Optional MeshInfo to expose immediately (usually learned via `info` RPC). */
  readonly info?: MeshInfo
}

/** Context handed to the daemon's injected authentication callback. */
export interface DaemonAuthContext {
  /** Fully validated, decrypted `client_auth` message. */
  readonly client: ClientAuthMessage
  /** Raw 32-byte controller nonce (needed for SAS / audit, never log it). */
  readonly clientNonce: Uint8Array
  /** Noise handshake hash `h` (used for signatures and SAS). */
  readonly handshakeHash: Uint8Array
  /** Six-digit SAS `123-456` for the local approval UI. */
  readonly sas: string
  readonly transportKind: MeshTransport['kind']
  readonly remoteLabel: string
}

export type DaemonAuthenticator = (context: DaemonAuthContext) => Promise<DaemonAuthOutcome> | DaemonAuthOutcome

export interface DaemonChannelOptions {
  readonly transport: MeshTransport
  readonly identity: DeviceIdentity
  /** Injected authentication policy (pairing records, tokens, approval UI). */
  readonly authenticate: DaemonAuthenticator
  /** Handlers for `info`, `workspaces.*`, `portal.*`, … */
  readonly handlers: DaemonSessionHandlers
  readonly appVersion: string
  readonly capabilities?: readonly MeshCapability[]
  readonly hostLabel?: string
  readonly authTimeoutMs?: number
  /** Bound for the first inbound Noise frame; defaults to 10 s. */
  readonly firstFrameTimeoutMs?: number
  /**
   * Shared replay cache. Pass the same instance for every accepted connection
   * so a nonce cannot be reused across sessions; a private default is created
   * otherwise.
   */
  readonly nonceCache?: NonceReplayCache
  /** Optional info exposed on the daemon session. */
  readonly info?: MeshInfo
  readonly session?: Pick<
    MeshSessionOptions,
    'rpcTimeoutMs' | 'maxConcurrentStreams' | 'maxInboundQueueBytes' | 'backpressureHighWaterBytes'
  >
}

/**
 * Daemon-side replay protection for `ClientAuth.nonce` values (32 bytes).
 * `docs/PROTOCOL.md` §4.2 rule 5 requires rejecting duplicates for 10 minutes.
 */
export class NonceReplayCache {
  private readonly seen = new Map<string, number>()
  private readonly ttlMs: number
  private readonly maxEntries: number
  private readonly now: () => number

  constructor(options: {
    readonly ttlMs?: number
    readonly maxEntries?: number
    readonly now?: () => number
  } = {}) {
    this.ttlMs = options.ttlMs ?? NONCE_CACHE_TTL_MS
    this.maxEntries = options.maxEntries ?? 10_000
    this.now = options.now ?? Date.now
  }

  /**
   * Returns `true` when the nonce is fresh (and records it); `false` when it
   * was already seen within the TTL. Nonces are keyed by their hex digest.
   */
  checkAndRecord(nonce: Uint8Array): boolean {
    if (nonce.length !== 32) return false
    const now = this.now()
    this.prune(now)
    const key = Buffer.from(nonce).toString('hex')
    if (this.seen.has(key)) return false
    this.seen.set(key, now)
    if (this.seen.size > this.maxEntries) {
      // Drop the oldest entry to keep memory bounded.
      const oldest = this.seen.keys().next()
      if (!oldest.done) this.seen.delete(oldest.value)
    }
    return true
  }

  /** Number of cached nonces (diagnostics/tests only). */
  get size(): number {
    return this.seen.size
  }

  private prune(now: number): void {
    for (const [key, timestamp] of this.seen) {
      if (now - timestamp > this.ttlMs) this.seen.delete(key)
      else break // Map preserves insertion order: the rest are newer.
    }
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

interface MailboxWaiter {
  readonly resolve: (message: Uint8Array) => void
  readonly reject: (error: Error) => void
}

/** Ordered inbound frame queue used during the handshake/auth phase. */
class Mailbox {
  private readonly queue: Uint8Array[] = []
  private readonly waiters: MailboxWaiter[] = []
  private failure: Error | null = null
  private readonly maxQueued: number

  constructor(maxQueued = 8) {
    this.maxQueued = maxQueued
  }

  push(message: Uint8Array): void {
    if (this.failure) return
    const waiter = this.waiters.shift()
    if (waiter) {
      waiter.resolve(message)
      return
    }
    if (this.queue.length >= this.maxQueued) {
      this.fail(new MeshChannelError('mesh/bad-request', 'too many queued handshake messages', MeshCloseCode.ProtocolError))
      return
    }
    this.queue.push(message)
  }

  next(): Promise<Uint8Array> {
    if (this.failure) return Promise.reject(this.failure)
    const queued = this.queue.shift()
    if (queued) return Promise.resolve(queued)
    return new Promise<Uint8Array>((resolve, reject) => {
      this.waiters.push({ resolve, reject })
    })
  }

  fail(error: Error): void {
    if (this.failure) return
    this.failure = error
    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift()
      waiter?.reject(error)
    }
    this.queue.length = 0
  }
}

function toFrame(kind: number, payload: Uint8Array): Uint8Array {
  const frame = new Uint8Array(1 + payload.length)
  frame[0] = kind
  frame.set(payload, 1)
  return frame
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function decodeJson(body: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(body))
  } catch {
    throw new MeshChannelError('mesh/bad-request', 'invalid application authentication JSON', MeshCloseCode.ProtocolError)
  }
}

function decodeFixed(value: unknown, length: number): Uint8Array | undefined {
  if (typeof value !== 'string') return undefined
  const decoded = fromBase64Url(value)
  return decoded && decoded.length === length ? decoded : undefined
}

function mapAuthError(error: unknown): MeshChannelError {
  if (error instanceof MeshChannelError) return error
  if (error instanceof MeshRpcError) {
    const code = error.code
    if (code === 'mesh/unauthorized' || code === 'mesh/revoked' || code === 'mesh/version-mismatch') {
      return new MeshChannelError(code, error.message, MeshCloseCode.Unauthorized)
    }
  }
  const detail = error instanceof Error ? error.message : String(error)
  return new MeshChannelError('mesh/unauthorized', `authentication rejected: ${detail}`, MeshCloseCode.Unauthorized)
}

// ---------------------------------------------------------------------------
// Controller (initiator)
// ---------------------------------------------------------------------------

/** Controller side: connect, authenticate the daemon, return the session. */
export async function connectMeshChannel(options: ControllerChannelOptions): Promise<MeshSession> {
  const identity = validateIdentityShape(options.identity)
  const pinned = parseDeviceDescriptor(options.daemon)
  const auth: ControllerAuth = options.auth ?? { kind: 'paired' }
  if (auth.kind === 'pair-token' && auth.daemonId !== pinned.deviceId) {
    throw new MeshChannelError('mesh/bad-request', 'pairing token is for a different daemon', MeshCloseCode.ProtocolError)
  }
  if (auth.kind === 'pair-token' && decodeFixed(auth.token, 32) === undefined) {
    throw new MeshChannelError('mesh/unauthorized', 'invalid pairing token', MeshCloseCode.Unauthorized)
  }
  return runInitiator(options, identity, pinned, auth)
}

async function runInitiator(
  options: ControllerChannelOptions,
  identity: DeviceIdentity,
  pinned: DeviceDescriptor,
  auth: ControllerAuth,
): Promise<MeshSession> {
  const transport = options.transport
  const authTimeoutMs = options.authTimeoutMs ?? DEFAULT_AUTH_TIMEOUT_MS
  const mailbox = new Mailbox()
  let phase: 'noise' | 'app-auth' | 'session' | 'closed' = 'noise'
  let tx: CipherState | undefined
  let rx: CipherState | undefined
  let session: MeshSessionImpl | undefined
  let deadline: ReturnType<typeof setTimeout> | undefined
  let firstFrameTimer: ReturnType<typeof setTimeout> | undefined
  let failure: MeshChannelError | undefined

  const clearFirstFrameTimer = (): void => {
    if (firstFrameTimer !== undefined) clearTimeout(firstFrameTimer)
    firstFrameTimer = undefined
  }

  const fail = (error: MeshChannelError): void => {
    if (phase === 'closed' || failure) return
    failure = error
    phase = 'closed'
    if (deadline) clearTimeout(deadline)
    clearFirstFrameTimer()
    mailbox.fail(error)
    try {
      transport.close(error.closeCode, error.code)
    } catch {
      // transport already gone
    }
  }

  const sendFrame = (frame: Uint8Array): void => {
    if (phase === 'closed') throw failure ?? new MeshChannelError('mesh/internal', 'channel closed', MeshCloseCode.ProtocolError)
    try {
      transport.send(frame)
    } catch {
      const error = new MeshChannelError('mesh/internal', 'transport closed', MeshCloseCode.ProtocolError)
      fail(error)
      throw error
    }
  }

  const sendSealed = (plaintext: Uint8Array): void => {
    if (!tx) throw new MeshChannelError('mesh/internal', 'cipher state missing', MeshCloseCode.ProtocolError)
    if (plaintext.length > 64 * 1024) {
      throw new MeshChannelError('mesh/bad-request', 'session message too large', MeshCloseCode.ProtocolError)
    }
    sendFrame(toFrame(MessageKind.Sealed, tx.encryptWithAd(EMPTY, plaintext)))
  }

  transport.onClose((info) => {
    if (phase !== 'closed') {
      phase = 'closed'
      if (deadline) clearTimeout(deadline)
      clearFirstFrameTimer()
      mailbox.fail(new MeshChannelError('mesh/internal', 'transport closed before authentication completed', MeshCloseCode.ProtocolError))
    } else if (info.code !== undefined && info.local !== true) {
      // remote close after a local failure: nothing else to do
    }
  })

  deadline = setTimeout(() => {
    fail(new MeshChannelError('mesh/unauthorized', 'authentication timed out', MeshCloseCode.Timeout))
  }, authTimeoutMs)

  const onMessage = (frame: Uint8Array): void => {
    if (phase === 'closed') return
    if (phase === 'session') {
      if (!session) return
      try {
        const plaintext = decryptSealedFrame(frame, rx)
        if (!plaintext) {
          fail(new MeshChannelError('mesh/crypto', 'message authentication failed', MeshCloseCode.CryptoError))
          return
        }
        session.handlePlaintext(plaintext)
      } catch (error) {
        fail(error instanceof MeshChannelError ? error : new MeshChannelError('mesh/crypto', 'invalid sealed frame', MeshCloseCode.CryptoError))
      }
      return
    }
    mailbox.push(frame)
  }
  transport.onMessage(onMessage)

  try {
    // --- Noise msg1 (-> e, es) -------------------------------------------
    const pinnedDhKey = decodeFixed(pinned.dhPk, 32)
    if (!pinnedDhKey) {
      throw new MeshChannelError('mesh/internal', 'pinned daemon key is invalid', MeshCloseCode.ProtocolError)
    }
    const handshake = new NoiseNkHandshake({
      role: 'initiator',
      remoteStaticPublicKey: pinnedDhKey,
    })
    const message1 = handshake.writeMessage()
    if (message1.length > NOISE_MAX_HANDSHAKE_MESSAGE) {
      throw new MeshChannelError('mesh/bad-request', 'handshake message too large', MeshCloseCode.ProtocolError)
    }
    sendFrame(toFrame(MessageKind.Handshake, message1))

    // --- Noise msg2 (<- e, ee) -------------------------------------------
    firstFrameTimer = setTimeout(() => {
      fail(new MeshChannelError('mesh/unauthorized', 'handshake timed out', MeshCloseCode.Timeout))
    }, options.firstFrameTimeoutMs ?? DEFAULT_FIRST_FRAME_TIMEOUT_MS)
    firstFrameTimer.unref?.()
    const frame2 = await mailbox.next().finally(clearFirstFrameTimer)
    assertHandshakeFrame(frame2, NOISE_MAX_HANDSHAKE_MESSAGE)
    try {
      handshake.readMessage(frame2.subarray(1))
    } catch (error) {
      throw noiseErrorToChannelError(error)
    }
    const handshakeHash = handshake.handshakeHash
    const transportPair = handshake.split()
    tx = transportPair.tx
    rx = transportPair.rx
    handshake.destroy()
    phase = 'app-auth'

    // --- ClientAuth ------------------------------------------------------
    const nonce = randomBytes(32)
    const controllerAuth: ClientAuthMessage['auth'] =
      auth.kind === 'paired'
        ? { kind: 'paired', sig: signClientAuth(identity.signSk, handshakeHash) }
        : { kind: 'pair-token', daemonId: pinned.deviceId, token: auth.token }
    const clientAuth: ClientAuthMessage = {
      t: 'client_auth',
      v: PROTOCOL_VERSION,
      controller: deviceDescriptorOf(identity),
      nonce: toBase64Url(nonce),
      auth: controllerAuth,
    }
    sendSealed(controlJsonFrame(clientAuth))

    // --- ServerAuth ------------------------------------------------------
    const authFrame = await mailbox.next()
    const serverAuthBytes = decryptSealedFrame(authFrame, rx)
    if (!serverAuthBytes) {
      throw new MeshChannelError('mesh/crypto', 'message authentication failed', MeshCloseCode.CryptoError)
    }
    const serverAuth = parseServerAuth(unwrapControlMessage(serverAuthBytes))
    if (serverAuth.v !== PROTOCOL_VERSION) {
      throw new MeshChannelError('mesh/version-mismatch', 'unsupported protocol version', MeshCloseCode.ProtocolError)
    }
    const daemonDescriptor = parseDeviceDescriptor(serverAuth.daemon)
    if (
      daemonDescriptor.deviceId !== pinned.deviceId ||
      daemonDescriptor.signPk !== pinned.signPk ||
      daemonDescriptor.dhPk !== pinned.dhPk
    ) {
      throw new MeshChannelError(
        'mesh/unauthorized',
        'daemon identity does not match the pinned pairing record',
        MeshCloseCode.Unauthorized,
      )
    }
    if (!verifyServerAuth(daemonDescriptor.signPk, handshakeHash, nonce, serverAuth.sig)) {
      throw new MeshChannelError('mesh/unauthorized', 'invalid daemon signature', MeshCloseCode.Unauthorized)
    }
    const approval = serverAuth.approval
    let pairing: { approval: 'none' } | { approval: 'pending'; requestId: string }
    if (approval === 'pending') {
      if (typeof serverAuth.requestId !== 'string' || serverAuth.requestId.length === 0) {
        throw new MeshChannelError('mesh/bad-request', 'missing pairing request id', MeshCloseCode.ProtocolError)
      }
      pairing = { approval: 'pending', requestId: sanitizeId(serverAuth.requestId) }
    } else {
      pairing = { approval: 'none' }
    }
    const sas = computeSas(handshakeHash, identity.signPk, daemonDescriptor.signPk)

    const bridge: SessionBridge = {
      role: 'controller',
      remote: daemonDescriptor,
      sas,
      pairing,
      sendPlaintext: (plaintext) =>{  sendSealed(plaintext) },
      onTransportClose: listener => transport.onClose(listener),
      closeTransport: (code, reason) =>{  transport.close(code, reason) },
      bufferedAmount: () => transport.bufferedAmount,
    }
    session = createSession(bridge, {
      ...(options.info === undefined ? {} : { info: options.info }),
      ...options.session,
    })
    phase = 'session'
    if (deadline) {
      clearTimeout(deadline)
      deadline = undefined
    }
    return session
  } catch (error) {
    const channelError = error instanceof MeshChannelError ? error : mapAuthError(error)
    fail(channelError)
    throw channelError
  }
}

// ---------------------------------------------------------------------------
// Daemon (responder)
// ---------------------------------------------------------------------------

/**
 * Daemon side: accept, authenticate the controller, return the session.
 *
 * The returned `DaemonMeshSession` exposes `emit(event, data)` in addition to
 * the shared `MeshSession` surface so the broker can push `workspaces.changed`
 * and similar events to the controller.
 */
export async function acceptMeshChannel(options: DaemonChannelOptions): Promise<DaemonMeshSession> {
  const identity = validateIdentityShape(options.identity)
  return runResponder(options, identity)
}

async function runResponder(options: DaemonChannelOptions, identity: DeviceIdentity): Promise<DaemonMeshSession> {
  const transport = options.transport
  const authTimeoutMs = options.authTimeoutMs ?? DEFAULT_AUTH_TIMEOUT_MS
  const nonceCache = options.nonceCache ?? new NonceReplayCache()
  const mailbox = new Mailbox()
  let phase: 'noise' | 'app-auth' | 'session' | 'closed' = 'noise'
  let tx: CipherState | undefined
  let rx: CipherState | undefined
  let session: MeshSessionImpl | undefined
  let deadline: ReturnType<typeof setTimeout> | undefined
  let firstFrameTimer: ReturnType<typeof setTimeout> | undefined
  let failure: MeshChannelError | undefined
  let pairingPending = false

  const clearFirstFrameTimer = (): void => {
    if (firstFrameTimer !== undefined) clearTimeout(firstFrameTimer)
    firstFrameTimer = undefined
  }

  const fail = (error: MeshChannelError): void => {
    if (phase === 'closed' || failure) return
    failure = error
    phase = 'closed'
    if (deadline) clearTimeout(deadline)
    clearFirstFrameTimer()
    mailbox.fail(error)
    try {
      transport.close(error.closeCode, error.code)
    } catch {
      // transport already gone
    }
  }

  const sendFrame = (frame: Uint8Array): void => {
    if (phase === 'closed') throw failure ?? new MeshChannelError('mesh/internal', 'channel closed', MeshCloseCode.ProtocolError)
    try {
      transport.send(frame)
    } catch {
      const error = new MeshChannelError('mesh/internal', 'transport closed', MeshCloseCode.ProtocolError)
      fail(error)
      throw error
    }
  }

  const sendSealed = (plaintext: Uint8Array): void => {
    if (!tx) throw new MeshChannelError('mesh/internal', 'cipher state missing', MeshCloseCode.ProtocolError)
    if (plaintext.length > 64 * 1024) {
      throw new MeshChannelError('mesh/bad-request', 'session message too large', MeshCloseCode.ProtocolError)
    }
    sendFrame(toFrame(MessageKind.Sealed, tx.encryptWithAd(EMPTY, plaintext)))
  }

  transport.onClose(() => {
    if (phase !== 'closed') {
      phase = 'closed'
      if (deadline) clearTimeout(deadline)
      clearFirstFrameTimer()
      mailbox.fail(new MeshChannelError('mesh/internal', 'transport closed before authentication completed', MeshCloseCode.ProtocolError))
    }
  })

  deadline = setTimeout(() => {
    fail(new MeshChannelError('mesh/unauthorized', 'authentication timed out', MeshCloseCode.Timeout))
  }, authTimeoutMs)

  const onMessage = (frame: Uint8Array): void => {
    if (phase === 'closed') return
    if (phase === 'session') {
      if (!session) return
      try {
        const plaintext = decryptSealedFrame(frame, rx)
        if (!plaintext) {
          fail(new MeshChannelError('mesh/crypto', 'message authentication failed', MeshCloseCode.CryptoError))
          return
        }
        session.handlePlaintext(plaintext)
      } catch (error) {
        fail(error instanceof MeshChannelError ? error : new MeshChannelError('mesh/crypto', 'invalid sealed frame', MeshCloseCode.CryptoError))
      }
      return
    }
    mailbox.push(frame)
  }
  transport.onMessage(onMessage)

  try {
    // --- Noise msg1 (-> e, es) -------------------------------------------
    firstFrameTimer = setTimeout(() => {
      fail(new MeshChannelError('mesh/unauthorized', 'handshake timed out', MeshCloseCode.Timeout))
    }, options.firstFrameTimeoutMs ?? DEFAULT_FIRST_FRAME_TIMEOUT_MS)
    firstFrameTimer.unref?.()
    const frame1 = await mailbox.next().finally(clearFirstFrameTimer)
    assertHandshakeFrame(frame1, NOISE_MAX_HANDSHAKE_MESSAGE)
    const handshake = new NoiseNkHandshake({
      role: 'responder',
      localStaticPrivateKey: x25519PrivateFromPkcs8(identity.dhSk),
    })
    let payload: Uint8Array
    try {
      payload = handshake.readMessage(frame1.subarray(1))
    } catch (error) {
      throw noiseErrorToChannelError(error)
    }
    if (payload.length !== 0) {
      throw new MeshChannelError('mesh/bad-request', 'handshake payload must be empty', MeshCloseCode.ProtocolError)
    }
    const message2 = handshake.writeMessage()
    sendFrame(toFrame(MessageKind.Handshake, message2))
    const handshakeHash = handshake.handshakeHash
    const transportPair = handshake.split()
    tx = transportPair.tx
    rx = transportPair.rx
    handshake.destroy()
    phase = 'app-auth'

    // --- ClientAuth ------------------------------------------------------
    const authFrame = await mailbox.next()
    const authBytes = decryptSealedFrame(authFrame, rx)
    if (!authBytes) {
      throw new MeshChannelError('mesh/crypto', 'message authentication failed', MeshCloseCode.CryptoError)
    }
    const clientAuth = parseClientAuth(unwrapControlMessage(authBytes))
    if (clientAuth.v !== PROTOCOL_VERSION) {
      throw new MeshChannelError('mesh/version-mismatch', 'unsupported protocol version', MeshCloseCode.ProtocolError)
    }
    const controller = parseDeviceDescriptor(clientAuth.controller)
    const nonce = decodeFixed(clientAuth.nonce, 32)
    if (!nonce) {
      throw new MeshChannelError('mesh/bad-request', 'invalid client nonce', MeshCloseCode.ProtocolError)
    }
    if (!nonceCache.checkAndRecord(nonce)) {
      throw new MeshChannelError('mesh/unauthorized', 'duplicate client nonce', MeshCloseCode.Unauthorized)
    }
    if (clientAuth.auth.kind === 'pair-token' && clientAuth.auth.daemonId !== identity.deviceId) {
      throw new MeshChannelError('mesh/unauthorized', 'pairing token target mismatch', MeshCloseCode.Unauthorized)
    }
    const sas = computeSas(handshakeHash, controller.signPk, identity.signPk)
    const outcome = await options.authenticate({
      client: clientAuth,
      clientNonce: nonce,
      handshakeHash,
      sas,
      transportKind: transport.kind,
      remoteLabel: transport.remoteLabel,
    })
    validateAuthOutcome(outcome, clientAuth, controller, handshakeHash)

    let pairing: { approval: 'none' } | { approval: 'pending'; requestId: string }
    let serverAuth: ServerAuthMessage
    if (outcome.kind === 'paired') {
      pairing = { approval: 'none' }
      serverAuth = {
        t: 'server_auth',
        v: PROTOCOL_VERSION,
        daemon: deviceDescriptorOf(identity),
        approval: 'none',
        sig: signServerAuth(identity.signSk, handshakeHash, nonce),
      }
    } else {
      if (clientAuth.auth.kind !== 'pair-token') {
        throw new MeshChannelError('mesh/unauthorized', 'paired sessions cannot require approval', MeshCloseCode.Unauthorized)
      }
      pairingPending = true
      const pendingRequestId = sanitizeId(outcome.requestId)
      if (pendingRequestId.length === 0) {
        throw new MeshChannelError('mesh/internal', 'pairing approval request id is invalid', MeshCloseCode.ProtocolError)
      }
      pairing = { approval: 'pending', requestId: pendingRequestId }
      serverAuth = {
        t: 'server_auth',
        v: PROTOCOL_VERSION,
        daemon: deviceDescriptorOf(identity),
        approval: 'pending',
        requestId: pendingRequestId,
        sig: signServerAuth(identity.signSk, handshakeHash, nonce),
      }
    }
    sendSealed(controlJsonFrame(serverAuth))

    const bridge: SessionBridge = {
      role: 'daemon',
      remote: controller,
      sas,
      pairing,
      // The session must observe the live gate: after local approval, the
      // broker's prune must stop treating this session as a first-contact one.
      isPairingPending: () => pairingPending,
      sendPlaintext: (plaintext) =>{  sendSealed(plaintext) },
      onTransportClose: listener => transport.onClose(listener),
      closeTransport: (code, reason) =>{  transport.close(code, reason) },
      bufferedAmount: () => transport.bufferedAmount,
    }
    session = createSession(bridge, {
      handlers: options.handlers,
      ...(options.info === undefined ? {} : { info: options.info }),
      ...options.session,
      authorizeRpc: (method) => {
        // Until the local user approves the pairing request, only `pair.status`
        // may be called (docs/PROTOCOL.md §4.2 rule 3).
        if (pairingPending && method !== 'pair.status') return 'mesh/unauthorized'
        return undefined
      },
    })
    phase = 'session'
    if (deadline) {
      clearTimeout(deadline)
      deadline = undefined
    }

    if (outcome.kind === 'pair-approval-required') {
      void outcome.decide
        .then((decision) => {
          if (!decision.approved) {
            pairingPending = false
            transport.close(MeshCloseCode.Unauthorized, 'mesh/unauthorized')
            return
          }
          pairingPending = false
        })
        .catch(() => {
          pairingPending = false
          transport.close(MeshCloseCode.Unauthorized, 'mesh/unauthorized')
        })
    }
    return session
  } catch (error) {
    const channelError = error instanceof MeshChannelError ? error : mapAuthError(error)
    fail(channelError)
    throw channelError
  }
}

// ---------------------------------------------------------------------------
// Parsing / validation helpers
// ---------------------------------------------------------------------------

/** Strip the sealed plaintext `0x10` control prefix and enforce the size cap. */
function unwrapControlMessage(plaintext: Uint8Array): Uint8Array {
  if (plaintext.length < 2 || plaintext[0] !== MessageKind.Control) {
    throw new MeshChannelError('mesh/bad-request', 'expected a control message', MeshCloseCode.ProtocolError)
  }
  const body = plaintext.subarray(1)
  if (body.length > MAX_APP_AUTH_MESSAGE_BYTES) {
    throw new MeshChannelError('mesh/bad-request', 'application authentication message too large', MeshCloseCode.ProtocolError)
  }
  return body
}

function controlJsonFrame(message: unknown): Uint8Array {
  const body = new TextEncoder().encode(JSON.stringify(message))
  if (body.length > MAX_APP_AUTH_MESSAGE_BYTES) {
    throw new MeshChannelError('mesh/bad-request', 'application authentication message too large', MeshCloseCode.ProtocolError)
  }
  return toFrame(MessageKind.Control, body)
}

function assertHandshakeFrame(frame: Uint8Array, maxMessageBytes: number): void {
  if (frame.length < 1 || frame[0] !== MessageKind.Handshake) {
    throw new MeshChannelError('mesh/bad-request', 'expected a Noise handshake frame', MeshCloseCode.ProtocolError)
  }
  if (frame.length - 1 > maxMessageBytes) {
    throw new MeshChannelError('mesh/bad-request', 'handshake message too large', MeshCloseCode.ProtocolError)
  }
}

/** Decrypt a `0x02` sealed frame; returns `undefined` on authentication failure. */
function decryptSealedFrame(frame: Uint8Array, rx: CipherState | undefined): Uint8Array | undefined {
  if (!rx) return undefined
  if (frame.length < 1 || frame[0] !== MessageKind.Sealed) {
    throw new MeshChannelError('mesh/bad-request', 'expected a sealed frame', MeshCloseCode.ProtocolError)
  }
  const ciphertext = frame.subarray(1)
  if (ciphertext.length < NOISE_TAG_LEN || ciphertext.length > 64 * 1024 + NOISE_TAG_LEN) {
    throw new MeshChannelError('mesh/bad-request', 'invalid sealed frame length', MeshCloseCode.ProtocolError)
  }
  try {
    return rx.decryptWithAd(EMPTY, ciphertext)
  } catch (error) {
    if (error instanceof NoiseError && error.code === 'noise/decrypt-failed') return undefined
    throw error
  }
}

function noiseErrorToChannelError(error: unknown): MeshChannelError {
  if (error instanceof MeshChannelError) return error
  if (error instanceof NoiseError) {
    if (error.code === 'noise/decrypt-failed') {
      return new MeshChannelError('mesh/crypto', 'handshake authentication failed', MeshCloseCode.CryptoError)
    }
    return new MeshChannelError('mesh/bad-request', 'invalid handshake message', MeshCloseCode.ProtocolError)
  }
  return new MeshChannelError('mesh/internal', 'handshake failed', MeshCloseCode.ProtocolError)
}

function parseClientAuth(body: Uint8Array): ClientAuthMessage {
  const parsed = decodeJson(body)
  if (!isPlainObject(parsed) || parsed.t !== 'client_auth' || typeof parsed.v !== 'number') {
    throw new MeshChannelError('mesh/bad-request', 'invalid client_auth message', MeshCloseCode.ProtocolError)
  }
  if (!isPlainObject(parsed.controller) || typeof parsed.nonce !== 'string' || !isPlainObject(parsed.auth)) {
    throw new MeshChannelError('mesh/bad-request', 'invalid client_auth fields', MeshCloseCode.ProtocolError)
  }
  const auth = parsed.auth
  if (auth.kind === 'paired') {
    if (typeof auth.sig !== 'string' || decodeFixed(auth.sig, 64) === undefined) {
      throw new MeshChannelError('mesh/bad-request', 'invalid client_auth signature', MeshCloseCode.ProtocolError)
    }
    return parsed as unknown as ClientAuthMessage
  }
  if (auth.kind === 'pair-token') {
    if (typeof auth.daemonId !== 'string' || decodeFixed(auth.token, 32) === undefined) {
      throw new MeshChannelError('mesh/bad-request', 'invalid pair-token fields', MeshCloseCode.ProtocolError)
    }
    return parsed as unknown as ClientAuthMessage
  }
  throw new MeshChannelError('mesh/bad-request', 'unknown client_auth kind', MeshCloseCode.ProtocolError)
}

function parseServerAuth(body: Uint8Array): ServerAuthMessage {
  const parsed = decodeJson(body)
  if (!isPlainObject(parsed) || parsed.t !== 'server_auth' || typeof parsed.v !== 'number') {
    throw new MeshChannelError('mesh/bad-request', 'invalid server_auth message', MeshCloseCode.ProtocolError)
  }
  if (
    !isPlainObject(parsed.daemon) ||
    typeof parsed.sig !== 'string' ||
    decodeFixed(parsed.sig, 64) === undefined ||
    (parsed.approval !== 'none' && parsed.approval !== 'pending')
  ) {
    throw new MeshChannelError('mesh/bad-request', 'invalid server_auth fields', MeshCloseCode.ProtocolError)
  }
  return parsed as unknown as ServerAuthMessage
}

function validateAuthOutcome(
  outcome: DaemonAuthOutcome,
  clientAuth: ClientAuthMessage,
  controller: DeviceDescriptor,
  handshakeHash: Uint8Array,
): void {
  if (outcome.kind === 'paired') {
    // A paired grant can only authorize the signature-based `paired` flow. A
    // first-contact `pair-token` message has no controller signature, so an
    // authenticator that returns `paired` for it would bypass authentication.
    if (clientAuth.auth.kind !== 'paired') {
      throw new MeshChannelError(
        'mesh/unauthorized',
        'paired authorization requires paired client authentication',
        MeshCloseCode.Unauthorized,
      )
    }
    const peer = outcome.peer
    if (
      peer.deviceId !== controller.deviceId ||
      peer.signPk !== controller.signPk ||
      peer.dhPk !== controller.dhPk
    ) {
      throw new MeshChannelError('mesh/unauthorized', 'controller identity changed', MeshCloseCode.Unauthorized)
    }
    if (peer.revokedAt !== null) {
      throw new MeshChannelError('mesh/revoked', 'controller has been revoked', MeshCloseCode.Unauthorized)
    }
    if (peer.scope.expiresAt !== null && peer.scope.expiresAt * 1000 <= Date.now()) {
      throw new MeshChannelError('mesh/unauthorized', 'controller grant expired', MeshCloseCode.Unauthorized)
    }
    if (!verifyClientAuth(peer.signPk, handshakeHash, clientAuth.auth.sig)) {
      throw new MeshChannelError('mesh/unauthorized', 'invalid controller signature', MeshCloseCode.Unauthorized)
    }
    return
  }
  // pair-approval-required
  if (clientAuth.auth.kind !== 'pair-token') {
    throw new MeshChannelError('mesh/unauthorized', 'unknown controller must present a pairing token', MeshCloseCode.Unauthorized)
  }
  if (typeof outcome.requestId !== 'string' || outcome.requestId.length === 0) {
    throw new MeshChannelError('mesh/internal', 'pairing approval request id missing', MeshCloseCode.ProtocolError)
  }
}

function sanitizeId(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]/gu, '').slice(0, 128)
}

/**
 * Raw 32-byte X25519 private key from a base64url PKCS#8 identity value.
 * Kept local to avoid importing the (slightly heavier) file helpers in crypto.
 */
function x25519PrivateFromPkcs8(pkcs8Base64Url: string): Uint8Array {
  const der = fromBase64Url(pkcs8Base64Url)
  if (!der || der.length !== 48) {
    throw new MeshChannelError('mesh/internal', 'invalid identity Diffie-Hellman key', MeshCloseCode.ProtocolError)
  }
  return der.subarray(16, 48)
}

/** Re-export the session-side handler types so brokers only import `channel.ts`. */
export type { DaemonMeshSession, DaemonSessionHandlers, MeshSession }
/** Re-export transport close info for embedders. */
export type { TransportCloseInfo }
