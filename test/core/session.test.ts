/**
 * Session multiplexer tests: RPC, events, ping/pong, HTTP & WS portal streams,
 * framing, backpressure, stream limits and exception isolation.
 *
 * These tests wire two `MeshSession`s directly through `helpers/local-pair.ts`
 * (no Noise); `channel.test.ts` covers the encrypted transport end to end.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { encodeUtf8 } from '../../src/shared/protocol.ts'
import type { DeviceDescriptor, MeshInfo, PortalHttpParams, PortalWsParams } from '../../src/shared/protocol.ts'
import { MeshRpcError, decodeWsMessage, encodeWsMessage } from '../../src/shared/mesh-session.ts'
import type { ChunkStream, DaemonSessionHandlers, StreamSink } from '../../src/shared/mesh-session.ts'
import { createLocalSessionPair } from './helpers/local-pair.ts'
import type { LocalSessionPair } from './helpers/local-pair.ts'
import { delay, flushAsync } from './helpers/memory-transport.ts'

// ---------------------------------------------------------------------------
// Fixtures and helpers
// ---------------------------------------------------------------------------

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
const INFO: MeshInfo = {
  device: { ...DAEMON, appVersion: 'test' },
  protocol: 1,
  capabilities: ['rpc', 'portal'],
  hostLabel: 'test-daemon',
}

function bytes(text: string): Uint8Array {
  return encodeUtf8(text)
}

function decode(chunk: Uint8Array): string {
  return new TextDecoder().decode(chunk)
}

async function collect(stream: AsyncIterable<Uint8Array>): Promise<Uint8Array[]> {
  const chunks: Uint8Array[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

function streamFrame(streamId: number, flags: number, payload: Uint8Array = new Uint8Array(0)): Uint8Array {
  const frame = new Uint8Array(6 + payload.length)
  frame[0] = 0x11
  new DataView(frame.buffer).setUint32(1, streamId)
  frame[5] = flags
  frame.set(payload, 6)
  return frame
}

function iterableOf(chunks: readonly Uint8Array[]): ChunkStream {
  return (async function* generate(): AsyncGenerator<Uint8Array> {
    for (const chunk of chunks) yield chunk
  })()
}

function makeHandlers(overrides: Partial<DaemonSessionHandlers> = {}): DaemonSessionHandlers {
  return {
    rpc: async (method, params) => {
      switch (method) {
        case 'info':
          return INFO
        case 'echo':
          return { method, params }
        case 'fail':
          throw new MeshRpcError('mesh/not-found', 'nothing here')
        case 'boom':
          throw new Error('secret internal detail')
        case 'portal-ish':
          throw { code: 'portal/unavailable', message: 'no portal' }
        case 'large-ok':
          return 'x'.repeat(60 * 1024)
        case 'large':
          return 'x'.repeat(70 * 1024)
        case 'never':
          return new Promise<never>(() => {})
        default:
          throw new MeshRpcError('mesh/not-found', 'unknown method')
      }
    },
    http: async () => ({ status: 200, headers: {}, body: iterableOf([]) }),
    ws: async () => ({ protocol: 'test', inbound: iterableOf([]), outbound: nullSink() }),
    ...overrides,
  }
}

function nullSink(): StreamSink {
  return {
    write: async () => undefined,
    end: async () => undefined,
    abort: async () => undefined,
  }
}

function createPair(options: {
  readonly handlers?: DaemonSessionHandlers
  readonly controllerSession?: Parameters<typeof createLocalSessionPair>[0]['session']
  readonly daemonSession?: Parameters<typeof createLocalSessionPair>[1]['session']
  readonly daemonSendFilter?: ((frame: Uint8Array) => Uint8Array | null) | undefined
} = {}): LocalSessionPair {
  return createLocalSessionPair(
    {
      remote: DAEMON,
      sas: '123-456',
      pairing: { approval: 'none' },
      session: { rpcTimeoutMs: 500, ...options.controllerSession },
    },
    {
      remote: CONTROLLER,
      sas: '123-456',
      pairing: { approval: 'none' },
      sendFilter: options.daemonSendFilter,
      session: { rpcTimeoutMs: 500, handlers: options.handlers ?? makeHandlers(), ...options.daemonSession },
    },
  )
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('waitFor timed out')
    await delay(2)
  }
}

// ---------------------------------------------------------------------------
// RPC
// ---------------------------------------------------------------------------

test('RPC round-trip, error mapping and handler isolation', async () => {
  const pair = createPair()
  const { sessionA, sessionB } = pair
  try {
    assert.deepEqual(await sessionA.rpc('echo', { a: 1 }), { method: 'echo', params: { a: 1 } })

    await assert.rejects(sessionA.rpc('fail'), (error: unknown) => {
      return error instanceof MeshRpcError && error.code === 'mesh/not-found'
    })
    // A plain handler error must not leak internals or close the session.
    await assert.rejects(sessionA.rpc('boom'), (error: unknown) => {
      return error instanceof MeshRpcError && error.code === 'mesh/internal' && !error.message.includes('secret')
    })
    // Errors that already look like a Mesh code keep their code.
    await assert.rejects(sessionA.rpc('portal-ish'), (error: unknown) => {
      return error instanceof MeshRpcError && error.code === 'portal/unavailable'
    })
    // The session is still healthy after three handler failures.
    assert.equal(sessionA.open, true)
    assert.deepEqual(await sessionA.rpc('echo'), { method: 'echo' })

    // Daemon sessions cannot originate RPC/portal calls.
    await assert.rejects(sessionB.rpc('echo'), (error: unknown) => {
      return error instanceof MeshRpcError && error.code === 'mesh/unsupported'
    })
    await assert.rejects(sessionB.http({ method: 'GET', path: '/', headers: {} }), (error: unknown) => {
      return error instanceof MeshRpcError && error.code === 'mesh/unsupported'
    })
    await assert.rejects(sessionB.ws({ path: '/', headers: {} }), (error: unknown) => {
      return error instanceof MeshRpcError && error.code === 'mesh/unsupported'
    })
  } finally {
    sessionA.close()
    sessionB.close()
  }
})

test('info RPC updates MeshSession.info', async () => {
  const pair = createPair()
  try {
    const before = pair.sessionA.info
    assert.equal(before, undefined)
    const info = await pair.sessionA.rpc<MeshInfo>('info')
    assert.equal(info.hostLabel, 'test-daemon')
    const after = pair.sessionA.info
    assert.equal(after?.device.deviceId, DAEMON.deviceId)
  } finally {
    pair.sessionA.close()
    pair.sessionB.close()
  }
})

test('RPC timeout, AbortSignal and ping timeout keep the session usable', async () => {
  const pair = createPair({ controllerSession: { rpcTimeoutMs: 60 } })
  const { sessionA } = pair
  try {
    const started = Date.now()
    await assert.rejects(sessionA.rpc('never'), (error: unknown) => {
      return error instanceof MeshRpcError && error.message === 'RPC timed out'
    })
    assert.ok(Date.now() - started >= 40)
    assert.equal(sessionA.open, true)

    const controller = new AbortController()
    const aborted = sessionA.rpc('never', {}, { signal: controller.signal })
    setTimeout(() =>{  controller.abort() }, 10)
    await assert.rejects(aborted, (error: unknown) => {
      return error instanceof MeshRpcError && error.message === 'request aborted'
    })

    // Application ping works both ways and times out against a silent peer.
    assert.equal(await sessionA.ping(300), 1)
    assert.equal(await pair.sessionB.ping(300), 1)

    const silent = createPair({
      daemonSendFilter: (frame) => {
        if (frame[0] !== 0x10) return frame
        try {
          const message = JSON.parse(new TextDecoder().decode(frame.subarray(1))) as Record<string, unknown>
          if (typeof message.pong === 'number') return null
        } catch {
          // keep non-JSON frames
        }
        return frame
      },
    })
    try {
      await assert.rejects(silent.sessionA.ping(40), /ping timed out/u)
      assert.equal(silent.sessionA.open, true)
    } finally {
      silent.sessionA.close()
      silent.sessionB.close()
    }
    assert.deepEqual(await sessionA.rpc('echo'), { method: 'echo' })
  } finally {
    sessionA.close()
    pair.sessionB.close()
  }
})

test('events are delivered and isolated from throwing listeners', async () => {
  const pair = createPair()
  const received: unknown[] = []
  try {
    pair.sessionA.onEvent(() => {
      throw new Error('bad listener')
    })
    const unsubscribe = pair.sessionA.onEvent(event => received.push(event))
    pair.sessionB.emit('workspaces.changed', { updatedAt: 'now' })
    await flushAsync()
    assert.deepEqual(received, [{ event: 'workspaces.changed', data: { updatedAt: 'now' } }])
    unsubscribe()
    pair.sessionB.emit('workspaces.changed', { updatedAt: 'later' })
    await flushAsync()
    assert.equal(received.length, 1)
    // Controller emits are a no-op (events are daemon → controller only in v1).
    pair.sessionA.emit('should.not.appear')
    await flushAsync()
    assert.equal(received.length, 1)
  } finally {
    pair.sessionA.close()
    pair.sessionB.close()
  }
})

// ---------------------------------------------------------------------------
// HTTP portal streams
// ---------------------------------------------------------------------------

test('portal.http carries request body, headers and a chunked response body', async () => {
  let seenParams: Omit<PortalHttpParams, 'streamId'> | undefined
  let seenBody: Uint8Array[] = []
  const pair = createPair({
    handlers: makeHandlers({
      http: async (params, body) => {
        seenParams = params
        seenBody = await collect(body)
        return {
          status: 201,
          headers: { 'x-test': 'yes', 'content-type': 'text/plain' },
          body: iterableOf([bytes('hello '), bytes('world')]),
        }
      },
    }),
  })
  try {
    const response = await pair.sessionA.http(
      { method: 'POST', path: '/api/test?q=1', headers: { accept: '*/*' } },
      iterableOf([bytes('abc'), bytes('def')]),
    )
    assert.equal(response.status, 201)
    assert.deepEqual(response.headers, { 'x-test': 'yes', 'content-type': 'text/plain' })
    assert.equal((response.streamId & 1), 1, 'controller stream ids are odd')
    assert.equal(seenParams?.method, 'POST')
    assert.equal(seenParams?.path, '/api/test?q=1')
    assert.deepEqual(seenParams?.headers, { accept: '*/*' })
    const body = await collect(response.body)
    assert.equal(body.map(decode).join(''), 'hello world')
    assert.equal(seenBody.map(decode).join(''), 'abcdef')
  } finally {
    pair.sessionA.close()
    pair.sessionB.close()
  }
})

