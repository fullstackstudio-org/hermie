import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const plugin = require('../plugins/with-ios-scene-lifecycle')
const { applySceneManifest, assertAppDelegateShape, SCENE_MANIFEST } = plugin

const FIXTURE_PATH = join(__dirname, 'support', 'generated-app-delegate.swift')
const GENERATED_PATH = join(__dirname, '..', 'ios', 'Hermie', 'AppDelegate.swift')

const fixture = readFileSync(FIXTURE_PATH, 'utf8')

describe('the scene manifest', () => {
  it('names the module-provided scene delegate, with one scene', () => {
    const plist = applySceneManifest({ CFBundleName: 'Hermie' })

    expect(plist.CFBundleName).toBe('Hermie')
    expect(plist.UIApplicationSceneManifest).toEqual({
      UIApplicationSupportsMultipleScenes: false,
      UISceneConfigurations: {
        UIWindowSceneSessionRoleApplication: [
          {
            UISceneConfigurationName: 'Default Configuration',
            // Not `$(PRODUCT_MODULE_NAME).HermieSceneDelegate`: the class ships from the autolinked
            // pod rather than from the app target, so UIKit resolves the bare Objective-C name.
            UISceneDelegateClassName: 'HermieSceneDelegate'
          }
        ]
      }
    })
  })

  it('does not change on a second pass', () => {
    const once = applySceneManifest({})

    expect(applySceneManifest(once)).toEqual(once)
  })

  it('leaves the caller’s plist alone', () => {
    const input = { CFBundleName: 'Hermie' }
    applySceneManifest(input)

    expect(input).not.toHaveProperty('UIApplicationSceneManifest')
  })

  it('refuses to merge with someone else’s manifest', () => {
    const foreign = {
      UIApplicationSceneManifest: {
        UIApplicationSupportsMultipleScenes: true
      }
    }

    expect(() => applySceneManifest(foreign)).toThrow(/already declares a UIApplicationSceneManifest/)
  })
})

describe('the AppDelegate shape the scene delegate adopts', () => {
  it('accepts the generated SDK 54 AppDelegate', () => {
    expect(() => assertAppDelegateShape(fixture)).not.toThrow()
  })

  it('rejects an AppDelegate that is not Swift', () => {
    expect(() => assertAppDelegateShape(fixture, 'objc')).toThrow(/expects the Swift AppDelegate/)
  })

  // Each of these is a line HermieSceneDelegate depends on without the compiler being able to say
  // so. Losing one silently would mean a black window or a deep link that goes nowhere, so the
  // prebuild has to stop instead.
  const loadBearing = [
    ['the window property', 'var window: UIWindow?', 'var somethingElse: UIWindow?'],
    [
      'window creation in didFinishLaunching',
      'window = UIWindow(frame: UIScreen.main.bounds)',
      'window = UIWindow(windowScene: windowScene)'
    ],
    ['the React root going into that window', 'in: window,', 'in: otherWindow,'],
    ['the open-URL forwarding target', 'RCTLinkingManager.application(app, open: url', 'noLinkingManagerHere('],
    [
      'the continue-user-activity forwarding target',
      'RCTLinkingManager.application(application, continue: userActivity',
      'noLinkingManagerHere('
    ]
  ] as const

  for (const [what, present, replacement] of loadBearing) {
    it(`fails loudly when ${what} is gone`, () => {
      expect(fixture).toContain(present)
      const changed = fixture.replace(present, replacement)

      expect(() => assertAppDelegateShape(changed)).toThrow(/no longer matches what HermieSceneDelegate/)
    })
  }

  it('lists every missing line at once', () => {
    expect(() => assertAppDelegateShape('class AppDelegate {}')).toThrow(
      /UIScreen\.main\.bounds[\s\S]*RCTLinkingManager/
    )
  })
})

describe('the fixture', () => {
  // The fixture is what CI has to reason about, because `ios/` is generated and not committed. When
  // a prebuild has run here, hold the two against each other so a template change is caught by a
  // failing test rather than by a crash on a device.
  const generated = existsSync(GENERATED_PATH) ? readFileSync(GENERATED_PATH, 'utf8') : undefined
  const test = generated === undefined ? it.skip : it

  test('is the AppDelegate this prebuild generated', () => {
    expect(generated).toBe(fixture)
  })
})

describe('the plugin itself', () => {
  it('exports the manifest it writes, so the test and the plugin cannot disagree', () => {
    expect(applySceneManifest({}).UIApplicationSceneManifest).toBe(SCENE_MANIFEST)
  })
})
