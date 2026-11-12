/**
 * `dsh-device-mesh` Host plugin (Cordis entry point).
 *
 * Activation order mirrors the ds-bot third-party plugin convention:
 *   1. open durable state under `$DSH_HOME/device-mesh`;
 *   2. build the broker, workspace model and both portal proxies;
 *   3. start the direct listener / relay daemon (best effort);
 *   4. register `POST /api/device-mesh` on the shared authenticated `/api`
 *      channel via `ctx.connection.fetch.register`.
 *
 * DSH services are read through `ctx.get(...)` so a reduced composition (or a
 * future DSH version) degrades to "feature unavailable" instead of failing to
 * load the plugin.
 */

import type {
  DeviceDescriptor,
  MeshCapability,
  MeshInfo,
} from '../shared/protocol.ts'
import { PROTOCOL_VERSION } from '../shared/protocol.ts'
import type { MeshSession } from '../shared/mesh-session.ts'
import { MeshRpcError } from '../shared/mesh-session.ts'
import { acceptMeshChannel, connectMeshChannel, NonceReplayCache } from './channel.ts'
import type { DaemonAuthContext } from './channel.ts'
import { deviceDescriptorOf, generateDeviceIdentity } from './crypto.ts'
import { Config as meshConfigSchema, createConsoleLogger, getHostService, isRecord, resolvePluginConfig, safeLogger } from './config.ts'
import type { HostContextLike, MeshLogger, ResolvedMeshPluginConfig } from './config.ts'
import { DeviceMeshBroker } from './broker.ts'
import type { BrokerTransportFactories, ControllerConnectOptions, PortalOpener } from './broker.ts'
import { PairingService } from './pairing.ts'
import { MeshStore } from './store.ts'
import { PortalDaemon } from './portal-daemon.ts'
import { PortalController } from './portal-controller.ts'
import { connectDirect, startDirectListener } from './transport/direct.ts'
import { connectRelayClient, startRelayDaemon } from './transport/relay.ts'
import type { MeshTransport } from '../shared/transport.ts'
import { WorkspaceProvider } from './workspaces.ts'
import { createWebApi } from './web-api.ts'
import type { WebApi } from './web-api.ts'

export { Config } from './config.ts'

/** Cordis plugin name; also the Loader row id and client module id. */
export const name = 'device-mesh'

/**
 * Services required before activation. Both are composed by the shipped Web
 * profile and by the Desktop host; optional services (workspace registry,
 * sessions, …) are looked up defensively at runtime.
 */
export const inject = ['webServer', 'connection']

/** Capabilities advertised over the mesh. */
const CAPABILITIES: readonly MeshCapability[] = ['rpc', 'portal', 'workspaces', 'pairing', 'relay']

/** Structural view of the DSH Connection host service used here. */
interface HostConnectionFetch {
  register(route: {
    readonly path: string
    readonly methods: readonly string[]
    readonly requestBody: 'buffered' | 'streaming'
    readonly fetch: (request: Request) => Promise<Response>
  }): () => void | Promise<void>
}

interface HostConnectionService {
  readonly fetch?: HostConnectionFetch
}

