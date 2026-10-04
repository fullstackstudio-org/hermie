/**
 * The browser's own device APIs, reached through one seam: the sheets that ask for the location, a contact, a code
 * through the camera or a recording read `navigator` and the browser's classes here, so a test (and the lint rule that
 * keeps `window` and `navigator` out of the features) has one place to look.
 *
 * The classes are named, never looked up by a computed key on `globalThis`: the plugin scanner reads `globalThis[name]` as
 * a way to reach anything, and a build that has one is no longer judged to be only data where it sees the word `sudo`.
 */

/** `BarcodeDetector`, which the DOM library does not declare, where the browser has it. */
declare const BarcodeDetector: unknown

/** The page's `navigator`, or undefined where there is none (a server, a worker without one). */
export const pageNavigator = (): Navigator | undefined => (typeof navigator === 'undefined' ? undefined : navigator)

/** The browser's barcode detector class, or undefined. */
export const pageBarcodeDetector = <T>(): T | undefined =>
  typeof BarcodeDetector === 'undefined' ? undefined : (BarcodeDetector as T)

/** The browser's media recorder class, or undefined. */
export const pageMediaRecorder = <T>(): T | undefined =>
  typeof MediaRecorder === 'undefined' ? undefined : (MediaRecorder as unknown as T)
