#!/usr/bin/env node
// Verifies the byte-identical copies under contract/ against their SHA256SUMS.
//
//   npm run contract:check
//
// For every directory under contract/ that has a SHA256SUMS file, every listed
// file must exist and hash to the listed sha256, and every file in that
// directory tree must be listed (SHA256SUMS itself excepted). A change to a
// copy, a missing file or a stray file fails, with the offending path named.
// Nothing is written. Directories without a SHA256SUMS are left alone.

import { createHash } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const contractRoot = join(repoRoot, 'contract')
const SUMS = 'SHA256SUMS'

/** Every directory at or below `dir` that holds a SHA256SUMS file. */
async function sumDirectories(dir) {
  const entries = await readdir(dir, { withFileTypes: true })
  const found = entries.some(entry => entry.isFile() && entry.name === SUMS) ? [dir] : []

  for (const entry of entries) {
    if (entry.isDirectory()) {
      found.push(...(await sumDirectories(join(dir, entry.name))))
    }
  }

  return found
}

/** Every file below `dir`, as posix paths relative to it. */
async function filesBelow(dir, prefix = '') {
  const files = []

  for (const entry of await readdir(join(dir, prefix), { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name

    if (entry.isDirectory()) {
      files.push(...(await filesBelow(dir, rel)))
    } else {
      files.push(rel)
    }
  }

  return files
}

/** Parses `<64 hex>  <path>` lines (shasum's text and binary forms). */
function parseSums(text, label) {
  const listed = new Map()
  const problems = []

  text.split('\n').forEach((line, index) => {
    if (line.trim() === '') {
      return
    }

    const match = /^([0-9a-f]{64}) [ *](.+)$/.exec(line)

    if (!match) {
      problems.push(`${label}:${index + 1}: not a "<sha256>  <path>" line`)

      return
    }

    listed.set(match[2], match[1])
  })

  return { listed, problems }
}

const problems = []
const directories = await sumDirectories(contractRoot)

if (directories.length === 0) {
  problems.push(`no directory under contract/ has a ${SUMS}`)
}

let checked = 0

for (const dir of directories) {
  const name = relative(repoRoot, dir).split(sep).join('/')
  const { listed, problems: parseProblems } = parseSums(await readFile(join(dir, SUMS), 'utf8'), `${name}/${SUMS}`)

  problems.push(...parseProblems)

  for (const [path, expected] of listed) {
    let bytes

    try {
      bytes = await readFile(join(dir, path))
    } catch {
      problems.push(`${name}/${path}: listed in ${SUMS} but missing`)

      continue
    }

    checked += 1

    const actual = createHash('sha256').update(bytes).digest('hex')

    if (actual !== expected) {
      problems.push(`${name}/${path}: drifted (expected sha256 ${expected}, found ${actual})`)
    }
  }

  for (const path of await filesBelow(dir)) {
    if (path !== SUMS && !listed.has(path)) {
      problems.push(`${name}/${path}: present but not listed in ${SUMS}`)
    }
  }
}

if (problems.length > 0) {
  console.error('contract:check failed:')

  for (const problem of problems) {
    console.error(`  - ${problem}`)
  }

  console.error(
    '\nThese directories are byte-identical copies of the fork. Do not edit them by hand: refresh them from the fork (and its SHA256SUMS), then run this check again.'
  )
  process.exit(1)
}

console.log(`contract:check: ${checked} files in ${directories.length} directories match their ${SUMS}.`)
