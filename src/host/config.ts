/**
 * Host plugin configuration, filesystem locations, logging, and defensive DSH
 * service access.
 *
 * Everything in this module is pure: it never imports a DSH package and never
 * touches the network. That keeps the broker, persistence and proxy modules
 * unit-testable without a running DeepSeek Harness.
 */

import { homedir, hostname } from 'node:os'
import { join } from 'node:path'

import type { DevicePlatform, MeshSettings } from '../shared/protocol.ts'
import { DEFAULT_DIRECT_PORT } from '../shared/protocol.ts'

/** Package name; also the Cordis loader row id and client module id. */
export const PLUGIN_NAME = 'device-mesh'

/** Fallback app version reported in `info` when no config overrides it. */
export const PLUGIN_VERSION = '0.0.1'

/** Directory under `$DSH_HOME` holding every durable mesh file. */
export const MESH_DIR_NAME = 'device-mesh'

/** Pairing QR/link lifetime (PROTOCOL.md §2.1). */
export const PAIRING_TICKET_TTL_MS = 10 * 60 * 1000

/** How long an inbound "approve this controller?" request waits for the user. */
export const PAIRING_REQUEST_TTL_MS = 5 * 60 * 1000

/** How long `workspaces.list` answers are cached (task requirement: 60 s). */
export const WORKSPACE_CACHE_MS = 60_000

/** Default idle timeout after which an unused controller-side portal closes. */
export const PORTAL_IDLE_TIMEOUT_MS = 30 * 60 * 1000

/** Hard cap on one proxied HTTP request body (PROTOCOL.md §9). */
export const PORTAL_MAX_BODY_BYTES = 64 * 1024 * 1024

/** Maximum number of pending "approve this controller?" prompts. */
export const MAX_PENDING_PAIRINGS = 8

/** Audit log rotation threshold. */
export const MAX_AUDIT_BYTES = 8 * 1024 * 1024

/** Default number of audit rows returned by `audit.list`. */
export const AUDIT_DEFAULT_LIMIT = 100

/** Direct listener maximum concurrent inbound connections (PROTOCOL.md §9). */
export const DIRECT_MAX_CONNECTIONS = 16

/** Hard cap on inbound controller sessions across every paired controller. */
export const MAX_INBOUND_SESSIONS = 64

/** Hard cap on inbound controller sessions for one controller. */
export const MAX_INBOUND_SESSIONS_PER_CONTROLLER = 8

/** HTTP upgrade timeout for both direct listener and local web proxy. */
export const HANDSHAKE_TIMEOUT_MS = 10_000
/** Bound for dialing one pairing endpoint before trying the next one. */
export const ENDPOINT_DIAL_TIMEOUT_MS = 8_000

/** How often an online controller session's application heartbeat is sampled. */
export const SESSION_PING_INTERVAL_MS = 30_000

/** Reconnect backoff floor / ceiling for controller connections. */
export const RECONNECT_MIN_MS = 1_000
export const RECONNECT_MAX_MS = 30_000

/**
 * Upper bound for dialing + Noise + application auth on one pairing endpoint.
 * Covers the slowest carrier handshake (relay, 15 s) plus the channel's 60 s
 * application-auth window, with margin; the approval watcher has its own,
 * longer window below.
 */
export const PAIRING_CONNECT_TIMEOUT_MS = 90_000

/**
 * Time to wait for a peer's pairing approval before giving up (controller side).
 *
 * Must outlive the daemon's local approval window ({@link PAIRING_REQUEST_TTL_MS});
 * otherwise the controller rolls back while the daemon can still approve and
 * persist a controller record it can never reach. The extra 30 s covers the
 * status poll and persistence.
 */
export const PAIRING_APPROVAL_TIMEOUT_MS = PAIRING_REQUEST_TTL_MS + 30_000

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

export type MeshLogLevel = 'debug' | 'info' | 'warn' | 'error'

/** Minimal logger seam; messages must never contain tokens, keys or cookies. */
export interface MeshLogger {
  debug(message: string): void
  info(message: string): void
  warn(message: string): void
  error(message: string): void
}

