/**
 * Noise_NK_25519_ChaChaPoly_SHA256 — the cryptographic core of the Mesh
 * protocol (see `docs/PROTOCOL.md` §4 and §4.5).
 *
 * This module is a from-spec implementation of the Noise handshake state
 * machine (revision 34): `CipherState`, `SymmetricState`, the HKDF chain and
 * the `NK` message pattern. It deliberately implements **no** cryptographic
 * primitive itself: every X25519 / ChaCha20-Poly1305 / SHA-256 operation is
 * delegated to Node's OpenSSL bindings (`node:crypto`). See §4.5 of the
 * protocol: "不得手写密码算法".
 *
 * Design notes
 * - Keys are raw 32-byte values on the outside, converted to `KeyObject`s with
 *   minimal PKCS#8 / SPKI DER envelopes internally. `crypto.ts` (identity
 *   storage) converts those raw values to/from base64url PKCS#8.
 * - `NoiseNkHandshake` is specialised for the `NK` pattern (one pre-message:
 *   `<- s`). It also supports `NKpsk0` for the official noise-c test vectors
 *   only; production dsh-mesh never sets a PSK.
 * - All errors are `NoiseError`s with stable `code`s and messages that never
 *   contain key material, nonces, ciphertext or handshake hashes.
 */

import {
  createHash,
  createHmac,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
} from 'node:crypto'
import type { KeyObject } from 'node:crypto'

import { chacha20poly1305 } from '@noble/ciphers/chacha.js'

/** Canonical Noise protocol name for the Mesh handshake. */
export const NOISE_PROTOCOL_NAME = 'Noise_NK_25519_ChaChaPoly_SHA256'

/** Prologue mandated by `docs/PROTOCOL.md` §4: ASCII `dsh-mesh/1`. */
export const NOISE_PROLOGUE: Uint8Array = new TextEncoder().encode('dsh-mesh/1')

/** SHA-256 / X25519 / ChaCha20 key length in bytes. */
export const NOISE_KEY_LEN = 32
/** SHA-256 output length in bytes. */
export const NOISE_HASH_LEN = 32
/** Poly1305 authentication tag length in bytes. */
export const NOISE_TAG_LEN = 16
/** Ephemeral / static X25519 key length in bytes. */
export const NOISE_DH_LEN = 32
/** Maximum nonce value (noise spec §5.1): a message may use `MAX_NONCE - 1`. */
export const NOISE_MAX_NONCE = (1n << 64n) - 1n

/** Handshake messages are short; `docs/PROTOCOL.md` §4.1 caps them at 4 KiB. */
export const NOISE_MAX_HANDSHAKE_MESSAGE = 4 * 1024

/**
 * AEAD implementation backing `CipherState`.
 *
 * DSH desktop / server run on Electron's Node with BoringSSL, whose
 * `crypto.getCiphers()` does not include ChaCha20-Poly1305 (the system Node
 * build only works by accident). The AEAD therefore comes from the audited
 * pure-JS `@noble/ciphers` package. SHA-256/HKDF/X25519/Ed25519 still use
 * `node:crypto`, which BoringSSL does provide.
 */
export const NOISE_AEAD_BACKEND = '@noble/ciphers/chacha20poly1305'

/** Stable error codes produced by this module. */
export type NoiseErrorCode =
  | 'noise/invalid-key'
  | 'noise/invalid-state'
  | 'noise/invalid-message'
  | 'noise/decrypt-failed'
  | 'noise/nonce-exhausted'
  | 'noise/peer-key'

/**
 * Error thrown by the Noise implementation. Messages are deliberately generic
 * (no key, nonce, ciphertext or handshake-hash bytes) so they are safe to log.
 */
export class NoiseError extends Error {
  constructor(
    readonly code: NoiseErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'NoiseError'
  }
}

// ---------------------------------------------------------------------------
// Primitive wrappers (node:crypto only)
// ---------------------------------------------------------------------------

const X25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b656e04220420', 'hex')
const X25519_SPKI_PREFIX = Buffer.from('302a300506032b656e032100', 'hex')

function asBytes(value: Uint8Array): Buffer {
  return Buffer.isBuffer(value)
    ? value
    : Buffer.from(value.buffer, value.byteOffset, value.byteLength)
}

