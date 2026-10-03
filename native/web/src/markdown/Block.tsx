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
import { memo, useMemo, type ReactNode } from 'react'

import { useLocale } from '../i18n/use-locale'
import { webStrings } from '../i18n/web-strings'
import { CodeBlock } from './CodeBlock'
import { Inline } from './Inline'
import { Table } from './Table'

/** A fence in this language is a diagram (case-insensitive). */
export const MERMAID_LANGUAGE = 'mermaid'

type Heading = 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6'

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
      const Tag = `h${Math.min(Math.max(heading.depth, 1), 6)}` as Heading

      return (
        <Tag key={index}>
          <Inline baseUrl={baseUrl} tokens={heading.tokens} />
        </Tag>
      )
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
      return <CodeBlock code={(token as unknown as MathToken).text.trim()} key={index} kind="math" label="LaTeX" />

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
