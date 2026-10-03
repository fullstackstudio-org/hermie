#!/usr/bin/env node
// Runs Hermes's own plugin scanner over a build of the web client, the way the
// plugin repository's `guard-scan` job runs it over the tree the build is
// imported into (decision W3 of the web client plan).
//
//   node scripts/web/guard-scan.mjs [<dist directory>] [--pins <file>] [--workdir <dir>]
//                                   [--scanner-root NAME=DIR]... [--python <executable>]
//
// `GUARD_SCAN_PYTHON` names the interpreter (default `python3`; the scanner's own
// annotations need 3.10 or newer). `GUARD_SCAN_RETRY_DELAY_MS` is the pause between
// the three tries of a fetch (default 5000).
//
// Why here as well: the plugin's job blocks an import, but an import is a pull
// request in another repository, and a finding that only shows up there (the
// first one was `role_hijack` on an ordinary English sentence) costs a round
// trip through two repositories. The bundle is scanned where it is built.
//
// What it does, and the rules it holds to:
//   - It fetches `tools/` of each scanner named in `scanner-pins.json` (the fork
//     the gateways run and upstream, which the fork tracks) at the 40-character
//     commit pinned there. A branch or a tag cannot stand in for a pin, and a
//     server that answers with another commit is an error, not a scan.
//   - It lays the build into a synthetic plugin tree, `plugin.yaml` plus the
//     build under `dashboard/app/`, which is where the plugin carries it, so the
//     scanner sees the paths it sees on an install.
//   - It calls `scan_plugin` and `should_allow_plugin_install` in a fresh
//     `python -I -B` child per scanner (the two define the same package name),
//     and passes only on a `safe` verdict the install would allow outright.
//     `caution` fails too. There is no policy of its own and no threshold.
//   - A gate that cannot run must not pass: a scanner that cannot be fetched or
//     imported, that prints no result, a directory that is not a build, and a
//     configuration with no scanner all exit non-zero.
//   - The scanner's report quotes lines of the tree under test, so every line
//     of it is made harmless before it reaches a CI log (`safeText`).
//
// `--scanner-root NAME=DIR` uses a checkout you already have (it must hold
// `tools/plugin_guard.py`) instead of the pins, for a local run.
//
// Exit status: 0 when every scanner says `safe`; 1 when any does not, or one
// could not be fetched or run; 2 for a command line or a directory that makes
// no sense.

