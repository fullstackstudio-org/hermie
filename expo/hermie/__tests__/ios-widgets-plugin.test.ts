/**
 * The config plugin that adds the WidgetKit extension.
 *
 * Everything worth pinning here is something that fails SILENTLY when it goes
 * wrong, which is why a plugin this mechanical has a test at all:
 *
 *  - an App Group that only reached one of the two targets is a widget that is
 *    permanently empty and nothing that reports itself;
 *  - a build setting written onto no configuration means the extension builds
 *    with the template's defaults and ships under the wrong bundle identifier;
 *  - the App Group dropping `keychain-access-groups` would move where every
 *    credential the app writes ends up (see the note in app.config.ts).
 *
 * The Xcode surgery itself is not unit-tested and could not usefully be: what it
 * produces is a pbxproj, and the only real assertion about one is whether
 * xcodebuild accepts it. That is checked by building, and the plugin's own
 * `assertEmbedded` fails the prebuild for the one case where the `xcode`
 * package does nothing quietly — see docs/platform-notes.md.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const plugin = require('../modules/hermie-widgets/plugin/with-hermie-widgets')
const { APP_GROUP, applyAppGroup, applyTargetSettings, assertExtensionEntitlements, buildSettingsFor, TARGET } = plugin

const ENTITLEMENTS_PATH = join(__dirname, '..', 'modules', 'hermie-widgets', 'widget', `${TARGET}.entitlements`)
const MODULE_PATH = join(__dirname, '..', 'modules', 'hermie-widgets', 'ios', 'HermieWidgetsModule.swift')
const SNAPSHOT_SWIFT_PATH = join(__dirname, '..', 'modules', 'hermie-widgets', 'widget', 'HermieWidgetSnapshot.swift')

describe('the App Group', () => {
  it('is added to the app entitlements', () => {
    expect(applyAppGroup({})).toEqual({ 'com.apple.security.application-groups': [APP_GROUP] })
  })

  /**
   * app.config.ts puts `keychain-access-groups` in this same file, and the
   * comment there explains at length which access group a credential lands in.
   * A plugin that replaced the dictionary rather than extending it would move
   * that, silently, for every secret the app has already written.
   */
  it('leaves the keychain access group alone', () => {
    const existing = { 'keychain-access-groups': ['$(AppIdentifierPrefix)dev.hermie.app'] }

    expect(applyAppGroup(existing)).toEqual({
      ...existing,
      'com.apple.security.application-groups': [APP_GROUP]
    })
  })

  it('extends a groups array a fork already had rather than replacing it', () => {
    const existing = { 'com.apple.security.application-groups': ['group.example.other'] }

    expect(applyAppGroup(existing)['com.apple.security.application-groups']).toEqual(['group.example.other', APP_GROUP])
  })

  it('is idempotent, because a prebuild without --clean runs every mod again', () => {
    const once = applyAppGroup({})

    expect(applyAppGroup(once)).toEqual(once)
  })

  it('refuses an extension entitlements file that names a different group', () => {
    expect(() => assertExtensionEntitlements('<plist><dict></dict></plist>')).toThrow(/App Group/)
    expect(() => assertExtensionEntitlements(`<string>${APP_GROUP}</string>`)).not.toThrow()
  })
})

/**
 * Four files spell the App Group and no compiler checks that they agree. The
 * plugin asserts the entitlements at prebuild time; this asserts the two Swift
 * files, which nothing else can.
 */
describe('the App Group, in every place it is spelled', () => {
  it.each([
    ['the extension entitlements', ENTITLEMENTS_PATH],
    ['the app-side native module', MODULE_PATH],
    ["the extension's reader", SNAPSHOT_SWIFT_PATH]
  ])('is the same string in %s', (_label, path) => {
    expect(readFileSync(path, 'utf8')).toContain(APP_GROUP)
  })
})

