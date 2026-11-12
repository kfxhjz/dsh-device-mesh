import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import { WebSocket } from 'ws'

import type { WsExchangeResult } from '../../src/shared/mesh-session.ts'
import { encodeWsMessage } from '../../src/shared/mesh-session.ts'
import {
  PortalController,
  injectEmbedShell,
  readLimitedText,
  sanitizeControllerRequestHeaders,
  sanitizeControllerResponseHeaders,
  stripFrameAncestorsDirective,
} from '../../src/host/portal-controller.ts'
import { FakeMeshSession, collect, fakeDescriptor, streamOf } from './helpers.ts'

function cookieFrom(response: Response): string {
  const setCookie = response.headers.getSetCookie()[0]
  assert.ok(setCookie, 'expected a Set-Cookie header')
  const pair = setCookie.split(';')[0]
  assert.ok(pair)
  return pair
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for a condition')
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

interface RawHttpResult {
  readonly status: number
  readonly headers: Record<string, string | string[] | undefined>
  readonly body: string
}

/** Low-level HTTP request, so tests can forge `Host`/`Origin`/`Sec-Fetch-*`. */
async function rawHttp(
  url: string,
  options: {
    method?: string
    headers?: Record<string, string>
    body?: string
    /** Overrides the synthetic Fetch Metadata header; `null` omits it. */
    fetchSite?: string | null
  } = {},
): Promise<RawHttpResult> {
  const headers: Record<string, string> = { ...(options.headers ?? {}) }
  if (options.fetchSite === null) delete headers['sec-fetch-site']
  else if (options.fetchSite !== undefined) headers['sec-fetch-site'] = options.fetchSite
  else if (headers.cookie !== undefined && headers['sec-fetch-site'] === undefined) {
    // Browser-like default for the many cookie tests; tests that need to omit
    // the header pass `fetchSite: null`.
    headers['sec-fetch-site'] = 'same-origin'
  }
  return await new Promise((resolve, reject) => {
    const request = httpRequest(url, {
      method: options.method ?? 'GET',
      headers,
    }, (response) => {
      const chunks: Buffer[] = []
      response.on('data', chunk => chunks.push(Buffer.from(chunk)))
      response.on('end', () => {
        resolve({
          status: response.statusCode ?? 0,
          headers: response.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        })
      })
    })
    request.on('error', reject)
    request.end(options.body)
  })
}

interface WsHandshakeOptions {
  readonly origin?: string
  readonly headers?: Record<string, string>
}

/** Attempt a WebSocket handshake and resolve with the HTTP reject status. */
async function wsRejectStatus(url: string, options: WsHandshakeOptions = {}): Promise<number> {
  return await new Promise((resolve, reject) => {
    const socket = new WebSocket(url, options)
    const timer = setTimeout(() => {
      socket.terminate()
      reject(new Error('websocket handshake timed out'))
    }, 3_000)
    socket.once('unexpected-response', (_request, response) => {
      clearTimeout(timer)
      response.resume()
      const status = response.statusCode ?? 0
      socket.terminate()
      resolve(status)
    })
    socket.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    socket.once('open', () => {
      clearTimeout(timer)
      socket.close()
      reject(new Error('websocket unexpectedly opened'))
    })
  })
}

/** Raw WebSocket handshake: returns the `Sec-WebSocket-Protocol` response header. */
async function wsNegotiatedProtocol(
  url: string,
  protocols: readonly string[],
  origin: string,
): Promise<string | undefined> {
  return await new Promise((resolve, reject) => {
    const request = httpRequest(url, {
      headers: {
        connection: 'Upgrade',
        upgrade: 'websocket',
        'sec-websocket-key': randomBytes(16).toString('base64'),
        'sec-websocket-version': '13',
        'sec-websocket-protocol': protocols.join(', '),
        origin,
      },
    })
    const timer = setTimeout(() => {
      request.destroy()
      reject(new Error('websocket handshake timed out'))
    }, 3_000)
    request.on('upgrade', (response, socket) => {
      clearTimeout(timer)
      const protocol = response.headers['sec-websocket-protocol']
      socket.destroy()
      resolve(typeof protocol === 'string' ? protocol : undefined)
    })
    request.on('response', (response) => {
      clearTimeout(timer)
      response.resume()
      resolve(undefined)
    })
    request.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    request.end()
  })
}

interface FakeWsExchange {
  readonly exchange: WsExchangeResult
  readonly sent: Uint8Array[]
  readonly closes: Array<{ code?: number; reason?: string }>
  readonly aborts: string[]
  push(message: Uint8Array): void
  endInbound(): void
}

function fakeWsExchange(options: { protocol?: string } = {}): FakeWsExchange {
  const sent: Uint8Array[] = []
  const closes: Array<{ code?: number; reason?: string }> = []
  const aborts: string[] = []
  const queued: Uint8Array[] = []
  const waiters: Array<(result: IteratorResult<Uint8Array>) => void> = []
  let ended = false
  const finish = (): void => {
    ended = true
    for (const waiter of waiters.splice(0)) waiter({ value: undefined, done: true })
  }
  const messages = {
    messageBoundaries: true as const,
    [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
      return {
        next: () => {
          const value = queued.shift()
          if (value !== undefined) return Promise.resolve({ value, done: false })
          if (ended) return Promise.resolve({ value: undefined, done: true })
          return new Promise(resolve => waiters.push(resolve))
        },
        return: () => {
          finish()
          return Promise.resolve({ value: undefined, done: true })
        },
      }
    },
  }
  const exchange: WsExchangeResult = {
    ...(options.protocol === undefined ? {} : { protocol: options.protocol }),
    messages,
    sink: {
      write: async () => {},
      end: async () => {},
      abort: async (code: string) => {
        aborts.push(code)
        finish()
      },
      sendMessage: async (message: Uint8Array) => {
        sent.push(Buffer.from(message))
      },
      close: async (code?: number, reason?: string) => {
        closes.push({ ...(code !== undefined ? { code } : {}), ...(reason !== undefined ? { reason } : {}) })
        finish()
      },
    },
  }
  return {
    exchange,
    sent,
    closes,
    aborts,
    push: (message: Uint8Array) => {
      const waiter = waiters.shift()
      if (waiter !== undefined) waiter({ value: message, done: false })
      else queued.push(message)
    },
    endInbound: finish,
  }
}

describe('portal-controller: capability token and cookie', () => {
  it('trades the URL token for an HttpOnly cookie and serves the proxied page', async () => {
    const session = new FakeMeshSession({
      remote: fakeDescriptor(),
      http: async () => ({
        streamId: 7,
        status: 200,
        headers: {
          'content-type': 'text/html; charset=utf-8',
          'x-frame-options': 'DENY',
          'content-security-policy': "default-src 'self'; frame-ancestors 'none'; script-src 'self'",
          'set-cookie': 'dsh-auth-secret=leak',
          'x-keep': 'yes',
        },
        body: streamOf('remote-ui'),
      }),
    })
    const portal = await PortalController.open({
      session,
      deviceId: 'dm_device',
      token: 'fixed-capability-token',
      idleTimeoutMs: 60_000,
    })
    try {
      const first = await fetch(portal.url, { redirect: 'manual' })
      assert.equal(first.status, 303)
      assert.equal(first.headers.get('location'), '/')
      const setCookie = first.headers.getSetCookie()[0]
      assert.ok(setCookie)
      assert.match(setCookie, /HttpOnly/u)
      assert.match(setCookie, /SameSite=None/u)
      assert.match(setCookie, /Secure/u)

      const cookie = cookieFrom(first)
      const page = await fetch(`${portal.origin}/`, { headers: { cookie, 'sec-fetch-site': 'same-origin' } })
      assert.equal(page.status, 200)
      assert.equal(await page.text(), 'remote-ui')
      assert.equal(page.headers.get('x-frame-options'), null)
      assert.equal(page.headers.get('content-security-policy'), "default-src 'self'; script-src 'self'")
      assert.equal(page.headers.get('set-cookie'), null)
      assert.equal(page.headers.get('x-keep'), 'yes')

      const exchange = session.httpExchanges[0]
      assert.ok(exchange)
      assert.equal(exchange.params.method, 'GET')
      assert.equal(exchange.params.path, '/')
      assert.equal(exchange.params.headers['x-dsh-mesh-peer'], 'dm_device')
      // The daemon's DSH cookie never comes from the browser side.
      assert.equal(exchange.params.headers.cookie, undefined)
    } finally {
      await portal.close()
    }
  })

  it('serves a same-origin bootstrap for a cross-site capability-token entry', async () => {
    const session = new FakeMeshSession({
      remote: fakeDescriptor(),
      http: async () => ({
        streamId: 8,
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
        body: streamOf('remote-ui'),
      }),
    })
    const portal = await PortalController.open({
      session,
      deviceId: 'dm_device',
      token: 'fixed-capability-token',
      idleTimeoutMs: 60_000,
    })
    try {
      // A popup opened from another loopback origin is cross-site; a 303+
      // SameSite=None/Secure cookie must survive the cross-site frame.
      const first = await fetch(portal.url, {
        redirect: 'manual',
        headers: { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' },
      })
      assert.equal(first.status, 200)
      const body = await first.text()
      assert.match(body, /location\.replace\("\/"\)/u)
      const cookie = cookieFrom(first)
      assert.ok(cookie.length > 0)

      const page = await fetch(`${portal.origin}/`, {
        headers: { cookie, 'sec-fetch-site': 'same-origin' },
      })
      assert.equal(page.status, 200)
      assert.equal(await page.text(), 'remote-ui')
    } finally {
      await portal.close()
    }
  })

  it('serves immutable GUI assets from the disk cache on a later portal', async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), 'dm-portal-cache-'))
    try {
      const html = '<html><head><link rel="preload" href="plugins/??@deepseek-ai/dsh-api-gateway/client.js&amp;rev=abc"></head></html>'
      const session = new FakeMeshSession({
        http: async (params) => {
          if (params.path === '/') {
            return {
              streamId: 1,
              status: 200,
              headers: { 'content-type': 'text/html; charset=utf-8' },
              body: streamOf(html),
            }
          }
          return {
            streamId: 1,
            status: 200,
            headers: { 'content-type': 'text/javascript; charset=utf-8' },
            body: streamOf('cached-asset-body'),
          }
        },
      })
      const first = await PortalController.open({
        session,
        deviceId: 'dm_cache_device',
        token: 'cache-token-1',
        idleTimeoutMs: 60_000,
        cacheDir,
      })
      try {
        const login = await fetch(first.url, { redirect: 'manual' })
        const cookie = cookieFrom(login)
        const asset = await fetch(`${first.origin}/assets/app-abc123.js`, { headers: { cookie, 'sec-fetch-site': 'same-origin' } })
        assert.equal(asset.status, 200)
        assert.equal(await asset.text(), 'cached-asset-body')
      } finally {
        await first.close()
      }
      assert.equal(session.httpExchanges.length, 2, 'manifest + first asset')

      const second = await PortalController.open({
        session,
        deviceId: 'dm_cache_device',
        token: 'cache-token-2',
        idleTimeoutMs: 60_000,
        cacheDir,
      })
      try {
        const login = await fetch(second.url, { redirect: 'manual' })
        const cookie = cookieFrom(login)
        const hit = await fetch(`${second.origin}/assets/app-abc123.js`, { headers: { cookie, 'sec-fetch-site': 'same-origin' } })
        assert.equal(hit.status, 200)
        assert.equal(hit.headers.get('x-dm-cache'), 'hit')
        assert.equal(await hit.text(), 'cached-asset-body')
      } finally {
        await second.close()
      }
      assert.equal(session.httpExchanges.length, 3, 'the second portal only refetches the manifest')
    } finally {
      await rm(cacheDir, { recursive: true, force: true })
    }
  })

  it('hands an iframe auth failure to the parent shell', async () => {
    const portal = await PortalController.open({
      session: new FakeMeshSession(),
      deviceId: 'dm_device',
      token: 'iframe-token',
      idleTimeoutMs: 60_000,
    })
    try {
      const response = await fetch(`${portal.origin}/`, {
        redirect: 'manual',
        headers: { 'sec-fetch-dest': 'iframe', 'sec-fetch-site': 'cross-site' },
      })
      assert.equal(response.status, 403)
      assert.match(response.headers.get('content-type') ?? '', /text\/html/u)
      const body = await response.text()
      assert.match(body, /parent\.postMessage/u)
      assert.match(body, /auth-failed/u)
    } finally {
      await portal.close()
    }
  })

  it('rejects requests without the capability cookie or with a bad token', async () => {
    const session = new FakeMeshSession()
    const portal = await PortalController.open({
      session,
      deviceId: 'dm_device',
      token: 'right-token',
      idleTimeoutMs: 60_000,
    })
    try {
      const missing = await fetch(`${portal.origin}/`, { redirect: 'manual' })
      assert.equal(missing.status, 403)
      const wrong = await fetch(`${portal.origin}/?token=wrong-token`, { redirect: 'manual' })
      assert.equal(wrong.status, 403)
      const wrongCookie = await fetch(`${portal.origin}/`, {
        headers: { cookie: 'dsh-mesh-portal-whatever=right-token' },
        redirect: 'manual',
      })
      assert.equal(wrongCookie.status, 403)
      assert.equal(session.httpExchanges.length, 0)
    } finally {
      await portal.close()
    }
  })

  it('rejects methods outside the allowed set', async () => {
    const portal = await PortalController.open({
      session: new FakeMeshSession(),
      deviceId: 'dm_device',
      token: 'token',
      idleTimeoutMs: 60_000,
    })
    try {
      const first = await fetch(portal.url, { redirect: 'manual' })
      const cookie = cookieFrom(first)
      const status = await new Promise<number>((resolve, reject) => {
        const request = httpRequest(`${portal.origin}/`, { method: 'TRACE', headers: { cookie, 'sec-fetch-site': 'same-origin' } }, (response) => {
          response.resume()
          resolve(response.statusCode ?? 0)
        })
        request.on('error', reject)
        request.end()
      })
      assert.equal(status, 405)
    } finally {
      await portal.close()
    }
  })
})

