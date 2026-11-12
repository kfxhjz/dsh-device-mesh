import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { Config, apply, createHostRuntime, inject, name } from '../../src/host/index.ts'
import { DeviceMeshBroker } from '../../src/host/broker.ts'
import type { HostContextLike } from '../../src/host/config.ts'
import { makeTempDir } from './helpers.ts'

interface FakeCtx {
  readonly ctx: HostContextLike
  readonly services: Record<string, unknown>
  readonly registered: Array<Record<string, unknown>>
  readonly effects: string[]
  readonly dispose: () => Promise<void>
}

function fakeCtx(services: Record<string, unknown> = {}): FakeCtx {
  const registered: Array<Record<string, unknown>> = []
  const effects: string[] = []
  const disposers: Array<() => void | Promise<void>> = []
  const ctx = {
    get: (serviceName: string): unknown => services[serviceName],
    effect: (callback: () => void | (() => void | Promise<void>), label?: string): unknown => {
      if (label !== undefined) effects.push(label)
      const disposer = callback()
      if (typeof disposer === 'function') disposers.push(disposer)
      return undefined
    },
  }
  return {
    ctx,
    services,
    registered,
    effects,
    dispose: async () => {
      for (const disposer of disposers.splice(0)) await disposer()
    },
  }
}

describe('index: plugin manifest', () => {
  it('exports the Cordis manifest surface', () => {
    assert.equal(name, 'device-mesh')
    assert.ok(inject.includes('webServer'))
    assert.ok(inject.includes('connection'))
    const standard = (Config as unknown as {
      '~standard': { version: number; validate(value: unknown): unknown }
    })['~standard']
    assert.equal(standard.version, 1)
    const result = standard.validate({}) as { value?: { direct: { port: number } }; issues?: unknown }
    assert.ok(result.value)
    assert.equal(result.value?.direct.port, 45871)
    const invalid = standard.validate({ direct: { port: -1 } }) as { issues?: unknown[] }
    assert.ok(Array.isArray(invalid.issues) && invalid.issues.length > 0)
  })
})

describe('index: host runtime', () => {
  it('loads offline, reuses the identity and serves the local API', async () => {
    const temp = await makeTempDir()
    try {
      const first = await createHostRuntime(fakeCtx().ctx, {
        home: temp.dir,
        offline: true,
        appVersion: '9.9.9',
        direct: { enabled: true, port: 45872 },
        logLevel: 'error',
      })
      const identity = first.store.getIdentity()
      assert.equal(first.config.offline, true)
      assert.equal(first.broker.state().self.appVersion, '9.9.9')
      assert.equal(first.broker.state().direct.enabled, false)
      // Plugin config seeds the one-time settings file.
      assert.equal(first.store.getSettings().direct.port, 45872)
      const state = await first.api.dispatch({ endpoint: 'state' })
      assert.equal(state.ok, true)
      if (state.ok) {
        const value = state.value as { self: { deviceId: string } }
        assert.equal(value.self.deviceId, identity.deviceId)
      }
      await first.stop()

      const second = await createHostRuntime(fakeCtx().ctx, {
        home: temp.dir,
        offline: true,
        logLevel: 'error',
      })
      assert.equal(second.store.getIdentity().deviceId, identity.deviceId)
      await second.stop()
    } finally {
      await temp.cleanup()
    }
  })

  it('registers POST /api/device-mesh on the DSH connection fetch registry', async () => {
    const temp = await makeTempDir()
    const fake = fakeCtx()
    const connection = {
      fetch: {
        register(route: Record<string, unknown>): () => Promise<void> {
          fake.registered.push(route)
          return async () => {}
        },
      },
    }
    fake.services.connection = connection
    try {
      await apply(fake.ctx, {
        home: temp.dir,
        offline: true,
        direct: { enabled: false },
        logLevel: 'error',
      })
      assert.equal(fake.registered.length, 1)
      const route = fake.registered[0]
      assert.ok(route)
      assert.equal(route.path, '/api/device-mesh')
      assert.deepEqual(route.methods, ['POST'])
      assert.equal(route.requestBody, 'buffered')
      assert.ok(fake.effects.includes('device-mesh: local API route'))
      assert.ok(fake.effects.includes('device-mesh: runtime'))

      const handle = route.fetch as (request: Request) => Promise<Response>
      const response = await handle(new Request('http://127.0.0.1/api/device-mesh', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ endpoint: 'state' }),
      }))
      assert.equal(response.status, 200)
      const body = await response.json() as { ok: boolean; value?: { protocol: number } }
      assert.equal(body.ok, true)
      assert.equal(body.value?.protocol, 1)
      await fake.dispose()
    } finally {
      await temp.cleanup()
    }
  })

  it('disposes the runtime when fetch route registration throws', async () => {
    const temp = await makeTempDir()
    const fake = fakeCtx()
    fake.services.connection = {
      fetch: {
        register(): () => Promise<void> {
          throw new Error('connection: exact Fetch route is already registered')
        },
      },
    }
    const prototype = DeviceMeshBroker.prototype as unknown as {
      stop(this: DeviceMeshBroker): Promise<void>
    }
    const originalStop = prototype.stop
    let stops = 0
    prototype.stop = async function stop(this: DeviceMeshBroker): Promise<void> {
      stops += 1
      return originalStop.call(this)
    }
    try {
      await assert.rejects(
        () => apply(fake.ctx, { home: temp.dir, offline: true, logLevel: 'error' }),
        /already registered/u,
      )
      assert.ok(stops >= 1, 'a failed route registration must stop the broker/listeners')
    } finally {
      prototype.stop = originalStop
      await fake.dispose()
      await temp.cleanup()
    }
  })

  it('loads without a Connection service (degraded local API)', async () => {
    const temp = await makeTempDir()
    const fake = fakeCtx()
    try {
      await apply(fake.ctx, { home: temp.dir, offline: true, logLevel: 'error' })
      assert.equal(fake.registered.length, 0)
      assert.ok(fake.effects.includes('device-mesh: runtime'))
      await fake.dispose()
    } finally {
      await temp.cleanup()
    }
  })
})
