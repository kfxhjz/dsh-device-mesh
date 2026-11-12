import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import type { DeviceDescriptor, PairingEndpoint, PairingTicket } from '../../src/shared/protocol.ts'
import {
  PAIRING_URI_PREFIX,
  decodeUtf8,
  encodeUtf8,
  fromBase64Url,
  toBase64Url,
} from '../../src/shared/protocol.ts'
import { computeSas as cryptoComputeSas, generateDeviceIdentity } from '../../src/host/crypto.ts'
import {
  PairingError,
  PairingService,
  computeSas,
  createPairingTicket,
  hashPairingToken,
  parsePairingLink,
  verifyPairingTicket,
} from '../../src/host/pairing.ts'
import { MeshStore } from '../../src/host/store.ts'
import { makeTempDir } from './helpers.ts'

const ENDPOINTS: PairingEndpoint[] = [
  { k: 'direct', url: 'ws://192.168.1.2:45871/mesh' },
  { k: 'relay', url: 'wss://relay.example.com/ws', sid: 'secret-server-id', v: 2 },
]

function decodeLink(link: string): Record<string, unknown> {
  assert.equal(link.startsWith(PAIRING_URI_PREFIX), true)
  const bytes = fromBase64Url(link.slice(PAIRING_URI_PREFIX.length))
  assert.ok(bytes)
  return JSON.parse(decodeUtf8(bytes)) as Record<string, unknown>
}

function encodeLink(document: Record<string, unknown>): string {
  return `${PAIRING_URI_PREFIX}${toBase64Url(encodeUtf8(JSON.stringify(document)))}`
}

async function makeService(options: {
  now?: () => number
  ttlMs?: number
  requestTtlMs?: number
  autoApprove?: () => boolean
} = {}): Promise<{
  readonly store: MeshStore
  readonly service: PairingService
  readonly cleanup: () => Promise<void>
}> {
  const temp = await makeTempDir()
  const store = await MeshStore.open({ home: temp.dir })
  const service = new PairingService({
    identity: store.getIdentity(),
    store,
    ...(options.now !== undefined ? { now: options.now } : {}),
    ...(options.ttlMs !== undefined ? { ttlMs: options.ttlMs } : {}),
    ...(options.requestTtlMs !== undefined ? { requestTtlMs: options.requestTtlMs } : {}),
    ...(options.autoApprove !== undefined ? { autoApprove: options.autoApprove } : {}),
  })
  await service.init()
  return { store, service, cleanup: temp.cleanup }
}

describe('pairing: tickets', () => {
  it('creates a signed link and parses it back', async () => {
    const context = await makeService()
    try {
      const before = Date.now()
      const created = await context.service.createTicket(ENDPOINTS)
      assert.equal(created.ticket.v, 1)
      assert.equal(created.ticket.id, context.store.getIdentity().deviceId)
      assert.equal(created.ticket.signPk, context.store.getIdentity().signPk)
      assert.equal(fromBase64Url(created.ticket.tok)?.byteLength, 32)
      assert.equal(created.ticket.eps.length, 2)
      assert.ok(created.ticket.exp * 1000 > before + 9 * 60 * 1000)

      const parsed = parsePairingLink(created.link)
      assert.deepEqual(parsed, created.ticket)
      // Re-encoding produces the same canonical link.
      assert.equal(decodeLink(created.link).id, created.ticket.id)
    } finally {
      await context.cleanup()
    }
  })

  it('rejects a tampered payload because the signature covers every field', async () => {
    const context = await makeService()
    try {
      const created = await context.service.createTicket(ENDPOINTS)
      const document = decodeLink(created.link)
      document.exp = Number(document.exp) + 3600
      assert.throws(
        () => parsePairingLink(encodeLink(document)),
        (error: unknown) => error instanceof PairingError && error.code === 'mesh/bad-request',
      )

      const tokenTampered = decodeLink(created.link)
      tokenTampered.tok = toBase64Url(new Uint8Array(32).fill(9))
      assert.throws(
        () => parsePairingLink(encodeLink(tokenTampered)),
        (error: unknown) => error instanceof PairingError,
      )
      // The document-level verifier also rejects a device-id/key mismatch.
      const mismatched = decodeLink(created.link)
      mismatched.id = 'dm_other00000000000000001'
      assert.throws(() => verifyPairingTicket(mismatched), PairingError)
    } finally {
      await context.cleanup()
    }
  })

  it('rejects an expired ticket', async () => {
    let clock = 1_700_000_000_000
    const context = await makeService({ now: () => clock, ttlMs: 60_000 })
    try {
      const created = await context.service.createTicket(ENDPOINTS)
      clock += 61_000
      assert.throws(
        () => parsePairingLink(created.link, clock),
        (error: unknown) => error instanceof PairingError && error.code === 'mesh/unauthorized',
      )
    } finally {
      await context.cleanup()
    }
  })

  it('builds a ticket without a service (pure helper)', () => {
    const identity = generateDeviceIdentity({ name: 'A' })
    const created = createPairingTicket({
      identity,
      endpoints: ENDPOINTS,
      token: toBase64Url(new Uint8Array(32).fill(3)),
      now: Date.now(),
    })
    assert.equal(created.tokenHash, hashPairingToken(created.ticket.tok))
    assert.equal(parsePairingLink(created.link).id, identity.deviceId)
  })
})

