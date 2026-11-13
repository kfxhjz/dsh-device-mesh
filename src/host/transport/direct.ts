/**
 * Direct (LAN / Tailscale) carrier: the daemon listens on a WebSocket port of
 * its own because the DSH host process only binds `127.0.0.1`; the controller
 * dials `ws://host:port/mesh`.
 *
 * Only non-browser clients are accepted: a request carrying any `Origin`
 * header is rejected with `403` before the upgrade is completed.
 */

import { createServer } from 'node:http'
import type { IncomingMessage, Server as HttpServer } from 'node:http'
import { networkInterfaces } from 'node:os'
import type { NetworkInterfaceInfo } from 'node:os'
import type { Duplex } from 'node:stream'

import { WebSocketServer } from 'ws'

import {
  DEFAULT_DIRECT_PORT,
} from '../../shared/protocol.ts'
import type {
  DirectAcceptHandler,
  DirectListener,
  DirectOptions,
  MeshTransport,
} from '../../shared/transport.ts'
import {
  abortError,
  logDebug,
  logWarn,
  MAX_WS_PAYLOAD_BYTES,
  openWebSocket,
  terminateQuietly,
  WebSocketMeshTransport,
} from './common.ts'
import type { TransportLogger } from './common.ts'

/** HTTP path every direct endpoint serves. */
export const DIRECT_WS_PATH = '/mesh'

/** How long the os heartbeat waits for a pong. Matches PROTOCOL.md §3.2. */
const DEFAULT_DIRECT_HEARTBEAT_MS = 20_000

/**
 * Bound on per-source-address rate-limit windows. Expired windows are swept
 * first; an attacker rotating IPv6 sources must not grow the table without bound.
 */
const MAX_TRACKED_ATTEMPT_ADDRESSES = 1_024

export interface DirectListenerOptions extends DirectOptions {
  /** URL path served by the listener; defaults to `/mesh`. */
  readonly path?: string
  /** Connections accepted per remote IP; defaults to `maxConnections / 4`. */
  readonly maxConnectionsPerIp?: number
  /** WS ping interval in milliseconds; `0` disables it. Default 20_000. */
  readonly heartbeatMs?: number
  /**
   * HTTP upgrade attempts accepted from one address per minute before a
   * 429 response; defaults to 60. Concurrency caps are separate.
   */
  readonly maxAttemptsPerIpPerMinute?: number
  /** Test/DI seam: replaces `os.networkInterfaces()` for URL enumeration. */
  readonly interfaces?: NodeJS.Dict<NetworkInterfaceInfo[]>
  readonly logger?: TransportLogger
}

export interface ConnectDirectOptions {
  /** Cancels a pending dial (upper layer has its own overall deadline). */
  readonly signal?: AbortSignal
  /** HTTP upgrade timeout; default 10_000. */
  readonly handshakeTimeoutMs?: number
  /** WS ping interval in milliseconds; `0` disables it. Default 20_000. */
  readonly heartbeatMs?: number
  /** Maximum inbound message size; defaults to the protocol message limit. */
  readonly maxPayload?: number
  /** Optional WebSocket subprotocols (unused by Mesh). */
  readonly protocols?: readonly string[]
  readonly logger?: TransportLogger
}

export interface DirectUrlOptions {
  /** Explicit bind host; when not a wildcard the URL list only contains it. */
  readonly host?: string
  readonly path?: string
  readonly interfaces?: NodeJS.Dict<NetworkInterfaceInfo[]>
}

/**
 * Build the `ws://…/mesh` URL list for a listener, in preference order:
 * private LAN IPv4 first, then Tailscale CGNAT (`100.64/10`), then other
 * global IPv4, then IPv6. Loopback, link-local, docker/bridge/virtual
 * interfaces and duplicate addresses are skipped.
 */