import { spawnSync } from 'node:child_process'
import {
  appendFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

export const RESULT_PREFIX = 'GUARD_SCAN_RESULT '
export const PINS_DEFAULT = join(here, 'scanner-pins.json')
export const RUNNER = join(here, 'guard-scan-run.py')
export const DIST_DEFAULT = resolve(here, '../../native/web/dist')

const SHA = /^[0-9a-f]{40}$/u
const NAME = /^[a-z][a-z0-9-]*$/u
/** What the scanner itself never reads (`tools/plugin_guard.py::EXCLUDED_DIRS`); used to count, never to decide. */
const SCANNER_EXCLUDED_DIRS = new Set([
  '.git',
  '__pycache__',
  'node_modules',
  '.venv',
  'venv',
  '.mypy_cache',
  '.pytest_cache',
  '.ruff_cache',
  '.tox'
])
/** A fetch of `tools/` takes seconds; one that stalls is cut after twenty seconds without data and tried again. */
const GIT_TIMEOUT_MS = 90_000
const GIT_STALL = ['-c', 'http.lowSpeedLimit=1000', '-c', 'http.lowSpeedTime=20']
const SCAN_TIMEOUT_MS = 300_000
const REPORT_LINE_LIMIT = 200

/** The plugin manifest the synthetic tree carries: what the scanner needs of a plugin, and nothing it would judge. */
export const PLUGIN_MANIFEST = `name: hermie
manifest_version: 1
version: 0.0.0
description: A build of the Hermie web client laid into a plugin tree so the Hermes plugin scanner can read it.
kind: standalone
`

/** A scanner could not be obtained or run. The gate fails; it never skips. */
export class GuardError extends Error {
  constructor(message) {
    super(message)
    this.name = 'GuardError'
  }
}

/** @typedef {{ name: string, root: string, repo?: string, commit?: string }} Source */

// ---------------------------------------------------------------------------
// Getting the scanner
// ---------------------------------------------------------------------------

/** One `{ name, repo, ref }` per scanner in the pin file; every `ref` is a full lower-case commit. */
export function loadPins(path) {
  let data

  try {
    data = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    throw new GuardError(`cannot read the scanner pins at ${path}: ${error instanceof Error ? error.message : error}`)
  }

  const scanners = data?.scanners

  if (typeof scanners !== 'object' || scanners === null || Object.keys(scanners).length === 0) {
    throw new GuardError(`${path} has no 'scanners' object`)
  }

  return Object.entries(scanners).map(([name, entry]) => {
    if (!NAME.test(name)) {
      throw new GuardError(`scanner name '${name}' must be lower-case letters, digits and dashes`)
    }

    if (typeof entry !== 'object' || entry === null) {
      throw new GuardError(`scanner '${name}' must be an object`)
    }

    if (typeof entry.repo !== 'string' || !entry.repo.startsWith('https://')) {
      throw new GuardError(`scanner '${name}': 'repo' must be an https:// URL`)
    }

    if (typeof entry.commit !== 'string' || !SHA.test(entry.commit)) {
      throw new GuardError(`scanner '${name}': 'commit' must be a full 40-character lower-case SHA`)
    }

    return { name, repo: entry.repo, ref: entry.commit }
  })
}

function git(args, cwd) {
  const done = spawnSync('git', [...GIT_STALL, ...args], {
    cwd,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    encoding: 'utf8',
    timeout: GIT_TIMEOUT_MS
  })

  if (done.error || done.status !== 0) {
    const detail = done.error ? String(done.error.message) : (done.stderr || done.stdout).trim().slice(-400)

    throw new GuardError(`git ${args.slice(0, 2).join(' ')} failed: ${detail}`)
  }

  return done.stdout.trim()
}

const sleep = ms => new Promise(settle => setTimeout(settle, ms))

/** Make `dest` an empty directory. Only one this script made (it holds a `.git`) is cleared; anything else is refused. */
export function prepareDest(dest) {
  if (existsSync(dest) && readdirSync(dest).length > 0) {
    if (!existsSync(join(dest, '.git'))) {
      throw new GuardError(`${dest} is not empty and is not a previous scanner checkout; refusing to clear it`)
    }

    rmSync(dest, { recursive: true, force: true })
  }

  mkdirSync(dest, { recursive: true })
}

/**
 * Fetch `tools/` of `repo` at `ref` into `dest`: a shallow, blob-less, sparse
 * fetch, a few megabytes and a few seconds. The commit that was checked out is
 * compared with the one asked for.
 *
 * @returns {Promise<Source>}
 */
export async function fetchScanner({ name, repo, ref }, dest, { attempts = 3, delayMs = 5000 } = {}) {
  prepareDest(dest)
  git(['init', '-q', '.'], dest)
  git(['remote', 'add', 'origin', repo], dest)
  git(['sparse-checkout', 'set', '--cone', 'tools'], dest)

  // The checkout is inside the retry as well: with a blob-less fetch it is the step that downloads the files.
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      git(['fetch', '-q', '--depth', '1', '--filter=blob:none', 'origin', ref], dest)
      git(['checkout', '-q', '-f', '--detach', 'FETCH_HEAD'], dest)
      break
    } catch (error) {
      if (attempt === attempts) {
        throw error
      }

      await sleep(delayMs)
    }
  }

  const commit = git(['rev-parse', 'HEAD'], dest)

  if (SHA.test(ref) && commit !== ref) {
    throw new GuardError(`${name}: asked for ${ref} and got ${commit}`)
  }

  if (!existsSync(join(dest, 'tools', 'plugin_guard.py'))) {
    throw new GuardError(`${name}: ${repo} at ${commit.slice(0, 12)} has no tools/plugin_guard.py`)
  }

  return { name, root: dest, repo, commit }
}

