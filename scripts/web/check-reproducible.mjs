#!/usr/bin/env node
// Proves the web client builds to the same bytes every time. The plugin's CI
// rebuilds the commit named in `build.json` on another machine, in another
// directory, and compares every file; a build that is not reproducible cannot
// pass that, so this is what keeps it honest here.
//
//   node scripts/web/check-reproducible.mjs                    two clean builds of this tree
//   node scripts/web/check-reproducible.mjs --fresh-checkout   ... and one more from `git archive HEAD`,
//                                                              unpacked into another directory, with its
//                                                              own `npm ci` (needs a clean tree)
//
// Each build writes into its own empty temporary directory, with a different
// time zone and locale, and `build.json` and every file in it are compared byte
// for byte. Exits 1 and names the files that differ.

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

/**
 * Every file under `dir` mapped to its SHA-256.
 *
 * @param {string} dir
 * @returns {Map<string, string>}
 */
function digestTree(dir) {
  const digests = new Map()

  const walk = current => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name)
      if (entry.isDirectory()) {
        walk(path)
      } else {
        digests.set(
          relative(dir, path).split(sep).join('/'),
          createHash('sha256').update(readFileSync(path)).digest('hex')
        )
      }
    }
  }
  walk(dir)

  return digests
}

/**
 * What differs between two builds.
 *
 * @param {Map<string, string>} first
 * @param {Map<string, string>} second
 * @returns {string[]}
 */
export function differences(first, second) {
  const found = []

  for (const [name, digest] of first) {
    if (!second.has(name)) {
      found.push(`${name}: only in the first build`)
    } else if (second.get(name) !== digest) {
      found.push(`${name}: bytes differ`)
    }
  }
  for (const name of second.keys()) {
    if (!first.has(name)) {
      found.push(`${name}: only in the second build`)
    }
  }
  return found.sort()
}

function run(command, args, { cwd, env = {} }) {
  const result = spawnSync(command, args, {
    cwd,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8'
  })

  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed in ${cwd}\n${result.stdout}${result.stderr}`)
  }
  return result.stdout.trim()
}

/**
 * One clean build of the client rooted at `root`, written to `outDir`.
 *
 * @param {{ root: string, outDir: string, commit: string, env: Record<string, string> }} options
 */
function build({ root, outDir, commit, env }) {
  const client = join(root, 'native', 'web')
  const vite = join(dirname(createRequire(join(client, 'package.json')).resolve('vite/package.json')), 'bin', 'vite.js')

  rmSync(outDir, { recursive: true, force: true })
  mkdirSync(dirname(outDir), { recursive: true })

  const buildEnv = { HERMIE_SOURCE_COMMIT: commit, ...env }
  run(process.execPath, [vite, 'build', '--outDir', outDir, '--emptyOutDir', '--logLevel', 'error'], {
    cwd: client,
    env: buildEnv
  })
  run(process.execPath, [join(client, 'scripts', 'write-build-manifest.mjs'), outDir], { cwd: client, env: buildEnv })

  const digests = digestTree(outDir)
  if (!digests.has('build.json')) {
    throw new Error(`the build in ${root} wrote no build.json`)
  }
  return digests
}

function main(argv) {
  const freshCheckout = argv.includes('--fresh-checkout')
  const commit = run('git', ['rev-parse', 'HEAD'], { cwd: repoRoot })
  const scratch = mkdtempSync(join(tmpdir(), 'hermie-reproducible-'))
  const builds = []

  try {
    console.log(`check-reproducible: commit ${commit.slice(0, 12)}, node ${process.version}`)

    builds.push({
      label: 'this tree, build 1 (TZ=UTC, LC_ALL=C)',
      digests: build({
        root: repoRoot,
        outDir: join(scratch, 'one', 'dist'),
        commit,
        env: { TZ: 'UTC', LC_ALL: 'C', LANG: 'C' }
      })
    })
    builds.push({
      label: 'this tree, build 2 (TZ=Pacific/Kiritimati, LC_ALL=de_DE.UTF-8)',
      digests: build({
        root: repoRoot,
        outDir: join(scratch, 'two', 'dist'),
        commit,
        env: { TZ: 'Pacific/Kiritimati', LC_ALL: 'de_DE.UTF-8', LANG: 'de_DE.UTF-8' }
      })
    })

    if (freshCheckout) {
      if (run('git', ['status', '--porcelain'], { cwd: repoRoot }) !== '') {
        throw new Error('--fresh-checkout builds the committed tree; commit or stash your changes first')
      }

      const copy = join(scratch, 'checkout', 'a-different-directory')
      mkdirSync(copy, { recursive: true })
      const archive = join(scratch, 'source.tar')
      run('git', ['archive', '--format=tar', '--output', archive, 'HEAD'], { cwd: repoRoot })
      run('tar', ['-xf', archive, '-C', copy], { cwd: scratch })

      // Only what the client needs; `--ignore-scripts` because the copy has no
      // `.git` for husky and nothing here needs a lifecycle script.
      run('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund', '--workspace', '@hermie/web-client'], {
        cwd: copy
      })

      builds.push({
        label: 'a fresh checkout in another directory, its own npm ci',
        digests: build({
          root: copy,
          outDir: join(scratch, 'three', 'dist'),
          commit,
          env: { TZ: 'America/St_Johns', LC_ALL: 'C', LANG: 'C' }
        })
      })
    }

    let different = false
    for (const [index, current] of builds.entries()) {
      console.log(
        `  ${current.label}: ${current.digests.size} files, build.json ${current.digests.get('build.json')?.slice(0, 16)}`
      )
      if (index === 0) {
        continue
      }
      const found = differences(builds[0].digests, current.digests)
      if (found.length > 0) {
        different = true
        console.error(`check-reproducible: ${current.label} differs from the first build:`)
        for (const line of found) {
          console.error(`  - ${line}`)
        }
      }
    }

    if (different) {
      process.exit(1)
    }
    console.log(`check-reproducible: ${builds.length} builds, every file identical`)
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

// `realpathSync`: a temporary directory can sit behind a symbolic link (macOS's
// does), and a script that decides it was imported rather than run does nothing.
if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2))
  } catch (error) {
    console.error(`check-reproducible: ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  }
}
