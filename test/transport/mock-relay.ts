/**
 * A small in-process paseo-relay stand-in for unit tests.
 *
 * It implements the parts of the wire contract documented in
 * `paseo-relay/docs/protocol.md`:
 *  - v1: one server + one client socket per `serverId`, opaque frame
 *    forwarding, newer same-role socket replaces the older one with 1008;
 *  - v2: a daemon control socket (`sync` / `connected` / `disconnected` /
 *    JSON ping→pong), one daemon data socket per client `connectionId`,
 *    client frames buffered until the data route attaches (1013 on timeout),
 *    `1001` to the data socket and `1012` to the client when either side ends.
 *
 * This file is intentionally test-only and dependency-free besides `ws`.
 */

import { randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import type { Server as HttpServer, IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'

import { WebSocket, WebSocketServer } from 'ws'
import type { RawData } from 'ws'

export interface MockRelayOptions {
  /** How long a client frame waits for a daemon data socket (relay default 15 s). */
  readonly dataAttachTimeoutMs?: number
}

interface PendingFrames {
  frames: Array<{ readonly data: Buffer; readonly binary: boolean }>
  timer: NodeJS.Timeout
}

interface Session {
  readonly serverId: string
  control: WebSocket | undefined
  v1Server: WebSocket | undefined
  v1Client: WebSocket | undefined
  readonly clients: Map<string, WebSocket>
  readonly data: Map<string, WebSocket>
  readonly pending: Map<string, PendingFrames>
  readonly received: Map<string, Uint8Array[]>
}

export interface MockRelay {
  /** `ws://127.0.0.1:<port>/ws`. */
  readonly url: string
  readonly port: number
  /** Drop the daemon control socket, keeping clients/session alive (relay restart). */
  dropControl(serverId: string, code?: number, reason?: string): void
  /** Drop one controller socket from the relay side. */
  dropClient(connectionId: string, code?: number, reason?: string): void
  /** Drop the daemon data socket for a connection (simulates a data route loss). */
  dropData(connectionId: string): void
  connectionIds(serverId: string): string[]
  hasDataSocket(connectionId: string): boolean
  /** Bytes the daemon data socket received for that connection, in order. */
  receivedByData(connectionId: string): Uint8Array[]
  /** Send a JSON `{"type":"ping"}` on the daemon control socket. */
  sendControlPing(serverId: string): void
  /** Text control frames the daemon sent, in arrival order (parsed JSON). */
  controlMessages(serverId: string): unknown[]
  /** Await a predicate (poll up to `timeoutMs`). */
  waitFor(predicate: () => boolean, timeoutMs?: number): Promise<void>
  close(): Promise<void>
}

export async function startMockRelay(options: MockRelayOptions = {}): Promise<MockRelay> {
  const dataAttachTimeoutMs = options.dataAttachTimeoutMs ?? 15_000
  const sessions = new Map<string, Session>()
  const sockets = new Set<Duplex>()
  const receivedControl = new Map<string, unknown[]>()
  let closed = false

  const httpServer: HttpServer = createServer((_request, response) => {
    response.statusCode = 404
    response.end('not found\n')
  })
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: 32 * 1024 * 1024,
    perMessageDeflate: false,
  })

  httpServer.on('connection', (socket: Duplex) => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
  })
  httpServer.on('upgrade', (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    if (closed) {
      socket.destroy()
      return
    }
    const url = new URL(request.url ?? '/', 'http://relay.invalid')
    if (url.pathname !== '/ws') {
      rejectUpgrade(socket, 404, 'not found')
      return
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      handleConnection(ws, url.searchParams)
    })
  })

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject)
    httpServer.listen(0, '127.0.0.1', () =>{  resolve() })
  })
  const address = httpServer.address()
  if (address === null || typeof address === 'string') throw new Error('mock relay has no port')
  const port = address.port

  function getSession(serverId: string): Session {
    let session = sessions.get(serverId)
    if (!session) {
      session = {
        serverId,
        control: undefined,
        v1Server: undefined,
        v1Client: undefined,
        clients: new Map(),
        data: new Map(),
        pending: new Map(),
        received: new Map(),
      }
      sessions.set(serverId, session)
    }
    return session
  }

  function handleConnection(ws: WebSocket, params: URLSearchParams): void {
    const serverId = params.get('serverId')
    const role = params.get('role')
    if (!serverId || (role !== 'server' && role !== 'client')) {
      ws.close(1008, 'invalid query')
      return
    }
    const version = params.get('v') === '2' ? 2 : 1
    const rawConnectionId = params.get('connectionId') ?? ''
    const session = getSession(serverId)

    if (version === 1) {
      handleV1(ws, session, role)
      return
    }
    handleV2(ws, session, role, rawConnectionId)
  }

  function handleV1(ws: WebSocket, session: Session, role: 'server' | 'client'): void {
    const existing = role === 'server' ? session.v1Server : session.v1Client
    if (existing && existing.readyState === WebSocket.OPEN) {
      existing.close(1008, 'Replaced by new connection')
    }
    if (role === 'server') session.v1Server = ws
    else session.v1Client = ws

    ws.on('message', (data, isBinary) => {
      const peer = role === 'server' ? session.v1Client : session.v1Server
      if (peer && peer.readyState === WebSocket.OPEN) {
        peer.send(data, { binary: isBinary })
      }
    })
    ws.on('close', () => {
      if (role === 'server' && session.v1Server === ws) session.v1Server = undefined
      if (role === 'client' && session.v1Client === ws) session.v1Client = undefined
    })
  }

  function handleV2(
    ws: WebSocket,
    session: Session,
    role: 'server' | 'client',
    rawConnectionId: string,
  ): void {
    const connectionId = rawConnectionId.length > 0 ? rawConnectionId : ''
    if (role === 'server' && connectionId === '') {
      // Control socket: replaces a previous one with 1008.
      if (session.control && session.control.readyState === WebSocket.OPEN) {
        session.control.close(1008, 'Replaced by new connection')
      }
      session.control = ws
      sendText(ws, {
        type: 'sync',
        connectionIds: [...session.clients.keys()],
      })
      ws.on('message', (data, isBinary) => {
        if (isBinary) return
        let parsed: unknown
        try {
          parsed = JSON.parse(data.toString())
        } catch {
          return
        }
        const inbox = receivedControl.get(session.serverId) ?? []
        inbox.push(parsed)
        receivedControl.set(session.serverId, inbox)
        if (parsed && typeof parsed === 'object' && (parsed as { type?: unknown }).type === 'ping') {
          sendText(ws, { type: 'pong', ts: Date.now() })
        }
      })
      ws.on('close', () => {
        if (session.control === ws) session.control = undefined
      })
      return
    }

    if (role === 'server') {
      // Data socket for one connection id.
      const existing = session.data.get(connectionId)
      if (existing && existing.readyState === WebSocket.OPEN) {
        existing.close(1008, 'Replaced by new connection')
      }
      session.data.set(connectionId, ws)
      flushPending(session, connectionId, ws)
      ws.on('message', (data, isBinary) => {
        const buffer = toBuffer(data)
        const received = session.received.get(connectionId) ?? []
        received.push(new Uint8Array(buffer))
        session.received.set(connectionId, received)
        const client = session.clients.get(connectionId)
        if (client && client.readyState === WebSocket.OPEN) {
          client.send(data, { binary: isBinary })
        }
      })
      ws.on('close', () => {
        if (session.data.get(connectionId) !== ws) return
        session.data.delete(connectionId)
        // "Server disconnected": all clients for the connection close 1012.
        const client = session.clients.get(connectionId)
        if (client) {
          session.clients.delete(connectionId)
          client.close(1012, 'Server disconnected')
        }
      })
      return
    }

    // Client socket.
    const id = connectionId.length > 0 ? connectionId : newConnectionId()
    const existing = session.clients.get(id)
    if (existing && existing.readyState === WebSocket.OPEN) {
      existing.close(1008, 'Replaced by new connection')
    }
    session.clients.set(id, ws)
    const control = session.control
    if (control && control.readyState === WebSocket.OPEN) {
      sendText(control, { type: 'connected', connectionId: id })
    }

    ws.on('message', (data, isBinary) => {
      const dataSocket = session.data.get(id)
      if (dataSocket && dataSocket.readyState === WebSocket.OPEN) {
        dataSocket.send(data, { binary: isBinary })
        return
      }
      const pending = session.pending.get(id)
      const frame = { data: toBuffer(data), binary: isBinary }
      if (pending) {
        pending.frames.push(frame)
        return
      }
      const timer = setTimeout(() => {
        const current = session.pending.get(id)
        session.pending.delete(id)
        if (current && session.clients.get(id) === ws) {
          ws.close(1013, 'Data route unavailable')
        }
      }, dataAttachTimeoutMs)
      timer.unref?.()
      session.pending.set(id, { frames: [frame], timer })
    })
    ws.on('close', () => {
      if (session.clients.get(id) !== ws) return
      session.clients.delete(id)
      const pending = session.pending.get(id)
      if (pending) {
        clearTimeout(pending.timer)
        session.pending.delete(id)
      }
      const control = session.control
      if (control && control.readyState === WebSocket.OPEN) {
        sendText(control, { type: 'disconnected', connectionId: id })
      }
      const dataSocket = session.data.get(id)
      if (dataSocket) {
        session.data.delete(id)
        if (dataSocket.readyState === WebSocket.OPEN) {
          dataSocket.close(1001, 'Client disconnected')
        }
      }
    })
  }

  function flushPending(session: Session, connectionId: string, dataSocket: WebSocket): void {
    const pending = session.pending.get(connectionId)
    if (!pending) return
    clearTimeout(pending.timer)
    session.pending.delete(connectionId)
    for (const frame of pending.frames) {
      if (dataSocket.readyState !== WebSocket.OPEN) break
      dataSocket.send(frame.data, { binary: frame.binary })
    }
  }

  async function close(): Promise<void> {
    if (closed) return
    closed = true
    for (const session of sessions.values()) {
      session.control?.close(1000, 'relay stopped')
      session.v1Server?.close(1000, 'relay stopped')
      session.v1Client?.close(1000, 'relay stopped')
      for (const client of session.clients.values()) client.close(1000, 'relay stopped')
      for (const dataSocket of session.data.values()) dataSocket.close(1000, 'relay stopped')
      for (const pending of session.pending.values()) clearTimeout(pending.timer)
    }
    const wssClosed = new Promise<void>((resolve) =>{  wss.close(() => resolve()) })
    const serverClosed = new Promise<void>(resolve => httpServer.close(() =>{  resolve() }))
    await Promise.race([Promise.all([wssClosed, serverClosed]), sleep(1_000)])
    for (const socket of sockets) socket.destroy()
    await Promise.race([Promise.all([wssClosed, serverClosed]), sleep(500)])
  }

  async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error('mock relay waitFor timed out')
      await sleep(10)
    }
  }

  return {
    url: `ws://127.0.0.1:${port}/ws`,
    port,
    dropControl(serverId: string, code = 1011, reason = 'relay restart'): void {
      const control = sessions.get(serverId)?.control
      if (control) control.close(code, reason)
    },
    dropClient(connectionId: string, code = 1000, reason = 'test drop'): void {
      for (const session of sessions.values()) {
        const client = session.clients.get(connectionId)
        if (client) client.close(code, reason)
      }
    },
    dropData(connectionId: string): void {
      for (const session of sessions.values()) {
        const dataSocket = session.data.get(connectionId)
        if (dataSocket) dataSocket.terminate()
      }
    },
    connectionIds(serverId: string): string[] {
      const session = sessions.get(serverId)
      return session ? [...session.clients.keys()] : []
    },
    hasDataSocket(connectionId: string): boolean {
      for (const session of sessions.values()) {
        const dataSocket = session.data.get(connectionId)
        if (dataSocket && dataSocket.readyState === WebSocket.OPEN) return true
      }
      return false
    },
    receivedByData(connectionId: string): Uint8Array[] {
      for (const session of sessions.values()) {
        const frames = session.received.get(connectionId)
        if (frames) return frames
      }
      return []
    },
    sendControlPing(serverId: string): void {
      const control = sessions.get(serverId)?.control
      if (control) sendText(control, { type: 'ping' })
    },
    controlMessages(serverId: string): unknown[] {
      return receivedControl.get(serverId) ?? []
    },
    waitFor,
    close,
  }

  function sendText(ws: WebSocket, payload: unknown): void {
    if (ws.readyState !== WebSocket.OPEN) return
    try {
      ws.send(JSON.stringify(payload))
    } catch {
      // Socket raced into CLOSING.
    }
  }

  function newConnectionId(): string {
    return `conn_${randomBytes(8).toString('hex')}`
  }
}

function toBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return Buffer.from(data)
  if (Array.isArray(data)) return Buffer.concat(data)
  return Buffer.from(new Uint8Array(data))
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
  })
}

const STATUS_TEXT: Record<number, string> = { 404: 'Not Found' }

function rejectUpgrade(socket: Duplex, status: number, message: string): void {
  const body = `${message}\n`
  socket.write(
    `HTTP/1.1 ${status} ${STATUS_TEXT[status] ?? 'Error'}\r\n` +
      'Connection: close\r\n' +
      'Content-Type: text/plain\r\n' +
      `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
  )
  socket.end()
}