test('portal.http splits large chunks into <=32 KiB stream frames', async () => {
  const bigRequest = new Uint8Array(100 * 1024).fill(0x41)
  const bigResponse = new Uint8Array(100 * 1024).fill(0x42)
  let requestChunkSizes: number[] = []
  let totalRequest = 0
  const pair = createPair({
    handlers: makeHandlers({
      http: async (_params, body) => {
        requestChunkSizes = []
        totalRequest = 0
        for await (const chunk of body) {
          requestChunkSizes.push(chunk.length)
          totalRequest += chunk.length
        }
        return { status: 200, headers: {}, body: iterableOf([bigResponse]) }
      },
    }),
  })
  try {
    const response = await pair.sessionA.http({ method: 'PUT', path: '/big', headers: {} }, iterableOf([bigRequest]))
    const responseChunks = await collect(response.body)
    assert.equal(requestChunkSizes.reduce((sum, size) => sum + size, 0), bigRequest.length)
    for (const size of requestChunkSizes) assert.ok(size <= 32 * 1024, `request chunk ${size} > 32 KiB`)
    assert.equal(totalRequest, bigRequest.length)
    assert.equal(responseChunks.reduce((sum, chunk) => sum + chunk.length, 0), bigResponse.length)
    for (const chunk of responseChunks) assert.ok(chunk.length <= 32 * 1024, `response chunk ${chunk.length} > 32 KiB`)
  } finally {
    pair.sessionA.close()
    pair.sessionB.close()
  }
})