/** `--scanner-root NAME=DIR` values as sources. */
export function parseScannerRoots(values) {
  return values.map(value => {
    const at = value.indexOf('=')
    const name = at < 0 ? '' : value.slice(0, at)
    const directory = at < 0 ? '' : value.slice(at + 1)

    if (!NAME.test(name) || directory === '') {
      throw new GuardError(`--scanner-root wants NAME=DIR, got '${value}'`)
    }

    const root = resolve(directory)

    if (!existsSync(join(root, 'tools', 'plugin_guard.py'))) {
      throw new GuardError(`${root} has no tools/plugin_guard.py`)
    }

    return { name, root }
  })
}

// ---------------------------------------------------------------------------
// The tree being scanned
// ---------------------------------------------------------------------------

/** Every file under `dir` the scanner would read (it skips its own excluded directory names). */
function scannedFiles(dir) {
  let count = 0

  const walk = current => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (SCANNER_EXCLUDED_DIRS.has(entry.name)) {
        continue
      }

      const path = join(current, entry.name)

      if (entry.isDirectory()) {
        walk(path)
      } else {
        count += 1
      }
    }
  }

  walk(dir)

  return count
}

/**
 * Refuse a directory that is not a build of the client; return how many files the
 * scanner will see in it. `scan_plugin` answers "clean scan" for a path that does
 * not exist and for an empty one, and a gate pointed at the wrong directory must
 * not pass.
 */
export function checkDist(dist) {
  if (!existsSync(dist) || !lstatSync(dist).isDirectory()) {
    throw new GuardError(`${dist} is not a directory; build the client first (npm run client:build)`)
  }

  for (const required of ['index.html', 'build.json']) {
    if (!existsSync(join(dist, required))) {
      throw new GuardError(`${dist} has no ${required}: this is not a build of the web client`)
    }
  }

  const count = scannedFiles(dist)

  if (count < 3) {
    throw new GuardError(`${dist} holds ${count} file(s) the scanner would read; that cannot be a build`)
  }

  return count
}

/**
 * The tree the scanner is given: `<parent>/plugin/plugin.yaml` and the build
 * copied (not linked, the scanner skips links) to `<parent>/plugin/dashboard/app/`.
 */
export function buildPluginTree(dist, parent) {
  const tree = join(parent, 'plugin')
  const app = join(tree, 'dashboard', 'app')

  mkdirSync(app, { recursive: true })
  writeFileSync(join(tree, 'plugin.yaml'), PLUGIN_MANIFEST)
  cpSync(dist, app, { recursive: true })

  return tree
}

// ---------------------------------------------------------------------------
// One scanner, in its own interpreter
// ---------------------------------------------------------------------------

/**
 * Run one scanner in a child process and return its parsed result plus its report.
 *
 * `python -I` ignores `PYTHON*` variables and the user's site directory, and the
 * child puts the scanner root first on `sys.path` and checks the module's file.
 */
export function scanWith(source, tree, python = 'python3') {
  const done = spawnSync(python, ['-I', '-B', RUNNER, source.root, tree], {
    encoding: 'utf8',
    timeout: SCAN_TIMEOUT_MS,
    maxBuffer: 64 * 1024 * 1024
  })

  if (done.error) {
    throw new GuardError(`${source.name}: the scanner could not be run: ${done.error.message}`)
  }

  let payload = null
  const report = []

  for (const line of (done.stdout ?? '').split('\n')) {
    if (line.startsWith(RESULT_PREFIX)) {
      try {
        payload = JSON.parse(line.slice(RESULT_PREFIX.length))
      } catch {
        payload = null
      }
    } else {
      report.push(line)
    }
  }

  if (payload === null) {
    const detail = ((done.stderr ?? '') || (done.stdout ?? '')).trim().slice(-600)

    throw new GuardError(`${source.name}: the scanner produced no result (exit ${done.status}): ${detail}`)
  }

  return { ...payload, report: report.join('\n').trimEnd(), exit: done.status }
}

