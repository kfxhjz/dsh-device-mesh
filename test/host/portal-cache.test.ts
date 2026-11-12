import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import { PortalCache, isImmutableAsset } from '../../src/host/portal-cache.ts'

describe('portal asset cache', () => {
  it('classifies only content-addressed GUI resources as immutable', () => {
    assert.equal(isImmutableAsset('/assets/index-BgUyXZcc.js', ''), true)
    assert.equal(isImmutableAsset('/locales/zh-abc.js', ''), true)
    assert.equal(isImmutableAsset('/plugins/??@deepseek-ai/dsh-api-gateway/client.js&rev=1234', ''), true)
    assert.equal(isImmutableAsset('/plugins/events', ''), false)
    assert.equal(isImmutableAsset('/api/device-mesh', ''), false)
    assert.equal(isImmutableAsset('/', ''), false)
  })

  it('invalidates every asset when the remote manifest digest changes', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dm-cache-unit-'))
    try {
      const cache = new PortalCache(directory)
      await cache.put('dm_dev', 'manifest-v1', '/assets/app-abc.js', '', Buffer.from('v1'), 'text/javascript')
      const hit = await cache.get('dm_dev', 'manifest-v1', '/assets/app-abc.js', '')
      assert.equal(hit?.body.toString(), 'v1')
      const otherBuild = await cache.get('dm_dev', 'manifest-v2', '/assets/app-abc.js', '')
      assert.equal(otherBuild, undefined)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('evicts the oldest entries when the disk budget is exceeded', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dm-cache-evict-'))
    try {
      const cache = new PortalCache(directory, { maxBytes: 400 })
      const put = async (name: string, fill: number): Promise<void> => {
        await cache.put('dm_dev', 'manifest', `/assets/${name}.js`, '', Buffer.alloc(200, fill), 'text/javascript')
        await new Promise(resolve => setTimeout(resolve, 15))
      }
      await put('a', 1)
      await put('b', 2)
      await put('c', 3)
      assert.equal(await cache.get('dm_dev', 'manifest', '/assets/a.js', ''), undefined)
      const newest = await cache.get('dm_dev', 'manifest', '/assets/c.js', '')
      assert.equal(newest?.body.length, 200)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
