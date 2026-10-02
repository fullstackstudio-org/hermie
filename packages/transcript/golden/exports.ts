/**
 * What a module of the engine exports at run time, read off its source.
 *
 * The recorder needs two facts per export before the module runs: whether it is
 * a plain function (wrap it), a class (leave it, `new` must keep working) or a
 * value (pass it through), and — for a function — the position of a parameter
 * named `now`, so a call that leaned on the `Date.now()` default can be written
 * down with the instant it actually used.
 */
import ts from 'typescript'

export interface ExportInfo {
  name: string
  kind: 'function' | 'class' | 'value'
  /** Index of the `now` parameter, when the function has one. */
  nowIndex?: number
}

function nowIndexOf(parameters: ts.NodeArray<ts.ParameterDeclaration>): number | undefined {
  const index = parameters.findIndex(parameter => ts.isIdentifier(parameter.name) && parameter.name.text === 'now')

  return index < 0 ? undefined : index
}

function isExported(node: ts.Node): boolean {
  return (
    ts.canHaveModifiers(node) &&
    (ts.getModifiers(node) ?? []).some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)
  )
}

export function runtimeExportsOf(fileName: string, source: string): ExportInfo[] {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.ES2022, false, ts.ScriptKind.TS)
  const out: ExportInfo[] = []

  for (const statement of file.statements) {
    if (ts.isExportDeclaration(statement)) {
      // Re-exports would hide a function behind a name this parse cannot see.
      // The engine has none outside `index.ts`; fail loudly if one appears.
      if (!statement.isTypeOnly) {
        throw new Error(`${fileName}: re-exports are not supported by the golden recorder`)
      }

      continue
    }

    if (!isExported(statement)) {
      continue
    }

    if (ts.isFunctionDeclaration(statement) && statement.name) {
      out.push({ name: statement.name.text, kind: 'function', nowIndex: nowIndexOf(statement.parameters) })
    } else if (ts.isClassDeclaration(statement) && statement.name) {
      out.push({ name: statement.name.text, kind: 'class' })
    } else if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name)) {
          throw new Error(`${fileName}: destructured exports are not supported by the golden recorder`)
        }

        const init = declaration.initializer
        const fn = init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) ? init : undefined

        out.push(
          fn
            ? { name: declaration.name.text, kind: 'function', nowIndex: nowIndexOf(fn.parameters) }
            : { name: declaration.name.text, kind: 'value' }
        )
      }
    } else if (ts.isEnumDeclaration(statement)) {
      out.push({ name: statement.name.text, kind: 'value' })
    }
  }

  return out
}
