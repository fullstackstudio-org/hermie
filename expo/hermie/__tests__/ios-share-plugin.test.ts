/**
 * The config plugin that adds the share extension, and the strings four files
 * have to agree on.
 *
 * Same reasoning as `ios-widgets-plugin.test.ts`: everything pinned here fails
 * SILENTLY when it goes wrong. An App Group that reached one binary and not the
 * other is a share sheet that writes into a container nothing reads; a build
 * setting written onto no configuration is an extension shipped under the wrong
 * identifier; a duplicated intent filter is Hermie appearing twice in Android's
 * chooser.
 *
 * The Xcode surgery is not unit-tested and could not usefully be — what it
 * produces is a pbxproj, and the only real assertion about one is whether
 * xcodebuild accepts it.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const plugin = require('../modules/hermie-share/plugin/with-hermie-share')
const {
  APP_GROUP,
  applyAppGroup,
  applyKeychainGroup,
  applySendFilters,
  applyTargetSettings,
  assertExtensionEntitlements,
  buildSettingsFor,
  KEYCHAIN_GROUP,
  SEND_ACTIONS,
  TARGET
} = plugin

const MODULE_DIR = join(__dirname, '..', 'modules', 'hermie-share')
const read = (...parts: string[]): string => readFileSync(join(MODULE_DIR, ...parts), 'utf8')

describe('the App Group', () => {
  it('is added to the app entitlements', () => {
    expect(applyAppGroup({})).toEqual({ 'com.apple.security.application-groups': [APP_GROUP] })
  })

  /**
   * Two plugins now write this key — the widgets' and this one — and both run
   * on every prebuild. Whichever goes second must be a no-op, and neither may
   * touch `keychain-access-groups`, which `app.config.ts` puts in the same file
   * and which decides where every credential the app writes ends up.
   */
  it('is idempotent and leaves everything else alone', () => {
    const existing = {
      'keychain-access-groups': ['$(AppIdentifierPrefix)dev.hermie.app'],
      'com.apple.security.application-groups': [APP_GROUP]
    }

    expect(applyAppGroup(existing)).toBe(existing)
    expect(applyAppGroup({ 'keychain-access-groups': ['x'] })).toEqual({
      'keychain-access-groups': ['x'],
      'com.apple.security.application-groups': [APP_GROUP]
    })
  })

  it('refuses an extension entitlements file that names a different group', () => {
    expect(() => assertExtensionEntitlements('<plist><dict></dict></plist>')).toThrow(/App Group/)
    expect(() =>
      assertExtensionEntitlements(`<string>${APP_GROUP}</string><string>${KEYCHAIN_GROUP}</string>`)
    ).not.toThrow()
  })
})

/**
 * The keychain group, which ADR-0026 made load-bearing.
 *
 * It is the one thing standing between "the share sheet sends" and "the share
 * sheet queues every time", and it fails as silently as the App Group does: the
 * extension's keychain lookup finds nothing, every share is written for the app
 * to deliver, and no log anywhere says why.
 */
describe('the keychain group', () => {
  it('is added to the app entitlements and is idempotent', () => {
    expect(applyKeychainGroup({})).toEqual({ 'keychain-access-groups': [KEYCHAIN_GROUP] })

    const existing = { 'keychain-access-groups': [KEYCHAIN_GROUP] }

    expect(applyKeychainGroup(existing)).toBe(existing)
  })

  /**
   * `expo-secure-store` writes with no access group, which lands the item in the
   * binary's FIRST declared one. So an entry appended here can never move where
   * the app's existing credentials live; one prepended would move all of them,
   * and the symptom would be a sign-out on the next launch with nothing to say
   * why.
   */
  it('appends rather than prepends, so the first group stays first', () => {
    expect(applyKeychainGroup({ 'keychain-access-groups': ['$(AppIdentifierPrefix)other'] })).toEqual({
      'keychain-access-groups': ['$(AppIdentifierPrefix)other', KEYCHAIN_GROUP]
    })
  })

  it('leaves the App Group key alone', () => {
    expect(applyKeychainGroup({ 'com.apple.security.application-groups': [APP_GROUP] })).toEqual({
      'com.apple.security.application-groups': [APP_GROUP],
      'keychain-access-groups': [KEYCHAIN_GROUP]
    })
  })

  it('is the same string app.config.ts puts on the app', () => {
    expect(read('..', '..', 'app.config.ts')).toContain('`$(AppIdentifierPrefix)${BUNDLE_ID}`')
    expect(KEYCHAIN_GROUP).toBe('$(AppIdentifierPrefix)dev.hermie.app')
  })

  it('is named in the extension entitlements', () => {
    expect(read('share', `${TARGET}.entitlements`)).toContain(`<string>${KEYCHAIN_GROUP}</string>`)
  })
})

/**
 * Four files spell the App Group and no compiler checks that they agree. The
 * plugin asserts the entitlements at prebuild time; this asserts the two Swift
 * files and the Kotlin store's directory name, which nothing else can.
 */