describe('pairing: ticket endpoint validation', () => {
  const identity = generateDeviceIdentity({ name: 'A' })
  const token = toBase64Url(new Uint8Array(32).fill(5))

  function parseEndpoints(endpoints: PairingEndpoint[]): PairingTicket {
    const created = createPairingTicket({ identity, endpoints, token, now: Date.now() })
    return parsePairingLink(created.link)
  }

  it('accepts direct WebSocket, loopback plaintext relay and public wss relay', () => {
    const endpoints: PairingEndpoint[] = [
      { k: 'direct', url: 'ws://192.168.1.2:45871/mesh' },
      { k: 'relay', url: 'ws://127.0.0.1:4000/ws', sid: 'local-server-id', v: 2 },
      { k: 'relay', url: 'wss://relay.example.com/ws', sid: 'secret-server-id', v: 2 },
    ]
    assert.deepEqual(parseEndpoints(endpoints).eps, endpoints)
  })

  it('rejects unsafe or malformed endpoints before the ticket is dialed', () => {
    const cases: PairingEndpoint[][] = [
      [{ k: 'direct', url: 'http://192.168.1.2:45871/mesh' }],
      [{ k: 'direct', url: 'file:///etc/passwd' }],
      [{ k: 'direct', url: 'ws://user:pass@192.168.1.2:45871/mesh' }],
      [{ k: 'direct', url: `ws://${'a'.repeat(512)}` }],
      [{ k: 'relay', url: 'ws://relay.example.com/ws', sid: 'secret-server-id', v: 2 }],
      [{ k: 'relay', url: 'https://relay.example.com/ws', sid: 'secret-server-id', v: 2 }],
      [{ k: 'relay', url: 'wss://relay.example.com/ws', sid: '', v: 2 }],
      [{ k: 'relay', url: 'wss://relay.example.com/ws', sid: 'bad sid', v: 2 }],
    ]
    for (const endpoints of cases) {
      assert.throws(
        () => parseEndpoints(endpoints),
        (error: unknown) => error instanceof PairingError && error.code === 'mesh/bad-request',
        JSON.stringify(endpoints),
      )
    }
  })
})

describe('pairing: one-time tokens', () => {
  it('accepts a token exactly once and never stores it in plaintext', async () => {
    const context = await makeService()
    try {
      const created = await context.service.createTicket(ENDPOINTS)
      const daemonId = context.store.getIdentity().deviceId

      assert.deepEqual(await context.service.beginPairToken(daemonId, created.ticket.tok), { ok: true })
      const second = await context.service.beginPairToken(daemonId, created.ticket.tok)
      assert.equal(second.ok, false)

      const unknown = await context.service.beginPairToken(
        daemonId,
        toBase64Url(new Uint8Array(32).fill(7)),
      )
      assert.equal(unknown.ok, false)

      const wrongDevice = await context.service.beginPairToken('dm_other', created.ticket.tok)
      assert.equal(wrongDevice.ok, false)

      const persisted = await readFile(join(context.store.paths.home, 'pairing.json'), 'utf8')
      assert.equal(persisted.includes(created.ticket.tok), false)
      assert.equal(persisted.includes(hashPairingToken(created.ticket.tok)), false)
    } finally {
      await context.cleanup()
    }
  })

  it('loads pending token hashes across service instances', async () => {
    const context = await makeService()
    try {
      const created = await context.service.createTicket(ENDPOINTS)
      const reopened = new PairingService({ identity: context.store.getIdentity(), store: context.store })
      await reopened.init()
      assert.equal(reopened.pendingTicketCount, 1)
      assert.deepEqual(
        await reopened.beginPairToken(context.store.getIdentity().deviceId, created.ticket.tok),
        { ok: true },
      )
      assert.equal(reopened.pendingTicketCount, 0)
    } finally {
      await context.cleanup()
    }
  })
})

