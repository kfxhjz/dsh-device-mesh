/**
 * Durable device-mesh state under `$DSH_HOME/device-mesh/`.
 *
 * Files (all private, written `0600`, atomically via temp file + rename):
 *   - `identity.json`  — this device's identity and private keys.
 *   - `peers.json`     — paired controllers (daemon role) and daemons
 *                        (controller role), plus the relay `serverId`.
 *   - `settings.json`  — listener / relay / portal / pairing settings.
 *   - `audit.jsonl`    — append-only audit trail (never message contents).
 *
 * Concurrency: an in-process promise mutex serializes writers in this process
 * and a `0600` lock file serializes writers across processes (a second DSH
 * instance sharing the same `$DSH_HOME`).
 *
 * Corruption: a file that fails to parse or validate is renamed to
 * `<name>.corrupt-<timestamp>` and rebuilt from defaults; the plugin keeps
 * working instead of failing to load.
 */

import { randomBytes } from 'node:crypto'
import {
  appendFile,
  chmod,
  mkdir,
  open,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { join } from 'node:path'

import type {
  AuditEntry,
  DeviceIdentity,
  DevicePlatform,
  DeviceDescriptor,
  MeshSettings,
  PeerRecord,
  PeersFile,
  PairingEndpoint,
  PairingScope,
} from '../shared/protocol.ts'
import { fromBase64Url, toBase64Url } from '../shared/protocol.ts'
import { defaultDeviceNameInternal, defaultMeshSettings, isRecord, mapPlatform, MAX_AUDIT_BYTES, AUDIT_DEFAULT_LIMIT, silentLogger } from './config.ts'
import type { MeshLogger } from './config.ts'
import {
  base32Lower,
  deviceIdFromSignPublicKey,
  generateDeviceIdentity,
  parseDeviceIdentity,
  sha256Hex,
  signEd25519,
  verifyEd25519,
} from './crypto.ts'

const IDENTITY_FILE = 'identity.json'
const PEERS_FILE = 'peers.json'
const SETTINGS_FILE = 'settings.json'
const AUDIT_FILE = 'audit.jsonl'
const LOCK_FILE = '.state.lock'

/** Default cross-process lock wait / stale threshold. */
const DEFAULT_LOCK_TIMEOUT_MS = 5_000
const DEFAULT_STALE_LOCK_MS = 15_000

// ---------------------------------------------------------------------------
// Crypto helpers (single source of truth: `crypto.ts`)
// ---------------------------------------------------------------------------

/**
 * Re-exported so existing callers/tests keep one import surface.
 * `crypto.ts` owns base32, key encoding, signing and identity validation.
 */
export { base32Lower, sha256Hex, signEd25519, verifyEd25519 }

/**
 * Derive the public device id from an Ed25519 public key.
 * `dm_` + first 22 lowercase base32 chars of `sha256(raw public key)`.
 * @param signPk - base64url raw 32-byte Ed25519 public key.
 * @returns device id, or `undefined` when the key is malformed.
 */
export function deriveDeviceId(signPk: string): string | undefined {
  try {
    return deviceIdFromSignPublicKey(signPk)
  } catch {
    return undefined
  }
}

/**
 * Build a fresh device identity with Ed25519 signing and X25519 static keys.
 *
 * Delegates to `crypto.generateDeviceIdentity` so key generation and
 * key-pair consistency checks live in one place.
 *
 * @param options - optional name / platform / clock / hostname overrides.
 * @returns new identity (private halves included).
 */
export function createDeviceIdentity(options: {
  readonly name?: string
  readonly platform?: DevicePlatform
  readonly now?: () => number
  readonly hostname?: string
} = {}): DeviceIdentity {
  const platform = options.platform ?? mapPlatform()
  const now = options.now ?? Date.now
  return generateDeviceIdentity({
    name: options.name ?? defaultDeviceNameInternal(platform, options.hostname),
    platform,
    createdAt: new Date(now()).toISOString(),
  })
}

// ---------------------------------------------------------------------------
// File helpers
// ---------------------------------------------------------------------------

function errorCode(error: unknown): string | undefined {
  return isRecord(error) && typeof error.code === 'string' ? error.code : undefined
}

/**
 * Atomically replace a file: write a sibling temp file, fsync-ish close, then
 * rename. The temp file inherits the target mode, so secrets never appear
 * world-readable even briefly.
 * @param path - destination path.
 * @param data - file contents.
 * @param mode - permission bits (default 0600).
 */
export async function atomicWriteFile(
  path: string,
  data: string | Uint8Array,
  mode = 0o600,
): Promise<void> {
  const temp = `${path}.tmp-${process.pid.toString(36)}-${randomBytes(6).toString('hex')}`
  let handle: FileHandle | undefined
  try {
    handle = await open(temp, 'w', mode)
    await handle.writeFile(data)
    await handle.sync()
    await handle.close()
    handle = undefined
    await chmod(temp, mode)
    await rename(temp, path)
  } catch (error) {
    if (handle !== undefined) await handle.close().catch(() => {})
    await unlink(temp).catch(() => {})
    throw error
  }
}

type JsonReadResult =
  | { readonly status: 'missing' }
  | { readonly status: 'invalid' }
  | { readonly status: 'ok'; readonly value: unknown }

/**
 * Read and parse a JSON file, distinguishing "absent" from "corrupt" so the
 * caller can decide whether a backup is warranted.
 * @param path - file to read.
 * @returns tagged parse result.
 */
async function readJsonResult(path: string): Promise<JsonReadResult> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch {
    return { status: 'missing' }
  }
  try {
    return { status: 'ok', value: JSON.parse(text) as unknown }
  } catch {
    return { status: 'invalid' }
  }
}

