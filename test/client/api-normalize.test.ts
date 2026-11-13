import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  MeshApiError,
  extractPairingLink,
  normalizeDevice,
  normalizePairedDevice,
  normalizePortalUrl,
  normalizeState,
  normalizeTicket,
  normalizeWorkspaces,
} from '../../src/client/api.ts'

describe('api: workspace normalization', () => {
  it('maps a workspace payload and filters malformed rows', () => {
    const result = normalizeWorkspaces({
      updatedAt: '2026-11-12T00:00:00.000Z',
      truncated: true,
      workspaces: [
        {
          id: 'w1',
          title: 'Demo',
          path: '/tmp/demo',
          sessions: [
            {
              id: 's1',
              title: 'Session one',
              updatedAt: '2026-11-12T00:00:00.000Z',
              running: true,
              awaitingUser: true,
              unread: true,
              archived: true,
            },
            { id: '', title: 'dropped: empty id' },
            'not a session',
          ],
        },
        { title: 'dropped: no id' },
        'not a workspace',
      ],
    })
    assert.equal(result.updatedAt, '2026-11-12T00:00:00.000Z')
    assert.equal(result.truncated, true)
    assert.equal(result.workspaces.length, 1)
    const workspace = result.workspaces[0]
    assert.ok(workspace)
    assert.equal(workspace.id, 'w1')
    assert.equal(workspace.title, 'Demo')
    assert.equal(workspace.path, '/tmp/demo')
    assert.deepEqual(workspace.sessions, [{
      id: 's1',
      title: 'Session one',
      updatedAt: '2026-11-12T00:00:00.000Z',
      running: true,
      awaitingUser: true,
      unread: true,
      archived: true,
    }])
  })

  it('accepts a bare workspace array and stamps a fresh updatedAt', () => {
    const result = normalizeWorkspaces([{ id: 'w1' }])
    assert.equal(result.workspaces.length, 1)
    assert.match(result.updatedAt, /^\d{4}-\d{2}-\d{2}T/u)
    assert.equal(result.truncated, undefined)
    assert.deepEqual(normalizeWorkspaces(undefined).workspaces, [])
    assert.deepEqual(normalizeWorkspaces({ workspaces: 'nope' }).workspaces, [])
  })
})

describe('api: device and state normalization', () => {
  it('fills safe defaults for a partial device row', () => {
    const device = normalizeDevice({ deviceId: 'd1' })
    assert.equal(device.deviceId, 'd1')
    assert.equal(device.name, 'd1')
    assert.equal(device.direction, 'controller')
    assert.equal(device.status, 'offline')
    assert.equal(device.revoked, false)
    assert.deepEqual(device.scope, { kind: 'control', workspaces: 'all', expiresAt: null })
    assert.equal('sas' in device, false)
    assert.equal('statusDetail' in device, false)
  })

  it('keeps daemon facts, optional detail and a truncated remote listing', () => {
    const device = normalizeDevice({
      deviceId: 'd2',
      name: 'Studio',
      platform: 'linux',
      direction: 'daemon',
      status: 'online',
      revoked: true,
      sas: '123-456',
      statusDetail: 'waiting for approval',
      remoteWorkspacesTruncated: true,
      remoteWorkspaces: { workspaces: [{ id: 'w1' }] },
    })
    assert.equal(device.platform, 'linux')
    assert.equal(device.direction, 'daemon')
    assert.equal(device.revoked, true)
    assert.equal(device.sas, '123-456')
    assert.equal(device.statusDetail, 'waiting for approval')
    assert.equal(device.remoteWorkspaces?.length, 1)
    assert.equal(device.remoteWorkspacesTruncated, true)
    assert.equal(normalizeDevice('nope').status, 'offline')
  })

  it('normalizes a partial host state snapshot', () => {
    const state = normalizeState({
      self: { deviceId: 'self', platform: 'darwin' },
      devices: [{ deviceId: 'a' }, 'nope'],
      pendingPairings: [
        { requestId: 'r1', peer: { deviceId: 'p1' }, sas: '111-222', createdAt: 'now' },
        { peer: { deviceId: 'no-request-id' } },
      ],
      portals: [{ deviceId: 'a', url: 'http://127.0.0.1:1/' }, { deviceId: '', url: 'http://x/' }],
    })
    assert.equal(state.protocol, 1)
    assert.equal(state.self.deviceId, 'self')
    assert.equal(state.self.name, 'self')
    assert.equal(state.direct.enabled, false)
    assert.equal(state.relay.useTls, true)
    // Device rows degrade to safe defaults instead of disappearing; pairing
    // requests without a request id are dropped.
    assert.equal(state.devices.length, 2)
    assert.equal(state.devices[1]?.deviceId, '')
    assert.equal(state.pendingPairings.length, 1)
    assert.equal(state.pendingPairings[0]?.sas, '111-222')
    assert.equal(state.portals.length, 1)

    const empty = normalizeState(null)
    assert.deepEqual(empty.devices, [])
    assert.deepEqual(empty.pendingPairings, [])
    assert.deepEqual(empty.portals, [])
  })
})

