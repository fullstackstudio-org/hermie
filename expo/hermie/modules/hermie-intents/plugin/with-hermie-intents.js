const fs = require('node:fs')
const path = require('node:path')

const { withDangerousMod, withXcodeProject } = require('expo/config-plugins')

/**
 * Puts the App Intents into the APP's own target.
 *
 * ## This is the one that is different, and the difference is the whole file
 *
 * `hermie-widgets` and `hermie-share` each add a second TARGET and copy their
 * Swift into it. This adds no target at all: it copies four Swift files into the
 * app's own group and sources build phase, alongside the generated AppDelegate.
 *
 * That is not a shortcut. Two facts force it:
 *
 *  1. **`AppShortcutsProvider` has to be in the app's target.** It is what puts
 *     an action in the Shortcuts gallery and in Siri's vocabulary without
 *     anybody assembling a Shortcut first, and Apple's documentation places it
 *     in the app. In an extension it is simply never found.
 *  2. **App Intents metadata is extracted per target, from that target's own
 *     Swift sources.** Xcode runs `appintentsmetadataprocessor` over the target
 *     it is building. Intents compiled into a static library — which is what an
 *     autolinked Expo module is — are a known source of "the action does not
 *     appear and nothing says why", and the version of that story changes with
 *     every Xcode release. Putting the sources in the app target takes the
 *     question off the table instead of betting on a build setting.
 *
 * `ios/HermieIntentsModule.swift` still travels the ordinary way, as an
 * autolinked pod, because it IS an ordinary Expo module: JavaScript calls it.
 * The podspec's `source_files` therefore stops at its own directory, or the
 * same file would be compiled into the pod AND the app and the link would fail
 * on a duplicate symbol.
 *
 * ## What it does, in order
 *
 * 1. Copies `../intents/` into `ios/HermieIntents/`. The Swift lives in the
 *    repository, not in the generated project, for the same reason the scene
 *    delegate does: `ios/` is disposable and `npx expo prebuild --clean` must be
 *    able to throw it away without losing work.
 * 2. Adds each file to the app target's group and Sources phase, once.
 *
 * There is no entitlements step. The App Group these intents write into is
 * already on the app — `with-hermie-widgets` and `with-hermie-share` both put it
 * there, additively, and a third copy of that code would be a third thing to
 * keep in step for no gain.
 *
 * ## Idempotence, and its one sharp edge
 *
 * The COPY runs on every prebuild, so editing one of these files is a prebuild
 * away rather than a `--clean` away. Adding a NEW file to `../intents/` is not:
 * the project surgery is guarded on the group already existing, so a new source
 * needs `npx expo prebuild --clean`. That is the same property the other two
 * plugins have, and the alternative — reconciling an existing group's children
 * against a directory listing — is more machinery than the case deserves.
 */

/** The group and directory name inside `ios/`. Not a target: see above. */
const GROUP = 'HermieIntents'

/** Every Swift file the app compiles from here, sorted so the project is stable. */
function intentSources(sourceDirectory) {
  return fs
    .readdirSync(sourceDirectory)
    .filter(name => name.endsWith('.swift'))
    .sort()
}

/**
 * Copy `intents/` into `ios/HermieIntents/`.
 *
 * Deleted first rather than merged over, so a Swift file removed from the
 * repository is removed from the build too. A stale `AppShortcutsProvider` left
 * behind here would be a second one in the same target, which is a compile
 * error whose cause is a file nobody can see in the diff.
 */
function copyIntentSources(sourceDirectory, destination) {
  fs.rmSync(destination, { force: true, recursive: true })
  fs.mkdirSync(destination, { recursive: true })

  for (const name of fs.readdirSync(sourceDirectory)) {
    fs.copyFileSync(path.join(sourceDirectory, name), path.join(destination, name))
  }
}

/**
 * Fails the prebuild when the sources landed in no build phase.
 *
 * The silence this guards against is the expensive one: the app builds, it
 * launches, everything works — and there are no Shortcuts, no Siri phrases and
 * no explanation anywhere, because four Swift files were copied into a
 * directory nothing compiles. It is the same class of failure
 * `with-hermie-widgets`' `touched === 0` check exists for.
 */
