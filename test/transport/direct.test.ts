/**
 * Direct carrier tests: a real loopback listener + real ws clients.
 */

import assert from 'node:assert/strict'
import { once } from 'node:events'
import net from 'node:net'
import { test } from 'node:test'

import { WebSocket } from 'ws'

import type { NetworkInterfaceInfo } from 'node:os'

import {
  connectDirect,
  enumerateDirectUrls,
  startDirectListener,
} from '../../src/host/transport/direct.ts'
import { MAX_WS_PAYLOAD_BYTES } from '../../src/host/transport/common.ts'
import type { MeshTransport, TransportCloseInfo } from '../../src/shared/transport.ts'

function nextMessage(transport: MeshTransport): Promise<Uint8Array> {
  return new Promise((resolve) => {
    const off = transport.onMessage((bytes) => {
      off()
      resolve(bytes)
    })
  })
}

function nextClose(transport: MeshTransport): Promise<TransportCloseInfo> {
  return new Promise((resolve) => {
    transport.onClose(resolve)
  })
}

function bytes(length: number, seed: number): Uint8Array {
  const value = new Uint8Array(length)
  for (let index = 0; index < length; index += 1) {
    value[index] = (index * 31 + seed) & 0xff
  }
  return value
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
  })
}

function wsError(ws: WebSocket): Promise<Error> {
  return new Promise((resolve) => {
    ws.once('error', (error: Error) =>{  resolve(error) })
  })
}

test('direct: listener round-trips a 64 KiB binary frame in both directions', async () => {
  let acceptedResolve!: (transport: MeshTransport) => void
  const accepted = new Promise<MeshTransport>((resolve) => {
    acceptedResolve = resolve
  })
  const listener = await startDirectListener(
    { host: '127.0.0.1', port: 0, upgradeTimeoutMs: 2_000 },
    (transport) =>{  acceptedResolve(transport) },
  )
  const transports: MeshTransport[] = []
  try {
    assert.ok(listener.port > 0)
    assert.deepEqual(listener.urls, [`ws://127.0.0.1:${listener.port}/mesh`])

    const client = await connectDirect(`ws://127.0.0.1:${listener.port}/mesh`)
    const server = await accepted
    transports.push(client, server)
    assert.equal(client.kind, 'direct')
    assert.equal(typeof client.bufferedAmount, 'number')

    const up = bytes(64 * 1024, 7)
    const serverGot = nextMessage(server)
    client.send(up)
    assert.deepEqual(Array.from(await serverGot), Array.from(up))

    const down = bytes(64 * 1024, 19)
    const clientGot = nextMessage(client)
    server.send(down)
    assert.deepEqual(Array.from(await clientGot), Array.from(down))
  } finally {
    await listener.close()
    for (const transport of transports) {
      transport.close(1000, 'test done')
    }
  }
})

test('direct: accepts a sealed frame at the plaintext boundary', async () => {
  let acceptedResolve!: (transport: MeshTransport) => void
  const accepted = new Promise<MeshTransport>((resolve) => {
    acceptedResolve = resolve
  })
  const listener = await startDirectListener(
    { host: '127.0.0.1', port: 0, upgradeTimeoutMs: 2_000 },
    (transport) =>{  acceptedResolve(transport) },
  )
  const transports: MeshTransport[] = []
  try {
    const client = await connectDirect(`ws://127.0.0.1:${listener.port}/mesh`)
    const server = await accepted
    transports.push(client, server)

    // MAX_MESSAGE_BYTES plaintext plus the 1-byte kind and 16-byte AEAD tag:
    // exactly the largest sealed frame a peer may legitimately send.
    const up = bytes(MAX_WS_PAYLOAD_BYTES, 23)
    const serverGot = nextMessage(server)
    client.send(up)
    assert.deepEqual(Array.from(await serverGot), Array.from(up))

    const down = bytes(MAX_WS_PAYLOAD_BYTES, 29)
    const clientGot = nextMessage(client)
    server.send(down)
    assert.deepEqual(Array.from(await clientGot), Array.from(down))
  } finally {
    for (const transport of transports) transport.close(1000, 'test done')
    await listener.close()
  }
})

