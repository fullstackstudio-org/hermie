/**
 * The Android release signing patch.
 *
 * Two things this has to pin. That the patched `build.gradle` still makes the
 * choice it is supposed to — the upload key when configured, the debug key
 * otherwise — because the failure mode is a release APK that looks fine, installs
 * fine, and is refused by Play. And that no value ever reaches the file: the
 * patch may carry the property NAMES and nothing else.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const plugin = require('../plugins/with-android-release-signing')
const { addReleaseSigning, assertShape, MARKER, PROPERTY_NAMES } = plugin

const FIXTURE_PATH = join(__dirname, 'support', 'generated-app-build.gradle')
const GENERATED_PATH = join(__dirname, '..', 'android', 'app', 'build.gradle')

const fixture = readFileSync(FIXTURE_PATH, 'utf8')
const patched = addReleaseSigning(fixture)

/** The body of a `<header> {` block, by brace counting — the same idea the plugin uses. */
function block(contents: string, header: string): string {
  const start = contents.indexOf(header)
  expect(start).toBeGreaterThanOrEqual(0)

  const open = contents.indexOf('{', start)
  let depth = 0
  for (let index = open; index < contents.length; index += 1) {
    if (contents[index] === '{') depth += 1
    else if (contents[index] === '}') {
      depth -= 1
      if (depth === 0) return contents.slice(open + 1, index)
    }
  }

  throw new Error(`unterminated block: ${header}`)
}

describe('the fixture this is all reasoned about', () => {
  it('is the template the plugin was written against: release signed with the debug key', () => {
    const release = block(block(fixture, 'buildTypes {'), 'release {')

    expect(release).toContain('signingConfig signingConfigs.debug')
    expect(fixture).not.toContain(MARKER)
  })
})

