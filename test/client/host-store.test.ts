import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  consumeAddHostRequest,
  getSelectedHost,
  requestAddHost,
  setSelectedHost,
  subscribeHost,
} from '../../src/client/host-store.ts'

describe('host store', () => {
  it('notifies subscribers only when the selected host changes', () => {
    setSelectedHost('local')
    let calls = 0
    const unsubscribe = subscribeHost(() => { calls += 1 })
    setSelectedHost('local')
    assert.equal(calls, 0)
    setSelectedHost('dm_device')
    assert.equal(getSelectedHost(), 'dm_device')
    assert.equal(calls, 1)
    setSelectedHost('dm_device')
    assert.equal(calls, 1)
    unsubscribe()
    setSelectedHost('local')
    assert.equal(getSelectedHost(), 'local')
    assert.equal(calls, 1)
  })

  it('queues one add-host request per call and consumes it once', () => {
    assert.equal(consumeAddHostRequest(), false)
    requestAddHost()
    requestAddHost()
    assert.equal(consumeAddHostRequest(), true)
    assert.equal(consumeAddHostRequest(), false)
  })
})
