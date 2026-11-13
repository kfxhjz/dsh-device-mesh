/**
 * Wire and local-API contracts for `dsh-device-mesh`.
 *
 * This module is imported by the Host plugin, the browser plugin and the tests.
 * It must stay free of `node:` imports and of DSH package imports so the client
 * bundle can inline it.
 *
 * The normative description of every field lives in `docs/PROTOCOL.md`. Keep the
 * two in sync: this file is the executable form of that document.
 */

/** Wire protocol version. Bumped only for incompatible changes. */
export const PROTOCOL_VERSION = 1 as const

/** First byte of every Mesh message (a WebSocket binary message). */
export const MessageKind = {
  /** Plaintext JSON during the handshake. */
  Handshake: 0x01,
  /** AEAD-sealed envelope after the handshake. */
  Sealed: 0x02,
  /** Sealed payload: JSON control message (RPC, events, pings). */
  Control: 0x10,
  /** Sealed payload: multiplexed stream chunk. */
  Stream: 0x11,
} as const

export type MessageKindValue = (typeof MessageKind)[keyof typeof MessageKind]

/** `MessageKind.Stream` flags. */
export const StreamFlag = {
  /** Ordinary data chunk. */
  Data: 0x01,
  /** End of the stream; no further chunks are allowed. */
  End: 0x02,
  /** Abort the stream; payload is a UTF-8 error code. */
  Abort: 0x04,
  /** The chunk completes one WebSocket message (WS-over-Mesh framing only). */
  MessageEnd: 0x08,
} as const

/** Maximum plaintext bytes carried by one Mesh message (before sealing). */
export const MAX_MESSAGE_BYTES = 64 * 1024

/** Maximum plaintext carried by one stream chunk. */
export const MAX_STREAM_CHUNK_BYTES = 32 * 1024

/** Default TCP port of a daemon's direct listener. */
export const DEFAULT_DIRECT_PORT = 45871

/** HTTP path of the local controller/daemon web API (same-origin, cookie-authenticated). */
export const LOCAL_API_PATH = '/api/device-mesh'

/** URI prefix of a pairing link. */
export const PAIRING_URI_PREFIX = 'dsh-mesh://pair?d='

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

/** Base64url (no padding) encoding of a raw 32-byte public key. */
export type PublicKeyB64 = string

/** A device's long-term identity. Private keys never leave the host. */
export interface DeviceKeys {
  /** Ed25519 raw public key (base64url). */
  readonly signPk: PublicKeyB64
  /** Ed25519 private key in base64url PKCS#8 (host only). */
  readonly signSk?: string
  /** X25519 raw public key (base64url). */
  readonly dhPk: PublicKeyB64
  /** X25519 private key in base64url PKCS#8 (host only). */
  readonly dhSk?: string
}

export type DevicePlatform = 'darwin' | 'linux' | 'win32' | 'android' | 'ios' | 'web' | 'unknown'

export interface DeviceIdentity {
  readonly version: 1
  /** `dm_` + 22 lowercase base32 chars derived from the Ed25519 public key. */
  readonly deviceId: string
  readonly name: string
  readonly platform: DevicePlatform
  readonly createdAt: string
  readonly signPk: PublicKeyB64
  readonly dhPk: PublicKeyB64
  /** Private halves; present only in the on-disk identity file. */
  readonly signSk: string
  readonly dhSk: string
}

/** The public part of a device identity, safe to put in a pairing ticket. */
export interface DeviceDescriptor {
  readonly deviceId: string
  readonly name: string
  readonly platform: DevicePlatform
  readonly signPk: PublicKeyB64
  readonly dhPk: PublicKeyB64
}

/** Capability list advertised in `info`. */
export type MeshCapability = 'rpc' | 'portal' | 'workspaces' | 'pairing' | 'relay'

export interface MeshInfo {
  readonly device: DeviceDescriptor & { readonly appVersion: string }
  readonly protocol: typeof PROTOCOL_VERSION
  readonly capabilities: readonly MeshCapability[]
  /** Human readable, never contains secrets. */
  readonly hostLabel: string
}

// ---------------------------------------------------------------------------
// Pairing
// ---------------------------------------------------------------------------

