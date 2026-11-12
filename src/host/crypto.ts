/**
 * Device identity, key encoding and authentication helpers for `dsh-device-mesh`.
 *
 * Everything here matches `src/shared/protocol.ts` (`DeviceIdentity`,
 * `DeviceKeys`, `DeviceDescriptor`, `PairingScope`) and `docs/PROTOCOL.md` §1-2:
 *
 * - Ed25519 signing key (`signPk` = raw 32-byte public key as base64url,
 *   `signSk` = PKCS#8 DER as base64url).
 * - X25519 Diffie-Hellman key (`dhPk` raw, `dhSk` PKCS#8).
 * - `deviceId = "dm_" + base32(sha256(signPk))[0:22]` (lowercase base32).
 * - Private keys never leave the host and never appear in logs; the error
 *   types in this module carry only stable codes and generic messages.
 *
 * The module is host-only (`node:crypto`, `node:fs`); the browser bundle uses
 * the pure helpers in `src/shared/protocol.ts` instead.
 */

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  hkdfSync,
  randomBytes as nodeRandomBytes,
  sign as nodeSign,
  verify as nodeVerify,
} from 'node:crypto'
import type { KeyObject } from 'node:crypto'
import { chmod, mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { hostname } from 'node:os'

import { toBase64Url, fromBase64Url } from '../shared/protocol.ts'
import type { DeviceDescriptor, DeviceIdentity, DevicePlatform, PublicKeyB64 } from '../shared/protocol.ts'

/** Base32 alphabet for device ids: RFC 4648 lowercase, no padding. */
const BASE32_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567'
/** Prefix of every device id. */
export const DEVICE_ID_PREFIX = 'dm_'
/** Number of base32 characters kept after the prefix. */
export const DEVICE_ID_LENGTH = 22
/** Ed25519 / X25519 raw key length in bytes. */
export const KEY_BYTES = 32
/** Ed25519 signature length in bytes. */
export const SIGNATURE_BYTES = 64
/** Exact string signed by the controller during application authentication. */
export const CLIENT_AUTH_LABEL = 'client_auth'
/** Exact string signed by the daemon during application authentication. */
export const SERVER_AUTH_LABEL = 'server_auth'
/** HKDF info string used to derive the six-digit pairing SAS. */
export const SAS_INFO = 'dsh-mesh/1 sas'

const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex')
const X25519_SPKI_PREFIX = Buffer.from('302a300506032b656e032100', 'hex')

const PLATFORMS: readonly DevicePlatform[] = ['darwin', 'linux', 'win32', 'android', 'ios', 'web', 'unknown']

/** Stable error codes for identity/key handling. */
export type IdentityErrorCode =
  | 'identity/invalid'
  | 'identity/key-mismatch'
  | 'identity/io'
  | 'identity/unsupported'

/** Error thrown for malformed identities, keys or signatures. */
export class IdentityError extends Error {
  constructor(
    readonly code: IdentityErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'IdentityError'
  }
}

// ---------------------------------------------------------------------------
// base64url helpers (thin wrappers around the shared portable implementation)
// ---------------------------------------------------------------------------

/** Encode bytes as unpadded base64url. */
export function encodeBase64Url(bytes: Uint8Array): string {
  return toBase64Url(bytes)
}

/** Decode unpadded base64url; throws `IdentityError` for non-canonical input. */
export function decodeBase64Url(value: string): Uint8Array {
  const decoded = fromBase64Url(value)
  if (!decoded) throw new IdentityError('identity/invalid', 'invalid base64url value')
  return decoded
}

/** Decode unpadded base64url, returning `undefined` instead of throwing. */
export function tryDecodeBase64Url(value: string): Uint8Array | undefined {
  return fromBase64Url(value)
}

/** Decode a base64url value and assert its byte length. */
export function decodeFixedBytes(value: string, length: number, what: string): Uint8Array {
  const decoded = decodeBase64Url(value)
  if (decoded.length !== length) {
    throw new IdentityError('identity/invalid', `invalid ${what} length`)
  }
  return decoded
}

/** Copy of `bytes` zeroed out; used for private key material. */
export function zeroize(bytes: Uint8Array | undefined | null): void {
  if (bytes) bytes.fill(0)
}

/** SHA-256 digest. */
export function sha256(data: Uint8Array): Uint8Array {
  return new Uint8Array(createHash('sha256').update(Buffer.from(data)).digest())
}

/** SHA-256 hex digest of a UTF-8 string (one-time pairing-token hashes). */
export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

/** Cryptographically secure random bytes. */
export function randomBytes(length: number): Uint8Array {
  if (!Number.isInteger(length) || length < 1) throw new IdentityError('identity/invalid', 'invalid random length')
  return new Uint8Array(nodeRandomBytes(length))
}

/** Random 32-byte base64url token (pairing tokens, nonces, portal tokens). */
export function randomToken(length = 32): string {
  return encodeBase64Url(randomBytes(length))
}

// ---------------------------------------------------------------------------
// Raw <-> KeyObject helpers
// ---------------------------------------------------------------------------

function derKey(prefix: Buffer, raw: Uint8Array, privateKey: boolean): KeyObject {
  const body = Buffer.concat([prefix, Buffer.from(raw)])
  return privateKey
    ? createPrivateKey({ key: body, format: 'der', type: 'pkcs8' })
    : createPublicKey({ key: body, format: 'der', type: 'spki' })
}

function privateKeyObject(pkcs8Base64Url: string): KeyObject {
  const der = decodeBase64Url(pkcs8Base64Url)
  try {
    return createPrivateKey({ key: Buffer.from(der), format: 'der', type: 'pkcs8' })
  } catch {
    throw new IdentityError('identity/invalid', 'invalid PKCS#8 private key')
  }
}

/** Export a private key as base64url PKCS#8 DER. */
function exportPkcs8(key: KeyObject): string {
  return encodeBase64Url(new Uint8Array(key.export({ format: 'der', type: 'pkcs8' })))
}

function deriveRawPublicKey(key: KeyObject): Uint8Array {
  try {
    const jwk = createPublicKey(key).export({ format: 'jwk' })
    if (typeof jwk.x !== 'string') throw new Error('missing x')
    return new Uint8Array(Buffer.from(jwk.x, 'base64url'))
  } catch {
    throw new IdentityError('identity/invalid', 'invalid private key encoding')
  }
}

/** Raw 32-byte Ed25519 public key from a PKCS#8 private key. */
export function ed25519PublicKeyFromPrivateKey(pkcs8Base64Url: string): Uint8Array {
  const key = privateKeyObject(pkcs8Base64Url)
  if (key.asymmetricKeyType !== 'ed25519') {
    throw new IdentityError('identity/unsupported', 'expected an Ed25519 private key')
  }
  return deriveRawPublicKey(key)
}

/** Raw 32-byte X25519 public key from a PKCS#8 private key. */
export function x25519PublicKeyFromPrivateKey(pkcs8Base64Url: string): Uint8Array {
  const key = privateKeyObject(pkcs8Base64Url)
  if (key.asymmetricKeyType !== 'x25519') {
    throw new IdentityError('identity/unsupported', 'expected an X25519 private key')
  }
  return deriveRawPublicKey(key)
}

/**
 * Raw 32-byte X25519 private key from a base64url PKCS#8 value. The Noise
 * handshake works on raw bytes; the identity file stores PKCS#8.
 */
export function x25519PrivateKeyBytes(pkcs8Base64Url: string): Uint8Array {
  const key = privateKeyObject(pkcs8Base64Url)
  if (key.asymmetricKeyType !== 'x25519') {
    throw new IdentityError('identity/unsupported', 'expected an X25519 private key')
  }
  const der = new Uint8Array(key.export({ format: 'der', type: 'pkcs8' }))
  if (der.length !== 48) {
    throw new IdentityError('identity/invalid', 'invalid PKCS#8 private key length')
  }
  return new Uint8Array(der.subarray(16, 48))
}

function importRawPublicKey(raw: Uint8Array, type: 'ed25519' | 'x25519'): KeyObject {
  if (raw.length !== KEY_BYTES) throw new IdentityError('identity/invalid', 'invalid public key length')
  return derKey(type === 'ed25519' ? ED25519_SPKI_PREFIX : X25519_SPKI_PREFIX, raw, false)
}

// ---------------------------------------------------------------------------
// Device identity
// ---------------------------------------------------------------------------

/** Lowercase RFC 4648 base32, no padding. */
export function base32Lower(bytes: Uint8Array): string {
  let output = ''
  let bits = 0
  let value = 0
  for (const byte of bytes) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      bits -= 5
      output += BASE32_ALPHABET[(value >>> bits) & 0x1f]
    }
    value &= (1 << bits) - 1
  }
  if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 0x1f]
  return output
}

