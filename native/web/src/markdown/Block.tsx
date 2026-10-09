/**
 * Block tokens as React elements, and the memoised unit a streaming reply
 * re-renders: one top-level block of the message (`MarkdownBlock`).
 *
 * The elements made here are `p`, `h1`..`h6`, `ul`, `ol`, `li`, `input` (a
 * disabled checkbox on a task item), `blockquote`, `hr`, `pre`, the code block
 * and the table; the inline ones are in `Inline.tsx`. The cases follow the
 * Expo renderer's (`expo/hermie/src/markdown/Block.tsx`) and the block model in
 * `@hermie/markdown`, which `contract/markdown` records.
 */
import { marked, type Token, type Tokens } from '@hermie/markdown/marked-compat'
import { MATH_BLOCK_TOKEN, type MathToken } from '@hermie/markdown/math/marked-math'
import { createContext, memo, useContext, useMemo, type ReactNode } from 'react'

import { useLocale } from '../i18n/use-locale'
import { sheetStrings } from '../i18n/sheet-strings'
import { Alert, readAlert, useInAlert } from './Alert'
import { CodeBlock } from './CodeBlock'
import { Inline } from './Inline'
import { cardsRenderer, chartRenderer, mathRenderer, mermaidRenderer, useLazyModule } from './lazy'
import { Table } from './Table'

/** A fence in this language is a diagram (case-insensitive). */
export const MERMAID_LANGUAGE = 'mermaid'

/** The structured blocks of a reply (`docs/charts.md`, `contract/markup`): case does not matter, models capitalise. */
export const CHART_FENCE = 'hermie-chart'
export const CARDS_FENCE = 'hermie-cards'

/**
 * Whether the blocks that are more than text (a chart, cards, a callout) are drawn. They are in a reply and not in what
 * the owner typed: the owner's own bubble stays as typed, which is the native apps' rule too.
 */
export const RichBlocksContext = createContext(true)

/**
 * Whether a fenced code token ends in its closing fence. A fence that is still streaming (or never closed) is code:
 * a structured block is drawn when it closes and validates, so a reader never sees a half-drawn picture.
 */
