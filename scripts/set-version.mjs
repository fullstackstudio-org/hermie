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
 * Run it from a clean tree, read the diff, then tag. docs/release.md is the
 * surrounding process.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const checkOnly = args.includes('--check')
const version = args.find(argument => !argument.startsWith('--'))

if (!version || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error('usage: node scripts/set-version.mjs <major.minor.patch> [--check]')
  process.exit(2)
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

edit('package.json', 'the version field', /"version":\s*"[^"]+"/, `"version": "${version}"`)
edit('expo/hermie/package.json', 'the version field', /"version":\s*"[^"]+"/, `"version": "${version}"`)
edit('expo/hermie/app.config.ts', 'the Expo version', /version:\s*'[^']+'/, `version: '${version}'`)
edit('apps/desktop/package.json', 'the version field', /"version":\s*"[^"]+"/, `"version": "${version}"`)
edit('apps/desktop/src-tauri/tauri.conf.json', 'the version field', /"version":\s*"[^"]+"/, `"version": "${version}"`)
edit('apps/desktop/src-tauri/Cargo.toml', 'the package version', /^version = "[^"]+"/m, `version = "${version}"`)
edit('packages/hermie-web/package.json', 'the version field', /"version":\s*"[^"]+"/, `"version": "${version}"`)

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

editLockVersions('package-lock.json', [
  { label: 'the root document version', get: lock => lock },
  { label: 'packages[""] (the root workspace)', get: lock => lock.packages?.[''] },
  { label: 'packages["expo/hermie"]', get: lock => lock.packages?.['expo/hermie'] },
  { label: 'packages["apps/desktop"]', get: lock => lock.packages?.['apps/desktop'] },
  { label: 'packages["packages/hermie-web"]', get: lock => lock.packages?.['packages/hermie-web'] }
])

for (const change of changes) {
  console.log(change)
}

console.log('')
console.log(`Next: put a [${version}] section in CHANGELOG.md, commit, and tag v${version}.`)
console.log(`      node scripts/changelog-section.mjs ${version}   # what the release notes will say`)
console.log(`      ${relative(process.cwd(), resolve(repoRoot, 'docs/release.md'))} is the rest of it.`)