/** Derive the human readable `deviceId` from an Ed25519 public key. */
export function deviceIdFromSignPublicKey(signPk: PublicKeyB64): string {
  const raw = decodeFixedBytes(signPk, KEY_BYTES, 'Ed25519 public key')
  return `${DEVICE_ID_PREFIX}${base32Lower(sha256(raw)).slice(0, DEVICE_ID_LENGTH)}`
}

/** Map `process.platform` to the wire `DevicePlatform` union. */
export function currentPlatform(): DevicePlatform {
  const platform = process.platform
  if (platform === 'darwin' || platform === 'linux' || platform === 'win32') return platform
  return 'unknown'
}

export interface GenerateIdentityOptions {
  readonly name?: string
  readonly platform?: DevicePlatform
  readonly createdAt?: string
}

/** Generate a brand new Ed25519 + X25519 device identity. */
export function generateDeviceIdentity(options: GenerateIdentityOptions = {}): DeviceIdentity {
  const signPair = generateKeyPairSync('ed25519')
  const dhPair = generateKeyPairSync('x25519')
  const signPk = encodeBase64Url(deriveRawPublicKey(signPair.privateKey))
  const dhPk = encodeBase64Url(deriveRawPublicKey(dhPair.privateKey))
  const signSk = exportPkcs8(signPair.privateKey)
  const dhSk = exportPkcs8(dhPair.privateKey)
  const identity: DeviceIdentity = {
    version: 1,
    deviceId: deviceIdFromSignPublicKey(signPk),
    name: options.name ?? hostname(),
    platform: options.platform ?? currentPlatform(),
    createdAt: options.createdAt ?? new Date().toISOString(),
    signPk,
    dhPk,
    signSk,
    dhSk,
  }
  return validateIdentityShape(identity)
}

