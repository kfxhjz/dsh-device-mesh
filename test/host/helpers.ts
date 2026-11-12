/**
 * Shared test helpers for the host-side suites.
 *
 * The helpers deliberately avoid real DSH services, real networks and real
 * crypto: a fake `MeshSession`, a fake `MeshTransport`, and temp-directory
 * stores keep the tests fast and deterministic.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type {
  DeviceDescriptor,
  MeshInfo,
  PortalHttpParams,
  PortalHttpResult,
  PortalWsParams,
  RpcEvent,
} from '../../src/shared/protocol.ts'
import type {
  ChunkStream,
  HttpExchangeResult,
  MeshSession,
  MeshSessionPairing,
  WsExchangeResult,
} from '../../src/shared/mesh-session.ts'
import type { MeshTransport } from '../../src/shared/transport.ts'

/** Create a unique temp directory and return its path plus a cleanup function. */
export async function makeTempDir(prefix = 'device-mesh-test-'): Promise<{
  readonly dir: string
  readonly cleanup: () => Promise<void>
}> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  return {
    dir,
    cleanup: async () => {
      // Fire-and-forget audit/persistence writes can still be in flight; retry
      // the removal so a shutdown race does not fail an unrelated test.
      await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 })
    },
  }
}

/** Deterministic descriptor for a fake controller/daemon device. */
export function fakeDescriptor(overrides: Partial<DeviceDescriptor> = {}): DeviceDescriptor {
  return {
    deviceId: 'dm_testdevice00000000001',
    name: 'test device',
    platform: 'linux',
    signPk: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    dhPk: 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
    ...overrides,
  }
}