test('direct: addresses are enumerated in preference order and filtered', () => {
  const interfaces: NodeJS.Dict<NetworkInterfaceInfo[]> = {
    lo0: [
      {
        address: '127.0.0.1',
        netmask: '255.0.0.0',
        family: 'IPv4',
        mac: '00:00:00:00:00:00',
        internal: true,
        cidr: '127.0.0.1/8',
      },
    ],
    en0: [
      {
        address: '192.168.1.23',
        netmask: '255.255.255.0',
        family: 'IPv4',
        mac: 'aa:bb:cc:dd:ee:ff',
        internal: false,
        cidr: '192.168.1.23/24',
      },
      {
        address: 'fe80::1%en0',
        netmask: 'ffff:ffff:ffff:ffff::',
        family: 'IPv6',
        mac: 'aa:bb:cc:dd:ee:ff',
        internal: false,
        cidr: 'fe80::1/64',
        scopeid: 4,
      },
      {
        address: 'fd7a:115c:a1e0::42',
        netmask: 'ffff:ffff:ffff:ffff::',
        family: 'IPv6',
        mac: 'aa:bb:cc:dd:ee:ff',
        internal: false,
        cidr: 'fd7a:115c:a1e0::42/64',
        scopeid: 0,
      },
    ],
    tailscale0: [
      {
        address: '100.101.102.7',
        netmask: '255.192.0.0',
        family: 'IPv4',
        mac: 'aa:bb:cc:dd:ee:01',
        internal: false,
        cidr: '100.101.102.7/10',
      },
    ],
    docker0: [
      {
        address: '172.17.0.1',
        netmask: '255.255.0.0',
        family: 'IPv4',
        mac: 'aa:bb:cc:dd:ee:02',
        internal: false,
        cidr: '172.17.0.1/16',
      },
    ],
    veth1234: [
      {
        address: '10.99.0.1',
        netmask: '255.255.0.0',
        family: 'IPv4',
        mac: 'aa:bb:cc:dd:ee:03',
        internal: false,
        cidr: '10.99.0.1/16',
      },
    ],
    // macOS pseudo-interfaces must never leak into a pairing QR code.
    bridge100: [
      {
        address: '192.168.99.1',
        netmask: '255.255.255.0',
        family: 'IPv4',
        mac: 'aa:bb:cc:dd:ee:04',
        internal: false,
        cidr: '192.168.99.1/24',
      },
    ],
    utun3: [
      {
        address: '10.8.0.1',
        netmask: '255.255.255.0',
        family: 'IPv4',
        mac: 'aa:bb:cc:dd:ee:05',
        internal: false,
        cidr: '10.8.0.1/24',
      },
    ],
    // Linux hotspot/AP interfaces (`ap0` on NetworkManager) are local-only
    // and must be filtered like other virtual interfaces.
    ap0: [
      {
        address: '192.168.12.1',
        netmask: '255.255.255.0',
        family: 'IPv4',
        mac: 'aa:bb:cc:dd:ee:07',
        internal: false,
        cidr: '192.168.12.1/24',
      },
    ],
    // A real Tailscale CGNAT address also lives on `utun*` on macOS and must
    // survive the virtual-interface filter.
    utun4: [
      {
        address: '100.88.1.2',
        netmask: '255.192.0.0',
        family: 'IPv4',
        mac: 'aa:bb:cc:dd:ee:06',
        internal: false,
        cidr: '100.88.1.2/10',
      },
    ],
  }

  assert.deepEqual(enumerateDirectUrls(45871, { interfaces }), [
    'ws://192.168.1.23:45871/mesh',
    'ws://100.101.102.7:45871/mesh',
    'ws://100.88.1.2:45871/mesh',
    'ws://[fd7a:115c:a1e0::42]:45871/mesh',
  ])
  // An explicit bind address short-circuits enumeration.
  assert.deepEqual(enumerateDirectUrls(45871, { host: '127.0.0.1', interfaces }), [
    'ws://127.0.0.1:45871/mesh',
  ])
})

test('direct: listener rejects the connection over maxConnections', async () => {
  const accepted: MeshTransport[] = []
  const listener = await startDirectListener(
    { host: '127.0.0.1', port: 0, maxConnections: 2, maxConnectionsPerIp: 10 },
    transport => accepted.push(transport),
  )
  const clients: MeshTransport[] = []
  try {
    clients.push(await connectDirect(`ws://127.0.0.1:${listener.port}/mesh`))
    clients.push(await connectDirect(`ws://127.0.0.1:${listener.port}/mesh`))
    assert.equal(accepted.length, 2)

    const overflow = new WebSocket(`ws://127.0.0.1:${listener.port}/mesh`)
    const error = await wsError(overflow)
    assert.match(error.message, /503/)
    overflow.terminate()

    // Freeing one slot lets the next connection in again.
    clients[0]?.close(1000, 'free a slot')
    await sleep(100)
    clients.push(await connectDirect(`ws://127.0.0.1:${listener.port}/mesh`))
    assert.equal(accepted.length, 3)
  } finally {
    for (const client of clients) client.close(1000, 'test done')
    await listener.close()
  }
})

test('direct: per-IP cap rejects excess connections without touching the global cap', async () => {
  const accepted: MeshTransport[] = []
  const listener = await startDirectListener(
    { host: '127.0.0.1', port: 0, maxConnections: 8, maxConnectionsPerIp: 1 },
    transport => accepted.push(transport),
  )
  const clients: MeshTransport[] = []
  try {
    clients.push(await connectDirect(`ws://127.0.0.1:${listener.port}/mesh`))
    const overflow = new WebSocket(`ws://127.0.0.1:${listener.port}/mesh`)
    const error = await wsError(overflow)
    assert.match(error.message, /429/)
    overflow.terminate()
    assert.equal(accepted.length, 1)
  } finally {
    for (const client of clients) client.close(1000, 'test done')
    await listener.close()
  }
})

