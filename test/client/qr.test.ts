import assert from 'node:assert/strict'
import { test } from 'node:test'

import { qrDataUrl } from '../../src/client/qr.ts'

const LINK = 'dsh-mesh://pair?d=eyJ2IjoxfQ'

test('qrDataUrl renders a base64 GIF data URL', () => {
  const url = qrDataUrl(LINK)
  assert.match(url, /^data:image\/gif;base64,[A-Za-z0-9+/]+={0,2}$/u)
  const payload = Buffer.from(url.split(',')[1] ?? '', 'base64')
  assert.ok(payload.byteLength > 100)
  assert.match(payload.subarray(0, 6).toString('ascii'), /^GIF8[79]a$/u)
})

test('cell size and margin change the encoded image', () => {
  const small = qrDataUrl(LINK, 4, 2)
  const large = qrDataUrl(LINK, 10, 6)
  assert.notEqual(small, large)
  assert.match(large, /^data:image\/gif;base64,/u)
})
