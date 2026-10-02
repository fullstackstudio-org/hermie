/**
 * The parameter list of every string function in the English tables, read from
 * the TypeScript types.
 *
 * At run time a function is only `(current, total) => …`: the names survive
 * but the types do not, and the native API needs both (`Int` or `String`, and
 * whether the argument may be left out). The compiler knows, so this asks it:
 * it loads `expo/hermie/src/i18n/trees.ts`, finds the `ENGLISH_TREES` object
 * literal and walks the declared type of every table it lists.
 */
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import ts from 'typescript'

import type { Param, ParamType } from './template'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const treesFile = join(repoRoot, 'expo/hermie/src/i18n/trees.ts')

function paramType(text: string, at: string): { type: ParamType; optional: boolean } {
  switch (text) {
    case 'string':
      return { type: 'string', optional: false }
    case 'string | undefined':
      return { type: 'string', optional: true }
    case 'number':
      return { type: 'number', optional: false }
    case 'string[]':
    case 'readonly string[]':
      return { type: 'string[]', optional: false }
    default:
      throw new Error(`${at}: parameter type ${text} has no native counterpart (string, number or string[])`)
  }
}

export interface Signatures {
  /** Dotted key → parameters, for every function leaf of every English table. */
  functions: Map<string, Param[]>
  /**
   * Branches typed `Record<string, string>`: tables a screen indexes with a
   * value it got from the gateway (`outcomes[choice]`), not with a name it knows.
   */
  keyed: Set<string>
}

export function readSignatures(): Signatures {
  const program = ts.createProgram([treesFile], {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    strict: true,
    skipLibCheck: true,
    noEmit: true,
    types: [],
    lib: ['lib.es2023.d.ts']
  })
  const checker = program.getTypeChecker()
  const source = program.getSourceFile(treesFile)

  if (!source) {
    throw new Error(`cannot load ${treesFile}`)
  }

  let trees: ts.ObjectLiteralExpression | undefined

  source.forEachChild(function find(node) {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === 'ENGLISH_TREES' &&
      node.initializer &&
      ts.isObjectLiteralExpression(node.initializer)
    ) {
      trees = node.initializer
    }

    node.forEachChild(find)
  })

  if (!trees) {
    throw new Error('ENGLISH_TREES is not an object literal in expo/hermie/src/i18n/trees.ts')
  }

  const out = new Map<string, Param[]>()
  const keyed = new Set<string>()

  const walk = (type: ts.Type, path: string, at: ts.Node): void => {
    if (checker.getIndexInfoOfType(type, ts.IndexKind.String)) {
      keyed.add(path)
    }

    for (const property of checker.getPropertiesOfType(type)) {
      const key = `${path}.${property.getName()}`
      const propertyType = checker.getTypeOfSymbolAtLocation(property, at)
      const [signature, ...more] = propertyType.getCallSignatures()

      if (signature) {
        if (more.length) {
          throw new Error(`${key}: overloaded string functions are not supported`)
        }

        out.set(
          key,
          signature.getParameters().map(parameter => {
            const declaration = parameter.valueDeclaration

            if (!declaration || !ts.isParameter(declaration)) {
              throw new Error(`${key}: cannot read parameter ${parameter.getName()}`)
            }

            if (declaration.dotDotDotToken) {
              throw new Error(`${key}: rest parameters are not supported`)
            }

            const text = checker.typeToString(checker.getTypeOfSymbolAtLocation(parameter, declaration))
            const { type, optional } = paramType(text, `${key}(${parameter.getName()})`)

            return {
              name: parameter.getName(),
              type,
              optional: optional || Boolean(declaration.questionToken) || Boolean(declaration.initializer)
            }
          })
        )

        continue
      }

      const isStringLike =
        propertyType.flags & ts.TypeFlags.StringLike ||
        checker.isArrayType(propertyType) ||
        checker.isTupleType(propertyType)

      if (!isStringLike && propertyType.flags & ts.TypeFlags.Object) {
        walk(propertyType, key, at)
      }
    }
  }

  for (const property of trees.properties) {
    if (!ts.isPropertyAssignment(property) || !ts.isIdentifier(property.name)) {
      throw new Error('ENGLISH_TREES must list its tables as `name: table`')
    }

    walk(checker.getTypeAtLocation(property.initializer), property.name.text, property.initializer)
  }

  return { functions: out, keyed }
}
