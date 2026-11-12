import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  ConfigValidationError,
  PAIRING_APPROVAL_TIMEOUT_MS,
  PAIRING_CONNECT_TIMEOUT_MS,
  PAIRING_REQUEST_TTL_MS,
  normalizeRelayEndpoint,
  resolvePluginConfig,
} from '../../src/host/config.ts'

const ENV = { DSH_HOME: '/tmp/dsh-device-mesh-config-test' } as unknown as NodeJS.ProcessEnv

describe('config: relay transport security', () => {
  it('defaults bare and https endpoints to wss', () => {
    assert.equal(normalizeRelayEndpoint('relay.example.com'), 'wss://relay.example.com/ws')
    assert.equal(normalizeRelayEndpoint('https://relay.example.com'), 'wss://relay.example.com/ws')
    assert.equal(normalizeRelayEndpoint('wss://relay.example.com/ws'), 'wss://relay.example.com/ws')
  })

  it('accepts explicit insecure plain ws only with the opt-in', () => {
    assert.equal(
      normalizeRelayEndpoint('ws://relay.example.com/ws', { allowInsecure: true }),
      'ws://relay.example.com/ws',
    )
    assert.equal(
      normalizeRelayEndpoint('relay.example.com:8411', { useTls: false, allowInsecure: true }),
      'ws://relay.example.com:8411/ws',
    )
  })

  it('rejects plain ws to a non-loopback relay', () => {
    assert.throws(
      () => normalizeRelayEndpoint('ws://relay.example.com/ws'),
      (error: unknown) => error instanceof ConfigValidationError
        && /wss:\/\//u.test(error.message),
    )
    assert.throws(
      () => normalizeRelayEndpoint('http://relay.example.com'),
      ConfigValidationError,
    )
  })

  it('keeps ws for loopback hosts used by local E2E tests', () => {
    assert.equal(normalizeRelayEndpoint('ws://127.0.0.1:45871/ws'), 'ws://127.0.0.1:45871/ws')
    assert.equal(normalizeRelayEndpoint('ws://localhost:45871/ws'), 'ws://localhost:45871/ws')
    assert.equal(normalizeRelayEndpoint('ws://[::1]:45871/ws'), 'ws://[::1]:45871/ws')
    assert.equal(normalizeRelayEndpoint(null), null)
    assert.equal(normalizeRelayEndpoint(''), null)
  })

  it('applies the same rule when resolving plugin config', () => {
    assert.throws(
      () => resolvePluginConfig({ relay: { endpoint: 'ws://relay.example.com/ws' } }, ENV),
      ConfigValidationError,
    )
    const resolved = resolvePluginConfig(
      { relay: { endpoint: 'ws://127.0.0.1:45871/ws' } },
      ENV,
    )
    assert.equal(resolved.relay.endpoint, 'ws://127.0.0.1:45871/ws')
  })
})

describe('config: pairing windows', () => {
  it('keeps the controller wait longer than the daemon approval window (S4)', () => {
    assert.ok(
      PAIRING_APPROVAL_TIMEOUT_MS > PAIRING_REQUEST_TTL_MS,
      'the controller must not give up before the daemon request expires',
    )
    assert.ok(
      PAIRING_CONNECT_TIMEOUT_MS < PAIRING_APPROVAL_TIMEOUT_MS,
      'one endpoint attempt must not consume the whole approval window',
    )
  })
})
