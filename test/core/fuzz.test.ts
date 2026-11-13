/**
 * Deterministic fuzz / property tests for every parser boundary reachable from
 * the public surface of the Mesh protocol:
 *
 * - `src/host/noise.ts` handshake message parser (`NoiseNkHandshake.readMessage`);
 * - `src/host/session.ts` session frame parser (`MeshSessionImpl.handlePlaintext`);
 * - `src/host/channel.ts` framing + length pre-checks (`acceptMeshChannel`,
 *   `connectMeshChannel` over `MemoryTransport`);
 * - `src/shared/mesh-session.ts` portal WS envelope (`decodeWsMessage`);
 * - `src/shared/protocol.ts` base64url / canonical JSON / UTF-8 helpers.
 *
 * All random inputs come from a fixed-seed PRNG (never `Math.random`), so the
 * generated corpus is reproducible run to run. The assertions check for
 * *behaviour*: a malformed input must either be handled deterministically or
 * be rejected with a typed protocol error (`MeshChannelError`, `MeshRpcError`,
 * `NoiseError`) — never an unexpected exception, crash or hang.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  MAX_MESSAGE_BYTES,
  MAX_STREAM_CHUNK_BYTES,
  canonicalJson,
  decodeUtf8,
  encodeUtf8,
  fromBase64Url,
  toBase64Url,
} from '../../src/shared/protocol.ts'
import type { DeviceDescriptor, DeviceIdentity, PeerRecord } from '../../src/shared/protocol.ts'
import { MeshRpcError, decodeWsMessage, encodeWsMessage } from '../../src/shared/mesh-session.ts'
import type { DaemonSessionHandlers, MeshSession } from '../../src/shared/mesh-session.ts'
import { MeshChannelError, acceptMeshChannel, connectMeshChannel } from '../../src/host/channel.ts'
import { createSession } from '../../src/host/session.ts'
import type { DaemonMeshSession, MeshSessionImpl, SessionBridge } from '../../src/host/session.ts'
import {
  NOISE_DH_LEN,
  NOISE_MAX_HANDSHAKE_MESSAGE,
  NOISE_TAG_LEN,
  NoiseError,
  NoiseNkHandshake,
  generateX25519KeyPair,
} from '../../src/host/noise.ts'
import { deviceDescriptorOf, generateDeviceIdentity } from '../../src/host/crypto.ts'
import { createMemoryTransportPair, flushAsync } from './helpers/memory-transport.ts'
import type { MemoryTransport } from './helpers/memory-transport.ts'

// ---------------------------------------------------------------------------
// Fixed-seed PRNG (mulberry32)
// ---------------------------------------------------------------------------

/** Seed shared by every case; bumping it regenerates the whole corpus. */
const SEED = 0x5eed_1e55

interface Rng {
  next(): number
  int(maxExclusive: number): number
  bytes(length: number): Uint8Array
  ascii(length: number): string
}

const DEFAULT_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_=+/ \u0000\u007fé😀'

