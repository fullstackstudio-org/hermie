/**
 * What a page can do for the interactive requests that reach for the device, read from an environment a test hands in
 * (`device-support.ts`): a method is advertised only where its sheet can work, and a plain-http page (a LAN address)
 * withholds the location, the camera, the microphone and the contact picker.
 */
import { describe, expect, it } from 'vitest'

import { canRecord, detectDeviceSupport, isShowable, type SupportEnvironment } from './device-support'

const fn = (): void => undefined

/** A page that can do everything, in a secure context; a test takes one thing away. */
const full = (): SupportEnvironment => ({
  isSecureContext: true,
  File: fn,
  FormData: fn,
  PointerEvent: fn,
  Path2D: fn,
  ContactsManager: fn,
  BarcodeDetector: fn,
  MediaRecorder: fn,
  navigator: { geolocation: {}, contacts: {}, mediaDevices: { getUserMedia: fn } }
})

const without = (name: string): SupportEnvironment => {
  const environment = full()

  delete environment[name]

  return environment
}

describe('detectDeviceSupport', () => {
  it('lists everything on a page that has it all', () => {
    expect(detectDeviceSupport(full())).toEqual({
      file: true,
      signature: true,
      location: true,
      contact: true,
      scan: true
    })
  })

  it('lists nothing but the file on a page that has none of it', () => {
    expect(detectDeviceSupport({})).toEqual({
      file: false,
      signature: false,
      location: false,
      contact: false,
      scan: false
    })
  })

  it('withholds the location, the contact picker and the scanner from an insecure context, and nothing else', () => {
    expect(detectDeviceSupport({ ...full(), isSecureContext: false })).toEqual({
      file: true,
      signature: true,
      location: false,
      contact: false,
      scan: false
    })
  })

  it('takes a page that does not say whether it is secure as secure', () => {
    const environment = full()

    delete environment.isSecureContext

    expect(detectDeviceSupport(environment)).toMatchObject({ location: true, contact: true, scan: true })
  })

  it('needs navigator.geolocation for the location', () => {
    const environment = full()

    environment.navigator = { ...environment.navigator, geolocation: undefined }

    expect(detectDeviceSupport(environment).location).toBe(false)
    expect(detectDeviceSupport(full()).location).toBe(true)
  })

  it('needs both navigator.contacts and ContactsManager for the contact picker', () => {
    const environment = full()

    environment.navigator = { ...environment.navigator, contacts: undefined }

    expect(detectDeviceSupport(without('ContactsManager')).contact).toBe(false)
    expect(detectDeviceSupport(environment).contact).toBe(false)
    expect(detectDeviceSupport(full()).contact).toBe(true)
  })

  it('needs the camera API and BarcodeDetector for the scanner', () => {
    const noCamera = full()

    noCamera.navigator = { ...noCamera.navigator, mediaDevices: {} }

    const noMedia = full()

    noMedia.navigator = { geolocation: {}, contacts: {} }

    expect(detectDeviceSupport(without('BarcodeDetector')).scan).toBe(false)
    expect(detectDeviceSupport(noCamera).scan).toBe(false)
    expect(detectDeviceSupport(noMedia).scan).toBe(false)
    expect(detectDeviceSupport(full()).scan).toBe(true)
  })

  it('needs pointer events, Path2D and the upload for the signature, and File and FormData for the file', () => {
    expect(detectDeviceSupport(without('PointerEvent')).signature).toBe(false)
    expect(detectDeviceSupport(without('Path2D')).signature).toBe(false)
    expect(detectDeviceSupport(without('File'))).toMatchObject({ file: false, signature: false })
    expect(detectDeviceSupport(without('FormData'))).toMatchObject({ file: false, signature: false })
  })
})

describe('canRecord', () => {
  it('is true where a microphone and MediaRecorder exist in a secure context', () => {
    expect(canRecord(full())).toBe(true)
  })

  it('is false in an insecure context, without MediaRecorder, and without getUserMedia', () => {
    const noMicrophone = full()

    noMicrophone.navigator = { ...noMicrophone.navigator, mediaDevices: {} }

    expect(canRecord({ ...full(), isSecureContext: false })).toBe(false)
    expect(canRecord(without('MediaRecorder'))).toBe(false)
    expect(canRecord(noMicrophone)).toBe(false)
    expect(canRecord({})).toBe(false)
  })
})

describe('isShowable', () => {
  it('asks the support the method needs, and nothing of a method that needs none', () => {
    const support = { file: false, signature: false, location: true, contact: false, scan: false }

    expect(isShowable('device.location', support)).toBe(true)
    expect(isShowable('device.scan', support)).toBe(false)
    expect(isShowable('input.file', support)).toBe(false)
    expect(isShowable('input.form', support)).toBe(true)
    expect(isShowable('review.draft', support)).toBe(true)
  })
})
