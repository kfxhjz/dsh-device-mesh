/**
 * Regression tests for the shared WebSocket helpers.
 *
 * `ws.terminate()` on a CONNECTING socket aborts the handshake by emitting
 * `error` on the next tick. With no listener attached at that moment Node
 * raises an uncaught exception and the whole DSH host process exits. Both
 * helpers below must keep that event contained.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { WebSocket } from 'ws'

import { openWebSocket, terminateQuietly } from '../../src/host/transport/common.ts'

interface CapturedUncaught {
  readonly errors: unknown[]
  stop(): void
}

function captureUncaught(): CapturedUncaught {
  const errors: unknown[] = []
  const onUncaught = (error: Error): void => {
    errors.push(error)
  }
  process.on('uncaughtException', onUncaught)
  return {
    errors,
    stop: () => {
      process.off('uncaughtException', onUncaught)
    },
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
  })
}

test('openWebSocket: aborting a CONNECTING handshake rejects without an uncaught error', async () => {
  const captured = captureUncaught()
  try {
    const controller = new AbortController()
    const pending = openWebSocket({
      // Nothing listens here; the dial is aborted before it can complete.
      url: 'ws://127.0.0.1:9/',
      signal: controller.signal,
      handshakeTimeoutMs: 5_000,
    })
    assert.equal(controller.signal.aborted, false)
    controller.abort()

    await assert.rejects(pending, (error: Error) => error.name === 'AbortError')
    // The terminate-induced error event arrives on the next tick.
    await sleep(100)
    assert.deepEqual(captured.errors, [])
  } finally {
    captured.stop()
  }
})

test('terminateQuietly: dropping a CONNECTING socket never emits an uncaught error', async () => {
  const captured = captureUncaught()
  try {
    const ws = new WebSocket('ws://127.0.0.1:9/')
    assert.equal(ws.readyState, WebSocket.CONNECTING)

    terminateQuietly(ws)
    await sleep(100)

    assert.deepEqual(captured.errors, [])
    assert.equal(ws.readyState, WebSocket.CLOSED)
  } finally {
    captured.stop()
  }
})
