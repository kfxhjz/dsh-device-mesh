import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { REMOTE_STATUS_REFRESH_MS, remoteRefreshDue } from '../../src/client/remote-status.ts'

const base = { now: 100_000, lastRefreshAt: 0, refreshing: false, status: 'online' }

describe('remote mirror refresh scheduling', () => {
  it('refreshes immediately on a fresh online selection', () => {
    assert.equal(remoteRefreshDue(base), true)
    assert.equal(remoteRefreshDue({ ...base, lastRefreshAt: 100_000 - REMOTE_STATUS_REFRESH_MS }), true)
  })

  it('throttles refreshes to the configured window', () => {
    assert.equal(remoteRefreshDue({ ...base, lastRefreshAt: 100_000 - (REMOTE_STATUS_REFRESH_MS - 1) }), false)
    assert.equal(remoteRefreshDue({ ...base, lastRefreshAt: 100_000 - REMOTE_STATUS_REFRESH_MS }), true)
  })

  it('does not poll while a refresh is in flight or the device is not online', () => {
    assert.equal(remoteRefreshDue({ ...base, refreshing: true }), false)
    for (const status of ['offline', 'connecting', 'revoked', 'error']) {
      assert.equal(remoteRefreshDue({ ...base, status }), false, status)
    }
  })
})
