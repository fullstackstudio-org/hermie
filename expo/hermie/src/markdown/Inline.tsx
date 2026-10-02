/**
 * Inline token rendering.
 *
 * Everything nests inside one `Text`, which is what makes a bold word inside a
 * sentence wrap with the sentence instead of becoming its own box. Only images
 * break out, because an `Image` cannot live inside a `Text` on Android.
 */
import { Fragment, useState, type ReactNode } from 'react'
import { Image, StyleSheet, Text, type TextStyle, View } from 'react-native'
import type { Token, Tokens } from './marked-compat'

import { anchorProps } from '../platform/link-anchor'
import { isOpenableLink, MONO_ADVANCE, MONOSPACE, resolveImageUri, type MarkdownContext } from './context'
import { inlineMathRuns, MathRunsText } from './math/Math'
import { MATH_INLINE_TOKEN, type MathToken } from './math/marked-math'

export interface InlineProps {
  tokens: Token[]
  context: MarkdownContext
  style?: TextStyle
}

/**
 * The chip's fake horizontal padding. React Native will not apply padding to a
 * `Text` nested inside a `Text`, so the padding has to be characters — and they
 * are NON-BREAKING on purpose. Do not "tidy" this back into a normal space.
 *
 * A background-coloured nested `Text` paints EVERY line fragment of its range,
 * and a fragment that holds only the line's trailing whitespace is painted
 * across the whole rest of the line. So a chip that broke on its own ASCII
 * padding space drew a full-width empty bar at the end of the previous line and
 * then the real chip on the next one. Non-breaking padding means a break can
 * never land at the chip's edge: the whole chip moves down instead.
 */
const CODE_PAD = '\u00a0'

/**
 * U+2060 WORD JOINER: "you may not break here", with no width of its own.
 *
 * ## What it is for, and what it replaced
 *
 * The owner photographed `sc-domain:hermie.dev` and `WACHT OP VERIFICATIE` on the
 * iPad build: the chip grew EMPTY to the end of the line and then continued, mid
 * span, on the next one — a grey tail with nothing in it. The chip had not asked
 * to break there. UAX #14 gives a break opportunity after `:` and after `.`, and
 * one inside a run of capitals with a space in it, so CoreText took one; and
 * because React Native paints the background of every line fragment of a nested
 * `Text`'s range, the fragment that ended at that opportunity was painted across
 * the rest of the line.
 *
 * A zero-width space used to be inserted at the chip's internal word gaps for the
 * opposite reason — to give it somewhere sensible to break. That was the wrong
 * trade: a chip is one token, and the owner's rule is the one every terminal and
 * every code review uses —
 *
 *  1. **do not break it if it does not have to.** A chip that fits on the next
 *     line goes to the next line WHOLE;
 *  2. **break per character only when it genuinely cannot fit**, i.e. when it is
 *     wider than the line itself;
 *  3. **and the background hugs the glyphs**, never empty space.
 *
 * Joining every pair of characters says exactly (1): there is no break
 * opportunity anywhere inside the chip, so the line breaker moves the whole thing
 * down. (2) then comes free — CoreText falls back to a character-level break for
 * a run that cannot fit on a line at all, which is the only case left. And (3)
 * follows from both: every fragment that CAN exist now holds glyphs.
 *
 * Zero width, so it changes no measurement, and invisible to a reader. It IS on
 * the clipboard if a reader long-presses and copies the whole paragraph on a
 * phone; the context menu's own Copy goes through `plainTextBlock` over the
 * markdown source and never sees it, and so does the Mac's Select text panel.
 */
const CODE_JOIN = '\u2060'

