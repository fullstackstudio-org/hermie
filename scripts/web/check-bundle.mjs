#!/usr/bin/env node
// Gates a build of the web client (`native/web/dist`) before it is imported into
// the plugin. The client is served by the Hermes dashboard's own static route and
// the plugin tree it lands in is scanned on every install and update, so a build
// that breaks either's limits is not a build that can ship.
//
//   node scripts/web/check-bundle.mjs [<dist directory>] [--commit <sha>]
//
// Exits 1 and lists every problem when:
//   - a file has an extension the static route will not serve (and `.map`, which
//     the route allows but the plugin tree must not carry);
//   - a file is larger than 900 kB, or the bundle is larger than 3 MB or holds
//     more than 80 files;
//   - a `.js`, `.css`, `.html`, `.json`, `.mjs` or `.svg` file holds a non-ASCII
//     byte or a control character other than tab, newline and carriage return
//     (the scanner flags invisible characters; the build escapes instead);
//   - the code needed before the first screen (the entry and the chunks it
//     imports statically) is larger than 600 kB, or 190 kB gzipped;
//   - `index.html` carries inline script or style, an inline handler, no policy,
//     a policy that is not exactly REFERENCE_POLICY (a missing or extra
//     directive or source), or a script or link element before the policy;
//   - `build.json` is missing, malformed, not in canonical form, or does not
//     match the files (a changed byte, a missing file, an unlisted file);
//   - a text file carries the development-only marker: code from
//     `native/web/src/dev` (the transcript harness) reached the bundle.
//
// Sizes are decimal (1 kB = 1000 bytes), which is the stricter reading of the
// scanner's own 1 MB-per-file ceiling.

import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import { join, posix, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'

/**
 * What the dashboard's `/dashboard-plugins/<name>/<file>` route serves
 * (`serve_plugin_asset` in `hermes_cli/web_routers/dashboard_ui.py`). `.map` is
 * on the route's list and deliberately not on ours: see SOURCE_MAP_EXTENSION.
 */
export const ALLOWED_EXTENSIONS = Object.freeze([
  '.js',
  '.mjs',
  '.css',
  '.json',
  '.html',
  '.svg',
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.ico',
  '.woff2',
  '.woff',
  '.ttf',
  '.otf'
])

export const SOURCE_MAP_EXTENSION = '.map'

/** Files whose bytes the plugin scanner reads as text. */
export const TEXT_EXTENSIONS = Object.freeze(['.js', '.mjs', '.css', '.html', '.json', '.svg'])

export const LIMITS = Object.freeze({
  maxFileBytes: 900_000,
  maxTotalBytes: 3_000_000,
  maxFiles: 80,
  // The plan's budget is 700 kB / 230 kB (ADR 0030). The gate is held a little over what the first load weighs, so that
  // a change that puts a chunk's worth of code back into it fails at once instead of eating the plan's headroom
  // (one import of `interactive-frame` from the request layer once added 79 kB and still fitted). A change that has a
  // reason to weigh more raises this in the same commit, with the reason.
  maxInitialJsBytes: 600_000,
  maxInitialJsGzipBytes: 190_000
})

export const MANIFEST_NAME = 'build.json'

/**
 * Stamped by every development-only page (`native/web/src/dev`) into its own
 * document. Those pages are built only in `--mode harness`; finding the stamp
 * in a production build means one of them was imported by the client.
 */
export const DEVELOPMENT_ONLY_MARKER = 'hermie:development-only'

const SHA256 = /^[0-9a-f]{64}$/
const COMMIT = /^[0-9a-f]{40}$/
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/

/**
 * @param {string} dir
 * @returns {{ files: string[], problems: string[] }} every regular file below
 *   `dir` as sorted POSIX paths, and a problem for anything that is not one.
 */
function listBundle(dir) {
  const files = []
  const problems = []

  const walk = current => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name)
      const name = relative(dir, path).split(sep).join('/')

      if (entry.isSymbolicLink()) {
        problems.push(`${name}: is a symbolic link; the bundle holds regular files only`)
      } else if (entry.isDirectory()) {
        walk(path)
      } else if (entry.isFile()) {
        files.push(name)
      } else {
        problems.push(`${name}: is not a regular file`)
      }
    }
  }
  walk(dir)

  return { files: files.sort(), problems }
}

