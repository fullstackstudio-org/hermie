#!/usr/bin/env node
/**
 * Writes THIRD_PARTY_LICENSES.md and the licence data the app bundles, from the
 * PRODUCTION dependency tree of the `@hermie/app` workspace.
 *
 *   node scripts/generate-third-party-licenses.mjs
 *   node scripts/generate-third-party-licenses.mjs --check    # fail if stale
 *
 * Why the lockfile and not `npm ls`: the lockfile already knows which entry is
 * dev-only (`dev` / `devOptional`) and which version won every conflict, so a
 * walk over it is both exact and offline. `node_modules` is then only asked for
 * what the lockfile cannot hold — the package's own `package.json` metadata and
 * the bytes of its licence file.
 *
 * Determinism is the whole point of `--check`: everything is sorted (packages by
 * name then version, licence texts by the hash of their content), identical
 * licence texts are emitted once and referenced by that hash, and the output is
 * run through the repository's own Prettier configuration so the generated files
 * satisfy `npm run format` without an ignore rule.
 */

import { createHash } from 'node:crypto'
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..')

/** The workspace whose production tree ships to users. */
const APP_WORKSPACE = 'expo/hermie'

const markdownPath = resolve(repoRoot, 'THIRD_PARTY_LICENSES.md')
const jsonPath = resolve(repoRoot, 'expo/hermie/src/generated/third-party-licences.json')

const checkOnly = process.argv.includes('--check')

// ---------------------------------------------------------------------------
// The lockfile walk
// ---------------------------------------------------------------------------

/**
 * A package's own dependency edges, as they appear on a lockfile entry.
 *
 * `peerDependencies` are followed because an installed peer is part of the
 * shipped tree (React and React Native reach half the Expo packages that way),
 * and an unmet or optional peer simply fails to resolve and is skipped.
 */
function dependencyEdges(entry) {
  const edges = new Map()

  // Only a plain `dependencies` edge is REQUIRED to resolve. An optional
  // dependency may legitimately be absent, and an unmet peer is a normal,
  // installable state — neither is evidence that the walk went wrong.
  for (const name of Object.keys(entry.dependencies ?? {})) {
    edges.set(name, { required: true })
  }
  for (const name of Object.keys(entry.optionalDependencies ?? {})) {
    edges.set(name, { required: false })
  }
  for (const name of Object.keys(entry.peerDependencies ?? {})) {
    if (!edges.has(name)) {
      edges.set(name, { required: false })
    }
  }

  return edges
}

/**
 * Node's resolution order, expressed over lockfile keys: the nearest
 * `node_modules` first, then every parent one, then the root.
 */
function resolveEntry(packages, fromPath, name) {
  let base = fromPath

  for (;;) {
    const candidate = base ? `${base}/node_modules/${name}` : `node_modules/${name}`

    if (packages[candidate]) {
      return candidate
    }
    if (!base) {
      return undefined
    }

    const cut = base.lastIndexOf('/node_modules/')
    base = cut === -1 ? '' : base.slice(0, cut)
  }
}

/** A `link: true` entry points at a workspace directory in this repository. */
const isWorkspaceLink = entry => entry.link === true

/**
 * Every production package the app's tree reaches, keyed by lockfile path.
 *
 * Workspace packages are walked THROUGH — their own dependencies ship with the
 * app — but recorded separately, because they are this repository's code and
 * carry this repository's licence.
 */
