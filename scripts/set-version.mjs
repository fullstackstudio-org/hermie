#!/usr/bin/env node
/**
 * Sets the version everywhere it is written down, in one go.
 *
 *   node scripts/set-version.mjs 0.2.0
 *   node scripts/set-version.mjs 0.2.0 --check    # report, change nothing
 *
 * Seven places now, and they drift because most of them are easy to forget:
 * the root package.json, the app's package.json, `version` in app.config.ts —
 * the marketing version every platform ships: iOS, Android, and the Mac,
 * which is the iOS build (ADR-0011) — and, since the desktop shell
 * (ADR-0027), its own package.json, `tauri.conf.json`'s `version`, and
 * `Cargo.toml`'s `[package].version`, which is what CI's `cargo
 * check`/`tauri build` embed in the shell binary and the platform installers
 * read. The seventh, added because it drifted silently for two releases
 * (0.1.6 while the rest read 0.1.8), is `packages/hermie-web/package.json`:
 * Hermie Web reads its own version from that file to answer `/hermie/update`
 * and to label the release zip and the GHCR image, so it has to track the
 * app the same way the desktop shell does. The other workspace packages
 * (`fake-gateway`, `gateway-client`, `transcript`) are `private` and pinned
 * at `0.0.0` on purpose — they never ship on their own — and
 * `hermes-shared` is vendored from upstream and is never touched by this
 * script.
 *
 * `package-lock.json` mirrors every one of those workspace versions in its
 * own `packages["<path>"].version` entries (plus the root document's own
 * `name`/`version`), and npm rewrites them the moment anyone runs an
 * install against a bumped package.json — which is exactly the uncontrolled
 * lock churn this script exists to avoid, so it writes them itself, in the
 * same commit, instead.
 *
 * `Cargo.lock` records the desktop crate's own version too, in its
 * `hermie-desktop` package entry. CI builds the crate with `--locked`, so a
 * lockfile that still names the previous version fails that job outright
 * ("cannot update the lock file"); it is written here for the same reason the
 * npm lockfile is.
 *
 * The native Apple apps (`native/`) carry their own line, `MARKETING_VERSION`
 * in `native/apple/Config/Version.xcconfig`, and it is allowed to differ from
 * the Expo one until the native apps replace the Expo app. It is written only
 * when `--native <version>` is given, a native release can bump it alone, and
 * it may never fall behind the Expo line: both apps upload to the same App
 * Store Connect record, so the native version has to be at least the Expo
 * one. docs/release.md has the rule.
 *
 *   node scripts/set-version.mjs 0.1.10                   # the Expo line only
 *   node scripts/set-version.mjs --native 0.2.1           # the native line only
 *   node scripts/set-version.mjs 0.1.10 --native 0.2.1    # both
 *
 * Run it from a clean tree, read the diff, then tag. docs/release.md is the
 * surrounding process.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/
const USAGE = 'usage: node scripts/set-version.mjs [<major.minor.patch>] [--native <major.minor.patch>] [--check]'

const args = process.argv.slice(2)
let checkOnly = false
let version
let nativeVersion
for (let index = 0; index < args.length; index += 1) {
  const argument = args[index]
  if (argument === '--check') {
    checkOnly = true
  } else if (argument === '--native') {
    nativeVersion = args[index + 1]
    index += 1
    if (!nativeVersion || !SEMVER.test(nativeVersion)) {
      console.error(USAGE)
      process.exit(2)
    }
  } else if (!argument.startsWith('--') && version === undefined && SEMVER.test(argument)) {
    version = argument
  } else {
    console.error(USAGE)
    process.exit(2)
  }
}

if (!version && !nativeVersion) {
  console.error(USAGE)
  process.exit(2)
}

/**
 * Orders two versions by major, minor and patch, and puts a pre-release before
 * the release it leads up to. Enough for the one comparison below; the
 * pre-release tags themselves are not ordered against each other.
 */
function compareVersions(left, right) {
  const parse = value => {
    const [core, pre] = value.split('-', 2)
    return { numbers: core.split('.').map(Number), pre: pre !== undefined }
  }
  const a = parse(left)
  const b = parse(right)
  for (let index = 0; index < 3; index += 1) {
    if (a.numbers[index] !== b.numbers[index]) {
      return a.numbers[index] - b.numbers[index]
    }
  }
  return Number(b.pre) - Number(a.pre)
}

const NATIVE_VERSION_FILE = 'native/apple/Config/Version.xcconfig'
const NATIVE_VERSION_PATTERN = /^MARKETING_VERSION = (\S+)$/m

/**
 * The native line is checked before anything is written: it may never be
 * behind the Expo line, whichever of the two this run moves.
 */
const currentNative = NATIVE_VERSION_PATTERN.exec(readFileSync(resolve(repoRoot, NATIVE_VERSION_FILE), 'utf8'))?.[1]
if (currentNative === undefined) {
  console.error(`${NATIVE_VERSION_FILE}: could not find MARKETING_VERSION.`)
  console.error('The file has moved on without this script. Read it and fix the pattern.')
  process.exit(1)
}
const expoVersion = version ?? JSON.parse(readFileSync(resolve(repoRoot, 'package.json'), 'utf8')).version
const nativeAfter = nativeVersion ?? currentNative
if (!SEMVER.test(nativeAfter)) {
  console.error(`${NATIVE_VERSION_FILE}: MARKETING_VERSION ${nativeAfter} is not a version.`)
  process.exit(1)
}
if (compareVersions(nativeAfter, expoVersion) < 0) {
  console.error(`The native line (${nativeAfter}) would be behind the Expo line (${expoVersion}).`)
  console.error('Both upload to the same App Store Connect record; pass --native with a version at least as high.')
  process.exit(1)
}