function extensionOf(name) {
  const base = posix.basename(name)
  const dot = base.lastIndexOf('.')
  return dot <= 0 ? '' : base.slice(dot).toLowerCase()
}

/** Tab, newline and carriage return are the only control bytes a text file may hold. */
const PLAIN_CONTROL = new Set([0x09, 0x0a, 0x0d])

function hasNonAscii(bytes) {
  for (const byte of bytes) {
    if (byte > 0x7e || (byte < 0x20 && !PLAIN_CONTROL.has(byte))) {
      return true
    }
  }
  return false
}

/** Attributes of one tag, lower-cased names. */
function attributesOf(source) {
  const attributes = new Map()
  for (const match of source.matchAll(/([A-Za-z_:][\w:.-]*)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g)) {
    attributes.set(match[1].toLowerCase(), match[2] ?? match[3] ?? match[4] ?? '')
  }
  return attributes
}

/**
 * The module files `index.html` loads and the files they import statically,
 * following imports from file to file. A dynamic `import()` is not followed:
 * what it loads is by definition not needed for the first screen.
 *
 * @param {string} html
 * @param {Map<string, Buffer>} contents bytes of every `.js` file, by bundle path
 * @returns {{ initial: string[], problems: string[] }}
 */
function initialScripts(html, contents) {
  const problems = []
  const roots = []

  for (const tag of html.matchAll(/<(script|link)\b([^>]*)>/gi)) {
    const attributes = attributesOf(tag[2] ?? '')
    const reference =
      tag[1]?.toLowerCase() === 'script' && attributes.get('type') === 'module'
        ? attributes.get('src')
        : tag[1]?.toLowerCase() === 'link' && attributes.get('rel') === 'modulepreload'
          ? attributes.get('href')
          : undefined

    if (reference) {
      roots.push(posix.normalize(reference))
    }
  }

  if (!/<script\b[^>]*\btype\s*=\s*["']?module["']?[^>]*\bsrc\s*=/i.test(html)) {
    problems.push('index.html: no module script to start the client')
  }

  const seen = new Set()
  const queue = [...roots]

  while (queue.length > 0) {
    const name = queue.shift()
    if (name === undefined || seen.has(name)) {
      continue
    }
    seen.add(name)

    const bytes = contents.get(name)
    if (!bytes) {
      problems.push(`index.html: loads ${name}, which is not in the bundle`)
      continue
    }

    const source = bytes.toString('utf8')
    const imports = [
      ...source.matchAll(/(?:^|[;}\s])import\s*["']([^"']+\.js)["']/g),
      ...source.matchAll(
        /(?:^|[;}\s])(?:import|export)\s*(?:[\w$]+\s*,?\s*)?(?:\*\s*(?:as\s+[\w$]+)?|\{[^}]*\})?\s*from\s*["']([^"']+\.js)["']/g
      )
    ]
    for (const match of imports) {
      const target = match[1]
      if (target?.startsWith('.')) {
        queue.push(posix.normalize(posix.join(posix.dirname(name), target)))
      }
    }
  }

  return { initial: [...seen].sort(), problems }
}

/**
 * The policy `native/web/index.html` carries: the plan's decision W6, plus
 * `trusted-types 'none'` so the page can create no Trusted Types policy to turn a
 * string into script. The document must carry exactly this set: a missing
 * directive, an extra one, or a source added to or removed from one is a
 * different policy and fails the gate. Change it here and in `index.html`
 * together, with the reason in the commit.
 */
export const REFERENCE_POLICY = Object.freeze({
  'default-src': ["'none'"],
  'script-src': ["'self'"],
  'style-src': ["'self'"],
  'img-src': ["'self'", 'data:', 'blob:'],
  'font-src': ["'self'"],
  'connect-src': ["'self'"],
  'worker-src': ["'self'"],
  'manifest-src': ["'self'"],
  'media-src': ["'self'", 'blob:'],
  'base-uri': ["'none'"],
  'form-action': ["'none'"],
  'object-src': ["'none'"],
  'frame-src': ["'none'"],
  'require-trusted-types-for': ["'script'"],
  'trusted-types': ["'none'"]
})

/**
 * Splits a policy into its directives. A repeated directive stays a second
 * entry, because a browser ignores all but the first and the gate must not.
 *
 * @param {string} content
 * @returns {Array<[string, string[]]>}
 */
