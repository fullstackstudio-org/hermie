// @vitest-environment node
/**
 * What the first load must not import: the modules the client keeps in chunks of their own.
 *
 * `npm run client:check-bundle` measures the built entry against a byte budget, but only after a build, and the budget
 * has to leave room. This holds the structure instead, from the sources and in a second: follow every static import
 * from `main.tsx` (a dynamic `import()` is the way a chunk is meant to be reached, so it is not followed; a type-only
 * import is erased, so it is not either) and fail, naming the chain, when one reaches a module that is loaded on
 * demand. One value import of `interactive-frame.tsx` from the request layer once put every sheet's strings in the
 * first load (+79 kB) without any test noticing.
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const ENTRY = join(here, 'main.tsx')

/** Modules that exist to be loaded on demand: nothing the entry imports statically may reach them. */
const ON_DEMAND = [
  // The request sheets' chunk (`features/requests/sheets.ts`), what only a sheet draws, and the sheets' words.
  ...[
    'ApprovalSheet',
    'ClarifySheet',
    'ConfirmSheet',
    'ConnectionSheet',
    'DraftSheet',
    'FileSheet',
    'FormSheet',
    'SecretSheet',
    'SudoSheet',
    'VaultCodeSheet',
    'VaultSaveLoginSheet',
    'VaultUnlockSheet',
    'SecureSheet'
  ].map(name => `features/requests/${name}.tsx`),
  'features/requests/sheets.ts',
  'features/requests/interactive-frame.tsx',
  'features/requests/FormFields.tsx',
  'i18n/sheet-strings.ts',
  // The chat screen and the settings pages are chunks of their own.
  'features/chat/ChatScreen.tsx',
  'features/settings/SettingsHost.tsx'
].map(path => join(here, path))

/** The file a relative specifier names, or undefined for a package, a stylesheet or an asset. */
function resolveModule(from: string, specifier: string): string | undefined {
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
function staticImports(file: string): string[] {
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX)
  const specifiers: string[] = []

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

/** Every source module the entry reaches statically, each with the module it was first reached from. */
function entryGraph(): Map<string, string | undefined> {
  const reached = new Map<string, string | undefined>([[ENTRY, undefined]])
  const queue = [ENTRY]

  while (queue.length > 0) {
    const file = queue.shift() as string

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

/** `main.tsx > a.tsx > b.ts`: how the entry gets to `file`. */
function chainTo(reached: Map<string, string | undefined>, file: string): string {
  const chain: string[] = []

  for (let at: string | undefined = file; at !== undefined; at = reached.get(at)) {
    chain.unshift(relative(here, at))
  }

  return chain.join(' > ')
}

describe('the first load', () => {
  const reached = entryGraph()

  it('reaches the request layer, so the check below means something', () => {
    expect(reached.has(join(here, 'features/requests/RequestLayer.tsx'))).toBe(true)
    expect(reached.has(join(here, 'features/requests/sheet-busy.ts'))).toBe(true)
  })

  it('imports no module that is loaded on demand', () => {
    const leaks = ON_DEMAND.filter(file => reached.has(file)).map(file => chainTo(reached, file))

    expect(leaks).toEqual([])
  })

  it('names modules that exist', () => {
    expect(ON_DEMAND.filter(file => !existsSync(file))).toEqual([])
  })
})
