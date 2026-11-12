/**
 * Refresh cadence for the sidebar's remote workspace mirror.
 *
 * The mirror is fed from the controller Host's `state` snapshot. That snapshot
 * only changes when the controller asks the daemon for a fresh listing, so the
 * mirror has to re-request `workspaces.refresh` while a remote host is selected;
 * otherwise running/awaiting session state stays frozen at the first fetch.
 *
 * Five seconds keeps the spinner responsive without rebuilding the daemon's
 * workspace inventory on every 2.5 s state tick.
 */

/** Minimum time between two remote workspace refreshes, in milliseconds. */
export const REMOTE_STATUS_REFRESH_MS = 5_000

/** Inputs for {@link remoteRefreshDue}. */
export interface RemoteRefreshInput {
  /** Current wall clock. */
  readonly now: number
  /** When the last refresh was requested (`0` means never). */
  readonly lastRefreshAt: number
  /** True while a previous refresh is still in flight. */
  readonly refreshing: boolean
  /** Current device status from the mesh snapshot. */
  readonly status: string
}

/**
 * Whether the mirror should ask for a fresh remote workspace listing now.
 *
 * Only an online device is polled: offline/connecting sessions cannot answer and
 * the next `online` transition schedules an immediate refresh because
 * `lastRefreshAt` is still older than the window.
 *
 * @param input - clock, last refresh, in-flight flag and device status.
 * @returns true when a refresh is due.
 */
export function remoteRefreshDue(input: RemoteRefreshInput): boolean {
  if (input.refreshing) return false
  if (input.status !== 'online') return false
  if (input.lastRefreshAt <= 0) return true
  return input.now - input.lastRefreshAt >= REMOTE_STATUS_REFRESH_MS
}
