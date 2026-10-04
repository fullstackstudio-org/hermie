/**
 * The browser's own device APIs, reached through one seam: the sheets that ask for the location, a contact, a code
 * through the camera or a recording read `navigator` and the page's globals here, so a test (and the lint rule that keeps
 * `window` and `navigator` out of the features) has one place to look.
 */

/** The page's `navigator`, or undefined where there is none (a server, a worker without one). */
export const pageNavigator = (): Navigator | undefined => (typeof navigator === 'undefined' ? undefined : navigator)

/** A global the DOM library does not declare (`BarcodeDetector`, `MediaRecorder`), or undefined where the browser lacks it. */
export const pageGlobal = <T>(name: string): T | undefined =>
  (globalThis as unknown as Record<string, unknown>)[name] as T | undefined
