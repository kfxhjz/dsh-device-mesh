/**
 * Relay carrier unit tests against an in-process mock relay (see mock-relay.ts).
 * These cover the exact v2 control/data semantics documented by paseo-relay.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  buildRelayUrl,
  connectRelayClient,
  startRelayDaemon,
  startRelayDaemonV1,
} from '../../src/host/transport/relay.ts'
import type { RelayDaemonExtraOptions } from '../../src/host/transport/relay.ts'
import type { MeshTransport, RelayDaemon, TransportCloseInfo } from '../../src/shared/transport.ts'
import { startMockRelay } from './mock-relay.ts'
import type { MockRelay } from './mock-relay.ts'
import { bytes, captureLogs, nextClose, nextMessage, sleep, waitForCondition } from './helpers.ts'
import type { CapturedLogs } from './helpers.ts'

const SERVER_ID = 'srv_unit_test_0123456789'

interface AttachedClient {
  readonly transport: MeshTransport
  readonly connectionId: string
}

interface Harness {
  readonly mock: MockRelay
  readonly daemon: RelayDaemon
  readonly clients: AttachedClient[]
  readonly disconnects: TransportCloseInfo[]
  readonly logs: CapturedLogs
  close(): Promise<void>
}

async function startV2Harness(overrides: Partial<RelayDaemonExtraOptions> = {}): Promise<Harness> {
  const mock = await startMockRelay({ dataAttachTimeoutMs: 2_000 })
  const clients: AttachedClient[] = []
  const disconnects: TransportCloseInfo[] = []
  const logs = captureLogs()
  const daemon = startRelayDaemon(
    {
      url: mock.url,
      serverId: SERVER_ID,
      version: 2,
      minBackoffMs: 25,
      maxBackoffMs: 100,
      heartbeatMs: 40,
      logger: logs.logger,
      ...overrides,
    },
    (transport, connectionId) => {
      clients.push({ transport, connectionId })
    },
  )
  daemon.onDisconnect(info => disconnects.push(info))
  await daemon.ready
  return {
    mock,
    daemon,
    clients,
    disconnects,
    logs,
    async close(): Promise<void> {
      for (const client of clients) client.transport.close(1000, 'test done')
      await daemon.close()
      await mock.close()
    },
  }
}

function isPong(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { type?: unknown }).type === 'pong' &&
    typeof (value as { ts?: unknown }).ts === 'number'
  )
}

test('relay v2: connected opens a data socket, forwards 64 KiB, answers ping', async () => {
  const harness = await startV2Harness()
  const client = await connectRelayClient({
    url: harness.mock.url,
    serverId: SERVER_ID,
    version: 2,
    heartbeatMs: 40,
  })
  try {
    await waitForCondition(() => harness.clients.length === 1, 3_000, 'daemon data socket')
    const entry = harness.clients[0]
    assert.ok(entry)
    assert.match(entry.connectionId, /^conn_[0-9a-f]{16}$/)
    assert.deepEqual(harness.mock.connectionIds(SERVER_ID), [entry.connectionId])
    await waitForCondition(
      () => harness.mock.hasDataSocket(entry.connectionId),
      3_000,
      'mock data socket',
    )

    const up = bytes(64 * 1024, 3)
    const daemonGot = nextMessage(entry.transport)
    client.send(up)
    assert.deepEqual(Array.from(await daemonGot), Array.from(up))

    const down = bytes(64 * 1024, 5)
    const clientGot = nextMessage(client)
    entry.transport.send(down)
    assert.deepEqual(Array.from(await clientGot), Array.from(down))
    const received = harness.mock.receivedByData(entry.connectionId)
    assert.equal(received.length, 1)
    assert.deepEqual(Array.from(received[0] ?? []), Array.from(down))

    // Application-level control ping is answered with a timestamped pong.
    harness.mock.sendControlPing(SERVER_ID)
    await waitForCondition(
      () => harness.mock.controlMessages(SERVER_ID).some(isPong),
      2_000,
      'control pong',
    )

    // A 40 ms WS heartbeat survived several intervals without killing anything.
    await sleep(160)
    assert.equal(harness.daemon.connected, true)
    assert.equal(harness.clients.length, 1)
    assert.equal(harness.mock.hasDataSocket(entry.connectionId), true)
  } finally {
    client.close(1000, 'test done')
    await harness.close()
  }
})

test('relay v2: sync lists a pre-existing client and the daemon attaches its route', async () => {
  const mock = await startMockRelay({ dataAttachTimeoutMs: 2_000 })
  const clients: AttachedClient[] = []
  const logs = captureLogs()
  const client = await connectRelayClient({
    url: mock.url,
    serverId: SERVER_ID,
    version: 2,
    heartbeatMs: 0,
  })
  const daemon = startRelayDaemon(
    {
      url: mock.url,
      serverId: SERVER_ID,
      version: 2,
      minBackoffMs: 25,
      maxBackoffMs: 100,
      heartbeatMs: 0,
      logger: logs.logger,
    },
    (transport, connectionId) => clients.push({ transport, connectionId }),
  )
  try {
    await mock.waitFor(() => mock.connectionIds(SERVER_ID).length === 1)
    const connectionId = mock.connectionIds(SERVER_ID)[0]
    assert.ok(connectionId)

    // The relay buffers controller frames until the daemon data socket shows
    // up; those frames must arrive after the sync-driven attach and never be
    // dropped.
    const early = bytes(1024, 11)
    client.send(early)

    await daemon.ready
    await mock.waitFor(() => mock.hasDataSocket(connectionId))
    await waitForCondition(() => clients.length === 1, 3_000, 'sync-driven data socket')
    const entry = clients[0]
    assert.ok(entry)
    assert.equal(entry.connectionId, connectionId)
    const buffered = await nextMessage(entry.transport)
    assert.deepEqual(Array.from(buffered), Array.from(early))

    const live = bytes(2048, 13)
    const daemonGot = nextMessage(entry.transport)
    client.send(live)
    assert.deepEqual(Array.from(await daemonGot), Array.from(live))
  } finally {
    client.close(1000, 'test done')
    await daemon.close()
    await mock.close()
  }
})

test('relay v2: controller close propagates 1001 to the daemon data transport', async () => {
  const harness = await startV2Harness()
  const client = await connectRelayClient({
    url: harness.mock.url,
    serverId: SERVER_ID,
    version: 2,
    heartbeatMs: 0,
  })
  try {
    await waitForCondition(() => harness.clients.length === 1, 3_000, 'daemon data socket')
    const entry = harness.clients[0]
    assert.ok(entry)

    const daemonClosed = nextClose(entry.transport)
    const clientClosed = nextClose(client)
    client.close(4400, 'controller done')
    const daemonInfo = await daemonClosed
    assert.equal(daemonInfo.code, 1001)
    assert.equal(daemonInfo.reason, 'Client disconnected')
    const clientInfo = await clientClosed
    assert.equal(clientInfo.local, true)
    assert.equal(clientInfo.code, 4400)

    // The daemon control socket stays healthy and a new controller attaches.
    assert.equal(harness.daemon.connected, true)
    const second = await connectRelayClient({
      url: harness.mock.url,
      serverId: SERVER_ID,
      version: 2,
      heartbeatMs: 0,
    })
    try {
      await waitForCondition(() => harness.clients.length === 2, 3_000, 'second data socket')
      const secondId = harness.clients[1]?.connectionId
      assert.ok(secondId)
      const frame = bytes(256, 23)
      const daemonGot = nextMessage(harness.clients[1]!.transport)
      second.send(frame)
      assert.deepEqual(Array.from(await daemonGot), Array.from(frame))
    } finally {
      second.close(1000, 'test done')
    }
  } finally {
    await harness.close()
  }
})

test('relay v2: a client with no data route is closed 1013', async () => {
  const mock = await startMockRelay({ dataAttachTimeoutMs: 100 })
  const client = await connectRelayClient({
    url: mock.url,
    serverId: 'srv_without_daemon',
    version: 2,
    heartbeatMs: 0,
  })
  try {
    const closed = nextClose(client)
    client.send(bytes(32, 1))
    const info = await closed
    assert.equal(info.code, 1013)
    assert.equal(info.reason, 'Data route unavailable')
  } finally {
    await mock.close()
  }
})

test('relay v2: control loss closes data transports and reconnects with backoff', async () => {
  const harness = await startV2Harness({ minBackoffMs: 30, maxBackoffMs: 120 })
  await connectRelayClient({
    url: harness.mock.url,
    serverId: SERVER_ID,
    version: 2,
    heartbeatMs: 0,
  })
  try {
    await waitForCondition(() => harness.clients.length === 1, 3_000, 'daemon data socket')
    const first = harness.clients[0]
    assert.ok(first)
    const firstClosed = nextClose(first.transport)

    harness.mock.dropControl(SERVER_ID, 1011, 'relay restart')
    const firstInfo = await firstClosed
    assert.equal(firstInfo.code, 1012)
    assert.equal(firstInfo.reason, 'relay control disconnected')

    await waitForCondition(() => harness.disconnects.length === 1, 3_000, 'onDisconnect')
    const disconnect = harness.disconnects[0]
    assert.ok(disconnect)
    assert.equal(disconnect.code, 1011)
    assert.equal(disconnect.reason, 'relay restart')

    await waitForCondition(() => harness.daemon.connected, 3_000, 'control reconnect')
    const client2 = await connectRelayClient({
      url: harness.mock.url,
      serverId: SERVER_ID,
      version: 2,
      heartbeatMs: 0,
    })
    try {
      await waitForCondition(() => harness.clients.length === 2, 3_000, 'post-reconnect data')
      const entry = harness.clients[1]
      assert.ok(entry)
      const frame = bytes(512, 31)
      const daemonGot = nextMessage(entry.transport)
      client2.send(frame)
      assert.deepEqual(Array.from(await daemonGot), Array.from(frame))
    } finally {
      client2.close(1000, 'test done')
    }
  } finally {
    await harness.close()
  }
})

test('relay v1 fallback: one socket round-trips and 1008 replaces the old daemon', async () => {
  const mock = await startMockRelay()
  const logs = captureLogs()
  const firstClients: AttachedClient[] = []
  const daemon1 = startRelayDaemonV1(
    {
      url: mock.url,
      serverId: SERVER_ID,
      minBackoffMs: 500,
      maxBackoffMs: 500,
      heartbeatMs: 0,
      logger: logs.logger,
    },
    (transport, connectionId) => firstClients.push({ transport, connectionId }),
  )
  const client = await connectRelayClient({
    url: mock.url,
    serverId: SERVER_ID,
    version: 1,
    heartbeatMs: 0,
  })
  let daemon2: RelayDaemon | undefined
  try {
    await daemon1.ready
    assert.equal(daemon1.connected, true)
    await waitForCondition(() => firstClients.length === 1, 3_000, 'v1 daemon transport')
    const entry = firstClients[0]
    assert.ok(entry)
    assert.equal(entry.connectionId, 'v1')

    const up = bytes(64 * 1024, 7)
    const daemonGot = nextMessage(entry.transport)
    client.send(up)
    assert.deepEqual(Array.from(await daemonGot), Array.from(up))

    const down = bytes(4096, 9)
    const clientGot = nextMessage(client)
    entry.transport.send(down)
    assert.deepEqual(Array.from(await clientGot), Array.from(down))

    const replaced = nextClose(entry.transport)
    const secondClients: AttachedClient[] = []
    daemon2 = startRelayDaemonV1(
      {
        url: mock.url,
        serverId: SERVER_ID,
        minBackoffMs: 500,
        maxBackoffMs: 500,
        heartbeatMs: 0,
        logger: logs.logger,
      },
      (transport, connectionId) => secondClients.push({ transport, connectionId }),
    )
    await daemon2.ready
    const info = await replaced
    assert.equal(info.code, 1008)
    assert.equal(info.reason, 'Replaced by new connection')
    await waitForCondition(() => secondClients.length === 1, 3_000, 'second v1 daemon transport')
  } finally {
    client.close(1000, 'test done')
    await daemon2?.close()
    await daemon1.close()
    await mock.close()
  }
})

test('relay: serverId never leaks into logs or network errors', async () => {
  const secret = 'SID_bearer_secret_9f8e7d'
  const logs = captureLogs()
  const mock = await startMockRelay()
  const daemon = startRelayDaemon({
    url: mock.url,
    serverId: secret,
    version: 2,
    minBackoffMs: 20,
    maxBackoffMs: 50,
    heartbeatMs: 0,
    logger: logs.logger,
  })
  try {
    await daemon.ready
    mock.dropControl(secret, 1011, 'restart')
    await waitForCondition(
      () => logs.messages.some(message => message.includes('reconnecting')),
      3_000,
      'reconnect log',
    )
  } finally {
    await daemon.close()
    await mock.close()
  }
  for (const message of logs.messages) {
    assert.equal(message.includes(secret), false, `log leaked serverId: ${message}`)
  }

  // Invalid server ids are rejected without echoing the value.
  assert.throws(
    () => buildRelayUrl({ url: 'ws://127.0.0.1:1/ws', serverId: 'bad server id', version: 2 }, 'server'),
    (error: Error) => error.message === 'invalid relay serverId',
  )

  // Connection errors also stay secret-free.
  await assert.rejects(
    connectRelayClient({
      url: 'ws://127.0.0.1:1/ws',
      serverId: secret,
      version: 2,
      heartbeatMs: 0,
    }),
    (error: Error) => !error.message.includes(secret) && /websocket connect failed/.test(error.message),
  )
})

test('relay: URL builder keeps exactly one of each query parameter', () => {
  const built = buildRelayUrl(
    { url: 'wss://relay.example.com/ws?role=client&serverId=old', serverId: 'sid-123', version: 2 },
    'server',
    'conn_abc',
  )
  const url = new URL(built)
  assert.equal(url.pathname, '/ws')
  assert.equal(url.searchParams.get('serverId'), 'sid-123')
  assert.equal(url.searchParams.get('role'), 'server')
  assert.equal(url.searchParams.get('v'), '2')
  assert.equal(url.searchParams.get('connectionId'), 'conn_abc')
  assert.equal(url.searchParams.getAll('serverId').length, 1)
  assert.equal(url.searchParams.getAll('role').length, 1)
})

test('relay: buildRelayUrl rejects non-ws protocols', () => {
  assert.throws(
    () => buildRelayUrl({ url: 'https://relay.example.com/ws', serverId: 'sid', version: 2 }, 'client'),
    /ws:\/\//,
  )
})
