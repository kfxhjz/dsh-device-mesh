/**
 * C1 end-to-end regression: portal WebSocket text/binary opcodes.
 *
 * This is a host-level integration test (kept under `test/core` because it
 * builds on the in-memory session pair) that wires the real
 * `PortalController` → real `MeshSession`s → real `PortalDaemon` → a fake local
 * DSH WebSocket server. The fake server mirrors `dsh-api-gateway`: it accepts
 * only text frames and closes with `1003` as soon as a binary frame arrives.
 * Without the `[kind byte][payload]` envelope both directions were binary, so
 * `/api/remote.mux` could never work through the portal.
 */

import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { test } from 'node:test'

import { WebSocket, WebSocketServer } from 'ws'

import { MeshRpcError } from '../../src/shared/mesh-session.ts'
import type { DaemonSessionHandlers } from '../../src/shared/mesh-session.ts'
import type { DeviceDescriptor } from '../../src/shared/protocol.ts'
import { PortalController } from '../../src/host/portal-controller.ts'
import { PortalDaemon } from '../../src/host/portal-daemon.ts'
import { createLocalSessionPair } from './helpers/local-pair.ts'

const CONTROLLER: DeviceDescriptor = {
  deviceId: 'dm_controller',
  name: 'controller',
  platform: 'darwin',
  signPk: Buffer.alloc(32, 1).toString('base64url'),
  dhPk: Buffer.alloc(32, 2).toString('base64url'),
}
const DAEMON: DeviceDescriptor = {
  deviceId: 'dm_daemon',
  name: 'daemon',
  platform: 'linux',
  signPk: Buffer.alloc(32, 3).toString('base64url'),
  dhPk: Buffer.alloc(32, 4).toString('base64url'),
}

interface FakeDsh {
  readonly origin: string
  readonly received: Array<{ readonly data: Buffer; readonly isBinary: boolean }>
  readonly closeCodes: number[]
  /** Close every upstream DSH WebSocket (a remote-initiated close). */
  closeClients(): void
  close(): Promise<void>
}

/** Fake local DSH: launch-token login + a `/api/remote.mux` echo WebSocket. */
async function startFakeDsh(options: { rejectBinary: boolean }): Promise<FakeDsh> {
  const received: Array<{ data: Buffer; isBinary: boolean }> = []
  const closeCodes: number[] = []
  const server: Server = createServer((request, response) => {
    request.resume()
    const url = new URL(request.url ?? '/', 'http://fake')
    if (url.searchParams.has('token')) {
      response.writeHead(303, {
        location: './',
        'set-cookie': 'dsh-auth-test=the-secret-cookie; Max-Age=3600; Path=/; HttpOnly',
      })
      response.end()
      return
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end('fake local DSH')
  })
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false })
  server.on('upgrade', (request, socket, head) => {
    wss.handleUpgrade(request, socket, head, (client) => {
      client.on('close', (code: number) => {
        closeCodes.push(code)
      })
      client.on('message', (data: unknown, isBinary: boolean) => {
        const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer)
        received.push({ data: buffer, isBinary })
        if (isBinary) {
          if (options.rejectBinary) {
            // Exactly what dsh-api-gateway does with a binary frame.
            client.close(1003, 'text messages required')
            return
          }
          client.send(buffer, { binary: true })
          return
        }
        client.send(`echo:${buffer.toString('utf8')}`)
      })
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as AddressInfo
  return {
    origin: `http://127.0.0.1:${String(address.port)}`,
    received,
    closeCodes,
    closeClients: () => {
      for (const client of wss.clients) client.close(1000, 'upstream done')
    },
    close: async () => {
      for (const client of wss.clients) client.terminate()
      await new Promise<void>((resolve) =>{  wss.close(() => resolve()) })
      await new Promise<void>(resolve => server.close(() =>{  resolve() }))
    },
  }
}

interface PortalHarness {
  readonly portal: PortalController
  readonly sessions: ReturnType<typeof createLocalSessionPair>
  readonly url: string
  close(): Promise<void>
}

async function startPortal(dsh: FakeDsh): Promise<PortalHarness> {
  const daemon = new PortalDaemon({
    origin: dsh.origin,
    getService: name => name === 'connection'
      ? { authenticatedUrl: (base: string) => `${base}/?token=launch-token` }
      : undefined,
  })
  const handlers: DaemonSessionHandlers = {
    rpc: async (method) => {
      throw new MeshRpcError('mesh/not-found', `unknown method ${method}`)
    },
    http: (params, body, signal) => daemon.http(params, body, signal),
    ws: (params, signal) => daemon.ws(params, signal),
  }
  const sessions = createLocalSessionPair(
    { remote: DAEMON, pairing: { approval: 'none' } },
    {
      remote: CONTROLLER,
      pairing: { approval: 'none' },
      session: { handlers },
    },
  )
  const portal = await PortalController.open({
    session: sessions.sessionA,
    deviceId: DAEMON.deviceId,
    token: 'portal-token',
    idleTimeoutMs: 60_000,
  })
  return {
    portal,
    sessions,
    url: `ws://127.0.0.1:${String(portal.port)}/api/remote.mux?token=portal-token`,
    close: async () => {
      await portal.close()
      sessions.sessionA.close()
      sessions.sessionB.close()
      daemon.close()
    },
  }
}

function openBrowser(url: string, origin: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { origin })
    const timer = setTimeout(() => {
      socket.terminate()
      reject(new Error('browser websocket handshake timed out'))
    }, 3_000)
    socket.once('open', () => {
      clearTimeout(timer)
      resolve(socket)
    })
    socket.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
  })
}