test('portal.http upstream error is surfaced as an RPC failure', async () => {
  const pair = createPair({
    handlers: makeHandlers({
      http: async () => {
        throw new MeshRpcError('portal/unavailable', 'local web server is not ready')
      },
    }),
  })
  try {
    await assert.rejects(pair.sessionA.http({ method: 'GET', path: '/', headers: {} }), (error: unknown) => {
      return error instanceof MeshRpcError && error.code === 'portal/unavailable'
    })
    assert.equal(pair.sessionA.open, true)
    assert.deepEqual(await pair.sessionA.rpc('echo'), { method: 'echo' })
  } finally {
    pair.sessionA.close()
    pair.sessionB.close()
  }
})

test('oversized RPC results fail with mesh/busy instead of a timeout', async () => {
  const pair = createPair({ controllerSession: { rpcTimeoutMs: 5_000 } })
  try {
    // A 60 KiB result still fits in one sealed control message.
    const fits = await pair.sessionA.rpc<string>('large-ok')
    assert.equal(fits.length, 60 * 1024)

    const started = Date.now()
    await assert.rejects(pair.sessionA.rpc('large'), (error: unknown) => {
      return error instanceof MeshRpcError
        && error.code === 'mesh/busy'
        && /too large/u.test(error.message)
    })
    assert.ok(Date.now() - started < 2_000, 'the caller must not wait for the 30 s RPC timeout')
    // The session survives an oversized result and keeps serving RPCs.
    assert.equal(pair.sessionA.open, true)
    assert.equal(pair.sessionB.open, true)
    assert.deepEqual(await pair.sessionA.rpc('echo', { a: 1 }), { method: 'echo', params: { a: 1 } })
  } finally {
    pair.sessionA.close()
    pair.sessionB.close()
  }
})

