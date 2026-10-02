/**
 * The recorded Markdown corpus, replayed against this package.
 *
 * `contract/markdown/*.json` is what `npm run golden` records from
 * `blockModelOf`; the native client's tests read the same files and must
 * produce the same structure. Replaying them here means a change to the lexer
 * setup, the preprocessor or the block splitter that moves any recorded
 * structure fails in this package first, with the case named, before the
 * generator's `--check` or the native suites say anything.
 *
 * The comparison is on JSON values, which is the canonical-JSON comparison the
 * generator makes: object key order carries no meaning there.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { beforeEach, describe, expect, it } from 'vitest'

import { blockModelOf } from './block-model'
import { resetBlockCache } from './blocks'

interface RecordedCase {
  name: string
  input: string
  preprocessed: string
  blocks: unknown[]
}

const FILES = ['blocks', 'inline', 'preprocess', 'streaming'] as const

function recorded(file: string): RecordedCase[] {
  const path = fileURLToPath(new URL(`../../../contract/markdown/${file}.json`, import.meta.url))

  return JSON.parse(readFileSync(path, 'utf8')) as RecordedCase[]
}

describe('contract/markdown replay', () => {
  beforeEach(() => {
    resetBlockCache()
  })

  for (const file of FILES) {
    describe(`${file}.json`, () => {
      const cases = recorded(file)

      it('records cases', () => {
        expect(cases.length).toBeGreaterThan(0)
      })

      it.each(cases.map(entry => [entry.name, entry] as const))('%s', (_name, entry) => {
        resetBlockCache()

        const { preprocessed, blocks } = blockModelOf(entry.input)

        // Through JSON, so `undefined` fields compare the way the file holds them.
        expect(JSON.parse(JSON.stringify({ preprocessed, blocks }))).toEqual({
          preprocessed: entry.preprocessed,
          blocks: entry.blocks
        })
      })
    })
  }
})
