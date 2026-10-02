const fs = require('node:fs')
const path = require('node:path')

const {
  AndroidConfig,
  withAndroidManifest,
  withDangerousMod,
  withEntitlementsPlist,
  withXcodeProject
} = require('expo/config-plugins')

/**
 * Adds the share extension to the generated Xcode project, puts the App Group and
 * the keychain group on both sides of it, and teaches Android's MainActivity to
 * answer `ACTION_SEND`.
 *
 * ## It is the widget plugin's twin, and deliberately so
 *
 * `modules/hermie-widgets/plugin/with-hermie-widgets.js` already solves "add a
 * second target to a generated project by hand", including the three things
 * that fail silently — the target dependency the `xcode` package creates
 * quietly or not at all, the build settings that land on no configuration
 * because CocoaPods re-quoted the pbxproj, and an App Group that reaches one
 * binary but not the other. Every one of those comments applies here word for
 * word and is not repeated; read that file first.
 *
 * What differs is worth stating, and it is four things:
 *
 *  1. **The extension point.** A share extension is `com.apple.share-services`
 *     and its activation rule is in its own checked-in `Info.plist`. Nothing
 *     here writes that, because what a build accepts from a share sheet is a
 *     product decision rather than a build one.
 *  2. **The bundle identifier is `<app>.share`**, which is what the App Store's
 *     provisioning expects of an extension and what
 *     `docs/platform-notes.md` names for the person adding it in the portal.
 *  3. **It writes a KEYCHAIN group as well as an App Group.** ADR-0026 lets the
 *     extension deliver a share itself, which needs a credential, which may not
 *     live in a plain directory — so the app's keychain group goes onto both
 *     binaries and the pairing is asserted the same way the App Group's is.
 *  4. **There is an ANDROID half.** The widget's Android side needs no patch to
 *     the app's project at all — a library manifest merges its receivers in —
 *     but an intent filter has to go on the app's OWN MainActivity, which is
 *     generated. So it is written here, additively, and checked for duplicates
 *     because a prebuild without `--clean` runs every mod again.
 *
 * ## Idempotence
 *
 * Same rule as the widget plugin: the sources and the build settings are
 * re-applied every time, so editing the extension's Swift is a prebuild away
 * rather than a `--clean` away, while the target creation and the intent filter
 * are guarded on already existing.
 */

/**
 * The extension's target, product and directory name inside `ios/`.
 *
 * `HermieShareExtension` and not `HermieShare`, for exactly the reason the
 * widget plugin spells out at length: the local Expo module in `../ios/` is a
 * CocoaPods pod named `HermieShare`, and a pod and a native target with the
 * same name both write `<name>.swiftmodule` into the same products directory.
 * Two names, one products directory, no collision.
 */
const TARGET = 'HermieShareExtension'

/**
 * The App Group, spelled here and in three other places that cannot check each
 * other at compile time: `ios/HermieShareModule.swift`,
 * `share/HermieShareOutbox.swift` and `share/HermieShareExtension.entitlements`.
 * It is also the same group `hermie-widgets` uses — one container, three
 * binaries — which is why both plugins assert it rather than one owning it.
 */
const APP_GROUP = 'group.dev.hermie.app'

/**
 * The keychain group the app's delivery credential is written into, spelled here
 * and in `ios.entitlements` in app.config.ts and in the extension's own
 * entitlements.
 *
 * ADR-0026 needed one thing the App Group could not give it: somewhere to put a
 * bearer token that is not a plain directory. `$(AppIdentifierPrefix)dev.hermie.app`
 * is the app's FIRST keychain group, which is where `expo-secure-store` writes
 * when no access group is passed — and a keychain READ searches every group the
 * reading binary declares, so the extension declaring this one is the whole of
 * what makes the item reachable. Nothing has to change on the write side.
 *
 * `$(AppIdentifierPrefix)` is expanded by the build from the signing team, so the
 * same string is correct in every fork and no team identifier enters this
 * repository.
 */
const KEYCHAIN_GROUP = '$(AppIdentifierPrefix)dev.hermie.app'

const ENTITLEMENTS_KEY = 'com.apple.security.application-groups'

const KEYCHAIN_KEY = 'keychain-access-groups'

/**
 * The app's own floor, not the widget's 17.0.
 *
 * Nothing in this extension needs anything newer: it is a `List`, a `TextField`
 * and a button. A share extension that refused to install on an iOS 15 phone
 * would take the app down with it, since an extension's minimum cannot be lower
 * than its container's but a container's cannot be raised by one.
 */
const DEPLOYMENT_TARGET = '15.1'