export function isClosedFence(raw: string): boolean {
  const lines = raw.replace(/\s+$/u, '').split('\n')
  const opening = /^ {0,3}(`{3,}|~{3,})/u.exec(lines[0] ?? '')

  if (!opening || lines.length < 2) {
    return false
  }

  const fence = opening[1] as string
  // A backtick and a tilde mean themselves in a pattern: the closing line is the same character, at least as many.
  const closing = new RegExp(`^ {0,3}${fence[0]}{${fence.length},}[ \\t]*$`, 'u')

  return closing.test(lines[lines.length - 1] ?? '')
}

type Heading = 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6'

/**
 * Where a message's headings sit in the page they are drawn in.
 *
 * A message is inside a page that has its own `h1` (and, in a transcript, a date
 * `h2`), so a `#` in a reply must not become a second title: `offset` pushes
 * every heading down (`#` is an `h1` at 0 and an `h3` at 2) and `max` stops them
 * going deeper (an `h4` straight after an `h2` is a skipped level, which a reader
 * who moves by heading hears as a gap; a transcript caps at `h3`, so a message's
 * headings are all one level below the day they are under, whatever the author
 * wrote). The size still follows the depth that was written (`md-h<depth>`).
 */
export interface HeadingPlacement {
  offset: number
  max: number
}

export const HeadingPlacementContext = createContext<HeadingPlacement>({ offset: 0, max: 6 })

function MessageHeading({ depth, tokens, baseUrl }: { depth: number; tokens: Token[]; baseUrl: string | undefined }) {
  const { offset, max } = useContext(HeadingPlacementContext)
  const written = Math.min(Math.max(depth, 1), 6)
  const Tag = `h${Math.min(written + offset, max, 6)}` as Heading

  return (
    <Tag className={`md-h${written}`}>
      <Inline baseUrl={baseUrl} tokens={tokens} />
    </Tag>
  )
}

/**
 * `$$…$$`: drawn once the mathematics chunk is there, its source in a code block
 * until then (which is also what the drawing falls back to for source it
 * cannot draw).
 */
function MathBlock({ source }: { source: string }) {
  const math = useLazyModule(mathRenderer)

  return math ? <math.BlockMath source={source} /> : <CodeBlock code={source.trim()} kind="math" label="LaTeX" />
}

/** A ```mermaid fence: drawn once the Mermaid chunk is there, its source until then. */
function MermaidBlock({ source }: { source: string }) {
  const mermaid = useLazyModule(mermaidRenderer)

  return mermaid ? (
    <mermaid.MermaidDiagram source={source} />
  ) : (
    <CodeBlock code={source} kind="mermaid" label={MERMAID_LANGUAGE} />
  )
}

/** The code block a structured fence is until its renderer has arrived, and whenever it is not drawn. */
function PlainFence({ source, language }: { source: string; language: string | undefined }) {
  return <CodeBlock code={source} {...(language ? { language } : {})} />
}

/** A ```hermie-chart fence: the chart once its chunk is there and the block validates, the code block until then. */
function ChartFence({ source, language }: { source: string; language: string | undefined }) {
  const chart = useLazyModule(chartRenderer)

  return chart ? (
    <chart.ChartDiagram language={language} source={source} />
  ) : (
    <PlainFence language={language} source={source} />
  )
}

/** A ```hermie-cards fence: the cards once their chunk is there and the block validates, the code block until then. */
function CardsFence({ source, language }: { source: string; language: string | undefined }) {
  const cards = useLazyModule(cardsRenderer)

  return cards ? (
    <cards.CardsDiagram language={language} source={source} />
  ) : (
    <PlainFence language={language} source={source} />
  )
}

/** A fence in a structured language: drawn where blocks are drawn and the fence is closed, code otherwise. */
function StructuredFence({
  fence,
  source,
  language,
  closed
}: {
  fence: typeof CHART_FENCE | typeof CARDS_FENCE
  source: string
  language: string | undefined
  closed: boolean
}) {
  const draws = useContext(RichBlocksContext)

  if (!draws || !closed) {
    return <PlainFence language={language} source={source} />
  }

  return fence === CHART_FENCE ? (
    <ChartFence language={language} source={source} />
  ) : (
    <CardsFence language={language} source={source} />
  )
}

/** A quote, or a callout when its first line is an alert marker (and it is not inside a callout already). */
function Quote({ token, baseUrl }: { token: Tokens.Blockquote; baseUrl: string | undefined }) {
  const draws = useContext(RichBlocksContext)
  const inAlert = useInAlert()
  const alert = useMemo(() => (draws && !inAlert ? readAlert(token) : undefined), [draws, inAlert, token])

  if (alert) {
    return <Alert kind={alert.kind}>{renderBlocks(alert.body, baseUrl, false)}</Alert>
  }

  return <blockquote>{renderBlocks(token.tokens, baseUrl, false)}</blockquote>
}

function ListItem({ item, baseUrl }: { item: Tokens.ListItem; baseUrl: string | undefined }) {
  useLocale()

  return (
    <li className={item.task ? 'md-task' : undefined}>
      {item.task ? (
        <input
          aria-label={item.checked ? sheetStrings.markdown.taskDone : sheetStrings.markdown.taskOpen}
          checked={Boolean(item.checked)}
          disabled
          type="checkbox"
        />
      ) : null}
      {renderBlocks(item.tokens, baseUrl, true)}
    </li>
  )
}

function List({ token, baseUrl }: { token: Tokens.List; baseUrl: string | undefined }) {
  const items = token.items.map((item, index) => <ListItem baseUrl={baseUrl} item={item} key={index} />)

  if (!token.ordered) {
    return <ul>{items}</ul>
  }

  const start = Number(token.start || 1)

  return <ol {...(start !== 1 ? { start } : {})}>{items}</ol>
}

/**
 * `tight` is true inside a list item: a tight item holds its words as a `text`
 * token, which belongs to the item itself and is not wrapped in a paragraph.
 */
function renderBlock(token: Token, index: number, baseUrl: string | undefined, tight: boolean): ReactNode {
  switch (token.type) {
    case 'space':
    case 'checkbox':
    case 'def':
      return null

    case 'heading': {
      const heading = token as Tokens.Heading

      return <MessageHeading baseUrl={baseUrl} depth={heading.depth} key={index} tokens={heading.tokens} />
    }

    case 'paragraph':
      return (
        <p key={index}>
          <Inline baseUrl={baseUrl} tokens={(token as Tokens.Paragraph).tokens} />
        </p>
      )

    case 'text': {
      const text = token as Tokens.Text
      const body = text.tokens?.length ? <Inline baseUrl={baseUrl} tokens={text.tokens} /> : text.text

      return tight ? (
        <span className="md-item-text" key={index}>
          {body}
        </span>
      ) : (
        <p key={index}>{body}</p>
      )
    }

    case 'code': {
      const code = token as Tokens.Code
      // The first word of the info string.
      const language = code.lang?.split(/\s/)[0] || undefined

      if (language?.toLowerCase() === MERMAID_LANGUAGE) {
        return <MermaidBlock key={index} source={code.text} />
      }

      const structured = language?.toLowerCase()

      if (structured === CHART_FENCE || structured === CARDS_FENCE) {
        return (
          <StructuredFence
            closed={isClosedFence(code.raw)}
            fence={structured}
            key={index}
            language={language}
            source={code.text}
          />
        )
      }

      return <CodeBlock code={code.text} key={index} {...(language ? { language } : {})} />
    }

    case MATH_BLOCK_TOKEN:
      return <MathBlock key={index} source={(token as unknown as MathToken).text} />

    case 'blockquote':
      return <Quote baseUrl={baseUrl} key={index} token={token as Tokens.Blockquote} />

    case 'list':
      return <List baseUrl={baseUrl} key={index} token={token as Tokens.List} />

    case 'table':
      return <Table baseUrl={baseUrl} key={index} token={token as Tokens.Table} />

    case 'hr':
      return <hr key={index} />

    // Raw HTML is text, in the monospace the agent would have typed it in.
    case 'html':
      return (
        <pre className="md-html" key={index}>
          {(token as Tokens.HTML).raw.trimEnd()}
        </pre>
      )

    default: {
      // An unknown token is shown as its source.
      const raw = (token as { raw?: string }).raw ?? ''

      return raw.trim() ? <p key={index}>{raw}</p> : null
    }
  }
}

export function renderBlocks(tokens: Token[], baseUrl: string | undefined, tight: boolean): ReactNode[] {
  return tokens.map((token, index) => renderBlock(token, index, baseUrl, tight))
}

export interface MarkdownBlockProps {
  /** The source slice `splitBlocks` cut this block from. */
  raw: string
  baseUrl: string | undefined
}

function MarkdownBlockView({ raw, baseUrl }: MarkdownBlockProps) {
  // Lexed once per source; a settled block of a streaming reply never lexes again.
  const tokens = useMemo(() => marked.lexer(raw), [raw])

  return <>{renderBlocks(tokens, baseUrl, false)}</>
}

/** Re-renders only when its source (or the base URL) changes. */
export const MarkdownBlock = memo(MarkdownBlockView)
