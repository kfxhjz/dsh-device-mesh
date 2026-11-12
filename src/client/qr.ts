/**
 * QR rendering for pairing links.
 *
 * Uses the `qrcode-generator` dependency, which the esbuild client bundle
 * inlines (it is not on the DSH platform external list). The generated SVG/GIF
 * is rendered on a white plate so it stays scannable in dark themes; the
 * module also accepts the host-provided `qrSvg` as a fallback.
 */
import qrcodeFactory from 'qrcode-generator'

interface QrCodeInstance {
  addData(data: string): void
  make(): void
  createSvgTag(options?: { readonly cellSize?: number; readonly margin?: number; readonly scalable?: boolean }): string
  createDataURL(cellSize?: number, margin?: number): string
}

type QrCodeFactory = (typeNumber: number, errorCorrectionLevel: 'L' | 'M' | 'Q' | 'H') => QrCodeInstance

const factory = qrcodeFactory as unknown as QrCodeFactory

/** Build a QR code instance for a pairing link. */
function buildCode(link: string): QrCodeInstance {
  const code = factory(0, 'M')
  code.addData(link)
  code.make()
  return code
}

/**
 * Render the QR as a GIF data URL, used in an `<img>` so no untrusted markup is
 * injected into the page.
 *
 * @param link - pairing link encoded into the code.
 * @param cellSize - module size in pixels.
 * @param margin - quiet-zone width in pixels.
 * @returns `data:image/gif;base64,…`.
 */
export function qrDataUrl(link: string, cellSize = 8, margin = 4): string {
  return buildCode(link).createDataURL(cellSize, margin)
}
