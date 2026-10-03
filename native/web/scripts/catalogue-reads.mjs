// Which keys of the generated catalogue the web client can read.
//
// `src/generated/locales/<tag>.json` holds every string the Expo app has, and
// the web client reads a small part of them: the screens it has, under the keys
// those screens use. The production build bundles only that part
// (`vite.config.ts`, `catalogueOnlyWhatIsRead`), which keeps the first load and
// the Dutch and German chunks to what a browser can show.
//
// The rule must never drop a key that is read, because a dropped key reads as
// `undefined` at run time, where the type checker cannot see it. So it is a
// syntactic rule that only ever errs towards keeping:
//
//   - every value reference to the `strings` export of `generated/strings`, in
//     every source file under `src` that is not a test, is followed through the
//     property accesses that come after it (`.a`, `?.a`, `['a']`, a `!`, a
//     cast or parentheses) as far as they are static;
//   - the path it reaches is kept whole, with everything below it: an alias
//     (`const errors = strings.app.errors`), a table read with a key that
//     arrives at run time (`strings.chat.approval.choices[id]`) or a subtree
//     handed to a function keeps that subtree, and a path that runs past a leaf
//     (`strings.app.common.cancel.length`) keeps the leaf;
//   - a reference that reaches no key at all keeps the whole catalogue: the tree
//     itself passed on (`f(strings)`, `{ strings }`), destructured, read with a
//     computed key at the root, re-exported, or the module imported
//     dynamically or as a namespace that is not followed into `.strings`.
//
// A reference in a type position (`typeof strings.app`) reads nothing at run
// time and is not counted. A local of the same name that is not the import is
// counted anyway, which can only keep more.

import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

import ts from 'typescript'

/** A module specifier that names the generated tree. */
const GENERATED_STRINGS = /(?:^|\/)generated\/strings(?:\.(?:ts|js))?$/

/** The export that is the tree. */
const EXPORT = 'strings'

/** Source files the analysis reads: TypeScript, not a test. */
const SOURCE = /\.(?:ts|tsx|mts|cts)$/
const TEST = /\.test\.(?:ts|tsx|mts|cts)$/

/** Wrappers a read passes through without changing what it reads. */
const TRANSPARENT = new Set([
  ts.SyntaxKind.ParenthesizedExpression,
  ts.SyntaxKind.NonNullExpression,
  ts.SyntaxKind.AsExpression,
  ts.SyntaxKind.SatisfiesExpression,
  ts.SyntaxKind.TypeAssertionExpression
])

const isStaticKey = node => ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)

/** Is `node` in a type position, where a reference reads nothing at run time? */
function inTypePosition(node) {
  for (let current = node.parent; current; current = current.parent) {
    if (ts.isTypeNode(current)) {
      return true
    }
    if (ts.isExpression(current) || ts.isStatement(current)) {
      return false
    }
  }
  return false
}

/** The dotted path a reference reaches, following the static property accesses after it. */
function pathFrom(start) {
  const segments = []
  let current = start

  for (;;) {
    const parent = current.parent

    if (!parent) {
      break
    }
    if (TRANSPARENT.has(parent.kind) && parent.expression === current) {
      current = parent
    } else if (ts.isPropertyAccessExpression(parent) && parent.expression === current) {
      segments.push(parent.name.text)
      current = parent
    } else if (
      ts.isElementAccessExpression(parent) &&
      parent.expression === current &&
      isStaticKey(parent.argumentExpression)
    ) {
      segments.push(parent.argumentExpression.text)
      current = parent
    } else {
      break
    }
  }

  return segments.join('.')
}

/**
 * The paths one source file reads, or `null` when it reads the tree in a way
 * that reaches no key (the whole catalogue must then be kept).
 *
 * @param {string} name a path, for the parser's sake (the extension decides JSX)
 * @param {string} text
 * @returns {string[] | null}
 */
