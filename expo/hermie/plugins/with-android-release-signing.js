const { withAppBuildGradle } = require('expo/config-plugins')

// Release builds are signed with the owner's Play upload key, and the key never
// comes near this repository.
//
// The React Native template gives `buildTypes.release` the line
// `signingConfig signingConfigs.debug`, which produces a release APK signed with
// the well-known debug key: installable by hand, refused by Play. This plugin
// replaces that line with a choice made at configuration time — the upload key
// when all four `HERMIE_UPLOAD_*` values are there, the template's debug key when
// they are not, so a fork and a CI run with no key still build a release.
//
// The values are read by Gradle from `~/.gradle/gradle.properties` (outside the
// repository, outside the build tree) or from the environment, which is how CI
// hands over a secret. Nothing here writes them anywhere: the generated
// `android/app/build.gradle` contains the property NAMES and no value, and the
// prebuild output is therefore safe to inspect even though it is gitignored.
//
// See docs/release.md for the Play side and CONTRIBUTING for the local setup.
const MARKER = '// hermie: android release signing'

/** The four values, all of which have to be present before anything is signed. */
const PROPERTY_NAMES = [
  'HERMIE_UPLOAD_STORE_FILE',
  'HERMIE_UPLOAD_STORE_PASSWORD',
  'HERMIE_UPLOAD_KEY_ALIAS',
  'HERMIE_UPLOAD_KEY_PASSWORD'
]

/**
 * What this plugin assumes about the generated `app/build.gradle`. Each of these
 * is load-bearing and none of them is checked by anything else, so a template
 * change has to stop the prebuild rather than quietly produce a release APK
 * signed with the debug key — the one outcome that looks fine locally and is
 * rejected the moment it reaches Play.
 */
const EXPECTATIONS = [
  {
    what: 'a `signingConfigs` block',
    needed: 'the upload key is added to it as a second named configuration'
  },
  {
    what: 'a `debug` entry inside `signingConfigs`',
    needed: 'it is the fallback a build with no upload key keeps using'
  },
  {
    what: 'a `buildTypes` block with a `release` entry',
    needed: 'that is the build type whose signing config is being switched'
  },
  {
    what: 'exactly one `signingConfig signingConfigs.debug` inside `buildTypes.release`',
    needed: 'that single line is what gets replaced by the choice between the two keys'
  }
]

/**
 * The span of a `<name> {` block, found by counting braces from its opening one.
 *
 * Deliberately naive: it does not know about braces inside strings or comments.
 * It is only ever pointed at `signingConfigs` and `buildTypes`, whose bodies in
 * this template contain neither, and `assertShape` fails loudly if either block
 * stops being findable — so the naivety cannot silently produce a wrong edit.
 */
function findBlock(contents, header, from = 0) {
  const start = contents.indexOf(header, from)
  if (start === -1) {
    return undefined
  }

  const open = contents.indexOf('{', start)
  if (open === -1) {
    return undefined
  }

  let depth = 0
  for (let index = open; index < contents.length; index += 1) {
    if (contents[index] === '{') {
      depth += 1
    } else if (contents[index] === '}') {
      depth -= 1
      if (depth === 0) {
        return { start, open, close: index, body: contents.slice(open + 1, index) }
      }
    }
  }

  return undefined
}

const DEBUG_SIGNING_LINE = 'signingConfig signingConfigs.debug'

/** Reports which of `EXPECTATIONS` the given `build.gradle` fails, if any. */
function shapeFailures(contents) {
  const failures = []

  const signingConfigs = findBlock(contents, 'signingConfigs {')
  if (signingConfigs === undefined) {
    failures.push(EXPECTATIONS[0])
  } else if (findBlock(signingConfigs.body, 'debug {') === undefined) {
    failures.push(EXPECTATIONS[1])
  }

  const buildTypes = findBlock(contents, 'buildTypes {')
  const release = buildTypes === undefined ? undefined : findBlock(buildTypes.body, 'release {')
  if (release === undefined) {
    failures.push(EXPECTATIONS[2])
  } else {
    const occurrences = release.body.split(DEBUG_SIGNING_LINE).length - 1
    if (occurrences !== 1) {
      failures.push(EXPECTATIONS[3])
    }
  }

  return failures
}

/** Throws a message naming every assumption that no longer holds. */
function assertShape(contents) {
  const failures = shapeFailures(contents)
  if (failures.length === 0) {
    return
  }

  throw new Error(
    [
      'The generated android/app/build.gradle no longer has the shape',
      'with-android-release-signing patches, so a release build would silently keep the debug',
      'key — which installs by hand and is refused by Play. Missing:',
      ...failures.map(failure => `  - ${failure.what}\n      needed because ${failure.needed}`),
      '',
      'Read the new template before changing the plugin. If it has grown a release signing',
      'config of its own, delete this plugin instead of adjusting it.'
    ].join('\n')
  )
}