describe('the extension build settings', () => {
  const settings = buildSettingsFor({ buildNumber: '42', version: '0.1.0' })

  it('points at the checked-in Info.plist rather than a synthesised one', () => {
    expect(settings.INFOPLIST_FILE).toBe(`"${TARGET}/Info.plist"`)
    // Without this the template synthesises an Info.plist from build settings
    // and wins over the file above.
    expect(settings.GENERATE_INFOPLIST_FILE).toBe('NO')
  })

  it('carries the app version and build number, which the store requires to match', () => {
    expect(settings.MARKETING_VERSION).toBe('"0.1.0"')
    expect(settings.CURRENT_PROJECT_VERSION).toBe('"42"')
  })

  /**
   * This is a public repository, and a team identifier names an account. Every
   * path that signs this project passes it on the command line instead, where
   * it reaches every target at once — `scripts/run-mac.mjs`, EAS, the release
   * workflow. A CI simulator build passes `CODE_SIGNING_ALLOWED=NO` and needs
   * none of it.
   */
  it('names no signing identity of its own', () => {
    expect(settings).not.toHaveProperty('DEVELOPMENT_TEAM')
    expect(settings).not.toHaveProperty('CODE_SIGN_IDENTITY')
    expect(settings).not.toHaveProperty('PROVISIONING_PROFILE_SPECIFIER')
    // Automatic, so `-allowProvisioningUpdates` can mint the profile that
    // carries the App Group capability.
    expect(settings.CODE_SIGN_STYLE).toBe('Automatic')
  })

  /**
   * By uuid, and never by matching on a build setting's VALUE. The first version
   * of this matched `PRODUCT_NAME === '"HermieWidgetsExtension"'` and worked
   * exactly once: `pod install` re-serialises the pbxproj through CocoaPods'
   * own writer, which drops the quotes around a value that does not need them,
   * and the next `expo prebuild` without `--clean` then wrote the settings
   * nowhere.
   */
  it('is written onto the configurations it is given and no others', () => {
    const configurations = {
      appDebug: { buildSettings: { PRODUCT_NAME: 'Hermie' } },
      widgetDebug: { buildSettings: { PRODUCT_NAME: TARGET } },
      widgetRelease: { buildSettings: { PRODUCT_NAME: TARGET } },
      widgetDebug_comment: 'Debug'
    }

    const touched = applyTargetSettings(configurations, ['widgetDebug', 'widgetRelease'], {
      SWIFT_VERSION: '"5.9"'
    })

    expect(touched).toBe(2)
    expect(configurations.appDebug.buildSettings).toEqual({ PRODUCT_NAME: 'Hermie' })
    expect(configurations.widgetRelease.buildSettings.SWIFT_VERSION).toBe('"5.9"')
  })

  it('counts nothing for a uuid that is a comment rather than a configuration', () => {
    expect(applyTargetSettings({ widgetDebug_comment: 'Debug' }, ['widgetDebug_comment'], {})).toBe(0)
  })
})

describe('the generated project, when one has been prebuilt here', () => {
  // `ios/` is generated and not committed, so CI has nothing to look at. When a
  // prebuild has run, check the two things a successful build does not prove:
  // that the extension's sources were copied, and that the app's entitlements
  // came out with both groups rather than one.
  const entitlements = join(__dirname, '..', 'ios', 'Hermie', 'Hermie.entitlements')
  const test = existsSync(entitlements) ? it : it.skip

  test('gave the app both the App Group and the keychain access group', () => {
    const contents = readFileSync(entitlements, 'utf8')

    expect(contents).toContain(APP_GROUP)
    expect(contents).toContain('keychain-access-groups')
  })

  test("copied the extension's sources out of the module", () => {
    expect(existsSync(join(__dirname, '..', 'ios', TARGET, 'HermieWidgetBundle.swift'))).toBe(true)
    expect(existsSync(join(__dirname, '..', 'ios', TARGET, `${TARGET}.entitlements`))).toBe(true)
  })
})