/**
 * Read a JSON file, tolerating absence/corruption as `undefined`.
 * @param path - file to read.
 * @returns parsed JSON, or `undefined`.
 */
async function readJsonFile(path: string): Promise<unknown> {
  const result = await readJsonResult(path)
  return result.status === 'ok' ? result.value : undefined
}

/**
 * Move a corrupt file aside so it can be inspected, keeping its bytes.
 * @param path - corrupt file.
 * @param logger - warning sink (path only, never contents).
 */
async function backupCorruptFile(path: string, logger: MeshLogger): Promise<void> {
  const backup = `${path}.corrupt-${Date.now().toString(36)}`
  try {
    await rename(path, backup)
    logger.warn(`device-mesh: moved corrupt state file to ${backup}`)
  } catch {
    logger.warn(`device-mesh: could not move corrupt state file ${path} aside`)
  }
}

/** Delay helper for lock retry loops. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
  })
}

/** In-process async mutex (FIFO, never rejects the chain). */
function createMutex(): <T>(callback: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve()
  return <T>(callback: () => Promise<T>): Promise<T> => {
    const run = tail.then(callback, callback)
    tail = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }
}

/**
 * Acquire the cross-process state lock.
 * @param lockPath - lock file path.
 * @param timeoutMs - maximum wait.
 * @param staleMs - age after which an abandoned lock is broken.
 * @returns release function.
 */
async function acquireStateLock(
  lockPath: string,
  timeoutMs: number,
  staleMs: number,
): Promise<() => Promise<void>> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    let handle: FileHandle | undefined
    try {
      handle = await open(lockPath, 'wx', 0o600)
      await handle.writeFile(JSON.stringify({ pid: process.pid, at: Date.now() }))
      return async () => {
        await handle?.close().catch(() => {})
        await unlink(lockPath).catch(() => {})
      }
    } catch (error) {
      if (handle !== undefined) await handle.close().catch(() => {})
      if (errorCode(error) !== 'EEXIST') throw error
      try {
        const info = await stat(lockPath)
        if (Date.now() - info.mtimeMs > staleMs) {
          await unlink(lockPath).catch(() => {})
          continue
        }
      } catch {
        continue
      }
      if (Date.now() >= deadline) {
        throw new Error('device-mesh: timed out waiting for the state lock')
      }
      await delay(8 + Math.floor(Math.random() * 20))
    }
  }
}

// ---------------------------------------------------------------------------
// Validation / sanitizers
// ---------------------------------------------------------------------------

const PLATFORMS: readonly DevicePlatform[] = [
  'darwin',
  'linux',
  'win32',
  'android',
  'ios',
  'web',
  'unknown',
]

function isPlatform(value: unknown): value is DevicePlatform {
  return typeof value === 'string' && (PLATFORMS as readonly string[]).includes(value)
}

function isB64Key32(value: unknown): value is string {
  const raw = typeof value === 'string' ? fromBase64Url(value) : undefined
  return raw !== undefined && raw.byteLength === 32
}

function sanitizeScope(value: unknown): PairingScope {
  if (isRecord(value)) {
    const kind = value.kind === 'view' ? 'view' : 'control'
    const workspaces = value.workspaces === 'all'
      ? 'all'
      : Array.isArray(value.workspaces)
        ? value.workspaces.filter((item): item is string => typeof item === 'string')
        : 'all'
    const expiresAt = typeof value.expiresAt === 'number' && Number.isFinite(value.expiresAt)
      ? value.expiresAt
      : null
    return { kind, workspaces, expiresAt }
  }
  return { kind: 'control', workspaces: 'all', expiresAt: null }
}