export function enumerateDirectUrls(port: number, options: DirectUrlOptions = {}): string[] {
  const path = options.path ?? DIRECT_WS_PATH
  const host = options.host
  if (host && host !== '0.0.0.0' && host !== '::' && host !== '[::]') {
    return [`ws://${formatHost(host)}:${port}${path}`]
  }

  const interfaces = options.interfaces ?? networkInterfaces()
  const lan: string[] = []
  const tailscale: string[] = []
  const otherV4: string[] = []
  const v6: string[] = []
  const seen = new Set<string>()

  for (const [name, addresses] of Object.entries(interfaces)) {
    if (!addresses) continue
    // Virtual interfaces (docker/veth, macOS `bridge100`, `utun*`, …) must
    // never be advertised as LAN endpoints. The one exception is a real
    // Tailscale CGNAT address, which on macOS lives on a `utun*` interface and
    // is exactly the endpoint we want for remote control.
    const virtual = isVirtualInterface(name)
    for (const address of addresses) {
      if (address.internal) continue
      const raw = address.address.split('%')[0] ?? address.address
      if (address.family === 'IPv4') {
        if (!isUsableIPv4(raw)) continue
        const cgnat = isCgnat(raw)
        if (virtual && !cgnat) continue
        const url = `ws://${raw}:${port}${path}`
        if (seen.has(url)) continue
        seen.add(url)
        if (cgnat) tailscale.push(url)
        else if (isPrivateIPv4(raw)) lan.push(url)
        else otherV4.push(url)
      } else if (address.family === 'IPv6') {
        if (virtual) continue
        if (!isUsableIPv6(raw)) continue
        const url = `ws://[${raw}]:${port}${path}`
        if (seen.has(url)) continue
        seen.add(url)
        v6.push(url)
      }
    }
  }

  const rankLan = (url: string): number => {
    const hostPart = url.slice('ws://'.length, url.indexOf(':', 5))
    if (hostPart.startsWith('192.168.')) return 0
    if (hostPart.startsWith('10.')) return 1
    return 2
  }
  return [...lan.sort((a, b) => rankLan(a) - rankLan(b)), ...tailscale, ...otherV4, ...v6]
}

function formatHost(host: string): string {
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host
}

function isVirtualInterface(name: string): boolean {
  // Includes the macOS pseudo-interfaces (`bridge100`, `utun*`, `awdl*`, …)
  // that otherwise leak carrier-grade-NAT-free host addresses into pairing QR
  // codes. Tailscale CGNAT addresses on `utun*` are handled by the caller.
  return /^(bridge|utun|awdl|llw|anpi|ap\d+|gif|stf|vmnet|vboxnet|docker|br-|veth|tun|tap|virbr|podman|cni|flannel|kube|cali|nerdctl)/i
    .test(name)
}

function isUsableIPv4(address: string): boolean {
  if (address === '0.0.0.0') return false
  if (address.startsWith('127.')) return false
  if (address.startsWith('169.254.')) return false
  return true
}

function isUsableIPv6(address: string): boolean {
  if (address === '::1' || address === '::') return false
  const lower = address.toLowerCase()
  if (lower.startsWith('fe80:')) return false // link-local
  if (lower.startsWith('ff')) return false // multicast
  return true
}

function isPrivateIPv4(address: string): boolean {
  if (address.startsWith('10.')) return true
  if (address.startsWith('192.168.')) return true
  if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(address)) return true
  return false
}

function isCgnat(address: string): boolean {
  if (!address.startsWith('100.')) return false
  const second = Number(address.split('.')[1])
  return second >= 64 && second <= 127
}

/**
 * Start a daemon-side direct listener. Resolves once the port is bound; every
 * accepted connection is wrapped as a `MeshTransport` and handed to
 * `onAccept`.
 */
