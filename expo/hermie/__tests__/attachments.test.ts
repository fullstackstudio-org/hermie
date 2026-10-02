/**
 * Picking a photo for the composer.
 *
 * The rule under test is a permission that is NOT asked for. Both platforms
 * run the library picker out of process — PHPicker on iOS, the Android photo
 * picker on Android — and neither needs a grant for it. Asking anyway put a
 * full-library prompt in front of someone who wanted to attach one screenshot,
 * and a "Limited" answer came back as `granted: false`, which refused a picker
 * that would have worked.
 */
import { Image, Linking } from 'react-native'

import { imageDimensions, openAppSettings, pickAttachment } from '../src/features/chats/attachments'

const mockLaunch = jest.fn()
const mockRequestPermission = jest.fn()
const mockManipulate = jest.fn()

jest.mock('expo-image-picker', () => ({
  launchImageLibraryAsync: (...args: unknown[]) => mockLaunch(...args),
  requestMediaLibraryPermissionsAsync: (...args: unknown[]) => mockRequestPermission(...args)
}))

jest.mock('expo-image-manipulator', () => ({
  manipulateAsync: (...args: unknown[]) => mockManipulate(...args),
  SaveFormat: { JPEG: 'jpeg' }
}))

beforeEach(() => {
  jest.clearAllMocks()
  mockManipulate.mockResolvedValue({ base64: 'AAAA', uri: 'file:///tmp/out.jpg' })
})

describe('pickAttachment', () => {
  it('opens the picker without asking for the photo library first', async () => {
    mockLaunch.mockResolvedValue({
      canceled: false,
      assets: [{ uri: 'file:///tmp/shot.png', fileName: 'shot.png', width: 400, height: 300 }]
    })

    const picked = await pickAttachment()

    expect(mockRequestPermission).not.toHaveBeenCalled()
    expect(picked).toMatchObject({ base64: 'AAAA', filename: 'shot.jpg' })
  })

  it('treats a cancelled pick as nothing to attach, not as a failure', async () => {
    mockLaunch.mockResolvedValue({ canceled: true, assets: null })

    await expect(pickAttachment()).resolves.toBeNull()
  })

  it('turns a refused picker into the sentence that says what to do about it', async () => {
    mockLaunch.mockRejectedValue(new Error('User denied permissions'))

    await expect(pickAttachment()).rejects.toThrow(/photo library/u)
  })

  it('passes any other failure through as its own message', async () => {
    mockLaunch.mockRejectedValue(new Error('the picker exploded'))

    await expect(pickAttachment()).rejects.toThrow('the picker exploded')
  })

  it('offers the one action that can fix a refused picker', () => {
    const openSettings = jest.spyOn(Linking, 'openSettings').mockResolvedValue(undefined)

    try {
      openAppSettings()

      expect(openSettings).toHaveBeenCalled()
    } finally {
      openSettings.mockRestore()
    }
  })
})

describe('imageDimensions', () => {
  it('answers the pixel size Image.getSize reports', async () => {
    const getSize = jest.spyOn(Image, 'getSize').mockImplementation((_uri, success) => success(1600, 1200))

    try {
      await expect(imageDimensions('blob:pasted')).resolves.toEqual({ width: 1600, height: 1200 })
    } finally {
      getSize.mockRestore()
    }
  })

  it('answers an empty object rather than rejecting when the size cannot be read', async () => {
    const getSize = jest
      .spyOn(Image, 'getSize')
      .mockImplementation((_uri, _success, failure) => failure?.(new Error('decode failed')))

    try {
      await expect(imageDimensions('blob:broken')).resolves.toEqual({})
    } finally {
      getSize.mockRestore()
    }
  })
})
