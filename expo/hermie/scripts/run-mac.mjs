#!/usr/bin/env node
// Builds the Mac version of Hermie and opens it.
//
// The Mac version IS the iOS app, running as "Designed for iPad" on Apple
// Silicon (docs/adr/0011-mac-via-the-ipad-build.md). So there is no separate
// project: this generates `ios/` if it is missing, installs pods if they are
// stale, builds the iOS scheme for the macOS destination, and then wraps the
// product, because a bare iOS .app is not something macOS will launch.
//
//   npm run mac                      Release, and open it
//   npm run mac -- --no-open         build only
//   npm run mac -- --debug           Debug; needs Metro running
//   npm run mac -- --team ABCDE12345 override HERMIE_APPLE_TEAM_ID
//
// The team identifier comes from `HERMIE_APPLE_TEAM_ID` or `--team`, never from
// a file in this repository: signing for a Mac needs a real Apple Developer
// team, and that is per person, not per project.

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const iosDir = join(appRoot, 'ios')
const derivedData = join(iosDir, 'build', 'MacDerivedData')
const wrappedRoot = join(iosDir, 'build', 'mac')

const args = process.argv.slice(2)
const configuration = args.includes('--debug') ? 'Debug' : 'Release'
const shouldOpen = !args.includes('--no-open')
const teamFlag = args.indexOf('--team')
const team = teamFlag === -1 ? process.env.HERMIE_APPLE_TEAM_ID : args[teamFlag + 1]

if (!team) {
  fail(
    'Set HERMIE_APPLE_TEAM_ID to your ten-character Apple Developer team identifier (or pass --team <id>): a Mac build has to be signed, and the team is yours rather than the repository’s.'
  )
}

function fail(message) {
  console.error(message)
  process.exit(1)
}

function run(command, commandArgs, options = {}) {
  console.log(`\n> ${command} ${commandArgs.join(' ')}`)
  const result = spawnSync(command, commandArgs, { stdio: 'inherit', ...options })
  if (result.status !== 0) {
    process.exit(result.status ?? 1)
  }
}

// `ios/` is a prebuild output and is gitignored, so a clean checkout has none.
if (!existsSync(join(iosDir, 'Hermie.xcworkspace'))) {
  console.log('No ios/ yet, generating it.')
  run('npx', ['expo', 'prebuild', '--platform', 'ios'], { cwd: appRoot })
}

/**
 * Pods are stale when they are absent, or when Podfile.lock has moved on from
 * the manifest CocoaPods left inside Pods/. That second case is the one that
 * bites: `npm install` replaces node_modules while the Pods project still holds
 * absolute paths into it, and the build then fails deep inside a dependency
 * rather than at the project level.
 */
function podsAreStale() {
  const lock = join(iosDir, 'Podfile.lock')
  const manifest = join(iosDir, 'Pods', 'Manifest.lock')

  if (!existsSync(manifest) || !existsSync(lock)) {
    return true
  }

  return readFileSync(lock, 'utf8') !== readFileSync(manifest, 'utf8')
}

if (podsAreStale()) {
  console.log('Pods are missing or out of date, installing.')
  // CocoaPods aborts with "Unicode Normalization not appropriate for ASCII-8BIT"
  // unless the locale is UTF-8, and says so in its own warning.
  run('pod', ['install'], { cwd: iosDir, env: { ...process.env, LANG: 'en_US.UTF-8' } })
}

run(
  'xcodebuild',
  [
    '-workspace',
    'Hermie.xcworkspace',
    '-scheme',
    'Hermie',
    '-configuration',
    configuration,
    '-destination',
    'platform=macOS,variant=Designed for iPad',
    '-derivedDataPath',
    derivedData,
    '-allowProvisioningUpdates',
    // A Mac that has never built this app is not in the team's device list, and
    // automatic signing will not add it on its own — it renews profiles for
    // devices it already knows and fails with "doesn't include the currently
    // selected device" for one it does not. This is the flag that lets it
    // register the machine, which is a one-off per Mac and the difference
    // between `npm run mac` working on a fresh checkout and not.
    '-allowProvisioningDeviceRegistration',
    `DEVELOPMENT_TEAM=${team}`,
    'CODE_SIGN_STYLE=Automatic',
    'build'
  ],
  { cwd: iosDir }
)

/**
 * Where the product landed.
 *
 * Xcode names the products directory after the SDK it built against, and for
 * this destination that name is not the one either `iphoneos` or `macosx` would
 * suggest. Reading the directory is one syscall and survives Xcode renaming it.
 */
function findBuiltApp() {
  const products = join(derivedData, 'Build', 'Products')

  if (!existsSync(products)) {
    return null
  }

  for (const entry of readdirSync(products)) {
    const candidate = join(products, entry, 'Hermie.app')
    if (existsSync(candidate)) {
      return candidate
    }
  }

  return null
}

const built = findBuiltApp()

if (!built) {
  fail(`The build reported success but no Hermie.app turned up under ${join(derivedData, 'Build', 'Products')}.`)
}

/**
 * Wrap it, or macOS refuses to launch it.
 *
 * A "Designed for iPad" app is an iOS bundle, and opening one directly fails
 * with "the application ... has an incorrect executable format". macOS expects
 * the shape the App Store installs: an outer .app whose payload is the iOS
 * bundle inside `Wrapper/`, with `WrappedBundle` pointing at it. The symlink is
 * relative on purpose — an absolute one only works on the machine that built it.
 */
const wrapped = join(wrappedRoot, 'Hermie.app')

rmSync(wrappedRoot, { force: true, recursive: true })
mkdirSync(join(wrapped, 'Wrapper'), { recursive: true })

// ditto rather than cp: a .app is a bundle with symlinks and extended
// attributes, and cp -R does not reliably keep them.
run('ditto', [built, join(wrapped, 'Wrapper', 'Hermie.app')])
symlinkSync(join('Wrapper', 'Hermie.app'), join(wrapped, 'WrappedBundle'))

console.log(`\nWrapped: ${wrapped}`)

if (configuration === 'Debug') {
  console.log('\nA Debug build loads its JavaScript from Metro. Start it with:')
  console.log('  npm run start --workspace @hermie/app')
}

if (shouldOpen) {
  run('open', [wrapped])
}
