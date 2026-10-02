import { execFileSync } from 'node:child_process'

import type { ExpoConfig } from 'expo/config'

/**
 * Which build this is, decided here rather than typed by hand.
 *
 * Two facts, both read from git at config-evaluation time:
 *
 *  - `commit` is the short hash, so a screenshot of the About line names the
 *    exact tree it was taken from. A checkout with no git (a release tarball, a
 *    CI step that fetched without history) answers `dev`.
 *  - `buildNumber` is the commit COUNT, which is the only monotonic number a git
 *    history hands out for free. Apple wants a build number that never goes
 *    backwards within a version and Play wants an integer `versionCode` that
 *    never repeats, and both are satisfied by the same value — so there is one
 *    place to get it wrong instead of two.
 *
 * Neither may ever fail the build: an `execFileSync` that throws is caught and
 * answered with a default, because a missing `git` is not a reason for the app
 * not to compile.
 */
function git(args: string[], fallback: string): string {
  try {
    return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || fallback
  } catch {
    return fallback
  }
}

const COMMIT = git(['rev-parse', '--short', 'HEAD'], 'dev')
const BUILD_NUMBER = Number.parseInt(git(['rev-list', '--count', 'HEAD'], '1'), 10) || 1

const BUNDLE_ID = 'dev.hermie.app'
const IOS_DEPLOYMENT_TARGET = '15.1'

/**
 * The midpoint of the gradient in design/icon.svg. Android composites the
 * adaptive foreground over a flat colour, so this is what makes the launcher
 * icon look like the one on iOS instead of a bubble floating on a slab.
 */
const ICON_BACKGROUND = '#1772D3'

/** The app's own backgrounds, from design/tokens.md, so the splash hands over to
 * the first screen without a flash of a different colour. */
const SPLASH_BACKGROUND_LIGHT = '#F2F2F7'
const SPLASH_BACKGROUND_DARK = '#000000'

