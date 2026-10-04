// Which catalogue keys the first load needs, and which only a chunk loaded on demand does.
//
// The English catalogue is inlined into the entry (`src/i18n/catalogue.ts`), so every key it holds is first-load
// weight, whoever reads it. A key that only a lazy page reads (the Crons pages, the Settings pages, the Conversations
// page, the chat screen's own words) does not have to be: the build leaves it out of the entry's English and puts it in
// a module that the pages importing it also import, which registers it before the page's own code runs
// (`vite.config.ts`, `catalogueOnlyWhatIsRead`).
//
// "The first load" is the entry module and everything it imports statically, as far as the sources can say: a
// dynamic `import()` is how a chunk is reached, so it is not followed, and a type-only import is erased, so it is not
// either. The rule only ever errs towards the entry: a module that is in the graph but ends up in a chunk costs the
// entry a key it did not need, and a module that is not in the graph but ends up in the entry still finds its key
// registered, because registering is what importing the module does.

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'

import ts from 'typescript'

import { isRead, pathsReadIn } from './catalogue-reads.mjs'

const SOURCE = /\.(?:ts|tsx|mts|cts)$/
const TEST = /\.test\.(?:ts|tsx|mts|cts)$/

/**
 * The paths each non-test source file under `dir` reads, by the file's path relative to `dir` (with `/`): `null`
 * for a file that reads the tree in a way that reaches no key.
 *
 * @param {string} dir
 * @returns {Map<string, string[] | null>}
 */
export function pathsReadByFile(dir) {
  const byFile = new Map()

  const walk = current => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name)

      if (entry.isDirectory()) {
        walk(path)
      } else if (entry.isFile() && SOURCE.test(entry.name) && !TEST.test(entry.name)) {
        const name = relative(dir, path).split(sep).join('/')

        byFile.set(name, pathsReadIn(name, readFileSync(path, 'utf8')))
      }
    }
  }
  walk(dir)

  return new Map([...byFile].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
}

/** The file a relative specifier names, or undefined for a package, a stylesheet or an asset. */
function resolveModule(from, specifier) {
  if (!specifier.startsWith('.')) {
    return undefined
  }

  const base = join(dirname(from), specifier)

  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts'), join(base, 'index.tsx')]) {
    if (/\.tsx?$/.test(candidate) && existsSync(candidate)) {
      return candidate
    }
  }

  return undefined
}

/** The modules a file imports (or re-exports from) with something that is not erased. */
function staticImports(file) {
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX)
  const specifiers = []

  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      const clause = statement.importClause
      const named = clause?.namedBindings
      const erased =
        clause !== undefined &&
        (clause.isTypeOnly ||
          (clause.name === undefined &&
            named !== undefined &&
            ts.isNamedImports(named) &&
            named.elements.length > 0 &&
            named.elements.every(element => element.isTypeOnly)))

      if (!erased) {
        specifiers.push(statement.moduleSpecifier.text)
      }
    } else if (
      ts.isExportDeclaration(statement) &&
      !statement.isTypeOnly &&
      statement.moduleSpecifier !== undefined &&
      ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      specifiers.push(statement.moduleSpecifier.text)
    }
  }

  return specifiers
}

/**
 * Every source module `entry` reaches by static imports, each with the module it was first reached from.
 *
 * @param {string} entry an absolute path
 * @returns {Map<string, string | undefined>}
 */
export function entryGraph(entry) {
  const reached = new Map([[entry, undefined]])
  const queue = [entry]

  while (queue.length > 0) {
    const file = queue.shift()

    for (const specifier of staticImports(file)) {
      const target = resolveModule(file, specifier)

      if (target !== undefined && !reached.has(target)) {
        reached.set(target, file)
        queue.push(target)
      }
    }
  }

  return reached
}

/**
 * Split what the sources read into the first load's and the chunks'.
 *
 *  - `entry`: the paths read by a module of the entry's static graph; `null` when one of them reads the tree in a way
 *    that reaches no key, and then everything is the first load's.
 *  - `lazy`: the paths read by every other module; `null` likewise.
 *  - `byFile`: each module's own paths, and `inEntry` the modules of the static graph (paths relative to `dir`).
 *
 * @param {string} dir the sources
 * @param {string} entryFile the entry module, relative to `dir`
 * @returns {{ entry: string[] | null, lazy: string[] | null, byFile: Map<string, string[] | null>, inEntry: Set<string> }}
 */
export function splitReads(dir, entryFile) {
  const inEntry = new Set(
    [...entryGraph(join(dir, entryFile)).keys()].map(file => relative(dir, file).split(sep).join('/'))
  )
  const byFile = pathsReadByFile(dir)
  const side = { entry: new Set(), lazy: new Set() }
  const whole = { entry: false, lazy: false }

  for (const [name, paths] of byFile) {
    const which = inEntry.has(name) ? 'entry' : 'lazy'

    if (paths === null) {
      whole[which] = true
    } else {
      paths.forEach(path => side[which].add(path))
    }
  }

  return {
    entry: whole.entry ? null : [...side.entry].sort(),
    lazy: whole.lazy ? null : [...side.lazy].sort(),
    byFile,
    inEntry
  }
}

/**
 * The keys that leave the first load: those some module outside the entry's graph reads and the entry does not. A
 * `null` read on either side means nothing leaves (the entry keeps everything), because nothing can be proved.
 *
 * @template T
 * @param {Readonly<Record<string, T>>} catalogue
 * @param {{ entry: readonly string[] | null, lazy: readonly string[] | null }} split
 * @returns {string[]}
 */
export function lazyOnlyKeys(catalogue, split) {
  if (split.entry === null || split.lazy === null) {
    return []
  }

  const { entry, lazy } = split

  return Object.keys(catalogue).filter(key => isRead(key, lazy) && !isRead(key, entry))
}

/**
 * Which of `keys` (the ones that left the first load) each module outside the entry's graph reads: the words the build
 * registers for that module, in a virtual module only that module imports.
 *
 * One per reading module, not one per group of keys, because a module imported by only one other is in that one's
 * chunk: the words land in the chunk of the page that says them and are never a file of their own. A group shared by
 * pages loaded in different combinations was one (the plugin importer accepts 80 files). A key two such modules read is
 * in both of theirs; `registerEnglish` keeps the first and ignores the second. Modules that read none are left out.
 *
 * @param {readonly string[]} keys
 * @param {{ byFile: Map<string, readonly string[] | null>, inEntry: Set<string> }} split
 * @returns {Map<string, string[]>} by the module's path relative to the sources, in path order
 */
export function lazyKeysByFile(keys, split) {
  const byFile = new Map()

  for (const [name, read] of split.byFile) {
    if (split.inEntry.has(name) || read === null) {
      continue
    }

    const own = keys.filter(key => isRead(key, read))

    if (own.length > 0) {
      byFile.set(name, own)
    }
  }

  return byFile
}