test('portal.http stops consuming the request body after the RPC fails', async () => {
  let pulled = 0
  const body: ChunkStream = (async function* generate(): AsyncGenerator<Uint8Array> {
    for (let index = 0; index < 200; index += 1) {
      pulled += 1
      yield new Uint8Array(1024).fill(1)
    }
  })()
  const pair = createPair({
    handlers: makeHandlers({
      http: async () => {
        throw new MeshRpcError('mesh/busy', 'too many concurrent streams')
      },
    }),
  })
  try {
    await assert.rejects(
      pair.sessionA.http({ method: 'POST', path: '/upload', headers: {} }, body),
      (error: unknown) => error instanceof MeshRpcError && error.code === 'mesh/busy',
    )
    await flushAsync(10)
    // Before the fix the pump kept reading and sending all 200 chunks after
    // the RPC had already failed (M14).
    assert.ok(pulled < 200, `request body kept being pulled: ${pulled} chunks`)
    assert.ok(pulled <= 20, `request body was not stopped promptly: ${pulled} chunks`)
    assert.equal(pair.sessionA.open, true)
    assert.deepEqual(await pair.sessionA.rpc('echo'), { method: 'echo' })
  } finally {
    pair.sessionA.close()
    pair.sessionB.close()
  }
})

// ---------------------------------------------------------------------------
// WebSocket portal streams
// ---------------------------------------------------------------------------

interface ControllableWs {
  readonly handlers: DaemonSessionHandlers
  readonly params: () => Omit<PortalWsParams, 'streamId'> | undefined
  push(message: Uint8Array): void
  endInbound(): void
  readonly outboundMessages: Uint8Array[]
  readonly outboundEnded: () => boolean
  readonly outboundAborted: string[]
}