/** Logger that discards everything (default for tests). */
export const silentLogger: MeshLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
}

const LOG_LEVEL_WEIGHT: Readonly<Record<MeshLogLevel, number>> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
}

/**
 * Create a console logger with a fixed prefix and minimum level.
 * @param prefix - line prefix, e.g. `[device-mesh]`.
 * @param minimum - lowest emitted level.
 * @returns logger writing to `console`.
 */
export function createConsoleLogger(
  prefix = '[device-mesh]',
  minimum: MeshLogLevel = 'info',
): MeshLogger {
  const floor = LOG_LEVEL_WEIGHT[minimum]
  const emit = (level: MeshLogLevel, message: string): void => {
    if (LOG_LEVEL_WEIGHT[level] < floor) return
    const line = `${prefix} ${message}`
    if (level === 'error') console.error(line)
    else if (level === 'warn') console.warn(line)
    else console.log(line)
  }
  return {
    debug: (message) =>{  emit('debug', message) },
    info: (message) =>{  emit('info', message) },
    warn: (message) =>{  emit('warn', message) },
    error: (message) =>{  emit('error', message) },
  }
}

/**
 * Wrap a logger so thrown/rejected callbacks cannot escape through logging.
 * @param logger - underlying logger.
 * @returns the same surface with every call guarded.
 */
export function safeLogger(logger: MeshLogger): MeshLogger {
  const guard = (level: MeshLogLevel) => (message: string): void => {
    try {
      logger[level](message)
    } catch {
      // A broken logger must never break the mesh.
    }
  }
  return {
    debug: guard('debug'),
    info: guard('info'),
    warn: guard('warn'),
    error: guard('error'),
  }
}

// ---------------------------------------------------------------------------
// Small structural guards shared by the host modules
// ---------------------------------------------------------------------------

/** Narrow an unknown value to a plain record. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Return `value` when it is a non-empty string, otherwise `undefined`. */
export function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** Return `value` when it is a finite number, otherwise `undefined`. */
export function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** Return `value` when it is a boolean, otherwise `undefined`. */
export function asBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

// ---------------------------------------------------------------------------
// Defensive DSH service access
// ---------------------------------------------------------------------------

/**
 * The subset of a Cordis host context this plugin relies on. Kept structural so
 * the modules can be exercised with plain objects in tests.
 */
export interface HostContextLike {
  readonly get?: (name: string) => unknown
  /** Cordis effect registrar; the host plugin uses it for cleanup. */
  readonly effect?: (callback: () => void | (() => void | Promise<void>), label?: string) => unknown
  readonly [key: string]: unknown
}

/**
 * Read a DSH service without assuming it exists.
 *
 * `ctx.get(name)` is the Cordis-supported lookup; the direct property read is
 * only a fallback for minimal test contexts. Both are guarded so a missing or
 * throwing service degrades instead of failing plugin activation.
 *
 * @param ctx - host context (or `undefined`).
 * @param name - service name, e.g. `workspaceRegistry`.
 * @returns the service, or `undefined` when absent.
 */
export function getHostService(ctx: HostContextLike | undefined, name: string): unknown {
  if (ctx === undefined || ctx === null) return undefined
  const lookup = ctx.get
  if (typeof lookup === 'function') {
    try {
      const value = lookup.call(ctx, name)
      if (value !== undefined && value !== null) return value
    } catch {
      // A failing service lookup is treated as "absent".
    }
  }
  try {
    const direct = Reflect.get(ctx, name)
    if (direct !== undefined && direct !== null) return direct
  } catch {
    // Fall through to undefined.
  }
  return undefined
}

/** Read a function member off an unknown service object. */
export function serviceMethod(
  service: unknown,
  name: string,
): ((...args: unknown[]) => unknown) | undefined {
  if (typeof service !== 'object' || service === null) return undefined
  try {
    const value = Reflect.get(service, name)
    return typeof value === 'function'
      ? (value as (...args: unknown[]) => unknown).bind(service)
      : undefined
  } catch {
    return undefined
  }
}