function policyDirectives(content) {
  return content
    .split(';')
    .map(part => part.trim().split(/\s+/).filter(Boolean))
    .filter(tokens => tokens.length > 0)
    .map(([name, ...sources]) => [name.toLowerCase(), sources])
}

/** Every difference between a policy and REFERENCE_POLICY, as problem lines. */
function policyProblems(content) {
  const problems = []
  const seen = new Set()

  for (const [name, sources] of policyDirectives(content)) {
    if (seen.has(name)) {
      problems.push(`index.html: the policy repeats the ${name} directive`)
      continue
    }
    seen.add(name)

    const expected = REFERENCE_POLICY[name]
    if (!expected) {
      problems.push(`index.html: the policy has a directive the reference does not: ${name}`)
      continue
    }
    for (const source of sources) {
      if (!expected.includes(source)) {
        problems.push(`index.html: the policy ${name} allows ${source}, which the reference does not`)
      }
    }
    for (const source of expected) {
      if (!sources.includes(source)) {
        problems.push(`index.html: the policy ${name} lacks ${source}`)
      }
    }
  }

  for (const name of Object.keys(REFERENCE_POLICY)) {
    if (!seen.has(name)) {
      problems.push(`index.html: the policy lacks the ${name} directive`)
    }
  }
  return problems
}