function sanitizeEndpoint(value: unknown): PairingEndpoint | undefined {
  if (!isRecord(value)) return undefined
  if (value.k === 'direct' && typeof value.url === 'string') {
    return { k: 'direct', url: value.url }
  }
  if (
    value.k === 'relay'
    && typeof value.url === 'string'
    && typeof value.sid === 'string'
    && (value.v === 1 || value.v === 2)
  ) {
    return { k: 'relay', url: value.url, sid: value.sid, v: value.v }
  }
  return undefined
}

/**
 * Validate and normalize one stored peer record.
 * @param value - untrusted JSON row.
 * @returns sanitized record, or `undefined` when unusable.
 */
export function sanitizePeerRecord(value: unknown): PeerRecord | undefined {
  if (!isRecord(value)) return undefined
  const { deviceId, name, platform, signPk, dhPk, pairedAt } = value
  if (typeof deviceId !== 'string' || deviceId.length === 0) return undefined
  if (typeof name !== 'string') return undefined
  if (!isPlatform(platform)) return undefined
  if (!isB64Key32(signPk) || !isB64Key32(dhPk)) return undefined
  if (typeof pairedAt !== 'string') return undefined
  const endpoints = Array.isArray(value.endpoints)
    ? value.endpoints.map(sanitizeEndpoint).filter((item): item is PairingEndpoint => item !== undefined)
    : undefined
  const record: PeerRecord = {
    deviceId,
    name,
    platform,
    signPk,
    dhPk,
    scope: sanitizeScope(value.scope),
    pairedAt,
    lastSeenAt: typeof value.lastSeenAt === 'string' ? value.lastSeenAt : null,
    revokedAt: typeof value.revokedAt === 'string' ? value.revokedAt : null,
    ...(endpoints !== undefined && endpoints.length > 0 ? { endpoints } : {}),
  }
  return record
}

function sanitizePeersFile(value: unknown, logger: MeshLogger): PeersFile | undefined {
  if (!isRecord(value) || value.version !== 1) return undefined
  const controllers = Array.isArray(value.controllers)
    ? value.controllers.map(sanitizePeerRecord).filter((item): item is PeerRecord => item !== undefined)
    : []
  const daemons = Array.isArray(value.daemons)
    ? value.daemons.map(sanitizePeerRecord).filter((item): item is PeerRecord => item !== undefined)
    : []
  const dropped = (Array.isArray(value.controllers) ? value.controllers.length : 0) - controllers.length
    + (Array.isArray(value.daemons) ? value.daemons.length : 0) - daemons.length
  if (dropped > 0) logger.warn(`device-mesh: dropped ${dropped} unusable peer record(s)`)
  return {
    version: 1,
    controllers,
    daemons,
    ...(typeof value.relayServerId === 'string' && value.relayServerId.length > 0
      ? { relayServerId: value.relayServerId }
      : {}),
  }
}

function sanitizeSettings(value: unknown): MeshSettings {
  const defaults = defaultMeshSettings()
  if (!isRecord(value)) return defaults
  const direct = isRecord(value.direct) ? value.direct : {}
  const relay = isRecord(value.relay) ? value.relay : {}
  const portal = isRecord(value.portal) ? value.portal : {}
  const directPort = typeof direct.port === 'number' && Number.isSafeInteger(direct.port)
    && direct.port > 0 && direct.port <= 65535
    ? direct.port
    : defaults.direct.port
  const idleTimeoutMs = typeof portal.idleTimeoutMs === 'number'
    && Number.isFinite(portal.idleTimeoutMs) && portal.idleTimeoutMs > 0
    ? portal.idleTimeoutMs
    : defaults.portal.idleTimeoutMs
  return {
    version: 1,
    ...(typeof value.deviceName === 'string' && value.deviceName.length > 0
      ? { deviceName: value.deviceName }
      : {}),
    direct: {
      enabled: typeof direct.enabled === 'boolean' ? direct.enabled : defaults.direct.enabled,
      port: directPort,
    },
    relay: {
      endpoint: typeof relay.endpoint === 'string' && relay.endpoint.length > 0
        ? relay.endpoint
        : null,
      useTls: typeof relay.useTls === 'boolean' ? relay.useTls : defaults.relay.useTls,
      enabled: typeof relay.enabled === 'boolean' ? relay.enabled : defaults.relay.enabled,
    },
    portal: { idleTimeoutMs },
    autoApprovePairing: typeof value.autoApprovePairing === 'boolean'
      ? value.autoApprovePairing
      : defaults.autoApprovePairing,
  }
}

