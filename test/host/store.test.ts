import assert from 'node:assert/strict'
import { readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import type { PeerRecord } from '../../src/shared/protocol.ts'
import { fromBase64Url, toBase64Url } from '../../src/shared/protocol.ts'
import {
  MeshStore,
  atomicWriteFile,
  createDeviceIdentity,
  deriveDeviceId,
  signEd25519,
  verifyEd25519,
} from '../../src/host/store.ts'
import { makeTempDir } from './helpers.ts'

function peerRecord(deviceId: string, overrides: Partial<PeerRecord> = {}): PeerRecord {
  return {
    deviceId,
    name: 'Peer',
    platform: 'linux',
    signPk: toBase64Url(new Uint8Array(32).fill(1)),
    dhPk: toBase64Url(new Uint8Array(32).fill(2)),
    scope: { kind: 'control', workspaces: 'all', expiresAt: null },
    pairedAt: '2026-01-01T00:00:00.000Z',
    lastSeenAt: null,
    revokedAt: null,
    ...overrides,
  }
}

async function modeOf(path: string): Promise<number> {
  const info = await stat(path)
  return info.mode & 0o777
}

describe('store: identity and defaults', () => {
  it('creates a 0600 identity whose deviceId derives from its signing key', async () => {
    const temp = await makeTempDir()
    try {
      const store = await MeshStore.open({ home: temp.dir })
      const identity = store.getIdentity()
      assert.equal(identity.version, 1)
      assert.match(identity.deviceId, /^dm_[a-z2-7]{22}$/u)
      assert.equal(deriveDeviceId(identity.signPk), identity.deviceId)
      assert.equal((await modeOf(join(temp.dir, 'identity.json'))), 0o600)
      // Both key pairs are real and usable.
      const signature = signEd25519(identity.signSk, new Uint8Array([1, 2, 3]))
      assert.equal(verifyEd25519(identity.signPk, new Uint8Array([1, 2, 3]), signature), true)
      assert.equal(verifyEd25519(identity.signPk, new Uint8Array([1, 2, 4]), signature), false)
      assert.equal(fromBase64Url(identity.dhPk)?.byteLength, 32)
    } finally {
      await temp.cleanup()
    }
  })

  it('reuses the persisted identity on reopen', async () => {
    const temp = await makeTempDir()
    try {
      const first = await MeshStore.open({ home: temp.dir })
      const before = first.getIdentity()
      const second = await MeshStore.open({ home: temp.dir })
      assert.deepEqual(second.getIdentity(), before)
    } finally {
      await temp.cleanup()
    }
  })

  it('writes default settings and persists patches', async () => {
    const temp = await makeTempDir()
    try {
      const store = await MeshStore.open({ home: temp.dir })
      assert.equal(store.getSettings().direct.port, 45871)
      assert.equal(store.getSettings().relay.enabled, false)
      await store.updateSettings({
        direct: { enabled: false, port: 5000 },
        relay: { endpoint: 'wss://relay.example.com/ws', enabled: true },
        autoApprovePairing: true,
      })
      const reopened = await MeshStore.open({ home: temp.dir })
      assert.equal(reopened.getSettings().direct.enabled, false)
      assert.equal(reopened.getSettings().direct.port, 5000)
      assert.equal(reopened.getSettings().relay.endpoint, 'wss://relay.example.com/ws')
      assert.equal(reopened.getSettings().autoApprovePairing, true)
    } finally {
      await temp.cleanup()
    }
  })
})

describe('store: peers', () => {
  it('upserts, patches, revokes and removes peers', async () => {
    const temp = await makeTempDir()
    try {
      const store = await MeshStore.open({ home: temp.dir })
      const id = 'dm_peer000000000000000001'
      await store.upsertPeer('controllers', peerRecord(id))
      assert.equal(store.getPeers().controllers.length, 1)

      const patched = await store.patchPeer('controllers', id, {
        name: 'Renamed',
        lastSeenAt: '2026-01-02T00:00:00.000Z',
      })
      assert.equal(patched?.name, 'Renamed')
      assert.equal(store.findPeer('controllers', id)?.lastSeenAt, '2026-01-02T00:00:00.000Z')

      const revoked = await store.revokePeer('controllers', id)
      assert.equal(revoked?.revokedAt !== null, true)
      // Revoking again keeps the original timestamp.
      const second = await store.revokePeer('controllers', id)
      assert.equal(second?.revokedAt, revoked?.revokedAt)

      assert.equal(await store.removePeer('controllers', id), true)
      assert.equal(await store.removePeer('controllers', id), false)
    } finally {
      await temp.cleanup()
    }
  })

  it('persists and reuses the relay server id', async () => {
    const temp = await makeTempDir()
    try {
      const store = await MeshStore.open({ home: temp.dir })
      const generated = await store.ensureRelayServerId()
      assert.equal((fromBase64Url(generated) ?? new Uint8Array()).byteLength, 32)
      const reopened = await MeshStore.open({ home: temp.dir })
      assert.equal(await reopened.ensureRelayServerId(), generated)
      assert.equal(reopened.getRelayServerId(), generated)
    } finally {
      await temp.cleanup()
    }
  })

  it('serializes concurrent settings writes from two stores', async () => {
    const temp = await makeTempDir()
    try {
      const a = await MeshStore.open({ home: temp.dir })
      const b = await MeshStore.open({ home: temp.dir })
      await Promise.all([
        a.updateSettings({ direct: { enabled: false } }),
        b.updateSettings({ autoApprovePairing: true }),
      ])
      const reopened = await MeshStore.open({ home: temp.dir })
      // The file lock + reload before write keeps both patches.
      assert.equal(reopened.getSettings().direct.enabled, false)
      assert.equal(reopened.getSettings().autoApprovePairing, true)
    } finally {
      await temp.cleanup()
    }
  })
})

describe('store: corruption recovery and audit', () => {
  it('backs up a corrupt peers.json and rebuilds it empty', async () => {
    const temp = await makeTempDir()
    try {
      const store = await MeshStore.open({ home: temp.dir })
      await store.upsertPeer('controllers', peerRecord('dm_peer000000000000000002'))
      await writeFile(join(temp.dir, 'peers.json'), '{not json', { mode: 0o600 })

      const reopened = await MeshStore.open({ home: temp.dir })
      assert.deepEqual(reopened.getPeers().controllers, [])
      const files = await readdir(temp.dir)
      assert.equal(files.some(name => name.startsWith('peers.json.corrupt-')), true)
    } finally {
      await temp.cleanup()
    }
  })

  it('regenerates a corrupt identity and keeps a backup', async () => {
    const temp = await makeTempDir()
    try {
      const first = await MeshStore.open({ home: temp.dir })
      const oldId = first.getIdentity().deviceId
      await writeFile(join(temp.dir, 'identity.json'), JSON.stringify({ version: 1, deviceId: 'broken' }), { mode: 0o600 })

      const reopened = await MeshStore.open({ home: temp.dir })
      assert.notEqual(reopened.getIdentity().deviceId, oldId)
      const files = await readdir(temp.dir)
      assert.equal(files.some(name => name.startsWith('identity.json.corrupt-')), true)
      const audit = await reopened.listAudit(20)
      assert.equal(audit.some(row => row.action === 'identity.regenerated'), true, 'key rotation must be audited')
    } finally {
      await temp.cleanup()
    }
  })

  it('rejects an identity whose private key does not match its public half', async () => {
    const temp = await makeTempDir()
    try {
      const identity = createDeviceIdentity({ name: 'Mismatched' })
      const other = createDeviceIdentity({ name: 'Other' })
      await writeFile(
        join(temp.dir, 'identity.json'),
        JSON.stringify({ ...identity, dhPk: other.dhPk }),
        { mode: 0o600 },
      )

      const reopened = await MeshStore.open({ home: temp.dir })
      // A corrupted/mismatched identity is backed up and regenerated, never
      // loaded as-is (loading it would fail later inside Noise/signing).
      assert.notEqual(reopened.getIdentity().deviceId, identity.deviceId)
      const files = await readdir(temp.dir)
      assert.equal(files.some(name => name.startsWith('identity.json.corrupt-')), true)
    } finally {
      await temp.cleanup()
    }
  })

  it('appends audit rows and lists newest first with a limit', async () => {
    const temp = await makeTempDir()
    try {
      const store = await MeshStore.open({ home: temp.dir })
      await store.appendAudit({ action: 'pairing.ticket.created', peer: 'dm_a' })
      await store.appendAudit({ action: 'pairing.approved', peer: 'dm_b', detail: 'ok' })
      await store.appendAudit({ action: 'portal.opened', peer: 'dm_c' })

      const rows = await store.listAudit(2)
      assert.equal(rows.length, 2)
      assert.equal(rows[0]?.action, 'portal.opened')
      assert.equal(rows[1]?.action, 'pairing.approved')
      // Audit lines are JSON and never include a token field.
      const raw = await readFile(join(temp.dir, 'audit.jsonl'), 'utf8')
      const parsed = JSON.parse(raw.trim().split('\n').at(-1) ?? '{}') as Record<string, unknown>
      assert.equal(typeof parsed.at, 'string')
      assert.equal(Object.hasOwn(parsed, 'token'), false)
      assert.equal((await modeOf(join(temp.dir, 'audit.jsonl'))), 0o600)
    } finally {
      await temp.cleanup()
    }
  })

  it('keeps private JSON documents behind the same lock', async () => {
    const temp = await makeTempDir()
    try {
      const store = await MeshStore.open({ home: temp.dir })
      await store.writePrivateJson('pairing.json', { version: 1, tickets: [{ hash: 'abc', exp: 1 }] })
      assert.deepEqual(await store.readPrivateJson('pairing.json'), {
        version: 1,
        tickets: [{ hash: 'abc', exp: 1 }],
      })
      await assert.rejects(() => store.writePrivateJson('../../escape.json', {}))
    } finally {
      await temp.cleanup()
    }
  })
})

describe('store: helpers', () => {
  it('atomicWriteFile replaces the target and applies the mode', async () => {
    const temp = await makeTempDir()
    try {
      const target = join(temp.dir, 'x.json')
      await atomicWriteFile(target, 'one', 0o600)
      assert.equal(await readFile(target, 'utf8'), 'one')
      await atomicWriteFile(target, 'two', 0o600)
      assert.equal(await readFile(target, 'utf8'), 'two')
      assert.equal(await modeOf(target), 0o600)
    } finally {
      await temp.cleanup()
    }
  })

  it('createDeviceIdentity honors name and platform', () => {
    const identity = createDeviceIdentity({ name: 'My box', platform: 'darwin' })
    assert.equal(identity.name, 'My box')
    assert.equal(identity.platform, 'darwin')
    assert.equal(deriveDeviceId(identity.signPk), identity.deviceId)
  })
})
