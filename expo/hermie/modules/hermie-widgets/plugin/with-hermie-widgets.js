const fs = require('node:fs')
const path = require('node:path')

const { withDangerousMod, withEntitlementsPlist, withXcodeProject } = require('expo/config-plugins')

/**
 * Adds the WidgetKit extension to the generated Xcode project, and puts the App Group on both
 * sides of it.
 *
 * ## Why this is written by hand
 *
 * `@bacons/apple-targets` does this job well and was considered. It was not taken for one reason
 * that matters on this SDK line: it depends on `@expo/prebuild-config` at a MAJOR version above the
 * one Expo SDK 54 installs, so adding it puts two copies of the prebuild pipeline in the tree — the
 * exact shape of the "plugin came from a different @expo/config-plugins" failure, in the one step
 * this repository cannot afford to have fail silently. Everything below is the subset of that
 * plugin's job this app needs, using the `xcode` project object `withXcodeProject` already hands
 * over.
 *
 * ## What it does, in order
 *
 * 1. Copies `../widget/` into `ios/HermieWidgets/`. The extension's Swift lives in the repository,
 *    not in the generated project, for the same reason the scene delegate does: `ios/` is
 *    disposable and `npx expo prebuild --clean` must be able to throw it away without losing work.
 * 2. Adds `com.apple.security.application-groups` to the APP's entitlements, and checks that the
 *    extension's own entitlements file names the same group. Two sandboxes that disagree about the
 *    group share nothing, and the failure mode is a widget that is permanently empty rather than
 *    anything that reports itself.
 * 3. Creates the extension target, its Sources phase, its group and its build settings, and lets
 *    `addTarget` wire the embed phase and the target dependency onto the app.
 *
 * ## Idempotence
 *
 * `expo prebuild` without `--clean` re-runs every mod against the project that is already there, so
 * step 3 is guarded on the target already existing while steps 1 and 2 are not: the sources and the
 * settings are re-applied every time, which is what makes editing a widget's Swift a prebuild away
 * rather than a `--clean` away.
 */

/**
 * The extension's target, product and directory name inside `ios/`.
 *
 * `HermieWidgetsExtension` and not `HermieWidgets`, and the extra word is load-bearing. The local
 * Expo module in `../ios/` is a CocoaPods pod named `HermieWidgets`, and a pod and a native target
 * with the same name both write `<name>.swiftmodule` into the SAME products directory. The
 * extension's is built for iOS 17 and the pod's for 15.1, so the app target then fails to compile
 * its own autolinking file with "compiling for iOS 15.1, but module 'HermieWidgets' has a minimum
 * deployment target of iOS 17.0" — an error that names neither the target nor the plugin that
 * created it. Two names, one products directory, no collision.
 */
const TARGET = 'HermieWidgetsExtension'

/**
 * The App Group, spelled here and in three other places that cannot check each other at compile
 * time: `ios/HermieWidgetsModule.swift`, `widget/HermieWidgetSnapshot.swift` and
 * `widget/HermieWidgetsExtension.entitlements`. This plugin is what ties the last of those to the first two,
 * by refusing to build when it says something else.
 */
const APP_GROUP = 'group.dev.hermie.app'

const ENTITLEMENTS_KEY = 'com.apple.security.application-groups'

/**
 * iOS 17, not the app's 15.1.
 *
 * `AppIntentConfiguration` — which is what lets the reader pick WHICH chat a small widget shows —
 * and `containerBackground(for:)`, which iOS 17 requires of every widget, both start here. An
 * extension may declare a higher minimum than the app that contains it: an iOS 15 or 16 device
 * installs the app and simply has no widgets to add, which is a better answer than an app that
 * refuses to install on a phone whose owner may never want one.
 */
const DEPLOYMENT_TARGET = '17.0'

/**
 * Add the App Group to whatever entitlements the app already has.
 *
 * Pure, and additive on purpose: `app.config.ts` puts `keychain-access-groups` in the same file for
 * reasons of its own (see the comment there about which access group a secret lands in), and this
 * must not be the change that quietly drops it. An existing groups array is extended rather than
 * replaced, so a fork that needs a second group keeps it.
 */
function applyAppGroup(entitlements) {
  const existing = Array.isArray(entitlements[ENTITLEMENTS_KEY]) ? entitlements[ENTITLEMENTS_KEY] : []

  return existing.includes(APP_GROUP) ? entitlements : { ...entitlements, [ENTITLEMENTS_KEY]: [...existing, APP_GROUP] }
}