// ---------------------------------------------------------------------------
// Paths, platform and defaults
// ---------------------------------------------------------------------------

/**
 * Resolve the DeepSeek Harness home directory.
 * @param env - environment map, defaults to `process.env`.
 * @returns absolute `$DSH_HOME` path (defaults to `~/.dsh`).
 */
export function resolveDshHome(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.DSH_HOME
  if (typeof configured === 'string' && configured.trim().length > 0) {
    return configured.trim()
  }
  return join(homedir(), '.dsh')
}

/**
 * Resolve the mesh state directory (`$DSH_HOME/device-mesh` unless overridden).
 * @param options - optional explicit home override.
 * @param env - environment map.
 * @returns absolute state directory path.
 */
export function resolveMeshHome(
  options: { readonly home?: string } = {},
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (typeof options.home === 'string' && options.home.trim().length > 0) {
    return options.home.trim()
  }
  return join(resolveDshHome(env), MESH_DIR_NAME)
}

/**
 * Map a Node platform string onto the wire vocabulary.
 * @param platform - `process.platform`-shaped value.
 * @returns protocol platform name.
 */
export function mapPlatform(platform: string = process.platform): DevicePlatform {
  switch (platform) {
    case 'darwin':
    case 'linux':
    case 'win32':
    case 'android':
    case 'ios':
    case 'web':
      return platform
    default:
      return 'unknown'
  }
}

/** Human readable platform label used in the default device name. */
function platformLabel(platform: DevicePlatform): string {
  switch (platform) {
    case 'darwin':
      return 'macOS'
    case 'linux':
      return 'Linux'
    case 'win32':
      return 'Windows'
    case 'android':
      return 'Android'
    case 'ios':
      return 'iOS'
    case 'web':
      return 'Web'
    default:
      return 'Device'
  }
}

/**
 * Build the default device display name.
 * @param platform - protocol platform.
 * @param host - hostname; defaults to `os.hostname()`.
 * @returns e.g. `study-mac (macOS)`.
 */
export function defaultDeviceNameInternal(
  platform: DevicePlatform,
  host: string = hostname(),
): string {
  const trimmed = host.trim()
  const label = platformLabel(platform)
  return trimmed.length > 0 ? `${trimmed} (${label})` : `DSH ${label}`
}

/**
 * Build the initial settings document written on first start.
 * @param deviceName - optional display name override.
 * @returns fresh `MeshSettings`.
 */
export function defaultMeshSettings(deviceName?: string): MeshSettings {
  return {
    version: 1,
    ...(deviceName !== undefined && deviceName.length > 0 ? { deviceName } : {}),
    direct: { enabled: true, port: DEFAULT_DIRECT_PORT },
    relay: { endpoint: null, useTls: true, enabled: false },
    portal: { idleTimeoutMs: PORTAL_IDLE_TIMEOUT_MS },
    autoApprovePairing: false,
  }
}

// ---------------------------------------------------------------------------
// Plugin config schema
// ---------------------------------------------------------------------------

/** User-facing plugin config accepted from the Cordis loader row. */
export interface MeshPluginConfig {
  /** Overrides the state directory (default `$DSH_HOME/device-mesh`). */
  readonly home?: string
  /** Device display name used when creating the identity. */
  readonly deviceName?: string
  /** Version reported to peers in `info`. */
  readonly appVersion?: string
  readonly direct?: {
    readonly enabled?: boolean
    readonly port?: number
    /** Bind address for the direct listener; default `0.0.0.0`. */
    readonly host?: string
  }
  readonly relay?: {
    /** Full WebSocket URL of the paseo-relay, e.g. `wss://relay.example.com/ws`. */
    readonly endpoint?: string | null
    readonly useTls?: boolean
  }
  readonly portal?: {
    readonly idleTimeoutMs?: number
    readonly maxBodyBytes?: number
  }
  readonly autoApprovePairing?: boolean
  readonly logLevel?: MeshLogLevel
  /** Never open listeners or dial peers (tests / emergency stop). */
  readonly offline?: boolean
}

