/** Small shared helpers for the transport test-suite. */

import type { MeshTransport, TransportCloseInfo } from '../../src/shared/transport.ts'

export function nextMessage(transport: MeshTransport): Promise<Uint8Array> {
  return new Promise((resolve) => {
    const subscription: { off?: () => void } = {}
    subscription.off = transport.onMessage((bytes) => {
      subscription.off?.()
      resolve(bytes)
    })
  })
}

export function nextClose(transport: MeshTransport): Promise<TransportCloseInfo> {
  return new Promise((resolve) => {
    transport.onClose(resolve)
  })
}

export function bytes(length: number, seed: number): Uint8Array {
  const value = new Uint8Array(length)
  for (let index = 0; index < length; index += 1) {
    value[index] = (index * 31 + seed) & 0xff
  }
  return value
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
  })
}

export async function waitForCondition(
  predicate: () => boolean,
  timeoutMs = 3_000,
  label = 'condition',
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`)
    await sleep(10)
  }
}

/** Collects logger output so tests can assert that secrets never leak. */
export interface CapturedLogs {
  readonly messages: string[]
  readonly logger: {
    debug(message: string): void
    info(message: string): void
    warn(message: string): void
    error(message: string): void
  }
}

export function captureLogs(): CapturedLogs {
  const messages: string[] = []
  const push = (message: string): void => {
    messages.push(message)
  }
  return {
    messages,
    logger: { debug: push, info: push, warn: push, error: push },
  }
}