function controllableWs(options: { compressed?: boolean } = {}): ControllableWs {
  const queue: Uint8Array[] = []
  const waiters: Array<(result: IteratorResult<Uint8Array>) => void> = []
  const outboundMessages: Uint8Array[] = []
  const outboundAborted: string[] = []
  let ended = false
  let outboundDone = false
  let requestParams: Omit<PortalWsParams, 'streamId'> | undefined
  const inbound: ChunkStream = {
    [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
      return {
        next: () => {
          if (queue.length > 0) return Promise.resolve({ value: queue.shift() as Uint8Array, done: false })
          if (ended) return Promise.resolve({ value: undefined, done: true })
          return new Promise<IteratorResult<Uint8Array>>((resolve) => {
            waiters.push(resolve)
          })
        },
        return: () => {
          ended = true
          while (waiters.length > 0) waiters.shift()?.({ value: undefined, done: true })
          return Promise.resolve({ value: undefined, done: true })
        },
      }
    },
  }
  const sink: StreamSink = {
    write: async (chunk) => {
      outboundMessages.push(new Uint8Array(chunk))
    },
    end: async () => {
      outboundDone = true
    },
    abort: async (code) => {
      outboundAborted.push(code)
    },
  }
  const handlers = makeHandlers({
    ws: async (params) => {
      requestParams = params
      return {
        protocol: 'dsh-test',
        ...(options.compressed === true ? { compressed: true } : {}),
        inbound,
        outbound: sink,
      }
    },
  })
  return {
    handlers,
    params: () => requestParams,
    push: (message) => {
      const copy = new Uint8Array(message)
      const waiter = waiters.shift()
      if (waiter) waiter({ value: copy, done: false })
      else queue.push(copy)
    },
    endInbound: () => {
      ended = true
      while (waiters.length > 0) waiters.shift()?.({ value: undefined, done: true })
    },
    outboundMessages,
    outboundEnded: () => outboundDone,
    outboundAborted,
  }
}

test('portal.ws relays messages both ways with message boundaries preserved', async () => {
  const ws = controllableWs()
  const pair = createPair({ handlers: ws.handlers })
  try {
    const exchange = await pair.sessionA.ws({ path: '/ws', headers: { origin: 'http://localhost' }, protocols: ['dsh'] })
    assert.equal(exchange.protocol, 'dsh-test')
    await waitFor(() => ws.params() !== undefined)
    assert.equal(ws.params()?.path, '/ws')
    assert.deepEqual(ws.params()?.protocols, ['dsh'])
    assert.ok((exchange as unknown as { streamId?: number }).streamId === undefined)

    // daemon → controller: three messages including an empty one and a large
    // message that must be split into several <=32 KiB frames internally.
    const large = new Uint8Array(70 * 1024).fill(7)
    ws.push(bytes('first'))
    ws.push(new Uint8Array(0))
    ws.push(large)
    const messages: Uint8Array[] = []
    const iterator = exchange.messages[Symbol.asyncIterator]()
    for (let index = 0; index < 3; index += 1) {
      const result = await iterator.next()
      assert.equal(result.done, false)
      messages.push(result.value)
    }
    assert.equal(decode(messages[0] as Uint8Array), 'first')
    assert.equal((messages[1] as Uint8Array).length, 0)
    assert.deepEqual(messages[2], large)
    // Message boundaries are visible as a marker on the stream object.
    const streaming = iterator.next()
    streaming.catch(() => undefined)

    // controller → daemon: each sendMessage is exactly one WebSocket message,
    // tagged with its text/binary kind (C1).
    await exchange.sink.sendMessage(encodeWsMessage(bytes('client-one'), 'text'))
    await exchange.sink.sendMessage(encodeWsMessage(new Uint8Array(0), 'text'))
    const largeClient = encodeWsMessage(new Uint8Array(70 * 1024).fill(9), 'binary')
    await exchange.sink.sendMessage(largeClient)
    await waitFor(() => ws.outboundMessages.length === 3)
    assert.deepEqual(ws.outboundMessages[0], encodeWsMessage(bytes('client-one'), 'text'))
    assert.deepEqual(ws.outboundMessages[1], Uint8Array.of(0))
    assert.deepEqual(ws.outboundMessages[2], largeClient)
    const decodedClient = decodeWsMessage(ws.outboundMessages[2])
    assert.equal(decodedClient.kind, 'binary')
    assert.deepEqual(decodedClient.payload, new Uint8Array(70 * 1024).fill(9))
    void streaming

    // Closing the controller side ends the daemon-side sink.
    await exchange.sink.close(1000, 'bye')
    await waitFor(() => ws.outboundEnded())
    ws.endInbound()
    await flushAsync()
    assert.equal(pair.sessionA.open, true)
  } finally {
    pair.sessionA.close()
    pair.sessionB.close()
  }
})

