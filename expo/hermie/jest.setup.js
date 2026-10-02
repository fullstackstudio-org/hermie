/**
 * Native modules a test renderer has no implementation for. Each of these is a
 * real dependency of a screen under test, so the alternative to a shared mock is
 * the same three blocks at the top of every suite.
 */

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
)

jest.mock('@react-native-community/netinfo', () => require('@react-native-community/netinfo/jest/netinfo-mock.js'))

jest.mock('expo-secure-store', () => {
  const store = new Map()

  return {
    AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 'AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY',
    getItemAsync: jest.fn(async key => (store.has(key) ? store.get(key) : null)),
    setItemAsync: jest.fn(async (key, value) => {
      store.set(key, value)
    }),
    deleteItemAsync: jest.fn(async key => {
      store.delete(key)
    })
  }
})

/**
 * `expo-local-authentication`, which the app lock's platform seam imports at
 * module scope — and `app/App.tsx` pulls that seam in through the gate, so a
 * suite that renders anything at all would reach for it.
 *
 * The stand-in answers "a device with Face ID enrolled, and the person in front
 * of it says yes". A suite that wants another answer mocks the SEAM
 * (`platform/biometrics`) rather than this module: the seam is the contract,
 * and the web build has no `expo-local-authentication` to mock at all.
 */
jest.mock('expo-local-authentication', () => ({
  SecurityLevel: { NONE: 0, SECRET: 1, BIOMETRIC_WEAK: 2, BIOMETRIC_STRONG: 3 },
  AuthenticationType: { FINGERPRINT: 1, FACIAL_RECOGNITION: 2, IRIS: 3 },
  hasHardwareAsync: jest.fn(async () => true),
  isEnrolledAsync: jest.fn(async () => true),
  getEnrolledLevelAsync: jest.fn(async () => 3),
  supportedAuthenticationTypesAsync: jest.fn(async () => [2]),
  authenticateAsync: jest.fn(async () => ({ success: true })),
  cancelAuthenticate: jest.fn(async () => undefined)
}))

/**
 * The glass stack. All three render native views, and two of them reach for a
 * native module the moment they are imported — `expo-glass-effect` throws
 * outright from `requireNativeModule`, which is exactly the case
 * `src/ui/glass/material.ts` catches in the app and which a test renderer would
 * otherwise hit on every import.
 *
 * The stand-ins keep the props, so a test can assert which material a surface
 * asked for. `isLiquidGlassAvailable` answers false, so the suite renders the
 * SOLID fallback — the one path that has to look right with no blur at all, and
 * the one whose colours are assertable.
 */
jest.mock('expo-glass-effect', () => {
  const React = require('react')

  return {
    GlassView: props => React.createElement('ExpoGlassView', props),
    GlassContainer: props => React.createElement('ExpoGlassContainer', props),
    isLiquidGlassAvailable: () => false,
    isGlassEffectAPIAvailable: () => false
  }
})

jest.mock('expo-blur', () => {
  const React = require('react')

  return { BlurView: props => React.createElement('ExpoBlurView', props) }
})

jest.mock('expo-linear-gradient', () => {
  const React = require('react')

  return { LinearGradient: props => React.createElement('ExpoLinearGradient', props) }
})

// react-native-webview reaches for its native module at import time, which is
// the one thing a test renderer cannot provide. The stand-in keeps the props so
// a test can assert on how the web view was configured.
jest.mock('react-native-webview', () => {
  const React = require('react')

  return {
    WebView: props => React.createElement('RNCWebView', props)
  }
})

/**
 * `expo-notifications`, which reaches for a native module the moment it is
 * imported — `src/features/push/platform.ts` calls `setNotificationHandler` at
 * module scope, so every screen that can show Settings would pull it in.
 *
 * The stand-in answers "nothing is permitted and nothing is registered", which
 * is the state a device the reader has never answered the dialog on is actually
 * in. A test that wants the other answer hands `PushSync` its own platform
 * object instead: the whole point of `PushPlatform` is that nothing above it has
 * to know this module exists.
 */
jest.mock('expo-notifications', () => ({
  AndroidImportance: { DEFAULT: 3, MAX: 5 },
  setNotificationHandler: jest.fn(),
  setNotificationCategoryAsync: jest.fn(async () => undefined),
  setNotificationChannelAsync: jest.fn(async () => undefined),
  getPermissionsAsync: jest.fn(async () => ({ status: 'undetermined', canAskAgain: true })),
  requestPermissionsAsync: jest.fn(async () => ({ status: 'undetermined', canAskAgain: true })),
  getExpoPushTokenAsync: jest.fn(async () => ({ data: '' })),
  addNotificationResponseReceivedListener: jest.fn(() => ({ remove: jest.fn() })),
  getLastNotificationResponseAsync: jest.fn(async () => null)
}))

/**
 * The two speech modules, which reach for a native module the moment they are
 * used — `expo-speech-recognition` builds its `NativeModule` subclass at module
 * scope, and `expo-speech` resolves its own on the first call.
 *
 * The stand-ins answer "this platform can speak and can listen", which is the
 * state a phone is in and therefore the one worth covering by default. A suite
 * that wants the other answer hands the reader or the dictation machine its own
 * engine: the whole point of `SpeechEngine` and `RecognitionEngine` is that
 * nothing above them has to know these modules exist.
 */
jest.mock('expo-speech', () => ({
  speak: jest.fn(),
  stop: jest.fn(async () => undefined),
  isSpeakingAsync: jest.fn(async () => false),
  getAvailableVoicesAsync: jest.fn(async () => [])
}))

jest.mock('expo-speech-recognition', () => ({
  ExpoSpeechRecognitionModule: {
    start: jest.fn(),
    stop: jest.fn(),
    abort: jest.fn(),
    isRecognitionAvailable: jest.fn(() => true),
    supportsOnDeviceRecognition: jest.fn(() => true),
    getPermissionsAsync: jest.fn(async () => ({ granted: false, canAskAgain: true, status: 'undetermined' })),
    requestPermissionsAsync: jest.fn(async () => ({ granted: true, canAskAgain: true, status: 'granted' })),
    getSupportedLocales: jest.fn(async () => ({ locales: [], installedLocales: [] })),
    addListener: jest.fn(() => ({ remove: jest.fn() }))
  }
}))
