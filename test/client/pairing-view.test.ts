/**
 * The plaintext-relay warning is the one UI surface that can authorize an
 * insecure dial, so its copy, URL list and both actions are asserted here.
 * React is rendered by calling the hook-free component directly: the element
 * tree is plain `createElement` data, no DOM or react-dom needed.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { InsecureRelayWarning } from '../../src/client/pairing.ts'
import { en } from '../../src/client/locale.ts'

interface ElementLike {
  readonly type?: unknown
  readonly props?: Record<string, unknown> & { readonly children?: unknown }
}

/** Translate with the shipped English copy and simple `{name}` interpolation. */
function translate(key: string, params: Readonly<Record<string, string | number>> = {}): string {
  const template = (en as Record<string, string>)[key] ?? key
  return template.replace(/\{(\w+)\}/gu, (_match, name: string) => String(params[name] ?? ''))
}

/** Collect the visible text of an element tree. */
function textOf(node: unknown): string {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join(' ')
  return textOf((node as ElementLike).props?.children)
}

/** Find the first element with `role="dialog"`. */
function dialogOf(node: unknown): ElementLike | null {
  if (node === null || typeof node !== 'object') return null
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = dialogOf(child)
      if (hit !== null) return hit
    }
    return null
  }
  const element = node as ElementLike
  if (element.props?.role === 'dialog') return element
  return dialogOf(element.props?.children)
}

/** Collect every `button` element in the tree. */
function buttonsOf(node: unknown, found: ElementLike[] = []): ElementLike[] {
  if (node === null || typeof node !== 'object') return found
  if (Array.isArray(node)) {
    for (const child of node) buttonsOf(child, found)
    return found
  }
  const element = node as ElementLike
  if (element.type === 'button') found.push(element)
  buttonsOf(element.props?.children, found)
  return found
}

function render(overrides: {
  readonly name?: string
  readonly endpoints?: readonly string[]
  readonly onCancel?: () => void
  readonly onConfirm?: () => void
} = {}): ElementLike {
  return InsecureRelayWarning({
    t: translate,
    name: overrides.name ?? 'Daemon',
    endpoints: overrides.endpoints ?? ['ws://relay.example.com/ws'],
    onCancel: overrides.onCancel ?? (() => undefined),
    onConfirm: overrides.onConfirm ?? (() => undefined),
  }) as ElementLike
}

describe('pairing view: plaintext relay warning', () => {
  it('names the daemon, lists every affected relay and explains the risk', () => {
    const element = render({
      name: 'Studio',
      endpoints: ['ws://relay.example.com/ws', 'ws://203.0.113.10:8411/ws'],
    })
    const text = textOf(element)
    assert.match(text, /Studio/u)
    assert.match(text, /ws:\/\/relay\.example\.com\/ws/u)
    assert.match(text, /ws:\/\/203\.0\.113\.10:8411\/ws/u)
    assert.match(text, /Relay is not encrypted/u)
    assert.match(text, /stays encrypted/u)
    const dialog = dialogOf(element)
    assert.ok(dialog, 'the warning must be a dialog')
    assert.equal(dialog.props?.['aria-label'], 'Relay is not encrypted')
    assert.equal(dialog.props?.['aria-modal'], 'true')
  })

  it('offers cancel and an explicit insecure confirmation', () => {
    let cancelled = 0
    let confirmed = 0
    const element = render({ onCancel: () => { cancelled += 1 }, onConfirm: () => { confirmed += 1 } })
    const buttons = buttonsOf(element)
    const labelled = (label: string): ElementLike | undefined => buttons.find(
      button => textOf(button.props?.children).trim() === label,
    )
    const continueButton = labelled('Continue anyway')
    const cancelButton = labelled('Cancel')
    assert.ok(continueButton, 'the warning must offer "Continue anyway"')
    assert.ok(cancelButton, 'the warning must offer a cancel action')
    assert.equal(cancelButton.props?.autoFocus, true, 'focus must default to the safe choice')
    const onConfirm = continueButton.props?.onClick as (() => void) | undefined
    const onCancel = cancelButton.props?.onClick as (() => void) | undefined
    assert.equal(typeof onConfirm, 'function')
    assert.equal(typeof onCancel, 'function')
    onConfirm?.()
    onCancel?.()
    assert.equal(confirmed, 1)
    assert.equal(cancelled, 1)
  })
})