/**
 * U+200B ZERO WIDTH SPACE: "you MAY break here", with no width of its own.
 *
 * The other half of the owner's rule, and the half the joiner alone could not
 * reach. Joining every pair says "never break", and CoreText's answer to a
 * never-breakable run that is wider than the line is to open a line, put no
 * glyphs on it, and try again on the next one. React Native paints the
 * background of every line fragment of a nested `Text`'s range, so that empty
 * fragment is a full-width bar with nothing under it — which is exactly what
 * the owner photographed above a chip too long for the bubble.
 *
 * A chip that cannot fit on a line is joined with THIS instead, which puts a
 * break opportunity between every pair of characters and gets the per-letter
 * break rule 2 asks for. Every fragment it can produce ends on a glyph, because
 * the opportunities are between glyphs and never before the first one.
 */
const CODE_BREAK = '\u200b'

/**
 * Which join a chip gets: never break, or break anywhere.
 *
 * The owner's rule needs a measurement, because its two halves are about
 * different things:
 *
 *  1. **a chip that FITS on a line must not break at all** — it goes to the
 *     next line whole, and joining every pair is what says so;
 *  2. **a chip WIDER than the line has to break per letter** — and gluing it
 *     there is what produced the empty bar, because a run that can never break
 *     and can never fit makes the typesetter emit a line with no glyphs on it.
 *
 * So the comparison is against the width the paragraph lays out in, and not
 * against the space left on the current line. The remaining space is the wrong
 * question: a chip that does not fit in it but does fit on a line is case (1),
 * and moving down is the whole point of case (1).
 *
 * With no width yet — the first frame, before the block has laid out — the
 * answer is the unbreakable join. That is right for every chip short enough to
 * be common and wrong only for one that is re-decided a frame later.
 */
export function codeJoinFor({
  characters,
  fontSize,
  lineWidth
}: {
  /** Code points in the chip, its padding included. */
  characters: number
  /** The chip's own size, which is smaller than the body's. */
  fontSize: number
  /** The width the paragraph lays out in; absent means not measured yet. */
  lineWidth?: number
}): string {
  if (!lineWidth) {
    return CODE_JOIN
  }

  return characters * fontSize * MONO_ADVANCE > lineWidth ? CODE_BREAK : CODE_JOIN
}

/**
 * Pad the chip and decide how it is allowed to break.
 *
 * No ASCII space survives inside a chip, at either edge or between words: any of
 * them could end up as a line's trailing whitespace and paint the bar described
 * above. A gap between words keeps its width as non-breaking spaces.
 *
 * Then a joiner goes between every remaining pair of characters, and
 * `codeJoinFor` says which one. Between EVERY pair rather than at a list of
 * known punctuation: the list would be a guess at one line-breaking
 * implementation, and the property wanted is simply "nowhere" or "anywhere".
 *
 * The PADDING is glued either way. In the breakable case a fragment holding only
 * the leading pad would be a bar a character wide with nothing under it — the
 * same defect at a smaller size — so the pads ride with the first and the last
 * glyph whatever the core is allowed to do.
 */
function padCode(text: string, context: MarkdownContext): string {
  const leading = /^\s*/.exec(text)?.[0] ?? ''
  const rest = text.slice(leading.length)
  const trailing = /\s*$/.exec(rest)?.[0] ?? ''
  const core = rest.slice(0, rest.length - trailing.length)
  const spaced = core.replace(/\s+/gu, gap => CODE_PAD.repeat(gap.length))

  const head = `${CODE_PAD}${CODE_PAD.repeat(leading.length)}`
  const tail = `${CODE_PAD.repeat(trailing.length)}${CODE_PAD}`

  // By code POINT, not by UTF-16 unit: a joiner between a surrogate pair's halves
  // would be a broken character rather than a refused break.
  const points = [...spaced]
  const join = codeJoinFor({
    characters: points.length + head.length + tail.length,
    fontSize: codeFontSize(context),
    ...(context.lineWidth ? { lineWidth: context.lineWidth } : {})
  })

  return [...head].join(CODE_JOIN) + CODE_JOIN + points.join(join) + CODE_JOIN + [...tail].join(CODE_JOIN)
}