describe('portal-controller: forwarding', () => {
  it('streams request bodies and responses through the fake session', async () => {
    const session = new FakeMeshSession({
      http: async _params => ({
        streamId: 3,
        status: 201,
        headers: { 'content-type': 'application/json', 'x-frame-options': 'SAMEORIGIN' },
        body: streamOf('{"saved":', 'true}'),
      }),
    })
    const portal = await PortalController.open({
      session,
      deviceId: 'dm_device',
      token: 'token',
      idleTimeoutMs: 60_000,
    })
    try {
      const first = await fetch(portal.url, { redirect: 'manual' })
      const cookie = cookieFrom(first)
      const response = await fetch(`${portal.origin}/api/save?x=1`, {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
        body: '{"value":42}',
      })
      assert.equal(response.status, 201)
      assert.equal(await response.text(), '{"saved":true}')
      assert.equal(response.headers.get('x-frame-options'), null)
      const exchange = session.httpExchanges[0]
      assert.ok(exchange)
      assert.equal(exchange.params.method, 'POST')
      assert.equal(exchange.params.path, '/api/save?x=1')
      assert.equal(exchange.body.toString('utf8'), '{"value":42}')
    } finally {
      await portal.close()
    }
  })

  it('caps request bodies', async () => {
    const session = new FakeMeshSession()
    const portal = await PortalController.open({
      session,
      deviceId: 'dm_device',
      token: 'token',
      maxBodyBytes: 8,
      idleTimeoutMs: 60_000,
    })
    try {
      const first = await fetch(portal.url, { redirect: 'manual' })
      const cookie = cookieFrom(first)
      const response = await fetch(`${portal.origin}/upload`, {
        method: 'POST',
        headers: { cookie, 'sec-fetch-site': 'same-origin' },
        body: '0123456789',
      })
      assert.equal(response.status, 413)
      assert.equal(session.httpExchanges.length, 0)
    } finally {
      await portal.close()
    }
  })

  it('limits concurrent streams', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const session = new FakeMeshSession({
      http: async () => {
        await gate
        return { streamId: 1, status: 200, headers: {}, body: streamOf('ok') }
      },
    })
    const portal = await PortalController.open({
      session,
      deviceId: 'dm_device',
      token: 'token',
      maxConcurrentStreams: 1,
      idleTimeoutMs: 60_000,
    })
    try {
      const first = await fetch(portal.url, { redirect: 'manual' })
      const cookie = cookieFrom(first)
      const pending = fetch(`${portal.origin}/slow`, { headers: { cookie, 'sec-fetch-site': 'same-origin' } })
      await waitFor(() => session.httpExchanges.length === 1)
      const busy = await fetch(`${portal.origin}/second`, { headers: { cookie, 'sec-fetch-site': 'same-origin' } })
      assert.equal(busy.status, 503)
      release()
      const done = await pending
      assert.equal(done.status, 200)
      assert.equal(await done.text(), 'ok')
    } finally {
      await portal.close()
    }
  })

  it('stops serving after close', async () => {
    const portal = await PortalController.open({
      session: new FakeMeshSession(),
      deviceId: 'dm_device',
      token: 'token',
      idleTimeoutMs: 60_000,
    })
    const url = portal.url
    await portal.close()
    assert.equal(portal.open, false)
    await assert.rejects(() => fetch(url, { redirect: 'manual' }))
  })
})

