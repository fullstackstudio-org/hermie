/**
 * `src/__fixtures__/{events,rows}.ts` as JSON: `contract/transcript/fixtures/`.
 *
 * Each file is one object keyed by export name. A fixture that is a function
 * (a template, not data) has no JSON form; it is listed under `"$functions"`
 * so a reader knows it exists and was left out on purpose.
 *
 *   tsx packages/transcript/golden/dump-fixtures.ts --out <dir>
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { prettyJson } from '../../../scripts/golden/canonical-json'
import * as events from '../src/__fixtures__/events'
import * as rows from '../src/__fixtures__/rows'

function outDir(): string {
  const index = process.argv.indexOf('--out')
  const dir = index >= 0 ? process.argv[index + 1] : undefined

  if (!dir) {
    console.error('usage: dump-fixtures.ts --out <dir>')
    process.exit(1)
  }

  return dir
}

function dump(module: Record<string, unknown>): Record<string, unknown> {
  const data: Record<string, unknown> = {}
  const functions: string[] = []

  for (const [name, value] of Object.entries(module)) {
    if (typeof value === 'function') {
      functions.push(name)
    } else {
      data[name] = value
    }
  }

  return functions.length ? { ...data, $functions: functions.sort() } : data
}

const dir = join(outDir(), 'transcript', 'fixtures')

mkdirSync(dir, { recursive: true })
writeFileSync(join(dir, 'events.json'), prettyJson(dump(events)))
writeFileSync(join(dir, 'rows.json'), prettyJson(dump(rows)))
