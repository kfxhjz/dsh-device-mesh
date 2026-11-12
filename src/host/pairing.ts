/**
 * Pairing: QR / link creation, verification, one-time token handling, the
 * local approval queue, and the 6-digit SAS.
 *
 * The wire format is `dsh-mesh://pair?d=<base64url(JSON)>`; the JSON payload is
 * a `PairingTicket` (see `src/shared/protocol.ts` and PROTOCOL.md §2). The
 * Ed25519 signature covers the canonical JSON of every field except `sig`.
 *
 * One-time tokens are persisted only as SHA-256 hashes (`pairing.json`). A
 * token is reserved the moment it is presented and removed from disk before the
 * local approval prompt appears, so a crash can never leave a reusable token
 * behind; a denied or lost prompt simply means a fresh QR code is needed.
 */

import { randomBytes, randomUUID } from 'node:crypto'

import type {
  DeviceDescriptor,
  DeviceIdentity,
  PairingEndpoint,
  PairingRequest,
  PairingScope,
  PairingTicket,
  PeerRecord,
} from '../shared/protocol.ts'
import {
  PAIRING_URI_PREFIX,
  canonicalJson,
  decodeUtf8,
  encodeUtf8,
  fromBase64Url,
  toBase64Url,
} from '../shared/protocol.ts'
import {
  isLoopbackHostname,
  isRecord,
  MAX_PENDING_PAIRINGS,
  PAIRING_REQUEST_TTL_MS,
  PAIRING_TICKET_TTL_MS,
} from './config.ts'
import type { MeshStore } from './store.ts'
import { deviceIdFromSignPublicKey, sha256Hex, signEd25519, verifyEd25519 } from './crypto.ts'

/** File under the mesh state directory holding hashed one-time tokens. */
const PAIRING_FILE = 'pairing.json'

/** How long a decided request stays answerable by `pair.status`. */
const DECISION_RETENTION_MS = 5 * 60 * 1000

/** Maximum encoded ticket size accepted from a link (defensive bound). */
const MAX_TICKET_BYTES = 8 * 1024

/** Maximum endpoint URL length accepted from a ticket (defensive bound). */
const MAX_ENDPOINT_URL_LENGTH = 512

/** Maximum relay `serverId` length accepted from a ticket. */
const MAX_RELAY_SERVER_ID_LENGTH = 256

/** Relay `serverId` characters that would corrupt the query string. */
const RELAY_SERVER_ID_FORBIDDEN = /[\u0000-\u0020\u007f]/u

/** Structured pairing failure with a wire error code. */
export class PairingError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'PairingError'
  }
}

/**
 * Reject grants the current release cannot actually enforce.
 *
 * v1 implements only a full `control` grant over every workspace. Accepting a
 * `view` or workspace-limited scope would show the user a restricted pairing in
 * the UI while the broker continued to authorize full control, so such scopes
 * fail closed instead.
 *
 * @param scope - grant to validate (undefined means the default full control).
 * @throws {PairingError} `mesh/unsupported` for any restricted grant.
 */
export function assertSupportedPairingScope(scope: PairingScope | undefined): void {
  if (scope === undefined) return
  if (scope.kind !== 'control' || scope.workspaces !== 'all') {
    throw new PairingError(
      'mesh/unsupported',
      'view and workspace-limited pairing scopes are not supported yet',
    )
  }
}

// ---------------------------------------------------------------------------
// Pure ticket helpers
// ---------------------------------------------------------------------------

/** Unsigned ticket body (everything the signature covers). */
export type PairingTicketBody = Omit<PairingTicket, 'sig'>

/**
 * Hash a one-time pairing token for storage.
 * @param token - base64url token text.
 * @returns lowercase hex SHA-256.
 */
export function hashPairingToken(token: string): string {
  return sha256Hex(token)
}

/**
 * Build, sign and encode a pairing ticket.
 * @param options - signer identity, endpoints, token, expiry, clock.
 * @returns ticket plus its link and token hash.
 */