/** The two actions Android's chooser sends: one attachment, or several. */
const SEND_ACTIONS = ['android.intent.action.SEND', 'android.intent.action.SEND_MULTIPLE']

/** The MIME pattern the filters match: every type the chooser can offer. */
const SEND_MIME_TYPE = '*/*'

/**
 * Add the App Group to whatever entitlements the app already has.
 *
 * Pure, and additive on purpose — the same function the widget plugin carries,
 * duplicated rather than imported because a plugin reaching into a sibling
 * module's internals is a dependency neither package declares. Both are
 * idempotent and both extend an existing array, so whichever runs second is a
 * no-op.
 */
function applyAppGroup(entitlements) {
  const existing = Array.isArray(entitlements[ENTITLEMENTS_KEY]) ? entitlements[ENTITLEMENTS_KEY] : []

  return existing.includes(APP_GROUP) ? entitlements : { ...entitlements, [ENTITLEMENTS_KEY]: [...existing, APP_GROUP] }
}

/**
 * The same, for the keychain group — and with one rule the App Group does not
 * have: it is appended, never prepended.
 *
 * `expo-secure-store` writes without an access group, and a keychain write with
 * no group lands in the binary's FIRST declared one. So the order of this array
 * decides where every credential this app has ever stored goes. app.config.ts
 * already names `$(AppIdentifierPrefix)dev.hermie.app` first and explains at
 * length why; this function exists to make that a thing the share extension's
 * plugin asserts rather than assumes, and appending is what keeps it from
 * silently moving somebody's stored sign-in to a new group on the next prebuild.
 */
function applyKeychainGroup(entitlements) {
  const existing = Array.isArray(entitlements[KEYCHAIN_KEY]) ? entitlements[KEYCHAIN_KEY] : []

  return existing.includes(KEYCHAIN_GROUP)
    ? entitlements
    : { ...entitlements, [KEYCHAIN_KEY]: [...existing, KEYCHAIN_GROUP] }
}

/**
 * Fails the prebuild when the extension's entitlements name a different group
 * from the app's.
 *
 * The one assertion in here that earns its place, for the reason the widget
 * plugin gives: nothing at build time and nothing at launch reports a mismatched
 * App Group. The share extension writes its entry into a container of its own,
 * the app reads a container with nothing in it, and "Share to Hermie" silently
 * does nothing at all — which reads as the extension not running.
 */
function assertExtensionEntitlements(contents) {
  const missing = [APP_GROUP, KEYCHAIN_GROUP].filter(group => !contents.includes(`<string>${group}</string>`))

  if (missing.length === 0) {
    return
  }

  throw new Error(
    [
      `modules/hermie-share/share/${TARGET}.entitlements does not name every group the app uses.`,
      '',
      ...missing.map(group => `Expected: <string>${group}</string>`),
      '',
      'The app and the share extension share a container only when both entitlements name the SAME',
      'App Group, and the extension can read the delivery credential only when it declares the SAME',
      'keychain group. Both failures are invisible: nothing fails to build and nothing fails to',
      'launch. A wrong App Group means sharing never delivers anything at all; a wrong keychain group',
      'means every share is queued for the next launch of the app, which is what ADR-0026 exists to',
      'stop. Change both sides, or neither.'
    ].join('\n')
  )
}

/**
 * The build settings the target needs beyond the ones `addTarget` writes.
 *
 * Quoted the way the pbxproj wants them, because this object is assigned
 * straight into a build configuration's `buildSettings` and the `xcode` package
 * does no quoting of its own. `DEVELOPMENT_TEAM` is deliberately absent, for the
 * reason the widget plugin states: it identifies an account, and every path that
 * signs this project passes it on the command line instead.
 */
function buildSettingsFor({ version, buildNumber }) {
  return {
    CODE_SIGN_ENTITLEMENTS: `"${TARGET}/${TARGET}.entitlements"`,
    CODE_SIGN_STYLE: 'Automatic',
    CURRENT_PROJECT_VERSION: `"${buildNumber}"`,
    // The app's own Info.plist is generated by Expo; this one is checked in, so
    // the template's "synthesise one from build settings" behaviour has to be
    // switched off or it wins — and what it would win is the activation rule,
    // which is the whole of what this extension declares.
    GENERATE_INFOPLIST_FILE: 'NO',
    INFOPLIST_FILE: `"${TARGET}/Info.plist"`,
    IPHONEOS_DEPLOYMENT_TARGET: `"${DEPLOYMENT_TARGET}"`,
    MARKETING_VERSION: `"${version}"`,
    PRODUCT_NAME: `"${TARGET}"`,
    SKIP_INSTALL: 'YES',
    SWIFT_EMIT_LOC_STRINGS: 'YES',
    SWIFT_VERSION: '"5.9"',
    // iPhone and iPad, which is also what the Mac runs (ADR-0011): a "Designed
    // for iPad" app's share extension appears in the Mac's own share menu.
    TARGETED_DEVICE_FAMILY: '"1,2"'
  }
}

