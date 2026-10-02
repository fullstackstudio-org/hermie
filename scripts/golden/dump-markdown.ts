/**
 * The Expo app's Markdown block structure as data: `contract/markdown/`.
 *
 *   tsx scripts/golden/dump-markdown.ts --out <dir>
 *
 * For every input in `markdown-corpus.ts` this runs exactly what `<Markdown>`
 * runs — `preprocessMarkdown`, `splitBlocks`, then `marked.lexer` per block —
 * and writes the tokens in a neutral shape a port can produce without knowing
 * anything about marked. It imports only the pure modules (`preprocess.ts`,
 * `blocks.ts`, `marked-compat.ts`); nothing from React Native is loaded and the
 * TypeScript sources are not changed.
 *
 * The neutral shape, one entry per case:
 *
 *   { name, input, preprocessed, blocks: [Block] }
 *
 *   Block = { kind: 'paragraph', inline }
 *         | { kind: 'heading', level, inline }
 *         | { kind: 'list', ordered, start?, items: [{ checked?, blocks }] }
 *         | { kind: 'quote', blocks }
 *         | { kind: 'table', align: ['left' | 'center' | 'right' | null], header: [inline], rows: [[inline]] }
 *         | { kind: 'code', language?, text }
 *         | { kind: 'mermaid', text }
 *         | { kind: 'math', text }
 *         | { kind: 'rule' }
 *         | { kind: 'html', text }
 *   inline = [{ text, marks?: ['bold' | 'code' | 'italic' | 'math' | 'strike'], link? }]
 *
 * What is normalised, and why it is not a judgement about the TS behaviour:
 *
 * - marked's `text` block token (a tight list item's body) is a paragraph; the
 *   renderer draws both the same way.
 * - `start` is only written for an ordered list; `checked` only for a task item.
 * - Inline runs are flattened: adjacent runs with the same marks and link are
 *   merged, and a `br` token is the text `"\n"`. A soft break is the `"\n"` that
 *   marked leaves inside its text, which is also what the app shows.
 * - A math run carries the LaTeX source, the way a math block does; drawing it
 *   is the port's business.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { resetBlockCache, splitBlocks } from '../../expo/hermie/src/markdown/blocks'
import { marked, type Token, type Tokens } from '../../expo/hermie/src/markdown/marked-compat'
import type { MathToken } from '../../expo/hermie/src/markdown/math/marked-math'
import { preprocessMarkdown } from '../../expo/hermie/src/markdown/preprocess'
import { prettyJson } from './canonical-json'
import {
  BLOCK_CASES,
  INLINE_CASES,
  type MarkdownCase,
  PREPROCESS_CASES,
  STREAMING_DOCUMENTS,
  streamingPrefixes
} from './markdown-corpus'

type Mark = 'bold' | 'code' | 'italic' | 'math' | 'strike'

interface Run {
  text: string
  marks?: Mark[]
  link?: string
}

type Block =
  | { kind: 'paragraph'; inline: Run[] }
  | { kind: 'heading'; level: number; inline: Run[] }
  | { kind: 'list'; ordered: boolean; start?: number; items: { checked?: boolean; blocks: Block[] }[] }
  | { kind: 'quote'; blocks: Block[] }
  | { kind: 'table'; align: (string | null)[]; header: Run[][]; rows: Run[][][] }
  | { kind: 'code'; language?: string; text: string }
  | { kind: 'mermaid'; text: string }
  | { kind: 'math'; text: string }
  | { kind: 'rule' }
  | { kind: 'html'; text: string }

function outDir(): string {
  const index = process.argv.indexOf('--out')
  const dir = index >= 0 ? process.argv[index + 1] : undefined

  if (!dir) {
    console.error('usage: dump-markdown.ts --out <dir>')
    process.exit(1)
  }

  return dir
}

interface Style {
  marks: Mark[]
  link?: string
}

function push(runs: Run[], text: string, style: Style): void {
  if (!text) {
    return
  }

  const marks = [...new Set(style.marks)].sort()
  const last = runs.at(-1)
  const sameMarks = (last?.marks ?? []).join(',') === marks.join(',')

  if (last && sameMarks && last.link === style.link) {
    last.text += text

    return
  }

  runs.push({
    text,
    ...(marks.length ? { marks } : {}),
    ...(style.link !== undefined ? { link: style.link } : {})
  })
}

function inlineRuns(tokens: Token[], style: Style, runs: Run[]): Run[] {
  for (const token of tokens) {
    const nested = (token as { tokens?: Token[] }).tokens
    const withMark = (mark: Mark): Style => ({ ...style, marks: [...style.marks, mark] })

    switch (token.type) {
      case 'strong':
        inlineRuns(nested ?? [], withMark('bold'), runs)
        break
      case 'em':
        inlineRuns(nested ?? [], withMark('italic'), runs)
        break
      case 'del':
        inlineRuns(nested ?? [], withMark('strike'), runs)
        break
      case 'codespan':
        push(runs, (token as Tokens.Codespan).text, withMark('code'))
        break
      case 'mathInline':
        push(runs, (token as unknown as MathToken).text, withMark('math'))
        break
      case 'br':
        push(runs, '\n', style)
        break
      case 'link':
        inlineRuns(nested ?? [], { ...style, link: (token as Tokens.Link).href }, runs)
        break
      case 'checkbox':
        break
      case 'html':
        push(runs, (token as Tokens.HTML).raw, style)
        break
      case 'image':
        push(runs, (token as Tokens.Image).text, style)
        break
      default:
        if (nested?.length) {
          inlineRuns(nested, style, runs)
        } else {
          push(runs, (token as { text?: string }).text ?? (token as { raw?: string }).raw ?? '', style)
        }
    }
  }

  return runs
}

function inline(tokens: Token[] | undefined): Run[] {
  return inlineRuns(tokens ?? [], { marks: [] }, [])
}

function blocksOf(tokens: Token[]): Block[] {
  const out: Block[] = []

  for (const token of tokens) {
    switch (token.type) {
      case 'space':
      case 'checkbox':
      case 'def':
        break
      case 'paragraph':
      case 'text':
        out.push({ kind: 'paragraph', inline: inline((token as Tokens.Paragraph).tokens) })
        break
      case 'heading': {
        const heading = token as Tokens.Heading

        out.push({ kind: 'heading', level: heading.depth, inline: inline(heading.tokens) })
        break
      }
      case 'list': {
        const list = token as Tokens.List

        out.push({
          kind: 'list',
          ordered: list.ordered,
          ...(list.ordered ? { start: Number(list.start || 1) } : {}),
          items: list.items.map(item => ({
            ...(item.task ? { checked: Boolean(item.checked) } : {}),
            blocks: blocksOf(item.tokens)
          }))
        })
        break
      }
      case 'blockquote':
        out.push({ kind: 'quote', blocks: blocksOf((token as Tokens.Blockquote).tokens) })
        break
      case 'table': {
        const table = token as Tokens.Table

        out.push({
          kind: 'table',
          align: table.align.map(align => align ?? null),
          header: table.header.map(cell => inline(cell.tokens)),
          rows: table.rows.map(row => row.map(cell => inline(cell.tokens)))
        })
        break
      }
      case 'code': {
        const code = token as Tokens.Code
        // The same reading `Block.tsx` does: the first word of the info string.
        const language = code.lang?.split(/\s/)[0] || undefined

        if (language?.toLowerCase() === 'mermaid') {
          out.push({ kind: 'mermaid', text: code.text })
        } else {
          out.push({ kind: 'code', ...(language ? { language } : {}), text: code.text })
        }

        break
      }
      case 'mathBlock':
        out.push({ kind: 'math', text: (token as unknown as MathToken).text })
        break
      case 'hr':
        out.push({ kind: 'rule' })
        break
      case 'html':
        out.push({ kind: 'html', text: (token as Tokens.HTML).raw.trimEnd() })
        break
      default: {
        // `Block.tsx` prints an unknown token's source as a paragraph.
        const raw = (token as { raw?: string }).raw ?? ''

        if (raw.trim()) {
          out.push({ kind: 'paragraph', inline: [{ text: raw }] })
        }
      }
    }
  }

  return out
}

function record(entry: MarkdownCase): unknown {
  resetBlockCache()

  const preprocessed = preprocessMarkdown(entry.input)
  // Whitespace-only slices render nothing, exactly as `MarkdownBlock` skips them.
  const blocks = splitBlocks(preprocessed)
    .filter(raw => raw.trim())
    .flatMap(raw => blocksOf(marked.lexer(raw)))

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