export function createPairingTicket(options: {
  readonly identity: DeviceIdentity
  readonly endpoints: readonly PairingEndpoint[]
  readonly token: string
  readonly now: number
  readonly ttlMs?: number
}): { readonly ticket: PairingTicket; readonly link: string; readonly tokenHash: string } {
  const ttlMs = options.ttlMs ?? PAIRING_TICKET_TTL_MS
  const exp = Math.floor((options.now + ttlMs) / 1000)
  const body: PairingTicketBody = {
    v: 1,
    id: options.identity.deviceId,
    name: options.identity.name,
    platform: options.identity.platform,
    signPk: options.identity.signPk,
    dhPk: options.identity.dhPk,
    eps: options.endpoints,
    tok: options.token,
    exp,
  }
  const sig = signEd25519(options.identity.signSk, encodeUtf8(canonicalJson(body)))
  const ticket: PairingTicket = { ...body, sig }
  return {
    ticket,
    link: `${PAIRING_URI_PREFIX}${toBase64Url(encodeUtf8(JSON.stringify(ticket)))}`,
    tokenHash: hashPairingToken(options.token),
  }
}

/**
 * Encode an already-signed ticket as a pairing URI.
 * @param ticket - signed ticket.
 * @returns `dsh-mesh://pair?d=…`.
 */
export function encodePairingLink(ticket: PairingTicket): string {
  return `${PAIRING_URI_PREFIX}${toBase64Url(encodeUtf8(JSON.stringify(ticket)))}`
}

function invalid(message: string): PairingError {
  return new PairingError('mesh/bad-request', message)
}

/**
 * Validate one endpoint URL carried by a ticket.
 *
 * A pairing link is untrusted input: the controller dials whatever endpoints the
 * ticket lists before the local user approves anything. Restrict endpoints to
 * WebSocket transports, reject embedded credentials, and keep a public relay on
 * TLS (SECURITY.md: a public relay must use `wss://`). Loopback `ws://` stays
 * accepted for a local relay and for the isolated two-instance E2E runs.
 *
 * The original string is returned unchanged: ticket signatures cover the
 * canonical JSON of the endpoint objects, so normalizing the URL here would make
 * a valid ticket fail verification.
 *
 * @param kind - endpoint kind, for error messages.
 * @param url - raw endpoint URL from the ticket.
 * @returns the validated URL text, unchanged.
 * @throws {PairingError} when the endpoint would be dialed unsafely.
 */
function parseEndpointUrl(kind: 'direct' | 'relay', url: unknown): string {
  if (typeof url !== 'string' || url.length === 0) {
    throw invalid(`pairing ticket ${kind} endpoint has no url`)
  }
  if (url.length > MAX_ENDPOINT_URL_LENGTH) {
    throw invalid(`pairing ticket ${kind} endpoint url is too long`)
  }
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw invalid(`pairing ticket ${kind} endpoint is not a valid url`)
  }
  if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') {
    throw invalid(`pairing ticket ${kind} endpoint must use ws:// or wss://`)
  }
  if (parsed.username.length > 0 || parsed.password.length > 0) {
    throw invalid(`pairing ticket ${kind} endpoint must not carry credentials`)
  }
  if (parsed.hostname.length === 0) {
    throw invalid(`pairing ticket ${kind} endpoint has no host`)
  }
  if (kind === 'relay' && parsed.protocol === 'ws:' && !isLoopbackHostname(parsed.hostname)) {
    throw invalid('pairing ticket relay endpoint must use wss:// for non-loopback hosts')
  }
  return url
}

function parseEndpoint(value: unknown): PairingEndpoint {
  if (!isRecord(value)) throw invalid('pairing ticket endpoint is not an object')
  if (value.k === 'direct') {
    return { k: 'direct', url: parseEndpointUrl('direct', value.url) }
  }
  if (value.k === 'relay') {
    const url = parseEndpointUrl('relay', value.url)
    if (typeof value.sid !== 'string' || value.sid.length === 0) {
      throw invalid('pairing ticket relay endpoint has no server id')
    }
    if (value.sid.length > MAX_RELAY_SERVER_ID_LENGTH || RELAY_SERVER_ID_FORBIDDEN.test(value.sid)) {
      throw invalid('pairing ticket relay server id is invalid')
    }
    if (value.v !== 1 && value.v !== 2) throw invalid('pairing ticket relay generation is invalid')
    return { k: 'relay', url, sid: value.sid, v: value.v }
  }
  throw invalid('pairing ticket endpoint kind is unknown')
}

