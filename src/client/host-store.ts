/**
 * Tiny shared UI store between the sidebar host switcher (a footer action) and
 * the Devices main panel. The sidebar entry owns the host choice so the current
 * host is visible without opening the panel; the panel reads the same value.
 */
import { useEffect, useState } from 'react'

let selectedHost = 'local'
let addHostRequests = 0
const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** Current host id: `'local'` or a paired device id. */
export function getSelectedHost(): string {
  return selectedHost
}

/** Select the host whose workspaces the panel shows. */
export function setSelectedHost(hostId: string): void {
  if (hostId === selectedHost) return
  selectedHost = hostId
  emit()
}

/** Subscribe to host-selection changes (used by the non-React sidebar bar). */
export function subscribeHost(listener: () => void): () => void {
  return subscribe(listener)
}

/** Subscribe to the current host id from a component. */
export function useSelectedHost(): string {
  const [value, setValue] = useState<string>(getSelectedHost)
  useEffect(() => subscribe(() =>{  setValue(getSelectedHost()) }), [])
  return value
}

/** Ask the panel to open its add-host dialog on the next render. */
export function requestAddHost(): void {
  addHostRequests += 1
  emit()
}

/** Consume a pending add-host request (returns true once per request). */
export function consumeAddHostRequest(): boolean {
  if (addHostRequests === 0) return false
  addHostRequests = 0
  return true
}

/** Subscribe to add-host requests (the value itself is only a change counter). */
export function useAddHostRequests(): number {
  const [value, setValue] = useState<number>(addHostRequests)
  useEffect(() => subscribe(() =>{  setValue(addHostRequests) }), [])
  return value
}