test('portal.ws propagates compression negotiation and flags', async () => {
  const ws = controllableWs({ compressed: true })
  const pair = createPair({ handlers: ws.handlers })
  try {
    const exchange = await pair.sessionA.ws({ path: '/ws', headers: {}, compress: true })
    assert.equal(exchange.compressed, true)
    await waitFor(() => ws.params() !== undefined)
    assert.equal(ws.params()?.compress, true, 'the controller request carries the opt-in')

    const compressedInbound = encodeWsMessage(Uint8Array.of(1, 2, 3), 'text', true)
    ws.push(compressedInbound)
    const result = await exchange.messages[Symbol.asyncIterator]().next()
    assert.deepEqual(result.value, compressedInbound)
    assert.equal(decodeWsMessage(result.value).compressed, true)

    await exchange.sink.sendMessage(compressedInbound)
    await waitFor(() => ws.outboundMessages.length === 1)
    assert.deepEqual(ws.outboundMessages[0], compressedInbound)
  } finally {
    pair.sessionA.close()
    pair.sessionB.close()
  }
})

test('portal.ws open failure is surfaced as an RPC error', async () => {
  const pair = createPair({
    handlers: makeHandlers({
      ws: async () => {
        throw new MeshRpcError('portal/upstream-error', 'upgrade rejected')
      },
    }),
  })
  try {
    await assert.rejects(pair.sessionA.ws({ path: '/', headers: {} }), (error: unknown) => {
      return error instanceof MeshRpcError && error.code === 'portal/upstream-error'
    })
    assert.equal(pair.sessionA.open, true)
  } finally {
    pair.sessionA.close()
    pair.sessionB.close()
  }
})

// ---------------------------------------------------------------------------
// Limits, backpressure and framing
// ---------------------------------------------------------------------------

test('concurrent stream limit rejects with mesh/busy', async () => {
  const never: ChunkStream = {
    [Symbol.asyncIterator]: () => ({ next: () => new Promise<IteratorResult<Uint8Array>>(() => {}) }),
  }
  const pair = createPair({
    handlers: makeHandlers({
      ws: async () => ({ protocol: 'never', inbound: never, outbound: nullSink() }),
    }),
    controllerSession: { maxConcurrentStreams: 2 },
  })
  try {
    const first = await pair.sessionA.ws({ path: '/a', headers: {} })
    const second = await pair.sessionA.ws({ path: '/b', headers: {} })
    void first
    void second
    await assert.rejects(pair.sessionA.ws({ path: '/c', headers: {} }), (error: unknown) => {
      return error instanceof MeshRpcError && error.code === 'mesh/busy'
    })
    // Closing the session aborts the open streams too.
    pair.sessionA.close()
    await pair.sessionA.closed
  } finally {
    pair.sessionB.close()
  }
})

test('backpressure blocks stream writes until the transport drains', async () => {
  const ws = controllableWs()
  const pair = createPair({ handlers: ws.handlers })
  try {
    const exchange = await pair.sessionA.ws({ path: '/ws', headers: {} })
    pair.a.bufferedAmount = 4 * 1024 * 1024
    let sent = false
    const sending = exchange.sink.sendMessage(bytes('blocked')).then(() => {
      sent = true
    })
    await delay(30)
    assert.equal(sent, false, 'write must wait while the transport is backed up')
    assert.equal(ws.outboundMessages.length, 0)
    pair.a.bufferedAmount = 0
    await sending
    await waitFor(() => ws.outboundMessages.length === 1)
    assert.equal(decode(ws.outboundMessages[0] as Uint8Array), 'blocked')
    ws.endInbound()
  } finally {
    pair.sessionA.close()
    pair.sessionB.close()
  }
})

test('inbound buffer overflow aborts only that stream, not the session', async () => {
  const pair = createPair({
    handlers: makeHandlers({
      // Returns immediately without consuming the request body: the daemon
      // session's inbound buffer for that stream must overflow and abort.
      http: async () => ({ status: 200, headers: {}, body: iterableOf([]) }),
    }),
    daemonSession: { maxInboundQueueBytes: 64 },
  })
  try {
    await pair.sessionA.http(
      { method: 'POST', path: '/huge', headers: {} },
      iterableOf([new Uint8Array(4 * 1024).fill(1)]),
    )
    await flushAsync(8)
    assert.equal(pair.sessionA.open, true)
    assert.equal(pair.sessionB.open, true)
    assert.deepEqual(await pair.sessionA.rpc('echo'), { method: 'echo' })
  } finally {
    pair.sessionA.close()
    pair.sessionB.close()
  }
})

