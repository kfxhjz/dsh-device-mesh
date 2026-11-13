/**
 * End-to-end gzip for portal WebSocket messages.
 *
 * Session history and streamed tool output travel over DSH's
 * `/api/remote.mux` WebSocket, not over HTTP, so the daemon's HTTP gzip does not
 * reach them. `ws` per-message deflate is hop-by-hop: enabling it on the
 * daemon's loopback dial would inflate again before the bytes enter the Mesh and
 * would not shrink the relay/LAN transfer at all. This module compresses one
 * complete WebSocket message *before* the Mesh framing splits it into 32 KiB
 * chunks, and inflates it after the controller receives the message.
 *
 * Both directions are independent and negotiated per exchange
 * (`portal.ws.open.compress` / `portal.ws.open` result `compressed`), so a
 * mixed-version pair keeps using the unchanged uncompressed envelope.
 */
import { gzip, gunzip } from 'node:zlib'
import { promisify } from 'node:util'

import { encodeWsMessage } from '../shared/mesh-session.ts'

const gzipAsync = promisify(gzip)
const gunzipAsync = promisify(gunzip)

/** Messages smaller than this are sent raw: gzip's header/footer would dominate. */
export const WS_COMPRESSION_MIN_BYTES = 1024

/**
 * Decompression ceiling. DSH's gateway caps one WebSocket message at 16 MiB
 * (`maxPayload` in the portal dial), so a legitimate inflated message never
 * exceeds that. Keeping the ceiling equal to the upstream cap rejects a
 * compression bomb without allowing a 32 MiB allocation from one frame.
 */
export const WS_COMPRESSION_MAX_OUTPUT_BYTES = 16 * 1024 * 1024

/** Whether a payload of `bytes` is worth compressing. */
export function shouldCompressWsPayload(bytes: number): boolean {
  return bytes >= WS_COMPRESSION_MIN_BYTES
}

/**
 * Gzip one WebSocket message for the Mesh.
 * @param payload - raw message bytes.
 * @returns gzip bytes.
 */
export async function gzipWsPayload(payload: Uint8Array): Promise<Uint8Array> {
  // Level 3 compresses JSON session pages several times while staying much
  // cheaper than the default 6 on a multi-megabyte history snapshot.
  return new Uint8Array(await gzipAsync(payload, { level: 3 }))
}

/**
 * Inflate one gzip-compressed WebSocket message.
 * @param payload - gzip bytes.
 * @returns raw message bytes.
 * @throws {Error} when the payload is not gzip or exceeds the output ceiling.
 */
export async function gunzipWsPayload(payload: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await gunzipAsync(payload, {
    maxOutputLength: WS_COMPRESSION_MAX_OUTPUT_BYTES,
  }))
}

/**
 * Encode one message, compressing it when it is large enough and the peer
 * negotiated compression.
 * @param payload - raw message bytes.
 * @param kind - text or binary.
 * @param compress - whether this exchange negotiated compression.
 * @returns the `[kind byte][payload]` Mesh envelope.
 */
export async function encodePortalWsMessage(
  payload: Uint8Array,
  kind: 'text' | 'binary',
  compress: boolean,
): Promise<Uint8Array> {
  if (!compress || !shouldCompressWsPayload(payload.byteLength)) {
    return encodeWsMessage(payload, kind)
  }
  return encodeWsMessage(await gzipWsPayload(payload), kind, true)
}