/** The whole gate: Hermes says `safe`, allows it outright, and the child agrees. */
export function passes(result) {
  return result.verdict === 'safe' && result.allowed === true && result.exit === 0
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

/**
 * Make scanner output and error text harmless in a CI log. The report quotes
 * lines of the tree under test. Every line is indented behind a marker, so a
 * line cannot begin with a workflow command; the two command spellings are also
 * broken wherever they appear, and control characters (escape sequences
 * included) become question marks.
 */
export function safeText(text) {
  const cleaned = [...text]
    .map(char => {
      const code = char.codePointAt(0) ?? 0

      return char === '\n' || (code >= 0x20 && code !== 0x7f && !(code >= 0x80 && code <= 0x9f)) ? char : '?'
    })
    .join('')
    .replaceAll('::', ': :')
    .replaceAll('##[', '# #[')

  return cleaned
    .split('\n')
    .map(line => `| ${line}`)
    .join('\n')
}

const oneLine = text => safeText(text).replaceAll('|', '/').split(/\s+/u).join(' ').trim().slice(0, 200)

function severityCounts(findings) {
  const counts = new Map()

  for (const finding of findings) {
    counts.set(finding.severity, (counts.get(finding.severity) ?? 0) + 1)
  }

  const order = ['critical', 'high', 'medium', 'low']
  const parts = [
    ...order.filter(severity => counts.has(severity)).map(severity => `${counts.get(severity)} ${severity}`),
    ...[...counts.entries()]
      .filter(([severity]) => !order.includes(severity))
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([severity, count]) => `${count} ${severity}`)
  ]

  return parts.length > 0 ? parts.join(', ') : 'none'
}

function printResult(source, result, log) {
  const where = source.commit ? `${source.repo} @ ${source.commit.slice(0, 12)}` : source.root

  log(`\n=== scanner: ${source.name} (${where}), ${result.scanner_version}  ->  ${passes(result) ? 'PASS' : 'FAIL'}`)

  const report = safeText(result.report).split('\n')

  for (const line of report.slice(0, REPORT_LINE_LIMIT)) {
    log(line)
  }

  if (report.length > REPORT_LINE_LIMIT) {
    log(`| ... ${report.length - REPORT_LINE_LIMIT} more line(s) not shown`)
  }

  log(`verdict ${result.verdict}; findings: ${severityCounts(result.findings)}`)
}