test('oversized WebSocket message aborts only that stream, not the session', async () => {
  const ws = controllableWs()
  const pair = createPair({
    handlers: ws.handlers,
    daemonSession: { maxInboundQueueBytes: 64 * 1024 },
  })
  try {
    const exchange = await pair.sessionA.ws({ path: '/ws', headers: {} })
    // Collect in the background: the abort must surface through the message
    // stream (the controller sees `mesh/busy`), not by closing the session.
    const received = collect(exchange.messages)
    // Five 32 KiB fragments of one WebSocket message, never followed by
    // MessageEnd. The old code only checked the completed-message queue, so
    // this accumulated 160 KiB and kept the session open forever.
    const fragment = new Uint8Array(32 * 1024).fill(1)
    for (let index = 0; index < 5; index += 1) {
      pair.b.receive(streamFrame(1, 0x01, fragment))
    }
    await assert.rejects(received, (error: unknown) => {
      return error instanceof MeshRpcError && error.code === 'mesh/busy'
    })
    await flushAsync(8)
    assert.equal(pair.sessionA.open, true)
    assert.equal(pair.sessionB.open, true)
    assert.deepEqual(await pair.sessionA.rpc('echo'), { method: 'echo' })
  } finally {
    pair.sessionA.close()
    pair.sessionB.close()
  }
})

test('daemon pairing state is live and flips to none after approval', () => {
  let pending = true
  const pair = createLocalSessionPair(
    {
      remote: DAEMON,
      sas: '123-456',
      pairing: { approval: 'pending', requestId: 'pair-live' },
    },
    {
      remote: CONTROLLER,
      sas: '123-456',
      pairing: { approval: 'pending', requestId: 'pair-live' },
      isPairingPending: () => pending,
      session: { handlers: makeHandlers() },
    },
  )
  try {
    assert.deepEqual(pair.sessionB.pairing, { approval: 'pending', requestId: 'pair-live' })
    pending = false
    assert.deepEqual(pair.sessionB.pairing, { approval: 'none' })
  } finally {
    pair.sessionA.close()
    pair.sessionB.close()
  }
})

test('unknown stream ids are ignored; malformed frames close with a protocol error', async () => {
  const pair = createPair()
  try {
    // Unknown stream id: silently dropped (no cross-stream interference).
    pair.b.receive(streamFrame(0x7ffffff1, 0x01, bytes('orphan')))
    await flushAsync()
    assert.equal(pair.sessionB.open, true)
    assert.deepEqual(await pair.sessionA.rpc('echo'), { method: 'echo' })

    // Malformed control JSON closes both ends (protocol violation).
    pair.b.receive(new Uint8Array([0x10, 0x7b]))
    await pair.sessionB.closed
    await pair.sessionA.closed
    assert.equal(pair.sessionB.open, false)
    assert.equal(pair.sessionA.open, false)
  } finally {
    pair.sessionA.close()
    pair.sessionB.close()
  }
})

test('malformed stream frames and unknown message kinds are protocol errors', async () => {
  for (const frame of [
    new Uint8Array([0x11]), // too short
    streamFrame(1, 0x10, bytes('bad-flags')), // unknown flag bit
    streamFrame(1, 0x06, bytes('end-and-abort')), // End|Abort
    new Uint8Array([0x12, 0x01]), // reserved/unknown kind
  ]) {
    const pair = createPair()
    pair.b.receive(frame)
    await pair.sessionB.closed
    await pair.sessionA.closed
    assert.equal(pair.sessionB.open, false)
    pair.sessionA.close()
    pair.sessionB.close()
  }
})

