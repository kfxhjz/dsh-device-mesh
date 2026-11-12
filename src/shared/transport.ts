/**
 * Transport seam between the Mesh session layer and the physical carriers.
 *
 * A `MeshTransport` is an ordered, reliable, bidirectional stream of binary
 * messages. It carries exactly one WebSocket binary message per `send()` and
 * delivers each peer message as one `Uint8Array`. Framing, encryption and
 * multiplexing belong to the layers above (`noise.ts`, `channel.ts`,
 * `session.ts`); a transport never inspects payload bytes (the paseo-relay
 * handshake-hygiene prefilter only looks at the first byte and ignores our
 * `0x01`-prefixed frames).
 *
 * Implementations: `direct.ts` (own WS listener / client over LAN or
 * Tailscale) and `relay.ts` (paseo-relay v2 control+data sockets).
 */

export interface TransportCloseInfo {
  readonly code?: number
  readonly reason?: string
  /** True when the close came from the local side calling `close()`. */
  readonly local?: boolean
}

export interface MeshTransport {
  /** Which carrier produced this transport; used for logging and UI only. */
  readonly kind: 'direct' | 'relay'
  /** Human readable peer label, never a secret. */
  readonly remoteLabel: string
  /** Bytes queued in the carrier; used for backpressure decisions. */
  readonly bufferedAmount: number
  /** Send one binary message. Throws only when the transport is already closed. */
  send(bytes: Uint8Array): void
  /** Subscribe to inbound messages. Returns an unsubscribe function. */
  onMessage(listener: (bytes: Uint8Array) => void): () => void
  /** Subscribe to close. Listeners run once. Returns an unsubscribe function. */
  onClose(listener: (info: TransportCloseInfo) => void): () => void
  /** Close the transport. Idempotent. */
  close(code?: number, reason?: string): void
}

/** A listening daemon-side direct endpoint. */
export interface DirectListener {
  readonly port: number
  /** URL list to publish in pairing tickets, in preference order. */
  readonly urls: readonly string[]
  close(): Promise<void>
}

/** Callback invoked once per accepted inbound direct connection. */
export type DirectAcceptHandler = (transport: MeshTransport) => void

/** Options shared by both direct roles. */
export interface DirectOptions {
  /** Bind interface; defaults to `0.0.0.0` for the daemon listener. */
  readonly host?: string
  /** TCP port; `0` asks the OS for a free port. */
  readonly port?: number
  /** Maximum inbound connections; excess are dropped. Default 16. */
  readonly maxConnections?: number
  /** Handshake timeout for the HTTP upgrade, milliseconds. Default 10_000. */
  readonly upgradeTimeoutMs?: number
}

/** A relay daemon connection set: one control socket and one data socket per client. */
export interface RelayDaemon {
  /** Resolves once the control socket is attached and `sync` arrived. */
  readonly ready: Promise<void>
  /** Fires once per attached controller data socket. */
  onClient(listener: (transport: MeshTransport, connectionId: string) => void): () => void
  /** Fires when the control socket goes away. */
  onDisconnect(listener: (info: TransportCloseInfo) => void): () => void
  readonly connected: boolean
  close(): Promise<void>
}

/** A relay client connection: one data socket for the controller role. */
export interface RelayClientOptions {
  /** Relay base URL including `/ws`, e.g. `wss://relay.example.com/ws`. */
  readonly url: string
  /** Relay routing secret (`serverId`). */
  readonly serverId: string
  /** Relay protocol generation; v2 is preferred. */
  readonly version: 1 | 2
  /** WebSocket subprotocol list; unused by our protocol. */
  readonly protocols?: readonly string[]
}

/** Options for the daemon side of the relay. */
export interface RelayDaemonOptions extends Omit<RelayClientOptions, 'protocols'> {
  /** Reconnect backoff floor/ceiling in milliseconds. Defaults 1_000/30_000. */
  readonly minBackoffMs?: number
  readonly maxBackoffMs?: number
}