/**
 * Fails the prebuild when the extension's entitlements name a different group from the app's.
 *
 * This is the one assertion in here that earns its place. Nothing at build time and nothing at
 * launch reports a mismatched App Group: the app writes its file into its own container, the widget
 * reads from a container that has nothing in it, and the result is a widget that is simply always
 * empty — which reads as "the snapshot is not being written" and sends the reader looking in the
 * wrong half of the system.
 */
function assertExtensionEntitlements(contents) {
  if (contents.includes(`<string>${APP_GROUP}</string>`)) {
    return
  }

  throw new Error(
    [
      `modules/hermie-widgets/widget/${TARGET}.entitlements does not name the App Group the app uses.`,
      '',
      `Expected: <string>${APP_GROUP}</string>`,
      '',
      'The app and the extension share a container only when both entitlements name the SAME group.',
      'A mismatch is invisible: nothing fails to build and nothing fails to launch, the widget is',
      'just permanently empty. Change both sides, or neither.'
    ].join('\n')
  )
}

/**
 * The build settings the target needs beyond the ones `addTarget` writes.
 *
 * Quoted the way the pbxproj wants them, because this object is assigned straight into a build
 * configuration's `buildSettings` and the `xcode` package does no quoting of its own.
 *
 * `DEVELOPMENT_TEAM` is deliberately NOT here. It is a secret in the sense that matters for a public
 * repository — it identifies an account — and every path that signs this project passes it on the
 * command line instead (`scripts/run-mac.mjs`, EAS, the release workflow), where it reaches every
 * target at once. A CI simulator build passes `CODE_SIGNING_ALLOWED=NO` and needs no team at all.
 */
function buildSettingsFor({ version, buildNumber }) {
  return {
    CODE_SIGN_ENTITLEMENTS: `"${TARGET}/${TARGET}.entitlements"`,
    CODE_SIGN_STYLE: 'Automatic',
    CURRENT_PROJECT_VERSION: `"${buildNumber}"`,
    // The app's own Info.plist is generated by Expo; this one is checked in, so the template's
    // "synthesise one from build settings" behaviour has to be switched off or it wins.
    GENERATE_INFOPLIST_FILE: 'NO',
    INFOPLIST_FILE: `"${TARGET}/Info.plist"`,
    IPHONEOS_DEPLOYMENT_TARGET: `"${DEPLOYMENT_TARGET}"`,
    MARKETING_VERSION: `"${version}"`,
    PRODUCT_NAME: `"${TARGET}"`,
    SKIP_INSTALL: 'YES',
    SWIFT_EMIT_LOC_STRINGS: 'YES',
    SWIFT_VERSION: '"5.9"',
    // iPhone and iPad, which is also what the Mac runs (ADR-0011): a "Designed for iPad" app's
    // widgets appear in Notification Center.
    TARGETED_DEVICE_FAMILY: '"1,2"'
  }
}

/**
 * Write `settings` onto the build configurations whose uuids are given.
 *
 * Addressed by uuid rather than by matching on `PRODUCT_NAME`, and that is the second version of
 * this function. The first matched `PRODUCT_NAME === '"HermieWidgetsExtension"'`, which worked on a
 * project this plugin had just written and then failed on the next `expo prebuild` without
 * `--clean`: `pod install` re-serialises the whole pbxproj through its own writer, and that writer
 * drops the quotes around a value that does not need them. So the settings landed nowhere, and the
 * assertion below — which exists for exactly this class of silence — is what said so.
 *
 * Pure, so the rule stays testable without an Xcode project.
 */
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

/**
 * The uuids of a target's build configurations, however the pbxproj was last written.
 *
 * Two indirections and both of them can be quoted or not: the target is found by a comment that
 * `xcode` writes as `"HermieWidgetsExtension"` and CocoaPods rewrites as `HermieWidgetsExtension`,
 * and each configuration is a `{ value, comment }` pair under the list the target names.
 */
function configurationUuidsFor(project) {
  const target = project.pbxTargetByName(TARGET) ?? project.pbxTargetByName(`"${TARGET}"`)
  const list = target && project.pbxXCConfigurationList()[target.buildConfigurationList]

  return (list?.buildConfigurations ?? []).map(entry => entry.value)
}