function createRng(seed: number): Rng {
  let state = seed >>> 0
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0
    let value = state
    value = Math.imul(value ^ (value >>> 15), value | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 0x1_0000_0000
  }
  const int = (maxExclusive: number): number => Math.floor(next() * maxExclusive)
  const bytes = (length: number): Uint8Array => {
    const out = new Uint8Array(length)
    for (let index = 0; index < length; index += 1) out[index] = int(256)
    return out
  }
  const ascii = (length: number): string => {
    let out = ''
    for (let index = 0; index < length; index += 1) out += DEFAULT_ALPHABET.charAt(int(DEFAULT_ALPHABET.length))
    return out
  }
  return { next, int, bytes, ascii }
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function frameOf(kind: number, body: Uint8Array): Uint8Array {
  const frame = new Uint8Array(1 + body.length)
  frame[0] = kind
  frame.set(body, 1)
  return frame
}

function streamFrame(streamId: number, flags: number, payload: Uint8Array): Uint8Array {
  const frame = new Uint8Array(6 + payload.length)
  frame[0] = 0x11
  const view = new DataView(frame.buffer)
  view.setUint32(1, streamId)
  frame[5] = flags
  frame.set(payload, 6)
  return frame
}

/** Attach a timeout to a promise so a parser hang fails the test quickly. */
async function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not settle within ${ms} ms`)), ms)
    timer.unref?.()
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

type Settled<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: unknown }

async function settle<T>(promise: Promise<T>): Promise<Settled<T>> {
  try {
    return { ok: true, value: await promise }
  } catch (error) {
    return { ok: false, error }
  }
}

// ---------------------------------------------------------------------------
// In-memory session harness (no crypto, exercises the frame parser directly)
// ---------------------------------------------------------------------------

const HARNESS_REMOTE: DeviceDescriptor = {
  deviceId: 'dm_harnesspeer0000000000',
  name: 'harness-peer',
  platform: 'unknown',
  signPk: 'A'.repeat(43),
  dhPk: 'A'.repeat(43),
}

interface SessionHarness {
  readonly session: MeshSessionImpl
  /** Transport close info captured by the bridge (first call wins). */
  closeInfo(): { readonly code: number | undefined; readonly reason: string | undefined }
}

function createHarnessSession(role: 'controller' | 'daemon'): SessionHarness {
  let closeCode: number | undefined
  let closeReason: string | undefined
  const bridge: SessionBridge = {
    role,
    remote: HARNESS_REMOTE,
    sas: undefined,
    pairing: undefined,
    sendPlaintext: () => undefined,
    onTransportClose: () => () => undefined,
    closeTransport: (code, reason) => {
      if (closeCode === undefined) {
        closeCode = code
        closeReason = reason
      }
    },
    bufferedAmount: () => 0,
  }
  return {
    session: createSession(bridge, {
      rpcTimeoutMs: 50,
      // Daemon sessions require handlers; they are inert for this harness.
      ...(role === 'daemon' ? { handlers: daemonHandlers() } : {}),
    }),
    closeInfo: () => ({ code: closeCode, reason: closeReason }),
  }
}

interface FrameOutcome {
  readonly open: boolean
  readonly closeCode: number | undefined
  readonly closeReason: string | undefined
}

/** Feed one plaintext session message; returns the session verdict. */
function runSessionFrame(role: 'controller' | 'daemon', bytes: Uint8Array): FrameOutcome {
  const harness = createHarnessSession(role)
  // Any synchronous throw is a parser bug and must fail the test.
  harness.session.handlePlaintext(bytes)
  const info = harness.closeInfo()
  const outcome: FrameOutcome = { open: harness.session.open, closeCode: info.code, closeReason: info.reason }
  harness.session.close()
  return outcome
}

function expectProtocolClose(outcome: FrameOutcome, expectedReason: RegExp, label: string): void {
  assert.equal(outcome.open, false, `${label}: session must be closed`)
  assert.equal(outcome.closeCode, 4400, `${label}: protocol violations close with 4400`)
  assert.match(outcome.closeReason ?? '', expectedReason, `${label}: stable close reason`)
}

// ---------------------------------------------------------------------------
// Real channel pair fixtures (Noise + application authentication)
// ---------------------------------------------------------------------------

const controllerIdentity: DeviceIdentity = generateDeviceIdentity({ name: 'controller-fuzz', platform: 'darwin' })
const daemonIdentity: DeviceIdentity = generateDeviceIdentity({ name: 'daemon-fuzz', platform: 'linux' })
const daemonDescriptor: DeviceDescriptor = deviceDescriptorOf(daemonIdentity)

function peerRecordOf(identity: DeviceIdentity): PeerRecord {
  return {
    deviceId: identity.deviceId,
    name: identity.name,
    platform: identity.platform,
    signPk: identity.signPk,
    dhPk: identity.dhPk,
    scope: { kind: 'control', workspaces: 'all', expiresAt: null },
    pairedAt: new Date().toISOString(),
    lastSeenAt: null,
    revokedAt: null,
  }
}

function emptyBody(): AsyncIterable<Uint8Array> {
  return (async function* empty(): AsyncGenerator<Uint8Array> {
    // intentionally yields no chunks
  })()
}

function daemonHandlers(): DaemonSessionHandlers {
  return {
    rpc: async method => ({ method }),
    http: async () => ({ status: 200, headers: {}, body: emptyBody() }),
    ws: async () => ({
      inbound: emptyBody(),
      outbound: { write: async () => undefined, end: async () => undefined, abort: async () => undefined },
    }),
  }
}

interface ChannelPair {
  readonly controller: MeshSession
  readonly daemon: DaemonMeshSession
  readonly a: MemoryTransport
  readonly b: MemoryTransport
}

async function establishPair(): Promise<ChannelPair> {
  const transports = createMemoryTransportPair()
  const [controller, daemon] = await Promise.all([
    connectMeshChannel({
      transport: transports.a,
      identity: controllerIdentity,
      daemon: daemonDescriptor,
      appVersion: 'fuzz',
      authTimeoutMs: 2_000,
      session: { rpcTimeoutMs: 500 },
    }),
    acceptMeshChannel({
      transport: transports.b,
      identity: daemonIdentity,
      authenticate: () => ({ kind: 'paired', peer: peerRecordOf(controllerIdentity) }),
      handlers: daemonHandlers(),
      appVersion: 'fuzz',
      authTimeoutMs: 2_000,
      session: { rpcTimeoutMs: 500 },
    }),
  ])
  return { controller, daemon, a: transports.a, b: transports.b }
}

/** Inject one frame into an authenticated daemon channel; returns its close code. */
async function deliverToDaemon(pair: ChannelPair, frame: Uint8Array): Promise<number | undefined> {
  pair.b.deliver(frame)
  await withTimeout(pair.daemon.closed, 3_000, 'channel must close after a malformed frame')
  return pair.b.closeInfo?.code
}

// ---------------------------------------------------------------------------
// Base64url / canonical JSON / UTF-8 helpers
// ---------------------------------------------------------------------------

describe('shared protocol helpers', () => {
  it('fromBase64Url is total and deterministic for arbitrary strings', () => {
    const rng = createRng(SEED ^ 0x60)
    const edges = ['', 'A', '=', 'AA', 'AAA', 'AAAA', 'A'.repeat(86), 'AAAA+AAA', 'AAAA/AAA', '-_-_']
    for (let index = 0; index < 3000; index += 1) {
      const value = index < edges.length ? edges[index] ?? '' : rng.ascii(rng.int(80))
      const first = fromBase64Url(value)
      const second = fromBase64Url(value)
      if (first === undefined) {
        assert.equal(second, undefined, `value #${index} must decode deterministically`)
        continue
      }
      assert.ok(first instanceof Uint8Array, `value #${index} must decode to bytes or undefined`)
      assert.deepEqual(second, first, `value #${index} must decode deterministically`)
      // Only canonical encodings are accepted: re-encoding must be a fixed point.
      assert.equal(toBase64Url(first), value, `value #${index} must be canonical`)
    }
  })

  it('base64url round-trips arbitrary byte arrays', () => {
    const rng = createRng(SEED ^ 0x61)
    for (let index = 0; index < 1000; index += 1) {
      const bytes = rng.bytes(index < 8 ? index : rng.int(64))
      const encoded = toBase64Url(bytes)
      const decoded = fromBase64Url(encoded)
      assert.ok(decoded !== undefined, `bytes #${index} must round-trip`)
      assert.deepEqual(decoded, bytes, `bytes #${index} must round-trip`)
      assert.equal(toBase64Url(decoded), encoded)
    }
  })

  it('canonicalJson is deterministic and independent of object key order', () => {
    const rng = createRng(SEED ^ 0x62)
    const reverseKeys = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(item => reverseKeys(item))
      if (value !== null && typeof value === 'object') {
        const entries = Object.entries(value as Record<string, unknown>).reverse()
        return Object.fromEntries(entries.map(([key, item]): [string, unknown] => [key, reverseKeys(item)]))
      }
      return value
    }
    for (let index = 0; index < 500; index += 1) {
      const value = randomJsonValue(rng, 0)
      const canonical = canonicalJson(value)
      assert.equal(canonicalJson(value), canonical)
      assert.equal(canonicalJson(reverseKeys(value)), canonical)
      assert.deepEqual(JSON.parse(canonical), value)
    }
    // `undefined` object members are dropped before hashing.
    assert.equal(canonicalJson({ b: 1, a: undefined }), '{"b":1}')
  })

  it('UTF-8 decoding is total for arbitrary bytes', () => {
    const rng = createRng(SEED ^ 0x63)
    for (let index = 0; index < 1000; index += 1) {
      const bytes = rng.bytes(rng.int(96))
      const text = decodeUtf8(bytes)
      assert.equal(typeof text, 'string')
      // Re-encoding a decoded string must be idempotent.
      assert.equal(decodeUtf8(encodeUtf8(text)), text)
    }
  })
})

