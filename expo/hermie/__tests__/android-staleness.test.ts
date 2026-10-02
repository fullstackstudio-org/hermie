/**
 * Whether `android/` is still the project `app.config.ts` describes.
 *
 * The failure this exists for is silent by construction. `android/` is a prebuild
 * output and gitignored, so the first build of a checkout generates it and
 * everything agrees; nothing regenerates it afterwards, and `android.versionCode`
 * is `git rev-list --count HEAD` — a number that moves with every commit. A tree
 * that prebuilt at 133 and released at 192 builds a bundle carrying 133, which
 * installs perfectly and which Play refuses because it has already seen it.
 *
 * The checked-in generated file is used as one of the fixtures, so a change to
 * the template that moves any of the three values out of reach fails here rather
 * than at an upload.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const { describeDrift, parseGradleIdentity } = require('../scripts/android-staleness.js') as {
  describeDrift: (
    generated: Record<string, string | null>,
    expected: Record<string, string | number | null | undefined>
  ) => string[]
  parseGradleIdentity: (contents: string) => Record<string, string | null>
}

const FIXTURE = join(__dirname, 'support', 'generated-app-build.gradle')
const GENERATED = join(__dirname, '..', 'android', 'app', 'build.gradle')

const CURRENT = { applicationId: 'dev.hermie.app', versionCode: 192, versionName: '0.1.0' }

describe('reading what prebuild wrote', () => {
  it('finds all three in the template the plugin tests are pinned to', () => {
    const identity = parseGradleIdentity(readFileSync(FIXTURE, 'utf8'))

    expect(Object.keys(identity).sort()).toEqual(['applicationId', 'versionCode', 'versionName'])
    for (const [key, value] of Object.entries(identity)) {
      expect({ key, found: value !== null }).toEqual({ key, found: true })
    }
  })

  it('finds all three in the file this checkout actually generated', () => {
    if (!existsSync(GENERATED)) {
      // A clean checkout has no android/ at all, and the script prebuilds before
      // it ever reads one. Nothing to assert, and nothing wrong.
      return
    }

    const identity = parseGradleIdentity(readFileSync(GENERATED, 'utf8'))

    expect(identity.applicationId).toBe('dev.hermie.app')
    expect(identity.versionCode).toMatch(/^\d+$/u)
    expect(identity.versionName).toMatch(/^\d+\.\d+\.\d+$/u)
  })

  it('does not mistake applicationIdSuffix for the application id', () => {
    const identity = parseGradleIdentity(`
      android {
        buildTypes {
          debug { applicationIdSuffix ".debug" }
        }
        defaultConfig {
          applicationId 'dev.hermie.app'
          versionCode 192
          versionName "0.1.0"
        }
      }
    `)

    expect(identity.applicationId).toBe('dev.hermie.app')
  })

  it('answers null for a file that carries none of them', () => {
    expect(parseGradleIdentity('apply plugin: "com.android.application"')).toEqual({
      applicationId: null,
      versionCode: null,
      versionName: null
    })
  })
})

describe('what counts as stale', () => {
  const generated = { applicationId: 'dev.hermie.app', versionCode: '192', versionName: '0.1.0' }

  it('says nothing when the three agree', () => {
    expect(describeDrift(generated, CURRENT)).toEqual([])
  })

  it('catches the commit count moving, which is the one that always moves', () => {
    expect(describeDrift({ ...generated, versionCode: '133' }, CURRENT)).toEqual([
      'versionCode is 133 in android/app/build.gradle; app.config.ts says 192'
    ])
  })

  it('catches a renamed application id, which is a different app to the system', () => {
    expect(describeDrift({ ...generated, applicationId: 'nl.fullstackstudio.hermie' }, CURRENT)).toEqual([
      'applicationId is nl.fullstackstudio.hermie in android/app/build.gradle; app.config.ts says dev.hermie.app'
    ])
  })

  it('catches a version bump that only reached app.config.ts', () => {
    expect(describeDrift(generated, { ...CURRENT, versionName: '0.2.0' })).toEqual([
      'versionName is 0.1.0 in android/app/build.gradle; app.config.ts says 0.2.0'
    ])
  })

  it('reports every value that moved, not the first', () => {
    expect(describeDrift({ applicationId: 'old.app', versionCode: '1', versionName: '0.0.1' }, CURRENT)).toHaveLength(3)
  })

  it('treats a value it could not read as drift, because it cannot be checked', () => {
    expect(describeDrift({ ...generated, versionCode: null }, CURRENT)).toEqual([
      'versionCode is not in android/app/build.gradle; app.config.ts says 192'
    ])
  })

  it('compares as text, so 192 and "192" are the same fact', () => {
    expect(describeDrift(generated, { ...CURRENT, versionCode: '192' })).toEqual([])
  })

  it('skips a value app.config.ts does not name rather than inventing one', () => {
    expect(describeDrift(generated, { ...CURRENT, applicationId: undefined })).toEqual([])
  })
})