/** One reachable endpoint of a daemon, in preference order. */
export type PairingEndpoint =
  | { readonly k: 'direct'; readonly url: string }
  | {
    readonly k: 'relay'
    /** Base URL including `/ws`, e.g. `wss://relay.example.com/ws`. */
    readonly url: string
    /** Relay routing secret (`serverId`), never logged. */
    readonly sid: string
    /** Relay protocol generation: 2 (multi-client) or 1 (single client). */
    readonly v: 1 | 2
  }

/** The payload carried inside a `dsh-mesh://pair?d=…` QR code or link. */
export interface PairingTicket {
  readonly v: 1
  /** Daemon device id. */
  readonly id: string
  readonly name: string
  readonly platform: DevicePlatform
  /** Daemon Ed25519 public key; pinned by the controller after pairing. */
  readonly signPk: PublicKeyB64
  /** Daemon X25519 static public key. */
  readonly dhPk: PublicKeyB64
  readonly eps: readonly PairingEndpoint[]
  /** One-time pairing token (32 random bytes, base64url). */
  readonly tok: string
  /** Unix seconds. */
  readonly exp: number
  /** Ed25519 signature over the canonical JSON of every field above. */
  readonly sig: string
}

/** Controller-supplied grant chosen at pairing time. */
export interface PairingScope {
  /** `control` can drive the device; `view` is reserved for a later release. */
  readonly kind: 'control' | 'view'
  /** `all` or an explicit workspace id allowlist. */
  readonly workspaces: 'all' | readonly string[]
  /** Unix seconds or null for no expiry. */
  readonly expiresAt: number | null
}

/** One paired peer, persisted by both sides. */
export interface PeerRecord {
  readonly deviceId: string
  readonly name: string
  readonly platform: DevicePlatform
  readonly signPk: PublicKeyB64
  readonly dhPk: PublicKeyB64
  readonly scope: PairingScope
  readonly pairedAt: string
  readonly lastSeenAt: string | null
  readonly revokedAt: string | null
  /** Endpoint cache learned from the pairing ticket or the last successful connection. */
  readonly endpoints?: readonly PairingEndpoint[]
}

/** Result of an inbound pairing request awaiting local approval. */
export interface PairingRequest {
  readonly requestId: string
  readonly peer: DeviceDescriptor
  /** Six digits derived from the handshake transcript; humans compare it out of band. */
  readonly sas: string
  readonly createdAt: string
}

export interface PairingApproval {
  readonly requestId: string
  readonly approved: boolean
  readonly scope?: PairingScope
}

// ---------------------------------------------------------------------------
// Handshake / application authentication
// ---------------------------------------------------------------------------
//
// The physical handshake is Noise_NK_25519_ChaChaPoly_SHA256 (see
// docs/PROTOCOL.md §4): each side sends its Noise message as a binary frame
// prefixed with MessageKind.Handshake. The messages below are the *encrypted*
// application frames exchanged immediately after the Noise handshake
// completes; they authenticate the controller and bind both identities to the
// handshake hash `h`.

/** First encrypted controller message. */
export interface ClientAuthMessage {
  readonly t: 'client_auth'
  readonly v: 1
  readonly controller: DeviceDescriptor
  /** 32 random bytes, base64url; single-use per session. */
  readonly nonce: string
  readonly auth:
    | {
      readonly kind: 'paired'
      /** Ed25519(controller signSk, h || 'client_auth'). */
      readonly sig: string
    }
    | {
      readonly kind: 'pair-token'
      readonly daemonId: string
      /** The one-time token from the pairing ticket, base64url. */
      readonly token: string
    }
}

/** First encrypted daemon reply. */
export interface ServerAuthMessage {
  readonly t: 'server_auth'
  readonly v: 1
  readonly daemon: DeviceDescriptor
  readonly approval: 'none' | 'pending'
  /** Present while `approval === 'pending'`. */
  readonly requestId?: string
  /** Ed25519(daemon signSk, h || 'server_auth' || controller nonce). */
  readonly sig: string
}

export type AppAuthMessage = ClientAuthMessage | ServerAuthMessage

// ---------------------------------------------------------------------------
// RPC
// ---------------------------------------------------------------------------

export type MeshErrorCode =
  | 'mesh/unauthorized'
  | 'mesh/revoked'
  | 'mesh/bad-request'
  | 'mesh/not-found'
  | 'mesh/unsupported'
  | 'mesh/busy'
  | 'mesh/rate-limited'
  | 'mesh/version-mismatch'
  | 'mesh/crypto'
  | 'mesh/internal'
  | 'portal/unavailable'
  | 'portal/upstream-error'

