import assert from 'node:assert/strict'
import { test } from 'node:test'

import { STYLE_ELEMENT_ID, styles } from '../../src/client/styles.ts'

test('stylesheet has a stable injection id and uses theme tokens', () => {
  assert.equal(STYLE_ELEMENT_ID, 'dsh-device-mesh-styles')
  assert.ok(styles.length > 10_000, 'stylesheet should cover the panel, pairing and sidebar surfaces')
  assert.ok(styles.includes('.dm-root'), 'panel root class')
  assert.ok(styles.includes('.dm-sidebar-host'), 'sidebar host bar class')
  assert.ok(styles.includes('var(--dsw-'), 'colours and typography come from DSH theme tokens')
  assert.ok(styles.includes('@media (hover: hover)'), 'hover-only affordances are guarded')
  assert.equal((styles.match(/\{/gu) ?? []).length, (styles.match(/\}/gu) ?? []).length, 'balanced braces')
})