function unwrapX25519PrivateKey(privateKey: Uint8Array): KeyObject {
  if (privateKey.length !== NOISE_DH_LEN) {
    throw new NoiseError('noise/invalid-key', 'invalid X25519 private key length')
  }
  try {
    return createPrivateKey({
      key: Buffer.concat([X25519_PKCS8_PREFIX, asBytes(privateKey)]),
      format: 'der',
      type: 'pkcs8',
    })
  } catch {
    throw new NoiseError('noise/invalid-key', 'invalid X25519 private key')
  }
}

function unwrapX25519PublicKey(publicKey: Uint8Array): KeyObject {
  if (publicKey.length !== NOISE_DH_LEN) {
    throw new NoiseError('noise/invalid-key', 'invalid X25519 public key length')
  }
  try {
    return createPublicKey({
      key: Buffer.concat([X25519_SPKI_PREFIX, asBytes(publicKey)]),
      format: 'der',
      type: 'spki',
    })
  } catch {
    throw new NoiseError('noise/invalid-key', 'invalid X25519 public key')
  }
}

/** Derive the raw X25519 public key for a raw 32-byte private key. */
export function x25519PublicKeyFromPrivateKey(privateKey: Uint8Array): Uint8Array {
  const keyObject = unwrapX25519PrivateKey(privateKey)
  try {
    const jwk = createPublicKey(keyObject).export({ format: 'jwk' })
    if (typeof jwk.x !== 'string') {
      throw new NoiseError('noise/invalid-key', 'unsupported X25519 key encoding')
    }
    return new Uint8Array(Buffer.from(jwk.x, 'base64url'))
  } catch (error) {
    if (error instanceof NoiseError) throw error
    throw new NoiseError('noise/invalid-key', 'invalid X25519 private key')
  }
}

/** Raw X25519 Diffie-Hellman. Rejects all-zero shared secrets (low order points). */
export function x25519Dh(privateKey: Uint8Array, publicKey: Uint8Array): Uint8Array {
  const local = unwrapX25519PrivateKey(privateKey)
  const remote = unwrapX25519PublicKey(publicKey)
  let shared: Buffer
  try {
    shared = diffieHellman({ privateKey: local, publicKey: remote })
  } catch {
    throw new NoiseError('noise/peer-key', 'X25519 key agreement failed')
  }
  if (shared.length !== 32) {
    throw new NoiseError('noise/invalid-key', 'invalid X25519 shared secret')
  }
  let any = 0
  for (const byte of shared) any |= byte
  if (any === 0) {
    // Noise rev34 §11.6: reject null public keys / all-zero DH output.
    shared.fill(0)
    throw new NoiseError('noise/peer-key', 'invalid peer public key')
  }
  return new Uint8Array(shared)
}

/** Generate a fresh ephemeral X25519 key pair (raw 32-byte values). */
export function generateX25519KeyPair(): { privateKey: Uint8Array; publicKey: Uint8Array } {
  const pair = generateKeyPairSync('x25519')
  const jwkPublic = pair.publicKey.export({ format: 'jwk' })
  const jwkPrivate = pair.privateKey.export({ format: 'jwk' })
  if (typeof jwkPublic.x !== 'string' || typeof jwkPrivate.d !== 'string') {
    throw new NoiseError('noise/invalid-key', 'unsupported X25519 key encoding')
  }
  return {
    privateKey: new Uint8Array(Buffer.from(jwkPrivate.d, 'base64url')),
    publicKey: new Uint8Array(Buffer.from(jwkPublic.x, 'base64url')),
  }
}

function sha256(...parts: readonly Uint8Array[]): Buffer {
  const hash = createHash('sha256')
  for (const part of parts) hash.update(asBytes(part))
  return hash.digest()
}

function hmacSha256(key: Uint8Array, ...parts: readonly Uint8Array[]): Buffer {
  const hmac = createHmac('sha256', asBytes(key))
  for (const part of parts) hmac.update(asBytes(part))
  return hmac.digest()
}

/**
 * Noise HKDF (rev34 §5.2 / §4.3): `HKDF(ck, ikm, n)` where the salt is the
 * chaining key, the info string is empty and up to three outputs are returned.
 * HMAC-SHA256 comes from OpenSSL; only the HKDF composition is written here,
 * exactly as the Noise spec describes it.
 */
