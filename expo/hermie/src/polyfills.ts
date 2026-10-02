// Hermie decodes gateway frames with TextDecoder. Hermes' JavaScript runtimes
// differ on whether it exists: Hermes (iOS/Android) ships TextEncoder/TextDecoder
// on recent React Native versions, older runtimes and JSC do not. Installing the
// shim unconditionally would shadow a faster native implementation, so this only
// fills the gap when there is one.
if (typeof globalThis.TextDecoder === 'undefined' || typeof globalThis.TextEncoder === 'undefined') {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('fast-text-encoding')
}

export {}