/**
 * The Groovy that reads the four values and decides which key signs a release.
 *
 * Written as a top-level `def` block because that is what the template already
 * does for `enableMinifyInReleaseBuilds`, and a script-level `def` is visible
 * inside the `android { }` closure below it.
 */
function signingDecisionSnippet() {
  return [
    MARKER,
    '//',
    '// Reads the upload key from Gradle properties, or from the environment, which is how CI',
    '// passes a secret. With any of the four missing, release keeps the debug signing below, so',
    '// a checkout with no key still builds. The values are handed straight to AGP and are never',
    '// printed or written to a file — see expo/hermie/plugins/with-android-release-signing.js.',
    'def hermieUploadSetting = { String name ->',
    '    def value = project.findProperty(name)',
    '    if (value == null || value.toString().trim().isEmpty()) {',
    '        value = System.getenv(name)',
    '    }',
    // No trimming and no unquoting: the value reaches `file()` and AGP exactly as
    // configured. The owner's path contains spaces, and trimming a password would
    // silently change a legitimate one.
    '    (value == null || value.toString().trim().isEmpty()) ? null : value.toString()',
    '}',
    "def hermieUploadStoreFilePath = hermieUploadSetting('HERMIE_UPLOAD_STORE_FILE')",
    "def hermieUploadStorePassword = hermieUploadSetting('HERMIE_UPLOAD_STORE_PASSWORD')",
    "def hermieUploadKeyAlias = hermieUploadSetting('HERMIE_UPLOAD_KEY_ALIAS')",
    "def hermieUploadKeyPassword = hermieUploadSetting('HERMIE_UPLOAD_KEY_PASSWORD')",
    'def hermieUploadConfigured = hermieUploadStoreFilePath != null &&',
    '    hermieUploadStorePassword != null &&',
    '    hermieUploadKeyAlias != null &&',
    '    hermieUploadKeyPassword != null',
    '',
    '// Only when a release is actually being built. A debug build needs none of this, and failing',
    '// `npm run android` over a release credential would be a worse trap than the one below.',
    'def hermieUploadReleaseRequested = gradle.startParameter.taskNames.any {',
    "    it.toLowerCase(Locale.ROOT).contains('release')",
    '}',
    '',
    'if (hermieUploadConfigured && hermieUploadReleaseRequested) {',
    '    // Open the keystore here rather than letting the signing task fail minutes in: a wrong',
    '    // password arrives from deep inside AGP as a BadPaddingException with nothing pointing at',
    '    // the cause, and the cause is almost always a quoted value in a properties file.',
    '    def hermieUploadKeystore = file(hermieUploadStoreFilePath)',
    '    if (!hermieUploadKeystore.isFile()) {',
    '        throw new GradleException(',
    '            "hermie: HERMIE_UPLOAD_STORE_FILE does not name a file: ${hermieUploadKeystore}\\n" +',
    '            "  hint: a Gradle properties file keeps quote characters, so a quoted path still has" +',
    '            " them in it — check that the value in ~/.gradle/gradle.properties is not quoted.")',
    '    }',
    '    def hermieUploadOpened = false',
    '    def hermieUploadFailure = null',
    "    for (String hermieUploadStoreType : ['PKCS12', 'JKS']) {",
    '        try {',
    '            def hermieUploadStore = java.security.KeyStore.getInstance(hermieUploadStoreType)',
    '            hermieUploadKeystore.withInputStream { stream ->',
    '                hermieUploadStore.load(stream, hermieUploadStorePassword.toCharArray())',
    '            }',
    '            if (!hermieUploadStore.containsAlias(hermieUploadKeyAlias)) {',
    '                throw new GradleException(',
    '                    "hermie: the upload keystore has no key aliased \'${hermieUploadKeyAlias}\'." +',
    '                    " Aliases it does have: ${hermieUploadStore.aliases().toList()}")',
    '            }',
    '            hermieUploadStore.getKey(hermieUploadKeyAlias, hermieUploadKeyPassword.toCharArray())',
    '            hermieUploadOpened = true',
    '            break',
    '        } catch (GradleException hermieUploadRethrow) {',
    '            throw hermieUploadRethrow',
    '        } catch (Exception hermieUploadCaught) {',
    '            hermieUploadFailure = hermieUploadCaught',
    '        }',
    '    }',
    '    if (!hermieUploadOpened) {',
    '        // The exception CLASS only. Its message can quote what was fed to the cipher.',
    '        throw new GradleException(',
    '            "hermie: the upload keystore did not open (${hermieUploadFailure?.getClass()?.getSimpleName()}).\\n" +',
    '            "  hint: check that the passwords in ~/.gradle/gradle.properties are not quoted — a" +',
    '            " properties file does not strip quotes, so the quote characters become part of the" +',
    '            " password and the keystore refuses it.")',
    '    }',
    '}',
    '',
    '// One line, so a build log says which key it used instead of leaving it to be guessed.',
    'if (hermieUploadConfigured) {',
    '    println "hermie: release builds are signed with the upload key in HERMIE_UPLOAD_STORE_FILE" +',
    '        " (alias ${hermieUploadKeyAlias})"',
    '} else {',
    '    println "hermie: no upload key configured, so release builds keep the template\'s debug" +',
    `        " signing. Set ${PROPERTY_NAMES.slice(0, 2).join(', ')}," +`,
    `        " ${PROPERTY_NAMES.slice(2).join(' and ')} to sign."`,
    '}',
    ''
  ].join('\n')
}

