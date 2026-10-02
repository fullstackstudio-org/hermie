/**
 * What the app asks a phone for, before a phone is ever asked.
 *
 * Three failures this exists for, and none of them shows up in a simulator run:
 *
 *  - **A missing iOS usage string does not produce a dialog and a refusal. It
 *    terminates the app** the moment the permission is requested — no alert, no
 *    crash report, the app simply disappears. `app.config.ts` already carries
 *    that warning about the photo library; the microphone and the speech
 *    recognizer are two more of the same.
 *  - **A missing `RECORD_AUDIO`** builds and installs, and fails the first time
 *    somebody holds the mic.
 *  - **The strings are declared in two places** — `ios.infoPlist` and the
 *    plugin's options — because the plugin only fills in what is absent. Two
 *    copies that disagree would ship whichever one the plugin happened to
 *    prefer, so this asserts they are the same string.
 */
import config from '../app.config'

type PluginEntry = string | [string, Record<string, unknown>?]

const plugin = (name: string): PluginEntry | undefined =>
  (config.plugins as PluginEntry[] | undefined)?.find(entry =>
    typeof entry === 'string' ? entry === name : entry[0] === name
  )

describe('the microphone', () => {
  it('names both iOS usage strings', () => {
    const info = config.ios?.infoPlist ?? {}

    expect(typeof info.NSMicrophoneUsageDescription).toBe('string')
    expect(typeof info.NSSpeechRecognitionUsageDescription).toBe('string')
  })

  it('says WHY rather than what, because App Review reads these', () => {
    const info = config.ios?.infoPlist ?? {}

    // The plugin's own defaults are "Allow Hermie to use the microphone", which
    // is the app's wish rather than the reader's reason. Both of ours name the
    // feature and say the audio does not leave the device.
    expect(String(info.NSMicrophoneUsageDescription)).toMatch(/dictate/iu)
    expect(String(info.NSMicrophoneUsageDescription)).toMatch(/never sent anywhere/iu)
    expect(String(info.NSSpeechRecognitionUsageDescription)).toMatch(/on-device/iu)
  })

  it('asks Android for RECORD_AUDIO in the one place that lists what we ask for', () => {
    expect(config.android?.permissions).toContain('android.permission.RECORD_AUDIO')
  })

  it('installs the speech-recognition plugin, without which a release build cannot see a recognizer', () => {
    // The plugin's `<queries>` entry is the part that is easy to miss: Android
    // 11 and newer hide the recognition service from an app that has not
    // declared it, so the feature works in development and fails after release.
    expect(plugin('expo-speech-recognition')).toBeDefined()
  })

  it('hands the plugin the same strings the Info.plist carries', () => {
    const entry = plugin('expo-speech-recognition')
    const options = (Array.isArray(entry) ? entry[1] : undefined) ?? {}
    const info = config.ios?.infoPlist ?? {}

    expect(options.microphonePermission).toBe(info.NSMicrophoneUsageDescription)
    expect(options.speechRecognitionPermission).toBe(info.NSSpeechRecognitionUsageDescription)
  })

  it('still blocks the two permissions nothing in the app uses', () => {
    // Adding one permission is the moment somebody widens the list by accident.
    expect(config.android?.blockedPermissions).toEqual([
      'android.permission.VIBRATE',
      'android.permission.WRITE_EXTERNAL_STORAGE'
    ])
  })
})

describe('the image picker plugin', () => {
  it('does not delete the microphone purpose string the dictation plugin needs', () => {
    // `microphonePermission: false` removes the key from the plist; a binary
    // that uses the microphone with no purpose string is rejected after upload.
    const plugin = (config.plugins ?? []).find(
      (entry): entry is [string, Record<string, unknown>] => Array.isArray(entry) && entry[0] === 'expo-image-picker'
    )

    expect(plugin).toBeDefined()
    expect(typeof plugin?.[1].microphonePermission).toBe('string')
    expect(plugin?.[1].microphonePermission).toBe(config.ios?.infoPlist?.NSMicrophoneUsageDescription)
  })
})