export interface RpcRequest {
  readonly id: number
  readonly method: string
  readonly params?: unknown
}

export interface RpcSuccess {
  readonly id: number
  readonly result: unknown
}

export interface RpcFailure {
  readonly id: number
  readonly error: { readonly code: string; readonly message: string }
}

export interface RpcEvent {
  readonly event: string
  readonly data: unknown
}

export type ControlMessage = RpcRequest | RpcSuccess | RpcFailure | RpcEvent

/** `info` result. */
export type InfoResult = MeshInfo

export interface SessionSummary {
  readonly id: string
  readonly title: string
  readonly updatedAt: string
  readonly running: boolean
  readonly awaitingUser: boolean
  readonly unread: boolean
  /** The daemon's registry-global archive set contains this Session. */
  readonly archived?: boolean
}

export interface WorkspaceSummary {
  readonly id: string
  readonly title: string
  readonly path: string
  readonly sessions: readonly SessionSummary[]
}

export interface WorkspacesResult {
  readonly updatedAt: string
  readonly workspaces: readonly WorkspaceSummary[]
  /**
   * True when the daemon dropped workspaces/sessions to keep the RPC result
   * within the 64 KiB sealed-message limit. Additive optional field (v1).
   */
  readonly truncated?: boolean
}

export interface PortalPrepareResult {
  readonly ok: true
}

/** `portal.http` params; the body follows on the same stream id. */
export interface PortalHttpParams {
  readonly streamId: number
  readonly method: string
  readonly path: string
  readonly headers: Readonly<Record<string, string>>
}

/** `portal.http` result; the body follows on the same stream id. */
export interface PortalHttpResult {
  readonly streamId: number
  readonly status: number
  readonly headers: Readonly<Record<string, string>>
}

/** `portal.ws.open` params. */
export interface PortalWsParams {
  readonly streamId: number
  readonly path: string
  readonly headers: Readonly<Record<string, string>>
  readonly protocols?: readonly string[]
  /**
   * Ask the daemon to gzip WebSocket messages before they cross the Mesh and
   * to accept gzip-compressed messages addressed to it (additive v1 field).
   */
  readonly compress?: boolean
}

export interface PortalWsResult {
  readonly streamId: number
  readonly protocol?: string
  /** The daemon agreed to {@link PortalWsParams.compress}. */
  readonly compressed?: boolean
}

export interface PairStatusResult {
  readonly state: 'pending' | 'approved' | 'denied'
  readonly peer?: PeerRecord
}

// ---------------------------------------------------------------------------
// Local HTTP API (browser plugin ↔ its own host plugin)
// ---------------------------------------------------------------------------
//
// POST /api/device-mesh with `{ endpoint, payload }` — same shape as the
// established third-party plugin convention (see ds-bot). Every response is
// `{ ok: true, value } | { ok: false, error: { code, message } }`.

export interface LocalApiEnvelope {
  readonly endpoint: string
  readonly payload?: unknown
}

export type LocalApiResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } }

export interface MeshDeviceView {
  readonly deviceId: string
  readonly name: string
  readonly platform: DevicePlatform
  /** `self` never appears in `devices`; kept for clarity. */
  readonly direction: 'controller' | 'daemon'
  readonly pairedAt: string
  readonly lastSeenAt: string | null
  readonly revoked: boolean
  readonly scope: PairingScope
  /** `online` is refreshed by the host; `connecting`/`offline` are transient. */
  readonly status: 'online' | 'connecting' | 'offline' | 'revoked' | 'error'
  readonly statusDetail?: string
  /**
   * Six-digit SAS while a controller-side `pair-token` connection waits for the
   * daemon user to approve it (`status === 'connecting'`). Both devices show it
   * so the human can compare it out of band before approving.
   */
  readonly sas?: string
  readonly remoteWorkspaces?: readonly WorkspaceSummary[]
  readonly remoteWorkspacesAt?: string
  /** The list was trimmed to fit the 64 KiB `workspaces.list` result. */
  readonly remoteWorkspacesTruncated?: boolean
}

