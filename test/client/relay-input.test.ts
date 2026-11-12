import assert from 'node:assert/strict'
import { test } from 'node:test'

import { relayTlsForInput } from '../../src/client/relay-endpoint.ts'

test('an explicit relay scheme wins over the TLS toggle', () => {
  assert.equal(relayTlsForInput('https://relay.example.com/ws', false), true)
  assert.equal(relayTlsForInput('wss://relay.example.com/ws', false), true)
  assert.equal(relayTlsForInput('http://relay.example.com/ws', true), false)
  assert.equal(relayTlsForInput('ws://relay.example.com/ws', true), false)
  assert.equal(relayTlsForInput('  WSS://RELAY.EXAMPLE.COM/ws  ', false), true)
  assert.equal(relayTlsForInput('relay.example.com:4000', true), true)
  assert.equal(relayTlsForInput('relay.example.com', false), false)
})