function randomJsonValue(rng: Rng, depth: number): unknown {
  const kind = depth >= 3 ? rng.int(4) : rng.int(6)
  if (kind === 0) return null
  if (kind === 1) return rng.int(2) === 0
  if (kind === 2) return rng.int(2_000_001) - 1_000_000
  if (kind === 3) return rng.ascii(rng.int(13))
  if (kind === 4) {
    const length = rng.int(4)
    const items: unknown[] = []
    for (let index = 0; index < length; index += 1) items.push(randomJsonValue(rng, depth + 1))
    return items
  }
  const keys = ['a', 'b', 'c', 'z', 'aa', '0', '_', 'key']
  const record: Record<string, unknown> = {}
  const count = rng.int(4)
  for (let index = 0; index < count; index += 1) {
    record[keys[rng.int(keys.length)] ?? 'a'] = randomJsonValue(rng, depth + 1)
  }
  return record
}

// ---------------------------------------------------------------------------
// Portal WebSocket envelope
// ---------------------------------------------------------------------------

describe('portal WebSocket envelope', () => {
  it('decodeWsMessage is total, deterministic and falls back to binary for unknown kinds', () => {
    const rng = createRng(SEED ^ 0x70)
    const boundaries = [
      0,
      1,
      2,
      MAX_STREAM_CHUNK_BYTES - 1,
      MAX_STREAM_CHUNK_BYTES,
      MAX_STREAM_CHUNK_BYTES + 1,
      MAX_MESSAGE_BYTES - 1,
      MAX_MESSAGE_BYTES,
      MAX_MESSAGE_BYTES + 1,
    ]
    for (let index = 0; index < 3000; index += 1) {
      const length = index < boundaries.length ? boundaries[index] ?? 0 : rng.int(96)
      const message = rng.bytes(length)
      if (message.length > 0 && index % 4 === 0) message[0] = rng.int(4)
      const first = decodeWsMessage(message)
      const second = decodeWsMessage(message)
      assert.deepEqual(first, second, `message #${index} must decode deterministically`)
      assert.ok(first.kind === 'text' || first.kind === 'binary')
      const tag = message[0]
      if (tag === 0) {
        assert.equal(first.kind, 'text')
        assert.equal(first.compressed, false)
        assert.equal(first.payload.length, message.length - 1)
        assert.deepEqual(first.payload, message.subarray(1))
      } else if (tag === 1) {
        assert.equal(first.kind, 'binary')
        assert.equal(first.compressed, false)
        assert.deepEqual(first.payload, message.subarray(1))
      } else if (tag === 2) {
        assert.equal(first.kind, 'text')
        assert.equal(first.compressed, true)
        assert.deepEqual(first.payload, message.subarray(1))
      } else if (tag === 3) {
        assert.equal(first.kind, 'binary')
        assert.equal(first.compressed, true)
        assert.deepEqual(first.payload, message.subarray(1))
      } else {
        // Absent/unknown kind byte: legacy unframed binary, payload unchanged.
        assert.equal(first.kind, 'binary')
        assert.equal(first.compressed, false)
        assert.equal(first.payload.length, message.length)
        assert.deepEqual(first.payload, message)
      }
    }
  })

  it('encodeWsMessage round-trips payload boundaries', () => {
    const boundaries = [0, 1, 2, MAX_STREAM_CHUNK_BYTES, MAX_MESSAGE_BYTES]
    for (const length of boundaries) {
      const payload = new Uint8Array(length)
      payload.fill(0xa5)
      for (const kind of ['text', 'binary'] as const) {
        for (const compressed of [false, true]) {
          const encoded = encodeWsMessage(payload, kind, compressed)
          assert.equal(encoded.length, length + 1)
          assert.equal(encoded[0], (kind === 'text' ? 0 : 1) + (compressed ? 2 : 0))
          const decoded = decodeWsMessage(encoded)
          assert.equal(decoded.kind, kind)
          assert.equal(decoded.compressed, compressed)
          assert.deepEqual(decoded.payload, payload)
        }
      }
    }
  })
})

