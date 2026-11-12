import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { gunzipSync } from 'node:zlib'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { describe, it } from 'node:test'

import { MeshRpcError, decodeWsMessage, encodeWsMessage } from '../../src/shared/mesh-session.ts'
import type { ChunkStream } from '../../src/shared/mesh-session.ts'
import {
  PortalDaemon,
  sanitizeProxyRequestHeaders,
  sanitizeUpstreamResponseHeaders,
  validateProxyPath,
} from '../../src/host/portal-daemon.ts'
import type { PortalWebSocket } from '../../src/host/portal-daemon.ts'
import { collect, streamOf } from './helpers.ts'

interface ReceivedRequest {
  readonly url: string
  readonly headers: IncomingMessage['headers']
  readonly body: string
}

interface FakeDshServer {
  readonly server: Server
  readonly origin: string
  readonly received: ReceivedRequest[]
  readonly close: () => Promise<void>
}

async function startFakeDsh(): Promise<FakeDshServer> {
  const received: ReceivedRequest[] = []
  let slow401Count = 0
  const server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
    const url = new URL(request.url ?? '/', 'http://fake')
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    received.push({
      url: request.url ?? '/',
      headers: request.headers,
      body: Buffer.concat(chunks).toString('utf8'),
    })
    if (url.searchParams.has('token')) {
      response.writeHead(303, {
        location: './',
        'set-cookie': 'dsh-auth-abc123=the-secret-cookie; Max-Age=3600; Path=/; HttpOnly; SameSite=Strict',
      })
      response.end()
      return
    }
    if (request.headers.cookie !== 'dsh-auth-abc123=the-secret-cookie') {
      response.writeHead(401, { 'content-type': 'text/plain' })
      response.end('unauthorized')
      return
    }
    if (url.pathname === '/slow401' && slow401Count++ === 0) {
      response.writeHead(401, { 'content-type': 'text/plain' })
      response.end('expired')
      return
    }
    response.writeHead(200, {
      'content-type': 'text/plain; charset=utf-8',
      'x-frame-options': 'DENY',
      'x-keep': 'yes',
      'set-cookie': 'leak=1',
    })
    response.end('local-dsh-ui')
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as AddressInfo
  return {
    server,
    origin: `http://127.0.0.1:${String(address.port)}`,
    received,
    close: async () => {
      await new Promise<void>(resolve => server.close(() =>{  resolve() }))
    },
  }
}

class FakeSocket {
  readyState = 1
  protocol = ''
  bufferedAmount = 0
  readonly sent: Buffer[] = []
  /** Raw `send()` arguments, before the test normalizes them to Buffers. */
  readonly sentRaw: Array<Uint8Array | string> = []
  readonly closeCalls: Array<{ code?: number; reason?: string }> = []
  terminated = false
  private readonly listeners = new Map<string, Array<(...args: unknown[]) => void>>()

  on(event: string, listener: (...args: unknown[]) => void): void {
    const list = this.listeners.get(event) ?? []
    list.push(listener)
    this.listeners.set(event, list)
  }

  emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) listener(...args)
  }

  send(data: Uint8Array | string): void {
    this.sentRaw.push(data)
    this.sent.push(Buffer.isBuffer(data) ? data : Buffer.from(data as string))
  }

  close(code?: number, reason?: string): void {
    this.closeCalls.push({ ...(code !== undefined ? { code } : {}), ...(reason !== undefined ? { reason } : {}) })
    this.emit('close', code ?? 1000, Buffer.from(reason ?? ''))
  }

  terminate(): void {
    this.terminated = true
    this.emit('close', 1006, Buffer.alloc(0))
  }
}

function fakeConnection(_origin: string): Record<string, unknown> {
  return {
    authenticatedUrl: (base: string) => `${base}/?token=launch-token-secret`,
    createPeer: () => ({}),
  }
}