const changes = []

/**
 * Applies one replacement to one file, and fails loudly when the pattern no
 * longer matches. A version bump that silently skipped a file is exactly the
 * bug this script exists to prevent.
 */
function edit(path, description, pattern, replace) {
  const full = resolve(repoRoot, path)
  const before = readFileSync(full, 'utf8')
  const matches = before.match(pattern)
  if (!matches) {
    console.error(`${path}: could not find ${description}.`)
    console.error('The file has moved on without this script. Read it and fix the pattern.')
    process.exit(1)
  }
  const after = before.replace(pattern, replace)
  if (after === before) {
    changes.push(`unchanged  ${path}  ${description}`)
    return
  }
  if (!checkOnly) {
    writeFileSync(full, after)
  }
  const verb = checkOnly ? 'would set' : 'set      '
  changes.push(`${verb}  ${path}  ${description}: ${matches[0].trim()} -> ${after.match(pattern)[0].trim()}`)
}

/**
 * Mirrors the version into `package-lock.json`'s own record of it: the root
 * document's `name`/`version`, and the `version` field of every workspace
 * entry this script also edits directly. It is parsed and rewritten as JSON
 * rather than patched with a regex — the lockfile repeats the string
 * `"version"` dozens of times for third-party dependencies the exact same
 * indentation as these entries, so a text pattern that is unique enough to
 * be safe is more fragile than just editing the object. `JSON.stringify(...,
 * null, 2) + '\n'` reproduces npm's own formatting byte-for-byte when
 * nothing else in the file changes, which is what keeps the diff to version
 * fields only.
 *
 * The workspaces intentionally left out here — `fake-gateway`,
 * `gateway-client`, `transcript`, `hermes-shared` — stay at `0.0.0` in both
 * their package.json and the lock; nothing should ever write to them.
 */
function editLockVersions(path, entries) {
  const full = resolve(repoRoot, path)
  const before = readFileSync(full, 'utf8')
  const lock = JSON.parse(before)

  for (const { label, get } of entries) {
    const node = get(lock)
    if (!node || typeof node.version !== 'string') {
      console.error(`${path}: could not find a "version" field for ${label}.`)
      console.error('The lockfile has moved on without this script. Read it and fix the accessor.')
      process.exit(1)
    }
    const from = node.version
    if (from === version) {
      changes.push(`unchanged  ${path}  ${label}`)
      continue
    }
    node.version = version
    const verb = checkOnly ? 'would set' : 'set      '
    changes.push(`${verb}  ${path}  ${label}: "${from}" -> "${version}"`)
  }

  if (!checkOnly) {
    writeFileSync(full, JSON.stringify(lock, null, 2) + '\n')
  }
}

if (version) {
  edit('package.json', 'the version field', /"version":\s*"[^"]+"/, `"version": "${version}"`)
  edit('expo/hermie/package.json', 'the version field', /"version":\s*"[^"]+"/, `"version": "${version}"`)
  edit('expo/hermie/app.config.ts', 'the Expo version', /version:\s*'[^']+'/, `version: '${version}'`)
  edit('apps/desktop/package.json', 'the version field', /"version":\s*"[^"]+"/, `"version": "${version}"`)
  edit('apps/desktop/src-tauri/tauri.conf.json', 'the version field', /"version":\s*"[^"]+"/, `"version": "${version}"`)
  edit('apps/desktop/src-tauri/Cargo.toml', 'the package version', /^version = "[^"]+"/m, `version = "${version}"`)
  edit(
    'apps/desktop/src-tauri/Cargo.lock',
    'the hermie-desktop package entry',
    /(?<=^\[\[package\]\]\nname = "hermie-desktop"\n)version = "[^"]+"/m,
    `version = "${version}"`
  )
  edit('packages/hermie-web/package.json', 'the version field', /"version":\s*"[^"]+"/, `"version": "${version}"`)

  editLockVersions('package-lock.json', [
    { label: 'the root document version', get: lock => lock },
    { label: 'packages[""] (the root workspace)', get: lock => lock.packages?.[''] },
    { label: 'packages["expo/hermie"]', get: lock => lock.packages?.['expo/hermie'] },
    { label: 'packages["apps/desktop"]', get: lock => lock.packages?.['apps/desktop'] },
    { label: 'packages["packages/hermie-web"]', get: lock => lock.packages?.['packages/hermie-web'] }
  ])
}

if (nativeVersion) {
  edit(
    NATIVE_VERSION_FILE,
    'MARKETING_VERSION (the native line)',
    NATIVE_VERSION_PATTERN,
    `MARKETING_VERSION = ${nativeVersion}`
  )
} else {
  changes.push(`separate   ${NATIVE_VERSION_FILE}  MARKETING_VERSION (the native line) stays ${currentNative}; --native <version> sets it`) // prettier-ignore
}
changes.push(`rule       ${NATIVE_VERSION_FILE}  native ${nativeAfter} >= expo ${expoVersion}`)

for (const change of changes) {
  console.log(change)
}

console.log('')
if (version) {
  console.log(`Next: put a [${version}] section in CHANGELOG.md, commit, and tag v${version}.`)
  console.log(`      node scripts/changelog-section.mjs ${version}   # what the release notes will say`)
} else {
  console.log(`Next: commit, then archive the native apps with native/apple/scripts/archive.sh.`)
}
console.log(`      ${relative(process.cwd(), resolve(repoRoot, 'docs/release.md'))} is the rest of it.`)
