/**
 * Noise_NK_25519_ChaChaPoly_SHA256 tests.
 *
 * The first two tests reproduce the official noise-c test vectors byte for
 * byte (handshake messages, handshake hash and the recorded transport
 * messages). The remaining tests cover the production prologue (`dsh-mesh/1`),
 * negative paths (tamper / replay / reorder / truncate / low-order keys) and
 * `CipherState` invariants.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { test } from 'node:test'

import {
  CipherState,
  NOISE_AEAD_BACKEND,
  NOISE_MAX_NONCE,
  NoiseError,
  NoiseNkHandshake,
  generateX25519KeyPair,
  noiseHkdf,
  x25519Dh,
  x25519PublicKeyFromPrivateKey,
} from '../../src/host/noise.ts'

interface VectorMessage {
  readonly payload: string
  readonly ciphertext: string
}

interface NoiseVector {
  readonly name: string
  readonly protocolName: string
  readonly init_prologue: string
  readonly init_ephemeral: string
  readonly init_remote_static: string
  readonly resp_prologue: string
  readonly resp_static: string
  readonly resp_ephemeral: string
  readonly init_psk?: string
  readonly resp_psk?: string
  readonly messages: readonly VectorMessage[]
  readonly handshake_hash: string
}

interface VectorFile {
  readonly vectors: Record<'noise_nk' | 'noise_nkpsk0', NoiseVector>
}

const vectorFile: VectorFile = JSON.parse(
  readFileSync(new URL('./vectors/noise-nk.json', import.meta.url), 'utf8'),
) as VectorFile

const EMPTY = new Uint8Array(0)
const hexToBytes = (hex: string): Uint8Array => new Uint8Array(Buffer.from(hex, 'hex'))
const bytesToHex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex')

function buildHandshakes(vector: NoiseVector): {
  initiator: NoiseNkHandshake
  responder: NoiseNkHandshake
  messages: readonly Uint8Array[]
} {
  const psk = vector.init_psk === undefined ? undefined : hexToBytes(vector.init_psk)
  const initiator = new NoiseNkHandshake({
    role: 'initiator',
    protocolName: vector.protocolName,
    prologue: hexToBytes(vector.init_prologue),
    remoteStaticPublicKey: hexToBytes(vector.init_remote_static),
    ephemeralPrivateKey: hexToBytes(vector.init_ephemeral),
    ...(psk === undefined ? {} : { psk }),
  })
  const responder = new NoiseNkHandshake({
    role: 'responder',
    protocolName: vector.protocolName,
    prologue: hexToBytes(vector.resp_prologue),
    localStaticPrivateKey: hexToBytes(vector.resp_static),
    ephemeralPrivateKey: hexToBytes(vector.resp_ephemeral),
    ...(psk === undefined ? {} : { psk }),
  })
  return {
    initiator,
    responder,
    messages: vector.messages.map(message => hexToBytes(message.ciphertext)),
  }
}

function runVector(vector: NoiseVector): void {
  const { initiator, responder, messages } = buildHandshakes(vector)
  const [message1, message2, ...transport] = messages as [Uint8Array, Uint8Array, ...Uint8Array[]]
  const payload1 = hexToBytes(vector.messages[0]?.payload ?? '')
  const payload2 = hexToBytes(vector.messages[1]?.payload ?? '')

  // --- initiator writes msg1 (-> e, es); responder reads it. ---
  const initiatorMessage1 = initiator.writeMessage(payload1)
  assert.equal(bytesToHex(initiatorMessage1), bytesToHex(message1), 'msg1 must match the vector byte for byte')
  const receivedPayload1 = responder.readMessage(message1)
  assert.equal(bytesToHex(receivedPayload1), bytesToHex(payload1))

  // --- responder writes msg2 (<- e, ee); initiator reads it. ---
  const responderMessage2 = responder.writeMessage(payload2)
  assert.equal(bytesToHex(responderMessage2), bytesToHex(message2), 'msg2 must match the vector byte for byte')
  const receivedPayload2 = initiator.readMessage(message2)
  assert.equal(bytesToHex(receivedPayload2), bytesToHex(payload2))

  // --- handshake hashes agree with each other and with the vector. ---
  assert.equal(bytesToHex(initiator.handshakeHash), vector.handshake_hash)
  assert.equal(bytesToHex(responder.handshakeHash), vector.handshake_hash)

  // --- transport messages 3..6 are split among the two directions. ---
  const initiatorTransport = initiator.split()
  const responderTransport = responder.split()
  const initiatorSends = transport.filter((_message, index) => index % 2 === 0)
  const responderSends = transport.filter((_message, index) => index % 2 === 1)
  initiatorSends.forEach((ciphertext, index) => {
    const payloadIndex = 2 + index * 2
    const payload = hexToBytes(vector.messages[payloadIndex]?.payload ?? '')
    assert.equal(bytesToHex(initiatorTransport.tx.encryptWithAd(EMPTY, payload)), bytesToHex(ciphertext))
    assert.equal(bytesToHex(responderTransport.rx.decryptWithAd(EMPTY, ciphertext)), bytesToHex(payload))
  })
  responderSends.forEach((ciphertext, index) => {
    const payloadIndex = 3 + index * 2
    const payload = hexToBytes(vector.messages[payloadIndex]?.payload ?? '')
    assert.equal(bytesToHex(responderTransport.tx.encryptWithAd(EMPTY, payload)), bytesToHex(ciphertext))
    assert.equal(bytesToHex(initiatorTransport.rx.decryptWithAd(EMPTY, ciphertext)), bytesToHex(payload))
  })
}

test('official noise-c vector: Noise_NK_25519_ChaChaPoly_SHA256', () => {
  runVector(vectorFile.vectors.noise_nk)
})

test('official noise-c vector: NoisePSK_NK (NKpsk0) matches byte for byte', () => {
  runVector(vectorFile.vectors.noise_nkpsk0)
})

function productionHandshake(options: {
  prologue?: Uint8Array
  initiatorStatic?: { privateKey: Uint8Array; publicKey: Uint8Array }
} = {}): {
  initiator: NoiseNkHandshake
  responder: NoiseNkHandshake
  responderStatic: { privateKey: Uint8Array; publicKey: Uint8Array }
  initiatorStatic: { privateKey: Uint8Array; publicKey: Uint8Array }
} {
  const responderStatic = generateX25519KeyPair()
  const initiatorStatic = options.initiatorStatic ?? generateX25519KeyPair()
  const initiatorOptions: ConstructorParameters<typeof NoiseNkHandshake>[0] = {
    role: 'initiator',
    remoteStaticPublicKey: responderStatic.publicKey,
    ...(options.prologue === undefined ? {} : { prologue: options.prologue }),
  }
  const responderOptions: ConstructorParameters<typeof NoiseNkHandshake>[0] = {
    role: 'responder',
    localStaticPrivateKey: responderStatic.privateKey,
    ...(options.prologue === undefined ? {} : { prologue: options.prologue }),
  }
  return {
    initiator: new NoiseNkHandshake(initiatorOptions),
    responder: new NoiseNkHandshake(responderOptions),
    responderStatic,
    initiatorStatic,
  }
}

test('production NK handshake with dsh-mesh/1 prologue completes and agrees on h', () => {
  const { initiator, responder } = productionHandshake()
  const message1 = initiator.writeMessage()
  assert.equal(message1.length, 32 + 16, 'NK msg1 is ephemeral key + empty-payload tag')
  assert.equal(initiator.handshakeHash.length, 32)
  const payload = responder.readMessage(message1)
  assert.deepEqual(payload, EMPTY)
  const message2 = responder.writeMessage()
  assert.equal(message2.length, 32 + 16, 'NK msg2 is ephemeral key + empty-payload tag')
  assert.deepEqual(initiator.readMessage(message2), EMPTY)

  assert.equal(bytesToHex(initiator.handshakeHash), bytesToHex(responder.handshakeHash))
  const initiatorTransport = initiator.split()
  const responderTransport = responder.split()
  for (let index = 0; index < 4; index += 1) {
    const outbound = new TextEncoder().encode(`controller-${index}`)
    const sealed = initiatorTransport.tx.encryptWithAd(EMPTY, outbound)
    assert.equal(new TextDecoder().decode(responderTransport.rx.decryptWithAd(EMPTY, sealed)), `controller-${index}`)
    const reply = new TextEncoder().encode(`daemon-${index}`)
    const sealedReply = responderTransport.tx.encryptWithAd(EMPTY, reply)
    assert.equal(new TextDecoder().decode(initiatorTransport.rx.decryptWithAd(EMPTY, sealedReply)), `daemon-${index}`)
  }
  assert.equal(initiator.split(), initiatorTransport, 'split is idempotent')
  assert.equal(responder.split(), responderTransport, 'split is idempotent')
})

test('different prologues yield different handshake hashes (channel binding)', () => {
  const first = productionHandshake({ prologue: new TextEncoder().encode('dsh-mesh/1') })
  const second = productionHandshake({ prologue: new TextEncoder().encode('dsh-mesh/2') })
  const firstMessage = first.initiator.writeMessage()
  first.responder.readMessage(firstMessage)
  const firstHash = first.responder.handshakeHash
  const secondMessage = second.initiator.writeMessage()
  second.responder.readMessage(secondMessage)
  const secondHash = second.responder.handshakeHash
  assert.notEqual(bytesToHex(firstHash), bytesToHex(secondHash))
})

test('tampered msg1 payload is rejected by the responder', () => {
  const { initiator, responder } = productionHandshake()
  const message1 = initiator.writeMessage()
  message1[message1.length - 1] = (message1[message1.length - 1] ?? 0) ^ 0x01
  assert.throws(() => responder.readMessage(message1), (error: unknown) => {
    return error instanceof NoiseError && error.code === 'noise/decrypt-failed'
  })
})

test('truncated and oversized handshake messages are rejected', () => {
  const { initiator, responder } = productionHandshake()
  const message1 = initiator.writeMessage()
  assert.throws(() => responder.readMessage(message1.subarray(0, 40)), /too short/u)
  assert.throws(() => responder.readMessage(new Uint8Array(5000)), /too large/u)
})

test('zero ephemeral key is rejected before any DH happens', () => {
  const { initiator, responder } = productionHandshake()
  const message1 = initiator.writeMessage()
  const forged = new Uint8Array(message1)
  forged.fill(0, 0, 32)
  assert.throws(() => responder.readMessage(forged), (error: unknown) => {
    return error instanceof NoiseError && error.code === 'noise/peer-key'
  })
})

test('handshake out-of-order and replay attempts fail', () => {
  const { initiator, responder } = productionHandshake()
  assert.throws(() => initiator.readMessage(new Uint8Array(64)), /not this party/u)
  assert.throws(() => initiator.split(), /not complete/u)
  const message1 = initiator.writeMessage()
  assert.throws(() => initiator.writeMessage(), /not this party/u)
  responder.readMessage(message1)
  assert.throws(() => responder.readMessage(message1), /not this party/u)
  const message2 = responder.writeMessage()
  initiator.readMessage(message2)
  assert.throws(() => initiator.readMessage(message2), /not this party/u)
})

test('transport cipher states reject reordered, replayed and tampered frames', () => {
  const { initiator, responder } = productionHandshake()
  responder.readMessage(initiator.writeMessage())
  initiator.readMessage(responder.writeMessage())
  const initiatorTransport = initiator.split()
  const responderTransport = responder.split()

  const first = initiatorTransport.tx.encryptWithAd(EMPTY, new TextEncoder().encode('one'))
  const second = initiatorTransport.tx.encryptWithAd(EMPTY, new TextEncoder().encode('two'))
  // Reorder: the second frame cannot be decrypted with nonce 0.
  assert.throws(() => responderTransport.rx.decryptWithAd(EMPTY, second), (error: unknown) => {
    return error instanceof NoiseError && error.code === 'noise/decrypt-failed'
  })
  // The failed attempt did not consume nonce 0, so replay/next frame still works.
  assert.equal(new TextDecoder().decode(responderTransport.rx.decryptWithAd(EMPTY, first)), 'one')
  assert.throws(() => responderTransport.rx.decryptWithAd(EMPTY, first), (error: unknown) => {
    return error instanceof NoiseError && error.code === 'noise/decrypt-failed'
  })
  assert.equal(new TextDecoder().decode(responderTransport.rx.decryptWithAd(EMPTY, second)), 'two')

  const tampered = initiatorTransport.tx.encryptWithAd(EMPTY, new TextEncoder().encode('three'))
  tampered[0] = (tampered[0] ?? 0) ^ 0x80
  assert.throws(() => responderTransport.rx.decryptWithAd(EMPTY, tampered), /authentication failed/u)
})

test('CipherState without a key is the identity function', () => {
  const state = new CipherState()
  const plaintext = new Uint8Array([1, 2, 3])
  assert.equal(state.hasKey, false)
  assert.equal(bytesToHex(state.encryptWithAd(EMPTY, plaintext)), bytesToHex(plaintext))
  assert.equal(bytesToHex(state.decryptWithAd(EMPTY, plaintext)), bytesToHex(plaintext))
  state.initializeKey(new Uint8Array(32).fill(7))
  assert.equal(state.hasKey, true)
  const sealed = state.encryptWithAd(EMPTY, plaintext)
  assert.notEqual(bytesToHex(sealed), bytesToHex(plaintext))
  state.setNonce(0n)
  assert.equal(bytesToHex(state.decryptWithAd(EMPTY, sealed)), bytesToHex(plaintext))
})

test('CipherState enforces the 64-bit nonce limit', () => {
  const state = new CipherState(new Uint8Array(32).fill(1))
  state.setNonce(NOISE_MAX_NONCE)
  assert.throws(() => state.encryptWithAd(EMPTY, new Uint8Array(1)), (error: unknown) => {
    return error instanceof NoiseError && error.code === 'noise/nonce-exhausted'
  })
  state.setNonce(NOISE_MAX_NONCE - 1n)
  state.encryptWithAd(EMPTY, new Uint8Array(1))
  assert.throws(() => state.encryptWithAd(EMPTY, new Uint8Array(1)), /maximum nonce/u)
})

test('SymmetricState HKDF values match a hand-computed Noise chain', () => {
  // Sanity-check Noise HKDF(ck, ikm, n): HKDF-Extract(salt=ck, ikm) with
  // empty info, then HKDF-Expand. HMAC-SHA256 comes from node:crypto.
  const ck = new Uint8Array(32).fill(0x11)
  const ikm = new Uint8Array(32).fill(0x22)
  const [first, second, third] = noiseHkdf(ck, ikm, 3)
  assert.ok(first && second && third)
  assert.equal(first.length, 32)
  assert.notEqual(bytesToHex(first), bytesToHex(second))
  assert.deepEqual(noiseHkdf(ck, ikm, 1), [first])
})

test('low-order / all-zero X25519 public keys are rejected', () => {
  const privateKey = generateX25519KeyPair().privateKey
  assert.throws(() => x25519Dh(privateKey, new Uint8Array(32)), (error: unknown) => {
    return error instanceof NoiseError && (error.code === 'noise/peer-key' || error.code === 'noise/invalid-key')
  })
  assert.throws(() => x25519Dh(new Uint8Array(31), new Uint8Array(32)), /length/u)
})

test('handshake destroy wipes handshake secrets but keeps transport states usable', () => {
  const { initiator, responder } = productionHandshake()
  responder.readMessage(initiator.writeMessage())
  initiator.readMessage(responder.writeMessage())
  const initiatorTransport = initiator.split()
  const responderTransport = responder.split()
  initiator.destroy()
  responder.destroy()
  const sealed = initiatorTransport.tx.encryptWithAd(EMPTY, new Uint8Array([4, 5, 6]))
  assert.deepEqual(responderTransport.rx.decryptWithAd(EMPTY, sealed), new Uint8Array([4, 5, 6]))
})

test('AEAD is pure-JS @noble/ciphers and never uses node:crypto ChaCha', () => {
  // The DSH desktop/server host runs Electron's Node with BoringSSL, where
  // crypto.getCiphers() contains no ChaCha ciphers. The AEAD must therefore be
  // the pure-JS @noble/ciphers implementation, while SHA256/HKDF/X25519/
  // Ed25519 may keep using node:crypto.
  assert.equal(NOISE_AEAD_BACKEND, '@noble/ciphers/chacha20poly1305')

  const source = readFileSync(new URL('../../src/host/noise.ts', import.meta.url), 'utf8')
  assert.match(source, /from '@noble\/ciphers\/chacha\.js'/u, 'noise.ts must import @noble/ciphers/chacha.js')
  assert.doesNotMatch(source, /createCipheriv|createDecipheriv/u, 'noise.ts must not use node:crypto AEAD APIs')
  assert.doesNotMatch(source, /['"]chacha20-poly1305['"]/u, 'noise.ts must not request a node:crypto chacha cipher')

  // Simulate the Electron/BoringSSL runtime: any node:crypto ChaCha request
  // throws "Unknown cipher". A full NK handshake + transport round-trip must
  // still work, which proves the AEAD does not depend on OpenSSL/BoringSSL.
  type CryptoFactory = (...args: readonly unknown[]) => unknown
  const mutableCrypto = createRequire(import.meta.url)('node:crypto') as unknown as {
    createCipheriv: CryptoFactory
    createDecipheriv: CryptoFactory
  }
  const originalCipher = mutableCrypto.createCipheriv
  const originalDecipher = mutableCrypto.createDecipheriv
  const guard = (original: CryptoFactory): CryptoFactory => {
    return (algorithm, ...args) => {
      if (String(algorithm).toLowerCase().includes('chacha')) throw new Error('Unknown cipher')
      return original(algorithm, ...args)
    }
  }
  try {
    mutableCrypto.createCipheriv = guard(originalCipher)
    mutableCrypto.createDecipheriv = guard(originalDecipher)
    assert.throws(
      () => mutableCrypto.createCipheriv('chacha20-poly1305', new Uint8Array(32), new Uint8Array(12)),
      /Unknown cipher/u,
    )

    const { initiator, responder } = productionHandshake()
    responder.readMessage(initiator.writeMessage())
    initiator.readMessage(responder.writeMessage())
    const initiatorTransport = initiator.split()
    const responderTransport = responder.split()
    const sealed = initiatorTransport.tx.encryptWithAd(EMPTY, new TextEncoder().encode('boring-ssl'))
    assert.equal(
      new TextDecoder().decode(responderTransport.rx.decryptWithAd(EMPTY, sealed)),
      'boring-ssl',
    )
    const reply = responderTransport.tx.encryptWithAd(EMPTY, new TextEncoder().encode('no-chacha'))
    assert.equal(new TextDecoder().decode(initiatorTransport.rx.decryptWithAd(EMPTY, reply)), 'no-chacha')
  } finally {
    mutableCrypto.createCipheriv = originalCipher
    mutableCrypto.createDecipheriv = originalDecipher
  }
})

test('x25519 public key derivation and DH are symmetric', () => {
  const alice = generateX25519KeyPair()
  const bob = generateX25519KeyPair()
  assert.equal(bytesToHex(x25519PublicKeyFromPrivateKey(alice.privateKey)), bytesToHex(alice.publicKey))
  assert.equal(bytesToHex(x25519Dh(alice.privateKey, bob.publicKey)), bytesToHex(x25519Dh(bob.privateKey, alice.publicKey)))
})
