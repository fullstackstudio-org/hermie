/**
 * Gives every transcript test file recording copies of the engine modules.
 *
 * A test's relative import of an engine module (`./reducer`, `./types`, …) is
 * redirected to a generated module that re-exports the real one with each
 * function wrapped by `recorder.ts`. Only imports made BY a test file are
 * redirected: the engine's own modules keep importing each other directly, so
 * a call one engine function makes to another is never seen as a test's call.
 * That, plus the recorder's depth counter, is what keeps the corpus to the
 * top-level calls a port has to answer.
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

import type { Plugin } from 'vite'

import { runtimeExportsOf } from './exports'

const QUERY = '?golden-wrap'

export function goldenWrap(options: { srcDir: string; recorder: string }): Plugin {
  const srcDir = resolve(options.srcDir)

  /** The engine's public modules: what `index.ts` re-exports. */
  const publicModules = new Set(
    [...readFileSync(resolve(srcDir, 'index.ts'), 'utf8').matchAll(/^export \* from '\.\/([\w-]+)'$/gmu)].map(match =>
      resolve(srcDir, `${match[1]}.ts`)
    )
  )

  return {
    name: 'hermie-golden-wrap',
    enforce: 'pre',
    resolveId(source, importer) {
      if (!importer || !importer.endsWith('.test.ts') || !source.startsWith('.')) {
        return null
      }

      const importerPath = importer.split('?')[0] ?? importer

      if (dirname(importerPath) !== srcDir) {
        return null
      }

      const target = resolve(srcDir, source.endsWith('.ts') ? source : `${source}.ts`)

      return publicModules.has(target) ? `${target}${QUERY}` : null
    },
    load(id) {
      if (!id.endsWith(QUERY)) {
        return null
      }

      const target = id.slice(0, -QUERY.length)
      const exports = runtimeExportsOf(target, readFileSync(target, 'utf8'))
      const lines = [
        `import * as real from ${JSON.stringify(target)}`,
        `import { wrapExport } from ${JSON.stringify(options.recorder)}`,
        `export * from ${JSON.stringify(target)}`
      ]

      for (const entry of exports) {
        const nowIndex = entry.nowIndex === undefined ? 'undefined' : String(entry.nowIndex)

        lines.push(
          `export const ${entry.name} = wrapExport(${JSON.stringify(entry.name)}, real.${entry.name}, ${JSON.stringify(entry.kind)}, ${nowIndex})`
        )
      }

      return `${lines.join('\n')}\n`
    }
  }
}