// ---------------------------------------------------------------------------
// Noise handshake message parser
// ---------------------------------------------------------------------------

describe('noise handshake message parser', () => {
  const staticKeys = generateX25519KeyPair()
  const makeResponder = (): NoiseNkHandshake => {
    return new NoiseNkHandshake({ role: 'responder', localStaticPrivateKey: staticKeys.privateKey })
  }
  const validCodes = new Set<string>([
    'noise/invalid-key',
    'noise/invalid-state',
    'noise/invalid-message',
    'noise/decrypt-failed',
    'noise/nonce-exhausted',
    'noise/peer-key',
  ])
  const boundaryLengths = [0, 1, 15, 16, 17, 31, 32, 33, 47, 48, 49, 63, 64, 65, 128, 512, 4096]

  it('random byte strings only ever raise a typed NoiseError', () => {
    const rng = createRng(SEED ^ 0x80)
    for (let index = 0; index < 2000; index += 1) {
      let length: number
      if (index < boundaryLengths.length) length = boundaryLengths[index] ?? 0
      else if (index % 17 === 0) length = NOISE_MAX_HANDSHAKE_MESSAGE + 1 + rng.int(100)
      else length = rng.int(200)
      const message = rng.bytes(length)
      const responder = makeResponder()
      try {
        const payload = responder.readMessage(message)
        // Random ciphertext authenticating is cryptographically impossible.
        assert.fail(`message #${index} unexpectedly parsed (payload ${payload.length} bytes)`)
      } catch (error) {
        assert.ok(error instanceof NoiseError, `message #${index} leaked ${String(error)}`)
        assert.ok(validCodes.has(error.code), `message #${index} raised an unknown code: ${error.code}`)
        assert.equal(responder.complete, false)
      }
    }
  })

  it('handshake messages above the 4 KiB cap are rejected before decryption', () => {
    const lengths = [NOISE_MAX_HANDSHAKE_MESSAGE + 1, NOISE_MAX_HANDSHAKE_MESSAGE * 2, MAX_MESSAGE_BYTES, MAX_MESSAGE_BYTES + 1]
    for (const length of lengths) {
      assert.throws(
        () => makeResponder().readMessage(new Uint8Array(length)),
        (error: unknown) => error instanceof NoiseError && error.code === 'noise/invalid-message',
        `length ${length} must be rejected`,
      )
    }
  })

  it('writeMessage enforces the handshake message size boundary', () => {
    const makeInitiator = (): NoiseNkHandshake => {
      return new NoiseNkHandshake({ role: 'initiator', remoteStaticPublicKey: staticKeys.publicKey })
    }
    const maxPayload = NOISE_MAX_HANDSHAKE_MESSAGE - NOISE_DH_LEN - NOISE_TAG_LEN
    const exact = makeInitiator().writeMessage(new Uint8Array(maxPayload))
    assert.equal(exact.length, NOISE_MAX_HANDSHAKE_MESSAGE)
    assert.throws(
      () => makeInitiator().writeMessage(new Uint8Array(maxPayload + 1)),
      (error: unknown) => error instanceof NoiseError && error.code === 'noise/invalid-message',
    )
  })
})