export function noiseHkdf(chainingKey: Uint8Array, inputKeyMaterial: Uint8Array, outputs: number): Uint8Array[] {
  if (outputs < 1 || outputs > 3) {
    throw new NoiseError('noise/invalid-state', 'invalid HKDF output count')
  }
  const tempKey = hmacSha256(chainingKey, inputKeyMaterial)
  const result: Uint8Array[] = []
  let previous: Buffer = Buffer.alloc(0)
  for (let index = 1; index <= outputs; index += 1) {
    previous = hmacSha256(tempKey, previous, Buffer.from([index]))
    result.push(new Uint8Array(previous))
  }
  tempKey.fill(0)
  return result
}

function zeroize(bytes: Uint8Array | null | undefined): void {
  if (bytes) bytes.fill(0)
}

function nonceBytes(nonce: bigint): Buffer {
  // Noise nonce: 4 zero bytes || 8-byte little-endian counter (12-byte AEAD nonce).
  const buffer = Buffer.alloc(12)
  buffer.writeBigUInt64LE(nonce, 4)
  return buffer
}

// ---------------------------------------------------------------------------
// CipherState
// ---------------------------------------------------------------------------

/**
 * Noise `CipherState` (rev34 §5.1): ChaCha20-Poly1305 with a 64-bit
 * little-endian nonce counter and caller-supplied associated data.
 */
export class CipherState {
  private key: Buffer | null
  private nonce = 0n
  private destroyed = false

  constructor(key?: Uint8Array | null) {
    if (key === undefined || key === null) {
      this.key = null
    } else {
      if (key.length !== NOISE_KEY_LEN) {
        throw new NoiseError('noise/invalid-key', 'invalid cipher key length')
      }
      this.key = Buffer.from(asBytes(key))
    }
  }

  /** True when a key has been installed; `EncryptWithAd` then really encrypts. */
  get hasKey(): boolean {
    return this.key !== null
  }

  /** Current nonce (`n`), as a bigint. Exposed for tests and diagnostics only. */
  get nonceValue(): bigint {
    return this.nonce
  }

  /** InitializeKey(key): set the key and reset the nonce. */
  initializeKey(key: Uint8Array): void {
    if (key.length !== NOISE_KEY_LEN) {
      throw new NoiseError('noise/invalid-key', 'invalid cipher key length')
    }
    if (this.destroyed) {
      throw new NoiseError('noise/invalid-state', 'cipher state already destroyed')
    }
    zeroize(this.key)
    this.key = Buffer.from(asBytes(key))
    this.nonce = 0n
  }

  /** SetNonce(nonce): used by out-of-order transport handling and tests. */
  setNonce(nonce: bigint): void {
    if (nonce < 0n || nonce > NOISE_MAX_NONCE) {
      throw new NoiseError('noise/nonce-exhausted', 'nonce out of range')
    }
    this.nonce = nonce
  }

  /**
   * EncryptWithAd(ad, plaintext). Without a key this is the identity function
   * required by the Noise spec (used for pre-DH handshake payloads).
   */
  encryptWithAd(ad: Uint8Array, plaintext: Uint8Array): Uint8Array {
    this.assertUsable()
    if (this.key === null) return new Uint8Array(plaintext)
    const nonce = this.takeNonce()
    // RFC 8439 AEAD: ciphertext || 16-byte Poly1305 tag (exactly Noise's layout).
    const cipher = chacha20poly1305(asBytes(this.key), nonceBytes(nonce), asBytes(ad))
    return new Uint8Array(cipher.encrypt(asBytes(plaintext)))
  }

  /**
   * DecryptWithAd(ad, ciphertext). Authentication failures throw a
   * `NoiseError('noise/decrypt-failed')` and, as required by the spec, do not
   * advance the nonce.
   */
  decryptWithAd(ad: Uint8Array, ciphertext: Uint8Array): Uint8Array {
    this.assertUsable()
    if (this.key === null) return new Uint8Array(ciphertext)
    if (ciphertext.length < NOISE_TAG_LEN) {
      throw new NoiseError('noise/invalid-message', 'ciphertext shorter than authentication tag')
    }
    const nonce = this.takeNonce()
    let plaintext: Uint8Array
    try {
      const decipher = chacha20poly1305(asBytes(this.key), nonceBytes(nonce), asBytes(ad))
      plaintext = new Uint8Array(decipher.decrypt(asBytes(ciphertext)))
    } catch {
      // Rewind the counter: Noise does not increment n on authentication failure.
      this.nonce = nonce
      throw new NoiseError('noise/decrypt-failed', 'message authentication failed')
    }
    return plaintext
  }

