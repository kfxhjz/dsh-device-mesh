/**
 * Identity / key / signature tests for `src/host/crypto.ts`.
 *
 * Everything runs on the local filesystem (OS temp dir) and node:crypto; no
 * network, no external services.
 */

import assert from 'node:assert/strict'
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { x25519PublicKeyFromPrivateKey as rawX25519PublicFromRaw } from '../../src/host/noise.ts'
import {
  DEVICE_ID_PREFIX,
  IdentityError,
  SIGNATURE_BYTES,
  base32Lower,
  clientAuthTranscript,
  computeSas,
  decodeBase64Url,
  deviceDescriptorOf,
  deviceIdFromSignPublicKey,
  encodeBase64Url,
  generateDeviceIdentity,
  loadIdentity,
  loadOrCreateIdentity,
  parseDeviceDescriptor,
  parseDeviceIdentity,
  randomToken,
  saveIdentity,
  serializeIdentity,
  serverAuthTranscript,
  signClientAuth,
  signEd25519,
  signServerAuth,
  validateIdentityShape,
  verifyClientAuth,
  verifyEd25519,
  verifyServerAuth,
  x25519PrivateKeyBytes,
  x25519PublicKeyFromPrivateKey,
} from '../../src/host/crypto.ts'

const identity = generateDeviceIdentity({ name: 'test-host', platform: 'linux' })
const handshakeHash = new Uint8Array(32).fill(0xa5)
const controllerNonce = new Uint8Array(32).fill(0x5a)

test('generateDeviceIdentity produces a consistent Ed25519 + X25519 identity', () => {
  assert.equal(identity.version, 1)
  assert.equal(identity.name, 'test-host')
  assert.equal(identity.platform, 'linux')
  assert.equal(decodeBase64Url(identity.signPk).length, 32)
  assert.equal(decodeBase64Url(identity.dhPk).length, 32)
  assert.match(identity.deviceId, new RegExp(`^${DEVICE_ID_PREFIX}[a-z2-7]{22}$`, 'u'))
  assert.equal(identity.deviceId, deviceIdFromSignPublicKey(identity.signPk))
  // Private keys are PKCS#8 DER (48 bytes) and match the public halves.
  assert.equal(decodeBase64Url(identity.signSk).length, 48)
  assert.equal(decodeBase64Url(identity.dhSk).length, 48)
  assert.equal(encodeBase64Url(x25519PublicKeyFromPrivateKey(identity.dhSk)), identity.dhPk)
  assert.equal(encodeBase64Url(rawX25519PublicFromRaw(x25519PrivateKeyBytes(identity.dhSk))), identity.dhPk)
  assert.notEqual(identity.signSk, identity.dhSk)
  assert.deepEqual(deviceDescriptorOf(identity), {
    deviceId: identity.deviceId,
    name: identity.name,
    platform: identity.platform,
    signPk: identity.signPk,
    dhPk: identity.dhPk,
  })
})

test('identity JSON round-trips through the flat DeviceIdentity shape', () => {
  const parsed = parseDeviceIdentity(JSON.parse(serializeIdentity(identity)))
  assert.deepEqual(parsed, identity)
})

test('identity parser accepts the nested docs/PROTOCOL.md §1 shape', () => {
  const nested = {
    version: 1,
    deviceId: identity.deviceId,
    name: identity.name,
    platform: identity.platform,
    createdAt: identity.createdAt,
    signKey: { publicKey: identity.signPk, privateKey: identity.signSk },
    dhKey: { publicKey: identity.dhPk, privateKey: identity.dhSk },
  }
  const parsed = parseDeviceIdentity(nested)
  assert.deepEqual(parsed, identity)
})

test('identity validation rejects mismatched private keys and bad ids', () => {
  const other = generateDeviceIdentity({ name: 'other', platform: 'darwin' })
  assert.throws(() => validateIdentityShape({ ...identity, signSk: other.signSk }), (error: unknown) => {
    return error instanceof IdentityError && error.code === 'identity/key-mismatch'
  })
  assert.throws(() => validateIdentityShape({ ...identity, deviceId: other.deviceId }), /does not match/u)
  assert.throws(() => parseDeviceIdentity({ ...identity, version: 2 }), /invalid identity/u)
  assert.throws(() => parseDeviceIdentity({ ...identity, signSk: 'not-a-key' }), /invalid/u)
})

test('Ed25519 signatures round-trip and domain-separate client/server auth', () => {
  const message = new TextEncoder().encode('hello mesh')
  const signature = signEd25519(identity.signSk, message)
  assert.equal(decodeBase64Url(signature).length, SIGNATURE_BYTES)
  assert.equal(verifyEd25519(identity.signPk, message, signature), true)
  assert.equal(verifyEd25519(identity.signPk, new TextEncoder().encode('hello mesH'), signature), false)
  assert.equal(verifyEd25519(generateDeviceIdentity().signPk, message, signature), false)
  assert.equal(verifyEd25519(identity.signPk, message, 'AAAA'), false)
  assert.equal(verifyEd25519('not-base64!', message, signature), false)

  const clientSignature = signClientAuth(identity.signSk, handshakeHash)
  assert.equal(verifyClientAuth(identity.signPk, handshakeHash, clientSignature), true)
  assert.equal(verifyClientAuth(identity.signPk, new Uint8Array(32), clientSignature), false)

  const serverSignature = signServerAuth(identity.signSk, handshakeHash, controllerNonce)
  assert.equal(verifyServerAuth(identity.signPk, handshakeHash, controllerNonce, serverSignature), true)
  assert.equal(verifyServerAuth(identity.signPk, handshakeHash, new Uint8Array(32), serverSignature), false)
  // A client_auth signature must never verify as a server_auth signature.
  assert.equal(verifyServerAuth(identity.signPk, handshakeHash, controllerNonce, clientSignature), false)
  assert.equal(verifyClientAuth(identity.signPk, handshakeHash, serverSignature), false)
  assert.equal(
    Buffer.from(clientAuthTranscript(handshakeHash)).toString('hex'),
    Buffer.from(handshakeHash).toString('hex') + Buffer.from('client_auth').toString('hex'),
  )
  assert.ok(Buffer.from(serverAuthTranscript(handshakeHash, controllerNonce)).includes(Buffer.from('server_auth')))
  assert.throws(() => signClientAuth(identity.signSk, new Uint8Array(16)), /handshake hash/u)
  assert.throws(() => signClientAuth(otherPrivateKey(), handshakeHash), /Ed25519/u)
})