function collectTree(lock) {
  const packages = lock.packages ?? {}
  const app = packages[APP_WORKSPACE]

  if (!app) {
    throw new Error(`package-lock.json has no entry for ${APP_WORKSPACE}; run npm install first.`)
  }

  const external = new Map()
  const workspaces = new Set()
  const unresolved = new Set()
  const seen = new Set()
  const queue = []

  const push = (fromPath, entry) => {
    for (const [name, edge] of dependencyEdges(entry)) {
      const target = resolveEntry(packages, fromPath, name)

      if (!target) {
        // A bundled dependency has no tree entry of its own; anything else that
        // a required edge cannot reach means the walk is incomplete.
        if (edge.required && !(entry.bundleDependencies ?? []).includes(name)) {
          unresolved.add(`${name} (required by ${fromPath || 'the workspace root'})`)
        }
        continue
      }

      queue.push(target)
    }
  }

  push(APP_WORKSPACE, app)

  while (queue.length > 0) {
    const path = queue.pop()

    if (seen.has(path)) {
      continue
    }
    seen.add(path)

    const entry = packages[path]

    // The lockfile is the authority on what never ships: a dev-only entry, and
    // an entry only a dev or optional edge reaches.
    //
    // `optional` is skipped for a second reason as well, and it is the one that
    // keeps `--check` usable: npm installs an optional entry only when the host
    // matches its `os`/`cpu`, so a list built from what is on disk would differ
    // between a Mac and the Linux runner that verifies it. Every optional entry
    // in this tree is a per-platform native binary of build tooling
    // (`fsevents`, the `lightningcss-*` prebuilds) and none of it is bundled
    // into the app.
    if (!entry || entry.dev === true || entry.devOptional === true || entry.optional === true) {
      continue
    }

    if (isWorkspaceLink(entry)) {
      const target = entry.resolved

      if (target && packages[target]) {
        workspaces.add(packages[target].name ?? target)
        push(target, packages[target])
      }
      continue
    }

    external.set(path, entry)
    push(path, entry)
  }

  return { external, workspaces, unresolved: [...unresolved].sort() }
}

// ---------------------------------------------------------------------------
// What a package says about itself
// ---------------------------------------------------------------------------

/** `license`, the SPDX expression, or `licenses[]` on a package old enough to have one. */
function licenceId(manifest) {
  const license = manifest.license ?? manifest.licence

  if (typeof license === 'string' && license.trim()) {
    return license.trim()
  }
  // Pre-SPDX manifests wrote an object, or a list of them.
  if (license && typeof license === 'object' && typeof license.type === 'string') {
    return license.type.trim()
  }

  const list = Array.isArray(manifest.licenses) ? manifest.licenses : []
  const ids = list
    .map(item => (typeof item === 'string' ? item : typeof item?.type === 'string' ? item.type : ''))
    .map(id => id.trim())
    .filter(Boolean)

  return ids.length > 1 ? `(${ids.join(' OR ')})` : (ids[0] ?? '')
}

const SHORTHAND_HOSTS = { github: 'github.com', gitlab: 'gitlab.com', bitbucket: 'bitbucket.org' }