  /** Wipe the key material. Subsequent operations throw. */
  destroy(): void {
    zeroize(this.key)
    this.key = null
    this.destroyed = true
    this.nonce = 0n
  }

  private takeNonce(): bigint {
    const nonce = this.nonce
    if (nonce >= NOISE_MAX_NONCE) {
      throw new NoiseError('noise/nonce-exhausted', 'maximum nonce reached; rekey required')
    }
    this.nonce = nonce + 1n
    return nonce
  }

  private assertUsable(): void {
    if (this.destroyed) {
      throw new NoiseError('noise/invalid-state', 'cipher state already destroyed')
    }
  }
}

// ---------------------------------------------------------------------------
// SymmetricState
// ---------------------------------------------------------------------------

/**
 * Noise `SymmetricState` (rev34 §5.2): keeps the 32-byte chaining key `ck`,
 * the handshake hash `h` and the current `CipherState`.
 */
export class SymmetricState {
  private ck: Buffer
  private h: Buffer
  private cipher: CipherState
  /** Noise PSK mode also mixes ephemeral public keys into `ck` (§9). */
  private readonly pskMode: boolean
  private splitDone = false
  private destroyed = false

  constructor(protocolName: string | Uint8Array = NOISE_PROTOCOL_NAME, options: { readonly psk?: boolean } = {}) {
    if (options.psk === true) this.pskMode = true
    else this.pskMode = false
    this.h = Buffer.alloc(NOISE_HASH_LEN)
    this.ck = Buffer.alloc(NOISE_HASH_LEN)
    this.cipher = new CipherState(null)
    this.initializeSymmetric(protocolName)
  }

  /** InitializeSymmetric(protocol_name). */
  initializeSymmetric(protocolName: string | Uint8Array): void {
    const name = typeof protocolName === 'string' ? Buffer.from(protocolName, 'utf8') : Buffer.from(asBytes(protocolName))
    if (name.length <= NOISE_HASH_LEN) {
      this.h = Buffer.alloc(NOISE_HASH_LEN)
      name.copy(this.h)
    } else {
      this.h = sha256(name)
    }
    this.ck = Buffer.from(this.h)
    this.cipher = new CipherState(null)
  }

  /** MixHash(data): h = HASH(h || data). */
  mixHash(...data: readonly Uint8Array[]): void {
    this.assertNotSplit()
    this.h = sha256(this.h, ...data)
  }

  /** MixKey(ikm): ck, k = HKDF(ck, ikm, 2). */
  mixKey(inputKeyMaterial: Uint8Array): void {
    this.assertNotSplit()
    const [nextChainingKey, cipherKey] = noiseHkdf(this.ck, inputKeyMaterial, 2) as [Uint8Array, Uint8Array]
    zeroize(this.ck)
    this.ck = Buffer.from(nextChainingKey)
    this.cipher = new CipherState(cipherKey)
  }

  /** MixKeyAndHash(ikm): ck, h, k = HKDF(ck, ikm, 3) (PSK handling). */
  mixKeyAndHash(inputKeyMaterial: Uint8Array): void {
    this.assertNotSplit()
    const [nextChainingKey, tempHash, cipherKey] = noiseHkdf(this.ck, inputKeyMaterial, 3) as [
      Uint8Array,
      Uint8Array,
      Uint8Array,
    ]
    zeroize(this.ck)
    this.ck = Buffer.from(nextChainingKey)
    this.mixHash(tempHash)
    this.cipher = new CipherState(cipherKey)
  }

  /** MixKey(e.public_key) for PSK handshakes; a no-op otherwise. */
  mixEphemeralKey(ephemeralPublicKey: Uint8Array): void {
    if (this.pskMode) this.mixKey(ephemeralPublicKey)
  }

  /** EncryptAndHash(plaintext). */
  encryptAndHash(plaintext: Uint8Array): Uint8Array {
    this.assertNotSplit()
    const ciphertext = this.cipher.encryptWithAd(this.h, plaintext)
    this.mixHash(ciphertext)
    return ciphertext
  }