/** Runtime built by {@link createHostRuntime}; exported for tests/inspection. */
export interface HostRuntime {
  readonly config: ResolvedMeshPluginConfig
  readonly store: MeshStore
  readonly pairing: PairingService
  readonly workspaces: WorkspaceProvider
  readonly portalDaemon: PortalDaemon
  readonly broker: DeviceMeshBroker
  readonly api: WebApi
  /** Stop listeners, sessions, portals and dispose the runtime. */
  stop(): Promise<void>
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(new MeshRpcError('mesh/internal', 'operation was cancelled'))
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    timer.unref?.()
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(new MeshRpcError('mesh/internal', 'operation was cancelled'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * Retry one RPC while the daemon still reports "not authorized yet" (the
 * approval decision and the channel's `pairingPending` flag settle in separate
 * microtasks).
 */
async function rpcWithAuthorizationRetry<T>(
  session: MeshSession,
  method: string,
  params?: unknown,
): Promise<T> {
  const deadline = Date.now() + 2_000
  for (;;) {
    try {
      return await session.rpc<T>(method, params)
    } catch (error) {
      const unauthorized = error instanceof MeshRpcError && error.code === 'mesh/unauthorized'
      if (!unauthorized || !session.open || Date.now() > deadline) throw error
      await delay(50)
    }
  }
}

/**
 * Build the controller-side session connector on top of `channel.ts`.
 * @param store - persistent state (identity + pins).
 * @param logger - warning sink.
 * @param appVersion - version advertised on the wire.
 */
function createControllerConnector(
  store: MeshStore,
  logger: MeshLogger,
  appVersion: string,
): { connect(options: ControllerConnectOptions): Promise<{ readonly session: MeshSession }> } {
  return {
    async connect(options: ControllerConnectOptions): Promise<{ readonly session: MeshSession }> {
      const identity = store.getIdentity()
      const auth = options.auth.kind === 'pair-token'
        ? {
          kind: 'pair-token' as const,
          daemonId: options.remote.deviceId,
          token: options.auth.token,
        }
        : { kind: 'paired' as const }
      const session = await connectMeshChannel({
        transport: options.transport,
        identity,
        daemon: options.remote,
        auth,
        appVersion,
        capabilities: [...CAPABILITIES],
        hostLabel: identity.name,
      })
      try {
        if (session.pairing?.approval === 'pending') {
          // First contact: `pair.complete` returns immediately and the broker
          // watches `pair.status` in the background (the local user has not
          // clicked "allow" yet). Nothing else may run over this session until
          // the daemon approves it.
          logger.debug(`device-mesh: pairing request pending for ${options.remote.deviceId}`)
        } else {
          // The daemon flips its authorization gate asynchronously after an
          // approval decision; retry briefly so a fast status poll cannot race
          // the first authorized RPC.
          const info = await rpcWithAuthorizationRetry<MeshInfo>(session, 'info')
          if (info.protocol !== PROTOCOL_VERSION) {
            throw new MeshRpcError('mesh/version-mismatch', 'peer protocol version is not supported')
          }
        }
      } catch (error) {
        const code = isRecord(error) && typeof error.code === 'string' ? `${error.code}: ` : ''
        logger.warn(`device-mesh: controller channel to ${options.remote.deviceId} failed: ${code}${error instanceof Error ? error.message : String(error)}`)
        session.close()
        throw error
      }
      logger.debug(`device-mesh: controller session established with ${options.remote.deviceId}`)
      return { session }
    },
  }
}

/** Portal opener on top of the loopback reverse proxy. */
function createPortalOpener(config: ResolvedMeshPluginConfig, logger: MeshLogger): PortalOpener {
  return {
    open(options) {
      return PortalController.open({
        session: options.session,
        deviceId: options.deviceId,
        onClose: options.onClose,
        idleTimeoutMs: config.portal.idleTimeoutMs,
        maxBodyBytes: config.portal.maxBodyBytes,
        cacheDir: `${config.home}/portal-cache`,
        logger,
      })
    },
  }
}

/**
 * Wire an accepted inbound daemon transport into the Noise channel.
 * @param options - transport, store, broker and logger.
 */
async function acceptInboundTransport(options: {
  readonly transport: MeshTransport
  readonly store: MeshStore
  readonly broker: DeviceMeshBroker
  readonly logger: MeshLogger
  readonly appVersion: string
  readonly nonceCache: NonceReplayCache
}): Promise<void> {
  const { transport, store, broker, logger } = options
  const identity = store.getIdentity()
  logger.debug(`device-mesh: inbound ${transport.kind} transport from ${transport.remoteLabel}; starting channel`)
  const authenticatedController: { deviceId: string | undefined } = { deviceId: undefined }
  const handlers = broker.createDaemonHandlers(() => authenticatedController.deviceId)
  let session: MeshSession
  try {
    session = await acceptMeshChannel({
      transport,
      identity,
      appVersion: options.appVersion,
      capabilities: [...CAPABILITIES],
      hostLabel: identity.name,
      handlers,
      nonceCache: options.nonceCache,
      authenticate: async (context: DaemonAuthContext) => {
        const controller = context.client.controller
        logger.debug(`device-mesh: inbound auth kind=${context.client.auth.kind} controller=${controller.deviceId}`)
        try {
          if (context.client.auth.kind === 'paired') {
            const peer = broker.lookupPairedController(controller.deviceId)
            if (peer === undefined) {
              throw new MeshRpcError('mesh/unauthorized', 'unknown, revoked or expired controller')
            }
            authenticatedController.deviceId = controller.deviceId
            return { kind: 'paired', peer }
          }
          const outcome = await broker.beginPairToken(
            controller,
            context.client.auth.token,
            context.handshakeHash,
            context.sas,
          )
          authenticatedController.deviceId = controller.deviceId
          return outcome
        } catch (error) {
          const code = isRecord(error) && typeof error.code === 'string' ? error.code : 'mesh/unauthorized'
          logger.warn(`device-mesh: inbound authentication failed: ${error instanceof Error ? error.message : String(error)}`)
          void store.appendAudit({ action: 'auth.failed', peer: controller.deviceId, detail: code })
          throw error
        }
      },
    })
  } catch (error) {
    const code = isRecord(error) && typeof error.code === 'string' ? `${error.code}: ` : ''
    logger.warn(`device-mesh: inbound ${transport.kind} session rejected: ${code}${error instanceof Error ? error.message : String(error)}`)
    return
  }
  const deviceId = session.remote.deviceId
  const pendingRequestId = session.pairing?.requestId
  if (pendingRequestId !== undefined) {
    // First contact: a pending prompt must not survive its controller session.
    broker.trackPendingPairing(pendingRequestId, session)
  }
  broker.noteInboundOpened(deviceId, session)
  void session.closed.then(() => {
    broker.noteInboundClosed(deviceId, session)
  })
  logger.info(`device-mesh: inbound ${transport.kind} session established with ${deviceId}`)
}

/** Transport factories backed by `src/host/transport/**`. */
function createTransportFactories(logger: MeshLogger): BrokerTransportFactories {
  return {
    startDirectListener: (options, onAccept) => startDirectListener(
      {
        port: options.port,
        ...(options.host !== undefined ? { host: options.host } : {}),
        ...(options.maxConnections !== undefined ? { maxConnections: options.maxConnections } : {}),
        logger,
      },
      onAccept,
    ),
    connectDirect: (url, options) => connectDirect(url, {
      ...(options?.signal !== undefined ? { signal: options.signal } : {}),
      logger,
    }),
    startRelayDaemon: async (options, onClient) => startRelayDaemon({
      url: options.url,
      serverId: options.serverId,
      version: options.version,
      ...(options.minBackoffMs !== undefined ? { minBackoffMs: options.minBackoffMs } : {}),
      ...(options.maxBackoffMs !== undefined ? { maxBackoffMs: options.maxBackoffMs } : {}),
      logger,
    }, onClient),
    connectRelay: options => connectRelayClient({
      url: options.url,
      serverId: options.serverId,
      version: options.version,
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
      logger,
    }),
  }
}

/**
 * Build the full host runtime (state, broker, local API). Does not register the
 * Fetch route; {@link apply} does that through `ctx.effect`.
 *
 * @param ctx - Cordis host context (or a structural fake in tests).
 * @param rawConfig - loader-row config.
 * @returns initialized runtime.
 */
/**
 * Desktop-only capability: open the portal in the system browser. The DSH
 * desktop main window denies arbitrary `window.open`, so the shell must ask the
 * Electron main process instead. Plain `dsh web` has no electron module and
 * falls back to the browser popup path.
 */
async function resolveExternalOpener(): Promise<((url: string) => Promise<boolean>) | undefined> {
  // The Desktop host is spawned with ELECTRON_RUN_AS_NODE=1, so `require('electron')`
  // is unavailable there; fall back to the operating system's URL opener. Plain
  // `dsh web` (a normal Node server) has neither marker and must not open a
  // browser on the server machine.
  const desktopHost = process.env.ELECTRON_RUN_AS_NODE === '1' || process.versions.electron !== undefined
  if (!desktopHost) return undefined
  try {
    const { spawn } = await import('node:child_process')
    return async (url: string): Promise<boolean> => {
      const [command, args] = process.platform === 'darwin'
        ? ['open', [url]]
        : process.platform === 'win32'
          ? ['cmd', ['/c', 'start', '', url]]
          : ['xdg-open', [url]]
      try {
        const child = spawn(command, args, { detached: true, stdio: 'ignore' })
        child.unref()
        return true
      } catch {
        return false
      }
    }
  } catch {
    return undefined
  }
}

export async function createHostRuntime(
  ctx: HostContextLike,
  rawConfig?: unknown,
): Promise<HostRuntime> {
  const config = resolvePluginConfig(rawConfig)
  const logger = safeLogger(createConsoleLogger('[device-mesh]', config.logLevel))
  const identityFactory = (): ReturnType<typeof generateDeviceIdentity> => generateDeviceIdentity({
    name: config.deviceName,
  })
  const store = await MeshStore.open({
    home: config.home,
    logger,
    deviceName: config.deviceName,
    identityFactory,
    initialSettings: {
      version: 1,
      deviceName: config.deviceName,
      direct: { enabled: config.direct.enabled, port: config.direct.port },
      relay: {
        endpoint: config.relay.endpoint,
        useTls: config.relay.useTls,
        enabled: config.relay.endpoint !== null,
      },
      portal: { idleTimeoutMs: config.portal.idleTimeoutMs },
      autoApprovePairing: config.autoApprovePairing,
    },
  })
  const pairing = new PairingService({
    identity: store.getIdentity(),
    store,
    autoApprove: () => store.getSettings().autoApprovePairing,
  })
  const workspaces = new WorkspaceProvider({ ctx, logger })
  const portalDaemon = new PortalDaemon({ ctx, logger })
  const nonceCache = new NonceReplayCache()
  const broker = new DeviceMeshBroker({
    store,
    pairing,
    workspaces,
    portalDaemon,
    factories: createTransportFactories(logger),
    connector: createControllerConnector(store, logger, config.appVersion),
    portal: createPortalOpener(config, logger),
    logger,
    appVersion: config.appVersion,
    offline: config.offline,
    directHost: config.direct.host,
    onInboundTransport: (transport: MeshTransport) => {
      // Check before the Noise handshake so a burst of accepted sockets is
      // closed cheaply; the broker also enforces per-controller limits.
      if (!broker.canAcceptInbound()) {
        logger.warn('device-mesh: inbound session limit reached; rejecting transport')
        transport.close(1013, 'mesh busy')
        return
      }
      void acceptInboundTransport({
        transport,
        store,
        broker,
        logger,
        appVersion: config.appVersion,
        nonceCache,
      }).catch((error: unknown) => {
        logger.warn(`device-mesh: inbound session failed: ${error instanceof Error ? error.message : String(error)}`)
      })
    },
  })
  try {
    await broker.start()
  } catch (error) {
    logger.warn(`device-mesh: broker start was incomplete: ${error instanceof Error ? error.message : String(error)}`)
  }
  const openExternal = await resolveExternalOpener()
  const api = createWebApi({
    broker,
    logger,
    ...(openExternal === undefined ? {} : { openExternal }),
  })
  return {
    config,
    store,
    pairing,
    workspaces,
    portalDaemon,
    broker,
    api,
    async stop(): Promise<void> {
      await broker.stop()
      await store.close()
    },
  }
}

/**
 * Cordis plugin entry.
 * @param ctx - Cordis host context.
 * @param rawConfig - loader-row config (validated by {@link Config}).
 */
export async function apply(ctx: HostContextLike, rawConfig?: unknown): Promise<void> {
  const runtime = await createHostRuntime(ctx, rawConfig)
  const connection = getHostService(ctx, 'connection') as HostConnectionService | undefined
  const registry = connection?.fetch
  // Register the runtime disposer *first*: if a later route registration throws,
  // the broker/listener must still be torn down instead of leaking behind a
  // failed plugin load (M15).
  try {
    ctx.effect?.(() => () => {
      void runtime.stop()
    }, 'device-mesh: runtime')
    if (registry !== undefined && typeof registry.register === 'function') {
      ctx.effect?.(() => registry.register({
        path: runtime.api.path,
        methods: ['POST'],
        requestBody: 'buffered',
        fetch: (request: Request) => runtime.api.handle(request),
      }), 'device-mesh: local API route')
    } else {
      // A composition without Connection cannot expose the browser API; the
      // broker/session machinery still ran, so keep the plugin loaded.
      console.warn('[device-mesh] ctx.connection.fetch.register is unavailable; local API disabled')
    }
  } catch (error) {
    // Do not rely on Cordis rollback: an effect that was already registered may
    // not have disposed the runtime yet when `apply` rejects.
    await runtime.stop().catch(() => {})
    throw error
  }
}

/** Re-exported for the package manifest / tests. */
export { meshConfigSchema as ConfigSchema }

/** Type guard used by the plugin manager when inspecting the config export. */
export const supportsMeshConfig = (value: unknown): boolean =>
  isRecord(value) && isRecord(value['~standard'])

/** Public descriptor of this host's identity (diagnostics only). */
export function selfDescriptor(store: MeshStore): DeviceDescriptor {
  return deviceDescriptorOf(store.getIdentity())
}