/** `git+https://…`, `git://…`, `git@host:owner/repo`, `owner/repo` → a plain https URL. */
function repositoryUrl(manifest) {
  const repository = manifest.repository
  const raw = typeof repository === 'string' ? repository : typeof repository?.url === 'string' ? repository.url : ''
  let url = raw.trim()

  if (!url) {
    return ''
  }

  const shorthand = /^([a-z]+):(?!\/\/)(.+)$/i.exec(url)

  if (shorthand && SHORTHAND_HOSTS[shorthand[1].toLowerCase()]) {
    url = `https://${SHORTHAND_HOSTS[shorthand[1].toLowerCase()]}/${shorthand[2]}`
  } else if (/^[\w.-]+\/[\w.-]+$/.test(url)) {
    url = `https://github.com/${url}`
  }

  url = url
    .replace(/^git\+/, '')
    .replace(/^ssh:\/\/(?:git@)?/, 'https://')
    .replace(/^git@([^:/]+):/, 'https://$1/')
    .replace(/^git:\/\//, 'https://')
    .replace(/^http:\/\//, 'https://')
    .replace(/\.git$/, '')
    .replace(/\/+$/, '')

  // Anything that is still not a URL (a local path, a bare word) is not worth
  // printing as one.
  return /^https:\/\/\S+$/.test(url) ? url : ''
}

/**
 * `LICENSE`, `LICENCE`, `LICENSE.md`, `LICENSE-MIT`, `COPYING` — any case, any
 * extension. A package that ships several (the MIT-or-Apache pairs) gets all of
 * them, each under its own name, so nothing is silently dropped.
 */
const LICENCE_FILE_RE = /^(licen[cs]es?|copying)([-._].*)?$/i

function licenceText(packageDir) {
  let names

  try {
    names = readdirSync(packageDir)
  } catch {
    return ''
  }

  const found = names
    .filter(name => LICENCE_FILE_RE.test(name))
    .sort()
    .filter(name => {
      try {
        return statSync(join(packageDir, name)).isFile()
      } catch {
        return false
      }
    })

  const parts = found
    .map(name => ({ name, body: normaliseText(readFileSync(join(packageDir, name), 'utf8')) }))
    .filter(part => part.body.length > 0)

  if (parts.length <= 1) {
    return parts[0]?.body ?? ''
  }

  // A dual-licensed package ships one file per licence and all of them bind, so
  // each is kept under its own name rather than one of them winning.
  return parts.map(part => `${part.name}\n\n${part.body}`).join('\n\n----\n\n')
}

/** One text, one hash: line endings and edge whitespace must not split a group. */
function normaliseText(raw) {
  return raw
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map(line => line.replace(/[ \t]+$/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

const hashOf = text => createHash('sha256').update(text).digest('hex').slice(0, 12)

// ---------------------------------------------------------------------------
// Collecting
// ---------------------------------------------------------------------------

function collect() {
  const lock = JSON.parse(readFileSync(resolve(repoRoot, 'package-lock.json'), 'utf8'))
  const { external, workspaces, unresolved } = collectTree(lock)

  if (unresolved.length > 0) {
    fail(['The dependency walk could not resolve these packages:', ...unresolved.map(line => `  ${line}`), '', 'Run `npm install` so package-lock.json matches the manifests, then try again.']) // prettier-ignore
  }

  const entries = []
  const missingManifest = []
  const undeclared = []
  const texts = new Map()

  for (const [path, locked] of external) {
    const packageDir = resolve(repoRoot, path)
    let manifest

    try {
      manifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'))
    } catch {
      missingManifest.push(path)
      continue
    }

    const name = manifest.name ?? path.slice(path.lastIndexOf('node_modules/') + 'node_modules/'.length)
    const version = locked.version ?? manifest.version ?? ''
    const id = licenceId(manifest) || (typeof locked.license === 'string' ? locked.license.trim() : '')
    const text = licenceText(packageDir)

    if (!id && !text) {
      undeclared.push(`${name}@${version} (${path})`)
      continue
    }

    let hash = ''

    if (text) {
      hash = hashOf(text)

      const group = texts.get(hash) ?? { hash, text, ids: new Set(), packages: [] }
      if (id) {
        group.ids.add(id)
      }
      group.packages.push(`${name}@${version}`)
      texts.set(hash, group)
    }

    entries.push({ name, version, licence: id, repository: repositoryUrl(manifest), hash })
  }

  if (missingManifest.length > 0) {
    fail(['These packages are in the lockfile but not installed:', ...missingManifest.map(path => `  ${path}`), '', 'Run `npm ci` and try again.']) // prettier-ignore
  }

  if (undeclared.length > 0) {
    fail([
      'These packages declare no licence and ship no licence file:',
      ...undeclared.map(line => `  ${line}`),
      '',
      'Their terms have to be established by hand before Hermie can ship them: check the',
      'repository, then either pin a version that states a licence or drop the dependency.'
    ])
  }

  entries.sort((left, right) => byCodeUnits(left.name, right.name) || compareVersions(left.version, right.version))

  // The same name at the same version can sit at several places in the tree
  // (npm hoists what it can and nests the rest). It is one package and one
  // obligation, so it is listed once.
  const unique = entries.filter(
    (entry, index) =>
      index === 0 || entry.name !== entries[index - 1].name || entry.version !== entries[index - 1].version
  )

  const groups = [...texts.values()]
    .map(group => ({ ...group, ids: [...group.ids].sort(), packages: [...new Set(group.packages)].sort() }))
    .sort((left, right) => byCodeUnits(left.hash, right.hash))

  return { entries: unique, groups, workspaces: [...workspaces].sort() }
}

/**
 * Code-unit order, not locale order.
 *
 * `localeCompare` reads its rules from ICU, and a Node built without the full
 * data set collates differently — which would put the file's rows in a different
 * order on the machine that verifies it than on the machine that wrote it. The
 * default `Array.prototype.sort` comparator is this one, so the plain `.sort()`
 * calls above are already stable in the same way.
 */
const byCodeUnits = (left, right) => (left < right ? -1 : left > right ? 1 : 0)

/** Numeric where both sides are numeric, so 2.10.0 sorts after 2.9.0. */
function compareVersions(left, right) {
  const leftParts = left.split(/[.+-]/)
  const rightParts = right.split(/[.+-]/)

  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    const a = leftParts[index] ?? ''
    const b = rightParts[index] ?? ''

    if (a === b) {
      continue
    }

    const numeric = /^\d+$/.test(a) && /^\d+$/.test(b)

    return numeric ? Number(a) - Number(b) : byCodeUnits(a, b)
  }

  return 0
}

function fail(lines) {
  for (const line of lines) {
    console.error(line)
  }
  process.exit(1)
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const escapeCell = value => value.replace(/\|/g, '\\|')

/** "1 package" / "2 packages": a generated sentence still has to read as one. */
const count = (total, noun) => `${total} ${noun}${total === 1 ? '' : 's'}`

/** A fence long enough that nothing inside the licence text can close it. */
function fenced(text) {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map(match => match[0].length))

  const fence = '`'.repeat(Math.max(3, longest + 1))

  return `${fence}text\n${text}\n${fence}`
}

function renderMarkdown({ entries, groups, workspaces }) {
  const declaredOnly = entries.filter(entry => !entry.hash)
  const lines = []

  lines.push('# Third-party licences')
  lines.push('')
  lines.push('<!-- Generated by scripts/generate-third-party-licenses.mjs. Do not edit by hand. -->')
  lines.push('')
  lines.push(
    'Every third-party package that ships inside Hermie, with the licence each one declares and the',
    'licence text each one carries. It is generated: `npm run licences` rewrites this file and',
    '`npm run licences:check` — which CI runs — fails if it has drifted from the dependency tree.'
  )
  lines.push('')
  lines.push(
    'The list is the **production** dependency tree of `expo/hermie`, resolved transitively through',
    '`package-lock.json`. Development tooling is not in it: a linter, a test runner or a bundler never',
    "reaches a user's device, and the lockfile already records which entry only a development edge",
    'reaches.'
  )
  lines.push('')
  lines.push(
    'The optional, per-platform native binaries of that tooling are left out for a second reason: npm',
    'installs only the ones a given machine can run, so a list that included them would depend on the',
    'machine that generated it and could not be checked on another.'
  )
  lines.push('')

  if (workspaces.length > 0) {
    lines.push(
      "Nor are this repository's own workspace packages in it —",
      `${workspaces.map(name => `\`${name}\``).join(', ')} — because they are Hermie source code under`,
      'the licence in [LICENSE](LICENSE). Their own dependencies *are* in the list, because those ship.'
    )
    lines.push('')
  }

  lines.push(
    'Code copied or ported into this repository is a different obligation and is listed in',
    '[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).'
  )
  lines.push('')
  lines.push(
    `**${count(entries.length, 'package')}**, carrying **${count(groups.length, 'distinct licence text')}**.`,
    'Identical texts are printed once under [Licence texts](#licence-texts) and referenced by the first',
    'twelve hex digits of the SHA-256 of the text, which is why a file listing hundreds of MIT packages',
    'is not hundreds of copies of the MIT licence.'
  )
  lines.push('')
  lines.push('## Packages')
  lines.push('')
  lines.push('| Package | Version | Licence | Licence text | Source |')
  lines.push('| --- | --- | --- | --- | --- |')

  for (const entry of entries) {
    const licence = entry.licence ? escapeCell(entry.licence) : '_not declared_'
    const text = entry.hash ? `[\`${entry.hash}\`](#licence-text-${entry.hash})` : '_none shipped_'
    const source = entry.repository ? `<${entry.repository}>` : '—'

    lines.push(`| \`${escapeCell(entry.name)}\` | \`${entry.version}\` | ${licence} | ${text} | ${source} |`)
  }

  lines.push('')

  if (declaredOnly.length > 0) {
    lines.push('## Packages that ship no licence text')
    lines.push('')
    lines.push(
      'These packages declare a licence in their `package.json` but include no licence file of their',
      'own, so there is no text to reproduce here. The declared identifier is the whole statement they',
      'make; the canonical text of that licence is the one published at',
      '[spdx.org/licenses](https://spdx.org/licenses/).'
    )
    lines.push('')

    for (const entry of declaredOnly) {
      const name = entry.repository ? `[${entry.name}](${entry.repository})` : entry.name

      lines.push(`- ${name} \`${entry.version}\` — declares ${entry.licence}, ships no licence file.`)
    }

    lines.push('')
  }

  lines.push('## Licence texts')
  lines.push('')
  lines.push('Each heading is the first twelve hex digits of the SHA-256 of the text under it.')
  lines.push('')

  for (const group of groups) {
    lines.push(`### Licence text ${group.hash}`)
    lines.push('')
    lines.push(
      `Declared as ${group.ids.length > 0 ? group.ids.map(id => `\`${id}\``).join(', ') : '_nothing_'} by ` +
        `${group.packages.length === 1 ? 'one package' : `${group.packages.length} packages`}: ` +
        `${group.packages.map(name => `\`${name}\``).join(', ')}.`
    )
    lines.push('')
    lines.push(fenced(group.text))
    lines.push('')
  }

  return `${lines
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd()}\n`
}

/**
 * The same data for the app to bundle. Licence texts are stored once and
 * referenced by hash, exactly as the markdown does, which is what keeps a file
 * with several hundred MIT packages down to a few hundred kilobytes.
 */
function renderJson({ entries, groups, workspaces }) {
  const data = {
    generatedBy: 'scripts/generate-third-party-licenses.mjs',
    scope: `production dependencies of ${APP_WORKSPACE}`,
    excludesWorkspacePackages: workspaces,
    packages: entries.map(entry => ({
      name: entry.name,
      version: entry.version,
      licence: entry.licence,
      ...(entry.repository ? { repository: entry.repository } : {}),
      ...(entry.hash ? { text: entry.hash } : {})
    })),
    texts: Object.fromEntries(groups.map(group => [group.hash, group.text]))
  }

  return `${JSON.stringify(data, null, 2)}\n`
}

// ---------------------------------------------------------------------------
// Writing, and the drift check
// ---------------------------------------------------------------------------

/**
 * Both files go through the repository's own Prettier configuration. Generated
 * files are checked by `npm run format` like every other file, and formatting
 * them here is the only way to keep that honest without an ignore rule.
 */
async function formatted(path, source) {
  let prettier

  try {
    prettier = await import('prettier')
  } catch {
    throw new Error('Prettier is not installed. Run `npm ci` before generating the licence files.')
  }

  const config = (await prettier.resolveConfig(path)) ?? {}

  return prettier.format(source, { ...config, filepath: path })
}

function readIfPresent(path) {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

const collected = collect()

const outputs = [
  { path: markdownPath, source: renderMarkdown(collected) },
  { path: jsonPath, source: renderJson(collected) }
]

const stale = []

for (const output of outputs) {
  const wanted = await formatted(output.path, output.source)
  const current = readIfPresent(output.path)

  if (checkOnly) {
    if (current !== wanted) {
      stale.push(relative(repoRoot, output.path))
    }
    continue
  }

  if (current !== wanted) {
    mkdirSync(dirname(output.path), { recursive: true })
    writeFileSync(output.path, wanted)
  }

  console.log(`wrote ${relative(repoRoot, output.path)}  ${(wanted.length / 1024).toFixed(1)} kB`)
}

if (checkOnly) {
  if (stale.length > 0) {
    fail([
      'These generated licence files do not match the dependency tree:',
      ...stale.map(path => `  ${path}`),
      '',
      'Run `npm run licences` and commit the result.'
    ])
  }

  console.log(
    `Licence files are in sync: ${collected.entries.length} packages, ${collected.groups.length} licence texts.`
  )
} else {
  console.log(`${collected.entries.length} packages, ${collected.groups.length} distinct licence texts.`)
}
