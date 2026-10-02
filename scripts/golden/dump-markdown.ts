/**
 * The Markdown block structure as data: `contract/markdown/`.
 *
 *   tsx scripts/golden/dump-markdown.ts --out <dir>
 *
 * For every input in `markdown-corpus.ts` this records what `@hermie/markdown`'s
 * `blockModelOf` reads from it: the preprocessed text and the block model, in a
 * neutral shape a port can produce without knowing anything about marked. The
 * shape and what is normalised in it are documented on `blockModelOf`
 * (`packages/markdown/src/block-model.ts`). Only the package's pure modules are
 * loaded; nothing from React Native is.
 *
 * `packages/markdown/src/contract.test.ts` replays the recorded files against
 * the same function, so the corpus and the package cannot drift apart unseen.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { blockModelOf, resetBlockCache } from '@hermie/markdown'

import { prettyJson } from './canonical-json'
import {
  BLOCK_CASES,
  INLINE_CASES,
  type MarkdownCase,
  PREPROCESS_CASES,
  STREAMING_DOCUMENTS,
  streamingPrefixes
} from './markdown-corpus'

function outDir(): string {
  const index = process.argv.indexOf('--out')
  const dir = index >= 0 ? process.argv[index + 1] : undefined

  if (!dir) {
    console.error('usage: dump-markdown.ts --out <dir>')
    process.exit(1)
  }

  return dir
}

function record(entry: MarkdownCase): unknown {
  resetBlockCache()

  const { preprocessed, blocks } = blockModelOf(entry.input)

  return { name: entry.name, input: entry.input, preprocessed, blocks }
}

const streaming: MarkdownCase[] = STREAMING_DOCUMENTS.flatMap(document =>
  streamingPrefixes(document.input).map(cut => ({
    name: `${document.name} @${cut}`,
    input: document.input.slice(0, cut)
  }))
)

const dir = join(outDir(), 'markdown')

mkdirSync(dir, { recursive: true })
writeFileSync(join(dir, 'blocks.json'), prettyJson(BLOCK_CASES.map(record)))
writeFileSync(join(dir, 'inline.json'), prettyJson(INLINE_CASES.map(record)))
writeFileSync(join(dir, 'preprocess.json'), prettyJson(PREPROCESS_CASES.map(record)))
writeFileSync(join(dir, 'streaming.json'), prettyJson(streaming.map(record)))
