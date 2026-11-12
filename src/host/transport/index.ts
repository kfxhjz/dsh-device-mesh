/**
 * Transport layer entry point.
 *
 * `direct.ts` = own WS listener / dialer over LAN or Tailscale.
 * `relay.ts`  = paseo-relay v2 control+data daemon and client (v1 fallback).
 *
 * Both carriers expose the same `MeshTransport` seam from
 * `src/shared/transport.ts`; encryption, framing and sessions sit above them.
 */

export {
  connectDirect,
  enumerateDirectUrls,
  startDirectListener,
  DIRECT_WS_PATH,
} from './direct.ts'
export type { ConnectDirectOptions, DirectListenerOptions, DirectUrlOptions } from './direct.ts'

export {
  buildRelayUrl,
  connectRelayClient,
  startRelayDaemon,
  startRelayDaemonV1,
  RELAY_HEARTBEAT_MS,
  RELAY_V1_CONNECTION_ID,
} from './relay.ts'
export type {
  ConnectRelayClientOptions,
  RelayDaemonClientHandler,
  RelayDaemonExtraOptions,
} from './relay.ts'

export {
  normalizeCloseCode,
  redactSecret,
  silentLogger,
  truncateCloseReason,
  WebSocketMeshTransport,
} from './common.ts'
export type { TransportLogger, OpenWebSocketOptions, WebSocketMeshTransportOptions } from './common.ts'

export type {
  DirectAcceptHandler,
  DirectListener,
  DirectOptions,
  MeshTransport,
  RelayClientOptions,
  RelayDaemon,
  RelayDaemonOptions,
  TransportCloseInfo,
} from '../../shared/transport.ts'