/** The upload key as a named signing config, created only when it is configured. */
const RELEASE_SIGNING_CONFIG = [
  '',
  '        // Absent unless all four values are there, which is what leaves `signingConfigs.debug`',
  '        // as the only option on a checkout with no key.',
  '        if (hermieUploadConfigured) {',
  '            release {',
  "                // The raw string: the owner's path contains spaces, and `file()` takes a path,",
  '                // not a command line, so there is nothing to quote or split.',
  '                storeFile file(hermieUploadStoreFilePath)',
  '                storePassword hermieUploadStorePassword',
  '                keyAlias hermieUploadKeyAlias',
  '                keyPassword hermieUploadKeyPassword',
  '            }',
  '        }'
].join('\n')

/** The line that replaces the template's unconditional debug signing. */
const RELEASE_SIGNING_CHOICE = [
  '// The upload key when it is configured, the debug key otherwise. The ternary is what keeps',
  '// `signingConfigs.release` from being dereferenced when it was never created.',
  'signingConfig hermieUploadConfigured ? signingConfigs.release : signingConfigs.debug'
]

/**
 * Adds the release signing config to a generated `app/build.gradle`.
 *
 * Idempotent by marker, so a second pass over an already-patched file returns it
 * unchanged. Pure: it takes and returns the contents.
 */
function addReleaseSigning(contents) {
  if (contents.includes(MARKER)) {
    return contents
  }

  assertShape(contents)

  // Work back to front so the earlier offsets stay valid.
  const buildTypes = findBlock(contents, 'buildTypes {')
  const release = findBlock(buildTypes.body, 'release {')
  const releaseStart = buildTypes.open + 1 + release.open + 1
  const lineStart = contents.lastIndexOf('\n', contents.indexOf(DEBUG_SIGNING_LINE, releaseStart)) + 1
  const indent = /^[ \t]*/.exec(contents.slice(lineStart))[0]
  const lineEnd = lineStart + indent.length + DEBUG_SIGNING_LINE.length

  let patched =
    contents.slice(0, lineStart) +
    RELEASE_SIGNING_CHOICE.map(line => `${indent}${line}`).join('\n') +
    contents.slice(lineEnd)

  // Before the newline that opens the block's closing line, so the `}` keeps its indentation.
  const signingConfigs = findBlock(patched, 'signingConfigs {')
  const insertAt = patched.lastIndexOf('\n', signingConfigs.close)
  patched = patched.slice(0, insertAt) + RELEASE_SIGNING_CONFIG + patched.slice(insertAt)

  // `android {` is the first thing that needs the values, and a script-level
  // `def` above it is in scope inside every closure below.
  const androidBlock = patched.indexOf('\nandroid {')
  if (androidBlock === -1) {
    throw new Error('Could not find the top-level `android {` block in the generated app/build.gradle.')
  }

  return `${patched.slice(0, androidBlock + 1)}${signingDecisionSnippet()}\n${patched.slice(androidBlock + 1)}`
}

module.exports = function withAndroidReleaseSigning(config) {
  return withAppBuildGradle(config, modConfig => {
    if (modConfig.modResults.language !== 'groovy') {
      throw new Error(
        `with-android-release-signing expects the Groovy app/build.gradle of the Expo SDK 54 template, not ${modConfig.modResults.language}.`
      )
    }

    modConfig.modResults.contents = addReleaseSigning(modConfig.modResults.contents)
    return modConfig
  })
}

module.exports.addReleaseSigning = addReleaseSigning
module.exports.assertShape = assertShape
module.exports.MARKER = MARKER
module.exports.PROPERTY_NAMES = PROPERTY_NAMES
