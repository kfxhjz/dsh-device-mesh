/**
 * Device-mesh broker: the runtime that ties persistence, pairing, the local
 * workspace model, both portal proxies and the bearer transports together.
 *
 * Everything that touches crypto/session construction or the physical carriers
 * is injected (`BrokerTransportFactories`, `ControllerSessionConnector`,
 * `PortalOpener`). The broker itself stays deterministic and unit-testable; the
 * host plugin (`index.ts`) supplies the real implementations.
 */

import type {
  AuditEntry,
  DeviceDescriptor,
  MeshDeviceView,
  MeshHostState,
  MeshInfo,
  PairStatusResult,
  PairingEndpoint,
  PairingScope,
  PairingTicket,
  PeerRecord,
  WorkspacesResult,
} from '../shared/protocol.ts'
import { PROTOCOL_VERSION } from '../shared/protocol.ts'
import type { DaemonAuthOutcome, DaemonSessionHandlers, MeshSession } from '../shared/mesh-session.ts'
import { MeshRpcError } from '../shared/mesh-session.ts'
import type {
  DirectListener,
  MeshTransport,
  RelayDaemon,
  RelayDaemonOptions,
  RelayClientOptions,
} from '../shared/transport.ts'
import { DIRECT_MAX_CONNECTIONS, HANDSHAKE_TIMEOUT_MS, isRecord, MAX_INBOUND_SESSIONS, MAX_INBOUND_SESSIONS_PER_CONTROLLER, ENDPOINT_DIAL_TIMEOUT_MS, PAIRING_APPROVAL_TIMEOUT_MS, PAIRING_CONNECT_TIMEOUT_MS, RECONNECT_MAX_MS, RECONNECT_MIN_MS, SESSION_PING_INTERVAL_MS, silentLogger } from './config.ts'
import type { MeshLogger } from './config.ts'
import type { PairingService } from './pairing.ts'
import { assertSupportedPairingScope, computeSas, PairingError, parsePairingLink } from './pairing.ts'
import type { MeshStore } from './store.ts'
import type { PortalDaemon } from './portal-daemon.ts'
import type { PortalController } from './portal-controller.ts'
import type { WorkspaceProvider } from './workspaces.ts'

/** Status vocabulary exposed to the client plugin. */
export type DeviceStatus = 'online' | 'connecting' | 'offline' | 'revoked' | 'error'

/** Options for starting a direct listener, mapped by the composition root. */
export interface DirectStartOptions {
  readonly port: number
  readonly host?: string
  readonly maxConnections?: number
}

/** Physical transport factories (implemented by `src/host/transport/**`). */
export interface BrokerTransportFactories {
  readonly startDirectListener?: (
    options: DirectStartOptions,
    onAccept: (transport: MeshTransport) => void,
  ) => Promise<DirectListener>
  readonly connectDirect?: (
    url: string,
    options?: { readonly signal?: AbortSignal },
  ) => Promise<MeshTransport>
  readonly startRelayDaemon?: (
    options: RelayDaemonOptions,
    onClient: (transport: MeshTransport, connectionId: string) => void,
  ) => Promise<RelayDaemon>
  readonly connectRelay?: (
    options: RelayClientOptions & { readonly signal?: AbortSignal },
  ) => Promise<MeshTransport>
}

/** Authentication input for a controller-side connection. */
export type ControllerAuth =
  | { readonly kind: 'paired' }
  | {
    readonly kind: 'pair-token'
    readonly token: string
    readonly ticket: PairingTicket
  }

/** Options handed to the session layer for a controller connection. */
export interface ControllerConnectOptions {
  readonly transport: MeshTransport
  readonly remote: DeviceDescriptor
  readonly auth: ControllerAuth
  readonly signal: AbortSignal
}

/** Session-layer seam: builds an authenticated MeshSession over a transport. */
export interface ControllerSessionConnector {
  connect(options: ControllerConnectOptions): Promise<{ readonly session: MeshSession }>
}

/** Portal seam: starts the loopback reverse proxy for one daemon session. */
export interface PortalOpener {
  open(options: {
    readonly session: MeshSession
    readonly deviceId: string
    readonly onClose: () => void
  }): Promise<PortalController>
}

/** Options for {@link DeviceMeshBroker}. */
export interface BrokerOptions {
  readonly store: MeshStore
  readonly pairing: PairingService
  readonly workspaces: WorkspaceProvider
  readonly portalDaemon: PortalDaemon
  readonly factories?: BrokerTransportFactories
  readonly connector?: ControllerSessionConnector
  readonly portal?: PortalOpener
  readonly logger?: MeshLogger
  readonly appVersion?: string
  readonly now?: () => number
  readonly offline?: boolean
  /** Bind address of the direct listener (default `0.0.0.0`). */
  readonly directHost?: string
  /**
   * Receives every accepted inbound daemon transport. The composition root
   * builds the Noise/session layer and the `DaemonSessionHandlers` returned by
   * {@link DeviceMeshBroker.createDaemonHandlers}.
   */
  readonly onInboundTransport?: (transport: MeshTransport, source: 'direct' | 'relay') => void
  /**
   * How long a first-contact controller may stay unapproved before the session
   * is treated as terminally failed. Defaults to
   * {@link PAIRING_APPROVAL_TIMEOUT_MS}; tests override it to stay fast.
   */
  readonly pairingApprovalTimeoutMs?: number
}

interface DaemonRuntime {
  status: DeviceStatus
  detail: string | undefined
  session: MeshSession | undefined
  remoteWorkspaces: WorkspacesResult | undefined
  remoteWorkspacesAt: string | undefined
  reconnectAttempt: number
  reconnectTimer: NodeJS.Timeout | undefined
  manualDisconnect: boolean
  connecting: Promise<unknown> | undefined
  /**
   * Connection generation. Every new attempt and every explicit cancellation
   * increments it, so a late handshake that belonged to an older attempt can be
   * detected and discarded instead of adopting a session.
   */
  epoch: number
  /** Aborts the dial/handshake of the current attempt (H5). */
  attemptAbort: AbortController | undefined
  /**
   * Set once a first-contact (`pair-token`) attempt reached a terminal failure
   * (denied/timeout/not authorized). Guards against duplicate cleanup and
   * automatic reconnects; a new explicit `pairWithLink` clears it.
   */
  pairingTerminal: boolean
  /**
   * The daemon record to restore when a first-contact pairing fails. `undefined`
   * means this attempt did not pin a record (normal reconnect); a wrapper with
   * `previous: undefined` means the record was newly created and must be
   * removed instead of restored.
   */
  pairingRollback: { readonly previous: PeerRecord | undefined } | undefined
  /** The session still waiting for the daemon user's approval, if any. */
  pairingSession: MeshSession | undefined
  /** Consecutive heartbeat misses; a lone miss is tolerated (relay jitter). */
  heartbeatFailures: number
}

interface PortalRecord {
  readonly controller: PortalController
  readonly deviceId: string
}

/** Result of opening the local pairing view. */
export interface CreatedPairingTicket {
  readonly link: string
  readonly expiresAt: string
  readonly ticket: PairingTicket
}

const CAPABILITIES = ['rpc', 'portal', 'workspaces', 'pairing', 'relay'] as const

function nowIso(now: () => number): string {
  return new Date(now()).toISOString()
}


function safeWorkspacesResult(value: unknown): WorkspacesResult | undefined {
  if (!isRecord(value) || typeof value.updatedAt !== 'string' || !Array.isArray(value.workspaces)) {
    return undefined
  }
  return {
    updatedAt: value.updatedAt,
    workspaces: value.workspaces.filter(isRecord).map(workspace => ({
      id: typeof workspace.id === 'string' ? workspace.id : '',
      title: typeof workspace.title === 'string' ? workspace.title : '',
      path: typeof workspace.path === 'string' ? workspace.path : '',
      sessions: Array.isArray(workspace.sessions)
        ? workspace.sessions.filter(isRecord).map(session => ({
          id: typeof session.id === 'string' ? session.id : '',
          title: typeof session.title === 'string' ? session.title : '',
          updatedAt: typeof session.updatedAt === 'string' ? session.updatedAt : '',
          running: session.running === true,
          awaitingUser: session.awaitingUser === true,
          unread: session.unread === true,
          ...(session.archived === true ? { archived: true } : {}),
        }))
        : [],
    })),
    ...(value.truncated === true ? { truncated: true } : {}),
  }
}

function relayEndpointOf(settings: {
  readonly relay: { readonly endpoint: string | null; readonly enabled: boolean }
}, serverId: string | undefined): PairingEndpoint | undefined {
  // A configured endpoint is also used for outbound controller sessions while
  // this device does not serve relay. Advertising it in a pairing ticket would
  // send the controller to a relay route that has no daemon socket attached.
  if (!settings.relay.enabled) return undefined
  const endpoint = settings.relay.endpoint
  if (endpoint === null || endpoint === undefined || serverId === undefined) return undefined
  return { k: 'relay', url: endpoint, sid: serverId, v: 2 }
}

/**
 * The daemon/controller runtime. Construct once per host plugin instance.
 */
export class DeviceMeshBroker {
  private readonly store: MeshStore
  private readonly pairing: PairingService
  private readonly workspaces: WorkspaceProvider
  private readonly portalDaemon: PortalDaemon
  private readonly factories: BrokerTransportFactories
  private readonly connector: ControllerSessionConnector | undefined
  private readonly portal: PortalOpener | undefined
  private readonly logger: MeshLogger
  private readonly appVersion: string
  private readonly now: () => number
  private readonly offline: boolean
  private readonly directHost: string
  private readonly pairingApprovalTimeoutMs: number
  private readonly onInboundTransportCallback: ((transport: MeshTransport, source: 'direct' | 'relay') => void) | undefined

  private readonly daemons = new Map<string, DaemonRuntime>()
  /** Inbound controller sessions, tracked so revocation and expiry can close them. */
  private readonly inbound = new Map<string, Set<MeshSession>>()
  private readonly portals = new Map<string, PortalRecord>()
  /**
   * Tail of a promise chain that serializes pairing decisions which read and
   * then modify both the pairing queue and the persisted peer records
   * (approve/revoke/forget/first-contact). Without it, a `persistController`
   * await could interleave with a deny/revoke and resurrect a peer.
   */
  private pairingChain: Promise<unknown> = Promise.resolve()