describe('portal-daemon: local DSH web proxy', () => {
  it('logs in once, rewrites the fence headers and strips credentials from responses', async () => {
    const dsh = await startFakeDsh()
    const daemon = new PortalDaemon({
      origin: dsh.origin,
      getService: name => (name === 'connection' ? fakeConnection(dsh.origin) : undefined),
    })
    try {
      assert.deepEqual(await daemon.prepare(), { ok: true })
      const loginRequests = dsh.received.filter(request => request.url.includes('token='))
      assert.equal(loginRequests.length, 1)
      assert.equal(loginRequests[0]?.url, '/?token=launch-token-secret')

      const exchange = await daemon.http(
        {
          method: 'GET',
          path: '/?x=1',
          headers: {
            accept: 'text/html',
            'user-agent': 'browser-ua',
            origin: 'http://127.0.0.1:55555',
            referer: 'http://127.0.0.1:55555/',
            'sec-fetch-site': 'cross-site',
            'x-dsh-mesh-peer': 'dm_controller',
          },
        },
        streamOf(),
        new AbortController().signal,
      )
      assert.equal(exchange.status, 200)
      assert.equal(exchange.headers['x-frame-options'], 'DENY')
      assert.equal(exchange.headers['x-keep'], 'yes')
      assert.equal(exchange.headers['set-cookie'], undefined)
      assert.equal(exchange.headers['content-encoding'], 'gzip')
      assert.equal(gunzipSync(await collect(exchange.body)).toString('utf8'), 'local-dsh-ui')

      const proxied = dsh.received.at(-1)
      assert.ok(proxied)
      const expectedAuthority = new URL(dsh.origin).host
      assert.equal(proxied.headers.host, expectedAuthority)
      assert.equal(proxied.headers.origin, dsh.origin)
      assert.equal(proxied.headers.referer, `${dsh.origin}/?x=1`)
      assert.equal(proxied.headers['sec-fetch-site'], 'same-origin')
      assert.equal(proxied.headers.cookie, 'dsh-auth-abc123=the-secret-cookie')
      assert.equal(proxied.headers['x-dsh-mesh-peer'], undefined)
      assert.equal(proxied.headers['accept-encoding'], 'identity')
      assert.equal(proxied.headers['user-agent'], 'browser-ua')

      const status = daemon.status()
      assert.equal(status.cookiePresent, true)
      assert.equal(status.origin, expectedAuthority)
      assert.equal(JSON.stringify(status).includes('the-secret-cookie'), false)
    } finally {
      daemon.close()
      await dsh.close()
    }
  })

  it('forwards request bodies and survives a cookie refresh on 401', async () => {
    const dsh = await startFakeDsh()
    const daemon = new PortalDaemon({
      origin: dsh.origin,
      getService: name => (name === 'connection' ? fakeConnection(dsh.origin) : undefined),
    })
    try {
      await daemon.prepare()
      const body = await collect(streamOf('{"value":', '42}'))
      const exchange = await daemon.http(
        {
          method: 'POST',
          path: '/api/save',
          headers: { 'content-type': 'application/json' },
        },
        streamOf('{"value":', '42}'),
        new AbortController().signal,
      )
      assert.equal(exchange.status, 200)
      const saved = dsh.received.at(-1)
      assert.equal(saved?.body, '{"value":42}')
      assert.equal(body.toString('utf8'), '{"value":42}')

      // Force one 401; the daemon must re-run the launch-token login and retry.
      const loginsBefore = dsh.received.filter(request => request.url.includes('token=')).length
      const retried = await daemon.http(
        { method: 'GET', path: '/slow401', headers: {} },
        streamOf(),
        new AbortController().signal,
      )
      const loginsAfter = dsh.received.filter(request => request.url.includes('token=')).length
      assert.equal(loginsAfter, loginsBefore + 1)
      assert.equal(retried.status, 200)
    } finally {
      daemon.close()
      await dsh.close()
    }
  })

  it('rejects unsafe paths and unknown methods', async () => {
    const dsh = await startFakeDsh()
    const daemon = new PortalDaemon({
      origin: dsh.origin,
      getService: name => (name === 'connection' ? fakeConnection(dsh.origin) : undefined),
    })
    try {
      await assert.rejects(
        () => daemon.http({ method: 'GET', path: '//evil.example/x', headers: {} }, streamOf(), new AbortController().signal),
        (error: unknown) => error instanceof MeshRpcError && error.code === 'mesh/bad-request',
      )
      await assert.rejects(
        () => daemon.http({ method: 'GET', path: 'http://evil.example/', headers: {} }, streamOf(), new AbortController().signal),
        (error: unknown) => error instanceof MeshRpcError && error.code === 'mesh/bad-request',
      )
      await assert.rejects(
        () => daemon.http({ method: 'BREW', path: '/', headers: {} }, streamOf(), new AbortController().signal),
        (error: unknown) => error instanceof MeshRpcError && error.code === 'mesh/bad-request',
      )
      assert.throws(() => validateProxyPath('/a\r\nb'), MeshRpcError)
    } finally {
      daemon.close()
      await dsh.close()
    }
  })
})