function assertCompiled(project, expected) {
  const phases = project.pbxSourcesBuildPhaseObj(project.getFirstTarget().uuid)
  const files = (phases?.files ?? []).map(entry => entry.comment ?? '')
  const missing = expected.filter(name => !files.some(comment => comment.includes(name)))

  if (missing.length === 0) {
    return
  }

  throw new Error(
    [
      `with-hermie-intents copied ${missing.join(', ')} into ios/${GROUP}/ but the app target does not compile them.`,
      '',
      'The symptom of shipping this way is silence: the app builds, it launches, and there are no',
      'Shortcuts and no Siri phrases — App Intents metadata is extracted from the sources a target',
      'actually compiles. Read node_modules/xcode/lib/pbxProject.js (addSourceFile) before changing',
      'the plugin.'
    ].join('\n')
  )
}

/**
 * Fails the prebuild when a file reference names a path Xcode cannot resolve.
 *
 * This exists because the first version of this plugin passed
 * `HermieIntents/<name>` to `addSourceFile` while the GROUP already carried
 * `HermieIntents` as its path, and Xcode resolves a child relative to its
 * group — so every source resolved to `ios/HermieIntents/HermieIntents/…` and
 * the app target failed with four "Build input files cannot be found".
 *
 * `assertCompiled` passed that build, and rightly: the files were in the
 * sources phase. The thing that was wrong was the path on the reference, which
 * is what this asks about. A reference inside a group with a path has a
 * BASENAME and nothing else.
 */
function assertPaths(project, expected) {
  const references = project.pbxFileReferenceSection()
  const offenders = []

  for (const key of Object.keys(references)) {
    const entry = references[key]
    const value = typeof entry === 'object' && entry !== null ? String(entry.path ?? '') : ''
    const unquoted = value.replace(/^"|"$/g, '')

    if (expected.includes(path.basename(unquoted)) && unquoted.includes('/')) {
      offenders.push(unquoted)
    }
  }

  if (offenders.length === 0) {
    return
  }

  throw new Error(
    [
      `with-hermie-intents wrote file references with a path inside a group that already has one: ${offenders.join(', ')}.`,
      '',
      'Xcode resolves a child relative to its group, so these would be looked for at',
      `ios/${GROUP}/${GROUP}/… and the app target would fail with "Build input files cannot be`,
      'found". A reference inside a group with a path is a basename and nothing else.'
    ].join('\n')
  )
}

module.exports = function withHermieIntents(config) {
  const sourceDirectory = path.join(__dirname, '..', 'intents')

  const withSources = withDangerousMod(config, [
    'ios',
    modConfig => {
      copyIntentSources(sourceDirectory, path.join(modConfig.modRequest.platformProjectRoot, GROUP))

      return modConfig
    }
  ])

  return withXcodeProject(withSources, modConfig => {
    const project = modConfig.modResults
    const sources = intentSources(sourceDirectory)

    if (project.pbxGroupByName(GROUP)) {
      // Already wired by an earlier prebuild. The files themselves were
      // re-copied above, so their CONTENT is current; only the project's list of
      // them is frozen. See the note on idempotence.
      assertCompiled(project, sources)
      assertPaths(project, sources)

      return modConfig
    }

    const target = project.getFirstTarget().uuid
    const group = project.pbxCreateGroup(GROUP, GROUP)

    project.addToPbxGroup(group, project.getFirstProject().firstProject.mainGroup)

    for (const name of sources) {
      // The BASENAME, not `HermieIntents/<name>`, and this cost a build to find
      // out. `pbxCreateGroup(GROUP, GROUP)` gives the group a `path` of
      // `HermieIntents`, and Xcode resolves a child's path relative to its
      // group — so joining the directory in again produced
      // `ios/HermieIntents/HermieIntents/HermieAppIntents.swift` and four
      // "Build input files cannot be found" errors. `assertCompiled` did not
      // catch it and could not: the files WERE in the sources phase, under a
      // path that does not exist. `assertPaths` below is the check that would
      // have.
      project.addSourceFile(name, { target }, group)
    }

    assertCompiled(project, sources)
    assertPaths(project, sources)

    return modConfig
  })
}

module.exports.GROUP = GROUP
module.exports.intentSources = intentSources
module.exports.assertCompiled = assertCompiled
module.exports.assertPaths = assertPaths
