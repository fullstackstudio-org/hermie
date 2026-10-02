/**
 * One top-level Markdown block.
 *
 * `MarkdownBlock` takes the block's SOURCE TEXT, not a token, and lexes it
 * itself. That is what makes the memo work: during streaming the text of every
 * settled block is byte-identical flush after flush, so `React.memo` on the raw
 * string keeps them all mounted and only the tail re-lexes.
 */
import { memo, useMemo } from 'react'
import { Text, View } from 'react-native'
import { marked, type Token, type Tokens } from './marked-compat'

import { CodeBlock } from './CodeBlock'
import { Inline } from './Inline'
import { OverflowScroll } from './OverflowScroll'
import { MONOSPACE, type MarkdownContext } from './context'
import { BlockMath } from './math/Math'
import { MATH_BLOCK_TOKEN, type MathToken } from './math/marked-math'
import { MERMAID_LANGUAGE, MermaidDiagram } from './mermaid/Mermaid'

const HEADING_SCALE = [1.5, 1.32, 1.18, 1.08, 1, 0.94]

function Blocks({ tokens, context }: { tokens: Token[]; context: MarkdownContext }) {
  return (
    <>
      {tokens.map((token, index) => (
        <BlockToken context={context} key={index} token={token} />
      ))}
    </>
  )
}

function ListBlock({ token, context }: { token: Tokens.List; context: MarkdownContext }) {
  return (
    <View style={{ gap: 4, marginVertical: 4 }}>
      {token.items.map((item, index) => {
        const marker = token.ordered ? `${Number(token.start || 1) + index}.` : '•'

        return (
          <View key={index} style={{ flexDirection: 'row', gap: 8 }}>
            <Text
              style={{
                color: context.mutedTextColor,
                fontSize: context.fontSize,
                lineHeight: context.lineHeight,
                minWidth: token.ordered ? 22 : 14
              }}
            >
              {item.task ? (item.checked ? '☑' : '☐') : marker}
            </Text>
            <View style={{ flex: 1 }}>
              {/* A loose item holds block tokens; a tight one holds inline
                  tokens under a single `text` token. */}
              <Blocks context={context} tokens={item.tokens} />
            </View>
          </View>
        )
      })}
    </View>
  )
}

/**
 * A column is as wide as its widest WORD, within reason.
 *
 * Every column used to be 150pt flat, which broke `docs.example.org` across two
 * lines mid-word and left a single orphaned letter under the row — an effect
 * that reads as a rendering fault rather than as a wrapped cell, and that the
 * fold's fade happened to land on in the report. A domain, a path or an id is
 * one word and wrapping it anywhere is wrong, so the width is derived instead
 * of fixed. The table already scrolls horizontally, which is what pays for it:
 * widening a column costs a scroll, not a squeeze on the column beside it.
 *
 * Estimated from the character count rather than measured, because measuring
 * means a layout pass per cell and a table that reflows after it is on screen.
 * Both bounds matter: the floor keeps a column of `on` / `off` from collapsing
 * to nothing, and the ceiling keeps a prose cell wrapping like prose.
 */
const TABLE_BORDER = 1
const COLUMN_MIN = 110
const COLUMN_MAX = 280
const COLUMN_PADDING = 20
/** A rough advance width per character for the body face, as a fraction of em. */
const CHARACTER_EM = 0.58
function columnWidth(cells: readonly string[], fontSize: number): number {
  // The longest CELL, not the longest word: `Registrar One` wrapping after
  // `Registrar` is a tidier fault than `docs.example.org` wrapping after the
  // `r`, but it is still a fault, and a column wide enough for the whole value
  // has neither.
  const characters = Math.max(...cells.map(cell => cell.length), 1)

  return Math.min(COLUMN_MAX, Math.max(COLUMN_MIN, Math.ceil(characters * fontSize * CHARACTER_EM) + COLUMN_PADDING))
}