export async function startDirectListener(
  options: DirectListenerOptions,
  onAccept: DirectAcceptHandler,
): Promise<DirectListener> {
  const host = options.host ?? '0.0.0.0'
  const port = options.port ?? DEFAULT_DIRECT_PORT
  const path = options.path ?? DIRECT_WS_PATH
  const maxConnections = options.maxConnections ?? 16
  // A single peer gets at most half the global budget by default. The host
  // plugin can pin an explicit per-IP number for hostile networks.
  const maxConnectionsPerIp =
    options.maxConnectionsPerIp ?? Math.max(2, Math.ceil(maxConnections / 2))
  const upgradeTimeoutMs = options.upgradeTimeoutMs ?? 10_000
  const heartbeatMs = options.heartbeatMs ?? DEFAULT_DIRECT_HEARTBEAT_MS
  const maxAttemptsPerIpPerMinute = options.maxAttemptsPerIpPerMinute ?? 60
  const logger = options.logger

  const active = new Set<WebSocketMeshTransport>()
  const perIpCounts = new Map<string, number>()
  const attemptWindows = new Map<string, { count: number; resetAt: number }>()
  const sockets = new Set<Duplex>()
  const handshakeTimers = new Map<Duplex, NodeJS.Timeout>()
  let closed = false

  const httpServer: HttpServer = createServer((_request, response) => {
    response.statusCode = 404
    response.setHeader('content-type', 'text/plain; charset=utf-8')
    response.end('not found\n')
  })
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_WS_PAYLOAD_BYTES,
    perMessageDeflate: false,
    clientTracking: true,
  })

  httpServer.on('connection', (socket: Duplex) => {
    sockets.add(socket)
    socket.once('close', () => {
      sockets.delete(socket)
      const timer = handshakeTimers.get(socket)
      if (timer) {
        clearTimeout(timer)
        handshakeTimers.delete(socket)
      }
    })
    const timer = setTimeout(() => {
      handshakeTimers.delete(socket)
      logWarn(logger, 'direct listener dropped a socket stuck in the HTTP upgrade')
      socket.destroy()
    }, upgradeTimeoutMs)
    timer.unref?.()
    handshakeTimers.set(socket, timer)
  })

  httpServer.on('upgrade', (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    const timer = handshakeTimers.get(socket)
    if (timer) {
      clearTimeout(timer)
      handshakeTimers.delete(socket)
    }

    try {
      const peerIp = normalizePeerAddress(request.socket.remoteAddress)
      const url = new URL(request.url ?? '/', 'http://mesh.invalid')
      if (url.pathname !== path) {
        rejectUpgrade(socket, 404, 'not found')
        return
      }
      if (!isWebSocketUpgrade(request)) {
        rejectUpgrade(socket, 426, 'upgrade required')
        return
      }
      if (request.headers.origin !== undefined) {
        rejectUpgrade(socket, 403, 'browser origins are not accepted')
        return
      }
      if (closed) {
        rejectUpgrade(socket, 503, 'listener closed')
        return
      }
      // Bound churn from one address before the (more expensive) Noise
      // handshake; one-time pairing tokens already make token brute force
      // infeasible, this only limits connection-level DoS noise.
      const now = Date.now()
      const window = attemptWindows.get(peerIp)
      if (window === undefined || now >= window.resetAt) {
        attemptWindows.set(peerIp, { count: 1, resetAt: now + 60_000 })
        if (attemptWindows.size > MAX_TRACKED_ATTEMPT_ADDRESSES) {
          for (const [address, entry] of attemptWindows) {
            if (now >= entry.resetAt) attemptWindows.delete(address)
          }
          while (attemptWindows.size > MAX_TRACKED_ATTEMPT_ADDRESSES) {
            const oldest = attemptWindows.keys().next().value
            if (oldest === undefined) break
            attemptWindows.delete(oldest)
          }
        }
      } else if (window.count >= maxAttemptsPerIpPerMinute) {
        rejectUpgrade(socket, 429, 'too many attempts from this address')
        return
      } else {
        window.count += 1
      }
      const peerCount = perIpCounts.get(peerIp) ?? 0
      if (peerCount >= maxConnectionsPerIp) {
        rejectUpgrade(socket, 429, 'too many connections from this address')
        return
      }
      if (active.size >= maxConnections) {
        rejectUpgrade(socket, 503, 'too many connections')
        return
      }

      wss.handleUpgrade(request, socket, head, (ws) => {
        const transport = new WebSocketMeshTransport(ws, {
          kind: 'direct',
          remoteLabel: peerIp,
          ...(logger ? { logger } : {}),
          heartbeatMs,
          onClosed: () => {
            active.delete(transport)
            const remaining = (perIpCounts.get(peerIp) ?? 1) - 1
            if (remaining <= 0) perIpCounts.delete(peerIp)
            else perIpCounts.set(peerIp, remaining)
          },
        })
        active.add(transport)
        perIpCounts.set(peerIp, (perIpCounts.get(peerIp) ?? 0) + 1)
        logDebug(logger, `direct listener accepted ${peerIp}`)
        try {
          onAccept(transport)
        } catch (error) {
          logWarn(
            logger,
            `direct accept handler threw: ${error instanceof Error ? error.name : 'unknown'}`,
          )
          transport.close(1011, 'accept handler failed')
        }
      })
    } catch (error) {
      logWarn(
        logger,
        `direct listener upgrade failed: ${error instanceof Error ? error.name : 'unknown'}`,
      )
      rejectUpgrade(socket, 400, 'bad request')
    }
  })

  wss.on('error', () => {
    logWarn(logger, 'direct listener websocket server error')
  })

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      httpServer.off('listening', onListening)
      reject(error)
    }
    const onListening = (): void => {
      httpServer.off('error', onError)
      resolve()
    }
    httpServer.once('error', onError)
    httpServer.once('listening', onListening)
    httpServer.listen(port, host)
  })

  const address = httpServer.address()
  if (address === null || typeof address === 'string') {
    throw new Error('direct listener has no TCP address')
  }
  const boundPort = address.port
  const urls = enumerateDirectUrls(boundPort, {
    ...(options.host ? { host: options.host } : {}),
    path,
    ...(options.interfaces ? { interfaces: options.interfaces } : {}),
  })

  let closePromise: Promise<void> | undefined
  return {
    port: boundPort,
    urls,
    close(): Promise<void> {
      closePromise ??= closeDirectListener()
      return closePromise
    },
  }

  async function closeDirectListener(): Promise<void> {
    closed = true
    for (const timer of handshakeTimers.values()) clearTimeout(timer)
    handshakeTimers.clear()

    const serverClosed = new Promise<void>((resolve) => {
      httpServer.close(() =>{  resolve() })
    })
    const wssClosed = new Promise<void>((resolve) => {
      wss.close(() =>{  resolve() })
    })

    for (const transport of [...active]) {
      transport.close(1001, 'listener closed')
    }

    // Give the close handshakes a moment, then hard-destroy whatever remains.
    await Promise.race([Promise.all([serverClosed, wssClosed]), wait(1_000)])
    for (const socket of sockets) socket.destroy()
    await Promise.race([Promise.all([serverClosed, wssClosed]), wait(500)])
  }
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
  })
}