// ---------------------------------------------------------------------------
// Session frame parser (handlePlaintext)
// ---------------------------------------------------------------------------

/** Arbitrary structured frame: control, stream, or pure random bytes. */
function randomSessionFrame(rng: Rng): Uint8Array {
  const roll = rng.int(10)
  if (roll < 3) {
    const bodies = [
      '',
      '{}',
      '[]',
      'null',
      '0',
      '"x"',
      '{"ping":1}',
      '{"pong":1}',
      '{"event":"e","data":{"n":1}}',
      '{"id":1,"method":"info"}',
      '{"id":1,"result":null}',
      '{"id":1,"error":{"code":"mesh/x","message":"m"}}',
      '{"id":-1,"method":""}',
      '{"id":1.5,"method":"x"}',
      '{"id":1,"method":"x"',
      '{"event":42}',
      '{"ping":"x"}',
      '{"result":1}',
      '{"ping":1e999}',
    ]
    const body = rng.int(2) === 0 ? bodies[rng.int(bodies.length)] ?? '' : rng.ascii(rng.int(24))
    return frameOf(0x10, encodeUtf8(body))
  }
  if (roll < 7) {
    const flagPool = [0x01, 0x02, 0x03, 0x04, 0x06, 0x08, 0x09, 0x00, 0x10, 0xff]
    const flags = rng.int(3) === 0 ? flagPool[rng.int(flagPool.length)] ?? 0 : rng.int(256)
    const idPool = [0, 1, 2, 3, 0x7fffffff, 0x80000000, 0xffffffff]
    const streamId = rng.int(4) === 0 ? idPool[rng.int(idPool.length)] ?? 0 : rng.int(0x1_0000_0000)
    const payloadPool = [0, 1, 2, 5, 6, MAX_STREAM_CHUNK_BYTES - 1, MAX_STREAM_CHUNK_BYTES, MAX_STREAM_CHUNK_BYTES + 1]
    const payloadLength = rng.int(4) === 0 ? payloadPool[rng.int(payloadPool.length)] ?? 0 : rng.int(48)
    return streamFrame(streamId, flags, rng.bytes(payloadLength))
  }
  return rng.bytes(rng.int(72))
}

