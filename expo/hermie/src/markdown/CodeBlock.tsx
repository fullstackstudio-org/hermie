/**
 * A fenced code block: language label, then the listing on one horizontally
 * scrollable surface.
 *
 * No wrapping. A wrapped line in a listing reads as two statements, and the
 * design board puts code in a scrollable row for exactly that reason.
 *
 * The box is sized rather than left to hug its listing. A `ScrollView` with no
 * frame of its own comes out as wide as its content and therefore has nothing
 * to scroll — see `OverflowScroll`, which has the measurement — so a long
 * `curl` line used to run off the bubble's edge and stop there.
 */
import { memo, useMemo } from 'react'
import { Text, View } from 'react-native'

import { MONO_ADVANCE, MONOSPACE, type MarkdownContext } from './context'
import { OverflowScroll } from './OverflowScroll'
import { codeScopeColor } from './code-theme'
import { highlightToLines } from './highlight'

export interface CodeBlockProps {
  code: string
  language?: string
  context: MarkdownContext
}

/** The listing's own inset, both sides, and the box's hairline, both sides. */
const CODE_PADDING = 12
const CODE_BORDER = 1

/** The listing's size, which is smaller than the body's. */
function codeFontSize(bodyFontSize: number): number {
  return Math.max(11, bodyFontSize - 4)
}

/**
 * How wide the listing wants to be, in points.
 *
 * ESTIMATED from the longest line's character count, unlike the table's exact
 * sum: measuring means a hidden `Text` and a layout pass per block, and a
 * listing that reflows after it is on screen is worse than a box a few points
 * off. Both failure directions are harmless, which is what makes the estimate
 * acceptable — the box is given `min(natural, room)` either way, so it never
 * escapes the bubble, and the only cost of a bad guess is a little slack inside
 * a box that already scrolls.
 *
 * By code POINT, so a line of emoji or CJK is not counted as its UTF-16 units.
 * Those faces are wider than 0.6 em and this will under-read them; the slack
 * lands inside the scroll, which is the direction that does not clip.
 */
export function codeNaturalWidth(code: string, fontSize: number): number {
  const longest = code.split('\n').reduce((most, line) => Math.max(most, [...line].length), 0)

  return Math.ceil(longest * fontSize * MONO_ADVANCE) + CODE_PADDING * 2 + CODE_BORDER * 2
}

function CodeBlockView({ code, language, context }: CodeBlockProps) {
  const listing = code.replace(/\n$/, '')
  const lines = useMemo(() => highlightToLines(listing, language), [listing, language])
  const fontSize = codeFontSize(context.fontSize)
  const natural = codeNaturalWidth(listing, fontSize)
  // `min`, not `room`: a two-word listing keeps hugging its own line rather
  // than stretching an empty slab across the bubble.
  const box = context.contentWidth ? Math.min(natural, context.contentWidth) : undefined

  return (
    <View
      style={{
        backgroundColor: context.blockBackground,
        borderColor: context.borderColor,
        borderRadius: 12,
        borderWidth: CODE_BORDER,
        marginVertical: 8,
        overflow: 'hidden',
        // Where the room is unknown the box keeps hugging its listing, which is
        // what it did before — wrong for a long line, and not made wronger by a
        // guess at a width nobody measured.
        ...(box ? { width: box } : {})
      }}
    >
      {language ? (
        <View
          style={{
            borderBottomColor: context.borderColor,
            borderBottomWidth: 1,
            paddingHorizontal: CODE_PADDING,
            paddingVertical: 6
          }}
        >
          <Text style={{ color: context.mutedTextColor, fontSize: 11, letterSpacing: 0.6 }}>
            {language.toUpperCase()}
          </Text>
        </View>
      ) : null}

      <OverflowScroll
        contentContainerStyle={{ padding: CODE_PADDING }}
        // The listing sits ON the block surface, so that is what its edge
        // dissolves into — not the bubble behind the block.
        fadeTo={context.blockBackground}
        testID="markdown-code-scroll"
        // Spelled out rather than left to stretch into the box above. A scroll
        // view is the one child that will not take a parent's width for itself
        // — that is the whole of the bug in `OverflowScroll`'s note — so the
        // one number it trusts is its own.
        {...(box ? { width: box - CODE_BORDER * 2 } : {})}
      >
        <Text selectable={context.selectable} style={{ fontFamily: MONOSPACE, fontSize, lineHeight: fontSize * 1.45 }}>
          {lines.map((spans, lineIndex) => (
            <Text key={lineIndex}>
              {lineIndex > 0 ? '\n' : ''}
              {spans.length ? (
                spans.map((span, spanIndex) => (
                  <Text
                    key={spanIndex}
                    style={{ color: codeScopeColor(span.scope, context.scheme) ?? context.textColor }}
                  >
                    {span.text}
                  </Text>
                ))
              ) : (
                <Text> </Text>
              )}
            </Text>
          ))}
        </Text>
      </OverflowScroll>
    </View>
  )
}

export const CodeBlock = memo(CodeBlockView)