function isKey32(value: unknown): value is string {
  const raw = typeof value === 'string' ? fromBase64Url(value) : undefined
  return raw !== undefined && raw.byteLength === 32
}

/**
 * Validate one decoded ticket object (shape + device id + signature).
 * @param value - decoded JSON value.
 * @returns the verified ticket.
 * @throws {PairingError} when anything does not check out.
 */
export function verifyPairingTicket(value: unknown): PairingTicket {
  if (!isRecord(value)) throw invalid('pairing ticket is not an object')
  if (value.v !== 1) throw new PairingError('mesh/version-mismatch', 'pairing ticket version is not 1')
  if (typeof value.id !== 'string' || value.id.length === 0) throw invalid('pairing ticket has no device id')
  if (typeof value.name !== 'string') throw invalid('pairing ticket has no device name')
  if (value.platform !== 'darwin' && value.platform !== 'linux' && value.platform !== 'win32'
    && value.platform !== 'android' && value.platform !== 'ios' && value.platform !== 'web'
    && value.platform !== 'unknown') {
    throw invalid('pairing ticket platform is unknown')
  }
  if (!isKey32(value.signPk)) throw invalid('pairing ticket signing key is invalid')
  if (!isKey32(value.dhPk)) throw invalid('pairing ticket DH key is invalid')
  if (!Array.isArray(value.eps) || value.eps.length === 0) throw invalid('pairing ticket has no endpoints')
  if (typeof value.tok !== 'string' || fromBase64Url(value.tok)?.byteLength !== 32) {
    throw invalid('pairing ticket token is invalid')
  }
  if (typeof value.exp !== 'number' || !Number.isSafeInteger(value.exp)) {
    throw invalid('pairing ticket expiry is invalid')
  }
  if (typeof value.sig !== 'string' || fromBase64Url(value.sig)?.byteLength !== 64) {
    throw invalid('pairing ticket signature is missing')
  }
  let derived: string
  try {
    derived = deviceIdFromSignPublicKey(value.signPk)
  } catch {
    throw invalid('pairing ticket signing key is invalid')
  }
  if (derived !== value.id) {
    throw invalid('pairing ticket device id does not match its signing key')
  }
  const ticket: PairingTicket = {
    v: 1,
    id: value.id,
    name: value.name,
    platform: value.platform,
    signPk: value.signPk,
    dhPk: value.dhPk,
    eps: value.eps.map(parseEndpoint),
    tok: value.tok,
    exp: value.exp,
    sig: value.sig,
  }
  const body: PairingTicketBody = {
    v: ticket.v,
    id: ticket.id,
    name: ticket.name,
    platform: ticket.platform,
    signPk: ticket.signPk,
    dhPk: ticket.dhPk,
    eps: ticket.eps,
    tok: ticket.tok,
    exp: ticket.exp,
  }
  if (!verifyEd25519(ticket.signPk, encodeUtf8(canonicalJson(body)), ticket.sig)) {
    throw invalid('pairing ticket signature does not verify')
  }
  return ticket
}

/**
 * Parse and verify a pairing link.
 * @param link - `dsh-mesh://pair?d=…` (whitespace tolerated).
 * @param nowMs - current time for expiry checking.
 * @returns verified ticket.
 * @throws {PairingError} with a stable code.
 */
export function parsePairingLink(link: string, nowMs: number = Date.now()): PairingTicket {
  const trimmed = typeof link === 'string' ? link.trim() : ''
  if (!trimmed.startsWith(PAIRING_URI_PREFIX)) {
    throw invalid('pairing link must start with dsh-mesh://pair?d=')
  }
  const encoded = trimmed.slice(PAIRING_URI_PREFIX.length)
  if (encoded.length === 0 || encoded.length > MAX_TICKET_BYTES) {
    throw invalid('pairing link payload length is invalid')
  }
  const bytes = fromBase64Url(encoded)
  if (bytes === undefined) throw invalid('pairing link payload is not base64url')
  let parsed: unknown
  try {
    parsed = JSON.parse(decodeUtf8(bytes)) as unknown
  } catch {
    throw invalid('pairing link payload is not JSON')
  }
  const ticket = verifyPairingTicket(parsed)
  if (ticket.exp * 1000 <= nowMs) {
    throw new PairingError('mesh/unauthorized', 'pairing ticket has expired')
  }
  return ticket
}