describe('portal-daemon: websocket proxy', () => {
  it('dials the local DSH WebSocket with rewritten headers and bridges messages', async () => {
    const socket = new FakeSocket()
    socket.protocol = 'dsh-demo'
    const dials: Array<{ url: string; headers: Readonly<Record<string, string>>; protocols?: readonly string[] }> = []
    const daemon = new PortalDaemon({
      origin: 'http://127.0.0.1:45678',
      getService: name => (name === 'connection' ? fakeConnection('http://127.0.0.1:45678') : undefined),
      // No real local DSH listener in this test: answer the login token
      // exchange in-process so only the WebSocket bridge is exercised.
      fetchImpl: async () => new Response(null, {
        status: 303,
        headers: { 'set-cookie': 'dsh-auth-abc123=the-secret-cookie; Max-Age=3600; Path=/' },
      }),
      openWebSocket: async (url, options) => {
        dials.push({
          url,
          headers: options.headers,
          ...(options.protocols !== undefined ? { protocols: options.protocols } : {}),
        })
        setTimeout(() =>{  socket.emit('open') }, 0)
        return socket as unknown as PortalWebSocket
      },
    })
    try {
      const exchange = await daemon.ws(
        {
          path: '/api/remote.mux',
          headers: {
            'user-agent': 'browser',
            origin: 'http://127.0.0.1:55555',
            'sec-fetch-site': 'cross-site',
            'x-dsh-mesh-peer': 'dm_controller',
          },
          protocols: ['dsh-demo', 'dsh-fallback'],
        },
        new AbortController().signal,
      )
      assert.equal(exchange.protocol, 'dsh-demo')
      const dial = dials[0]
      assert.ok(dial)
      assert.equal(dial.url, 'ws://127.0.0.1:45678/api/remote.mux')
      assert.deepEqual(dial.protocols, ['dsh-demo', 'dsh-fallback'])
      assert.equal(dial.headers.host, undefined)
      assert.equal(dial.headers.cookie, 'dsh-auth-abc123=the-secret-cookie')
      assert.equal(dial.headers.origin, 'http://127.0.0.1:45678')
      assert.equal(dial.headers['sec-fetch-site'], 'same-origin')
      assert.equal(dial.headers['x-dsh-mesh-peer'], undefined)

      socket.emit('message', Buffer.from('from-remote'), false)
      const inbound: ChunkStream = exchange.inbound
      const first = await inbound[Symbol.asyncIterator]().next()
      assert.equal(first.done, false)
      const received = decodeWsMessage(first.value ?? new Uint8Array())
      assert.equal(received.kind, 'text')
      assert.equal(Buffer.from(received.payload).toString('utf8'), 'from-remote')

      await exchange.outbound.write(encodeWsMessage(Buffer.from('from-controller'), 'text'))
      assert.equal(socket.sentRaw[0], 'from-controller')
      await exchange.outbound.end()
      assert.equal(socket.closeCalls.at(-1)?.code, 1000)
    } finally {
      daemon.close()
    }
  })

  it('preserves the text/binary opcode across the mesh envelope', async () => {
    const socket = new FakeSocket()
    const daemon = new PortalDaemon({
      origin: 'http://127.0.0.1:45678',
      getService: name => (name === 'connection' ? fakeConnection('http://127.0.0.1:45678') : undefined),
      fetchImpl: async () => new Response(null, {
        status: 303,
        headers: { 'set-cookie': 'dsh-auth-abc123=the-secret-cookie; Max-Age=3600; Path=/' },
      }),
      openWebSocket: async () => socket as unknown as PortalWebSocket,
    })
    try {
      const exchange = await daemon.ws({ path: '/api/remote.mux', headers: {} }, new AbortController().signal)
      const iterator = exchange.inbound[Symbol.asyncIterator]()

      socket.emit('message', Buffer.from('{"type":"hello"}'), false)
      const textMessage = (await iterator.next()).value as Uint8Array
      assert.equal(textMessage[0], 0, 'text frames get kind byte 0')
      assert.equal(decodeWsMessage(textMessage).kind, 'text')
      assert.equal(Buffer.from(decodeWsMessage(textMessage).payload).toString('utf8'), '{"type":"hello"}')

      socket.emit('message', Buffer.from([0xde, 0xad]), true)
      const binaryMessage = (await iterator.next()).value as Uint8Array
      assert.equal(binaryMessage[0], 1, 'binary frames get kind byte 1')
      assert.equal(decodeWsMessage(binaryMessage).kind, 'binary')
      assert.deepEqual([...decodeWsMessage(binaryMessage).payload], [0xde, 0xad])

      await exchange.outbound.write(encodeWsMessage(Buffer.from('{"ok":true}'), 'text'))
      await exchange.outbound.write(encodeWsMessage(Uint8Array.of(1, 2, 3), 'binary'))
      assert.equal(typeof socket.sentRaw[0], 'string', 'text must be sent as a string')
      assert.equal(socket.sentRaw[0], '{"ok":true}')
      assert.ok(socket.sentRaw[1] instanceof Uint8Array, 'binary must be sent as bytes')
      assert.deepEqual([...(socket.sentRaw[1])], [1, 2, 3])
    } finally {
      daemon.close()
    }
  })

  it('closes the upstream DSH socket when the mesh stream is aborted', async () => {
    const socket = new FakeSocket()
    const controller = new AbortController()
    const daemon = new PortalDaemon({
      origin: 'http://127.0.0.1:45678',
      getService: name => (name === 'connection' ? fakeConnection('http://127.0.0.1:45678') : undefined),
      fetchImpl: async () => new Response(null, {
        status: 303,
        headers: { 'set-cookie': 'dsh-auth-abc123=the-secret-cookie; Max-Age=3600; Path=/' },
      }),
      openWebSocket: async () => socket as unknown as PortalWebSocket,
    })
    try {
      const exchange = await daemon.ws({ path: '/api/remote.mux', headers: {} }, controller.signal)
      controller.abort()
      assert.equal(socket.closeCalls.at(-1)?.code, 1011)
      // The abort listener was removed during teardown; aborting again must not
      // re-close the socket or throw.
      assert.doesNotThrow(() =>{  controller.abort() })
      await assert.rejects(
        async () => {
          for await (const _chunk of exchange.inbound) {
            // The failed queue must not yield any message.
          }
        },
        (error: unknown) => error instanceof MeshRpcError,
      )
    } finally {
      daemon.close()
    }
  })

  it('maps a dial failure to portal/unavailable', async () => {
    const daemon = new PortalDaemon({
      origin: 'http://127.0.0.1:45678',
      getService: name => (name === 'connection' ? fakeConnection('http://127.0.0.1:45678') : undefined),
      fetchImpl: async () => new Response(null, {
        status: 303,
        headers: { 'set-cookie': 'dsh-auth-abc123=the-secret-cookie; Max-Age=3600; Path=/' },
      }),
      openWebSocket: async () => {
        throw new MeshRpcError('portal/unavailable', 'connection refused')
      },
    })
    try {
      await assert.rejects(
        () => daemon.ws({ path: '/x', headers: {} }, new AbortController().signal),
        (error: unknown) => error instanceof MeshRpcError && error.code === 'portal/unavailable',
      )
    } finally {
      daemon.close()
    }
  })
})