function sanitizeIdentity(value: unknown): DeviceIdentity | undefined {
  if (!isRecord(value) || value.version !== 1) return undefined
  try {
    // `parseDeviceIdentity` validates the shape and proves each private key
    // matches its public half; a mismatched identity must not be loaded.
    return parseDeviceIdentity(value)
  } catch {
    return undefined
  }
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

/** Options accepted by {@link MeshStore.open}. */
export interface MeshStoreOptions {
  /** Absolute state directory, normally `$DSH_HOME/device-mesh`. */
  readonly home: string
  readonly logger?: MeshLogger
  readonly now?: () => number
  /** Overrides the built-in `createDeviceIdentity` (tests / crypto.ts adapter). */
  readonly identityFactory?: () => DeviceIdentity | Promise<DeviceIdentity>
  /** Overrides the default device name used when creating an identity. */
  readonly deviceName?: string
  readonly platform?: DevicePlatform
  readonly lockTimeoutMs?: number
  readonly staleLockMs?: number
  readonly maxAuditBytes?: number
  /** Settings used only when `settings.json` is first created (plugin config). */
  readonly initialSettings?: MeshSettings
}

/** Mutable peers document used inside a `mutatePeers` callback. */
export interface PeersDraft {
  version: 1
  controllers: PeerRecord[]
  daemons: PeerRecord[]
  relayServerId?: string
}

/** Patch accepted by {@link MeshStore.updateSettings}. */
export interface SettingsPatch {
  readonly deviceName?: string
  readonly direct?: { readonly enabled?: boolean; readonly port?: number }
  readonly relay?: {
    readonly endpoint?: string | null
    readonly useTls?: boolean
    readonly enabled?: boolean
  }
  readonly portal?: { readonly idleTimeoutMs?: number }
  readonly autoApprovePairing?: boolean
}

/** Audit entry as accepted by {@link MeshStore.appendAudit}. */
export type AuditInput = Omit<AuditEntry, 'at'> & { readonly at?: string }

/** Absolute paths of the managed files (exposed for diagnostics/tests). */
export interface MeshStorePaths {
  readonly home: string
  readonly identity: string
  readonly peers: string
  readonly settings: string
  readonly audit: string
  readonly lock: string
}

/**
 * Durable mesh state. Construct with {@link MeshStore.open}; every read method
 * is synchronous against the last loaded snapshot, every write reloads under a
 * lock so multiple processes sharing one `$DSH_HOME` cannot clobber each other.
 */
export class MeshStore {
  private readonly logger: MeshLogger
  private readonly now: () => number
  private readonly identityFactory: () => DeviceIdentity | Promise<DeviceIdentity>
  private readonly lockTimeoutMs: number
  private readonly staleLockMs: number
  private readonly maxAuditBytes: number
  private readonly initialSettings: MeshSettings | undefined
  private readonly mutex = createMutex()
  private readonly homeValue: string

  private identityValue: DeviceIdentity | undefined
  private peersValue: PeersFile = { version: 1, controllers: [], daemons: [] }
  private settingsValue: MeshSettings
  private initialized = false

  private constructor(options: MeshStoreOptions) {
    this.logger = options.logger ?? silentLogger
    this.now = options.now ?? Date.now
    this.identityFactory = options.identityFactory
      ?? (() => createDeviceIdentity({
        ...(options.deviceName !== undefined ? { name: options.deviceName } : {}),
        ...(options.platform !== undefined ? { platform: options.platform } : {}),
        now: options.now ?? Date.now,
      }))
    this.lockTimeoutMs = options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS
    this.staleLockMs = options.staleLockMs ?? DEFAULT_STALE_LOCK_MS
    this.maxAuditBytes = options.maxAuditBytes ?? MAX_AUDIT_BYTES
    this.initialSettings = options.initialSettings
    this.settingsValue = options.initialSettings ?? defaultMeshSettings()
    const home = options.home.trim()
    if (home.length === 0) throw new Error('device-mesh: store home must be non-empty')
    this.homeValue = home
  }

  /**
   * Open (and if needed create) the mesh state directory.
   * @param options - home directory plus test seams.
   * @returns initialized store.
   */
  static async open(options: MeshStoreOptions): Promise<MeshStore> {
    const store = new MeshStore(options)
    await store.init()
    return store
  }

  /** Absolute paths of every managed file. */
  get paths(): MeshStorePaths {
    const home = this.homeValue
    return {
      home,
      identity: join(home, IDENTITY_FILE),
      peers: join(home, PEERS_FILE),
      settings: join(home, SETTINGS_FILE),
      audit: join(home, AUDIT_FILE),
      lock: join(home, LOCK_FILE),
    }
  }

  /** Create the directory, load/repair state, and ensure the identity exists. */
  async init(): Promise<void> {
    if (this.initialized) return
    const home = this.homeValue
    await mkdir(home, { recursive: true, mode: 0o700 })
    await chmod(home, 0o700).catch(() => {})
    await this.loadIdentity()
    await this.loadPeers()
    await this.loadSettings()
    await this.reconcileDeviceName()
    await this.requireAuditFile()
    this.initialized = true
  }

  private async loadIdentity(): Promise<void> {
    const path = join(this.homeValue, IDENTITY_FILE)
    const read = await readJsonResult(path)
    const raw = read.status === 'ok' ? read.value : undefined
    const sanitized = sanitizeIdentity(raw)
    if (sanitized !== undefined) {
      this.identityValue = sanitized
      await chmod(path, 0o600).catch(() => {})
      return
    }
    const replaced = read.status === 'invalid' || (read.status === 'ok' && raw !== undefined)
    if (replaced) {
      // Never rotate device keys silently: keep the old bytes aside and make the
      // replacement visible in both the log and the audit trail.
      await backupCorruptFile(path, this.logger)
      await this.appendAudit({ action: 'identity.regenerated', detail: 'invalid identity file' })
      this.logger.warn('device-mesh: identity file was invalid; generated a new identity (old file backed up)')
    }
    const created = await this.identityFactory()
    const validated = sanitizeIdentity(created)
    if (validated === undefined) throw new Error('device-mesh: identity factory produced an invalid identity')
    await atomicWriteFile(path, JSON.stringify(validated, null, 2), 0o600)
    this.identityValue = validated
    await this.appendAudit({ action: 'identity.created', peer: validated.deviceId })
    this.logger.info(`device-mesh: created device identity ${validated.deviceId}`)
  }

  private async loadPeers(): Promise<void> {
    const path = join(this.homeValue, PEERS_FILE)
    const read = await readJsonResult(path)
    const raw = read.status === 'ok' ? read.value : undefined
    const sanitized = sanitizePeersFile(raw, this.logger)
    if (sanitized !== undefined) {
      this.peersValue = sanitized
      await chmod(path, 0o600).catch(() => {})
      return
    }
    if (read.status === 'invalid' || (read.status === 'ok' && raw !== undefined)) {
      await backupCorruptFile(path, this.logger)
    }
    this.peersValue = { version: 1, controllers: [], daemons: [] }
    await atomicWriteFile(path, JSON.stringify(this.peersValue, null, 2), 0o600)
  }

  private async loadSettings(): Promise<void> {
    const path = join(this.homeValue, SETTINGS_FILE)
    const read = await readJsonResult(path)
    const raw = read.status === 'ok' ? read.value : undefined
    if (raw !== undefined && isRecord(raw) && raw.version === 1) {
      this.settingsValue = sanitizeSettings(raw)
      await chmod(path, 0o600).catch(() => {})
      return
    }
    if (read.status === 'invalid' || (read.status === 'ok' && raw !== undefined)) {
      await backupCorruptFile(path, this.logger)
    }
    this.settingsValue = this.initialSettings !== undefined
      ? sanitizeSettings(this.initialSettings)
      : defaultMeshSettings(this.identityValue?.name)
    await atomicWriteFile(path, JSON.stringify(this.settingsValue, null, 2), 0o600)
  }

  private async reconcileDeviceName(): Promise<void> {
    const identity = this.identityValue
    if (identity === undefined) return
    if (this.settingsValue.deviceName === undefined) {
      await this.updateSettings({ deviceName: identity.name })
      return
    }
    if (this.settingsValue.deviceName !== identity.name) {
      this.identityValue = { ...identity, name: this.settingsValue.deviceName }
      await atomicWriteFile(
        join(this.homeValue, IDENTITY_FILE),
        JSON.stringify(this.identityValue, null, 2),
        0o600,
      )
    }
  }

  private async requireAuditFile(): Promise<void> {
    const path = join(this.homeValue, AUDIT_FILE)
    try {
      await stat(path)
      // The audit file may pre-date this release; keep its metadata private.
      await chmod(path, 0o600).catch(() => {})
    } catch {
      await writeFile(path, '', { mode: 0o600 })
      await chmod(path, 0o600).catch(() => {})
    }
  }

  // -- reads ----------------------------------------------------------------

  /** This device's identity (present after {@link init}). */
  getIdentity(): DeviceIdentity {
    if (this.identityValue === undefined) throw new Error('device-mesh: store is not initialized')
    return this.identityValue
  }

  /** The public half of this device's identity. */
  getDescriptor(): DeviceDescriptor {
    const identity = this.getIdentity()
    return {
      deviceId: identity.deviceId,
      name: identity.name,
      platform: identity.platform,
      signPk: identity.signPk,
      dhPk: identity.dhPk,
    }
  }

  /** Last loaded peers snapshot. */
  getPeers(): PeersFile {
    return this.peersValue
  }

  /** Last loaded settings snapshot. */
  getSettings(): MeshSettings {
    return this.settingsValue
  }

  /** Current relay routing secret, if one has been generated. */
  getRelayServerId(): string | undefined {
    return this.peersValue.relayServerId
  }

  /** Look up one paired peer in either direction. */
  findPeer(kind: 'controllers' | 'daemons', deviceId: string): PeerRecord | undefined {
    return this.peersValue[kind].find(peer => peer.deviceId === deviceId)
  }

  // -- peer writes ----------------------------------------------------------

  /**
   * Apply a mutation atomically: reload from disk under the cross-process lock,
   * mutate the draft, then write it back.
   * @param mutator - synchronous mutation; return value is passed through.
   * @returns the mutator's return value.
   */
  private async mutatePeers<T>(mutator: (draft: PeersDraft) => T): Promise<T> {
    return this.mutex(async () => {
      const release = await acquireStateLock(this.paths.lock, this.lockTimeoutMs, this.staleLockMs)
      try {
        const raw = await readJsonFile(this.paths.peers)
        const loaded = sanitizePeersFile(raw, this.logger)
          ?? { version: 1 as const, controllers: [], daemons: [] }
        const draft: PeersDraft = {
          version: 1,
          controllers: [...loaded.controllers],
          daemons: [...loaded.daemons],
          ...(loaded.relayServerId !== undefined ? { relayServerId: loaded.relayServerId } : {}),
        }
        const result = mutator(draft)
        const next: PeersFile = {
          version: 1,
          controllers: draft.controllers,
          daemons: draft.daemons,
          ...(draft.relayServerId !== undefined ? { relayServerId: draft.relayServerId } : {}),
        }
        await atomicWriteFile(this.paths.peers, JSON.stringify(next, null, 2), 0o600)
        this.peersValue = next
        return result
      } finally {
        await release()
      }
    })
  }

  /** Insert or replace one peer record. */
  async upsertPeer(kind: 'controllers' | 'daemons', record: PeerRecord): Promise<void> {
    await this.mutatePeers((draft) => {
      const list = draft[kind]
      const at = list.findIndex(peer => peer.deviceId === record.deviceId)
      if (at === -1) list.push(record)
      else list[at] = record
    })
  }

  /** Remove one peer record entirely (forget). */
  async removePeer(kind: 'controllers' | 'daemons', deviceId: string): Promise<boolean> {
    return this.mutatePeers((draft) => {
      const before = draft[kind].length
      draft[kind] = draft[kind].filter(peer => peer.deviceId !== deviceId)
      return draft[kind].length !== before
    })
  }

  /** Mark one peer revoked (kept in the file for audit/UI). */
  async revokePeer(kind: 'controllers' | 'daemons', deviceId: string): Promise<PeerRecord | undefined> {
    return this.mutatePeers((draft) => {
      const peer = draft[kind].find(item => item.deviceId === deviceId)
      if (peer === undefined || peer.revokedAt !== null) return peer
      const revoked: PeerRecord = { ...peer, revokedAt: new Date(this.now()).toISOString() }
      const at = draft[kind].indexOf(peer)
      draft[kind][at] = revoked
      return revoked
    })
  }

  /**
   * Patch mutable peer facts (name, last seen, endpoint cache, scope).
   * @param kind - peer list.
   * @param deviceId - peer to patch.
   * @param patch - fields to replace.
   * @returns updated record, or `undefined` when absent.
   */
  async patchPeer(
    kind: 'controllers' | 'daemons',
    deviceId: string,
    patch: {
      readonly name?: string
      readonly lastSeenAt?: string | null
      readonly endpoints?: readonly PairingEndpoint[]
      readonly scope?: PairingScope
    },
  ): Promise<PeerRecord | undefined> {
    return this.mutatePeers((draft) => {
      const peer = draft[kind].find(item => item.deviceId === deviceId)
      if (peer === undefined) return undefined
      const updated: PeerRecord = {
        ...peer,
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.lastSeenAt !== undefined ? { lastSeenAt: patch.lastSeenAt } : {}),
        ...(patch.endpoints !== undefined && patch.endpoints.length > 0
          ? { endpoints: patch.endpoints }
          : {}),
        ...(patch.scope !== undefined ? { scope: patch.scope } : {}),
      }
      draft[kind][draft[kind].indexOf(peer)] = updated
      return updated
    })
  }

  /** Store the relay routing secret (only generated when relay is enabled). */
  async setRelayServerId(serverId: string): Promise<void> {
    await this.mutatePeers((draft) => {
      draft.relayServerId = serverId
    })
  }

  /**
   * Read the relay routing secret, generating and persisting one when absent.
   * @param create - generator (defaults to 32 random bytes base64url).
   * @returns existing or newly persisted secret.
   */
  async ensureRelayServerId(
    create: () => string = () => toBase64Url(randomBytes(32)),
  ): Promise<string> {
    const existing = this.peersValue.relayServerId
    if (existing !== undefined) return existing
    return this.mutatePeers((draft) => {
      if (draft.relayServerId !== undefined) return draft.relayServerId
      const created = create()
      draft.relayServerId = created
      return created
    })
  }

  // -- settings writes ------------------------------------------------------

  /**
   * Merge a settings patch and persist atomically (under the lock, after
   * reloading the on-disk document so concurrent writers are respected).
   * @param patch - partial settings.
   * @returns the new settings snapshot.
   */
  async updateSettings(patch: SettingsPatch): Promise<MeshSettings> {
    return this.mutex(async () => {
      const release = await acquireStateLock(this.paths.lock, this.lockTimeoutMs, this.staleLockMs)
      try {
        const raw = await readJsonFile(this.paths.settings)
        const current = isRecord(raw) && raw.version === 1
          ? sanitizeSettings(raw)
          : sanitizeSettings(this.settingsValue)
        const next = mergeSettings(current, patch)
        await atomicWriteFile(this.paths.settings, JSON.stringify(next, null, 2), 0o600)
        this.settingsValue = next
        return next
      } finally {
        await release()
      }
    })
  }

  // -- audit ----------------------------------------------------------------

  /**
   * Append one audit line. Never pass message contents, tokens, keys or
   * cookies here — callers own that contract.
   * @param input - action plus optional peer/detail.
   */
  async appendAudit(input: AuditInput): Promise<void> {
    const entry: AuditEntry = {
      at: input.at ?? new Date(this.now()).toISOString(),
      action: input.action,
      ...(input.peer !== undefined ? { peer: input.peer } : {}),
      ...(input.detail !== undefined ? { detail: input.detail } : {}),
    }
    try {
      await this.mutex(async () => {
        // Do not recreate a deleted state directory from an audit write.
        try {
          const info = await stat(this.paths.home)
          if (!info.isDirectory()) return
        } catch {
          this.logger.debug('device-mesh: audit skipped, state directory is unavailable')
          return
        }
        const release = await acquireStateLock(this.paths.lock, this.lockTimeoutMs, this.staleLockMs)
        try {
          await this.rotateAuditIfNeeded()
          await appendFile(this.paths.audit, `${JSON.stringify(entry)}\n`, { mode: 0o600 })
        } finally {
          await release()
        }
      })
    } catch (error) {
      // Audit is best effort: a full disk or a shutdown race must not reject
      // fire-and-forget callers (nor turn into an unhandled rejection).
      const code = errorCode(error)
      const message = error instanceof Error ? error.message : String(error)
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        // The state directory vanished (shutdown/cleanup race): nothing to write.
        this.logger.debug(`device-mesh: audit skipped, state directory is gone (${code})`)
        return
      }
      this.logger.warn(`device-mesh: could not append audit entry (${code ?? 'Error'}: ${message})`)
    }
  }

  private async rotateAuditIfNeeded(): Promise<void> {
    try {
      const info = await stat(this.paths.audit)
      if (info.size < this.maxAuditBytes) return
      await rename(this.paths.audit, `${this.paths.audit}.1`)
      this.logger.info('device-mesh: rotated audit log')
    } catch {
      // Missing audit file (or a rotation race) is fine: appending recreates it.
    }
  }

  /**
   * Read the newest audit entries first.
   * @param limit - maximum rows (1..1000).
   * @returns parsed entries, newest first.
   */
  async listAudit(limit = AUDIT_DEFAULT_LIMIT): Promise<AuditEntry[]> {
    const capped = Math.max(1, Math.min(1_000, Math.floor(limit)))
    let text: string
    try {
      text = await readFile(this.paths.audit, 'utf8')
    } catch {
      return []
    }
    const entries: AuditEntry[] = []
    for (const line of text.split('\n')) {
      if (line.trim().length === 0) continue
      try {
        const parsed: unknown = JSON.parse(line)
        if (!isRecord(parsed)) continue
        if (typeof parsed.at !== 'string' || typeof parsed.action !== 'string') continue
        entries.push({
          at: parsed.at,
          action: parsed.action as AuditEntry['action'],
          ...(typeof parsed.peer === 'string' ? { peer: parsed.peer } : {}),
          ...(typeof parsed.detail === 'string' ? { detail: parsed.detail } : {}),
        })
      } catch {
        // Skip a torn final line from a crashed writer.
      }
    }
    return entries.slice(-capped).reverse()
  }

  // -- generic private JSON (owned by pairing.ts) --------------------------

  /**
   * Read a private JSON document from the mesh directory.
   * @param name - file name, e.g. `pairing.json`.
   * @returns parsed value, or `undefined`.
   */
  async readPrivateJson(name: string): Promise<unknown> {
    if (!/^[a-z0-9][a-z0-9._-]*\.json$/u.test(name)) {
      throw new Error(`device-mesh: invalid state file name ${JSON.stringify(name)}`)
    }
    return readJsonFile(join(this.homeValue, name))
  }

  /**
   * Atomically write a private JSON document under the cross-process lock.
   * @param name - file name ending in `.json`.
   * @param value - JSON-serializable value.
   */
  async writePrivateJson(name: string, value: unknown): Promise<void> {
    if (!/^[a-z0-9][a-z0-9._-]*\.json$/u.test(name)) {
      throw new Error(`device-mesh: invalid state file name ${JSON.stringify(name)}`)
    }
    await this.mutex(async () => {
      const release = await acquireStateLock(this.paths.lock, this.lockTimeoutMs, this.staleLockMs)
      try {
        await atomicWriteFile(join(this.homeValue, name), JSON.stringify(value, null, 2), 0o600)
      } finally {
        await release()
      }
    })
  }

  /**
   * Read-modify-write a private JSON document under the cross-process lock.
   *
   * Unlike {@link writePrivateJson}, this never replaces the file with a stale
   * in-memory snapshot: the mutator sees what is on disk right now, so two DSH
   * processes sharing one `$DSH_HOME` cannot resurrect consumed pairing tokens
   * or drop each other's entries.
   *
   * @param name - file name ending in `.json`.
   * @param mutate - receives the current JSON (or `undefined`) and returns the
   *   caller's result plus the document to persist.
   * @returns the mutator's result.
   */
  async updatePrivateJson<T>(
    name: string,
    mutate: (current: unknown) => { readonly result: T; readonly next: unknown },
  ): Promise<T> {
    if (!/^[a-z0-9][a-z0-9._-]*\.json$/u.test(name)) {
      throw new Error(`device-mesh: invalid state file name ${JSON.stringify(name)}`)
    }
    return this.mutex(async () => {
      const release = await acquireStateLock(this.paths.lock, this.lockTimeoutMs, this.staleLockMs)
      try {
        const path = join(this.homeValue, name)
        const current = await readJsonFile(path)
        const { result, next } = mutate(current)
        await atomicWriteFile(path, JSON.stringify(next, null, 2), 0o600)
        return result
      } finally {
        await release()
      }
    })
  }

  /** Release resources (currently none; reserved for symmetry with stop()). */
  async close(): Promise<void> {
    this.initialized = false
  }
}