// ---------------------------------------------------------------------------
// SAS (single source of truth: `crypto.ts`, shared with the channel layer)
// ---------------------------------------------------------------------------

export { computeSas } from './crypto.ts'

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/** Result of accepting a one-time pairing token. */
export type PairTokenCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: string; readonly message: string }

/** A pending local-approval request and the promise the session layer awaits. */
export interface PendingApproval {
  readonly request: PairingRequest
  readonly decide: Promise<{ readonly approved: boolean }>
}

/** Outcome of the local user decision, as polled by `pair.status`. */
export interface PairingStatus {
  readonly state: 'pending' | 'approved' | 'denied'
  readonly peer?: PeerRecord
}

/** Persisted token-hash document. */
interface PairingFileDocument {
  readonly version: 1
  readonly tickets: readonly { readonly hash: string; readonly exp: number }[]
}

interface RequestEntry {
  readonly request: PairingRequest
  readonly peer: DeviceDescriptor
  readonly expiresAt: number
  readonly promise: Promise<{ readonly approved: boolean }>
  resolve: (decision: { readonly approved: boolean }) => void
  state: 'pending' | 'approved' | 'denied'
  scope: PairingScope | undefined
  timer: NodeJS.Timeout | undefined
}

interface DecisionEntry {
  readonly state: 'approved' | 'denied'
  readonly peer: DeviceDescriptor
  readonly at: number
  readonly scope: PairingScope | undefined
}

/** Options for {@link PairingService}. */
export interface PairingServiceOptions {
  readonly identity: DeviceIdentity
  readonly store: MeshStore
  readonly now?: () => number
  readonly ttlMs?: number
  readonly requestTtlMs?: number
  readonly autoApprove?: () => boolean
  readonly randomToken?: () => string
}

/**
 * Daemon-side pairing state: outstanding one-time tokens (hashed), the local
 * approval queue, and the recent-decision cache used by `pair.status`.
 */
export class PairingService {
  private readonly identity: DeviceIdentity
  private readonly store: MeshStore
  private readonly now: () => number
  private readonly ttlMs: number
  private readonly requestTtlMs: number
  private readonly autoApprove: () => boolean
  private readonly randomToken: () => string

  /** token hash → expiry (unix ms). */
  private readonly tickets = new Map<string, number>()
  /** Token hash → reservation time (already removed from disk). */
  private readonly reserved = new Map<string, number>()
  private readonly requests = new Map<string, RequestEntry>()
  private readonly decisions = new Map<string, DecisionEntry>()

  constructor(options: PairingServiceOptions) {
    this.identity = options.identity
    this.store = options.store
    this.now = options.now ?? Date.now
    this.ttlMs = options.ttlMs ?? PAIRING_TICKET_TTL_MS
    this.requestTtlMs = options.requestTtlMs ?? PAIRING_REQUEST_TTL_MS
    this.autoApprove = options.autoApprove ?? (() => false)
    this.randomToken = options.randomToken ?? (() => toBase64Url(randomBytes(32)))
  }

  /** Load persisted token hashes and drop anything already expired. */
  async init(): Promise<void> {
    const raw = await this.store.readPrivateJson(PAIRING_FILE)
    if (isRecord(raw) && raw.version === 1 && Array.isArray(raw.tickets)) {
      const now = this.now()
      for (const row of raw.tickets) {
        if (!isRecord(row)) continue
        if (typeof row.hash !== 'string' || typeof row.exp !== 'number') continue
        if (row.exp > now) this.tickets.set(row.hash, row.exp)
      }
    }
  }

  /** Number of outstanding (unused, unexpired) one-time tokens. */
  get pendingTicketCount(): number {
    return this.tickets.size
  }