describe('portal-controller: websocket', () => {
  it('bridges browser WebSocket messages to the mesh session', async () => {
    const ws = fakeWsExchange()
    const session = new FakeMeshSession({
      ws: async () => ws.exchange,
    })
    const portal = await PortalController.open({
      session,
      deviceId: 'dm_device',
      token: 'token',
      idleTimeoutMs: 60_000,
    })
    const socket = new WebSocket(`ws://127.0.0.1:${portal.port}/api/remote.mux?token=token`, {
      origin: `http://127.0.0.1:${portal.port}`,
    })
    try {
      await new Promise<void>((resolve, reject) => {
        socket.once('open', () =>{  resolve() })
        socket.once('error', reject)
      })
      socket.send('hello-mesh')
      await waitFor(() => ws.sent.length === 1)
      // Browser text frames cross the Mesh with a text kind byte (C1).
      assert.deepEqual(Uint8Array.from(ws.sent[0] ?? []), encodeWsMessage(Buffer.from('hello-mesh'), 'text'))

      ws.push(encodeWsMessage(Buffer.from('remote-hello'), 'text'))
      const reply = await new Promise<{ data: unknown; isBinary: boolean }>((resolve, reject) => {
        const timer = setTimeout(() =>{  reject(new Error('no websocket message')) }, 2_000)
        socket.once('message', (data: unknown, isBinary: boolean) => {
          clearTimeout(timer)
          resolve({ data, isBinary })
        })
      })
      // The remote text frame must reach the browser as a text frame.
      assert.equal(reply.isBinary, false)
      assert.equal(Buffer.from(reply.data as Buffer).toString('utf8'), 'remote-hello')

      socket.close()
      await waitFor(() => ws.closes.length > 0)
      assert.equal(session.wsExchanges[0]?.path, '/api/remote.mux')
    } finally {
      socket.close()
      await portal.close()
    }
  })
})

