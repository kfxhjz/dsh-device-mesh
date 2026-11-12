/**
 * Type-level declaration of the `deviceMesh` locale namespace.
 *
 * The DSH browser packages are not installed here, so this ambient module
 * declaration and interface merge stand in for the real
 * `declare module '@deepseek-ai/dsh-client-ui-slots'` block documented in
 * `docs/development.md` §7. It is types-only and never reaches the
 * browser bundle.
 */
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    deviceMesh: import('./locale.js').LocaleKey
  }
}