/** The policy rules and the inline-code rules the document relies on. */
function checkDocument(source) {
  const problems = []
  // A tag inside a comment is not a tag; blank the comment, keeping every offset.
  const html = source.replace(/<!--[\s\S]*?(?:-->|$)/g, comment => ' '.repeat(comment.length))
  const policies = [...html.matchAll(/<meta\b[^>]*http-equiv\s*=\s*["']?Content-Security-Policy["']?[^>]*>/gi)]
  const policy = policies[0]

  if (!policy) {
    problems.push('index.html: no Content-Security-Policy meta element')
  } else {
    if (policies.length > 1) {
      problems.push('index.html: has more than one Content-Security-Policy meta element')
    }
    const content = attributesOf(policy[0].replace(/^<meta/i, '')).get('content') ?? ''
    for (const unsafe of ['unsafe-inline', 'unsafe-eval']) {
      if (content.includes(unsafe)) {
        problems.push(`index.html: the policy allows '${unsafe}'`)
      }
    }
    problems.push(...policyProblems(content))

    // A policy only governs what the parser reads after it.
    const earlier = /<(?:script|link)\b/i.exec(html.slice(0, policy.index))
    if (earlier) {
      problems.push(`index.html: a ${earlier[0].slice(1).toLowerCase()} element comes before the policy`)
    }
  }

  for (const script of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    const hasSrc = attributesOf(script[1] ?? '').has('src')
    if (!hasSrc || (script[2] ?? '').trim() !== '') {
      problems.push('index.html: has an inline script, which the policy would refuse to run')
    }
  }
  if (/<style\b/i.test(html)) {
    problems.push('index.html: has a style element, which the policy would refuse to apply')
  }

  for (const tag of html.matchAll(/<[A-Za-z][^>]*>/g)) {
    for (const name of attributesOf(tag[0].replace(/^<[A-Za-z][\w-]*/, '')).keys()) {
      if (name === 'style') {
        problems.push('index.html: has a style attribute, which the policy would refuse to apply')
      } else if (/^on[a-z]+$/.test(name)) {
        problems.push(`index.html: has an inline ${name} handler, which the policy would refuse to run`)
      }
    }
  }

  return [...new Set(problems)]
}

/** Canonical text of a manifest: sorted keys, two-space indent, trailing newline. */
function canonicalText(value) {
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

/**
 * `build.json` against the files actually present.
 *
 * @param {string} raw
 * @param {Map<string, Buffer>} bytesByName every file in the bundle except build.json
 * @param {{ commit?: string }} expected
 */
function checkManifest(raw, bytesByName, { commit }) {
  const problems = []
  let manifest

  try {
    manifest = JSON.parse(raw)
  } catch (error) {
    return [`${MANIFEST_NAME}: is not valid JSON (${error instanceof Error ? error.message : String(error)})`]
  }

  if (canonicalText(manifest) !== raw) {
    problems.push(`${MANIFEST_NAME}: is not in canonical form (sorted keys, two-space indent, one trailing newline)`)
  }
  if (manifest?.v !== 1) {
    problems.push(`${MANIFEST_NAME}: "v" must be 1`)
  }
  if (manifest?.name !== 'hermie-web-client') {
    problems.push(`${MANIFEST_NAME}: "name" must be "hermie-web-client"`)
  }
  if (typeof manifest?.version !== 'string' || !SEMVER.test(manifest.version)) {
    problems.push(`${MANIFEST_NAME}: "version" must be a semantic version`)
  }
  if (typeof manifest?.sourceRepo !== 'string' || !REPO.test(manifest.sourceRepo)) {
    problems.push(`${MANIFEST_NAME}: "sourceRepo" must be "<owner>/<name>"`)
  }
  if (typeof manifest?.sourceCommit !== 'string' || !COMMIT.test(manifest.sourceCommit)) {
    problems.push(`${MANIFEST_NAME}: "sourceCommit" must be a 40-character lower-case commit hash`)
  } else if (commit !== undefined && manifest.sourceCommit !== commit) {
    problems.push(`${MANIFEST_NAME}: sourceCommit is ${manifest.sourceCommit}, expected ${commit}`)
  }

  const listed = manifest?.files
  if (!listed || typeof listed !== 'object' || Array.isArray(listed)) {
    problems.push(`${MANIFEST_NAME}: "files" must be an object`)
    return problems
  }

  let total = 0
  for (const name of Object.keys(listed)) {
    const entry = listed[name]
    const bytes = bytesByName.get(name)

    if (!bytes) {
      problems.push(`${MANIFEST_NAME}: lists ${name}, which is not in the bundle`)
      continue
    }
    if (!entry || typeof entry !== 'object' || Object.keys(entry).sort().join() !== 'bytes,sha256') {
      problems.push(`${MANIFEST_NAME}: ${name} must hold exactly "sha256" and "bytes"`)
      continue
    }
    if (typeof entry.sha256 !== 'string' || !SHA256.test(entry.sha256)) {
      problems.push(`${MANIFEST_NAME}: ${name} has a malformed sha256`)
    } else if (entry.sha256 !== createHash('sha256').update(bytes).digest('hex')) {
      problems.push(`${name}: does not match ${MANIFEST_NAME} (sha256 differs)`)
    }
    if (entry.bytes !== bytes.length) {
      problems.push(`${name}: does not match ${MANIFEST_NAME} (${bytes.length} bytes, listed ${entry.bytes})`)
    }
    total += bytes.length
  }

  for (const name of bytesByName.keys()) {
    if (!(name in listed)) {
      problems.push(`${name}: is in the bundle but not listed in ${MANIFEST_NAME}`)
    }
  }

  if (manifest.totalBytes !== total) {
    problems.push(`${MANIFEST_NAME}: totalBytes is ${manifest.totalBytes}, the listed files add up to ${total}`)
  }

  return problems
}

/**
 * Checks the build in `dir`.
 *
 * @param {string} dir
 * @param {{ limits?: Partial<typeof LIMITS>, commit?: string }} [options]
 * @returns {{ problems: string[], stats: { files: number, totalBytes: number, largestFile: { name: string, bytes: number } | null, initialJsBytes: number, initialJsGzipBytes: number, initialFiles: string[] } }}
 */
export function checkBundle(dir, { limits = {}, commit } = {}) {
  const max = { ...LIMITS, ...limits }
  const problems = []
  const stats = {
    files: 0,
    totalBytes: 0,
    largestFile: null,
    initialJsBytes: 0,
    initialJsGzipBytes: 0,
    initialFiles: []
  }

  if (!existsSync(dir) || !lstatSync(dir).isDirectory()) {
    return { problems: [`${dir}: no such build directory (run \`npm run client:build\`)`], stats }
  }

  const listing = listBundle(dir)
  problems.push(...listing.problems)

  const contents = new Map()
  for (const name of listing.files) {
    const bytes = readFileSync(join(dir, name))
    contents.set(name, bytes)
    stats.files += 1
    stats.totalBytes += bytes.length
    if (!stats.largestFile || bytes.length > stats.largestFile.bytes) {
      stats.largestFile = { name, bytes: bytes.length }
    }

    const extension = extensionOf(name)
    if (extension === SOURCE_MAP_EXTENSION) {
      problems.push(`${name}: is a source map; maps belong in dist-maps/, not in the bundle`)
    } else if (!ALLOWED_EXTENSIONS.includes(extension)) {
      problems.push(`${name}: extension "${extension}" is not served by the dashboard's static route`)
    }
    if (bytes.length > max.maxFileBytes) {
      problems.push(`${name}: ${bytes.length} bytes is over the ${max.maxFileBytes}-byte file limit`)
    }
    if (TEXT_EXTENSIONS.includes(extension) && hasNonAscii(bytes)) {
      problems.push(`${name}: holds a non-ASCII or control byte; the build must escape such text`)
    }
    if (TEXT_EXTENSIONS.includes(extension) && bytes.includes(DEVELOPMENT_ONLY_MARKER)) {
      problems.push(`${name}: holds development-only code (native/web/src/dev); it must not be in the bundle`)
    }
  }

  if (stats.totalBytes > max.maxTotalBytes) {
    problems.push(`the bundle is ${stats.totalBytes} bytes, over the ${max.maxTotalBytes}-byte limit`)
  }
  if (stats.files > max.maxFiles) {
    problems.push(`the bundle has ${stats.files} files, over the limit of ${max.maxFiles}`)
  }

  const html = contents.get('index.html')
  if (!html) {
    problems.push('index.html: missing')
  } else {
    problems.push(...checkDocument(html.toString('utf8')))

    const scripts = new Map([...contents].filter(([name]) => name.endsWith('.js') || name.endsWith('.mjs')))
    const { initial, problems: loadProblems } = initialScripts(html.toString('utf8'), scripts)
    problems.push(...loadProblems)

    stats.initialFiles = initial
    for (const name of initial) {
      const bytes = contents.get(name)
      if (bytes) {
        stats.initialJsBytes += bytes.length
        stats.initialJsGzipBytes += gzipSync(bytes, { level: 9 }).length
      }
    }
    if (stats.initialJsBytes > max.maxInitialJsBytes) {
      problems.push(`initial JavaScript is ${stats.initialJsBytes} bytes, over the ${max.maxInitialJsBytes}-byte limit`)
    }
    if (stats.initialJsGzipBytes > max.maxInitialJsGzipBytes) {
      problems.push(
        `initial JavaScript is ${stats.initialJsGzipBytes} bytes gzipped, over the ${max.maxInitialJsGzipBytes}-byte limit`
      )
    }
  }

  const manifest = contents.get(MANIFEST_NAME)
  if (!manifest) {
    problems.push(`${MANIFEST_NAME}: missing (run \`npm run client:build\`)`)
  } else {
    const others = new Map([...contents].filter(([name]) => name !== MANIFEST_NAME))
    problems.push(...checkManifest(manifest.toString('utf8'), others, { commit }))
  }

  return { problems, stats }
}

function kilobytes(bytes) {
  return `${(bytes / 1000).toFixed(1)} kB`
}

function main(argv) {
  const positional = []
  let commit

  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--commit') {
      commit = argv[(index += 1)]
    } else {
      positional.push(argv[index])
    }
  }

  const dir = resolve(process.cwd(), positional[0] ?? 'native/web/dist')
  const { problems, stats } = checkBundle(dir, { commit })

  console.log(`check-bundle: ${dir}`)
  console.log(
    `  ${stats.files} files (limit ${LIMITS.maxFiles}), ${kilobytes(stats.totalBytes)} (limit ${kilobytes(LIMITS.maxTotalBytes)})`
  )
  if (stats.largestFile) {
    console.log(
      `  largest file ${stats.largestFile.name}, ${kilobytes(stats.largestFile.bytes)} (limit ${kilobytes(LIMITS.maxFileBytes)})`
    )
  }
  console.log(
    `  initial JavaScript ${kilobytes(stats.initialJsBytes)} (limit ${kilobytes(LIMITS.maxInitialJsBytes)}), ` +
      `${kilobytes(stats.initialJsGzipBytes)} gzipped (limit ${kilobytes(LIMITS.maxInitialJsGzipBytes)})`
  )

  if (problems.length > 0) {
    console.error(`check-bundle: ${problems.length} problem${problems.length === 1 ? '' : 's'}`)
    for (const problem of problems) {
      console.error(`  - ${problem}`)
    }
    process.exit(1)
  }
  console.log('check-bundle: ok')
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2))
}