describe('session frame parser', () => {
  it('arbitrary byte strings never throw and yield deterministic verdicts', () => {
    const rng = createRng(SEED ^ 0x40)
    const lengths = [0, 1, 2, 3, 5, 6, 7, 16, 64, 128, 4096]
    for (let index = 0; index < 2000; index += 1) {
      const length = index % 6 === 0 ? lengths[index % lengths.length] ?? 0 : rng.int(80)
      const bytes = rng.bytes(length)
      const first = runSessionFrame('controller', bytes)
      const second = runSessionFrame('controller', bytes)
      assert.deepEqual(first, second, `bytes #${index} must decode deterministically`)
      if (!first.open) {
        expectProtocolClose(first, /^mesh\/bad-request/u, `bytes #${index}`)
      }
    }
  })

  it('structured random control/stream frames never throw and reject deterministically', () => {
    const rng = createRng(SEED ^ 0x30)
    for (let index = 0; index < 3000; index += 1) {
      const frame = randomSessionFrame(rng)
      for (const role of ['controller', 'daemon'] as const) {
        const first = runSessionFrame(role, frame)
        const second = runSessionFrame(role, frame)
        assert.deepEqual(first, second, `frame #${index} (${role}) must decode deterministically`)
        if (!first.open) expectProtocolClose(first, /^mesh\/bad-request/u, `frame #${index} (${role})`)
      }
    }
  })

  it('reserved stream flags and malformed headers close with stable reasons', () => {
    const headerOnly = (flags: number): Uint8Array => streamFrame(2, flags, new Uint8Array(0))
    expectProtocolClose(runSessionFrame('daemon', new Uint8Array(0)), /empty session message/u, 'empty')
    expectProtocolClose(runSessionFrame('daemon', new Uint8Array([0x99])), /unknown session message type/u, 'kind')
    expectProtocolClose(runSessionFrame('daemon', new Uint8Array([0x11, 0, 1])), /stream frame too short/u, 'short')
    expectProtocolClose(runSessionFrame('daemon', frameOf(0x10, encodeUtf8('{'))), /invalid control JSON/u, 'json')
    expectProtocolClose(runSessionFrame('daemon', headerOnly(0x10)), /unknown stream flags/u, 'reserved flag')
    expectProtocolClose(runSessionFrame('daemon', headerOnly(0x06)), /end and abort at once/u, 'end+abort')
    expectProtocolClose(runSessionFrame('daemon', headerOnly(0x08)), /without data\/end\/abort/u, 'message-end only')
    // Valid framing on an unknown stream id is ignored (isolation), not an error.
    const ignored = runSessionFrame('daemon', headerOnly(0x01))
    assert.equal(ignored.open, true)
  })

  it('stream payload boundaries honour MAX_STREAM_CHUNK_BYTES', () => {
    const atCap = streamFrame(2, 0x01, new Uint8Array(MAX_STREAM_CHUNK_BYTES))
    assert.equal(runSessionFrame('daemon', atCap).open, true)
    const overCap = streamFrame(2, 0x01, new Uint8Array(MAX_STREAM_CHUNK_BYTES + 1))
    expectProtocolClose(runSessionFrame('daemon', overCap), /stream chunk too large/u, 'cap+1')
    const overMessage = streamFrame(2, 0x01, new Uint8Array(MAX_MESSAGE_BYTES))
    expectProtocolClose(runSessionFrame('daemon', overMessage), /stream chunk too large/u, 'message bytes')
  })

  it('control messages honour the MAX_MESSAGE_BYTES cap at the exact boundary', async () => {
    const overhead = 1 + encodeUtf8(JSON.stringify({ id: 1, method: 'echo', params: '' })).length
    const maxParams = MAX_MESSAGE_BYTES - overhead
    const atCap = createHarnessSession('controller')
    // Exactly at the cap the frame is accepted and waits for a reply (timeout).
    await assert.rejects(
      atCap.session.rpc('echo', 'x'.repeat(maxParams)),
      (error: unknown) => error instanceof MeshRpcError && error.code === 'mesh/internal',
    )
    atCap.session.close()

    const overCap = createHarnessSession('controller')
    await assert.rejects(overCap.session.rpc('echo', 'x'.repeat(maxParams + 1)), (error: unknown) => {
      return error instanceof MeshRpcError && error.code === 'mesh/bad-request' && /too large/u.test(error.message)
    })
    overCap.session.close()
  })

  it('rpc rejects malformed methods with a typed MeshRpcError, never synchronously throwing', async () => {
    const rng = createRng(SEED ^ 0x50)
    const harness = createHarnessSession('controller')
    const attempts: Promise<unknown>[] = []
    const boundaryMethods = [0, 1, 2, 127, 128, 129]
    for (let index = 0; index < 500; index += 1) {
      const length = index < boundaryMethods.length ? boundaryMethods[index] ?? 0 : rng.int(160)
      const method = rng.ascii(length)
      let attempt: Promise<unknown>
      try {
        attempt = harness.session.rpc(method)
      } catch (error) {
        assert.fail(`rpc threw synchronously for method #${index}: ${String(error)}`)
      }
      attempts.push(attempt.catch((error: unknown) => error))
    }
    const results = await Promise.all(attempts)
    for (const result of results) {
      if (!(result instanceof Error)) continue
      assert.ok(result instanceof MeshRpcError, `unexpected rejection type: ${String(result)}`)
      assert.ok(
        result.code === 'mesh/bad-request' || result.code === 'mesh/internal',
        `unexpected MeshRpcError code: ${result.code}`,
      )
    }
    harness.session.close()
  })
})