/** The chip's size. Two things need it now, and only `codeStyle` used to know it. */
function codeFontSize(context: MarkdownContext): number {
  return Math.max(11, context.fontSize - 2)
}

/**
 * The chip reads as a sunk well on whatever surface it sits on, NOT as the
 * code-BLOCK surface: `blockBackground` is an opaque near-black in dark mode, and
 * a near-black slab behind a few words on a blue-slate bubble reads as a
 * redaction bar. `inlineCodeBackground` is a translucent tint instead, so it
 * steps one rung off its own surface wherever it lands.
 *
 * The hairline is carried but is very likely inert: React Native draws a nested
 * `Text` as a span on both platforms, and a span takes a background colour but
 * not a border. It is here so a caller's value survives to whatever renders the
 * chip, and the tint alone has to do the separating today.
 */
function codeStyle(context: MarkdownContext): TextStyle {
  const border = context.inlineCodeBorderColor

  return {
    backgroundColor: context.inlineCodeBackground ?? context.blockBackground,
    color: context.textColor,
    fontFamily: MONOSPACE,
    fontSize: codeFontSize(context),
    ...(border ? { borderColor: border, borderWidth: StyleSheet.hairlineWidth } : {})
  }
}

/**
 * Images are hoisted out of the inline flow by `renderInline`; this keeps a
 * sane box for one without knowing its intrinsic size. `expo-image` is not a
 * dependency of this app, so the platform `Image` does the work.
 *
 * Three things the platform `Image` will not do by itself: resolve the
 * gateway-relative `/api/...` src an agent actually writes, carry the headers a
 * gated gateway demands, and say anything at all when the fetch fails. The
 * third is the one a reader sees — a grey rectangle where a chart should be —
 * so a failed image falls back to its alt text, which is the description the
 * agent already wrote.
 */
function InlineImage({ token, context }: { token: Tokens.Image; context: MarkdownContext }) {
  const [failed, setFailed] = useState(false)
  const uri = resolveImageUri(token.href, context.images?.baseUrl)
  const headers = context.images?.headers
  const alt = token.text || token.title || ''

  if (failed || !uri) {
    return alt ? (
      <Text selectable={context.selectable} style={{ color: context.mutedTextColor, fontSize: 12, marginVertical: 8 }}>
        {alt}
      </Text>
    ) : null
  }

  return (
    <View style={{ gap: 4, marginVertical: 8 }}>
      <Image
        accessibilityLabel={alt || undefined}
        onError={() => setFailed(true)}
        resizeMode="contain"
        source={{ uri, ...(headers && Object.keys(headers).length ? { headers } : {}) }}
        style={{
          width: '100%',
          height: 180,
          borderRadius: 12,
          backgroundColor: context.blockBackground
        }}
      />
      {token.text ? (
        <Text selectable={context.selectable} style={{ color: context.mutedTextColor, fontSize: 12 }}>
          {token.text}
        </Text>
      ) : null}
    </View>
  )
}

