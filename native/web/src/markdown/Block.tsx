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
import { marked, MATH_BLOCK_TOKEN, type MathToken, type Token, type Tokens } from '@hermie/markdown'
import { createContext, memo, useContext, useMemo, type ReactNode } from 'react'

import { useLocale } from '../i18n/use-locale'
import { webStrings } from '../i18n/web-strings'
import { CodeBlock } from './CodeBlock'
import { Inline } from './Inline'
import { mathRenderer, useLazyModule } from './lazy'
import { Table } from './Table'

/** A fence in this language is a diagram (case-insensitive). */
export const MERMAID_LANGUAGE = 'mermaid'

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

function ListItem({ item, baseUrl }: { item: Tokens.ListItem; baseUrl: string | undefined }) {
  useLocale()

  return (
    <li className={item.task ? 'md-task' : undefined}>
      {item.task ? (
        <input
          aria-label={item.checked ? webStrings.markdown.taskDone : webStrings.markdown.taskOpen}
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
        return <CodeBlock code={code.text} key={index} kind="mermaid" label={MERMAID_LANGUAGE} />
      }

      return <CodeBlock code={code.text} key={index} {...(language ? { language } : {})} />
    }

    case MATH_BLOCK_TOKEN:
      return <MathBlock key={index} source={(token as unknown as MathToken).text} />

    case 'blockquote':
      return <blockquote key={index}>{renderBlocks((token as Tokens.Blockquote).tokens, baseUrl, false)}</blockquote>

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