/** Public projection of an identity, safe to send over the wire or print. */
export function deviceDescriptorOf(identity: DeviceIdentity | DeviceDescriptor): DeviceDescriptor {
  return {
    deviceId: identity.deviceId,
    name: identity.name,
    platform: identity.platform,
    signPk: identity.signPk,
    dhPk: identity.dhPk,
  }
}

/** Validate a `DeviceDescriptor` received from the wire. */
export function parseDeviceDescriptor(value: unknown): DeviceDescriptor {
  if (typeof value !== 'object' || value === null) {
    throw new IdentityError('identity/invalid', 'invalid device descriptor')
  }
  const record = value as Record<string, unknown>
  if (typeof record.deviceId !== 'string' || typeof record.name !== 'string' || typeof record.platform !== 'string') {
    throw new IdentityError('identity/invalid', 'invalid device descriptor fields')
  }
  if (typeof record.signPk !== 'string' || typeof record.dhPk !== 'string') {
    throw new IdentityError('identity/invalid', 'invalid device descriptor keys')
  }
  if (!isPlatform(record.platform)) {
    throw new IdentityError('identity/invalid', 'invalid device platform')
  }
  const name = record.name
  if (name.length === 0 || name.length > 128 || /[\u0000-\u001f\u007f]/u.test(name)) {
    throw new IdentityError('identity/invalid', 'invalid device name')
  }
  decodeFixedBytes(record.signPk, KEY_BYTES, 'Ed25519 public key')
  decodeFixedBytes(record.dhPk, KEY_BYTES, 'X25519 public key')
  const expectedDeviceId = deviceIdFromSignPublicKey(record.signPk)
  if (record.deviceId !== expectedDeviceId) {
    throw new IdentityError('identity/key-mismatch', 'device id does not match signing key')
  }
  return {
    deviceId: record.deviceId,
    name,
    platform: record.platform,
    signPk: record.signPk,
    dhPk: record.dhPk,
  }
}