  /** Number of queue entries currently awaiting a local decision. */
  get pendingRequestCount(): number {
    return this.pendingRequests().length
  }

  /**
   * Create and sign a fresh pairing ticket, persisting only the token hash.
   * @param endpoints - reachable endpoints to advertise, in preference order.
   * @returns ticket, link and expiry.
   */
  async createTicket(endpoints: readonly PairingEndpoint[]): Promise<{
    readonly ticket: PairingTicket
    readonly link: string
    readonly expiresAtMs: number
  }> {
    if (endpoints.length === 0) {
      throw new PairingError('mesh/unsupported', 'no reachable endpoint to put in a pairing ticket')
    }
    let token = this.randomToken()
    for (let attempt = 0; attempt < 4 && this.tickets.has(hashPairingToken(token)); attempt += 1) {
      token = this.randomToken()
    }
    const created = createPairingTicket({
      identity: this.identity,
      endpoints,
      token,
      now: this.now(),
      ttlMs: this.ttlMs,
    })
    await this.store.updatePrivateJson(PAIRING_FILE, (current) => {
      const tickets = readPersistedTickets(current)
      const now = this.now()
      for (const [hash, expiresAt] of tickets) {
        if (expiresAt <= now) tickets.delete(hash)
      }
      tickets.set(created.tokenHash, created.ticket.exp * 1000)
      this.replaceTickets(tickets)
      return { result: undefined, next: pairingDocument(tickets) }
    })
    await this.store.appendAudit({ action: 'pairing.ticket.created', peer: this.identity.deviceId })
    return {
      ticket: created.ticket,
      link: created.link,
      expiresAtMs: created.ticket.exp * 1000,
    }
  }

  /**
   * Reserve a presented one-time token for pairing.
   *
   * The token is removed from persistent storage before the local approval
   * prompt: a second use (concurrent or after a crash) is rejected.
   *
   * @param daemonId - daemon id the controller believes it is pairing with.
   * @param token - base64url token from the QR code.
   * @returns ok, or a stable failure code.
   */
  async beginPairToken(daemonId: string, token: string): Promise<PairTokenCheck> {
    if (daemonId !== this.identity.deviceId) {
      return { ok: false, code: 'mesh/unauthorized', message: 'pairing ticket belongs to another device' }
    }
    const hash = hashPairingToken(token)
    return await this.store.updatePrivateJson<PairTokenCheck>(PAIRING_FILE, (current) => {
      const tickets = readPersistedTickets(current)
      const now = this.now()
      for (const [candidate, expiresAt] of tickets) {
        if (expiresAt <= now) tickets.delete(candidate)
      }
      const refusal = (message: string): { result: PairTokenCheck; next: PairingFileDocument } => {
        this.replaceTickets(tickets)
        return {
          result: { ok: false, code: 'mesh/unauthorized', message },
          next: pairingDocument(tickets),
        }
      }
      const expiresAt = tickets.get(hash)
      if (expiresAt === undefined || this.reserved.has(hash)) {
        return refusal('pairing token is unknown, used or expired')
      }
      if (expiresAt <= now) return refusal('pairing token has expired')
      tickets.delete(hash)
      this.reserved.set(hash, this.now())
      this.replaceTickets(tickets)
      return { result: { ok: true }, next: pairingDocument(tickets) }
    })
  }

  /**
   * Queue a local-approval prompt for an authenticated pairing attempt.
   * @param peer - controller descriptor from `client_auth`.
   * @param sas - 6-digit SAS derived from the handshake.
   * @returns the request row plus the promise the session layer awaits.
   * @throws {PairingError} when the queue is full.
   */
  requestApproval(peer: DeviceDescriptor, sas: string): PendingApproval {
    this.pruneExpired()
    const pending = this.pendingRequests()
    if (pending.length >= MAX_PENDING_PAIRINGS) {
      throw new PairingError('mesh/busy', 'too many pending pairing requests')
    }
    const requestId = randomUUID()
    const request: PairingRequest = {
      requestId,
      peer,
      sas,
      createdAt: new Date(this.now()).toISOString(),
    }
    let resolve!: (decision: { readonly approved: boolean }) => void
    const promise = new Promise<{ readonly approved: boolean }>((settle) => {
      resolve = settle
    })
    const entry: RequestEntry = {
      request,
      peer,
      expiresAt: this.now() + this.requestTtlMs,
      promise,
      resolve,
      state: 'pending',
      scope: undefined,
      timer: undefined,
    }
    entry.timer = setTimeout(() => {
      this.deny(requestId, 'pairing request timed out')
    }, this.requestTtlMs)
    entry.timer.unref?.()
    this.requests.set(requestId, entry)
    void this.store.appendAudit({ action: 'pairing.requested', peer: peer.deviceId })
    if (this.autoApprove()) {
      // Discouraged but supported: the setting is explicit in settings.json.
      this.approve(requestId)
    }
    return { request, decide: entry.promise }
  }