describe('portal-controller: websocket subprotocol negotiation', () => {
  it('uses the subprotocol the remote selected instead of the first browser offer', async () => {
    const ws = fakeWsExchange({ protocol: 'b' })
    const session = new FakeMeshSession({ ws: async () => ws.exchange })
    const portal = await PortalController.open({
      session,
      deviceId: 'dm_device',
      token: 'token',
      idleTimeoutMs: 60_000,
    })
    const socket = new WebSocket(`ws://127.0.0.1:${portal.port}/api/remote.mux?token=token`, ['a', 'b'], {
      origin: portal.origin,
    })
    try {
      await new Promise<void>((resolve, reject) => {
        socket.once('open', () =>{  resolve() })
        socket.once('error', reject)
      })
      // `ws` would pick the browser's first offer ("a") without the fix (M1).
      assert.equal(socket.protocol, 'b')
      assert.deepEqual(session.wsExchanges[0]?.protocols, ['a', 'b'])
    } finally {
      socket.close()
      await portal.close()
    }
  })

  it('negotiates nothing when the remote selected nothing or an unoffered protocol', async () => {
    for (const options of [{}, { protocol: 'c' }]) {
      const ws = fakeWsExchange(options)
      const session = new FakeMeshSession({ ws: async () => ws.exchange })
      const portal = await PortalController.open({
        session,
        deviceId: 'dm_device',
        token: 'token',
        idleTimeoutMs: 60_000,
      })
      try {
        // A raw handshake is used because the `ws` client itself rejects a 101
        // that answers "no subprotocol" while protocols were offered.
        assert.equal(
          await wsNegotiatedProtocol(
            `http://127.0.0.1:${portal.port}/api/remote.mux?token=token`,
            ['a', 'b'],
            portal.origin,
          ),
          undefined,
        )
      } finally {
        await portal.close()
      }
    }
  })
})

