const { withAppDelegate, withInfoPlist } = require('expo/config-plugins')

// iOS 27 traps at launch unless the bundle declares the UIKit scene life cycle:
// `_UIApplicationEvaluateRuntimeIssueForNoSceneLifecycleAdoption` fires while the first scene
// connects and kills the process with EXC_BREAKPOINT before any of our code runs. Expo SDK 54's
// template is an application-life-cycle app, and the SDK line has no opt-in — SDK 57.0.23 added
// `expo-build-properties`' `ios.enableSceneSupport` and SDK 58 adopts scenes in the template, so
// this plugin is what stands in until the SDK moves.
//
// It writes the manifest and nothing else. The scene delegate itself is Swift in the autolinked
// module `modules/hermie-scene`, referenced below by its Objective-C name, which is how Expo
// references its own `EXExpoAppSceneDelegate` — no source file has to be added to the generated
// Xcode project, so `expo prebuild --clean` has nothing to throw away.
//
// Drop this plugin when the app moves to an SDK that adopts the scene life cycle itself; delete the
// module with it. See docs/platform-notes.md and docs/adr/0001-expo-sdk-54-rn-081.md.
const SCENE_DELEGATE_CLASS = 'HermieSceneDelegate'

/** One window, one configuration. Hermie has no second scene to show — not even on a Mac. */
const SCENE_MANIFEST = {
  UIApplicationSupportsMultipleScenes: false,
  UISceneConfigurations: {
    UIWindowSceneSessionRoleApplication: [
      {
        UISceneConfigurationName: 'Default Configuration',
        UISceneDelegateClassName: SCENE_DELEGATE_CLASS
      }
    ]
  }
}

// What `HermieSceneDelegate` assumes about the generated AppDelegate. It does not patch it — it
// adopts the window the template creates — so the assumptions are unenforced by the compiler and
// this is the only thing standing between a template change and a black window or a lost deep link.
// A prebuild that fails here is the point; see scripts/sync-hermes-shared.mjs for the same idea.
const APP_DELEGATE_EXPECTATIONS = [
  {
    pattern: /var\s+window\s*:\s*UIWindow\?/,
    expected: 'var window: UIWindow?',
    needed: 'the scene delegate reads the window back through UIApplication.shared.delegate?.window'
  },
  {
    pattern: /window\s*=\s*UIWindow\(frame:\s*UIScreen\.main\.bounds\)/,
    expected: 'window = UIWindow(frame: UIScreen.main.bounds)',
    needed:
      'the window has to exist before the first scene connects, because expo-dev-launcher looks for it during didFinishLaunching'
  },
  {
    pattern: /startReactNative\(\s*withModuleName:[^)]*in:\s*window/,
    expected: 'factory.startReactNative(withModuleName: …, in: window, …)',
    needed: 'the React root has to be inside the window the scene delegate attaches'
  },
  {
    pattern: /RCTLinkingManager\.application\(\s*\w+,\s*open:/,
    expected: 'RCTLinkingManager.application(app, open: url, options: options)',
    needed: 'scene(_:openURLContexts:) is forwarded to this override, which is what reaches JavaScript'
  },
  {
    pattern: /RCTLinkingManager\.application\(\s*\w+,\s*continue:/,
    expected: 'RCTLinkingManager.application(application, continue: userActivity, restorationHandler:)',
    needed: 'scene(_:continue:) is forwarded to this override'
  }
]

/**
 * Adds the scene manifest to an Info.plist. Pure, and idempotent by assignment.
 *
 * Throws when something else already declared a manifest: two answers to "which class runs the
 * scene" is not a merge, and the losing one fails at launch rather than at build time.
 */
function applySceneManifest(infoPlist) {
  const existing = infoPlist.UIApplicationSceneManifest

  if (existing !== undefined && JSON.stringify(existing) !== JSON.stringify(SCENE_MANIFEST)) {
    throw new Error(
      'Info.plist already declares a UIApplicationSceneManifest that is not the one ' +
        'with-ios-scene-lifecycle writes. Reconcile the two by hand: ' +
        JSON.stringify(existing)
    )
  }

  return { ...infoPlist, UIApplicationSceneManifest: SCENE_MANIFEST }
}

/**
 * Fails the prebuild if the generated AppDelegate no longer has the shape the scene delegate adopts.
 *
 * `language` is what `withAppDelegate` reports; anything but Swift means the template moved further
 * than a line, and guessing at the rest would be worse than stopping.
 */
function assertAppDelegateShape(contents, language = 'swift') {
  if (language !== 'swift') {
    throw new Error(
      `with-ios-scene-lifecycle expects the Swift AppDelegate of the Expo SDK 54 template, not ${language}.`
    )
  }

  const missing = APP_DELEGATE_EXPECTATIONS.filter(expectation => !expectation.pattern.test(contents))
  if (missing.length === 0) {
    return
  }

  throw new Error(
    [
      'The generated ios/Hermie/AppDelegate.swift no longer matches what HermieSceneDelegate',
      '(expo/hermie/modules/hermie-scene) adopts, so the app would launch into a black window or',
      'silently stop receiving links. Missing:',
      ...missing.map(expectation => `  - ${expectation.expected}\n      needed because ${expectation.needed}`),
      '',
      'Read the new AppDelegate before changing either side. If the template now adopts the scene',
      'life cycle itself, delete this plugin and modules/hermie-scene instead of adjusting it.'
    ].join('\n')
  )
}

module.exports = function withIosSceneLifecycle(config) {
  const withManifest = withInfoPlist(config, modConfig => {
    modConfig.modResults = applySceneManifest(modConfig.modResults)
    return modConfig
  })

  return withAppDelegate(withManifest, modConfig => {
    assertAppDelegateShape(modConfig.modResults.contents, modConfig.modResults.language)
    return modConfig
  })
}

module.exports.applySceneManifest = applySceneManifest
module.exports.assertAppDelegateShape = assertAppDelegateShape
module.exports.SCENE_MANIFEST = SCENE_MANIFEST