  private directListener: DirectListener | undefined
  private relayDaemon: RelayDaemon | undefined
  private relayConnected = false
  private listenPort = 0
  private started = false
  private pingTimer: NodeJS.Timeout | undefined
  private pruneTimer: NodeJS.Timeout | undefined
  private readonly listeners = new Set<() => void>()

  constructor(options: BrokerOptions) {
    this.store = options.store
    this.pairing = options.pairing
    this.workspaces = options.workspaces
    this.portalDaemon = options.portalDaemon
    this.factories = options.factories ?? {}
    this.connector = options.connector
    this.portal = options.portal
    this.logger = options.logger ?? silentLogger
    this.appVersion = options.appVersion ?? '0.0.0'
    this.now = options.now ?? Date.now
    this.offline = options.offline ?? false
    this.directHost = options.directHost ?? '0.0.0.0'
    this.pairingApprovalTimeoutMs = options.pairingApprovalTimeoutMs ?? PAIRING_APPROVAL_TIMEOUT_MS
    this.onInboundTransportCallback = options.onInboundTransport
  }

  /** Register a listener notified on every user-visible state transition. */
  onStateChange(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private changed(): void {
    for (const listener of [...this.listeners]) {
      try {
        listener()
      } catch {
        // A broken observer must not break the mesh.
      }
    }
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /** Start listeners, relay daemon and periodic maintenance. */
  async start(): Promise<void> {
    if (this.started) return
    this.started = true
    await this.pairing.init()
    if (this.offline) {
      this.logger.info('device-mesh: offline mode; no listener or relay will start')
      return
    }
    await this.startDirect()
    await this.startRelay()
    // A DSH restart should bring the mesh back up without requiring the user to
    // open the host menu first.
    for (const peer of this.store.getPeers().daemons) {
      if (peer.revokedAt !== null) continue
      void this.connectDevice(peer.deviceId).catch(() => undefined)
    }
    this.pingTimer = setInterval(() => {
      void this.pollSessions()
    }, SESSION_PING_INTERVAL_MS)
    this.pingTimer.unref?.()
    this.pruneTimer = setInterval(() => {
      this.pairing.pruneExpired()
      this.prunePortalIdle()
      // Inbound grants are re-checked at most this often, so a revoked or
      // expired controller's established session is closed within 30 s (the
      // upper bound) rather than surviving until its next RPC.
      this.pruneInboundSessions()
    }, 30_000)
    this.pruneTimer.unref?.()
  }

  /** Close every listener, session and portal. */
  async stop(): Promise<void> {
    if (!this.started) return
    this.started = false
    if (this.pingTimer !== undefined) clearInterval(this.pingTimer)
    if (this.pruneTimer !== undefined) clearInterval(this.pruneTimer)
    this.pingTimer = undefined
    this.pruneTimer = undefined
    this.pairing.stop()
    for (const deviceId of [...this.portals.keys()]) {
      await this.closePortal(deviceId)
    }
    for (const runtime of this.daemons.values()) {
      runtime.epoch += 1
      runtime.attemptAbort?.abort()
      runtime.attemptAbort = undefined
      if (runtime.reconnectTimer !== undefined) clearTimeout(runtime.reconnectTimer)
      runtime.reconnectTimer = undefined
      runtime.session?.close()
    }
    for (const deviceId of [...this.inbound.keys()]) this.closeInboundSessions(deviceId)
    this.daemons.clear()
    this.inbound.clear()
    const relay = this.relayDaemon
    this.relayDaemon = undefined
    if (relay !== undefined) await relay.close().catch(() => {})
    const direct = this.directListener
    this.directListener = undefined
    if (direct !== undefined) await direct.close().catch(() => {})
    this.portalDaemon.close()
    this.changed()
  }

  // -------------------------------------------------------------------------
  // Daemon role: direct listener + relay daemon
  // -------------------------------------------------------------------------

  private async startDirect(): Promise<void> {
    const settings = this.store.getSettings()
    if (!settings.direct.enabled) return
    const start = this.factories.startDirectListener
    if (start === undefined) {
      this.logger.warn('device-mesh: direct transport is unavailable; listener not started')
      return
    }
    const attempt = async (port: number): Promise<DirectListener> => start(
      {
        port,
        host: this.directHost,
        maxConnections: DIRECT_MAX_CONNECTIONS,
      },
      (transport) => {
        this.onInboundTransport(transport, 'direct')
      },
    )
    try {
      this.directListener = await attempt(settings.direct.port)
    } catch (error) {
      if (settings.direct.port !== 0) {
        this.logger.warn(`device-mesh: could not bind direct port ${String(settings.direct.port)}; falling back to an OS-assigned port`)
        try {
          this.directListener = await attempt(0)
        } catch (fallbackError) {
          this.logger.warn(`device-mesh: direct listener unavailable: ${errorMessage(fallbackError)}`)
        }
      } else {
        this.logger.warn(`device-mesh: direct listener unavailable: ${errorMessage(error)}`)
      }
    }
    this.listenPort = this.directListener?.port ?? 0
  }

  private async startRelay(): Promise<void> {
    const settings = this.store.getSettings()
    if (!settings.relay.enabled || settings.relay.endpoint === null) return
    const start = this.factories.startRelayDaemon
    if (start === undefined) {
      this.logger.warn('device-mesh: relay transport is unavailable; relay not started')
      return
    }
    const serverId = await this.store.ensureRelayServerId()
    try {
      const relay = await start(
        {
          url: settings.relay.endpoint,
          serverId,
          version: 2,
          minBackoffMs: RECONNECT_MIN_MS,
          maxBackoffMs: RECONNECT_MAX_MS,
        },
        (transport) => {
          this.onInboundTransport(transport, 'relay')
        },
      )
      this.relayDaemon = relay
      this.relayConnected = relay.connected
      relay.onDisconnect(() => {
        this.relayConnected = false
        void this.store.appendAudit({ action: 'relay.disconnected' })
        this.changed()
      })
      void relay.ready.then(() => {
        this.relayConnected = relay.connected
        void this.store.appendAudit({ action: 'relay.connected' })
        this.changed()
      }).catch((error: unknown) => {
        this.logger.warn(`device-mesh: relay daemon failed: ${errorMessage(error)}`)
      })
    } catch (error) {
      this.logger.warn(`device-mesh: relay daemon unavailable: ${errorMessage(error)}`)
    }
  }

  private onInboundTransport(transport: MeshTransport, source: 'direct' | 'relay'): void {
    if (this.onInboundTransportCallback === undefined) {
      this.logger.warn(`device-mesh: inbound ${source} transport accepted but no session layer is wired; closing it`)
      transport.close(1011, 'session layer unavailable')
      return
    }
    try {
      this.onInboundTransportCallback(transport, source)
    } catch (error) {
      this.logger.warn(`device-mesh: inbound transport dispatch failed: ${errorMessage(error)}`)
      transport.close(1011, 'session layer failed')
    }
  }

  // -------------------------------------------------------------------------
  // Daemon handlers (mounted on an inbound session by the composition root)
  // -------------------------------------------------------------------------

  /**
   * Build the daemon-side handlers for one authenticated session.
   * @param controllerDeviceId - authenticated controller device id.
   * @returns handlers consumed by the session/channel layer.
   */
  createDaemonHandlers(
    controllerDeviceId: string | (() => string | undefined),
  ): DaemonSessionHandlers {
    const deviceIdOf = typeof controllerDeviceId === 'function'
      ? controllerDeviceId
      : () => controllerDeviceId
    const requireScope = (): PeerRecord => {
      const controllerDeviceIdValue = deviceIdOf()
      if (controllerDeviceIdValue === undefined) {
        throw new MeshRpcError('mesh/unauthorized', 'controller has not completed authentication')
      }
      const peer = this.store.findPeer('controllers', controllerDeviceIdValue)
      if (peer === undefined) throw new MeshRpcError('mesh/unauthorized', 'controller is not paired')
      if (peer.revokedAt !== null) throw new MeshRpcError('mesh/revoked', 'controller has been revoked')
      const expiresAt = peer.scope.expiresAt
      if (expiresAt !== null && expiresAt <= Math.floor(this.now() / 1000)) {
        throw new MeshRpcError('mesh/unauthorized', 'controller grant has expired')
      }
      return peer
    }
    /** Mutating/portal operations require the full control grant of v1. */
    const ensureControl = (peer: PeerRecord): void => {
      if (peer.scope.kind !== 'control') {
        throw new MeshRpcError('mesh/unauthorized', 'controller grant is view-only')
      }
    }
    /**
     * A portal is an unauthenticated view of the daemon's whole DSH origin, so
     * it cannot be narrowed to an allowlist. Only a full control grant may use
     * it; view or workspace-limited controllers are refused (fail closed).
     */
    const ensurePortalAllowed = (peer: PeerRecord): void => {
      ensureControl(peer)
      if (peer.scope.workspaces !== 'all') {
        throw new MeshRpcError(
          'mesh/unauthorized',
          'portal access requires a full control grant over all workspaces',
        )
      }
    }
    /** Apply the controller's workspace allowlist to a listing. */
    const filterWorkspaces = (peer: PeerRecord, result: WorkspacesResult): WorkspacesResult => {
      const allowed = peer.scope.workspaces
      if (allowed === 'all') return result
      const ids = new Set(allowed)
      return {
        updatedAt: result.updatedAt,
        workspaces: result.workspaces.filter(workspace => ids.has(workspace.id)),
        ...(result.truncated === true ? { truncated: true } : {}),
      }
    }
    /**
     * A workspace-limited grant may only mutate Sessions it can see. The
     * bounded listing is not authoritative, so resolve the Session's owning
     * workspace directly; an unknown owner fails closed.
     */
    const ensureSessionInScope = async (peer: PeerRecord, sessionId: string): Promise<void> => {
      const allowed = peer.scope.workspaces
      if (allowed === 'all') return
      const workspaceId = await this.workspaces.workspaceIdOf(sessionId)
      if (workspaceId === undefined || !allowed.includes(workspaceId)) {
        throw new MeshRpcError('mesh/unauthorized', 'Session is outside the controller workspace grant')
      }
    }
    const handlers: DaemonSessionHandlers = {
      rpc: async (method, params) => {
        // `pair.status` is the only call a not-yet-approved controller may make
        // (docs/PROTOCOL.md §4.2 rule 3), so it is answered before scope checks.
        if (method === 'pair.status') {
          const requestId = isRecord(params) && typeof params.requestId === 'string'
            ? params.requestId
            : ''
          if (requestId.length === 0) throw new MeshRpcError('mesh/bad-request', 'pair.status needs requestId')
          const status = this.pairing.getStatus(requestId)
          if (status.state === 'approved' && status.peer === undefined) {
            // Approval is persisted asynchronously; report pending until the
            // controller record exists so the next RPC can be authorized.
            return { state: 'pending' }
          }
          return status.peer !== undefined
            ? { state: status.state, peer: status.peer }
            : { state: status.state }
        }
        const peer = requireScope()
        switch (method) {
          case 'info':
            return this.info()
          case 'workspaces.list': {
            const refresh = isRecord(params) && params.refresh === true
            return filterWorkspaces(peer, await this.workspaces.list({ refresh }))
          }
          case 'session.archive': {
            ensureControl(peer)
            const sessionId = isRecord(params) && typeof params.sessionId === 'string'
              ? params.sessionId
              : ''
            if (sessionId.length === 0) throw new MeshRpcError('mesh/bad-request', 'session.archive needs sessionId')
            await ensureSessionInScope(peer, sessionId)
            const stopActivity = isRecord(params) && params.stopActivity === true
            await this.workspaces.archiveSession(sessionId, stopActivity ? { stopActivity: true } : {})
            return { archived: true }
          }
          case 'session.unarchive': {
            ensureControl(peer)
            const sessionId = isRecord(params) && typeof params.sessionId === 'string'
              ? params.sessionId
              : ''
            if (sessionId.length === 0) throw new MeshRpcError('mesh/bad-request', 'session.unarchive needs sessionId')
            await ensureSessionInScope(peer, sessionId)
            await this.workspaces.unarchiveSession(sessionId)
            return { archived: false }
          }
          case 'workspaces.subscribe':
            // v1 has no daemon→controller event channel in the session seam;
            // the controller polls `workspaces.list` instead.
            return { ok: true }
          case 'portal.prepare':
            ensurePortalAllowed(peer)
            await this.portalDaemon.prepare()
            return { ok: true }
          case 'ping':
            return { now: this.now() }
          default:
            throw new MeshRpcError('mesh/not-found', `unknown RPC method ${JSON.stringify(method)}`)
        }
      },
      http: async (params, body, signal) => {
        ensurePortalAllowed(requireScope())
        return this.portalDaemon.http(params, body, signal)
      },
      ws: async (params, signal) => {
        ensurePortalAllowed(requireScope())
        return this.portalDaemon.ws(params, signal)
      },
    }
    return handlers
  }

  /**
   * Whether one more inbound controller session may be admitted (total cap).
   * The host checks this before starting the Noise handshake so a flood of
   * accepted sockets is closed cheaply with 1013 "mesh busy".
   */
  canAcceptInbound(): boolean {
    let total = 0
    for (const sessions of this.inbound.values()) {
      for (const session of sessions) {
        if (session.open) total += 1
      }
    }
    return total < MAX_INBOUND_SESSIONS
  }

  /** Record that an inbound controller session became usable. */
  noteInboundOpened(controllerDeviceId: string, session: MeshSession): void {
    const existing = this.inbound.get(controllerDeviceId)
    if ((existing?.size ?? 0) >= MAX_INBOUND_SESSIONS_PER_CONTROLLER) {
      this.logger.warn(
        `device-mesh: controller ${controllerDeviceId} reached the inbound session limit `
        + `(${MAX_INBOUND_SESSIONS_PER_CONTROLLER}); closing new session`,
      )
      session.close()
      return
    }
    if (!this.canAcceptInbound()) {
      this.logger.warn(
        `device-mesh: inbound session limit (${MAX_INBOUND_SESSIONS}) reached; closing new session`,
      )
      session.close()
      return
    }
    const sessions = existing ?? new Set<MeshSession>()
    sessions.add(session)
    this.inbound.set(controllerDeviceId, sessions)
    void this.store.patchPeer('controllers', controllerDeviceId, {
      lastSeenAt: nowIso(this.now),
    }).catch(() => {})
    void this.store.appendAudit({ action: 'session.opened', peer: controllerDeviceId, detail: 'inbound' })
    this.changed()
  }

  /** Record that an inbound controller session ended. */
  noteInboundClosed(controllerDeviceId: string, session: MeshSession): void {
    const sessions = this.inbound.get(controllerDeviceId)
    if (sessions !== undefined) {
      sessions.delete(session)
      if (sessions.size === 0) this.inbound.delete(controllerDeviceId)
    }
    void this.store.appendAudit({ action: 'session.closed', peer: controllerDeviceId, detail: 'inbound' })
    this.changed()
  }

  /**
   * Close every inbound session of one controller. Used by revocation and by the
   * periodic grant re-check so a long-lived portal WebSocket cannot outlive the
   * peer record that authorized it (docs/PROTOCOL.md §9).
   * @param controllerDeviceId - paired controller whose sessions should end.
   */
  private closeInboundSessions(controllerDeviceId: string): void {
    const sessions = this.inbound.get(controllerDeviceId)
    if (sessions === undefined) return
    this.inbound.delete(controllerDeviceId)
    for (const session of sessions) {
      try {
        session.close()
      } catch {
        // Already closed by the peer.
      }
    }
    this.changed()
  }

  /**
   * Re-check every inbound controller's grant. A session whose peer was revoked,
   * forgot, or whose grant expired is closed instead of waiting for its next RPC.
   */
  private pruneInboundSessions(): void {
    for (const [deviceId, sessions] of [...this.inbound.entries()]) {
      const record = this.store.findPeer('controllers', deviceId)
      const peer = this.lookupPairedController(deviceId)
      let changed = false
      for (const session of [...sessions]) {
        if (!session.open) {
          // The close listener (`noteInboundClosed`) normally removes it first.
          sessions.delete(session)
          changed = true
          continue
        }
        if (peer !== undefined) continue
        // A first-time pairing session is not a peer record yet; its live
        // `pairing` getter stays `pending` until the daemon user decides, and
        // the pairing service owns the approval timeout. Never prune it — but a
        // pending request from an already-revoked controller is not first
        // contact and must still be closed.
        const notRevoked = record === undefined || record.revokedAt === null
        if (notRevoked && session.pairing?.approval === 'pending') continue
        sessions.delete(session)
        changed = true
        try {
          session.close()
        } catch {
          // Already closed by the peer.
        }
      }
      if (sessions.size === 0) this.inbound.delete(deviceId)
      if (changed) this.changed()
    }
  }

  /**
   * Look up a paired controller (revocation/expiry aware).
   * @param deviceId - controller id from `client_auth`.
   * @returns the record, or `undefined` when not usable.
   */
  lookupPairedController(deviceId: string): PeerRecord | undefined {
    const peer = this.store.findPeer('controllers', deviceId)
    if (peer === undefined || peer.revokedAt !== null) return undefined
    const expiresAt = peer.scope.expiresAt
    if (expiresAt !== null && expiresAt <= Math.floor(this.now() / 1000)) return undefined
    return peer
  }

  /**
   * Handle a first-time `pair-token` authentication: claim the one-time token,
   * prompt the local user and, when approved, persist the controller.
   *
   * @param controller - controller descriptor from `client_auth`.
   * @param token - one-time token from the QR code.
   * @param handshakeHash - Noise handshake hash (used for the SAS).
   * @returns outcome consumed by the session layer's auth callback.
   */
  async beginPairToken(
    controller: DeviceDescriptor,
    token: string,
    handshakeHash: Uint8Array,
    sas?: string,
  ): Promise<DaemonAuthOutcome> {
    return this.exclusivePairing(async () => {
      // A revoked controller keeps its old record (and scope) until the local user
      // explicitly forgets it; re-pairing must not silently clear the revocation.
      const existing = this.store.findPeer('controllers', controller.deviceId)
      if (existing !== undefined && existing.revokedAt !== null) {
        throw new PairingError('mesh/revoked', 'controller was revoked; forget it before pairing again')
      }
      const claim = await this.pairing.beginPairToken(this.store.getIdentity().deviceId, token)
      if (!claim.ok) throw new MeshRpcError(claim.code, claim.message)
      const sasValue = sas ?? computeSas(
        handshakeHash,
        controller.signPk,
        this.store.getIdentity().signPk,
      )
      const pending = this.pairing.requestApproval(controller, sasValue)
      const requestId = pending.request.requestId
      // Auto-approval (and the manual path) both resolve through this wrapper, so
      // the decision only reaches the channel after the controller is persisted.
      // A persistence failure rejects `decide`, which makes the channel close the
      // session instead of reporting a bogus "approved" state.
      const decide = pending.decide.then(async (decision) => {
        if (!decision.approved) return decision
        // Persist under the same pairing lock as approve/revoke/forget and only
        // while the decision is still authoritative: a revoke/forget that
        // cancelled the request must not be undone by this late write (M8).
        return this.exclusivePairing(async () => {
          if (this.pairing.getStatus(requestId).state !== 'approved') {
            return { approved: false }
          }
          await this.persistController(
            controller,
            this.pairing.scopeOf(requestId) ?? defaultControlScope(),
          )
          return decision
        })
      })
      // Direct broker callers may never await `decide`; the channel observes the
      // rejection itself, so keep a handled branch to avoid an unhandled
      // rejection when persistence fails during shutdown.
      decide.catch(() => undefined)
      return { kind: 'pair-approval-required', requestId, decide }
    })
  }

  /** Persist (or refresh) a paired controller record. */
  private async persistController(peer: DeviceDescriptor, scope: PairingScope): Promise<void> {
    const existing = this.store.findPeer('controllers', peer.deviceId)
    if (existing !== undefined && existing.revokedAt !== null) {
      throw new PairingError('mesh/revoked', 'controller was revoked; forget it before pairing again')
    }
    assertSupportedPairingScope(scope)
    const record: PeerRecord = {
      deviceId: peer.deviceId,
      name: peer.name,
      platform: peer.platform,
      signPk: peer.signPk,
      dhPk: peer.dhPk,
      scope,
      pairedAt: existing?.pairedAt ?? nowIso(this.now),
      lastSeenAt: nowIso(this.now),
      revokedAt: null,
    }
    // Persistence failure must be visible to the caller: reporting an approval
    // without a peer record would authorize nothing and leave the UI lying.
    await this.store.upsertPeer('controllers', record)
    this.changed()
  }

  /**
   * Approve a pending pairing request from the local UI.
   *
   * The controller is persisted first so `pair.status` never reports "approved"
   * for a peer the daemon handlers cannot authorize. The request is re-checked
   * inside the pairing lock; if a concurrent deny/timeout won the race, the
   * freshly persisted record is rolled back and the call fails with
   * `mesh/unauthorized` (H2).
   *
   * @param requestId - request shown in `state().pendingPairings`.
   * @param scope - grant to persist once the controller is approved.
   */
  async approvePairing(
    requestId: string,
    scope?: PairingScope,
  ): Promise<{ readonly requestId: string; readonly approved: boolean }> {
    // v1 cannot enforce restricted grants; reject before persisting anything so
    // the UI never shows a limited pairing while the peer actually has control.
    const effectiveScope = scope ?? this.pairing.scopeOf(requestId) ?? defaultControlScope()
    assertSupportedPairingScope(effectiveScope)
    return this.exclusivePairing(async () => {
      const peer = this.pairing.peerOf(requestId)
      if (peer === undefined) {
        throw new MeshRpcError('mesh/not-found', 'no pending pairing request with that id')
      }
      // Re-validate under the lock: `getStatus` prunes expired requests, so a
      // timeout that elapsed while we waited is reported as no-longer-pending.
      const status = this.pairing.getStatus(requestId)
      if (status.state !== 'pending') {
        throw new MeshRpcError('mesh/unauthorized', 'pairing request is no longer pending')
      }
      const previous = this.store.findPeer('controllers', peer.deviceId)
      if (previous !== undefined && previous.revokedAt !== null) {
        throw new PairingError('mesh/revoked', 'controller was revoked; forget it before pairing again')
      }
      await this.persistController(peer, effectiveScope)
      let approved: ReturnType<PairingService['approve']>
      try {
        approved = this.pairing.approve(requestId, effectiveScope)
      } catch (error) {
        // Defensive: an unexpected throw from the decision layer must not leave
        // the controller persisted without an approval decision.
        await this.rollbackController(peer.deviceId, previous)
        throw error
      }
      if (approved === undefined) {
        // A concurrent deny/timeout resolved the request after the persistence
        // await. Undo the just-written record so an unapproved controller is
        // never left paired.
        await this.rollbackController(peer.deviceId, previous)
        throw new MeshRpcError('mesh/unauthorized', 'pairing request was denied before it could be approved')
      }
      this.changed()
      return { requestId, approved: true }
    })
  }

  /** Deny a pending pairing request from the local UI. */
  denyPairing(requestId: string): { readonly requestId: string; readonly approved: boolean } {
    const request = this.pairing.deny(requestId)
    if (request === undefined) {
      throw new MeshRpcError('mesh/not-found', 'no pending pairing request with that id')
    }
    this.changed()
    return { requestId, approved: false }
  }

  /**
   * Cancel a first-contact request when its controller session goes away before
   * the local user decides. Without this a prompt can outlive the session and
   * persist a controller that already gave up (and can never reconnect).
   * @param requestId - request carried by the pending `server_auth`.
   * @param session - authenticated controller session to watch.
   */
  trackPendingPairing(requestId: string, session: MeshSession): void {
    void session.closed.then(() => {
      this.cancelPendingPairing(requestId)
    })
  }

  /** Deny a still-pending first-contact request; no-op once decided. */
  cancelPendingPairing(requestId: string): void {
    if (this.pairing.getStatus(requestId).state !== 'pending') return
    this.pairing.deny(requestId, 'pairing session closed')
    this.changed()
  }

  /** Full `info` payload advertised to controllers. */
  info(): MeshInfo {
    const identity = this.store.getIdentity()
    return {
      device: {
        deviceId: identity.deviceId,
        name: identity.name,
        platform: identity.platform,
        signPk: identity.signPk,
        dhPk: identity.dhPk,
        appVersion: this.appVersion,
      },
      protocol: PROTOCOL_VERSION,
      capabilities: [...CAPABILITIES],
      hostLabel: identity.name,
    }
  }

  // -------------------------------------------------------------------------
  // Pairing (daemon view + controller link completion)
  // -------------------------------------------------------------------------

  /** Reachable endpoints advertised in a pairing ticket, in preference order. */
  currentEndpoints(): PairingEndpoint[] {
    const endpoints: PairingEndpoint[] = []
    for (const url of this.directListener?.urls ?? []) {
      endpoints.push({ k: 'direct', url })
    }
    const relay = relayEndpointOf(this.store.getSettings(), this.store.getRelayServerId())
    if (relay !== undefined) endpoints.push(relay)
    return endpoints
  }

  /** Create a signed pairing ticket / link for this device. */
  async createPairingTicket(): Promise<CreatedPairingTicket> {
    const endpoints = this.currentEndpoints()
    if (endpoints.length === 0) {
      throw new PairingError(
        'mesh/unsupported',
        'no reachable endpoint: enable the direct listener or configure the relay first',
      )
    }
    const created = await this.pairing.createTicket(endpoints)
    return {
      link: created.link,
      expiresAt: new Date(created.expiresAtMs).toISOString(),
      ticket: created.ticket,
    }
  }

  /**
   * Finish pairing as the controller *without blocking the browser request*.
   *
   * The daemon record is pinned and persisted immediately, then the physical
   * dial/Noise handshake runs in the background. `state()` exposes progress:
   * `connecting` (+ statusDetail) while waiting, `online` once the daemon's
   * local user approved, `error` with a detail if it never connects.
   *
   * @param link - scanned/pasted pairing link.
   * @returns device view with the freshly pinned daemon (usually `connecting`).
   */
  async pairWithLink(link: string): Promise<MeshDeviceView> {
    const ticket = parsePairingLink(link, this.now())
    const existing = this.store.findPeer('daemons', ticket.id)
    if (existing !== undefined) {
      if (existing.revokedAt !== null) {
        throw new PairingError('mesh/revoked', 'this device was revoked; forget it before pairing again')
      }
      if (existing.signPk !== ticket.signPk || existing.dhPk !== ticket.dhPk) {
        throw new PairingError('mesh/unauthorized', 'paired device identity changed; forget it before pairing again')
      }
    }
    if (this.connector === undefined) {
      throw new PairingError('mesh/unsupported', 'session layer is unavailable')
    }
    const record: PeerRecord = {
      deviceId: ticket.id,
      name: ticket.name,
      platform: ticket.platform,
      signPk: ticket.signPk,
      dhPk: ticket.dhPk,
      scope: existing?.scope ?? defaultControlScope(),
      pairedAt: existing?.pairedAt ?? nowIso(this.now),
      lastSeenAt: nowIso(this.now),
      revokedAt: null,
      endpoints: ticket.eps,
    }
    await this.store.upsertPeer('daemons', record)
    const runtime = this.runtimeFor(record.deviceId)
    runtime.manualDisconnect = false
    runtime.pairingTerminal = false
    // Remember what to restore if the first-contact handshake never becomes an
    // approved pairing (H3): a brand-new record is removed again, an existing
    // one is restored.
    runtime.pairingRollback = { previous: existing }
    runtime.pairingSession = undefined
    // A failed re-pair attempt must not hide an already working session (H4).
    if (runtime.session?.open !== true) {
      runtime.status = 'connecting'
      runtime.detail = 'waiting for the controlled device to approve pairing'
    }
    this.changed()
    // A second pairWithLink supersedes (and aborts) any in-flight attempt; only
    // the generation that is still current may adopt a session.
    const attempt = this.startAttempt(runtime, (epoch, signal) =>
      this.establishPairing(record, ticket, runtime, epoch, signal))
    attempt.catch(() => undefined)
    return this.requireView(record.deviceId)
  }

  /** Background half of {@link pairWithLink}: dial, handshake, adopt. */
  private async establishPairing(
    record: PeerRecord,
    ticket: PairingTicket,
    runtime: DaemonRuntime,
    epoch: number,
    signal: AbortSignal,
  ): Promise<void> {
    const connector = this.connector
    if (connector === undefined) return
    const remote: DeviceDescriptor = {
      deviceId: record.deviceId,
      name: record.name,
      platform: record.platform,
      signPk: record.signPk,
      dhPk: record.dhPk,
    }
    let lastError: unknown
    for (const endpoint of ticket.eps) {
      if (!this.isAttemptCurrent(runtime, record.deviceId, epoch)) return
      const timeout = new AbortController()
      // This timer only bounds one endpoint's dial/handshake; the approval
      // watcher below uses the (longer) pairing-approval window.
      const timer = setTimeout(() =>{  timeout.abort() }, PAIRING_CONNECT_TIMEOUT_MS)
      timer.unref?.()
      let transport: MeshTransport | undefined
      try {
        // Do not let one dead endpoint consume the whole approval window: dial
        // with a short per-endpoint budget, then keep the longer signal while
        // the daemon's local user decides.
        const dialTimeout = new AbortController()
        const dialTimer = setTimeout(() =>{  dialTimeout.abort() }, ENDPOINT_DIAL_TIMEOUT_MS)
        dialTimer.unref?.()
        let dialSignal: AbortSignal
        try {
          dialSignal = AbortSignal.any([signal, timeout.signal, dialTimeout.signal])
          transport = await this.dialEndpoint(endpoint, dialSignal)
        } finally {
          clearTimeout(dialTimer)
        }
        const sessionSignal = AbortSignal.any([signal, timeout.signal])
        if (!this.isAttemptCurrent(runtime, record.deviceId, epoch)) {
          transport.close(4001, 'pairing cancelled')
          return
        }
        const { session } = await connector.connect({
          transport,
          remote,
          auth: { kind: 'pair-token', token: ticket.tok, ticket },
          signal: sessionSignal,
        })
        if (!this.adoptSession(runtime, record, session, epoch)) {
          // A newer attempt (or an explicit cancel) superseded this handshake.
          session.close()
          return
        }
        void this.store.patchPeer('daemons', record.deviceId, {
          lastSeenAt: nowIso(this.now),
          endpoints: [endpoint, ...ticket.eps.filter(item => item !== endpoint)],
        }).catch(() => {})
        await this.store.appendAudit({
          action: 'session.opened',
          peer: record.deviceId,
          detail: 'pair-token',
        })
        this.changed()
        return
      } catch (error) {
        lastError = error
        transport?.close(4001, 'pairing failed')
        if (!this.isAttemptCurrent(runtime, record.deviceId, epoch)) return
        this.logger.warn(`device-mesh: pairing attempt via ${endpoint.k} failed: ${errorCodeAndMessage(error)}`)
      } finally {
        clearTimeout(timer)
      }
    }
    if (!this.isAttemptCurrent(runtime, record.deviceId, epoch)) return
    // A session that is already online stays authoritative: an attempt that
    // could not even establish a session must not turn it into an error (H4).
    if (runtime.session?.open === true) return
    runtime.status = 'error'
    runtime.detail = lastError === undefined
      ? 'no endpoint was reachable'
      : `pairing failed: ${errorCodeAndMessage(lastError)}`
    this.changed()
  }

  // -------------------------------------------------------------------------
  // Controller role: connections
  // -------------------------------------------------------------------------

  /** Ensure a controller session to a paired daemon is up. */
  async connectDevice(deviceId: string): Promise<MeshDeviceView> {
    const peer = this.requireDaemon(deviceId)
    if (peer.revokedAt !== null) throw new MeshRpcError('mesh/revoked', 'device has been revoked')
    const runtime = this.runtimeFor(deviceId)
    runtime.manualDisconnect = false
    if (runtime.session?.open === true) return this.requireView(deviceId)
    if (runtime.connecting !== undefined) {
      // Single-flight: a duplicate connect joins the attempt already running
      // instead of establishing a second session (H4).
      await runtime.connecting.catch(() => {})
      return this.requireView(deviceId)
    }
    const connecting = this.startAttempt(runtime, (epoch, signal) =>
      this.establish(runtime, peer, false, epoch, signal))
    await connecting
    return this.requireView(deviceId)
  }

  /** User-initiated disconnect: no automatic reconnect. */
  async disconnectDevice(deviceId: string): Promise<MeshDeviceView> {
    const runtime = this.runtimeFor(deviceId)
    runtime.manualDisconnect = true
    // Invalidate and abort an in-flight dial/handshake so its late success can
    // never re-adopt a session after the user disconnected (H5).
    this.cancelAttempt(runtime)
    if (runtime.reconnectTimer !== undefined) clearTimeout(runtime.reconnectTimer)
    runtime.reconnectTimer = undefined
    const session = runtime.session
    runtime.session = undefined
    runtime.status = 'offline'
    runtime.detail = undefined
    if (session !== undefined) session.close()
    await this.store.appendAudit({ action: 'session.closed', peer: deviceId, detail: 'manual' })
    this.changed()
    return this.requireView(deviceId)
  }

  private async establish(
    runtime: DaemonRuntime,
    peer: PeerRecord,
    automatic: boolean,
    epoch: number,
    signal: AbortSignal,
  ): Promise<MeshSession> {
    const connector = this.connector
    if (connector === undefined) {
      runtime.status = 'error'
      runtime.detail = 'session layer is unavailable'
      this.changed()
      throw new MeshRpcError('mesh/unsupported', runtime.detail)
    }
    // Dial only routes learned from that daemon's signed ticket. The local
    // relay configuration (and its own `serverId`) routes to this device, not to
    // the peer, so it can never stand in for a missing peer endpoint.
    const endpoints = peer.endpoints !== undefined && peer.endpoints.length > 0
      ? peer.endpoints
      : []
    if (endpoints.length === 0) {
      runtime.status = 'error'
      runtime.detail = 'no cached endpoint; re-pair with a fresh pairing link'
      this.changed()
      throw new MeshRpcError('mesh/not-found', runtime.detail)
    }
    if (!this.isAttemptCurrent(runtime, peer.deviceId, epoch)) {
      throw new MeshRpcError('mesh/internal', 'connection attempt was cancelled')
    }
    runtime.status = 'connecting'
    runtime.detail = undefined
    this.changed()
    let lastError: unknown
    for (const endpoint of endpoints) {
      if (!this.isAttemptCurrent(runtime, peer.deviceId, epoch)) {
        throw new MeshRpcError('mesh/internal', 'connection attempt was cancelled')
      }
      const timeout = new AbortController()
      const timer = setTimeout(() =>{  timeout.abort() }, HANDSHAKE_TIMEOUT_MS * 3)
      timer.unref?.()
      const sessionSignal = AbortSignal.any([signal, timeout.signal])
      let transport: MeshTransport | undefined
      try {
        const dialTimeout = new AbortController()
        const dialTimer = setTimeout(() =>{  dialTimeout.abort() }, ENDPOINT_DIAL_TIMEOUT_MS)
        dialTimer.unref?.()
        try {
          transport = await this.dialEndpoint(
            endpoint,
            AbortSignal.any([signal, timeout.signal, dialTimeout.signal]),
          )
        } finally {
          clearTimeout(dialTimer)
        }
        if (!this.isAttemptCurrent(runtime, peer.deviceId, epoch)) {
          transport.close(4001, 'connect cancelled')
          throw new MeshRpcError('mesh/internal', 'connection attempt was cancelled')
        }
        const { session } = await connector.connect({
          transport,
          remote: peer,
          auth: { kind: 'paired' },
          signal: sessionSignal,
        })
        if (!this.adoptSession(runtime, peer, session, epoch)) {
          session.close()
          throw new MeshRpcError('mesh/internal', 'connection attempt was cancelled')
        }
        const patch: { lastSeenAt: string; endpoints: readonly PairingEndpoint[] } = {
          lastSeenAt: nowIso(this.now),
          endpoints: [endpoint, ...endpoints.filter(item => item !== endpoint)],
        }
        void this.store.patchPeer('daemons', peer.deviceId, patch).catch(() => {})
        await this.store.appendAudit({
          action: 'session.opened',
          peer: peer.deviceId,
          detail: automatic ? 'reconnect' : 'manual',
        })
        this.changed()
        return session
      } catch (error) {
        lastError = error
        transport?.close(4001, 'connect failed')
        if (!this.isAttemptCurrent(runtime, peer.deviceId, epoch)) {
          // The attempt was cancelled by disconnect/forget/revoke or superseded;
          // never let its failure overwrite the live state.
          throw new MeshRpcError('mesh/internal', 'connection attempt was cancelled')
        }
        this.logger.warn(`device-mesh: connecting to ${peer.deviceId} via ${endpoint.k} failed: ${errorCodeAndMessage(error)}`)
      } finally {
        clearTimeout(timer)
      }
    }
    if (!this.isAttemptCurrent(runtime, peer.deviceId, epoch)) {
      throw new MeshRpcError('mesh/internal', 'connection attempt was cancelled')
    }
    runtime.status = 'error'
    runtime.detail = errorMessage(lastError)
    this.changed()
    if (!runtime.manualDisconnect) this.scheduleReconnect(peer.deviceId)
    throw lastError instanceof MeshRpcError
      ? lastError
      : new MeshRpcError('mesh/internal', runtime.detail ?? 'could not reach the device')
  }

  /**
   * Take over one freshly established session.
   *
   * @returns `false` when the attempt is stale (cancelled/superseded, peer
   * forgotten/revoked); the caller must close the session and discard it.
   */
  private adoptSession(
    runtime: DaemonRuntime,
    peer: PeerRecord,
    session: MeshSession,
    epoch: number,
  ): boolean {
    if (!this.canAdopt(runtime, peer, epoch)) {
      session.close()
      return false
    }
    // Only one live session per device: close the previous one before storing
    // the new one so no orphan stays connected on the daemon side (H4).
    const previous = runtime.session
    if (previous !== undefined && previous !== session) {
      runtime.session = undefined
      previous.close()
    }
    runtime.session = session
    runtime.heartbeatFailures = 0
    // Keep an open portal usable across a reconnect: swap its session instead
    // of closing the capability URL and forcing the user to reopen remote
    // control.
    this.portals.get(peer.deviceId)?.controller.adoptSession(session)
    const pendingPairing = session.pairing?.approval === 'pending'
    if (pendingPairing) {
      runtime.pairingSession = session
      runtime.status = 'connecting'
      runtime.detail = 'waiting for the controlled device to approve pairing'
    } else {
      runtime.pairingSession = undefined
      runtime.status = 'online'
      runtime.detail = undefined
    }
    runtime.reconnectAttempt = 0
    if (runtime.reconnectTimer !== undefined) clearTimeout(runtime.reconnectTimer)
    runtime.reconnectTimer = undefined
    void session.closed.then(() => {
      if (runtime.session !== session) return
      runtime.session = undefined
      const wasPending = runtime.pairingSession === session
      runtime.pairingSession = undefined
      if (wasPending) {
        // The daemon closed a first-contact session before approving it: this is
        // terminal, so clean up the pinned record and never reconnect (H3).
        void this.failFirstContact(
          runtime,
          peer,
          session,
          epoch,
          'pairing session closed before approval',
          'pairing-closed',
        )
        return
      }
      runtime.status = 'offline'
      void this.store.appendAudit({ action: 'session.closed', peer: peer.deviceId, detail: 'disconnected' })
      this.changed()
      if (!runtime.manualDisconnect && this.isAttemptCurrent(runtime, peer.deviceId, epoch)) {
        this.scheduleReconnect(peer.deviceId)
      }
    })
    if (pendingPairing) this.watchPairingApproval(runtime, peer, session, epoch)
    return true
  }

  /**
   * First-contact sessions become usable only after the daemon user approves.
   * Poll `pair.status` and flip the device online once the daemon authorizes
   * the session. Denial, timeout, an unauthorized approval and unexpected
   * watcher failure are terminal: the session and the pinned peer record are
   * cleaned up and automatic reconnects stay disabled (H3).
   */
  private watchPairingApproval(
    runtime: DaemonRuntime,
    peer: PeerRecord,
    session: MeshSession,
    epoch: number,
  ): void {
    const requestId = session.pairing?.requestId
    if (requestId === undefined) return
    void (async () => {
      const deadline = this.now() + this.pairingApprovalTimeoutMs
      while (
        this.isAttemptCurrent(runtime, peer.deviceId, epoch)
        && runtime.session === session
        && session.open
        && this.now() < deadline
      ) {
        let state: PairStatusResult['state'] = 'pending'
        try {
          const status = await session.rpc<PairStatusResult>('pair.status', { requestId })
          state = status.state
        } catch {
          if (!session.open) break
        }
        if (state === 'approved') {
          // Wait until the daemon's authorization gate actually flips before
          // declaring the device online (the status and the gate settle in
          // separate steps).
          const authorized = await this.waitForAuthorizedSession(session)
          if (!authorized) {
            await this.failFirstContact(
              runtime,
              peer,
              session,
              epoch,
              'pairing was approved but the session did not become authorized',
              'pairing-not-authorized',
            )
            return
          }
          runtime.pairingSession = undefined
          runtime.pairingRollback = undefined
          runtime.status = 'online'
          runtime.detail = undefined
          void this.store.patchPeer('daemons', peer.deviceId, { lastSeenAt: nowIso(this.now) }).catch(() => {})
          await this.store.appendAudit({ action: 'session.opened', peer: peer.deviceId, detail: 'pair-approved' })
          this.changed()
          return
        }
        if (state === 'denied') {
          await this.failFirstContact(
            runtime,
            peer,
            session,
            epoch,
            'pairing was denied on the controlled device',
            'pairing-denied',
          )
          return
        }
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 1_000)
          timer.unref?.()
        })
      }
      if (runtime.session === session) {
        await this.failFirstContact(
          runtime,
          peer,
          session,
          epoch,
          'pairing approval timed out',
          'pairing-timeout',
        )
      }
    })().catch(async (error: unknown) => {
      this.logger.warn(`device-mesh: pairing approval watcher failed: ${errorMessage(error)}`)
      await this.failFirstContact(
        runtime,
        peer,
        session,
        epoch,
        'pairing approval failed',
        'pairing-error',
      )
    })
  }

  /** Wait until the daemon answers a normal RPC again (authorization flip). */
  private async waitForAuthorizedSession(session: MeshSession): Promise<boolean> {
    const deadline = this.now() + 5_000
    while (session.open && this.now() < deadline) {
      try {
        // `info` goes through the daemon's authorization gate (`ping` is handled
        // below it by the session layer), so this is the honest readiness probe.
        await session.rpc('info')
        return true
      } catch {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 50)
          timer.unref?.()
        })
      }
    }
    return false
  }

  private scheduleReconnect(deviceId: string): void {
    const runtime = this.daemons.get(deviceId)
    if (runtime === undefined || runtime.manualDisconnect) return
    if (runtime.reconnectTimer !== undefined) return
    const peer = this.store.findPeer('daemons', deviceId)
    if (peer === undefined || peer.revokedAt !== null) return
    runtime.reconnectAttempt += 1
    const delay = Math.min(
      RECONNECT_MAX_MS,
      RECONNECT_MIN_MS * 2 ** Math.min(runtime.reconnectAttempt - 1, 5),
    )
    runtime.reconnectTimer = setTimeout(() => {
      runtime.reconnectTimer = undefined
      void this.connectDevice(deviceId).catch(() => {
        this.scheduleReconnect(deviceId)
      })
    }, delay)
    runtime.reconnectTimer.unref?.()
  }

  /** Health-check open controller sessions (PROTOCOL.md §3.2). */
  private async pollSessions(): Promise<void> {
    for (const [deviceId, runtime] of this.daemons) {
      const session = runtime.session
      if (session === undefined) continue
      try {
        await session.ping(5_000)
        runtime.heartbeatFailures = 0
        void this.store.patchPeer('daemons', deviceId, { lastSeenAt: nowIso(this.now) }).catch(() => {})
      } catch {
        runtime.heartbeatFailures += 1
        // Do not close on an application-ping miss: the transport close event is
        // the authoritative liveness signal, and a relay's RPC round-trip can be
        // dropped/queued while the tunnel itself is healthy. Treating a missed
        // ping as death produced a 10s reconnect loop that truncated portal
        // assets (white remote SPA).
        this.logger.warn(`device-mesh: session to ${deviceId} missed app heartbeat ${runtime.heartbeatFailures}`)
      }
    }
    this.changed()
  }

  private prunePortalIdle(): void {
    for (const [deviceId, record] of this.portals) {
      if (!record.controller.open) {
        this.portals.delete(deviceId)
        this.changed()
      }
    }
  }

  // -------------------------------------------------------------------------
  // Workspaces / portals (controller role)
  // -------------------------------------------------------------------------

  /**
   * Read workspaces: local when `deviceId` is omitted, otherwise the remote
   * daemon's list over its session.
   */
  async refreshWorkspaces(deviceId?: string): Promise<WorkspacesResult> {
    if (deviceId === undefined) return this.workspaces.list({ refresh: true })
    const peer = this.requireDaemon(deviceId)
    if (peer.revokedAt !== null) throw new MeshRpcError('mesh/revoked', 'device has been revoked')
    const runtime = this.runtimeFor(deviceId)
    const session = runtime.session
    if (session === undefined || !session.open) {
      throw new MeshRpcError('mesh/not-found', 'device is not connected')
    }
    const raw = await session.rpc<unknown>('workspaces.list', { refresh: true })
    const result = safeWorkspacesResult(raw)
    if (result === undefined) throw new MeshRpcError('mesh/internal', 'device returned an invalid workspace list')
    runtime.remoteWorkspaces = result
    runtime.remoteWorkspacesAt = result.updatedAt
    this.changed()
    return result
  }

  /**
   * Archive or restore one Session on a connected daemon.
   *
   * Returns the refreshed remote listing so the sidebar can drop/add the row
   * without waiting for the next poll window.
   * @param deviceId - paired remote device.
   * @param sessionId - Session on that device.
   * @param archived - true archives, false restores.
   * @param stopActivity - allow archiving a Session with running work.
   */
  async archiveSession(
    deviceId: string,
    sessionId: string,
    archived: boolean,
    stopActivity = false,
  ): Promise<WorkspacesResult> {
    const peer = this.requireDaemon(deviceId)
    if (peer.revokedAt !== null) throw new MeshRpcError('mesh/revoked', 'device has been revoked')
    const session = this.runtimeFor(deviceId).session
    if (session === undefined || !session.open) {
      throw new MeshRpcError('mesh/not-found', 'device is not connected')
    }
    await session.rpc(
      archived ? 'session.archive' : 'session.unarchive',
      { sessionId, ...(stopActivity ? { stopActivity: true } : {}) },
    )
    try {
      return await this.refreshWorkspaces(deviceId)
    } catch (error) {
      // The mutation already succeeded; a failed follow-up listing must not turn
      // it into an error the sidebar would report. Reuse the last listing and let
      // the next poll catch up.
      const cached = this.runtimeFor(deviceId).remoteWorkspaces
      if (cached !== undefined) return cached
      throw error
    }
  }

  /** Open the loopback portal for one connected daemon. */
  async openPortal(deviceId: string): Promise<{ readonly url: string }> {
    const peer = this.requireDaemon(deviceId)
    if (peer.revokedAt !== null) throw new MeshRpcError('mesh/revoked', 'device has been revoked')
    const runtime = this.runtimeFor(deviceId)
    const session = runtime.session
    if (session === undefined || !session.open) {
      throw new MeshRpcError('mesh/not-found', 'device is not connected')
    }
    const existing = this.portals.get(deviceId)
    if (existing !== undefined && existing.controller.open) {
      // Same device, possibly a reconnected Mesh session: keep the capability
      // URL and the loaded remote SPA, only adopt the new session.
      existing.controller.adoptSession(session)
      return { url: existing.controller.url }
    }
    await this.closePortal(deviceId)
    if (this.portal === undefined) {
      throw new MeshRpcError('mesh/unsupported', 'portal proxy is unavailable')
    }
    // Warm the daemon-side DSH login cookie before the browser starts loading
    // the SPA. Without this, the first parallel asset burst can race the cold
    // cookie acquisition and surface the shell's "plugin load failed" state.
    const warm = new AbortController()
    const warmTimer = setTimeout(() => { warm.abort() }, 5_000)
    warmTimer.unref?.()
    try {
      await session.rpc('portal.prepare', {}, { signal: warm.signal })
    } catch {
      // Portal open still returns a URL; the daemon retries on first request.
    } finally {
      clearTimeout(warmTimer)
    }
    const controller = await this.portal.open({
      session,
      deviceId,
      onClose: () => {
        this.portals.delete(deviceId)
        void this.store.appendAudit({ action: 'portal.closed', peer: deviceId })
        this.changed()
      },
    })
    this.portals.set(deviceId, { controller, deviceId })
    await this.store.appendAudit({ action: 'portal.opened', peer: deviceId })
    this.changed()
    return { url: controller.url }
  }

  /** Close the portal for one daemon (no-op when none is open). */
  async closePortal(deviceId: string): Promise<{ readonly closed: boolean }> {
    const record = this.portals.get(deviceId)
    if (record === undefined) return { closed: false }
    this.portals.delete(deviceId)
    // PortalController.close() invokes the onClose callback, which writes the
    // single `portal.closed` audit entry (doing it here too duplicated it).
    await record.controller.close().catch(() => {})
    this.changed()
    return { closed: true }
  }

  // -------------------------------------------------------------------------
  // Peer management
  // -------------------------------------------------------------------------

  /** Mark a peer revoked (immediately closing sessions/portals). */
  async revokePeer(deviceId: string): Promise<MeshDeviceView> {
    await this.closePortal(deviceId)
    this.closeInboundSessions(deviceId)
    // Serialized with pairing decisions: cancelling the pending requests and
    // revoking the record must be atomic against an approval that is already
    // past its first pending check (H2/M8).
    const records = await this.exclusivePairing(async () => {
      this.pairing.cancelPeer(deviceId, 'peer was revoked')
      const controllers = this.store.findPeer('controllers', deviceId)
      const daemons = this.store.findPeer('daemons', deviceId)
      if (controllers !== undefined) await this.store.revokePeer('controllers', deviceId)
      if (daemons !== undefined) await this.store.revokePeer('daemons', deviceId)
      return { controllers, daemons }
    })
    const runtime = this.daemons.get(deviceId)
    if (runtime !== undefined) {
      runtime.manualDisconnect = true
      // Abort a dial/handshake still in flight so it cannot complete after the
      // revocation and adopt a session (H5).
      this.cancelAttempt(runtime)
      if (runtime.reconnectTimer !== undefined) clearTimeout(runtime.reconnectTimer)
      runtime.reconnectTimer = undefined
      runtime.session?.close()
      runtime.session = undefined
      runtime.connecting = undefined
      runtime.status = 'revoked'
      runtime.detail = undefined
    }
    if (records.controllers === undefined && records.daemons === undefined) {
      throw new MeshRpcError('mesh/not-found', 'unknown peer')
    }
    await this.store.appendAudit({ action: 'peer.revoked', peer: deviceId })
    this.changed()
    const view = this.deviceView(deviceId)
    if (view !== undefined) return view
    const peer = records.daemons ?? records.controllers
    return buildPeerView(peer as PeerRecord, 'revoked')
  }

  /** Remove a peer from both directions (and close anything it owns). */
  async forgetPeer(deviceId: string): Promise<{ readonly forgot: boolean }> {
    await this.closePortal(deviceId)
    this.closeInboundSessions(deviceId)
    const runtime = this.daemons.get(deviceId)
    if (runtime !== undefined) {
      runtime.manualDisconnect = true
      // In-flight handshakes check their epoch/runtime before adopting, and the
      // abort shortens the dial; nothing this device owned may survive Forget.
      this.cancelAttempt(runtime)
      if (runtime.reconnectTimer !== undefined) clearTimeout(runtime.reconnectTimer)
      runtime.reconnectTimer = undefined
      runtime.session?.close()
      runtime.session = undefined
      runtime.connecting = undefined
    }
    this.daemons.delete(deviceId)
    const removed = await this.exclusivePairing(async () => {
      // A pending pairing request must not stay approvable after Forget (M8).
      this.pairing.cancelPeer(deviceId, 'peer was forgotten')
      const removedA = await this.store.removePeer('controllers', deviceId)
      const removedB = await this.store.removePeer('daemons', deviceId)
      return removedA || removedB
    })
    if (removed) this.changed()
    return { forgot: removed }
  }

  /** Rename a peer in whichever direction it is paired. */
  async renamePeer(deviceId: string, name: string): Promise<{ readonly renamed: boolean }> {
    const clean = name.trim()
    if (clean.length === 0 || clean.length > 120) {
      throw new MeshRpcError('mesh/bad-request', 'peer name must be 1-120 characters')
    }
    const inControllers = this.store.findPeer('controllers', deviceId) !== undefined
    const inDaemons = this.store.findPeer('daemons', deviceId) !== undefined
    if (!inControllers && !inDaemons) throw new MeshRpcError('mesh/not-found', 'unknown peer')
    if (inControllers) await this.store.patchPeer('controllers', deviceId, { name: clean })
    if (inDaemons) await this.store.patchPeer('daemons', deviceId, { name: clean })
    this.changed()
    return { renamed: true }
  }

  // -------------------------------------------------------------------------
  // Settings
  // -------------------------------------------------------------------------

  /** Update the direct listener settings and restart it when needed. */
  async configureDirect(patch: { readonly enabled?: boolean; readonly port?: number }): Promise<MeshHostState['direct']> {
    const settings = await this.store.updateSettings({ direct: patch })
    const direct = this.directListener
    this.directListener = undefined
    if (direct !== undefined) await direct.close().catch(() => {})
    this.listenPort = 0
    if (settings.direct.enabled && this.started) await this.startDirect()
    this.changed()
    return this.state().direct
  }

  /** Update relay settings and restart the relay daemon when needed. */
  async configureRelay(patch: {
    readonly endpoint?: string | null
    readonly enabled?: boolean
    readonly useTls?: boolean
  }): Promise<MeshHostState['relay']> {
    const settings = await this.store.updateSettings({ relay: patch })
    const relay = this.relayDaemon
    this.relayDaemon = undefined
    this.relayConnected = false
    if (relay !== undefined) await relay.close().catch(() => {})
    if (settings.relay.enabled && settings.relay.endpoint !== null && this.started) {
      await this.store.ensureRelayServerId()
      await this.startRelay()
    }
    this.changed()
    return this.state().relay
  }

  // -------------------------------------------------------------------------
  // State / audit / diagnostics
  // -------------------------------------------------------------------------

  /** Snapshot for the browser plugin (`state` endpoint). */
  state(): MeshHostState {
    const identity = this.store.getIdentity()
    const settings = this.store.getSettings()
    const controllers = this.store.getPeers().controllers
    const daemons = this.store.getPeers().daemons
    const deviceMap = new Map<string, MeshDeviceView>()
    for (const peer of daemons) {
      deviceMap.set(peer.deviceId, this.buildDaemonView(peer))
    }
    for (const peer of controllers) {
      const existing = deviceMap.get(peer.deviceId)
      const view = this.buildControllerView(peer)
      deviceMap.set(peer.deviceId, existing === undefined ? view : mergeDeviceViews(existing, view))
    }
    const portals: { readonly deviceId: string; readonly url: string }[] = []
    for (const [deviceId, record] of this.portals) {
      try {
        if (record.controller.open) portals.push({ deviceId, url: record.controller.url })
      } catch {
        // A closing portal simply does not appear.
      }
    }
    return {
      self: {
        deviceId: identity.deviceId,
        name: identity.name,
        platform: identity.platform,
        signPk: identity.signPk,
        dhPk: identity.dhPk,
        appVersion: this.appVersion,
      },
      protocol: PROTOCOL_VERSION,
      direct: {
        enabled: settings.direct.enabled && this.directListener !== undefined,
        port: this.directListener?.port ?? this.listenPort,
        urls: [...(this.directListener?.urls ?? [])],
      },
      relay: {
        configured: settings.relay.enabled && settings.relay.endpoint !== null,
        endpoint: settings.relay.endpoint,
        connected: this.relayConnected,
        useTls: settings.relay.useTls,
      },
      devices: [...deviceMap.values()],
      pendingPairings: this.pairing.listPending(),
      portals,
    }
  }

  /** Read the audit trail (newest first). */
  async listAudit(limit?: number): Promise<AuditEntry[]> {
    return this.store.listAudit(limit)
  }

  /** Diagnostics for the client plugin; never contains secrets. */
  diagnostics(): Record<string, unknown> {
    const settings = this.store.getSettings()
    return {
      plugin: 'dsh-device-mesh',
      appVersion: this.appVersion,
      protocol: PROTOCOL_VERSION,
      identity: {
        deviceId: this.store.getIdentity().deviceId,
        name: this.store.getIdentity().name,
        platform: this.store.getIdentity().platform,
      },
      paths: this.store.paths,
      direct: {
        configured: settings.direct.enabled,
        configuredPort: settings.direct.port,
        listening: this.directListener !== undefined,
        port: this.directListener?.port ?? 0,
        urls: [...(this.directListener?.urls ?? [])],
      },
      relay: {
        configured: settings.relay.enabled,
        endpoint: settings.relay.endpoint,
        serverIdPresent: this.store.getRelayServerId() !== undefined,
        connected: this.relayConnected,
      },
      pairing: {
        pendingTickets: this.pairing.pendingTicketCount,
        pendingRequests: this.pairing.pendingRequestCount,
      },
      workspaces: {
        lastError: this.workspaces.lastError ?? null,
        partial: this.workspaces.partial,
        cacheAgeMs: this.workspaces.cacheAgeMs ?? null,
      },
      portalDaemon: this.portalDaemon.status(),
      connections: [...this.daemons.entries()].map(([deviceId, runtime]) => ({
        deviceId,
        status: runtime.status,
        detail: runtime.detail ?? null,
        reconnectAttempt: runtime.reconnectAttempt,
        remoteWorkspacesAt: runtime.remoteWorkspacesAt ?? null,
      })),
      inbound: [...this.inbound.entries()].map(([deviceId, sessions]) => ({ deviceId, sessions: sessions.size })),
      portals: [...this.portals.values()].map(record => record.controller.status()),
      started: this.started,
    }
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /**
   * Serialize operations that read and then write the pairing queue or the
   * persisted controller records. The chain itself never rejects, so one failed
   * operation cannot poison the next.
   */
  private exclusivePairing<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.pairingChain.then(operation, operation)
    this.pairingChain = result.then(() => undefined, () => undefined)
    return result
  }

  /**
   * Undo a controller record written by a failed approval attempt.
   * @param deviceId - controller whose record was just persisted.
   * @param previous - record that existed before the attempt, if any.
   */
  private async rollbackController(deviceId: string, previous: PeerRecord | undefined): Promise<void> {
    try {
      if (previous === undefined) await this.store.removePeer('controllers', deviceId)
      else await this.store.upsertPeer('controllers', previous)
      this.changed()
    } catch (error) {
      this.logger.warn(`device-mesh: could not roll back unapproved controller: ${errorMessage(error)}`)
    }
  }

  /**
   * Start a new connection generation, aborting any attempt still in flight.
   * The returned promise is also stored in `runtime.connecting` so duplicate
   * callers can join it (single-flight).
   */
  private startAttempt<T>(
    runtime: DaemonRuntime,
    run: (epoch: number, signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    runtime.attemptAbort?.abort()
    runtime.epoch += 1
    const epoch = runtime.epoch
    const abort = new AbortController()
    runtime.attemptAbort = abort
    const attempt = run(epoch, abort.signal)
    runtime.connecting = attempt
    const settle = (): void => {
      if (runtime.attemptAbort === abort) runtime.attemptAbort = undefined
      if (runtime.connecting === attempt) runtime.connecting = undefined
    }
    void attempt.then(settle, settle)
    return attempt
  }

  /**
   * Invalidate the current generation and abort its dial/handshake. The actual
   * session is left to the caller so each cleanup path can close it with the
   * right audit detail.
   */
  private cancelAttempt(runtime: DaemonRuntime): void {
    runtime.epoch += 1
    runtime.attemptAbort?.abort()
    runtime.attemptAbort = undefined
    runtime.pairingSession = undefined
    runtime.pairingRollback = undefined
    runtime.pairingTerminal = false
  }

  /** Whether one attempt still owns this runtime and device. */
  private isAttemptCurrent(runtime: DaemonRuntime, deviceId: string, epoch: number): boolean {
    return this.daemons.get(deviceId) === runtime && runtime.epoch === epoch
  }

  /**
   * A late handshake may only adopt a session when the runtime is still live, the
   * peer is still paired/unrevoked and the user has not disconnected.
   */
  private canAdopt(runtime: DaemonRuntime, peer: PeerRecord, epoch: number): boolean {
    if (!this.isAttemptCurrent(runtime, peer.deviceId, epoch)) return false
    if (runtime.manualDisconnect) return false
    const record = this.store.findPeer('daemons', peer.deviceId)
    return record !== undefined && record.revokedAt === null
  }

  private requireView(deviceId: string): MeshDeviceView {
    const view = this.deviceView(deviceId)
    if (view === undefined) throw new MeshRpcError('mesh/not-found', 'device is no longer paired')
    return view
  }

  /**
   * Terminally fail a first-contact pairing: close the session, stop reconnects,
   * restore/remove the pinned daemon record and audit the outcome (never the
   * token or SAS). Idempotent, so the watcher and the session close hook may
   * race safely.
   */
  private async failFirstContact(
    runtime: DaemonRuntime,
    peer: PeerRecord,
    session: MeshSession,
    epoch: number,
    detail: string,
    auditDetail: string,
  ): Promise<void> {
    if (!this.isAttemptCurrent(runtime, peer.deviceId, epoch)) return
    if (runtime.pairingTerminal) return
    runtime.pairingTerminal = true
    // Invalidate every other in-flight operation (and any watcher iteration).
    runtime.epoch += 1
    runtime.attemptAbort?.abort()
    runtime.attemptAbort = undefined
    runtime.manualDisconnect = true
    runtime.pairingSession = undefined
    runtime.connecting = undefined
    runtime.reconnectAttempt = 0
    if (runtime.reconnectTimer !== undefined) clearTimeout(runtime.reconnectTimer)
    runtime.reconnectTimer = undefined
    if (runtime.session === session) runtime.session = undefined
    runtime.status = 'error'
    runtime.detail = detail
    const rollback = runtime.pairingRollback
    runtime.pairingRollback = undefined
    if (this.daemons.get(peer.deviceId) === runtime) this.daemons.delete(peer.deviceId)
    try {
      session.close()
    } catch {
      // Already closed by the peer.
    }
    this.changed()
    if (rollback !== undefined) {
      try {
        if (rollback.previous === undefined) await this.store.removePeer('daemons', peer.deviceId)
        else await this.store.upsertPeer('daemons', rollback.previous)
      } catch (error) {
        this.logger.warn(`device-mesh: could not roll back failed pairing: ${errorMessage(error)}`)
      }
    }
    // No secret material: only the fixed reason code goes to the audit trail.
    await this.store.appendAudit({ action: 'session.closed', peer: peer.deviceId, detail: auditDetail })
    this.changed()
  }

  private runtimeFor(deviceId: string): DaemonRuntime {
    const existing = this.daemons.get(deviceId)
    if (existing !== undefined) return existing
    const created: DaemonRuntime = {
      status: 'offline',
      detail: undefined,
      session: undefined,
      remoteWorkspaces: undefined,
      remoteWorkspacesAt: undefined,
      reconnectAttempt: 0,
      reconnectTimer: undefined,
      manualDisconnect: false,
      connecting: undefined,
      epoch: 0,
      attemptAbort: undefined,
      pairingTerminal: false,
      pairingRollback: undefined,
      pairingSession: undefined,
      heartbeatFailures: 0,
    }
    this.daemons.set(deviceId, created)
    return created
  }

  private requireDaemon(deviceId: string): PeerRecord {
    const peer = this.store.findPeer('daemons', deviceId)
    if (peer === undefined) throw new MeshRpcError('mesh/not-found', 'device is not paired as a controllable daemon')
    return peer
  }

  private async dialEndpoint(endpoint: PairingEndpoint, signal: AbortSignal): Promise<MeshTransport> {
    if (endpoint.k === 'direct') {
      const connect = this.factories.connectDirect
      if (connect === undefined) throw new MeshRpcError('mesh/unsupported', 'direct transport is unavailable')
      return connect(endpoint.url, { signal })
    }
    const connect = this.factories.connectRelay
    if (connect === undefined) throw new MeshRpcError('mesh/unsupported', 'relay transport is unavailable')
    return connect({ url: endpoint.url, serverId: endpoint.sid, version: endpoint.v, signal })
  }



  private buildDaemonView(peer: PeerRecord): MeshDeviceView {
    const runtime = this.daemons.get(peer.deviceId)
    const sessionOpen = runtime?.session?.open === true
    // A session that is open but still waiting for the daemon's pairing
    // approval is `connecting`, never `online` (portals/RPCs would be refused).
    const status: DeviceStatus = peer.revokedAt !== null
      ? 'revoked'
      : runtime?.status === 'online'
        ? (sessionOpen ? 'online' : 'offline')
        : runtime?.status === 'connecting'
          ? 'connecting'
          : runtime?.status ?? 'offline'
    // Show the SAS while the daemon user is being asked to approve this
    // controller, so both humans can compare the same six digits (M-2).
    const connectingSas = status === 'connecting' ? runtime?.session?.sas : undefined
    const view: MeshDeviceView = {
      deviceId: peer.deviceId,
      name: peer.name,
      platform: peer.platform,
      direction: 'daemon',
      pairedAt: peer.pairedAt,
      lastSeenAt: peer.lastSeenAt,
      revoked: peer.revokedAt !== null,
      scope: peer.scope,
      status,
      ...(runtime?.detail !== undefined && status !== 'online' ? { statusDetail: runtime.detail } : {}),
      ...(connectingSas !== undefined ? { sas: connectingSas } : {}),
      ...(runtime?.remoteWorkspaces !== undefined
        ? { remoteWorkspaces: runtime.remoteWorkspaces.workspaces }
        : {}),
      ...(runtime?.remoteWorkspacesAt !== undefined
        ? { remoteWorkspacesAt: runtime.remoteWorkspacesAt }
        : {}),
      ...(runtime?.remoteWorkspaces?.truncated === true ? { remoteWorkspacesTruncated: true } : {}),
    }
    return view
  }

  private buildControllerView(peer: PeerRecord): MeshDeviceView {
    const online = (this.inbound.get(peer.deviceId)?.size ?? 0) > 0
    const status: DeviceStatus = peer.revokedAt !== null ? 'revoked' : online ? 'online' : 'offline'
    return {
      deviceId: peer.deviceId,
      name: peer.name,
      platform: peer.platform,
      direction: 'controller',
      pairedAt: peer.pairedAt,
      lastSeenAt: peer.lastSeenAt,
      revoked: peer.revokedAt !== null,
      scope: peer.scope,
      status,
    }
  }

  private deviceView(deviceId: string): MeshDeviceView | undefined {
    const daemon = this.store.findPeer('daemons', deviceId)
    const controller = this.store.findPeer('controllers', deviceId)
    const daemonView = daemon !== undefined ? this.buildDaemonView(daemon) : undefined
    const controllerView = controller !== undefined ? this.buildControllerView(controller) : undefined
    if (daemonView !== undefined && controllerView !== undefined) {
      return mergeDeviceViews(daemonView, controllerView)
    }
    return daemonView ?? controllerView
  }
}