/** Fully resolved plugin config with defaults applied. */
export interface ResolvedMeshPluginConfig {
  readonly home: string
  readonly deviceName: string
  readonly appVersion: string
  readonly direct: {
    readonly enabled: boolean
    readonly port: number
    readonly host: string
  }
  readonly relay: {
    readonly endpoint: string | null
    readonly useTls: boolean
  }
  readonly portal: {
    readonly idleTimeoutMs: number
    readonly maxBodyBytes: number
  }
  readonly autoApprovePairing: boolean
  readonly logLevel: MeshLogLevel
  readonly offline: boolean
}

/** Invalid plugin config; surfaced as Cordis validation issues. */
export class ConfigValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConfigValidationError'
  }
}

function optionalBoolean(value: unknown, path: string): boolean | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'boolean') throw new ConfigValidationError(`${path} must be a boolean`)
  return value
}

function optionalString(value: unknown, path: string): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw new ConfigValidationError(`${path} must be a string`)
  return value
}

function optionalPositiveInteger(value: unknown, path: string): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new ConfigValidationError(`${path} must be a positive integer`)
  }
  return value
}

function optionalLogLevel(value: unknown): MeshLogLevel | undefined {
  if (value === undefined) return undefined
  if (value === 'debug' || value === 'info' || value === 'warn' || value === 'error') return value
  throw new ConfigValidationError('logLevel must be one of debug, info, warn, error')
}

/** True for a hostname that never leaves the local machine. */
export function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[/u, '').replace(/\]$/u, '')
  return host === '127.0.0.1' || host === '::1' || host === 'localhost'
}

/**
 * Normalize a raw relay endpoint into a full `ws(s)://…/ws` URL.
 *
 * Plain `ws://` is accepted only for loopback hosts: the relay carries the
 * encrypted Mesh session as opaque frames, but its own control channel and
 * routing metadata are not protected, so a public relay must use TLS. Local
 * E2E runs with `ws://127.0.0.1` keep working.
 *
 * @param value - user supplied endpoint (URL, `host:port`, or empty).
 * @param options - `useTls: false` prefixes a bare host with `ws://`;
 *   `allowInsecure: true` accepts a plain `ws://` non-loopback URL. The UI only
 *   enables that flag after an explicit user opt-in, because a public relay
 *   without TLS leaks control metadata and allows tampering.
 * @returns normalized URL, or `null` when disabled.
 * @throws {ConfigValidationError} for unparsable input or insecure remote transport.
 */
export function normalizeRelayEndpoint(
  value: string | null | undefined,
  options: { readonly allowInsecure?: boolean; readonly useTls?: boolean } = {},
): string | null {
  if (value === undefined || value === null) return null
  let text = value.trim()
  if (text.length === 0) return null
  const defaultScheme = options.useTls === false ? 'ws' : 'wss'
  if (text.startsWith('//')) text = `${defaultScheme}:${text}`
  else if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//u.test(text)) text = `${defaultScheme}://${text}`
  let url: URL
  try {
    url = new URL(text)
  } catch {
    throw new ConfigValidationError(`relay endpoint is not a valid URL: ${JSON.stringify(value)}`)
  }
  if (url.protocol === 'http:') url.protocol = 'ws:'
  else if (url.protocol === 'https:') url.protocol = 'wss:'
  if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
    throw new ConfigValidationError('relay endpoint must use ws:// or wss://')
  }
  if (url.protocol === 'ws:' && !isLoopbackHostname(url.hostname) && options.allowInsecure !== true) {
    throw new ConfigValidationError('relay endpoint must use wss:// for non-loopback hosts')
  }
  if (url.pathname === '' || url.pathname === '/') url.pathname = '/ws'
  if (url.search.length > 0) url.search = ''
  if (url.hash.length > 0) url.hash = ''
  return url.toString()
}

/**
 * Validate and normalize the plugin's loader-row config.
 * @param raw - untrusted config value from Cordis (often `{}`).
 * @param env - environment map supplying `DSH_HOME`.
 * @param options - test seams (hostname, platform).
 * @returns fully resolved config.
 * @throws {ConfigValidationError} on invalid input.
 */