describe('portal-controller: websocket lifecycle', () => {
  it('counts websockets against the concurrency cap and releases the slot on close', async () => {
    const ws = fakeWsExchange()
    const session = new FakeMeshSession({ ws: async () => ws.exchange })
    const portal = await PortalController.open({
      session,
      deviceId: 'dm_device',
      token: 'token',
      maxConcurrentStreams: 1,
      idleTimeoutMs: 60_000,
    })
    const cookie = cookieFrom(await fetch(portal.url, { redirect: 'manual' }))
    const socket = new WebSocket(`ws://127.0.0.1:${portal.port}/api/remote.mux?token=token`, {
      origin: portal.origin,
    })
    try {
      await new Promise<void>((resolve, reject) => {
        socket.once('open', () =>{  resolve() })
        socket.once('error', reject)
      })
      assert.equal(portal.status().activeStreams, 1)

      const busy = await fetch(`${portal.origin}/blocked`, { headers: { cookie, 'sec-fetch-site': 'same-origin' } })
      assert.equal(busy.status, 503)

      socket.close()
      await waitFor(() => portal.status().activeStreams === 0)
      const allowed = await fetch(`${portal.origin}/allowed`, { headers: { cookie, 'sec-fetch-site': 'same-origin' } })
      assert.equal(allowed.status, 200)
      await allowed.arrayBuffer()
    } finally {
      socket.close()
      await portal.close()
    }
  })

  it('aborts the mesh exchange when the browser disappears during the upgrade', async () => {
    let releaseGate!: () => void
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve
    })
    const ws = fakeWsExchange()
    const session = new FakeMeshSession({
      ws: async () => {
        await gate
        return ws.exchange
      },
    })
    const portal = await PortalController.open({
      session,
      deviceId: 'dm_device',
      token: 'token',
      idleTimeoutMs: 60_000,
    })
    const socket = new WebSocket(`ws://127.0.0.1:${portal.port}/api/remote.mux?token=token`, {
      origin: portal.origin,
    })
    socket.on('error', () => {})
    try {
      await waitFor(() => session.wsExchanges.length === 1)
      socket.terminate()
      // Let the portal observe the browser-side TCP close before the exchange
      // becomes available.
      await new Promise(resolve => setTimeout(resolve, 100))
      releaseGate()
      await waitFor(() => ws.aborts.length > 0)
      assert.equal(portal.status().activeStreams, 0)
    } finally {
      socket.terminate()
      await portal.close()
    }
  })
})

