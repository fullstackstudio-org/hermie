#!/usr/bin/env node
// Builds the Android release artefacts and says where they landed.
//
// The app bundle is what Play takes; the APK is what a person sideloads. Both
// come out of one Gradle invocation, so building them together costs barely more
// than building either.
//
//   npm run android:release              prebuild if needed, then bundle + assemble
//   npm run android:release -- --clean   prebuild --clean first, always
//   npm run android:release -- --apk     the APK only
//   npm run android:release -- --aab     the app bundle only
//
// Signing is not this script's business and deliberately so. The four
// HERMIE_UPLOAD_* values reach Gradle from `~/.gradle/gradle.properties` or from
// the environment, and `plugins/with-android-release-signing.js` decides what to
// do with them — the upload key when all four are there, the template's debug key
// otherwise. Nothing is read here, so nothing can be printed or written here.
// See docs/release.md.

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const { describeDrift, parseGradleIdentity } = require('./android-staleness.js')

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = resolve(appRoot, '..', '..')
const androidDir = join(appRoot, 'android')

const args = process.argv.slice(2)
const clean = args.includes('--clean')
const onlyApk = args.includes('--apk')
const onlyAab = args.includes('--aab')

if (onlyApk && onlyAab) {
  console.error('--apk and --aab are the two halves of the default; pass neither to get both.')
  process.exit(1)
}

function run(command, commandArgs, options = {}) {
  console.log(`\n> ${command} ${commandArgs.join(' ')}`)
  const result = spawnSync(command, commandArgs, { stdio: 'inherit', ...options })
  if (result.status !== 0) {
    process.exit(result.status ?? 1)
  }
}

/**
 * What `app.config.ts` says the Android project should be, right now.
 *
 * Asked of Expo rather than read out of the file, because the answer is not IN
 * the file: `android.versionCode` is `git rev-list --count HEAD` evaluated when
 * the config is, and the config plugins run over it afterwards. `expo config`
 * is the one thing that resolves both, and it costs a third of a second.
 *
 * `null` when it cannot be asked — a release must not be blocked because this
 * check could not run, so the caller says so and carries on.
 */
function expectedIdentity() {
  const result = spawnSync('npx', ['expo', 'config', '--json'], {
    cwd: appRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  })

  if (result.status !== 0 || !result.stdout) {
    return null
  }

  try {
    const config = JSON.parse(result.stdout)

    return {
      applicationId: config.android?.package,
      versionCode: config.android?.versionCode,
      versionName: config.version
    }
  } catch {
    return null
  }
}

/**
 * Why the native project is about to be generated, or nothing.
 *
 * Three reasons and they are in the order of how much they cost to be wrong
 * about: no project at all, the flag, and a project that no longer matches the
 * configuration it was generated from.
 */
function reasonToPrebuild() {
  if (!existsSync(join(androidDir, 'gradlew'))) {
    return { clean: false, why: ['no android/ yet'] }
  }

  if (clean) {
    return { clean: true, why: ['--clean given'] }
  }

  const expected = expectedIdentity()

  if (!expected) {
    console.log('Could not read app.config.ts through `expo config`; not checking whether android/ is stale.')

    return null
  }

  const generated = parseGradleIdentity(readFileSync(join(androidDir, 'app', 'build.gradle'), 'utf8'))
  const drift = describeDrift(generated, expected)

  return drift.length > 0 ? { clean: false, why: drift } : null
}

// `android/` is a prebuild output and gitignored, so a clean checkout has none.
// `--clean` regenerates it even when it is there. A project that IS there and is
// no longer the one app.config.ts describes is regenerated too — most often
// because the version code is the commit count and commits have happened since.
const prebuild = reasonToPrebuild()

if (prebuild) {
  for (const line of prebuild.why) {
    console.log(`Regenerating the native project: ${line}.`)
  }

  run('npx', ['expo', 'prebuild', '--platform', 'android', ...(prebuild.clean ? ['--clean'] : [])], { cwd: appRoot })
}

if (!process.env.JAVA_HOME) {
  // Not fatal: Gradle may still find a JDK. But on this project it is JDK 17, and
  // a wrong one fails much later with a message about nothing in particular.
  console.log('JAVA_HOME is not set. Android builds here need JDK 17 — see CONTRIBUTING.md.')
}

// bundleRelease before assembleRelease so the slower, more important artefact
// fails first if it is going to.
const tasks = onlyApk ? ['assembleRelease'] : onlyAab ? ['bundleRelease'] : ['bundleRelease', 'assembleRelease']
run('./gradlew', [...tasks, '--no-daemon'], { cwd: androidDir })

const outputs = [
  ['app bundle', join(androidDir, 'app', 'build', 'outputs', 'bundle', 'release', 'app-release.aab')],
  ['APK', join(androidDir, 'app', 'build', 'outputs', 'apk', 'release', 'app-release.apk')]
]

console.log('\nArtefacts:')
let missing = false
for (const [what, path] of outputs) {
  if (!existsSync(path)) {
    if ((onlyApk && what === 'app bundle') || (onlyAab && what === 'APK')) {
      continue
    }
    console.log(`  ${what}: NOT PRODUCED at ${relative(repoRoot, path)}`)
    missing = true
    continue
  }
  const megabytes = (statSync(path).size / 1024 / 1024).toFixed(1)
  console.log(`  ${what}: ${relative(repoRoot, path)} (${megabytes} MB)`)
}

if (missing) {
  process.exit(1)
}

console.log(
  '\nWhich key signed these is in the build log above, on the line beginning "hermie:".' +
    '\nCheck it before uploading: apksigner verify --print-certs on the APK, keytool -printcert -jarfile on the bundle.'
)