/** Default grant persisted for a newly paired controller. */
export function defaultControlScope(): PairingScope {
  return { kind: 'control', workspaces: 'all', expiresAt: null }
}

function mergeDeviceViews(daemon: MeshDeviceView, controller: MeshDeviceView): MeshDeviceView {
  const status: DeviceStatus = daemon.status === 'online' || controller.status === 'online'
    ? 'online'
    : daemon.status !== 'offline'
      ? daemon.status
      : controller.status
  return {
    ...controller,
    status,
    ...(daemon.statusDetail !== undefined ? { statusDetail: daemon.statusDetail } : {}),
    ...(daemon.status === 'connecting' && daemon.sas !== undefined ? { sas: daemon.sas } : {}),
    ...(daemon.remoteWorkspaces !== undefined ? { remoteWorkspaces: daemon.remoteWorkspaces } : {}),
    ...(daemon.remoteWorkspacesAt !== undefined ? { remoteWorkspacesAt: daemon.remoteWorkspacesAt } : {}),
    ...(daemon.remoteWorkspacesTruncated === true ? { remoteWorkspacesTruncated: true } : {}),
  }
}

function buildPeerView(peer: PeerRecord, status: DeviceStatus): MeshDeviceView {
  return {
    deviceId: peer.deviceId,
    name: peer.name,
    platform: peer.platform,
    direction: 'daemon',
    pairedAt: peer.pairedAt,
    lastSeenAt: peer.lastSeenAt,
    revoked: peer.revokedAt !== null,
    scope: peer.scope,
    status,
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

function errorCodeAndMessage(error: unknown): string {
  if (isRecord(error) && typeof error.code === 'string') return `${error.code}: ${errorMessage(error)}`
  return errorMessage(error)
}