/**
 * Fails the prebuild when the app was not told to build the extension before embedding it.
 *
 * Both halves are `addTarget`'s doing rather than this plugin's, and both have failed silently
 * once already (see the note where the two sections are created). The symptom of the missing
 * dependency is the worst kind: the build succeeds on a tree where the .appex happens to be left
 * over from last time and fails on a clean one, so it reaches CI rather than the person who made
 * the change.
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
function widgetSources(sourceDirectory) {
  return fs
    .readdirSync(sourceDirectory)
    .filter(name => name.endsWith('.swift'))
    .sort()
}

/**
 * Copy `widget/` into `ios/HermieWidgets/`.
 *
 * Deleted first rather than merged over, so a Swift file removed from the repository is removed
 * from the build too — a stale `@main` left behind here is a duplicate entry point and a link
 * error whose cause is a file nobody can see in the diff.
 */
function copyWidgetSources(sourceDirectory, destination) {
  fs.rmSync(destination, { force: true, recursive: true })
  fs.mkdirSync(destination, { recursive: true })

  for (const name of fs.readdirSync(sourceDirectory)) {
    fs.copyFileSync(path.join(sourceDirectory, name), path.join(destination, name))
  }
}

module.exports = function withHermieWidgets(config) {
  const sourceDirectory = path.join(__dirname, '..', 'widget')

  assertExtensionEntitlements(fs.readFileSync(path.join(sourceDirectory, `${TARGET}.entitlements`), 'utf8'))

  const withSources = withDangerousMod(config, [
    'ios',
    modConfig => {
      copyWidgetSources(sourceDirectory, path.join(modConfig.modRequest.platformProjectRoot, TARGET))

      return modConfig
    }
  ])

  const withGroup = withEntitlementsPlist(withSources, modConfig => {
    modConfig.modResults = applyAppGroup(modConfig.modResults)

    return modConfig
  })

  return withXcodeProject(withGroup, modConfig => {
    const project = modConfig.modResults
    const sources = widgetSources(sourceDirectory)

    if (!project.pbxTargetByName(TARGET)) {
      // A one-target project has no PBXTargetDependency or PBXContainerItemProxy section at all,
      // and `xcode`'s `addTargetDependency` ends in `if (proxySection && dependencySection)` — so
      // with the sections absent it does nothing, returns a value that looks like success, and the
      // app ends up with a "Copy Files" phase that embeds an extension it was never told to build
      // first. That is a race rather than an error: it copies whatever .appex is in the products
      // directory, which on a clean tree is none. Creating the two empty sections here is what
      // makes the dependency `addTarget` asks for actually land, and the assertion below is what
      // will notice if that stops being true.
      project.hash.project.objects.PBXTargetDependency ??= {}
      project.hash.project.objects.PBXContainerItemProxy ??= {}

      // The group FIRST: `addPbxGroup` creates the file references and the build files, and
      // `addBuildPhase` then reuses them rather than creating a second set. The other order
      // produces a project that builds and shows every source twice in the navigator.
      const group = project.addPbxGroup(sources, TARGET, TARGET)
      project.addToPbxGroup(group.uuid, project.getFirstProject().firstProject.mainGroup)

      // `addTarget` also creates the app target's "Copy Files" phase for the .appex and the target
      // dependency that makes the app wait for it. Both are its own doing; neither is safe to leave
      // out, and neither has to be written here.
      const target = project.addTarget(TARGET, 'app_extension', TARGET, `${modConfig.ios?.bundleIdentifier}.widgets`)

      project.addBuildPhase(sources, 'PBXSourcesBuildPhase', 'Sources', target.uuid)
      // Empty, and both are needed: Xcode treats a native target with no Frameworks or Resources
      // phase as one it has to migrate, and says so on every open.
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
        `with-hermie-widgets found no build configuration for the ${TARGET} target, so its build ` +
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
module.exports.DEPLOYMENT_TARGET = DEPLOYMENT_TARGET
module.exports.TARGET = TARGET
module.exports.applyAppGroup = applyAppGroup
module.exports.applyTargetSettings = applyTargetSettings
module.exports.configurationUuidsFor = configurationUuidsFor
module.exports.assertExtensionEntitlements = assertExtensionEntitlements
module.exports.buildSettingsFor = buildSettingsFor