describe('portal-daemon: header helpers', () => {
  it('sanitizes upstream response headers', () => {
    const headers = sanitizeUpstreamResponseHeaders({
      'content-type': 'text/html',
      'content-encoding': 'gzip',
      'content-length': '100',
      'set-cookie': 'a=b',
      connection: 'keep-alive',
      'x-frame-options': 'DENY',
    })
    assert.deepEqual(headers, { 'content-type': 'text/html', 'x-frame-options': 'DENY' })
  })

  it('never forwards browser Credentials or DSH-owned headers to DSH', () => {
    const headers = sanitizeProxyRequestHeaders(
      {
        cookie: 'browser=1',
        authorization: 'Bearer x',
        'x-dsh-mesh-peer': 'dm',
        'x-dsh-auth-token': 'stolen-platform-token',
        'x-dsh-file': '/etc/passwd',
        'x-custom': 'keep',
        accept: 'text/html',
      },
      'http://127.0.0.1:3080',
      'dsh-auth-a=b',
      '/x',
    )
    assert.equal(headers.cookie, 'dsh-auth-a=b')
    assert.equal(headers.authorization, undefined)
    assert.equal(headers['x-dsh-mesh-peer'], undefined)
    assert.equal(headers['x-dsh-auth-token'], undefined)
    assert.equal(headers['x-dsh-file'], undefined)
    assert.equal(headers['x-custom'], 'keep')
    assert.equal(headers.accept, 'text/html')
  })
})