/** Every column's width, derived once per table. */
export function tableColumnWidths(token: Tokens.Table, fontSize: number): number[] {
  return token.header.map((header, index) =>
    columnWidth([header.text, ...token.rows.map(row => row[index]?.text ?? '')], fontSize)
  )
}

/**
 * How wide the table wants to be, border included.
 *
 * EXACT rather than estimated, which is the difference from the code block:
 * this renderer chose the column widths itself, and a cell's box is
 * border-boxed, so the outer hairline on each side is the only thing the sum
 * misses. That is what lets the scroll-or-not decision be a comparison rather
 * than a guess.
 */
export function tableNaturalWidth(widths: readonly number[]): number {
  return widths.reduce((total, width) => total + width, 0) + TABLE_BORDER * 2
}

/**
 * Whether a table of this natural width has to scroll inside that much room.
 *
 * `false` where the room is unknown, so a caller that cannot measure keeps the
 * scrolling surface it had rather than being told the table fits.
 */
export function tableFitsInline(natural: number, contentWidth?: number): boolean {
  return contentWidth !== undefined && contentWidth > 0 && natural <= contentWidth
}

function TableBlock({ token, context }: { token: Tokens.Table; context: MarkdownContext }) {
  const widths = useMemo(() => tableColumnWidths(token, context.fontSize), [token, context.fontSize])
  const natural = tableNaturalWidth(widths)

  // A table that fits gets no scrolling surface at all. Not a tidiness
  // preference: a scroll view whose content fits still eats a drag that started
  // on it, and a two-column table is most of the tables an agent writes.
  const inline = tableFitsInline(natural, context.contentWidth)

  const cellStyle = {
    borderColor: context.borderColor,
    borderRightWidth: TABLE_BORDER,
    paddingHorizontal: 10,
    paddingVertical: 8
  } as const

  const frame = (
    <View
      style={{
        borderColor: context.borderColor,
        borderRadius: 10,
        borderWidth: TABLE_BORDER,
        overflow: 'hidden',
        width: natural
      }}
    >
      <View style={{ backgroundColor: context.blockBackground, flexDirection: 'row' }}>
        {token.header.map((cell, index) => (
          <View key={index} style={[cellStyle, { width: widths[index] }]}>
            <Inline
              context={context}
              style={{ fontWeight: '600', textAlign: cell.align ?? 'left' }}
              tokens={cell.tokens}
            />
          </View>
        ))}
      </View>

      {token.rows.map((row, rowIndex) => (
        <View key={rowIndex} style={{ borderColor: context.borderColor, borderTopWidth: 1, flexDirection: 'row' }}>
          {row.map((cell, cellIndex) => (
            <View key={cellIndex} style={[cellStyle, { width: widths[cellIndex] }]}>
              <Inline context={context} style={{ textAlign: cell.align ?? 'left' }} tokens={cell.tokens} />
            </View>
          ))}
        </View>
      ))}
    </View>
  )

  if (inline) {
    return <View style={{ marginVertical: 8 }}>{frame}</View>
  }

  return (
    <OverflowScroll
      {...(context.fadeColor ? { fadeTo: context.fadeColor } : {})}
      style={{ marginVertical: 8 }}
      testID="markdown-table-scroll"
      {...(context.contentWidth ? { width: context.contentWidth } : {})}
    >
      {frame}
    </OverflowScroll>
  )
}