function isWebSocketUpgrade(request: IncomingMessage): boolean {
  const connection = request.headers.connection
  const upgrade = request.headers.upgrade
  const hasUpgradeToken =
    typeof connection === 'string' &&
    connection
      .split(',')
      .map(value => value.trim().toLowerCase())
      .includes('upgrade')
  return hasUpgradeToken && typeof upgrade === 'string' && upgrade.trim().toLowerCase() === 'websocket'
}

function normalizePeerAddress(address: string | undefined): string {
  if (!address) return 'unknown'
  if (address.startsWith('::ffff:')) return address.slice('::ffff:'.length)
  return address
}

const STATUS_TEXT: Record<number, string> = {
  400: 'Bad Request',
  403: 'Forbidden',
  404: 'Not Found',
  426: 'Upgrade Required',
  429: 'Too Many Requests',
  503: 'Service Unavailable',
}

function rejectUpgrade(socket: Duplex, status: number, message: string): void {
  if (socket.destroyed) return
  const body = `${message}\n`
  const head =
    `HTTP/1.1 ${status} ${STATUS_TEXT[status] ?? 'Error'}\r\n` +
    'Connection: close\r\n' +
    'Content-Type: text/plain; charset=utf-8\r\n' +
    `Content-Length: ${Buffer.byteLength(body)}\r\n` +
    '\r\n'
  try {
    socket.write(head + body)
    socket.end()
  } catch {
    socket.destroy()
  }
}

/**
 * Dial a direct endpoint (controller role). Resolves with a connected
 * transport; `options.signal` cancels a pending dial.
 */
export async function connectDirect(
  url: string,
  options: ConnectDirectOptions = {},
): Promise<MeshTransport> {
  const parsed = new URL(url)
  if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') {
    throw new TypeError('direct endpoint must be a ws:// or wss:// URL')
  }
  const ws = await openWebSocket({
    url: parsed.toString(),
    handshakeTimeoutMs: options.handshakeTimeoutMs ?? 10_000,
    maxPayload: options.maxPayload ?? MAX_WS_PAYLOAD_BYTES,
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.protocols ? { protocols: options.protocols } : {}),
    ...(options.logger ? { logger: options.logger } : {}),
  })
  if (options.signal?.aborted) {
    terminateQuietly(ws)
    throw abortError()
  }
  return new WebSocketMeshTransport(ws, {
    kind: 'direct',
    remoteLabel: parsed.host,
    ...(options.logger ? { logger: options.logger } : {}),
    heartbeatMs: options.heartbeatMs ?? DEFAULT_DIRECT_HEARTBEAT_MS,
  })
}