const config: ExpoConfig = {
  name: 'Hermie',
  slug: 'hermie',
  owner: 'fullstack-studio',
  version: '0.1.9',
  orientation: 'default',
  scheme: 'hermie',
  userInterfaceStyle: 'automatic',
  newArchEnabled: true,
  icon: './assets/icon.png',
  primaryColor: ICON_BACKGROUND,
  assetBundlePatterns: ['**/*'],
  // Hermie talks to one gateway the user names and to nothing else, so there is
  // no update server to check in with. `runtimeVersion` is here anyway: if
  // expo-updates is ever added, the policy has to be decided before the first
  // build goes out, not after.
  updates: {
    enabled: false
  },
  runtimeVersion: {
    policy: 'appVersion'
  },
  extra: {
    commit: COMMIT,
    buildNumber: BUILD_NUMBER,
    /*
     * The Expo project this app is registered under. Nothing is built or served through it; it is
     * what a device needs to obtain a push token, and where the push credentials live. The id is
     * public by design, the same as a bundle identifier.
     */
    eas: { projectId: 'c28a9aee-1a9c-4c0e-8730-70e17fe31329' }
  },
  ios: {
    bundleIdentifier: BUNDLE_ID,
    buildNumber: String(BUILD_NUMBER),
    supportsTablet: true,
    /*
     * Name the keychain access group instead of inheriting one.
     *
     * `expo-secure-store` sets `kSecAttrAccessGroup` only when a caller passes
     * `accessGroup`, and nothing here does, so every credential this app writes
     * lands in whatever the system decides the app's FIRST access group is. With
     * no `keychain-access-groups` entitlement that group is derived implicitly
     * from the signing identity — and `scripts/run-mac.mjs` re-signs the Mac
     * bundle from scratch on every build, under a seven-day automatic
     * provisioning profile that is minted again whenever it has lapsed.
     *
     * `$(AppIdentifierPrefix)dev.hermie.app` is the same string the implicit
     * default already resolves to, and it is FIRST on purpose: writes go to the
     * first entry and reads search every entry, so naming it changes
     * where nothing is written and leaves every existing item readable. What it
     * buys is that the group is now declared by this repository rather than
     * inferred from build metadata, and it is auditable in `codesign
     * -d --entitlements -`.
     *
     * This is prophylactic, not a proven fix: see the 2026-09-20 section of
     * docs/platform-notes.md for what was and was not established about the
     * sign-out that follows replacing the .app bundle.
     */
    entitlements: {
      'keychain-access-groups': [`$(AppIdentifierPrefix)${BUNDLE_ID}`]
    },
    infoPlist: {
      // Everything Hermie sends goes over the platform's own TLS or HTTP stack,
      // with no cryptography of its own. Saying so here is what keeps App Store
      // Connect from asking on every upload.
      ITSAppUsesNonExemptEncryption: false,
      /*
       * Hermie talks to ONE server: the gateway the user names during setup,
       * and the identity provider that gateway redirects the sign-in page to.
       * A self-hosted gateway on a tailnet is normally served in the clear,
       * because WireGuard has already encrypted the path — and its address is
       * only known at runtime, so `NSExceptionDomains` has nothing to name.
       *
       * This key is ALONE on purpose, and the template's `NSAllowsLocalNetworking`
       * is gone with it. Since iOS 10 the presence of `NSAllowsLocalNetworking`,
       * `NSAllowsArbitraryLoadsInWebContent` or `NSAllowsArbitraryLoadsForMedia`
       * makes the system IGNORE `NSAllowsArbitraryLoads` and use its default of
       * false — so the three-key version of this dictionary blocked exactly the
       * case it was written for, measured as NSURLErrorDomain -1022 against a
       * cleartext FQDN. Web content follows this key when the web key is
       * absent, which is what the sign-in view needs.
       *
       * docs/adr/0014-plain-http-on-private-networks.md has the measurements and
       * docs/release.md the App Review note this requires.
       */
      NSAppTransportSecurity: {
        NSAllowsArbitraryLoads: true
      },
      /*
       * The app lock. Without this string iOS refuses the Face ID request
       * outright — and Apple requires it of any app that touches the API,
       * whether or not the device has a face to scan.
       *
       * Generic on purpose. It says what the prompt is for and nothing about
       * what is behind it: an unlock reason is read out on a device somebody
       * else may be holding, and "unlock your chats with <gateway>" would be
       * the one sentence the lock exists to prevent.
       */
      NSFaceIDUsageDescription: 'Hermie uses Face ID to unlock the app.',
      /*
       * The two strings the microphone needs, written here as well as in the
       * plugin's options below.
       *
       * The plugin fills them in only when they are ABSENT, so these are the
       * ones that ship; they are repeated rather than left to the plugin
       * because its defaults are "Allow Hermie to use the microphone", which
       * says what the app wants and not why — and App Review reads these.
       *
       * Both of them say the words never leave the device, because on iOS that
       * is enforced rather than promised: the recognizer is asked for
       * `requiresOnDeviceRecognition` and refuses where there is no offline
       * model (see `platform/speech-recognition.ts`).
       */
      NSMicrophoneUsageDescription:
        'Hermie uses the microphone so you can dictate a message instead of typing it. Audio is transcribed on this device and never sent anywhere.',
      NSSpeechRecognitionUsageDescription:
        'Hermie uses on-device speech recognition to turn what you say into the text of a message. Nothing is sent to Apple or to any other service.'
    }
  },
  android: {
    package: BUNDLE_ID,
    versionCode: BUILD_NUMBER,
    /*
     * Firebase Cloud Messaging is how a push reaches an Android device. The file holds the
     * project's public client configuration: ids, and a key that only works from this package.
     * A fork that wants its own Firebase project replaces it.
     */
    googleServicesFile: './google-services.json',
    adaptiveIcon: {
      foregroundImage: './assets/adaptive-icon.png',
      backgroundColor: ICON_BACKGROUND
    },
    edgeToEdgeEnabled: true,
    /*
     * A chat client needs the network and the photo library, and the app lock
     * needs BiometricPrompt. That is the whole list. The two blocked below are
     * pulled in by dependencies rather than asked for: nothing in the app
     * vibrates, and nothing writes to shared storage — an attachment is read,
     * resized in memory and sent.
     *
     * `expo-local-authentication`'s own library manifest already declares the
     * two biometric permissions, so this adds nothing to the merged manifest.
     * It is here for the same reason the keychain access group above is: what
     * the app asks the operating system for should be readable in this
     * repository, not inferred from a dependency's manifest. `USE_FINGERPRINT`
     * is deprecated and superseded by `USE_BIOMETRIC`; it is kept because the
     * library declares it and a device on API 27 still needs it.
     */
    permissions: [
      'android.permission.INTERNET',
      'android.permission.USE_BIOMETRIC',
      'android.permission.USE_FINGERPRINT',
      // Dictation. Named here as well as being added by the speech-recognition
      // plugin, so this array stays the one place to read what the app asks for.
      'android.permission.RECORD_AUDIO'
    ],
    blockedPermissions: ['android.permission.VIBRATE', 'android.permission.WRITE_EXTERNAL_STORAGE']
  },
  /*
   * What the EXPORTER needs to know about the browser build; everything else
   * the document says lives in `public/index.html`, which Expo uses as the
   * template.
   *
   * `themeColor` is deliberately absent. Expo would write a single
   * `<meta name="theme-color">` from it, and the tab chrome has to follow the
   * scheme the visitor is in — so the template carries two, one per
   * `prefers-color-scheme`, and `platform/status-bar.web.tsx` keeps them true
   * once the app knows which theme is actually pinned.
   */
  web: {
    favicon: './assets/favicon.png',
    lang: 'en',
    description: 'A client for Hermes Agent: chat with the bots on the gateway you run.'
  },
  plugins: [
    'expo-secure-store',
    'expo-sqlite',
    'expo-dev-client',
    [
      // Without an explicit usage string iOS TERMINATES the app the moment the
      // photo-library permission is requested — no dialog, no crash report, the
      // app simply disappears. The camera and microphone are switched off
      // because the composer only ever picks an existing image.
      'expo-image-picker',
      {
        photosPermission: 'Hermie uses your photo library so you can attach an image to a message.',
        cameraPermission: false,
        // NOT `false`: `false` DELETES `NSMicrophoneUsageDescription` from the
        // plist, and this plugin runs after the app's own `infoPlist` above —
        // so it silently threw away the dictation sentence and shipped a
        // microphone-using binary with no purpose string, which App Store
        // Connect rejects after the upload without a word in `altool`
        // (2026-09-22, builds 408 and 409 never appeared). Same sentence as
        // above, so the two agree whichever plugin writes last.
        microphonePermission:
          'Hermie uses the microphone so you can dictate a message instead of typing it. Audio is transcribed on this device and never sent anywhere.'
      }
    ],
    [
      /*
       * Dictation. The plugin writes the two iOS usage strings when they are
       * missing, adds `RECORD_AUDIO` on Android, and — the part that is easy to
       * miss — declares a `<queries>` entry for the recognition service, without
       * which Android 11 and newer cannot SEE the recognizer at all and the
       * feature fails on a release build while working in development.
       *
       * The strings are passed explicitly so the ones in `ios.infoPlist` above
       * and the ones here cannot drift; the plugin prefers these.
       */
      'expo-speech-recognition',
      {
        microphonePermission:
          'Hermie uses the microphone so you can dictate a message instead of typing it. Audio is transcribed on this device and never sent anywhere.',
        speechRecognitionPermission:
          'Hermie uses on-device speech recognition to turn what you say into the text of a message. Nothing is sent to Apple or to any other service.'
      }
    ],
    [
      'expo-splash-screen',
      {
        image: './assets/splash-icon.png',
        imageWidth: 180,
        resizeMode: 'contain',
        backgroundColor: SPLASH_BACKGROUND_LIGHT,
        dark: { backgroundColor: SPLASH_BACKGROUND_DARK }
      }
    ],
    [
      'expo-build-properties',
      {
        ios: {
          deploymentTarget: IOS_DEPLOYMENT_TARGET
        },
        android: {
          // The counterpart of the ATS exception above. Cleartext is off by
          // default for a release build targeting API 28 or newer, which would
          // make a gateway on `http://<tailnet name>` unreachable on Android
          // while working in every debug build — the template's debug manifest
          // already sets this, so the gap only ever shows up after release.
          usesCleartextTraffic: true
        }
      }
    ],
    ['./plugins/with-ios-deployment-target-floor', { deploymentTarget: IOS_DEPLOYMENT_TARGET }],
    // The template signs release builds with the debug key, which Play refuses. This gives them the
    // owner's upload key when the four HERMIE_UPLOAD_* values are configured, and leaves the debug
    // signing in place when they are not, so a fork still builds. No secret enters the repository.
    './plugins/with-android-release-signing',
    // iOS 27 refuses to launch an app built against its SDK that has not adopted the UIKit scene
    // life cycle, and SDK 54's template has not. The plugin writes the manifest; the scene delegate
    // it names lives in modules/hermie-scene.
    './plugins/with-ios-scene-lifecycle',
    // The home-screen widgets. This one lives INSIDE its module rather than in ./plugins, because
    // unlike the three above it is not a patch to the app's own project: it adds a second target
    // whose entire source — Swift, Info.plist and entitlements — is in that module, and a plugin
    // half a directory away from the thing it installs is a plugin that goes stale. It also writes
    // the App Group onto the app's entitlements, which is why `ios.entitlements` above does not
    // name it: one plugin owns the group on both targets so the two cannot disagree.
    './modules/hermie-widgets/plugin/with-hermie-widgets',
    // Share to Hermie. Beside the widget plugin and for the same reason: it
    // installs a second target whose entire source is in its own module, and it
    // writes the SAME App Group onto the app's entitlements — additively, so
    // whichever of the two runs second is a no-op. It also patches Android's
    // MainActivity, which the widget plugin has no need to.
    './modules/hermie-share/plugin/with-hermie-share',
    // Shortcuts, Siri and Spotlight. Unlike the two above it adds no target: an
    // `AppShortcutsProvider` has to be in the APP's own sources, and App Intents
    // metadata is extracted from the target that compiles them. The plugin says
    // so at length; the App Group it writes into is already on the app, put
    // there by either of the two plugins above.
    './modules/hermie-intents/plugin/with-hermie-intents'
  ]
  // `extra.eas.projectId` used to be deliberately absent, and this comment used to
  // say so. It is set above now, because push needs a project to mint a token
  // against (ADR-0017), and it ties the repository to one EAS account — so a fork
  // should run `eas init` and REPLACE it rather than inherit ours. See
  // docs/release.md.
}

export default config