  /** DecryptAndHash(ciphertext). */
  decryptAndHash(ciphertext: Uint8Array): Uint8Array {
    this.assertNotSplit()
    const plaintext = this.cipher.decryptWithAd(this.h, ciphertext)
    this.mixHash(ciphertext)
    return plaintext
  }

  /**
   * Split(): derive the two transport `CipherState`s. Returns them in
   * Noise order `(c1, c2)`; the caller maps initiator/responder appropriately.
   */
  split(): { readonly c1: CipherState; readonly c2: CipherState } {
    this.assertNotSplit()
    this.splitDone = true
    const [firstKey, secondKey] = noiseHkdf(this.ck, Buffer.alloc(0), 2) as [Uint8Array, Uint8Array]
    const c1 = new CipherState(firstKey)
    const c2 = new CipherState(secondKey)
    // The chaining key is no longer needed once the transport keys exist.
    zeroize(this.ck)
    this.ck = Buffer.alloc(NOISE_HASH_LEN)
    return { c1, c2 }
  }

  /** GetHandshakeHash(): the final `h`, used for channel binding / SAS. */
  get handshakeHash(): Uint8Array {
    return new Uint8Array(this.h)
  }

  /** Wipe the chaining key and handshake hash. */
  destroy(): void {
    zeroize(this.ck)
    zeroize(this.h)
    this.cipher.destroy()
    this.destroyed = true
  }

  private assertNotSplit(): void {
    if (this.destroyed) throw new NoiseError('noise/invalid-state', 'symmetric state already destroyed')
    if (this.splitDone) throw new NoiseError('noise/invalid-state', 'handshake already split')
  }
}

// ---------------------------------------------------------------------------
// Noise NK handshake
// ---------------------------------------------------------------------------

export type NoiseRole = 'initiator' | 'responder'

export interface NoiseHandshakeOptions {
  readonly role: NoiseRole
  /** Initiator only: the responder's pinned X25519 static public key (`<- s`). */
  readonly remoteStaticPublicKey?: Uint8Array
  /** Responder only: this side's X25519 static private key (`<- s`). */
  readonly localStaticPrivateKey?: Uint8Array
  /** Prologue; defaults to ASCII `dsh-mesh/1`. */
  readonly prologue?: Uint8Array
  /** Protocol name; defaults to `Noise_NK_25519_ChaChaPoly_SHA256`. */
  readonly protocolName?: string
  /** Deterministic ephemeral private key. Test vectors only. */
  readonly ephemeralPrivateKey?: Uint8Array
  /**
   * 32-byte pre-shared key enabling `NKpsk0`. Only used to validate the
   * official noise-c vectors (production dsh-mesh never enables PSK).
   */
  readonly psk?: Uint8Array
  /** Maximum accepted handshake message size. Default 4 KiB. */
  readonly maxMessageBytes?: number
}

export interface NoiseTransportPair {
  readonly tx: CipherState
  readonly rx: CipherState
}

/**
 * State machine for the Noise `NK` pattern:
 *
 * ```
 * controller (initiator)                          daemon (responder)
 *   -> e, es        ------------------------------------▶
 *                   ◀----------------------------------- <- e, ee
 * ```
 *
 * `writeMessage` / `readMessage` exchange the raw Noise handshake messages
 * (without the dsh-mesh `0x01` framing byte, which lives in `channel.ts`).
 * Handshake payloads are supported so the noise-c vectors can be reproduced
 * byte for byte; the Mesh protocol itself always uses empty payloads.
 */
export class NoiseNkHandshake {
  private readonly role: NoiseRole
  private readonly symmetric: SymmetricState
  private readonly prologue: Uint8Array
  private readonly psk: Uint8Array | null
  private readonly maxMessageBytes: number

  private localStaticPrivateKey: Uint8Array | null = null
  private localStaticPublicKey: Uint8Array | null = null
  private remoteStaticPublicKey: Uint8Array | null = null
  private localEphemeralPrivateKey: Uint8Array | null = null
  private localEphemeralPublicKey: Uint8Array | null = null
  private remoteEphemeralPublicKey: Uint8Array | null = null

  private readonly fixedEphemeralPrivateKey: Uint8Array | null
  private written = 0
  private read = 0
  private splitResult: NoiseTransportPair | null = null
  private destroyed = false