describe('the strings the three languages share', () => {
  it('names the same App Group in the entitlements, the module and the extension', () => {
    expect(read('share', `${TARGET}.entitlements`)).toContain(`<string>${APP_GROUP}</string>`)
    expect(read('ios', 'HermieShareModule.swift')).toContain(`"${APP_GROUP}"`)
    expect(read('share', 'HermieShareOutbox.swift')).toContain(`"${APP_GROUP}"`)
  })

  it('names the same outbox directory and manifest file everywhere', () => {
    for (const source of [
      read('ios', 'HermieShareModule.swift'),
      read('share', 'HermieShareOutbox.swift'),
      read('android', 'src', 'main', 'java', 'nl', 'fullstackstudio', 'hermie', 'share', 'HermieShareStore.kt')
    ]) {
      expect(source).toContain('share-outbox')
      expect(source).toContain('manifest.json')
    }
  })

  /**
   * `Info.plist` names the principal class as a plain string and the loader
   * looks it up in the Objective-C runtime. Without the `@objc` attribute a
   * Swift class is registered under a mangled name, the lookup finds nothing,
   * and the share sheet presents a blank panel with no error in any log.
   */
  it('exposes the principal class under the name Info.plist uses', () => {
    expect(read('share', 'Info.plist')).toContain('<string>ShareViewController</string>')
    expect(read('share', 'ShareViewController.swift')).toContain('@objc(ShareViewController)')
  })

  /**
   * The two names ADR-0026 added, and the three files that have to agree on them.
   *
   * `claim.json` is written by the extension and read by both native modules;
   * `share-targets.json` is written by the app's module and read by the extension.
   * A disagreement in either is silent in the same way everything else in this
   * file is: a claim nobody reads is a share that is sent twice, and a targets
   * file nobody reads is a share sheet that queues for ever.
   */
  it('names the same claim and targets files on both sides', () => {
    expect(read('share', 'HermieShareOutbox.swift')).toContain('claim.json')
    expect(read('ios', 'HermieShareModule.swift')).toContain('claim.json')
    expect(
      read('android', 'src', 'main', 'java', 'nl', 'fullstackstudio', 'hermie', 'share', 'HermieShareStore.kt')
    ).toContain('claim.json')

    expect(read('share', 'HermieShareTargets.swift')).toContain('share-targets.json')
    expect(read('ios', 'HermieShareModule.swift')).toContain('share-targets.json')
  })

  /**
   * The keychain account the app writes and the extension reads, plus the service
   * `expo-secure-store` stores it under. Both are spelled by hand on the Swift
   * side because there is no shared code, and a typo in either is a lookup that
   * finds nothing.
   */
  it('reads the keychain item the app writes', () => {
    const swift = read('share', 'HermieShareCredentials.swift')

    expect(swift).toContain('hermie.share.delivery')
    expect(swift).toContain('app:no-auth')
  })

  /** The item cap is applied by three writers and one reader; it has to be one number. */
  it('caps the items at the same number on every side', () => {
    expect(read('share', 'HermieShareOutbox.swift')).toContain('itemLimit = 12')
    expect(
      read('android', 'src', 'main', 'java', 'nl', 'fullstackstudio', 'hermie', 'share', 'HermieShareStore.kt')
    ).toContain('ITEM_LIMIT = 12')
    expect(read('share', 'Info.plist')).toContain('<integer>12</integer>')
  })
})

describe('the extension target settings', () => {
  const settings = buildSettingsFor({ version: '1.2.3', buildNumber: '77' })

  it('points at the checked-in Info.plist rather than a synthesised one', () => {
    // The activation rule — what Hermie offers to accept — lives in that file,
    // and the template would otherwise generate one without it.
    expect(settings.GENERATE_INFOPLIST_FILE).toBe('NO')
    expect(settings.INFOPLIST_FILE).toBe(`"${TARGET}/Info.plist"`)
  })

  it('carries the app’s version and build number', () => {
    expect(settings.MARKETING_VERSION).toBe('"1.2.3"')
    expect(settings.CURRENT_PROJECT_VERSION).toBe('"77"')
  })

  /** It identifies an account, so it is passed on the command line and never here. */
  it('never names a development team', () => {
    expect(JSON.stringify(settings)).not.toContain('DEVELOPMENT_TEAM')
  })

  it('writes onto every configuration it is given, and reports how many', () => {
    const configurations = {
      a: { buildSettings: {} },
      b: { buildSettings: { EXISTING: 'kept' } },
      c: { isa: 'something else' }
    }

    expect(applyTargetSettings(configurations, ['a', 'b', 'c', 'missing'], { X: '1' })).toBe(2)
    expect(configurations.b.buildSettings).toEqual({ EXISTING: 'kept', X: '1' })
  })
})

describe('the Android intent filter', () => {
  const launcher = {
    'intent-filter': [
      {
        action: [{ $: { 'android:name': 'android.intent.action.MAIN' } }],
        category: [{ $: { 'android:name': 'android.intent.category.LAUNCHER' } }]
      }
    ]
  }

  it('adds both send actions', () => {
    const filters = applySendFilters(launcher)['intent-filter']
    const actions = filters.flatMap((filter: { action?: { $: Record<string, string> }[] }) =>
      (filter.action ?? []).map(action => action.$['android:name'])
    )

    expect(actions).toEqual(['android.intent.action.MAIN', ...SEND_ACTIONS])
  })

  /**
   * MainActivity already carries the launcher filter and the `hermie://` scheme
   * Expo writes from `scheme` in app.config.ts. Replacing the array would take
   * the app off the home screen — a mistake a prebuild makes quietly and an
   * emulator reports as "the app is gone".
   */
  it('keeps the launcher filter it found', () => {
    expect(applySendFilters(launcher)['intent-filter'][0]).toBe(launcher['intent-filter'][0])
  })

  /** A prebuild without --clean runs every mod again; a duplicate is Hermie twice in the chooser. */
  it('is idempotent', () => {
    const once = applySendFilters(launcher)

    expect(applySendFilters(once)).toBe(once)
  })

  it('accepts an activity that had no filters at all', () => {
    expect(applySendFilters({})['intent-filter']).toHaveLength(SEND_ACTIONS.length)
  })
})
