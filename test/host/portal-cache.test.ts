import assert from 'node:assert/strict'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
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
      // Eviction removes .bin and .json pairs together without leaving orphans.
      const files = await readdir(directory)
      const bins = files.filter(name => name.endsWith('.bin')).map(name => name.slice(0, -4)).sort()
      const jsons = files.filter(name => name.endsWith('.json')).map(name => name.slice(0, -5)).sort()
      assert.deepEqual(bins, jsons)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('rejects tampered metadata containing control characters in cached headers', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dm-cache-meta-'))
    try {
      const cache = new PortalCache(directory)
      await cache.put('dm_dev', 'manifest', '/assets/app.js', '', Buffer.from('ok'), 'text/javascript')
      const files = await readdir(directory)
      const jsonFile = files.find(name => name.endsWith('.json'))
      assert.ok(jsonFile)
      await writeFile(
        join(directory, jsonFile),
        JSON.stringify({ contentType: 'text/javascript\r\nX-Evil: 1', path: '/assets/app.js', storedAt: new Date().toISOString() }),
      )
      assert.equal(await cache.get('dm_dev', 'manifest', '/assets/app.js', ''), undefined)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('refuses to cache assets with invalid content-encoding instead of stripping it', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dm-cache-encoding-'))
    try {
      const cache = new PortalCache(directory)
      await cache.put(
        'dm_dev',
        'manifest',
        '/assets/bundle.js',
        '',
        Buffer.from('compressed-bytes'),
        'text/javascript',
        'gzip\r\nX-Injected: 1',
      )
      assert.equal(await cache.get('dm_dev', 'manifest', '/assets/bundle.js', ''), undefined)
      const files = await readdir(directory)
      assert.deepEqual(files, [])
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