// ---------------------------------------------------------------------------
// Channel framing and length pre-checks (pre-handshake)
// ---------------------------------------------------------------------------

describe('channel framing pre-checks', () => {
  it('arbitrary first frames are rejected as MeshChannelError, never hang', async () => {
    const rng = createRng(SEED ^ 0x10)
    const frameLengths = [
      0,
      1,
      2,
      15,
      16,
      31,
      32,
      33,
      47,
      48,
      49,
      64,
      128,
      512,
      NOISE_MAX_HANDSHAKE_MESSAGE,
      NOISE_MAX_HANDSHAKE_MESSAGE + 1,
      5000,
      MAX_MESSAGE_BYTES,
      MAX_MESSAGE_BYTES + 1,
    ]
    const acceptedCodes = new Set(['mesh/bad-request', 'mesh/crypto'])
    for (let index = 0; index < 120; index += 1) {
      const length = frameLengths[index % frameLengths.length] ?? 0
      const frame = rng.bytes(length)
      if (index % 3 !== 0 && frame.length > 0) frame[0] = 0x01
      const transports = createMemoryTransportPair()
      const acceptance = acceptMeshChannel({
        transport: transports.b,
        identity: daemonIdentity,
        authenticate: () => ({ kind: 'paired', peer: peerRecordOf(controllerIdentity) }),
        handlers: daemonHandlers(),
        appVersion: 'fuzz',
        authTimeoutMs: 2_000,
      })
      transports.b.deliver(frame)
      const outcome = await withTimeout(settle(acceptance), 2_000, 'pre-handshake rejection')
      assert.equal(outcome.ok, false, `first frame #${index} must be rejected`)
      if (outcome.ok) continue
      assert.ok(outcome.error instanceof MeshChannelError, `frame #${index} leaked ${String(outcome.error)}`)
      assert.ok(acceptedCodes.has(outcome.error.code), `frame #${index} raised an unknown code: ${outcome.error.code}`)
      await flushAsync(1)
      const closeCode = transports.b.closeInfo?.code
      assert.ok(closeCode === 4400 || closeCode === 4401, `frame #${index} closed with ${String(closeCode)}`)
    }
  })
})