/** Write `settings` onto the build configurations whose uuids are given. */
function applyTargetSettings(configurations, uuids, settings) {
  let touched = 0

  for (const uuid of uuids) {
    const entry = configurations[uuid]

    if (typeof entry !== 'object' || entry === null || !entry.buildSettings) {
      continue
    }

    Object.assign(entry.buildSettings, settings)
    touched += 1
  }

  return touched
}

/** The uuids of a target's build configurations, however the pbxproj was last written. */
function configurationUuidsFor(project) {
  const target = project.pbxTargetByName(TARGET) ?? project.pbxTargetByName(`"${TARGET}"`)
  const list = target && project.pbxXCConfigurationList()[target.buildConfigurationList]

  return (list?.buildConfigurations ?? []).map(entry => entry.value)
}

/**
 * Fails the prebuild when the app was not told to build the extension before
 * embedding it. See the widget plugin for what `xcode`'s `addTargetDependency`
 * does quietly.
 */
function assertEmbedded(project, targetUuid) {
  const appTarget = project.getFirstTarget()
  const dependencies = appTarget?.firstTarget?.dependencies ?? []
  const proxies = project.hash.project.objects.PBXContainerItemProxy ?? {}

  const linked = dependencies.some(dependency => {
    const record = project.hash.project.objects.PBXTargetDependency?.[dependency.value]

    return record?.target === targetUuid || proxies[record?.targetProxy]?.remoteGlobalIDString === targetUuid
  })

  if (!linked) {
    throw new Error(
      `The ${TARGET} target was created but the app does not depend on it, so xcodebuild would ` +
        'embed whichever .appex happened to be in the products directory — none, on a clean tree. ' +
        "This is `xcode`'s addTarget/addTargetDependency doing nothing quietly; read " +
        'node_modules/xcode/lib/pbxProject.js before changing the plugin.'
    )
  }
}

/** Every Swift file the extension compiles, by basename, sorted so the project file is stable. */
function extensionSources(sourceDirectory) {
  return fs
    .readdirSync(sourceDirectory)
    .filter(name => name.endsWith('.swift'))
    .sort()
}

/**
 * Copy `share/` into `ios/HermieShareExtension/`.
 *
 * Deleted first rather than merged over, so a Swift file removed from the
 * repository is removed from the build too — a stale principal class left
 * behind here is a class the loader can still find, which is worse than a
 * missing one.
 */
function copyExtensionSources(sourceDirectory, destination) {
  fs.rmSync(destination, { force: true, recursive: true })
  fs.mkdirSync(destination, { recursive: true })

  for (const name of fs.readdirSync(sourceDirectory)) {
    fs.copyFileSync(path.join(sourceDirectory, name), path.join(destination, name))
  }
}

/**
 * Add the two `ACTION_SEND` filters to whatever MainActivity already declares.
 *
 * Pure, so the rule is testable without an Android project. Three things about
 * the shape are deliberate:
 *
 *  - **Additive.** MainActivity already carries the launcher filter and the
 *    `hermie://` scheme Expo writes from `scheme` in app.config.ts. Replacing
 *    the array would take the app off the home screen, which is the kind of
 *    mistake a prebuild makes quietly and an emulator reports as "the app is
 *    gone".
 *  - **Guarded on the ACTION.** A prebuild without `--clean` runs every mod
 *    again over a manifest that already has these, and a duplicate intent
 *    filter makes Hermie appear twice in the system chooser.
 *  - **Every MIME type rather than a list.** The iOS side declares what it will
 *    accept in its activation rule; Android's chooser has no equivalent
 *    granularity worth using here, and a filter naming only images and plain
 *    text would silently refuse the PDF somebody is trying to send.
 */
function applySendFilters(mainActivity) {
  const existing = Array.isArray(mainActivity['intent-filter']) ? mainActivity['intent-filter'] : []
  const declared = new Set(
    existing.flatMap(filter => (filter.action ?? []).map(action => action.$?.['android:name'])).filter(Boolean)
  )

  const added = SEND_ACTIONS.filter(action => !declared.has(action)).map(action => ({
    action: [{ $: { 'android:name': action } }],
    category: [{ $: { 'android:name': 'android.intent.category.DEFAULT' } }],
    data: [{ $: { 'android:mimeType': SEND_MIME_TYPE } }]
  }))

  return added.length === 0 ? mainActivity : { ...mainActivity, 'intent-filter': [...existing, ...added] }
}