/** Collect an async iterable into one concatenated Buffer. */
export async function collect(stream: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const chunks: Uint8Array[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return Buffer.concat(chunks.map(chunk => Buffer.from(chunk)))
}

/** Turn bytes/chunks into an async iterable. */
export async function* streamOf(
  ...chunks: ReadonlyArray<Uint8Array | string>
): AsyncGenerator<Uint8Array> {
  for (const chunk of chunks) {
    yield typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk
  }
}

/** Recorded HTTP exchange from the fake session. */
export interface RecordedHttpExchange {
  readonly params: Omit<PortalHttpParams, 'streamId'>
  readonly body: Buffer
}

/** Configuration for {@link FakeMeshSession}. */
export interface FakeMeshSessionOptions {
  readonly remote?: DeviceDescriptor
  readonly info?: MeshInfo
  /** Optional SAS exposed during a pending pair-token handshake. */
  readonly sas?: string
  /** Optional pairing state; `{ approval: 'pending' }` models first contact. */
  readonly pairing?: MeshSessionPairing
  /** HTTP responder; defaults to 200 with a small body. */
  readonly http?:
    | ((params: Omit<PortalHttpParams, 'streamId'>, body: Buffer) => Promise<PortalHttpResult & { body?: ChunkStream }>)
    | undefined
  readonly ws?: (params: Omit<PortalWsParams, 'streamId'>) => Promise<WsExchangeResult>
  /** Called when a WS exchange is opened (for assertions). */
  readonly onWs?: (params: Omit<PortalWsParams, 'streamId'>) => void
}

/**
 * Minimal but complete `MeshSession` fake. HTTP exchanges are recorded so the
 * portal controller tests can assert exactly what crossed the Mesh.
 */
export class FakeMeshSession implements MeshSession {
  readonly role: 'controller' | 'daemon' = 'controller'
  readonly remote: DeviceDescriptor
  readonly info: MeshInfo | undefined
  readonly sas: string | undefined
  readonly pairing: MeshSessionPairing | undefined
  open = true
  readonly closed: Promise<void>

  readonly httpExchanges: RecordedHttpExchange[] = []
  readonly wsExchanges: Omit<PortalWsParams, 'streamId'>[] = []
  readonly rpcCalls: Array<{ readonly method: string; readonly params: unknown }> = []
  readonly rpcResponder: (method: string, params: unknown) => unknown

  private readonly closeResolvers: Array<() => void> = []
  private readonly httpResponder: FakeMeshSessionOptions['http']
  private readonly wsResponder: FakeMeshSessionOptions['ws']
  private readonly onWsCallback: FakeMeshSessionOptions['onWs']

  constructor(options: FakeMeshSessionOptions = {}, rpcResponder?: (method: string, params: unknown) => unknown) {
    this.remote = options.remote ?? fakeDescriptor()
    this.info = options.info
    this.sas = options.sas
    this.pairing = options.pairing
    this.httpResponder = options.http
    this.wsResponder = options.ws
    this.onWsCallback = options.onWs
    this.rpcResponder = rpcResponder ?? (() => ({}))
    this.closed = new Promise<void>((resolve) => {
      this.closeResolvers.push(resolve)
    })
  }

  async rpc<T = unknown>(method: string, params?: unknown): Promise<T> {
    this.rpcCalls.push({ method, params })
    return this.rpcResponder(method, params) as T
  }

  onEvent(_listener: (event: RpcEvent) => void): () => void {
    return () => {}
  }

  async http(params: Omit<PortalHttpParams, 'streamId'>, body?: ChunkStream): Promise<HttpExchangeResult> {
    const recordedBody = body === undefined ? Buffer.alloc(0) : await collect(body)
    this.httpExchanges.push({ params, body: recordedBody })
    if (this.httpResponder !== undefined) {
      const result = await this.httpResponder(params, recordedBody)
      return { ...result, body: result.body ?? streamOf() }
    }
    return {
      streamId: 1,
      status: 200,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
      body: streamOf('hello from daemon'),
    }
  }

  async ws(params: Omit<PortalWsParams, 'streamId'>): Promise<WsExchangeResult> {
    this.wsExchanges.push(params)
    this.onWsCallback?.(params)
    if (this.wsResponder === undefined) throw new Error('fake session has no ws responder')
    return this.wsResponder(params)
  }

  async ping(): Promise<number> {
    return Date.now()
  }

  close(): void {
    if (!this.open) return
    this.open = false
    for (const resolve of this.closeResolvers.splice(0)) resolve()
  }
}

/** Simple in-memory transport used by broker tests. */
export class FakeTransport implements MeshTransport {
  readonly kind: 'direct' | 'relay'
  readonly remoteLabel = 'fake peer'
  bufferedAmount = 0
  closed = false
  readonly sent: Uint8Array[] = []
  private readonly messageListeners = new Set<(bytes: Uint8Array) => void>()
  private readonly closeListeners = new Set<(info: { code?: number; reason?: string; local?: boolean }) => void>()

  constructor(kind: 'direct' | 'relay' = 'direct') {
    this.kind = kind
  }

  send(bytes: Uint8Array): void {
    if (this.closed) throw new Error('fake transport is closed')
    this.sent.push(bytes)
  }

  onMessage(listener: (bytes: Uint8Array) => void): () => void {
    this.messageListeners.add(listener)
    return () => this.messageListeners.delete(listener)
  }

  onClose(listener: (info: { code?: number; reason?: string; local?: boolean }) => void): () => void {
    this.closeListeners.add(listener)
    return () => this.closeListeners.delete(listener)
  }

  deliver(bytes: Uint8Array): void {
    for (const listener of [...this.messageListeners]) listener(bytes)
  }

  close(code?: number, reason?: string): void {
    if (this.closed) return
    this.closed = true
    for (const listener of [...this.closeListeners]) {
      listener({
        ...(code !== undefined ? { code } : {}),
        ...(reason !== undefined ? { reason } : {}),
        local: true,
      })
    }
  }
}

/** Wait for pending microtasks/timers to settle. */
export async function flush(count = 4): Promise<void> {
  for (let index = 0; index < count; index += 1) await Promise.resolve()
}

/**
 * Two `MeshTransport`s cross-wired in memory: what one sends, the other
 * receives on a later microtask (mimicking a real WebSocket without a socket).
 */
class PairedTransport implements MeshTransport {
  readonly kind = 'direct' as const
  readonly remoteLabel = 'paired in-memory peer'
  bufferedAmount = 0
  closed = false
  peer: PairedTransport | undefined
  private readonly messageListeners = new Set<(bytes: Uint8Array) => void>()
  private readonly closeListeners = new Set<(info: { code?: number; reason?: string; local?: boolean }) => void>()

  send(bytes: Uint8Array): void {
    if (this.closed) throw new Error('paired transport is closed')
    const peer = this.peer
    if (peer === undefined) return
    const copy = new Uint8Array(bytes)
    queueMicrotask(() => {
      if (peer.closed) return
      for (const listener of [...peer.messageListeners]) listener(copy)
    })
  }

  onMessage(listener: (bytes: Uint8Array) => void): () => void {
    this.messageListeners.add(listener)
    return () => this.messageListeners.delete(listener)
  }

  onClose(listener: (info: { code?: number; reason?: string; local?: boolean }) => void): () => void {
    this.closeListeners.add(listener)
    return () => this.closeListeners.delete(listener)
  }

  close(code?: number, reason?: string): void {
    if (this.closed) return
    this.closed = true
    for (const listener of [...this.closeListeners]) {
      listener({
        ...(code !== undefined ? { code } : {}),
        ...(reason !== undefined ? { reason } : {}),
        local: true,
      })
    }
  }
}

/** Create a pair of cross-wired in-memory transports. */
export function pairedTransports(): [MeshTransport, MeshTransport] {
  const left = new PairedTransport()
  const right = new PairedTransport()
  left.peer = right
  right.peer = left
  return [left, right]
}