  /**
   * Approve one pending request.
   * @param requestId - request to approve.
   * @param scope - grant chosen at approval time (default `control`/`all`).
   * @returns the approved request, or `undefined` when unknown/decided.
   */
  approve(requestId: string, scope?: PairingScope): PairingRequest | undefined {
    const entry = this.requests.get(requestId)
    if (entry === undefined || entry.state !== 'pending') return undefined
    // The approval timer is best effort; never approve a request that already
    // outlived its TTL (the broker's pending re-check relies on this too).
    if (entry.expiresAt <= this.now()) {
      this.deny(requestId, 'pairing request timed out')
      return undefined
    }
    // A restricted grant would not be enforced by the broker's RPC scope check
    // in v1, so refuse it before the decision reaches the controller.
    assertSupportedPairingScope(scope)
    entry.state = 'approved'
    entry.scope = scope ?? entry.scope ?? { kind: 'control', workspaces: 'all', expiresAt: null }
    if (entry.timer !== undefined) clearTimeout(entry.timer)
    entry.resolve({ approved: true })
    this.decisions.set(requestId, {
      state: 'approved',
      peer: entry.peer,
      at: this.now(),
      scope: entry.scope,
    })
    void this.store.appendAudit({ action: 'pairing.approved', peer: entry.peer.deviceId })
    return entry.request
  }

  /**
   * Deny (or time out) one pending request.
   * @param requestId - request to deny.
   * @param detail - optional audit detail (never secrets).
   * @returns the denied request, or `undefined` when unknown/decided.
   */
  deny(requestId: string, detail?: string): PairingRequest | undefined {
    const entry = this.requests.get(requestId)
    if (entry === undefined || entry.state !== 'pending') return undefined
    entry.state = 'denied'
    if (entry.timer !== undefined) clearTimeout(entry.timer)
    entry.resolve({ approved: false })
    this.decisions.set(requestId, {
      state: 'denied',
      peer: entry.peer,
      at: this.now(),
      scope: undefined,
    })
    void this.store.appendAudit({
      action: 'pairing.denied',
      peer: entry.peer.deviceId,
      ...(detail !== undefined ? { detail } : {}),
    })
    return entry.request
  }

  /** Pending requests, oldest first. */
  listPending(): PairingRequest[] {
    this.pruneExpired()
    return this.pendingRequests().map(entry => entry.request)
  }

  /**
   * Deny every pending request belonging to one peer and invalidate an earlier
   * approval decision, so a later `approve` can never resurrect a peer that the
   * local user just revoked or forgot (M8).
   *
   * @param deviceId - peer whose outstanding pairing work must be cancelled.
   * @param detail - audit detail; never contains secrets.
   * @returns number of still-pending requests that were denied.
   */
  cancelPeer(deviceId: string, detail = 'peer was revoked or forgotten'): number {
    let canceled = 0
    for (const entry of [...this.requests.values()]) {
      if (entry.peer.deviceId !== deviceId) continue
      if (entry.state !== 'pending') continue
      entry.state = 'denied'
      if (entry.timer !== undefined) clearTimeout(entry.timer)
      entry.timer = undefined
      entry.resolve({ approved: false })
      this.decisions.set(entry.request.requestId, {
        state: 'denied',
        peer: entry.peer,
        at: this.now(),
        scope: undefined,
      })
      void this.store.appendAudit({
        action: 'pairing.denied',
        peer: deviceId,
        ...(detail !== '' ? { detail } : {}),
      })
      canceled += 1
    }
    // A previous approval of this peer must not be reported again either.
    for (const [requestId, decision] of [...this.decisions]) {
      if (decision.peer.deviceId !== deviceId) continue
      if (decision.state !== 'approved') continue
      this.decisions.set(requestId, {
        state: 'denied',
        peer: decision.peer,
        at: decision.at,
        scope: undefined,
      })
    }
    return canceled
  }