// ---------------------------------------------------------------------------
// Channel framing after authentication (sealed frames)
// ---------------------------------------------------------------------------

describe('authenticated channel framing', () => {
  it('random post-handshake frames close with 4400/4401 and never hang', async () => {
    const rng = createRng(SEED ^ 0x20)
    const lengths = [
      0,
      1,
      15,
      16,
      17,
      64,
      512,
      4096,
      MAX_MESSAGE_BYTES,
      MAX_MESSAGE_BYTES + NOISE_TAG_LEN,
      MAX_MESSAGE_BYTES + NOISE_TAG_LEN + 1,
    ]
    const acceptedCodes = new Set([4400, 4401])
    for (let index = 0; index < 24; index += 1) {
      const pair = await establishPair()
      try {
        const length = lengths[index % lengths.length] ?? 0
        const frame = rng.bytes(length + 1)
        const kindRoll = rng.int(4)
        if (kindRoll !== 0 && frame.length > 0) frame[0] = kindRoll === 1 ? 0x02 : rng.int(2) === 0 ? 0x01 : 0x11
        const closeCode = await deliverToDaemon(pair, frame)
        assert.ok(acceptedCodes.has(closeCode ?? -1), `frame #${index} closed with ${String(closeCode)}`)
        assert.equal(pair.daemon.open, false)
      } finally {
        pair.controller.close()
        pair.daemon.close()
      }
    }
  })

  it('sealed frame length boundaries: MAX+TAG fails auth, +1 is a length error', async () => {
    const authFailure = await establishPair()
    try {
      const frame = new Uint8Array(1 + MAX_MESSAGE_BYTES + NOISE_TAG_LEN)
      frame[0] = 0x02
      assert.equal(await deliverToDaemon(authFailure, frame), 4401)
    } finally {
      authFailure.controller.close()
      authFailure.daemon.close()
    }

    const lengthError = await establishPair()
    try {
      const frame = new Uint8Array(1 + MAX_MESSAGE_BYTES + NOISE_TAG_LEN + 1)
      frame[0] = 0x02
      assert.equal(await deliverToDaemon(lengthError, frame), 4400)
    } finally {
      lengthError.controller.close()
      lengthError.daemon.close()
    }

    const emptyCiphertext = await establishPair()
    try {
      assert.equal(await deliverToDaemon(emptyCiphertext, new Uint8Array([0x02])), 4400)
    } finally {
      emptyCiphertext.controller.close()
      emptyCiphertext.daemon.close()
    }
  })
})