describe('api: pairing payload normalization', () => {
  it('rejects a ticket without a link and keeps optional fields', () => {
    assert.throws(
      () => normalizeTicket({ expiresAt: 'later' }),
      (error: unknown) => error instanceof MeshApiError && error.code === 'client/bad-ticket',
    )
    const ticket = normalizeTicket({ link: 'dsh-mesh://pair?d=abc', expiresAt: 'later', qrSvg: '<svg/>' })
    assert.equal(ticket.link, 'dsh-mesh://pair?d=abc')
    assert.equal(ticket.expiresAt, 'later')
    assert.equal(ticket.qrSvg, '<svg/>')
    assert.equal('qrSvg' in normalizeTicket({ link: 'x' }), false)
  })

  it('accepts every documented portal-URL shape', () => {
    assert.equal(normalizePortalUrl('http://127.0.0.1:1/'), 'http://127.0.0.1:1/')
    assert.equal(normalizePortalUrl({ url: 'http://127.0.0.1:2/' }), 'http://127.0.0.1:2/')
    assert.equal(normalizePortalUrl({ value: { url: 'http://127.0.0.1:3/' } }), 'http://127.0.0.1:3/')
    for (const value of [{}, '', null, { url: '' }]) {
      assert.throws(
        () => normalizePortalUrl(value),
        (error: unknown) => error instanceof MeshApiError && error.code === 'client/bad-portal',
      )
    }
  })

  it('normalizes pair.complete with nested or bare device shapes', () => {
    const nested = normalizePairedDevice({ deviceId: 'd1', pairing: true, device: { deviceId: 'd1', name: 'Box' } })
    assert.equal(nested.deviceId, 'd1')
    assert.equal(nested.pairing, true)
    assert.equal(nested.device.name, 'Box')

    const bare = normalizePairedDevice({ deviceId: 'd2' })
    assert.equal(bare.deviceId, 'd2')
    assert.equal(bare.pairing, false)
    assert.equal(bare.device.deviceId, 'd2')
  })

  it('extracts one pairing link from pasted or scanned text', () => {
    assert.equal(extractPairingLink('  dsh-mesh://pair?d=abc  '), 'dsh-mesh://pair?d=abc')
    assert.equal(extractPairingLink('scan result: dsh-mesh://pair?d=abc thanks'), 'dsh-mesh://pair?d=abc')
    assert.equal(extractPairingLink('"dsh-mesh://pair?d=abc"'), 'dsh-mesh://pair?d=abc')
    assert.equal(extractPairingLink('no link here'), null)
    assert.equal(extractPairingLink('dsh-mesh://pair?d='), null)
    assert.equal(extractPairingLink(''), null)
  })
})