describe('the patched build.gradle', () => {
  it('chooses the upload key when it is configured and the debug key when it is not', () => {
    const release = block(block(patched, 'buildTypes {'), 'release {')

    expect(release).toContain('signingConfig hermieUploadConfigured ? signingConfigs.release : signingConfigs.debug')
    // The unconditional line is gone: leaving it behind would win, being later.
    expect(release).not.toMatch(/signingConfig signingConfigs\.debug/)
  })

  it('leaves the debug build type alone', () => {
    expect(block(block(patched, 'buildTypes {'), 'debug {')).toContain('signingConfig signingConfigs.debug')
  })

  it('keeps the template debug signing config and adds the upload one beside it', () => {
    const signingConfigs = block(patched, 'signingConfigs {')

    expect(signingConfigs).toContain("storeFile file('debug.keystore')")
    expect(signingConfigs).toContain('if (hermieUploadConfigured) {')
    expect(signingConfigs).toContain('storeFile file(hermieUploadStoreFilePath)')
    expect(signingConfigs).toContain('storePassword hermieUploadStorePassword')
    expect(signingConfigs).toContain('keyAlias hermieUploadKeyAlias')
    expect(signingConfigs).toContain('keyPassword hermieUploadKeyPassword')
  })

  it('reads every one of the four from a property first and the environment second', () => {
    for (const name of PROPERTY_NAMES) {
      expect(patched).toContain(`hermieUploadSetting('${name}')`)
    }

    expect(patched).toContain('project.findProperty(name)')
    expect(patched).toContain('System.getenv(name)')
  })

  it('treats the store file as a path, not as a command line', () => {
    // The owner's keystore lives under a directory with spaces in its name. `file()` takes the
    // string whole; anything that split it on whitespace would look for a keystore called "Studio".
    expect(patched).toContain('storeFile file(hermieUploadStoreFilePath)')
    expect(patched).not.toMatch(/hermieUploadStoreFilePath\s*\.\s*(split|tokenize)/)
  })

  it('requires all four before it signs anything', () => {
    const decision = /def hermieUploadConfigured =([\s\S]*?)\n\n/.exec(patched)?.[1] ?? ''

    for (const variable of [
      'hermieUploadStoreFilePath',
      'hermieUploadStorePassword',
      'hermieUploadKeyAlias',
      'hermieUploadKeyPassword'
    ]) {
      expect(decision).toContain(`${variable} != null`)
    }
    expect(decision).not.toContain('||')
  })

  it('says in one line which key a build used', () => {
    expect(patched).toContain('println "hermie: release builds are signed with the upload key')
    expect(patched).toContain('println "hermie: no upload key configured')
  })

  it('names the quoting trap when the keystore will not open', () => {
    expect(patched).toContain('are not quoted')
    expect(patched).toContain('does not strip quotes')
  })

  it('reports only the exception class, never what was fed to the cipher', () => {
    expect(patched).toContain('hermieUploadFailure?.getClass()?.getSimpleName()')
    expect(patched).not.toContain('hermieUploadFailure.getMessage()')
    expect(patched).not.toContain('${hermieUploadFailure}')
  })

  it('never prints or writes a password, only the names of the properties holding them', () => {
    // Everything the patch adds, so the assertion cannot be fooled by the template's own text.
    const added = patched
      .split('\n')
      .filter(line => !fixture.includes(line))
      .join('\n')

    for (const printed of added.matchAll(/println\s+(.*)$/gm)) {
      expect(printed[1]).not.toContain('Password')
    }
    // The debug keystore's password is the template's own and is public; nothing else is literal.
    expect(added).not.toMatch(/storePassword\s+['"]/)
    expect(added).not.toMatch(/keyPassword\s+['"]/)
  })

  it('does not change on a second pass', () => {
    expect(addReleaseSigning(patched)).toBe(patched)
  })

  it('is marked, which is what makes the second pass a no-op', () => {
    expect(patched).toContain(MARKER)
  })
})

describe('the shape it depends on', () => {
  it('accepts the generated SDK 54 template', () => {
    expect(() => assertShape(fixture)).not.toThrow()
  })

  // Each of these is an anchor the patch needs and the compiler cannot check. Losing one quietly
  // would mean a release APK signed with the debug key, which is the one failure that looks like
  // success right up until Play rejects the upload.
  const loadBearing = [
    ['the signingConfigs block is gone', 'signingConfigs {', 'signingConfigurations {'],
    [
      'the debug signing config is gone',
      "        debug {\n            storeFile file('debug.keystore')",
      "        aDifferentName {\n            storeFile file('debug.keystore')"
    ],
    [
      'the release build type is gone',
      '        release {\n            // Caution!',
      '        shipping {\n            // Caution!'
    ],
    [
      'the release build type no longer names the debug signing config',
      '            signingConfig signingConfigs.debug\n            def enableShrinkResources',
      '            def enableShrinkResources'
    ]
  ] as const

  for (const [what, present, replacement] of loadBearing) {
    it(`fails loudly when ${what}`, () => {
      expect(fixture).toContain(present)
      const changed = fixture.replace(present, replacement)

      expect(() => assertShape(changed)).toThrow(/no longer has the shape/)
      expect(() => addReleaseSigning(changed)).toThrow(/no longer has the shape/)
    })
  }

  it('refuses a release build type that names the debug config twice, rather than guessing', () => {
    const changed = fixture.replace(
      '            signingConfig signingConfigs.debug\n            def enableShrinkResources',
      '            signingConfig signingConfigs.debug\n            signingConfig signingConfigs.debug\n            def enableShrinkResources'
    )

    expect(() => assertShape(changed)).toThrow(/exactly one/)
  })

  it('explains what each missing anchor was for', () => {
    expect(() => assertShape('android {}')).toThrow(/needed because/)
  })
})

/**
 * The two lines a prebuild fills in per checkout rather than per template.
 * `versionCode` is the git commit COUNT and `versionName` the marketing version,
 * so a real `android/` disagrees with the fixture on both for reasons that have
 * nothing to do with signing — every commit moves one of them. Everything else
 * has to match byte for byte, which is the point of the comparison.
 */
function withoutGeneratedVersions(contents: string): string {
  return contents.replace(/^(\s*version(?:Code|Name) ).*$/gm, '$1<generated>')
}

describe('the generated project, when one has been prebuilt here', () => {
  // `android/` is generated and not committed, so CI reasons about the fixture. When a prebuild has
  // run, hold the two against each other: a template change then fails a test instead of shipping
  // a differently-signed APK. And confirm on the real file that no secret landed in it.
  const generated = existsSync(GENERATED_PATH) ? readFileSync(GENERATED_PATH, 'utf8') : undefined
  const test = generated === undefined ? it.skip : it

  test('is what this plugin produces from the fixture', () => {
    expect(withoutGeneratedVersions(generated as string)).toBe(withoutGeneratedVersions(patched))
  })

  test('carries the property names and no value', () => {
    for (const name of PROPERTY_NAMES) {
      expect(generated).toContain(name)
    }
    // The alias is the only one of the four with a value that is not a secret, and even that is
    // read at configuration time rather than written here.
    expect(generated).not.toContain('hermie-upload')
    expect(generated).not.toMatch(/\.jks/)
  })
})