function writeSummary(rows, files, env) {
  const target = env.GITHUB_STEP_SUMMARY

  if (!target) {
    return
  }

  const lines = [
    '### Plugin scanner, on the web client build',
    '',
    `${files} file(s) in the build. Passes only on a verdict of \`safe\`.`,
    '',
    '| Scanner | Commit | Version | Verdict | Findings |',
    '|---|---|---|---|---|'
  ]

  for (const { source, result, error } of rows) {
    const commit = source.commit ? `\`${source.commit.slice(0, 12)}\`` : 'local'

    if (result === null) {
      lines.push(`| ${source.name} | ${commit} | - | could not run | ${oneLine(error)} |`)
    } else {
      const verdict = result.verdict + (passes(result) ? '' : ' (fails)')

      lines.push(
        `| ${source.name} | ${commit} | ${result.scanner_version} | ${verdict} | ${severityCounts(result.findings)} |`
      )
    }
  }

  try {
    appendFileSync(target, `${lines.join('\n')}\n`)
  } catch {
    // A summary is a courtesy; the log has everything.
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

function parseArgs(argv, env) {
  const options = {
    dist: DIST_DEFAULT,
    pins: PINS_DEFAULT,
    pinsGiven: false,
    workdir: '',
    python: env.GUARD_SCAN_PYTHON || 'python3',
    roots: []
  }
  let positional = false

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    const value = () => {
      index += 1

      if (argv[index] === undefined) {
        throw new GuardError(`${arg} wants a value`)
      }

      return argv[index]
    }

    if (arg === '--pins') {
      options.pins = resolve(value())
      options.pinsGiven = true
    } else if (arg === '--workdir') {
      options.workdir = resolve(value())
    } else if (arg === '--python') {
      options.python = value()
    } else if (arg === '--scanner-root') {
      options.roots.push(value())
    } else if (arg.startsWith('-')) {
      throw new GuardError(`unknown option ${arg}`)
    } else if (positional) {
      throw new GuardError('one directory at most')
    } else {
      positional = true
      options.dist = resolve(arg)
    }
  }

  return options
}

/**
 * The command. `log` and `errorLog` are where its lines go, so a test can read
 * them. Returns the exit status instead of exiting.
 */
export async function main(argv, { log = console.log, errorLog = console.error, env = process.env } = {}) {
  let options
  let files
  let sources

  try {
    options = parseArgs(argv, env)
    files = checkDist(options.dist)
    sources = parseScannerRoots(options.roots)
  } catch (error) {
    errorLog(safeText(`guard-scan: ${error instanceof Error ? error.message : error}`))

    return 2
  }

  // Pins are read unless every scanner was named on the command line (and no pin file was named too).
  let pins = []

  try {
    if (sources.length === 0 || options.pinsGiven) {
      pins = loadPins(options.pins)
    }
  } catch (error) {
    errorLog(safeText(`guard-scan: ${error instanceof Error ? error.message : error}`))

    return 2
  }

  const scratch = mkdtempSync(join(tmpdir(), 'guard-scan-'))
  const workdir = options.workdir || join(scratch, 'scanners')

  // A scratch directory is never inside the tree it scans nor the other way round.
  if (workdir === options.dist || workdir.startsWith(options.dist + sep) || options.dist.startsWith(workdir + sep)) {
    errorLog('guard-scan: the scanner workdir and the build must not contain one another')
    rmSync(scratch, { recursive: true, force: true })

    return 2
  }

  const rows = []
  const retryDelayMs = Number(env.GUARD_SCAN_RETRY_DELAY_MS ?? 5000)
  let failed = false

  try {
    const tree = buildPluginTree(options.dist, scratch)

    log(`scanning ${options.dist} as dashboard/app of a plugin tree (${files} file(s) the scanner will read)`)

    for (const pin of pins) {
      try {
        sources.push(await fetchScanner(pin, join(workdir, pin.name), { delayMs: retryDelayMs }))
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)

        log(`\n=== scanner: ${pin.name}  ->  FAIL\n${safeText(`could not fetch it: ${message}`)}`)
        rows.push({
          source: { name: pin.name, root: join(workdir, pin.name), repo: pin.repo },
          result: null,
          error: message
        })
        failed = true
      }
    }

    for (const source of sources) {
      try {
        const result = scanWith(source, tree, options.python)

        printResult(source, result, log)
        rows.push({ source, result, error: '' })
        failed = failed || !passes(result)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)

        log(`\n=== scanner: ${source.name}  ->  FAIL\n${safeText(message)}`)
        rows.push({ source, result: null, error: message })
        failed = true
      }
    }

    if (rows.length === 0) {
      log('\nguard-scan: no scanner was configured, so nothing was checked')
      failed = true
    }

    writeSummary(rows, files, env)
    log(
      `\nguard-scan: ${failed ? 'FAILED: the plugin would not install or update as `safe`' : 'every scanner says safe'}`
    )
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }

  return failed ? 1 : 0
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2))
}