  /**
   * Look up the decision for `pair.status`.
   * @param requestId - request id from `server_auth`.
   * @returns current state, plus the persisted peer when approved.
   */
  getStatus(requestId: string): PairingStatus {
    this.pruneExpired()
    const pending = this.requests.get(requestId)
    if (pending !== undefined && pending.state === 'pending') return { state: 'pending' }
    const decision = this.decisions.get(requestId)
    if (decision === undefined) {
      if (pending !== undefined) return { state: pending.state }
      return { state: 'denied' }
    }
    if (decision.state === 'denied') return { state: 'denied' }
    const peer = this.store.findPeer('controllers', decision.peer.deviceId)
    return peer !== undefined ? { state: 'approved', peer } : { state: 'approved' }
  }

  /** Scope chosen when the request was approved (used when persisting the peer). */
  scopeOf(requestId: string): PairingScope | undefined {
    return this.requests.get(requestId)?.scope ?? this.decisions.get(requestId)?.scope
  }

  /** Peer descriptor of a request (used when persisting the peer). */
  peerOf(requestId: string): DeviceDescriptor | undefined {
    return this.requests.get(requestId)?.peer ?? this.decisions.get(requestId)?.peer
  }

  /**
   * Drop expired tickets/decisions and auto-deny timed-out requests.
   * Safe to call at any time; every public method calls it.
   */
  pruneExpired(): void {
    const now = this.now()
    for (const [hash, expiresAt] of [...this.tickets]) {
      if (expiresAt <= now) this.tickets.delete(hash)
    }
    for (const [hash, reservedAt] of [...this.reserved]) {
      if (now - reservedAt > this.requestTtlMs) this.reserved.delete(hash)
    }
    for (const entry of [...this.requests.values()]) {
      if (entry.state === 'pending' && entry.expiresAt <= now) {
        this.deny(entry.request.requestId, 'pairing request timed out')
      }
    }
    for (const [requestId, decision] of [...this.decisions]) {
      if (now - decision.at > DECISION_RETENTION_MS) this.decisions.delete(requestId)
    }
  }

  /** Resolve every pending request as denied and clear timers (plugin stop). */
  stop(): void {
    for (const entry of [...this.requests.values()]) {
      if (entry.state === 'pending') {
        entry.state = 'denied'
        if (entry.timer !== undefined) clearTimeout(entry.timer)
        entry.resolve({ approved: false })
      }
    }
    this.requests.clear()
    this.reserved.clear()
  }

  private pendingRequests(): RequestEntry[] {
    return [...this.requests.values()].filter(entry => entry.state === 'pending')
  }

  /** Replace the in-memory ticket mirror after a locked disk mutation. */
  private replaceTickets(tickets: ReadonlyMap<string, number>): void {
    this.tickets.clear()
    for (const [hash, expiresAt] of tickets) this.tickets.set(hash, expiresAt)
  }
}

/** Parse the persisted token document, keeping only well-formed rows. */
function readPersistedTickets(raw: unknown): Map<string, number> {
  const tickets = new Map<string, number>()
  if (!isRecord(raw) || raw.version !== 1 || !Array.isArray(raw.tickets)) return tickets
  for (const row of raw.tickets) {
    if (!isRecord(row)) continue
    if (typeof row.hash !== 'string' || typeof row.exp !== 'number') continue
    if (row.hash.length === 0) continue
    tickets.set(row.hash, row.exp)
  }
  return tickets
}

/** Serialize a ticket map to the persisted document shape. */
function pairingDocument(tickets: ReadonlyMap<string, number>): PairingFileDocument {
  return {
    version: 1,
    tickets: [...tickets].map(([hash, exp]) => ({ hash, exp })),
  }
}