  constructor(options: NoiseHandshakeOptions) {
    this.role = options.role
    this.psk = options.psk ? new Uint8Array(options.psk) : null
    if (this.psk !== null && this.psk.length !== NOISE_KEY_LEN) {
      throw new NoiseError('noise/invalid-key', 'invalid pre-shared key length')
    }
    this.fixedEphemeralPrivateKey = options.ephemeralPrivateKey ? new Uint8Array(options.ephemeralPrivateKey) : null
    this.prologue = options.prologue ? new Uint8Array(options.prologue) : NOISE_PROLOGUE
    this.maxMessageBytes = options.maxMessageBytes ?? NOISE_MAX_HANDSHAKE_MESSAGE
    const protocolName = options.protocolName ?? NOISE_PROTOCOL_NAME
    this.symmetric = new SymmetricState(protocolName, this.psk === null ? {} : { psk: true })

    // Initialize(): MixHash(prologue), then PSK (noise-c order), then pre-messages.
    this.symmetric.mixHash(this.prologue)
    if (this.psk !== null) this.symmetric.mixKeyAndHash(this.psk)

    if (this.role === 'initiator') {
      if (!options.remoteStaticPublicKey) {
        throw new NoiseError('noise/invalid-key', 'NK initiator requires the responder static public key')
      }
      if (options.remoteStaticPublicKey.length !== NOISE_DH_LEN) {
        throw new NoiseError('noise/invalid-key', 'invalid responder static public key length')
      }
      this.remoteStaticPublicKey = new Uint8Array(options.remoteStaticPublicKey)
      this.symmetric.mixHash(this.remoteStaticPublicKey)
    } else {
      if (!options.localStaticPrivateKey) {
        throw new NoiseError('noise/invalid-key', 'NK responder requires a local static private key')
      }
      if (options.localStaticPrivateKey.length !== NOISE_DH_LEN) {
        throw new NoiseError('noise/invalid-key', 'invalid local static private key length')
      }
      this.localStaticPrivateKey = new Uint8Array(options.localStaticPrivateKey)
      this.localStaticPublicKey = x25519PublicKeyFromPrivateKey(this.localStaticPrivateKey)
      this.symmetric.mixHash(this.localStaticPublicKey)
    }
  }

  get roleName(): NoiseRole {
    return this.role
  }

  /** True once both handshake messages have been exchanged. */
  get complete(): boolean {
    return this.written >= 1 && this.read >= 1
  }

  /** True once `writeMessage` may be called. */
  get canWrite(): boolean {
    if (this.destroyed || this.complete) return false
    return this.role === 'initiator' ? this.written === 0 && this.read === 0 : this.written === 0 && this.read === 1
  }

  /** True once `readMessage` may be called. */
  get canRead(): boolean {
    if (this.destroyed || this.complete) return false
    return this.role === 'initiator' ? this.read === 0 && this.written === 1 : this.read === 0 && this.written === 0
  }

  /** Handshake hash `h`; only meaningful after `complete`. */
  get handshakeHash(): Uint8Array {
    return this.symmetric.handshakeHash
  }

  /** Write the next handshake message for this role. */
  writeMessage(payload: Uint8Array = new Uint8Array(0)): Uint8Array {
    if (this.destroyed) throw new NoiseError('noise/invalid-state', 'handshake already finished')
    if (!this.canWrite) throw new NoiseError('noise/invalid-state', 'not this party\'s turn to write')
    if (payload.length > this.maxMessageBytes) {
      throw new NoiseError('noise/invalid-message', 'handshake payload too large')
    }

    const ephemeral = this.localEphemeral()
    const chunks: Uint8Array[] = [ephemeral.publicKey]
    this.symmetric.mixHash(ephemeral.publicKey)
    this.symmetric.mixEphemeralKey(ephemeral.publicKey)

    if (this.role === 'initiator') {
      // msg1: -> e, es
      const remoteStatic = this.remoteStaticPublicKey
      if (!remoteStatic) throw new NoiseError('noise/invalid-state', 'missing responder static key')
      this.symmetric.mixKey(x25519Dh(ephemeral.privateKey, remoteStatic))
    } else {
      // msg2: <- e, ee
      const remoteEphemeral = this.remoteEphemeralPublicKey
      if (!remoteEphemeral) throw new NoiseError('noise/invalid-state', 'missing initiator ephemeral key')
      this.symmetric.mixKey(x25519Dh(ephemeral.privateKey, remoteEphemeral))
    }
    chunks.push(this.symmetric.encryptAndHash(payload))
    this.written += 1
    const message = Buffer.concat(chunks.map(chunk => asBytes(chunk)))
    this.assertMessageSize(message.length)
    return new Uint8Array(message)
  }