describe('portal-controller: loopback request validation', () => {
  it('rejects a Host that is not this portal authority', async () => {
    const session = new FakeMeshSession()
    const portal = await PortalController.open({
      session,
      deviceId: 'dm_device',
      token: 'token',
      idleTimeoutMs: 60_000,
    })
    try {
      const cookie = cookieFrom(await fetch(portal.url, { redirect: 'manual' }))
      const mismatched = await rawHttp(`${portal.origin}/`, {
        headers: { cookie, host: '127.0.0.1:1' },
      })
      assert.equal(mismatched.status, 403)
      assert.equal(mismatched.headers['cache-control'], 'no-store')
      assert.equal(session.httpExchanges.length, 0)

      const status = await wsRejectStatus(`ws://127.0.0.1:${portal.port}/api/remote.mux`, {
        origin: portal.origin,
        headers: { host: '127.0.0.1:1' },
      })
      assert.equal(status, 403)
      assert.equal(session.wsExchanges.length, 0)
    } finally {
      await portal.close()
    }
  })

  it('rejects a WebSocket handshake without the exact portal Origin', async () => {
    const session = new FakeMeshSession({
      ws: async () => {
        throw new Error('remote must not be reached')
      },
    })
    const portal = await PortalController.open({
      session,
      deviceId: 'dm_device',
      token: 'token',
      idleTimeoutMs: 60_000,
    })
    try {
      const url = `ws://127.0.0.1:${portal.port}/api/remote.mux?token=token`
      const crossPortOrigin = `http://127.0.0.1:${portal.port + 1}`
      assert.equal(await wsRejectStatus(url, { origin: crossPortOrigin }), 403)
      assert.equal(await wsRejectStatus(url), 403)
      assert.equal(await wsRejectStatus(url, { origin: 'null' }), 403)
      assert.equal(session.wsExchanges.length, 0)
    } finally {
      await portal.close()
    }
  })

  it('rejects cross-port or missing Fetch Metadata and bad Origin on HTTP', async () => {
    const session = new FakeMeshSession()
    const portal = await PortalController.open({
      session,
      deviceId: 'dm_device',
      token: 'token',
      idleTimeoutMs: 60_000,
    })
    try {
      const cookie = cookieFrom(await fetch(portal.url, { redirect: 'manual' }))
      for (const site of ['same-site', 'cross-site']) {
        const response = await rawHttp(`${portal.origin}/`, {
          headers: { cookie, 'sec-fetch-site': site },
        })
        assert.equal(response.status, 403)
        assert.equal(response.headers['cache-control'], 'no-store')
      }
      const crossPortOrigin = `http://127.0.0.1:${portal.port + 1}`
      const crossOrigin = await rawHttp(`${portal.origin}/`, {
        headers: { cookie, origin: crossPortOrigin },
      })
      assert.equal(crossOrigin.status, 403)
      assert.equal(session.httpExchanges.length, 0)

      // A browser must send Fetch Metadata for a cookie-authenticated request;
      // an absent header is rejected rather than treated as a browser read.
      const unmarked = await rawHttp(`${portal.origin}/`, { headers: { cookie }, fetchSite: null })
      assert.equal(unmarked.status, 403)
      // An address-bar navigation is `none`, and a same-origin page request is
      // `same-origin`; both are allowed.
      const navigation = await fetch(`${portal.origin}/`, { headers: { cookie, 'sec-fetch-site': 'none' } })
      assert.equal(navigation.status, 200)
      // `Sec-Fetch-Site: none` (address-bar navigation) is allowed too.
      const typed = await rawHttp(`${portal.origin}/`, {
        headers: { cookie, 'sec-fetch-site': 'none' },
      })
      assert.equal(typed.status, 200)
      // Same-origin browser requests are allowed.
      const sameOrigin = await rawHttp(`${portal.origin}/`, {
        headers: { cookie, origin: portal.origin, 'sec-fetch-site': 'same-origin' },
      })
      assert.equal(sameOrigin.status, 200)
    } finally {
      await portal.close()
    }
  })

  it('never forwards the capability token in HTTP or WebSocket paths', async () => {
    const ws = fakeWsExchange()
    const session = new FakeMeshSession({
      ws: async () => ws.exchange,
      http: async () => ({ streamId: 2, status: 200, headers: {}, body: streamOf('ok') }),
    })
    const portal = await PortalController.open({
      session,
      deviceId: 'dm_device',
      token: 'token',
      idleTimeoutMs: 60_000,
    })
    try {
      const cookie = cookieFrom(await fetch(portal.url, { redirect: 'manual' }))
      const post = await fetch(`${portal.origin}/api/save?token=token&x=1`, {
        method: 'POST',
        headers: { cookie, 'sec-fetch-site': 'same-origin' },
        body: 'payload',
      })
      assert.equal(post.status, 200)
      assert.equal(await post.text(), 'ok')
      assert.equal(session.httpExchanges[0]?.params.path, '/api/save?x=1')

      const socket = new WebSocket(
        `ws://127.0.0.1:${portal.port}/api/remote.mux?token=token&x=1`,
        { origin: portal.origin },
      )
      try {
        await new Promise<void>((resolve, reject) => {
          socket.once('open', () =>{  resolve() })
          socket.once('error', reject)
        })
        assert.equal(session.wsExchanges[0]?.path, '/api/remote.mux?x=1')
      } finally {
        socket.close()
      }
    } finally {
      await portal.close()
    }
  })

  it('drops malformed upstream response headers instead of failing the response', async () => {
    const session = new FakeMeshSession({
      http: async () => ({
        streamId: 5,
        status: 200,
        headers: {
          'content-type': 'text/plain; charset=utf-8',
          'x-good': 'ok',
          'bad header': 'nope',
          'x-crlf': 'a\r\nb',
          'x-big': 'a'.repeat(9_000),
        },
        body: streamOf('sanitized'),
      }),
    })
    const portal = await PortalController.open({
      session,
      deviceId: 'dm_device',
      token: 'token',
      idleTimeoutMs: 60_000,
    })
    try {
      const cookie = cookieFrom(await fetch(portal.url, { redirect: 'manual' }))
      const response = await rawHttp(`${portal.origin}/headers`, { headers: { cookie, 'sec-fetch-site': 'same-origin' } })
      assert.equal(response.status, 200)
      assert.equal(response.body, 'sanitized')
      assert.equal(response.headers['x-good'], 'ok')
      assert.equal(response.headers['bad header'], undefined)
      assert.equal(response.headers['x-crlf'], undefined)
      assert.equal(response.headers['x-big'], undefined)
    } finally {
      await portal.close()
    }
  })

  it('maps an out-of-range upstream status to 502', async () => {
    const session = new FakeMeshSession({
      http: async () => ({ streamId: 6, status: 99, headers: {}, body: streamOf('') }),
    })
    const portal = await PortalController.open({
      session,
      deviceId: 'dm_device',
      token: 'token',
      idleTimeoutMs: 60_000,
    })
    try {
      const cookie = cookieFrom(await fetch(portal.url, { redirect: 'manual' }))
      const response = await fetch(`${portal.origin}/bad-status`, { headers: { cookie, 'sec-fetch-site': 'same-origin' } })
      assert.equal(response.status, 502)
      await response.arrayBuffer()
    } finally {
      await portal.close()
    }
  })
})