function renderToken(token: Token, index: number, context: MarkdownContext): ReactNode {
  const key = `${token.type}-${index}`

  switch (token.type) {
    case 'text':
    case 'escape': {
      const nested = (token as Tokens.Text).tokens

      if (nested?.length) {
        return <Fragment key={key}>{nested.map((child, at) => renderToken(child, at, context))}</Fragment>
      }

      return <Fragment key={key}>{(token as Tokens.Text).text}</Fragment>
    }

    case 'strong':
      return (
        <Text key={key} style={{ fontWeight: '700' }}>
          {(token as Tokens.Strong).tokens.map((child, at) => renderToken(child, at, context))}
        </Text>
      )

    case 'em':
      return (
        <Text key={key} style={{ fontStyle: 'italic' }}>
          {(token as Tokens.Em).tokens.map((child, at) => renderToken(child, at, context))}
        </Text>
      )

    case 'del':
      return (
        <Text key={key} style={{ textDecorationLine: 'line-through' }}>
          {(token as Tokens.Del).tokens.map((child, at) => renderToken(child, at, context))}
        </Text>
      )

    case 'codespan':
      return (
        <Text key={key} style={codeStyle(context)}>
          {padCode((token as Tokens.Codespan).text, context)}
        </Text>
      )

    case MATH_INLINE_TOKEN: {
      const math = token as MathToken
      const runs = inlineMathRuns(math.text)

      // An expression this renderer cannot draw falls back to the LaTeX in a
      // code chip — the same construct a fenced fallback uses one level up, so a
      // reader who meets both sees one idea rather than two. Never the raw
      // characters: `\frac{a}{b}` set as prose reads as a typing mistake.
      if (!runs) {
        return (
          <Text key={key} style={codeStyle(context)}>
            {padCode(math.text.trim(), context)}
          </Text>
        )
      }

      return <MathRunsText context={context} fontSize={context.fontSize} key={key} runs={runs} />
    }

    case 'br':
      return <Fragment key={key}>{'\n'}</Fragment>

    case 'link': {
      const link = token as Tokens.Link

      /**
       * An anchor where the platform has one, a press where it does not.
       *
       * The two are exclusive on purpose. Leaving `onPress` on an element that
       * already carries an `href` opens the destination twice — once because the
       * browser followed the link and once because `Linking.openURL` did — and
       * RNW's click handler does not `preventDefault`, so both would happen.
       *
       * The scheme is checked HERE rather than inside the seam: which schemes
       * this app is willing to leave through is a markdown decision, and whether
       * a link can be an element is a platform one.
       */
      const anchor = isOpenableLink(link.href) ? anchorProps(link.href) : null

      return (
        <Text
          key={key}
          style={{ color: context.linkColor, textDecorationLine: 'underline' }}
          {...(anchor ?? { accessibilityRole: 'link' as const, onPress: () => context.onLinkPress(link.href) })}
        >
          {link.tokens?.length ? link.tokens.map((child, at) => renderToken(child, at, context)) : link.text}
        </Text>
      )
    }

    case 'image':
      // Reached only when an image sits inside emphasis or a link; the block
      // renderer hoists the common case. Fall back to the alt text so the
      // sentence still reads.
      return <Fragment key={key}>{(token as Tokens.Image).text}</Fragment>

    case 'html':
      // No HTML renderer here by design: an agent's stray `<div>` should read
      // as the literal characters it typed.
      return <Fragment key={key}>{(token as Tokens.HTML).raw}</Fragment>

    default: {
      const nested = (token as { tokens?: Token[] }).tokens

      if (nested?.length) {
        return <Fragment key={key}>{nested.map((child, at) => renderToken(child, at, context))}</Fragment>
      }

      return <Fragment key={key}>{(token as { raw?: string }).raw ?? ''}</Fragment>
    }
  }
}

/** Splits a token list into the images that need their own box and the rest. */
export function partitionImages(tokens: Token[]): { images: Tokens.Image[]; inline: Token[] } {
  const images: Tokens.Image[] = []
  const inline: Token[] = []

  for (const token of tokens) {
    if (token.type === 'image') {
      images.push(token as Tokens.Image)

      continue
    }

    inline.push(token)
  }

  return { images, inline }
}

export function Inline({ tokens, context, style }: InlineProps) {
  const { images, inline } = partitionImages(tokens)
  const hasText = inline.some(token => (token as { raw?: string }).raw?.trim())

  return (
    <>
      {hasText ? (
        <Text
          selectable={context.selectable}
          style={[{ color: context.textColor, fontSize: context.fontSize, lineHeight: context.lineHeight }, style]}
        >
          {inline.map((token, index) => renderToken(token, index, context))}
        </Text>
      ) : null}
      {images.map((token, index) => (
        <InlineImage context={context} key={`img-${index}`} token={token} />
      ))}
    </>
  )
}
