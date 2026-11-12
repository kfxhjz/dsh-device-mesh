/**
 * In-memory `MeshTransport` pair used by all core tests. No sockets, no
 * network: messages are copied and delivered asynchronously in order to the
 * peer, close events propagate, and tests can inject frames or tamper with
 * outbound traffic.
 */

import type { MeshTransport, TransportCloseInfo } from '../../../src/shared/transport.ts'

export interface MemoryTransportOptions {
  readonly kind?: 'direct' | 'relay'
  readonly remoteLabel?: string
  /** Deliver on a macrotask instead of a microtask (lets timers interleave). */
  readonly macrotask?: boolean
}

export class MemoryTransport implements MeshTransport {
  readonly kind: 'direct' | 'relay'
  readonly remoteLabel: string
  /** Simulated queue depth; tests may set this to exercise backpressure. */
  bufferedAmount = 0
  /** Peer endpoint (set by `createMemoryTransportPair`). */
  peer: MemoryTransport | null = null
  closed = false
  closeInfo: TransportCloseInfo | undefined
  /** Fault injection: return a replacement frame, or null to drop it. */
  outboundHook: ((frame: Uint8Array) => Uint8Array | null) | undefined

  private readonly messageListeners = new Set<(bytes: Uint8Array) => void>()
  private readonly closeListeners = new Set<(info: TransportCloseInfo) => void>()
  private readonly macrotask: boolean

  constructor(options: MemoryTransportOptions = {}) {
    this.kind = options.kind ?? 'direct'
    this.remoteLabel = options.remoteLabel ?? 'memory-peer'
    this.macrotask = options.macrotask ?? false
  }

  send(bytes: Uint8Array): void {
    if (this.closed) throw new Error('transport is closed')
    if (!this.peer) throw new Error('transport has no peer')
    let frame: Uint8Array = new Uint8Array(bytes)
    if (this.outboundHook) {
      const hooked = this.outboundHook(frame)
      if (hooked === null) return
      frame = hooked
    }
    this.bufferedAmount += frame.length
    const payload = new Uint8Array(frame)
    const schedule = (): void => {
      this.bufferedAmount = Math.max(0, this.bufferedAmount - payload.length)
      this.peer?.deliver(payload)
    }
    if (this.macrotask) setTimeout(schedule, 0)
    else queueMicrotask(schedule)
  }

  onMessage(listener: (bytes: Uint8Array) => void): () => void {
    if (this.closed) return () => {}
    this.messageListeners.add(listener)
    return () => {
      this.messageListeners.delete(listener)
    }
  }

  onClose(listener: (info: TransportCloseInfo) => void): () => void {
    if (this.closed) {
      listener(this.closeInfo ?? {})
      return () => {}
    }
    this.closeListeners.add(listener)
    return () => {
      this.closeListeners.delete(listener)
    }
  }

  close(code = 1000, reason = ''): void {
    if (this.closed) return
    this.closed = true
    this.closeInfo = { code, reason, local: true }
    for (const listener of [...this.closeListeners]) listener(this.closeInfo)
    const peer = this.peer
    if (peer) {
      queueMicrotask(() => {
        if (peer.closed) return
        peer.closed = true
        peer.closeInfo = { code, reason }
        for (const listener of [...peer.closeListeners]) listener(peer.closeInfo)
        // The peer's transport also drops its pending buffered bytes.
        peer.bufferedAmount = 0
      })
    }
  }

  /** Test-only: simulate the peer delivering one frame to this transport. */
  deliver(bytes: Uint8Array): void {
    if (this.closed) return
    const frame = new Uint8Array(bytes)
    for (const listener of [...this.messageListeners]) listener(frame)
  }
}

export interface MemoryTransportPair {
  readonly a: MemoryTransport
  readonly b: MemoryTransport
}

/** Create a linked pair of in-memory transports (`a.send` → `b.onMessage`). */
export function createMemoryTransportPair(options: MemoryTransportOptions = {}): MemoryTransportPair {
  const a = new MemoryTransport(options)
  const b = new MemoryTransport(options)
  a.peer = b
  b.peer = a
  return { a, b }
}

/** Wait for pending microtasks/macrotasks to settle. */
export async function flushAsync(rounds = 4): Promise<void> {
  for (let index = 0; index < rounds; index += 1) {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 1)
    })
  }
}

/** Resolve after `ms` milliseconds. */
export function delay(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms)
  })
}