describe('portal-controller: header helpers', () => {
  it('strips frame-ancestors but keeps other CSP directives', () => {
    assert.equal(
      stripFrameAncestorsDirective("default-src 'self'; frame-ancestors 'none'; img-src data:"),
      "default-src 'self'; img-src data:",
    )
    const headers = sanitizeControllerResponseHeaders({
      'x-frame-options': 'DENY',
      'content-security-policy': "default-src 'self'; frame-ancestors *",
      'content-security-policy-report-only': 'frame-ancestors *',
      'set-cookie': 'a=b',
      'transfer-encoding': 'chunked',
      'x-ok': '1',
    })
    assert.equal(headers['x-frame-options'], undefined)
    assert.equal(headers['content-security-policy'], "default-src 'self'")
    assert.equal(headers['content-security-policy-report-only'], undefined)
    assert.equal(headers['set-cookie'], undefined)
    assert.equal(headers['transfer-encoding'], undefined)
    assert.equal(headers['x-ok'], '1')
  })

  it('drops malformed, oversized and excess response headers', () => {
    const input: Record<string, string> = {
      'x-ok': '1',
      'bad name': 'x',
      'x-crlf': 'a\r\nb',
      'x-big': 'a'.repeat(8_193),
    }
    for (let index = 0; index < 80; index += 1) input[`x-h-${index}`] = 'v'
    const headers = sanitizeControllerResponseHeaders(input)
    assert.equal(headers['x-ok'], '1')
    assert.equal(headers['bad name'], undefined)
    assert.equal(headers['x-crlf'], undefined)
    assert.equal(headers['x-big'], undefined)
    assert.equal(Object.keys(headers).length, 64)
  })

  it('filters browser headers and adds provenance markers', () => {
    const headers = sanitizeControllerRequestHeaders({
      host: '127.0.0.1:9999',
      cookie: 'browser-cookie=1',
      origin: 'http://127.0.0.1:9999',
      'sec-fetch-site': 'cross-site',
      'user-agent': 'test',
      accept: 'text/html',
      'x-forwarded-for': '1.2.3.4',
      'x-custom': 'keep',
    }, 'dm_device')
    assert.equal(headers.host, undefined)
    assert.equal(headers.cookie, undefined)
    assert.equal(headers.origin, undefined)
    assert.equal(headers['sec-fetch-site'], undefined)
    assert.equal(headers['x-forwarded-for'], undefined)
    assert.equal(headers['user-agent'], 'test')
    assert.equal(headers.accept, 'text/html')
    assert.equal(headers['x-custom'], 'keep')
    assert.equal(headers['x-dsh-mesh-peer'], 'dm_device')
    assert.equal(headers['x-dsh-mesh-version'], '1')
  })

  it('escapes a peer-controlled session id inside the injected script (S3)', () => {
    const html = '<!doctype html><html><head></head><body>remote</body></html>'
    const injected = injectEmbedShell(html, '</script><script>alert(1)</script>')
    assert.equal(injected.includes('</script><script>alert(1)</script>'), false)
    assert.ok(injected.includes('\\u003c/script\\u003e'), 'the closing tag must stay data')
    assert.ok(injected.includes("dataset.dmEmbed='1'"))
    assert.ok(injected.indexOf('dm-embed-shell') < injected.indexOf('</head>'))
  })

  it('caps manifest reads and survives oversized bodies (S5)', async () => {
    assert.equal(await readLimitedText(streamOf('a', 'b'), 16, 1_000), 'ab')
    assert.equal(await readLimitedText(streamOf('a'.repeat(64)), 16, 1_000), undefined)
    async function* slow(): AsyncGenerator<Uint8Array> {
      await new Promise(() => {})
    }
    assert.equal(await readLimitedText(slow(), 16, 20), undefined)
  })

  it('collects streamed bodies', async () => {
    assert.equal((await collect(streamOf('a', 'b'))).toString('utf8'), 'ab')
  })
})