export function resolvePluginConfig(
  raw: unknown,
  env: NodeJS.ProcessEnv = process.env,
  options: { readonly hostname?: string; readonly platform?: DevicePlatform } = {},
): ResolvedMeshPluginConfig {
  if (raw !== undefined && raw !== null && !isRecord(raw)) {
    throw new ConfigValidationError('device-mesh config must be an object')
  }
  const config: Record<string, unknown> = isRecord(raw) ? raw : {}
  const platform = options.platform ?? mapPlatform()
  const deviceName = optionalString(config.deviceName, 'deviceName')
    ?? defaultDeviceNameInternal(platform, options.hostname ?? hostname())
  const directRaw = config.direct
  if (directRaw !== undefined && !isRecord(directRaw)) {
    throw new ConfigValidationError('direct must be an object')
  }
  const direct = isRecord(directRaw) ? directRaw : {}
  const relayRaw = config.relay
  if (relayRaw !== undefined && !isRecord(relayRaw)) {
    throw new ConfigValidationError('relay must be an object')
  }
  const relay = isRecord(relayRaw) ? relayRaw : {}
  const portalRaw = config.portal
  if (portalRaw !== undefined && !isRecord(portalRaw)) {
    throw new ConfigValidationError('portal must be an object')
  }
  const portal = isRecord(portalRaw) ? portalRaw : {}

  const directPort = optionalPositiveInteger(direct.port, 'direct.port')
  if (directPort !== undefined && directPort > 65535) {
    throw new ConfigValidationError('direct.port must be <= 65535')
  }
  const directHost = optionalString(direct.host, 'direct.host')
  const relayEndpoint = config.relay !== undefined
    ? normalizeRelayEndpoint(relay.endpoint as string | null | undefined)
    : null

  return {
    home: resolveMeshHome(
      { ...(optionalString(config.home, 'home') !== undefined ? { home: optionalString(config.home, 'home') as string } : {}) },
      env,
    ),
    deviceName,
    appVersion: optionalString(config.appVersion, 'appVersion') ?? PLUGIN_VERSION,
    direct: {
      enabled: optionalBoolean(direct.enabled, 'direct.enabled') ?? true,
      port: directPort ?? DEFAULT_DIRECT_PORT,
      host: directHost ?? '0.0.0.0',
    },
    relay: {
      endpoint: relayEndpoint,
      useTls: optionalBoolean(relay.useTls, 'relay.useTls') ?? true,
    },
    portal: {
      idleTimeoutMs: optionalPositiveInteger(portal.idleTimeoutMs, 'portal.idleTimeoutMs')
        ?? PORTAL_IDLE_TIMEOUT_MS,
      maxBodyBytes: optionalPositiveInteger(portal.maxBodyBytes, 'portal.maxBodyBytes')
        ?? PORTAL_MAX_BODY_BYTES,
    },
    autoApprovePairing: optionalBoolean(config.autoApprovePairing, 'autoApprovePairing') ?? false,
    logLevel: optionalLogLevel(config.logLevel) ?? 'info',
    offline: optionalBoolean(config.offline, 'offline') ?? false,
  }
}

/** Standard Schema issue shape consumed by Cordis. */
export interface StandardSchemaIssue {
  readonly message: string
  readonly path?: readonly (string | number)[]
}

/**
 * Standard Schema (`~standard`) object accepted by Cordis' plugin `Config`
 * export. Hand-written so the host bundle needs no dependency on
 * `@deepseek-ai/schemastery`.
 */
export const Config = {
  '~standard': {
    version: 1 as const,
    vendor: PLUGIN_NAME,
    validate(value: unknown):
      | { readonly value: ResolvedMeshPluginConfig }
      | { readonly issues: readonly StandardSchemaIssue[] } {
      try {
        return { value: resolvePluginConfig(value) }
      } catch (error) {
        return {
          issues: [{
            message: error instanceof Error ? error.message : String(error),
          }],
        }
      }
    },
  },
} as const

/** Public (non-secret) device identity shape re-exported for convenience. */
export type { DevicePlatform, MeshSettings }
