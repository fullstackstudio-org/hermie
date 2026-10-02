/**
 * The block model: what a Markdown renderer draws, in a shape that does not
 * mention `marked`.
 *
 * `blockModelOf` runs exactly what a renderer runs (`preprocessMarkdown`,
 * `splitBlocks`, then `marked.lexer` per block) and reduces the tokens to a
 * small tree. It is the shape `contract/markdown/` records, so a port, or a
 * renderer's structure test, can compare against the corpus without knowing
 * anything about the lexer.
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
 * What is normalised, and why it is not a judgement about any renderer:
 *
 * - marked's `text` block token (a tight list item's body) is a paragraph; the
 *   renderers draw both the same way.
 * - `start` is only written for an ordered list; `checked` only for a task item.
 * - Inline runs are flattened: adjacent runs with the same marks and link are
 *   merged, and a `br` token is the text `"\n"`. A soft break is the `"\n"` that
 *   marked leaves inside its text.
 * - A math run carries the LaTeX source, the way a math block does; drawing it
 *   is the renderer's business.
 *
 * `blockModelOf` does not touch the block cache; call `resetBlockCache` first
 * when the result must not depend on what was rendered before.
 */
import { splitBlocks } from './blocks'
import { marked, type Token, type Tokens } from './marked-compat'
import type { MathToken } from './math/marked-math'
import { preprocessMarkdown } from './preprocess'

export type Mark = 'bold' | 'code' | 'italic' | 'math' | 'strike'

export interface Run {
  text: string
  marks?: Mark[]
  link?: string
}

export type Block =
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
        // The first word of the info string.
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
        // An unknown token is shown as its source, in a paragraph.
        const raw = (token as { raw?: string }).raw ?? ''

        if (raw.trim()) {
          out.push({ kind: 'paragraph', inline: [{ text: raw }] })
        }
      }
    }
  }

  return out
}

export interface BlockModel {
  /** What `preprocessMarkdown` made of the input. */
  preprocessed: string
  blocks: Block[]
}

/** The block model of one Markdown text, the way a renderer reads it. */
export function blockModelOf(markdown: string): BlockModel {
  const preprocessed = preprocessMarkdown(markdown)
  // Whitespace-only slices render nothing, exactly as a renderer skips them.
  const blocks = splitBlocks(preprocessed)
    .filter(raw => raw.trim())
    .flatMap(raw => blocksOf(marked.lexer(raw)))

  return { preprocessed, blocks }
}