test('close rejects pending work, resolves closed once and is idempotent', async () => {
  const pair = createPair({ controllerSession: { rpcTimeoutMs: 5_000 } })
  try {
    const pending = pair.sessionA.rpc('never')
    const closed = pair.sessionA.closed
    pair.sessionA.close()
    await closed
    await assert.rejects(pending, (error: unknown) => {
      return error instanceof MeshRpcError && error.message === 'session closed'
    })
    pair.sessionA.close()
    pair.sessionA.close()
    assert.equal(pair.sessionA.open, false)
    assert.equal(await pair.sessionA.ping().then(() => 'resolved', error => (error as MeshRpcError).code), 'mesh/internal')
    assert.doesNotThrow(() =>{  pair.sessionA.emit('after.close') })
    await flushAsync()
    assert.equal(pair.sessionB.open, false)
  } finally {
    pair.sessionB.close()
  }
})

test('exactly 32 concurrent streams are allowed by default', async () => {
  const never: ChunkStream = {
    [Symbol.asyncIterator]: () => ({ next: () => new Promise<IteratorResult<Uint8Array>>(() => {}) }),
  }
  const pair = createPair({
    handlers: makeHandlers({ ws: async () => ({ protocol: 'never', inbound: never, outbound: nullSink() }) }),
  })
  try {
    const opened: unknown[] = []
    for (let index = 0; index < 32; index += 1) {
      opened.push(await pair.sessionA.ws({ path: `/ws-${index}`, headers: {} }))
    }
    assert.equal(opened.length, 32)
    await assert.rejects(pair.sessionA.ws({ path: '/over', headers: {} }), (error: unknown) => {
      return error instanceof MeshRpcError && error.code === 'mesh/busy'
    })
  } finally {
    pair.sessionA.close()
    pair.sessionB.close()
  }
})

test('controller stream abort propagates to the daemon handler sink', async () => {
  const ws = controllableWs()
  const pair = createPair({ handlers: ws.handlers })
  try {
    const exchange = await pair.sessionA.ws({ path: '/ws', headers: {} })
    await waitFor(() => ws.params() !== undefined)
    await exchange.sink.abort('portal/upstream-error')
    await waitFor(() => ws.outboundAborted.includes('portal/upstream-error'))
    assert.equal(pair.sessionA.open, true)
    assert.equal(pair.sessionB.open, true)
    ws.endInbound()
  } finally {
    pair.sessionA.close()
    pair.sessionB.close()
  }
})

test('daemon response body failure aborts the HTTP stream with a Mesh error', async () => {
  const pair = createPair({
    handlers: makeHandlers({
      http: async () => ({
        status: 200,
        headers: {},
        body: (async function* failingBody(): AsyncGenerator<Uint8Array> {
          yield bytes('partial')
          throw new MeshRpcError('portal/upstream-error', 'upstream died')
        })(),
      }),
    }),
  })
  try {
    const response = await pair.sessionA.http({ method: 'GET', path: '/', headers: {} })
    assert.equal(response.status, 200)
    const chunks: Uint8Array[] = []
    await assert.rejects(async () => {
      for await (const chunk of response.body) chunks.push(chunk)
    }, (error: unknown) => {
      return error instanceof MeshRpcError && error.code === 'portal/upstream-error'
    })
    assert.equal(decode(chunks[0] as Uint8Array), 'partial')
    assert.equal(pair.sessionA.open, true)
    assert.equal(pair.sessionB.open, true)
  } finally {
    pair.sessionA.close()
    pair.sessionB.close()
  }
})

test('ping/pong and events keep working alongside portal streams', async () => {
  let received: Uint8Array[] = []
  const pair = createPair({
    handlers: makeHandlers({
      http: async (_params, body) => {
        received = await collect(body)
        return { status: 200, headers: {}, body: iterableOf([bytes('ok')]) }
      },
    }),
  })
  try {
    const response = await pair.sessionA.http(
      { method: 'POST', path: '/', headers: {} },
      iterableOf([bytes('payload')]),
    )
    assert.equal(decode((await collect(response.body))[0] as Uint8Array), 'ok')
    assert.equal(received.map(decode).join(''), 'payload')
    assert.equal(await pair.sessionA.ping(300), 1)
    pair.sessionB.emit('audit', { action: 'session.opened' })
    await flushAsync()
    assert.equal(pair.sessionA.open, true)
  } finally {
    pair.sessionA.close()
    pair.sessionB.close()
  }
})
