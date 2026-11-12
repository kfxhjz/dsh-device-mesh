/**
 * Relay endpoint input helpers.
 *
 * The host normalizes a bare host, `//host`, `ws(s)://` and `http(s)://`
 * (mapping HTTP(S) to WS(S)). The UI's TLS toggle only decides the scheme for a
 * bare host, so an explicit scheme in the pasted text must win over the toggle;
 * otherwise a pasted `ws://…` is rejected when the toggle is still on, and a
 * pasted `https://…` can be saved with a contradictory `useTls` flag.
 */

/**
 * Effective TLS choice for a relay input string.
 * @param input - raw field value.
 * @param toggle - current **Use TLS** switch value.
 * @returns `true` for an explicit secure scheme, `false` for an explicit
 *   plaintext scheme, otherwise the toggle.
 */
export function relayTlsForInput(input: string, toggle: boolean): boolean {
  const text = input.trim().toLowerCase()
  if (text.startsWith('https://') || text.startsWith('wss://')) return true
  if (text.startsWith('http://') || text.startsWith('ws://')) return false
  return toggle
}