  /** Read the next handshake message from the peer. */
  readMessage(message: Uint8Array): Uint8Array {
    if (this.destroyed) throw new NoiseError('noise/invalid-state', 'handshake already finished')
    if (!this.canRead) throw new NoiseError('noise/invalid-state', 'not this party\'s turn to read')
    this.assertMessageSize(message.length)
    if (message.length < NOISE_DH_LEN + NOISE_TAG_LEN) {
      throw new NoiseError('noise/invalid-message', 'handshake message too short')
    }
    const remoteEphemeral = new Uint8Array(message.subarray(0, NOISE_DH_LEN))
    // Reject the null/low-order ephemeral key before doing any DH with it.
    let any = 0
    for (const byte of remoteEphemeral) any |= byte
    if (any === 0) throw new NoiseError('noise/peer-key', 'invalid peer ephemeral key')
    this.remoteEphemeralPublicKey = remoteEphemeral
    this.symmetric.mixHash(remoteEphemeral)
    this.symmetric.mixEphemeralKey(remoteEphemeral)

    if (this.role === 'responder') {
      // msg1: -> e, es (es = DH(local static, remote ephemeral))
      const localStatic = this.localStaticPrivateKey
      if (!localStatic) throw new NoiseError('noise/invalid-state', 'missing local static key')
      this.symmetric.mixKey(x25519Dh(localStatic, remoteEphemeral))
    } else {
      // msg2: <- e, ee (ee = DH(local ephemeral, remote ephemeral))
      const ephemeral = this.localEphemeralPrivateKey
      if (!ephemeral) throw new NoiseError('noise/invalid-state', 'missing local ephemeral key')
      this.symmetric.mixKey(x25519Dh(ephemeral, remoteEphemeral))
    }

    const payload = this.symmetric.decryptAndHash(message.subarray(NOISE_DH_LEN))
    this.read += 1
    return payload
  }

  /**
   * Split(): derive the transport cipher states. Initiator: tx=c1/rx=c2;
   * responder: tx=c2/rx=c1. Idempotent.
   */
  split(): NoiseTransportPair {
    if (this.splitResult) return this.splitResult
    if (!this.complete) throw new NoiseError('noise/invalid-state', 'handshake is not complete')
    const { c1, c2 } = this.symmetric.split()
    this.splitResult = this.role === 'initiator' ? { tx: c1, rx: c2 } : { tx: c2, rx: c1 }
    return this.splitResult
  }

  /** Wipe handshake secret material (call after `split()`; cipher states survive). */
  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    zeroize(this.localStaticPrivateKey)
    zeroize(this.localEphemeralPrivateKey)
    zeroize(this.psk)
    if (!this.splitResult) this.symmetric.destroy()
    this.localStaticPrivateKey = null
    this.localEphemeralPrivateKey = null
  }

  private localEphemeral(): { privateKey: Uint8Array; publicKey: Uint8Array } {
    if (this.localEphemeralPrivateKey) {
      const publicKey = this.localEphemeralPublicKey
      if (!publicKey) throw new NoiseError('noise/invalid-state', 'missing local ephemeral public key')
      return { privateKey: this.localEphemeralPrivateKey, publicKey }
    }
    const pair = this.fixedEphemeralPrivateKey
      ? {
        privateKey: new Uint8Array(this.fixedEphemeralPrivateKey),
        publicKey: x25519PublicKeyFromPrivateKey(this.fixedEphemeralPrivateKey),
      }
      : generateX25519KeyPair()
    this.localEphemeralPrivateKey = pair.privateKey
    this.localEphemeralPublicKey = pair.publicKey
    return pair
  }

  private assertMessageSize(length: number): void {
    if (length > this.maxMessageBytes) {
      throw new NoiseError('noise/invalid-message', 'handshake message too large')
    }
  }

}