export function pathsReadIn(name, text) {
  const file = ts.createSourceFile(
    name,
    text,
    ts.ScriptTarget.Latest,
    true,
    name.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  )
  /** Locals bound to the tree. */
  const locals = new Set()
  /** Locals bound to the whole module (`import * as g`), followed into `g.strings`. */
  const namespaces = new Set()
  let whole = false

  for (const statement of file.statements) {
    const specifier = statement.moduleSpecifier

    if (!specifier || !ts.isStringLiteral(specifier) || !GENERATED_STRINGS.test(specifier.text)) {
      continue
    }

    if (ts.isExportDeclaration(statement)) {
      // Someone else could import the tree from here, under any name.
      if (!statement.isTypeOnly) {
        whole = true
      }
      continue
    }

    const clause = ts.isImportDeclaration(statement) ? statement.importClause : undefined
    if (!clause || clause.isTypeOnly) {
      continue
    }

    const bindings = clause.namedBindings
    if (bindings && ts.isNamespaceImport(bindings)) {
      namespaces.add(bindings.name.text)
    } else if (bindings) {
      for (const element of bindings.elements) {
        if (!element.isTypeOnly && (element.propertyName ?? element.name).text === EXPORT) {
          locals.add(element.name.text)
        }
      }
    }
  }

  const paths = new Set()

  const visit = node => {
    if (whole) {
      return
    }

    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.some(argument => !isStaticKey(argument) || GENERATED_STRINGS.test(argument.text))
    ) {
      // A dynamic import of the tree, or of a path that cannot be read here.
      whole = true
      return
    }

    if (ts.isIdentifier(node) && !inTypePosition(node)) {
      const parent = node.parent
      const isName =
        (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
        (ts.isPropertyAssignment(parent) && parent.name === node) ||
        ts.isImportSpecifier(parent) ||
        ts.isImportClause(parent) ||
        ts.isNamespaceImport(parent) ||
        (ts.isBindingElement(parent) && parent.propertyName === node) ||
        (ts.isMethodDeclaration(parent) && parent.name === node) ||
        (ts.isPropertyDeclaration(parent) && parent.name === node) ||
        (ts.isJsxAttribute(parent) && parent.name === node) ||
        (ts.isPropertySignature(parent) && parent.name === node) ||
        (ts.isEnumMember(parent) && parent.name === node) ||
        ((ts.isVariableDeclaration(parent) ||
          ts.isParameter(parent) ||
          ts.isBindingElement(parent) ||
          ts.isFunctionDeclaration(parent)) &&
          parent.name === node) ||
        ts.isLabeledStatement(parent) ||
        ts.isBreakOrContinueStatement(parent)

      let reference
      if (locals.has(node.text) && !isName) {
        reference = node
      } else if (
        namespaces.has(node.text) &&
        !isName &&
        ts.isPropertyAccessExpression(parent) &&
        parent.expression === node
      ) {
        // `g.strings…` reads the tree; `g.somethingElse` does not.
        if (parent.name.text === EXPORT) {
          reference = parent
        }
      } else if (namespaces.has(node.text) && !isName) {
        // The namespace object itself handed on: it carries the tree.
        whole = true
        return
      }

      if (reference) {
        const path = pathFrom(reference)

        if (path === '') {
          whole = true
          return
        }
        paths.add(path)
      }
    }

    ts.forEachChild(node, visit)
  }

  visit(file)

  return whole ? null : [...paths].sort()
}

/**
 * The paths every non-test source file under `dir` reads, sorted, or `null`
 * when any of them reaches no key.
 *
 * @param {string} dir
 * @returns {string[] | null}
 */
export function pathsReadUnder(dir) {
  const paths = new Set()
  const files = []

  const walk = current => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name)

      if (entry.isDirectory()) {
        walk(path)
      } else if (entry.isFile() && SOURCE.test(entry.name) && !TEST.test(entry.name)) {
        files.push(path)
      }
    }
  }
  walk(dir)

  for (const path of files.sort()) {
    const read = pathsReadIn(relative(dir, path).split(sep).join('/'), readFileSync(path, 'utf8'))

    if (read === null) {
      return null
    }
    for (const entry of read) {
      paths.add(entry)
    }
  }

  return [...paths].sort()
}

/**
 * Is `key` (a dotted catalogue key) read by one of `paths`? It is when a path
 * names it, names a branch above it, or runs on past it.
 *
 * @param {string} key
 * @param {readonly string[]} paths
 */
export function isRead(key, paths) {
  return paths.some(path => key === path || key.startsWith(`${path}.`) || path.startsWith(`${key}.`))
}

/**
 * A locale file with only the keys that are read, in the order it had them.
 * `null` paths keep everything.
 *
 * @template T
 * @param {Readonly<Record<string, T>>} catalogue
 * @param {readonly string[] | null} paths
 * @returns {Record<string, T>}
 */
export function catalogueRead(catalogue, paths) {
  if (paths === null) {
    return { ...catalogue }
  }
  return Object.fromEntries(Object.entries(catalogue).filter(([key]) => isRead(key, paths)))
}