describe('pairing: local approval queue', () => {
  function controller(): DeviceDescriptor {
    return generateDeviceIdentity({ name: 'Pixel' })
  }

  it('queues a request with its SAS, then approves it', async () => {
    const context = await makeService()
    try {
      const peer = controller()
      const pending = context.service.requestApproval(peer, '123-456')
      assert.equal(pending.request.peer.deviceId, peer.deviceId)
      assert.equal(pending.request.sas, '123-456')

      const queued = context.service.listPending()
      assert.equal(queued.length, 1)
      assert.equal(queued[0]?.requestId, pending.request.requestId)
      assert.equal(context.service.getStatus(pending.request.requestId).state, 'pending')

      const approved = context.service.approve(pending.request.requestId)
      assert.equal(approved?.requestId, pending.request.requestId)
      assert.deepEqual(await pending.decide, { approved: true })
      assert.equal(context.service.getStatus(pending.request.requestId).state, 'approved')
      assert.equal(context.service.listPending().length, 0)
      // The test seam never persisted a peer, so the status has no peer yet.
      assert.equal(context.service.getStatus(pending.request.requestId).peer, undefined)
    } finally {
      await context.cleanup()
    }
  })

  it('refuses restricted scopes and leaves the request pending', async () => {
    const context = await makeService()
    try {
      const pending = context.service.requestApproval(controller(), '555-666')
      for (const scope of [
        { kind: 'view', workspaces: 'all', expiresAt: null },
        { kind: 'control', workspaces: ['ws-a'], expiresAt: null },
      ] as const) {
        assert.throws(
          () => context.service.approve(pending.request.requestId, scope),
          (error: unknown) => error instanceof PairingError && error.code === 'mesh/unsupported',
        )
        assert.equal(context.service.getStatus(pending.request.requestId).state, 'pending')
      }
      assert.equal(context.service.listPending().length, 1)
      assert.ok(context.service.approve(pending.request.requestId))
      assert.deepEqual(await pending.decide, { approved: true })
    } finally {
      await context.cleanup()
    }
  })

  it('denies a request and reports the denial', async () => {
    const context = await makeService()
    try {
      const peer = controller()
      const pending = context.service.requestApproval(peer, '999-000')
      const denied = context.service.deny(pending.request.requestId)
      assert.equal(denied?.requestId, pending.request.requestId)
      assert.deepEqual(await pending.decide, { approved: false })
      assert.equal(context.service.getStatus(pending.request.requestId).state, 'denied')
    } finally {
      await context.cleanup()
    }
  })

  it('auto-denies a request after its TTL', async () => {
    const context = await makeService({ requestTtlMs: 20 })
    try {
      const pending = context.service.requestApproval(controller(), '111-222')
      await new Promise(resolve => setTimeout(resolve, 60))
      assert.deepEqual(await pending.decide, { approved: false })
      assert.equal(context.service.getStatus(pending.request.requestId).state, 'denied')
    } finally {
      await context.cleanup()
    }
  })

  it('auto-approves when the setting is on', async () => {
    const context = await makeService({ autoApprove: () => true })
    try {
      const pending = context.service.requestApproval(controller(), '000-001')
      assert.deepEqual(await pending.decide, { approved: true })
      assert.equal(context.service.getStatus(pending.request.requestId).state, 'approved')
    } finally {
      await context.cleanup()
    }
  })

  it('stops resolving pending requests on shutdown', async () => {
    const context = await makeService()
    try {
      const pending = context.service.requestApproval(controller(), '333-444')
      context.service.stop()
      assert.deepEqual(await pending.decide, { approved: false })
    } finally {
      await context.cleanup()
    }
  })
})

describe('pairing: SAS', () => {
  it('is symmetric, six digits and identical to the channel implementation', () => {
    const controller = generateDeviceIdentity({ name: 'controller' })
    const daemon = generateDeviceIdentity({ name: 'daemon' })
    const handshakeHash = new Uint8Array(32).fill(5)
    const sas = computeSas(handshakeHash, controller.signPk, daemon.signPk)
    assert.match(sas, /^\d{3}-\d{3}$/u)
    assert.equal(sas, computeSas(handshakeHash, daemon.signPk, controller.signPk))
    assert.equal(sas, cryptoComputeSas(handshakeHash, daemon.signPk, controller.signPk))
    assert.notEqual(sas, computeSas(new Uint8Array(32).fill(6), controller.signPk, daemon.signPk))
  })

  it('rejects malformed input', () => {
    assert.throws(() => computeSas(new Uint8Array(31), 'aa', 'bb'))
  })

  it('does not resurrect consumed tokens when another process writes a ticket', async () => {
    const temp = await makeTempDir()
    try {
      // Two independent stores model two DSH host processes sharing $DSH_HOME.
      const storeA = await MeshStore.open({ home: temp.dir })
      const storeB = await MeshStore.open({ home: temp.dir })
      const serviceA = new PairingService({ identity: storeA.getIdentity(), store: storeA })
      const serviceB = new PairingService({ identity: storeB.getIdentity(), store: storeB })
      await serviceA.init()
      await serviceB.init()

      const first = await serviceA.createTicket(ENDPOINTS)
      // B's in-memory snapshot never saw `first`; its locked write must keep it.
      await serviceB.createTicket(ENDPOINTS)

      const inspect = async (): Promise<PairingService> => {
        const store = await MeshStore.open({ home: temp.dir })
        const service = new PairingService({ identity: store.getIdentity(), store })
        await service.init()
        return service
      }
      assert.equal((await inspect()).pendingTicketCount, 2)

      const consumed = await serviceA.beginPairToken(storeA.getIdentity().deviceId, first.ticket.tok)
      assert.equal(consumed.ok, true)

      // B writes again; the consumed token must not come back from B's memory.
      await serviceB.createTicket(ENDPOINTS)
      assert.equal((await inspect()).pendingTicketCount, 2)

      const raw = JSON.parse(await readFile(join(temp.dir, 'pairing.json'), 'utf8')) as {
        tickets: Array<{ hash: string }>
      }
      assert.equal(raw.tickets.some(row => row.hash === hashPairingToken(first.ticket.tok)), false)
    } finally {
      await temp.cleanup()
    }
  })
})