function withShareIntentFilter(config) {
  return withAndroidManifest(config, modConfig => {
    const mainActivity = AndroidConfig.Manifest.getMainActivityOrThrow(modConfig.modResults)

    Object.assign(mainActivity, applySendFilters(mainActivity))

    return modConfig
  })
}

module.exports = function withHermieShare(config) {
  const sourceDirectory = path.join(__dirname, '..', 'share')

  assertExtensionEntitlements(fs.readFileSync(path.join(sourceDirectory, `${TARGET}.entitlements`), 'utf8'))

  const withAndroid = withShareIntentFilter(config)

  const withSources = withDangerousMod(withAndroid, [
    'ios',
    modConfig => {
      copyExtensionSources(sourceDirectory, path.join(modConfig.modRequest.platformProjectRoot, TARGET))

      return modConfig
    }
  ])

  const withGroup = withEntitlementsPlist(withSources, modConfig => {
    modConfig.modResults = applyKeychainGroup(applyAppGroup(modConfig.modResults))

    return modConfig
  })

  return withXcodeProject(withGroup, modConfig => {
    const project = modConfig.modResults
    const sources = extensionSources(sourceDirectory)

    if (!project.pbxTargetByName(TARGET)) {
      // See the widget plugin: with these two sections absent, `addTargetDependency`
      // ends in `if (proxySection && dependencySection)`, does nothing, and returns
      // a value that looks like success.
      project.hash.project.objects.PBXTargetDependency ??= {}
      project.hash.project.objects.PBXContainerItemProxy ??= {}

      // The group FIRST: `addPbxGroup` creates the file references and the build
      // files, and `addBuildPhase` then reuses them rather than creating a second
      // set. The other order produces a project that builds and shows every
      // source twice in the navigator.
      const group = project.addPbxGroup(sources, TARGET, TARGET)
      project.addToPbxGroup(group.uuid, project.getFirstProject().firstProject.mainGroup)

      const target = project.addTarget(TARGET, 'app_extension', TARGET, `${modConfig.ios?.bundleIdentifier}.share`)

      project.addBuildPhase(sources, 'PBXSourcesBuildPhase', 'Sources', target.uuid)
      // Empty, and both are needed: Xcode treats a native target with no
      // Frameworks or Resources phase as one it has to migrate, and says so on
      // every open.
      project.addBuildPhase([], 'PBXFrameworksBuildPhase', 'Frameworks', target.uuid)
      project.addBuildPhase([], 'PBXResourcesBuildPhase', 'Resources', target.uuid)

      assertEmbedded(project, target.uuid)
    }

    const touched = applyTargetSettings(
      project.pbxXCBuildConfigurationSection(),
      configurationUuidsFor(project),
      buildSettingsFor({
        buildNumber: modConfig.ios?.buildNumber ?? '1',
        version: modConfig.version ?? '0.0.0'
      })
    )

    if (touched === 0) {
      throw new Error(
        `with-hermie-share found no build configuration for the ${TARGET} target, so its build ` +
          'settings were written nowhere. The extension would then build with the template defaults ' +
          'and ship under the wrong bundle identifier rather than failing — which is why this stops ' +
          'the prebuild instead. Look at how the target and its XCConfigurationList are spelled in ' +
          'ios/Hermie.xcodeproj/project.pbxproj; `pod install` re-writes that file with its own ' +
          'quoting rules and has changed them before.'
      )
    }

    return modConfig
  })
}

module.exports.APP_GROUP = APP_GROUP
module.exports.KEYCHAIN_GROUP = KEYCHAIN_GROUP
module.exports.DEPLOYMENT_TARGET = DEPLOYMENT_TARGET
module.exports.TARGET = TARGET
module.exports.SEND_ACTIONS = SEND_ACTIONS
module.exports.SEND_MIME_TYPE = SEND_MIME_TYPE
module.exports.applyAppGroup = applyAppGroup
module.exports.applyKeychainGroup = applyKeychainGroup
module.exports.applySendFilters = applySendFilters
module.exports.applyTargetSettings = applyTargetSettings
module.exports.configurationUuidsFor = configurationUuidsFor
module.exports.assertExtensionEntitlements = assertExtensionEntitlements
module.exports.buildSettingsFor = buildSettingsFor