/** Next browser message, including the opcode `ws` reports. */
function nextMessage(socket: WebSocket, timeoutMs = 3_000): Promise<{ data: Buffer; isBinary: boolean }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() =>{  reject(new Error('no websocket message arrived')) }, timeoutMs)
    socket.once('message', (data: unknown, isBinary: boolean) => {
      clearTimeout(timer)
      const buffer = Buffer.isBuffer(data)
        ? data
        : Array.isArray(data)
          ? Buffer.concat(data)
          : Buffer.from(data as ArrayBuffer)
      resolve({ data: buffer, isBinary })
    })
  })
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
  })
}

async function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for a condition')
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

test('portal websocket keeps text frames text through the real session pair (C1)', async () => {
  const dsh = await startFakeDsh({ rejectBinary: true })
  const harness = await startPortal(dsh)
  const socket = await openBrowser(harness.url, harness.portal.origin)
  try {
    const payload = JSON.stringify({ type: 'subscribe', stream: 'remote.mux' })
    // Register the reply listener first: the echo can arrive before the polling
    // helper below observes the upstream frame.
    const replyPromise = nextMessage(socket)
    socket.send(payload)

    await waitFor(() => dsh.received.length === 1)
    const received = dsh.received[0]
    assert.ok(received)
    assert.equal(received.isBinary, false, 'local DSH must receive a text frame')
    assert.equal(received.data.toString('utf8'), payload)

    const reply = await replyPromise
    assert.equal(reply.isBinary, false, 'browser must receive a text frame')
    assert.equal(reply.data.toString('utf8'), `echo:${payload}`)
    // The strict fake would have closed with 1003 if anything was binary.
    assert.equal(dsh.closeCodes.includes(1003), false)
  } finally {
    socket.close()
    await harness.close()
    await dsh.close()
  }
})

test('portal websocket round-trips a large history snapshot through compressed framing', async () => {
  const dsh = await startFakeDsh({ rejectBinary: false })
  const harness = await startPortal(dsh)
  const socket = await openBrowser(harness.url, harness.portal.origin)
  try {
    // Comfortably above the gzip threshold and the 32 KiB Mesh chunk size.
    const payload = JSON.stringify({ messages: Array.from({ length: 2_000 }, (_, index) => ({ index, text: 'history-'.repeat(20) })) })
    const replyPromise = nextMessage(socket, 10_000)
    socket.send(payload)

    await waitFor(() => dsh.received.length === 1, 10_000)
    assert.equal(dsh.received[0]?.data.toString('utf8'), payload)

    const reply = await replyPromise
    assert.equal(reply.isBinary, false)
    assert.equal(reply.data.toString('utf8'), `echo:${payload}`)
  } finally {
    socket.close()
    await harness.close()
    await dsh.close()
  }
})