test('direct: per-IP upgrade attempts are rate limited with 429', async () => {
  const accepted: MeshTransport[] = []
  const listener = await startDirectListener(
    {
      host: '127.0.0.1',
      port: 0,
      maxConnections: 8,
      maxConnectionsPerIp: 4,
      maxAttemptsPerIpPerMinute: 2,
    },
    transport => accepted.push(transport),
  )
  const clients: MeshTransport[] = []
  try {
    clients.push(await connectDirect(`ws://127.0.0.1:${listener.port}/mesh`))
    clients.push(await connectDirect(`ws://127.0.0.1:${listener.port}/mesh`))
    const limited = new WebSocket(`ws://127.0.0.1:${listener.port}/mesh`)
    const error = await wsError(limited)
    assert.match(error.message, /429/)
    assert.equal(accepted.length, 2)
  } finally {
    for (const client of clients) client.close(1000, 'test done')
    await listener.close()
  }
})

test('direct: browser Origin headers are rejected before the upgrade', async () => {
  const listener = await startDirectListener(
    { host: '127.0.0.1', port: 0, maxConnectionsPerIp: 10 },
    () => {},
  )
  try {
    const browser = new WebSocket(`ws://127.0.0.1:${listener.port}/mesh`, {
      origin: 'https://evil.example',
    })
    const error = await wsError(browser)
    assert.match(error.message, /403/)
    browser.terminate()

    const wrongPath = new WebSocket(`ws://127.0.0.1:${listener.port}/nope`)
    const pathError = await wsError(wrongPath)
    assert.match(pathError.message, /404/)
    wrongPath.terminate()
  } finally {
    await listener.close()
  }
})

test('direct: close code and reason propagate to the peer', async () => {
  let acceptedResolve!: (transport: MeshTransport) => void
  const accepted = new Promise<MeshTransport>((resolve) => {
    acceptedResolve = resolve
  })
  const listener = await startDirectListener(
    { host: '127.0.0.1', port: 0, maxConnectionsPerIp: 10 },
    (transport) =>{  acceptedResolve(transport) },
  )
  let server: MeshTransport | undefined
  let client: MeshTransport | undefined
  try {
    client = await connectDirect(`ws://127.0.0.1:${listener.port}/mesh`)
    server = await accepted

    const serverClosed = nextClose(server)
    const clientClosed = nextClose(client)
    server.close(4400, 'daemon ended the session')
    const localInfo = await serverClosed
    assert.equal(localInfo.local, true)
    assert.equal(localInfo.code, 4400)
    const remoteInfo = await clientClosed
    assert.equal(remoteInfo.local, false)
    assert.equal(remoteInfo.code, 4400)
    assert.equal(remoteInfo.reason, 'daemon ended the session')

    // Reverse direction: a controller-initiated close reaches the daemon.
    const secondAccepted = new Promise<MeshTransport>((resolve) => {
      acceptedResolve = resolve
    })
    client = await connectDirect(`ws://127.0.0.1:${listener.port}/mesh`)
    server = await secondAccepted
    const daemonSideClosed = nextClose(server)
    client.close(4001, 'controller closed')
    const info = await daemonSideClosed
    assert.equal(info.local, false)
    assert.equal(info.code, 4001)
    assert.equal(info.reason, 'controller closed')
  } finally {
    server?.close(1000, 'test done')
    client?.close(1000, 'test done')
    await listener.close()
  }
})

test('direct: listener closes active transports when it shuts down', async () => {
  let acceptedResolve!: (transport: MeshTransport) => void
  const accepted = new Promise<MeshTransport>((resolve) => {
    acceptedResolve = resolve
  })
  const listener = await startDirectListener(
    { host: '127.0.0.1', port: 0, maxConnectionsPerIp: 10 },
    (transport) =>{  acceptedResolve(transport) },
  )
  const client = await connectDirect(`ws://127.0.0.1:${listener.port}/mesh`)
  const server = await accepted
  const clientClosed = nextClose(client)
  await listener.close()
  const info = await clientClosed
  assert.equal(info.code, 1001)
  assert.equal(info.reason, 'listener closed')
  server.close(1000, 'test done')
})

test('direct: sockets that never finish the upgrade are dropped', async () => {
  const listener = await startDirectListener(
    { host: '127.0.0.1', port: 0, upgradeTimeoutMs: 100, maxConnectionsPerIp: 10 },
    () => {
      throw new Error('idle socket must not be accepted')
    },
  )
  try {
    const socket = net.connect(listener.port, '127.0.0.1')
    await once(socket, 'connect')
    const closed = once(socket, 'close')
    const result = await Promise.race([
      closed.then(() => 'closed' as const),
      sleep(2_000).then(() => 'timeout' as const),
    ])
    assert.equal(result, 'closed')
  } finally {
    await listener.close()
  }
})
