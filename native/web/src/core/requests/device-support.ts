/**
 * What this browser can do for the interactive requests that reach for the device, read once per advert
 * (`showableMethods`): a method is listed in `client.capabilities` only when the sheet that answers it can work here,
 * because a gateway that knows this page can show a location sends it here instead of telling the agent nobody can
 * (`contract/requests/README.md` section 1). A method that is not listed never arrives, so a sheet is never drawn that
 * cannot do its job.
 *
 *  - **Secure context.** The location, the camera, the microphone and the contact picker are all withheld from a page
 *    served over plain http (a LAN address), so none of them is advertised there. `localhost` is secure.
 *  - **`device.location`**: `navigator.geolocation`.
 *  - **`device.contact`**: the Contact Picker (`navigator.contacts` and `ContactsManager`), which only some browsers
 *    have; no other way to read a contact exists, so without it the method is not listed.
 *  - **`device.scan`**: `BarcodeDetector` and a camera to feed it (`getUserMedia`). Which symbologies it reads is asked
 *    of the detector when the sheet opens (`getSupportedFormats`): a request for only ones it cannot read is declined
 *    then, with a reason of its own.
 *  - **`input.signature`**: pointer events to draw with, `Path2D` to draw the same path the SVG carries, and the upload
 *    (`File`, `FormData`).
 *  - **`input.file`**: always where `File` and `FormData` exist. A recording (`capture: audio`) is made on the sheet where
 *    `MediaRecorder` and a microphone exist (`canRecord`) and picked from a file everywhere else.
 *  - **`device.calendar` is never listed**: a browser has no calendar to write to.
 */
import type { InteractiveMethod } from './interactive-types'

/** What a page can do, by the method it serves. */
export interface DeviceSupport {
  file: boolean
  signature: boolean
  location: boolean
  contact: boolean
  scan: boolean
}

/** The part of the page this reads, so a test can hand in its own. */
export interface SupportEnvironment {
  isSecureContext?: boolean
  navigator?: { geolocation?: unknown; contacts?: unknown; mediaDevices?: { getUserMedia?: unknown } }
  [name: string]: unknown
}

const has = (environment: SupportEnvironment, name: string): boolean => typeof environment[name] === 'function'

/** A camera or a microphone, as far as a page can tell without asking for it: only in a secure context. */
const media = (environment: SupportEnvironment): boolean =>
  environment.isSecureContext !== false && typeof environment.navigator?.mediaDevices?.getUserMedia === 'function'

/** Whether the page can record a voice note on the sheet. */
export const canRecord = (environment: SupportEnvironment = globalThis as SupportEnvironment): boolean =>
  media(environment) && has(environment, 'MediaRecorder')

export function detectDeviceSupport(environment: SupportEnvironment = globalThis as SupportEnvironment): DeviceSupport {
  const file = has(environment, 'File') && has(environment, 'FormData')
  const secure = environment.isSecureContext !== false
  const navigator = environment.navigator

  return {
    file,
    signature: file && has(environment, 'PointerEvent') && has(environment, 'Path2D'),
    location: secure && Boolean(navigator?.geolocation),
    contact: secure && Boolean(navigator?.contacts) && has(environment, 'ContactsManager'),
    scan: media(environment) && has(environment, 'BarcodeDetector')
  }
}

/** Which support each method needs; a method not here (`review.*`, `input.form`) needs none. */
const NEEDS: Partial<Record<InteractiveMethod, keyof DeviceSupport>> = {
  'input.file': 'file',
  'input.signature': 'signature',
  'device.location': 'location',
  'device.contact': 'contact',
  'device.scan': 'scan'
}

/** Whether `method` can be shown given `support`. */
export const isShowable = (method: InteractiveMethod, support: DeviceSupport): boolean => {
  const need = NEEDS[method]

  return need === undefined || support[need]
}