export interface MeshHostState {
  readonly self: DeviceDescriptor & { readonly appVersion: string }
  readonly protocol: typeof PROTOCOL_VERSION
  readonly direct: { readonly enabled: boolean; readonly port: number; readonly urls: readonly string[] }
  readonly relay: {
    readonly configured: boolean
    readonly endpoint: string | null
    readonly connected: boolean
    readonly useTls: boolean
  }
  readonly devices: readonly MeshDeviceView[]
  readonly pendingPairings: readonly PairingRequest[]
  /** Controller-side portals currently open, keyed by device id. */
  readonly portals: readonly { readonly deviceId: string; readonly url: string }[]
}

export interface PairingTicketView {
  readonly link: string
  readonly expiresAt: string
  /** SVG markup of the QR code; rendered by the client plugin. */
  readonly qrSvg: string
}

/** Endpoint names accepted by `POST /api/device-mesh`. */
export type LocalApiEndpoint =
  | 'state'
  | 'pair.ticket'
  | 'pair.complete'
  | 'pair.approve'
  | 'pair.deny'
  | 'pair.forget'
  | 'peer.revoke'
  | 'peer.rename'
  | 'device.connect'
  | 'device.disconnect'
  | 'workspaces.refresh'
  | 'session.archive'
  | 'portal.open'
  | 'portal.close'
  | 'portal.external'
  | 'relay.configure'
  | 'direct.configure'
  | 'audit.list'
  | 'diagnostics'

// ---------------------------------------------------------------------------
// Persistence shapes
// ---------------------------------------------------------------------------

export interface PeersFile {
  readonly version: 1
  readonly controllers: readonly PeerRecord[]
  readonly daemons: readonly PeerRecord[]
  readonly relayServerId?: string
}

export interface MeshSettings {
  readonly version: 1
  readonly deviceName?: string
  readonly direct: { readonly enabled: boolean; readonly port: number }
  readonly relay: { readonly endpoint: string | null; readonly useTls: boolean; readonly enabled: boolean }
  readonly portal: { readonly idleTimeoutMs: number }
  /** When true, pairing requests are approved automatically (discouraged). */
  readonly autoApprovePairing: boolean
}

export type AuditAction =
  | 'identity.created'
  | 'identity.regenerated'
  | 'pairing.ticket.created'
  | 'pairing.requested'
  | 'pairing.approved'
  | 'pairing.denied'
  | 'peer.revoked'
  | 'auth.failed'
  | 'session.opened'
  | 'session.closed'
  | 'portal.opened'
  | 'portal.closed'
  | 'relay.connected'
  | 'relay.disconnected'

export interface AuditEntry {
  readonly at: string
  readonly action: AuditAction
  /** Device id or peer id; never a token or a key. */
  readonly peer?: string
  readonly detail?: string
}

// ---------------------------------------------------------------------------
// Small shared helpers (portable, no node builtins)
// ---------------------------------------------------------------------------

/** Base64url encode without padding. */
export function toBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  const base64 = typeof btoa === 'function'
    ? btoa(binary)
    : /* v8 ignore next */ Buffer.from(bytes).toString('base64')
  return base64.replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
}

/** Decode base64url, rejecting non-canonical input. */
export function fromBase64Url(value: string): Uint8Array | undefined {
  if (!/^[A-Za-z0-9_-]*$/u.test(value) || value.length % 4 === 1) return undefined
  const padded = value.replaceAll('-', '+').replaceAll('_', '/')
    + '='.repeat((4 - (value.length % 4)) % 4)
  let raw: string
  try {
    raw = typeof atob === 'function'
      ? atob(padded)
      : /* v8 ignore next */ Buffer.from(padded, 'base64').toString('binary')
  } catch {
    return undefined
  }
  const bytes = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i)
  // Reject non-canonical encodings (e.g. trailing bits set).
  return toBase64Url(bytes) === value ? bytes : undefined
}

/** UTF-8 encode that works in Node and in the browser bundle. */
export function encodeUtf8(text: string): Uint8Array {
  return new TextEncoder().encode(text)
}

/** UTF-8 decode that works in Node and in the browser bundle. */
export function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes)
}

/**
 * Canonical JSON used by pairing signatures: object keys sorted, no whitespace.
 * Only accepts JSON-safe values (the ticket shape).
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(item => canonicalJson(item)).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`
}
