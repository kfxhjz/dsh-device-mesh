/**
 * Immutable-asset cache for the controller-side portal.
 *
 * DSH assets are content-addressed: `/assets/<name>-<hash>.js`, hashed locale
 * and font files, and `/plugins/??…&rev=<hash>` plugin bundles. The URL itself
 * is therefore the manifest entry and its hash; when the remote build changes,
 * a new URL arrives and misses. Cached bytes are served before touching the
 * Mesh session, so opening a previously used remote DSH skips the ~7 MB
 * transfer (and a transient reconnect cannot truncate a cached bundle).
 */
import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** Immutable GUI asset prefixes the portal may cache. */
const ASSET_PREFIXES = ['/assets/', '/locales/', '/fonts/'] as const

/** Default disk budget for cached assets (bytes). */
export const DEFAULT_PORTAL_CACHE_BYTES = 256 * 1024 * 1024

/** A hit includes the bytes and the upstream content type. */
export interface CachedAsset {
  readonly body: Buffer
  readonly contentType: string
  readonly contentEncoding?: string
}

interface CacheMeta {
  readonly contentType: string
  readonly contentEncoding?: string
  readonly path: string
  readonly storedAt: string
}

/** Whether a request URL is an immutable GUI asset. */
export function isImmutableAsset(pathname: string, search: string): boolean {
  if (pathname === '/plugins/events') return false
  if (ASSET_PREFIXES.some(prefix => pathname.startsWith(prefix))) return true
  if (!pathname.startsWith('/plugins/')) return false
  // The plugin bundle is one request with a build revision; plain plugin
  // endpoints (events, APIs) are not cacheable.
  return pathname.includes('??') || search.includes('rev=')
}

function digest(deviceId: string, manifest: string, pathname: string, search: string): string {
  return createHash('sha256').update(`${deviceId}\u0000${manifest}\u0000${pathname}\u0000${search}`).digest('hex')
}

/** Options for {@link PortalCache}. */
export interface PortalCacheOptions {
  /**
   * Soft disk budget (bytes); defaults to {@link DEFAULT_PORTAL_CACHE_BYTES}.
   * Eviction is batched, so usage may briefly exceed it by one batch plus one
   * asset before the next scan.
   */
  readonly maxBytes?: number
  /**
   * Bytes written before an eviction scan. A full directory scan per asset write
   * is O(n²) over a long-lived cache, so scans are batched.
   */
  readonly evictThresholdBytes?: number
}

/** Disk cache; one file pair per immutable URL, scoped by remote device id. */
export class PortalCache {
  private ready: Promise<void> | undefined
  private readonly maxBytes: number
  private readonly evictThresholdBytes: number
  private pendingBytes = 0
  private pendingWrites = 0
  private evicting: Promise<void> | undefined

  constructor(private readonly directory: string, options: PortalCacheOptions = {}) {
    this.maxBytes = options.maxBytes ?? DEFAULT_PORTAL_CACHE_BYTES
    this.evictThresholdBytes = options.evictThresholdBytes
      ?? Math.min(8 * 1024 * 1024, Math.max(1, Math.floor(this.maxBytes / 8)))
  }

  private async ensure(): Promise<void> {
    if (this.ready === undefined) {
      this.ready = mkdir(this.directory, { recursive: true, mode: 0o700 }).then(() => undefined)
    }
    await this.ready
  }

  /** Read a cached asset, or undefined. */
  async get(deviceId: string, manifest: string, pathname: string, search: string): Promise<CachedAsset | undefined> {
    if (!isImmutableAsset(pathname, search)) return undefined
    try {
      await this.ensure()
      const key = digest(deviceId, manifest, pathname, search)
      const [body, raw] = await Promise.all([
        readFile(join(this.directory, `${key}.bin`)),
        readFile(join(this.directory, `${key}.json`), 'utf8'),
      ])
      const meta = JSON.parse(raw) as CacheMeta
      return {
        body,
        contentType: meta.contentType,
        ...(meta.contentEncoding !== undefined ? { contentEncoding: meta.contentEncoding } : {}),
      }
    } catch {
      return undefined
    }
  }

  /** Store an asset after a complete 200 response. Best effort. */
  async put(
    deviceId: string,
    manifest: string,
    pathname: string,
    search: string,
    body: Uint8Array,
    contentType: string,
    contentEncoding?: string,
  ): Promise<void> {
    if (!isImmutableAsset(pathname, search) || body.byteLength === 0) return
    try {
      await this.ensure()
      const key = digest(deviceId, manifest, pathname, search)
      const meta: CacheMeta = {
        contentType,
        ...(contentEncoding !== undefined ? { contentEncoding } : {}),
        path: `${pathname}${search}`,
        storedAt: new Date().toISOString(),
      }
      const temp = join(this.directory, `.${key}.tmp`)
      await writeFile(temp, body, { mode: 0o600 })
      await rename(temp, join(this.directory, `${key}.bin`))
      await writeFile(join(this.directory, `${key}.json`), JSON.stringify(meta), { mode: 0o600 })
      this.pendingBytes += body.byteLength + 256
      this.pendingWrites += 1
      if (this.pendingWrites >= 64 || this.pendingBytes >= this.evictThresholdBytes) {
        await this.scheduleEviction()
      }
    } catch {
      // A cache write must never fail the proxied request.
    }
  }

  /** Run at most one eviction scan at a time; concurrent puts share it. */
  private async scheduleEviction(): Promise<void> {
    if (this.evicting !== undefined) return this.evicting
    this.pendingBytes = 0
    this.pendingWrites = 0
    this.evicting = this.evict().finally(() => {
      this.evicting = undefined
    })
    return this.evicting
  }

  /** Drop the oldest cache entries until the disk budget is respected. */
  private async evict(): Promise<void> {
    try {
      const entries: Array<{ readonly path: string; readonly mtime: number; readonly size: number }> = []
      let total = 0
      for (const name of await readdir(this.directory)) {
        if (!name.endsWith('.bin') && !name.endsWith('.json')) continue
        const path = join(this.directory, name)
        const info = await stat(path).catch(() => undefined)
        if (info === undefined || !info.isFile()) continue
        entries.push({ path, mtime: info.mtimeMs, size: info.size })
        total += info.size
      }
      if (total <= this.maxBytes) return
      entries.sort((left, right) => left.mtime - right.mtime)
      for (const entry of entries) {
        if (total <= this.maxBytes) break
        await unlink(entry.path).catch(() => undefined)
        total -= entry.size
      }
    } catch {
      // Eviction is best effort; a cache miss is never fatal.
    }
  }
}