/** Parse an unknown JSON value as a `DeviceIdentity` (throws on inconsistency). */
export function parseDeviceIdentity(value: unknown): DeviceIdentity {
  if (typeof value !== 'object' || value === null) {
    throw new IdentityError('identity/invalid', 'invalid identity file')
  }
  const record = value as Record<string, unknown>
  // Accept both the flat `DeviceIdentity` shape and the nested shape shown in
  // docs/PROTOCOL.md §1 (`signKey`/`dhKey` objects). Serialization always uses
  // the flat shape declared in src/shared/protocol.ts.
  const sign = isKeyPair(record.signKey) ? record.signKey : undefined
  const dh = isKeyPair(record.dhKey) ? record.dhKey : undefined
  const signPk = sign?.publicKey ?? record.signPk
  const signSk = sign?.privateKey ?? record.signSk
  const dhPk = dh?.publicKey ?? record.dhPk
  const dhSk = dh?.privateKey ?? record.dhSk
  if (
    record.version !== 1 ||
    typeof record.deviceId !== 'string' ||
    typeof record.name !== 'string' ||
    typeof record.platform !== 'string' ||
    typeof record.createdAt !== 'string' ||
    typeof signPk !== 'string' ||
    typeof signSk !== 'string' ||
    typeof dhPk !== 'string' ||
    typeof dhSk !== 'string'
  ) {
    throw new IdentityError('identity/invalid', 'invalid identity file fields')
  }
  if (!isPlatform(record.platform)) {
    throw new IdentityError('identity/invalid', 'invalid identity platform')
  }
  const identity: DeviceIdentity = {
    version: 1,
    deviceId: record.deviceId,
    name: record.name,
    platform: record.platform,
    createdAt: record.createdAt,
    signPk,
    dhPk,
    signSk,
    dhSk,
  }
  return validateIdentityShape(identity)
}

/** Validate identity field consistency and that the private keys match the public keys. */
export function validateIdentityShape(identity: DeviceIdentity): DeviceIdentity {
  if (identity.version !== 1) throw new IdentityError('identity/unsupported', 'unsupported identity version')
  if (identity.name.length === 0 || identity.name.length > 128) {
    throw new IdentityError('identity/invalid', 'invalid identity name')
  }
  if (!isPlatform(identity.platform)) throw new IdentityError('identity/invalid', 'invalid identity platform')
  if (typeof identity.createdAt !== 'string' || Number.isNaN(Date.parse(identity.createdAt))) {
    throw new IdentityError('identity/invalid', 'invalid identity creation time')
  }
  decodeFixedBytes(identity.signPk, KEY_BYTES, 'Ed25519 public key')
  decodeFixedBytes(identity.dhPk, KEY_BYTES, 'X25519 public key')
  encodeBase64Url(decodeBase64Url(identity.signSk))
  encodeBase64Url(decodeBase64Url(identity.dhSk))
  const expectedDeviceId = deviceIdFromSignPublicKey(identity.signPk)
  if (identity.deviceId !== expectedDeviceId) {
    throw new IdentityError('identity/key-mismatch', 'device id does not match signing key')
  }
  const derivedSignPk = encodeBase64Url(ed25519PublicKeyFromPrivateKey(identity.signSk))
  if (derivedSignPk !== identity.signPk) {
    throw new IdentityError('identity/key-mismatch', 'signing key pair does not match')
  }
  const derivedDhPk = encodeBase64Url(x25519PublicKeyFromPrivateKey(identity.dhSk))
  if (derivedDhPk !== identity.dhPk) {
    throw new IdentityError('identity/key-mismatch', 'Diffie-Hellman key pair does not match')
  }
  return identity
}

function isPlatform(value: string): value is DevicePlatform {
  return (PLATFORMS as readonly string[]).includes(value)
}