test('portal websocket keeps binary frames binary through the real session pair (C1)', async () => {
  const dsh = await startFakeDsh({ rejectBinary: false })
  const harness = await startPortal(dsh)
  const socket = await openBrowser(harness.url, harness.portal.origin)
  try {
    // Include a NUL and invalid UTF-8 bytes: a text conversion would corrupt it.
    const payload = Buffer.from([0x00, 0x7b, 0xff, 0xfe, 0x0a])
    const replyPromise = nextMessage(socket)
    socket.send(payload)

    await waitFor(() => dsh.received.length === 1)
    const received = dsh.received[0]
    assert.ok(received)
    assert.equal(received.isBinary, true, 'local DSH must receive a binary frame')
    assert.deepEqual(received.data, payload)

    const reply = await replyPromise
    assert.equal(reply.isBinary, true, 'browser must receive a binary frame')
    assert.deepEqual(reply.data, payload)
  } finally {
    socket.close()
    await harness.close()
    await dsh.close()
  }
})

/** Number of stream records kept by one session (white-box: no public getter). */
function streamCount(session: unknown): number {
  return (session as { streams: Map<number, unknown> }).streams.size
}

test('graceful browser closes release every portal WebSocket stream (H1)', { timeout: 90_000 }, async () => {
  const dsh = await startFakeDsh({ rejectBinary: false })
  const harness = await startPortal(dsh)
  try {
    // Well past the 32-stream cap: before the fix, the 33rd upgrade failed
    // because both sides leaked one record per graceful close.
    for (let index = 0; index < 40; index += 1) {
      const socket = await openBrowser(harness.url, harness.portal.origin)
      const reply = nextMessage(socket)
      socket.send('ping')
      await reply
      const closed = new Promise<void>((resolve) => {
        socket.once('close', () =>{  resolve() })
      })
      socket.close(1000, 'done')
      await closed
    }
    await waitFor(
      () => streamCount(harness.sessions.sessionA) === 0 && streamCount(harness.sessions.sessionB) === 0,
      5_000,
    )
    // A fresh upgrade after the churn must still be admitted.
    const socket = await openBrowser(harness.url, harness.portal.origin)
    const reply = nextMessage(socket)
    socket.send('after-churn')
    assert.equal((await reply).data.toString('utf8'), 'echo:after-churn')
    socket.close(1000, 'done')
  } finally {
    await harness.close()
    await dsh.close()
  }
})

test('remote DSH close releases both portal WebSocket records (H1)', { timeout: 30_000 }, async () => {
  const dsh = await startFakeDsh({ rejectBinary: false })
  const harness = await startPortal(dsh)
  const socket = await openBrowser(harness.url, harness.portal.origin)
  try {
    const reply = nextMessage(socket)
    socket.send('ping')
    await reply

    const browserClosed = new Promise<void>((resolve) => {
      socket.once('close', () =>{  resolve() })
    })
    dsh.closeClients()
    assert.equal(
      await Promise.race([browserClosed.then(() => true), delay(2_000).then(() => false)]),
      true,
      'the browser socket should close when the upstream DSH socket closes',
    )
    await waitFor(
      () => streamCount(harness.sessions.sessionA) === 0 && streamCount(harness.sessions.sessionB) === 0,
      5_000,
    )
  } finally {
    socket.terminate()
    await harness.close()
    await dsh.close()
  }
})

test('closing the mesh session aborts the portal websocket and the upstream DSH socket (M2/M5)', async () => {
  const dsh = await startFakeDsh({ rejectBinary: false })
  const harness = await startPortal(dsh)
  const socket = await openBrowser(harness.url, harness.portal.origin)
  try {
    const replyPromise = nextMessage(socket)
    socket.send('ping')
    await replyPromise
    const browserClosed = new Promise<void>((resolve) => {
      socket.once('close', () =>{  resolve() })
    })

    harness.sessions.sessionA.close()

    // The daemon session learns about the transport close and must terminate
    // the local DSH WebSocket instead of leaving it dangling.
    await waitFor(() => dsh.closeCodes.length > 0)
    assert.ok(
      dsh.closeCodes.includes(1011),
      `expected an abort close on the local DSH socket, got ${dsh.closeCodes.join(',')}`,
    )
    assert.equal(await Promise.race([browserClosed.then(() => true), delay(2_000).then(() => false)]), true)
  } finally {
    socket.terminate()
    await harness.close()
    await dsh.close()
  }
})
