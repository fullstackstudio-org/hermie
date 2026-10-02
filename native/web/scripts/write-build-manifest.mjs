#!/usr/bin/env node
// Writes `build.json` into the build output: the source commit and a SHA-256 and
// size for every file. The plugin imports the output together with this file and
// refuses to advertise the client when a byte differs; its CI rebuilds the named
// commit and compares.
//
//   node scripts/write-build-manifest.mjs [<dist directory>]      (default: dist)
//
// The file is canonical: keys sorted, two-space indent, trailing newline, and no
// timestamp, so the same sources give the same bytes. `build.json` does not list
// itself.

import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import { hasUncommittedChanges, resolveSourceCommit } from './source-commit.mjs'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

export const MANIFEST_NAME = 'build.json'

/**
 * Every file under `dir`, as POSIX paths relative to it, sorted.
 *
 * @param {string} dir
 * @returns {string[]}
 */
function listFiles(dir) {
  const found = []

  const walk = current => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name)
      if (entry.isDirectory()) {
        walk(path)
      } else {
        found.push(relative(dir, path).split(sep).join('/'))
      }
    }
  }
  walk(dir)

  return found.sort()
}

/**
 * `owner/name` of the repository this client is built from, from the
 * `repository` field of its package.json (a GitHub URL).
 *
 * @param {{ repository?: { url?: string } | string }} packageJson
 * @returns {string}
 */
function sourceRepoOf(packageJson) {
  const url = typeof packageJson.repository === 'string' ? packageJson.repository : packageJson.repository?.url
  const match = /github\.com[/:]([^/]+\/[^/]+?)(?:\.git)?$/.exec(url ?? '')

  if (!match?.[1]) {
    throw new Error('package.json needs a "repository" field naming the GitHub repository')
  }
  return match[1]
}

/**
 * The manifest object for the files in `dir`.
 *
 * @param {string} dir
 * @param {{ commit: string, packageJson: { name?: string, version: string, repository?: { url?: string } | string } }} options
 */
export function buildManifest(dir, { commit, packageJson }) {
  /** @type {Record<string, { sha256: string, bytes: number }>} */
  const files = {}
  let totalBytes = 0

  for (const name of listFiles(dir)) {
    if (name === MANIFEST_NAME) {
      continue
    }
    const bytes = readFileSync(join(dir, name))
    files[name] = { sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length }
    totalBytes += bytes.length
  }

  return {
    v: 1,
    name: 'hermie-web-client',
    version: packageJson.version,
    sourceRepo: sourceRepoOf(packageJson),
    sourceCommit: commit,
    files,
    totalBytes
  }
}

/**
 * The canonical text of a manifest: sorted keys at every level, two-space
 * indent, one trailing newline.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function serialiseManifest(value) {
  const sorted = input => {
    if (Array.isArray(input)) {
      return input.map(sorted)
    }
    if (input && typeof input === 'object') {
      return Object.fromEntries(
        Object.keys(input)
          .sort()
          .map(key => [key, sorted(input[key])])
      )
    }
    return input
  }
  return `${JSON.stringify(sorted(value), null, 2)}\n`
}

// `realpathSync`: a build directory can sit behind a symbolic link (macOS's
// temporary directory does), and a script that decides it was imported rather
// than run writes nothing.
const invokedDirectly =
  process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)

if (invokedDirectly) {
  const dir = resolve(process.cwd(), process.argv[2] ?? join(packageRoot, 'dist'))
  const packageJson = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'))
  const commit = resolveSourceCommit()

  if (hasUncommittedChanges()) {
    console.warn(
      `write-build-manifest: the working tree has uncommitted changes, so ${MANIFEST_NAME} names commit ${commit.slice(0, 12)} ` +
        'for files that were not built from it. Do not import this build.'
    )
  }

  const manifest = buildManifest(dir, { commit, packageJson })
  writeFileSync(join(dir, MANIFEST_NAME), serialiseManifest(manifest))

  console.log(
    `write-build-manifest: ${Object.keys(manifest.files).length} files, ${manifest.totalBytes} bytes, commit ${commit.slice(0, 12)}`
  )
}
