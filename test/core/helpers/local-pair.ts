/**
 * Two `MeshSession` instances wired directly to each other without Noise.
 *
 * The session layer only talks to `SessionBridge`, so this harness gives
 * deterministic, crypto-free tests for RPC, events, stream multiplexing,
 * backpressure and protocol-violation handling. `channel.test.ts` covers the
 * real Noise handshake over `MemoryTransport`.
 */

import type { DeviceDescriptor } from '../../../src/shared/protocol.ts'
import { createSession } from '../../../src/host/session.ts'
import type { MeshSessionImpl, MeshSessionOptions, SessionBridge } from '../../../src/host/session.ts'

export interface LocalPeerOptions {
  readonly role: 'controller' | 'daemon'
  readonly remote: DeviceDescriptor
  readonly sas?: string
  readonly pairing?: { readonly approval: 'none' | 'pending'; readonly requestId?: string }
  /** Live pairing predicate (daemon side); defaults to the static snapshot. */
  readonly isPairingPending?: () => boolean
  readonly session?: MeshSessionOptions
  readonly sendFilter?: ((bytes: Uint8Array) => Uint8Array | null) | undefined
}

interface CloseEvent {
  readonly code?: number
  readonly reason?: string
  readonly local?: boolean
}

/** One endpoint of the in-memory session link. */
export class LocalPeer {
  bufferedAmount = 0
  closed = false
  /** Drop/rewrite session plaintext frames on their way to the peer. */
  sendFilter: ((bytes: Uint8Array) => Uint8Array | null) | undefined
  session!: MeshSessionImpl
  peer: LocalPeer | null = null
  private readonly closeListeners = new Set<(info: CloseEvent) => void>()
  private readonly options: LocalPeerOptions

  constructor(options: LocalPeerOptions) {
    this.options = options
    this.sendFilter = options.sendFilter
  }

  attach(): MeshSessionImpl {
    const bridge: SessionBridge = {
      role: this.options.role,
      remote: this.options.remote,
      sas: this.options.sas,
      pairing: this.options.pairing,
      ...(this.options.isPairingPending === undefined
        ? {}
        : { isPairingPending: this.options.isPairingPending }),
      sendPlaintext: (bytes) => {
        if (this.closed) throw new Error('local link closed')
        const filtered = this.sendFilter ? this.sendFilter(new Uint8Array(bytes)) : new Uint8Array(bytes)
        if (filtered === null) return
        queueMicrotask(() => {
          if (this.peer && !this.peer.closed) this.peer.session.handlePlaintext(new Uint8Array(filtered))
        })
      },
      onTransportClose: (listener) => {
        if (this.closed) {
          listener({ reason: 'closed', local: false })
          return () => {}
        }
        this.closeListeners.add(listener)
        return () => {
          this.closeListeners.delete(listener)
        }
      },
      closeTransport: (code, reason) =>{  this.close(code, reason) },
      bufferedAmount: () => this.bufferedAmount,
    }
    const session = createSession(bridge, this.options.session ?? {})
    this.session = session
    return session
  }

  /** Simulate the peer sending raw plaintext frames (for protocol-violation tests). */
  receive(bytes: Uint8Array): void {
    if (this.closed) return
    this.session.handlePlaintext(new Uint8Array(bytes))
  }

  /** Deliver a frame as if it came from the peer without going through its bridge. */
  close(code = 1000, reason = 'closed'): void {
    if (this.closed) return
    this.closed = true
    for (const listener of [...this.closeListeners]) listener({ code, reason, local: true })
    const peer = this.peer
    queueMicrotask(() => {
      peer?.closeFromRemote(code, reason)
    })
  }

  closeFromRemote(code = 1000, reason = 'closed'): void {
    if (this.closed) return
    this.closed = true
    for (const listener of [...this.closeListeners]) listener({ code, reason })
  }
}

export interface LocalSessionPair {
  readonly a: LocalPeer
  readonly b: LocalPeer
  readonly sessionA: MeshSessionImpl
  readonly sessionB: MeshSessionImpl
}

/** Create two linked sessions. `a` is usually the controller. */
export function createLocalSessionPair(
  a: Omit<LocalPeerOptions, 'role'>,
  b: Omit<LocalPeerOptions, 'role'>,
): LocalSessionPair {
  const peerA = new LocalPeer({ ...a, role: 'controller' })
  const peerB = new LocalPeer({ ...b, role: 'daemon' })
  peerA.peer = peerB
  peerB.peer = peerA
  const sessionA = peerA.attach()
  const sessionB = peerB.attach()
  return { a: peerA, b: peerB, sessionA, sessionB }
}