function mergeSettings(current: MeshSettings, patch: SettingsPatch): MeshSettings {
  const direct = patch.direct ?? {}
  const relay = patch.relay ?? {}
  const portal = patch.portal ?? {}
  return {
    version: 1,
    ...(patch.deviceName !== undefined
      ? { deviceName: patch.deviceName }
      : current.deviceName !== undefined
        ? { deviceName: current.deviceName }
        : {}),
    direct: {
      enabled: typeof direct.enabled === 'boolean' ? direct.enabled : current.direct.enabled,
      port: typeof direct.port === 'number' ? direct.port : current.direct.port,
    },
    relay: {
      endpoint: relay.endpoint !== undefined ? relay.endpoint : current.relay.endpoint,
      useTls: typeof relay.useTls === 'boolean' ? relay.useTls : current.relay.useTls,
      enabled: typeof relay.enabled === 'boolean' ? relay.enabled : current.relay.enabled,
    },
    portal: {
      idleTimeoutMs: typeof portal.idleTimeoutMs === 'number'
        ? portal.idleTimeoutMs
        : current.portal.idleTimeoutMs,
    },
    autoApprovePairing: typeof patch.autoApprovePairing === 'boolean'
      ? patch.autoApprovePairing
      : current.autoApprovePairing,
  }
}