function isKeyPair(value: unknown): value is { publicKey?: unknown; privateKey?: unknown } {
  return typeof value === 'object' && value !== null
}

// ---------------------------------------------------------------------------
// Persistence ($DSH_HOME/device-mesh/identity.json, mode 0600)
// ---------------------------------------------------------------------------

/** Serialize an identity as pretty JSON (caller writes it with mode 0600). */
export function serializeIdentity(identity: DeviceIdentity): string {
  return `${JSON.stringify(identity, null, 2)}\n`
}

/** Read and validate an identity file. */
export async function loadIdentity(filePath: string): Promise<DeviceIdentity> {
  let text: string
  try {
    text = await readFile(filePath, 'utf8')
  } catch (error) {
    throw new IdentityError('identity/io', `cannot read identity file: ${errorCode(error)}`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new IdentityError('identity/invalid', 'identity file is not valid JSON')
  }
  const identity = parseDeviceIdentity(parsed)
  // Harden permissions best effort: the file holds long-term private keys.
  try {
    const info = await stat(filePath)
    if (process.platform !== 'win32' && (info.mode & 0o077) !== 0) {
      await chmod(filePath, 0o600)
    }
  } catch {
    // A read-only filesystem must not prevent using an existing identity.
  }
  return identity
}

/** Write an identity atomically with mode 0600 (best effort on non-POSIX). */
export async function saveIdentity(filePath: string, identity: DeviceIdentity): Promise<void> {
  const validated = validateIdentityShape(identity)
  const directory = dirname(filePath)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`
  try {
    await writeFile(temporary, serializeIdentity(validated), { encoding: 'utf8', mode: 0o600 })
    await rename(temporary, filePath)
  } catch (error) {
    try {
      await unlink(temporary)
    } catch {
      // ignore cleanup failures
    }
    throw new IdentityError('identity/io', `cannot write identity file: ${errorCode(error)}`)
  }
  if (process.platform !== 'win32') {
    try {
      await chmod(filePath, 0o600)
    } catch {
      // best effort only
    }
  }
}

/**
 * Load an existing identity or create + persist a new one. Never overwrites a
 * file that exists but fails validation (that would silently rotate keys).
 */
export async function loadOrCreateIdentity(
  filePath: string,
  options: GenerateIdentityOptions = {},
): Promise<DeviceIdentity> {
  let exists = true
  try {
    await stat(filePath)
  } catch (error) {
    if (errorCode(error) === 'ENOENT') exists = false
    else throw new IdentityError('identity/io', `cannot stat identity file: ${errorCode(error)}`)
  }
  if (exists) return loadIdentity(filePath)
  const identity = generateDeviceIdentity(options)
  await saveIdentity(filePath, identity)
  return identity
}

function errorCode(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'code' in error && typeof (error).code === 'string') {
    return (error as { code: string }).code
  }
  return 'unknown'
}

// ---------------------------------------------------------------------------
// Ed25519 signatures
// ---------------------------------------------------------------------------

/** Sign a byte string with a base64url PKCS#8 Ed25519 key; returns base64url. */
export function signEd25519(signSkPkcs8: string, message: Uint8Array): string {
  const key = privateKeyObject(signSkPkcs8)
  if (key.asymmetricKeyType !== 'ed25519') {
    throw new IdentityError('identity/unsupported', 'expected an Ed25519 private key')
  }
  try {
    return encodeBase64Url(new Uint8Array(nodeSign(null, Buffer.from(message), key)))
  } catch {
    throw new IdentityError('identity/invalid', 'signing failed')
  }
}

/** Verify a base64url Ed25519 signature against a raw base64url public key. */
export function verifyEd25519(signPk: PublicKeyB64, message: Uint8Array, signatureB64: string): boolean {
  let publicKey: KeyObject
  let signature: Uint8Array
  try {
    publicKey = importRawPublicKey(decodeFixedBytes(signPk, KEY_BYTES, 'Ed25519 public key'), 'ed25519')
    signature = decodeFixedBytes(signatureB64, SIGNATURE_BYTES, 'Ed25519 signature')
  } catch {
    return false
  }
  try {
    return nodeVerify(null, Buffer.from(message), publicKey, Buffer.from(signature))
  } catch {
    return false
  }
}

function concatBytes(...parts: readonly Uint8Array[]): Uint8Array {
  return new Uint8Array(Buffer.concat(parts.map(part => Buffer.from(part))))
}

/** Transcript signed by the controller: `h || "client_auth"`. */
export function clientAuthTranscript(handshakeHash: Uint8Array): Uint8Array {
  if (handshakeHash.length !== 32) throw new IdentityError('identity/invalid', 'invalid handshake hash')
  return concatBytes(handshakeHash, new TextEncoder().encode(CLIENT_AUTH_LABEL))
}

/** Transcript signed by the daemon: `h || "server_auth" || controllerNonce`. */
export function serverAuthTranscript(handshakeHash: Uint8Array, controllerNonce: Uint8Array): Uint8Array {
  if (handshakeHash.length !== 32) throw new IdentityError('identity/invalid', 'invalid handshake hash')
  if (controllerNonce.length !== 32) throw new IdentityError('identity/invalid', 'invalid controller nonce')
  return concatBytes(handshakeHash, new TextEncoder().encode(SERVER_AUTH_LABEL), controllerNonce)
}

/** Controller's `client_auth` signature. */
export function signClientAuth(signSkPkcs8: string, handshakeHash: Uint8Array): string {
  return signEd25519(signSkPkcs8, clientAuthTranscript(handshakeHash))
}

/** Verify the controller's `client_auth` signature. */
export function verifyClientAuth(signPk: PublicKeyB64, handshakeHash: Uint8Array, signature: string): boolean {
  return verifyEd25519(signPk, clientAuthTranscript(handshakeHash), signature)
}

/** Daemon's `server_auth` signature. */
export function signServerAuth(signSkPkcs8: string, handshakeHash: Uint8Array, controllerNonce: Uint8Array): string {
  return signEd25519(signSkPkcs8, serverAuthTranscript(handshakeHash, controllerNonce))
}

/** Verify the daemon's `server_auth` signature. */
export function verifyServerAuth(
  signPk: PublicKeyB64,
  handshakeHash: Uint8Array,
  controllerNonce: Uint8Array,
  signature: string,
): boolean {
  return verifyEd25519(signPk, serverAuthTranscript(handshakeHash, controllerNonce), signature)
}

// ---------------------------------------------------------------------------
// SAS (short authentication string)
// ---------------------------------------------------------------------------

/**
 * Six-digit SAS, formatted `123-456` (docs/PROTOCOL.md §4.2 rule 4):
 * `HKDF-SHA256(ikm=h, salt=sort(controller.signPk, daemon.signPk),
 * info="dsh-mesh/1 sas", 4B)` interpreted big-endian, modulo 1_000_000.
 *
 * Both sides sort the two raw public keys bytewise, so the value is identical
 * regardless of role. A wrong/absent key throws; never log `h`.
 */
export function computeSas(
  handshakeHash: Uint8Array,
  firstSignPk: PublicKeyB64,
  secondSignPk: PublicKeyB64,
): string {
  if (handshakeHash.length !== 32) throw new IdentityError('identity/invalid', 'invalid handshake hash')
  const first = decodeFixedBytes(firstSignPk, KEY_BYTES, 'Ed25519 public key')
  const second = decodeFixedBytes(secondSignPk, KEY_BYTES, 'Ed25519 public key')
  const [low, high] = Buffer.compare(Buffer.from(first), Buffer.from(second)) <= 0 ? [first, second] : [second, first]
  const salt = concatBytes(low, high)
  const info = new TextEncoder().encode(SAS_INFO)
  let derived: Buffer
  try {
    derived = Buffer.from(hkdfSync('sha256', Buffer.from(handshakeHash), Buffer.from(salt), Buffer.from(info), 4))
  } catch {
    throw new IdentityError('identity/invalid', 'SAS derivation failed')
  }
  const value = derived.readUInt32BE(0) % 1_000_000
  const digits = String(value).padStart(6, '0')
  return `${digits.slice(0, 3)}-${digits.slice(3)}`
}
