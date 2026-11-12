import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { NS, en, zh } from '../../src/client/locale.ts'

describe('locale dictionaries', () => {
  it('exposes the same non-empty keys in English and Chinese', () => {
    const zhKeys = Object.keys(zh).sort()
    const enKeys = Object.keys(en).sort()
    assert.deepEqual(enKeys, zhKeys)
    assert.ok(zhKeys.length >= 50, `expected >= 50 keys, got ${zhKeys.length}`)
    for (const key of zhKeys) {
      const zhValue: unknown = (zh as Record<string, unknown>)[key]
      const enValue: unknown = (en as Record<string, unknown>)[key]
      assert.equal(typeof zhValue, 'string', key)
      assert.equal(typeof enValue, 'string', key)
      assert.ok((zhValue as string).length > 0, `zh.${key} is empty`)
      assert.ok((enValue as string).length > 0, `en.${key} is empty`)
    }
    assert.equal(NS, 'deviceMesh')
  })

  it('keeps {count} placeholders in both translations', () => {
    const keys = ['time.secondsAgo', 'time.minutesAgo', 'time.hoursAgo', 'time.daysAgo'] as const
    for (const key of keys) {
      assert.match(zh[key], /\{count\}/u, `zh.${key}`)
      assert.match(en[key], /\{count\}/u, `en.${key}`)
    }
  })
})