function otherPrivateKey(): string {
  // DH private key where an Ed25519 key is expected.
  return identity.dhSk
}

test('descriptor parsing enforces identity consistency and safe fields', () => {
  const descriptor = deviceDescriptorOf(identity)
  assert.deepEqual(parseDeviceDescriptor(descriptor), descriptor)
  const foreign = generateDeviceIdentity({ name: 'foreign' })
  assert.throws(() => parseDeviceDescriptor({ ...descriptor, deviceId: foreign.deviceId }), /does not match/u)
  assert.throws(() => parseDeviceDescriptor({ ...descriptor, platform: 'beOS' }), /platform/u)
  assert.throws(() => parseDeviceDescriptor({ ...descriptor, name: 'bad\nname' }), /name/u)
  assert.throws(() => parseDeviceDescriptor({ ...descriptor, name: '' }), /name/u)
  assert.throws(() => parseDeviceDescriptor({ ...descriptor, name: 'x'.repeat(129) }), /name/u)
  assert.throws(() => parseDeviceDescriptor({ ...descriptor, signPk: 'AAAA' }), /public key/u)
  assert.throws(() => parseDeviceDescriptor(null), /descriptor/u)
  assert.throws(() => parseDeviceDescriptor({ ...descriptor, signPk: undefined }), /descriptor/u)
})

test('SAS is six digits, role-order independent and transcript-dependent', () => {
  const daemon = generateDeviceIdentity({ name: 'daemon' })
  const controller = generateDeviceIdentity({ name: 'controller' })
  const sas = computeSas(handshakeHash, controller.signPk, daemon.signPk)
  assert.match(sas, /^\d{3}-\d{3}$/u)
  assert.equal(sas, computeSas(handshakeHash, daemon.signPk, controller.signPk))
  assert.notEqual(sas, computeSas(new Uint8Array(32).fill(0x11), controller.signPk, daemon.signPk))
  assert.notEqual(sas, computeSas(handshakeHash, daemon.signPk, generateDeviceIdentity().signPk))
  // Deterministic across calls (both sides derive the same value).
  assert.equal(sas, computeSas(handshakeHash, controller.signPk, daemon.signPk))
  assert.throws(() => computeSas(new Uint8Array(31), controller.signPk, daemon.signPk), /handshake hash/u)
})

test('base64url, base32 and random helpers', () => {
  const bytes = new Uint8Array([0xfb, 0xff, 0x00, 0x01])
  assert.equal(encodeBase64Url(bytes), '-_8AAQ')
  assert.deepEqual(decodeBase64Url('-_8AAQ'), bytes)
  assert.throws(() => decodeBase64Url('####'), /base64url/u)
  // RFC 4648 test vector "foo" -> mzxw6===
  assert.equal(base32Lower(new TextEncoder().encode('foo')), 'mzxw6')
  assert.match(randomToken(), /^[A-Za-z0-9_-]{43}$/u)
  assert.notEqual(randomToken(), randomToken())
  assert.equal(decodeBase64Url(randomToken(32)).length, 32)
})

test('identity files are created 0600, reload identically and harden loose modes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-mesh-crypto-'))
  try {
    const filePath = join(directory, 'device-mesh', 'identity.json')
    const created = await loadOrCreateIdentity(filePath, { name: 'first', platform: 'linux' })
    const info = await stat(filePath)
    if (process.platform !== 'win32') assert.equal(info.mode & 0o777, 0o600)
    assert.equal(JSON.parse(await readFile(filePath, 'utf8')).deviceId, created.deviceId)

    const loaded = await loadOrCreateIdentity(filePath, { name: 'ignored' })
    assert.deepEqual(loaded, created, 'existing identity must not be rotated')

    // A loose mode is hardened on load, and a bad file is never overwritten.
    if (process.platform !== 'win32') {
      await chmod(filePath, 0o644)
      await loadIdentity(filePath)
      const hardened = await stat(filePath)
      assert.equal(hardened.mode & 0o777, 0o600)
    }

    const secondPath = join(directory, 'identity.json')
    await writeFile(secondPath, '{"version":1,"garbage":true}', { mode: 0o600 })
    await assert.rejects(() => loadOrCreateIdentity(secondPath, { name: 'x' }), IdentityError)
    assert.equal(JSON.parse(await readFile(secondPath, 'utf8')).garbage, true, 'invalid identity kept intact')

    // Round-trip through saveIdentity.
    const saved = generateDeviceIdentity({ name: 'saved', platform: 'darwin' })
    const savedPath = join(directory, 'saved.json')
    await saveIdentity(savedPath, saved)
    assert.deepEqual(await loadIdentity(savedPath), saved)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
