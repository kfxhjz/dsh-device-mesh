/**
 * Minimal local declarations for the `react` baseline module.
 *
 * The browser bundle treats React as an external provided by the DSH web shell
 * (see docs/development.md §4), but this repository does not depend
 * on `@types/react`. These declarations exist only so `tsc -p tsconfig.json`
 * can check the plugin's own logic; JSX syntax is deliberately not used in
 * `src/client` because the repository tsconfig leaves the `jsx` option to the
 * esbuild build (which sets `jsx: 'automatic'`).
 */
declare module 'react' {
  export type ReactNode = unknown
  export type ReactElement = unknown

  export function createElement(
    type: unknown,
    props?: Record<string, unknown> | null,
    ...children: unknown[]
  ): unknown

  export function useState<T>(initialState: T | (() => T)): [T, (next: T | ((prev: T) => T)) => void]

  export function useEffect(effect: () => void | (() => void), deps?: readonly unknown[]): void

  export function useRef<T>(initialValue: T): { current: T }

  export function useCallback<T extends (...args: never[]) => unknown>(
    callback: T,
    deps: readonly unknown[],
  ): T

  export function useMemo<T>(factory: () => T, deps: readonly unknown[]): T
}
