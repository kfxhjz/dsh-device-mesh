/**
 * Local type surface for the DSH browser plugin APIs this package consumes.
 *
 * The DSH client packages are not installed in this repository (the browser
 * half is validated by the esbuild bundle, not by `tsc`), so this file declares
 * the narrow slices of the Cordis context and slot registry that `index.tsx`
 * uses. Every member is the documented shape from
 * `docs/development.md` §7 and the DSH `ui-slots` contract.
 */

/** Namespace-bound translation function: `{name}` placeholders are interpolated. */
export type Translate = (key: string, params?: Readonly<Record<string, string | number>>) => string

/** One dictionary set accepted by `ctx.locale.register`. */
export type LocaleDictionaries = Readonly<Record<string, Readonly<Record<string, string>>>>

/** Service face of `ctx.locale`. */
export interface LocaleService {
  register(namespace: string, dictionaries: LocaleDictionaries): () => void
  bind(namespace: string): Translate
}

/** Options accepted by `ctx.slots.register`. */
export interface SlotRegisterOptions {
  name: string
  key?: string
  id?: string
  order?: number
  priority?: number
  locale?: string
  label?: () => string
  inject?: (...args: never[]) => Record<string, unknown>
  store?: unknown
  children?: Record<string, { kind: string; scope: string }>
}

/** Service face of `ctx.slots`, limited to registration and declaration injection. */
export interface SlotsService {
  inject(name: string, callback: () => unknown): () => void
  register(options: SlotRegisterOptions, component: unknown): () => void
}

/** Column/panel navigation face of `ctx.layout`. */
export interface LayoutService {
  selectPanel(panelId: string): void
}

/** Options accepted by `ctx.sidebarRight.openTab`. */
export interface SidebarRightOpenOptions {
  params?: { readonly url?: string }
}

/** The optional right-sidebar service (only present when that feature is composed). */
export interface SidebarRightService {
  openTab(kind: string, options?: SidebarRightOpenOptions): void
}

/** The Cordis client context slices this plugin declares in `inject`. */
export interface ClientContext {
  readonly slots: SlotsService
  readonly locale: LocaleService
  readonly layout: LayoutService
  /** Cordis effects own every registration this plugin makes. */
  effect(callback: () => void | (() => void), label?: string): void
  /** Reflective service lookup (`ctx.get(name)`), used for optional services. */
  get?(name: string): unknown
}

/** One detected barcode from the experimental `BarcodeDetector` API. */
export interface DetectedBarcode {
  readonly rawValue?: string
}

/** Minimal `BarcodeDetector` face: Chromium-only, feature-detected at runtime. */
export interface BarcodeDetectorLike {
  detect(source: HTMLVideoElement): Promise<readonly DetectedBarcode[]>
}

export interface BarcodeDetectorConstructor {
  new (options?: { readonly formats?: readonly string[] }): BarcodeDetectorLike
}

/** Gamepad-shaped event target check is unnecessary; only the two DOM extras we need. */
export interface WindowWithBarcodeDetector extends Window {
  readonly BarcodeDetector?: BarcodeDetectorConstructor
}
