/**
 * Smoke test: a stock `dsh web` instance with the plugin installed must
 *  1. load the Host half (the local API answers), and
 *  2. serve the browser half through the client-modules route with the
 *     `__ModuleLoader__.load` wrapper and the package id.
 *
 * This is the cheapest end-to-end proof that packaging is right; the pairing
 * test builds on the same harness.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createHomes,
  ensureBuilt,
  recordEvidence,
  startInstance,
} from './helpers/dsh-instance.ts'

test('plugin loads and serves its client bundle in a stock dsh web instance', async (t) => {
  await ensureBuilt()
  const homeSet = await createHomes(1)
  const [home] = homeSet.homes
  assert.ok(home)
  const dsh = await startInstance(home, 'plugin-load')
  t.after(async () => {
    await dsh.stop()
    await homeSet.cleanup()
  })

  // The Host plugin must be loaded: the local API route answers.
  const response = await dsh.fetchRaw('/api/device-mesh', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ endpoint: 'state' }),
  })
  assert.equal(response.status, 200, `local API status (logs: ${dsh.logs()})`)
  const body = await response.json() as { ok: boolean; value?: { self?: { deviceId?: string } } }
  assert.equal(body.ok, true)
  assert.match(body.value?.self?.deviceId ?? '', /^dm_/u)

  // The client module must appear in the boot graph.
  const index = await dsh.fetchRaw('/')
  assert.equal(index.status, 200)
  const html = await index.text()
  const entry = /"id":"dsh-device-mesh","url":"([^"]+)"/u.exec(html)
  assert.ok(entry, `client entry missing from boot graph (logs: ${dsh.logs()})`)

  const bundle = await dsh.fetchRaw(`/${entry[1]}`)
  assert.equal(bundle.status, 200)
  const source = await bundle.text()
  assert.match(source, /window\.__ModuleLoader__\.load\(/u)
  assert.match(source, /"dsh-device-mesh"/u)

  await recordEvidence('plugin-load', {
    url: dsh.base,
    clientEntry: entry[1],
    bundleBytes: source.length,
    self: body.value?.self,
  })
})