function BlockToken({ token, context }: { token: Token; context: MarkdownContext }) {
  switch (token.type) {
    case 'space':
      return null

    case 'heading': {
      const heading = token as Tokens.Heading
      const scale = HEADING_SCALE[Math.min(heading.depth, HEADING_SCALE.length) - 1] ?? 1

      return (
        <View style={{ marginBottom: 4, marginTop: 10 }}>
          <Inline
            context={context}
            style={{
              fontSize: Math.round(context.fontSize * scale),
              fontWeight: '700',
              lineHeight: Math.round(context.lineHeight * scale)
            }}
            tokens={heading.tokens}
          />
        </View>
      )
    }

    case 'paragraph':
      return (
        <View style={{ marginVertical: 4 }}>
          <Inline context={context} tokens={(token as Tokens.Paragraph).tokens} />
        </View>
      )

    case 'text': {
      const text = token as Tokens.Text

      return text.tokens?.length ? (
        <Inline context={context} tokens={text.tokens} />
      ) : (
        <Text
          selectable={context.selectable}
          style={{ color: context.textColor, fontSize: context.fontSize, lineHeight: context.lineHeight }}
        >
          {text.text}
        </Text>
      )
    }

    case 'code': {
      const code = token as Tokens.Code
      const language = code.lang?.split(/\s/)[0] || undefined

      // A `mermaid` fence is a picture rather than a listing. The diagram
      // renderer answers with the same fenced listing when it cannot draw the
      // source, so an unsupported or malformed diagram is still readable — see
      // ADR-0020.
      if (language?.toLowerCase() === MERMAID_LANGUAGE) {
        return <MermaidDiagram context={context} source={code.text} />
      }

      return <CodeBlock code={code.text} context={context} {...(language ? { language } : {})} />
    }

    case MATH_BLOCK_TOKEN:
      return <BlockMath context={context} source={(token as MathToken).text} />

    case 'blockquote':
      return (
        <View
          style={{
            borderLeftColor: context.borderColor,
            borderLeftWidth: 3,
            marginVertical: 6,
            paddingLeft: 12
          }}
        >
          <Blocks context={context} tokens={(token as Tokens.Blockquote).tokens} />
        </View>
      )

    case 'list':
      return <ListBlock context={context} token={token as Tokens.List} />

    case 'table':
      return <TableBlock context={context} token={token as Tokens.Table} />

    case 'hr':
      return <View style={{ backgroundColor: context.borderColor, height: 1, marginVertical: 12 }} />

    case 'html':
      return (
        <Text
          selectable={context.selectable}
          style={{ color: context.mutedTextColor, fontFamily: MONOSPACE, fontSize: context.fontSize - 3 }}
        >
          {(token as Tokens.HTML).raw.trimEnd()}
        </Text>
      )

    default: {
      const raw = (token as { raw?: string }).raw ?? ''

      return raw.trim() ? (
        <Text
          selectable={context.selectable}
          style={{ color: context.textColor, fontSize: context.fontSize, lineHeight: context.lineHeight }}
        >
          {raw}
        </Text>
      ) : null
    }
  }
}

export interface MarkdownBlockProps {
  /** The block's own source slice, exactly as `splitBlocks` cut it. */
  raw: string
  context: MarkdownContext
}

/**
 * There is no streaming caret.
 *
 * There was one — a `▍` in the muted ink after the last block — and because a
 * `Text` sibling of the blocks is a block-level box, it landed on a LINE OF ITS
 * OWN under the reply: a small grey rectangle sitting in the bubble's last
 * paragraph's worth of empty space. The owner's verdict was "make it look right
 * or take it out", and there is nothing to make right: two other things already
 * say a reply is arriving, and both of them say it where a reader is already
 * looking. The dots are in the bubble until the first word lands, and the line
 * under the bot's name says Typing for the whole of it.
 */
function MarkdownBlockView({ raw, context }: MarkdownBlockProps) {
  const tokens = useMemo(() => marked.lexer(raw), [raw])

  if (!raw.trim()) {
    return null
  }

  return <Blocks context={context} tokens={tokens} />
}

/**
 * Memoized on `(raw, context)`. `context` is one frozen object from `Markdown`,
 * so in practice the raw string is the only thing that changes — which is
 * exactly the invariant the streaming path depends on, and with the caret gone a
 * settled block now renders exactly ONCE over a whole reply.
 */
export const MarkdownBlock = memo(MarkdownBlockView)
