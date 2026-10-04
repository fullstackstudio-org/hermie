/**
 * Markdown to the words worth saying, for something that is going to SAY them (`features/voice/speech-text.ts` in
 * the Expo app, `MarkdownSpeech` in the native apps: the three read a reply the same way).
 *
 * A speech engine reads characters aloud in order, has no way to skim and cannot go back, so the question here is
 * not "what is the text" (that is `plainTextBlock`, for a place that cannot draw Markdown: a preview, a Copy) but
 * "what is worth the listener's time, and in what order". The two differ most on the constructs this app spent a
 * round rendering:
 *
 *  - **A code block is read as its shape, not its contents.** Forty lines of source spoken one symbol at a time is
 *    ninety seconds of noise that cannot be paused at a useful place. `Code block, 40 lines` is the sentence a
 *    person would say. A listing of up to `SHORT_CODE_LINES` short lines is read out, because a one-liner IS the
 *    answer often enough that summarising it would hide the reply.
 *  - **A table is read a row at a time**, cells separated by commas and rows by full stops, the delimiter row
 *    dropped. Column alignment is a fact about a screen.
 *  - **Mathematics is read as its SOURCE**, un-stripped: `a_1 + b_2` between dollar signs would lose its subscripts
 *    to the emphasis rule (`_1 + b_` is a legal emphasis run), and wrong is worse than poor. So it is masked out
 *    before the inline pass and put back afterwards, as written.
 *  - **A link reads its label**: a URL read aloud is a minute of "h t t p s colon slash slash".
 *
 * Block structure is this file's own; the INLINE pass is `plainTextBlock`'s, because "strip emphasis, unwrap
 * links, drop backticks" is one decision and two copies of it would drift. What is added around it is the masking,
 * the block rules above, and a full stop at the end of a line that had none: a heading without one runs into the
 * paragraph under it, and an engine pauses on punctuation, not on a newline.
 *
 * Safe on an empty string and on a reply that is still arriving: an unclosed fence is summarised from what has
 * come so far.
 */
import { plainTextBlock } from '@hermie/markdown/plain-text'

import { strings } from '../../generated/strings'

/** How many lines a fenced block may have and still be read out in full. */
export const SHORT_CODE_LINES = 2

/** And how many characters, so two very long lines are still summarised. */
export const SHORT_CODE_CHARS = 80

/** How much of a reply is sampled to guess its language. */
export const LANGUAGE_SAMPLE_CHARS = 600

/** A fence in either flavour, with any info string. */
const FENCE_RE = /^\s{0,3}(?:`{3,}|~{3,})/u

/** `$$` on a line of its own: a display-maths block opening or closing. */
const MATH_FENCE_RE = /^\s*\$\$\s*$/u

/** `$$x^2$$` all on one line. */
const MATH_ONE_LINE_RE = /^\s*\$\$(.+)\$\$\s*$/u

/** A row of a pipe table: at least one `|` with something either side of it. */
const TABLE_ROW_RE = /^\s*\|.*\|\s*$/u

/** `|---|:--:|`: the row that describes the columns and says nothing. */
const TABLE_DELIMITER_RE = /^\s*\|?[\s:|-]*-{2,}[\s:|-]*\|?\s*$/u

/** `---`, `***`, `___` on their own: a rule, which has no sound. */
const RULE_RE = /^\s{0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/u

/** `$x^2$` inside a line, non-greedy, never spanning a break. */
const INLINE_MATH_RE = /\$([^$\n]+)\$/gu

/**
 * The character a masked span is parked under: NUL, the one character neither a model nor `plainTextBlock` will
 * produce or act on. Built from its code point, because Prettier rewrites the escape `\u0000` to the raw byte, and a
 * source file with a NUL in it is one that editors, diff tools and the plugin scanner all treat as binary.
 */
const MASK = String.fromCharCode(0)
const MASKED_RE = new RegExp(`${MASK}(\\d+)${MASK}`, 'gu')

/** Put a full stop on a line that ends without one, so the engine pauses. */
function stopped(line: string): string {
  const text = line.trim()

  if (!text) {
    return ''
  }

  return /[.!?:;,]$/u.test(text) ? text : `${text}.`
}

/** One line's inline markup removed, with any mathematics left exactly as it was. */
function inline(line: string): string {
  const spans: string[] = []
  const masked = line.replace(INLINE_MATH_RE, (_match, body: string) => {
    spans.push(String(body).trim())

    return `${MASK}${spans.length - 1}${MASK}`
  })

  const stripped = plainTextBlock(masked)

  return spans.length ? stripped.replace(MASKED_RE, (_match, index: string) => spans.at(Number(index)) ?? '') : stripped
}

/** A table row's cells, in order, with the outer rails taken off. */
function cells(row: string): string[] {
  return row
    .trim()
    .replace(/^\|/u, '')
    .replace(/\|$/u, '')
    .split('|')
    .map(cell => inline(cell).trim())
    .filter(Boolean)
}

/** What a speech engine should be handed for this Markdown. */
export function speechText(markdown: string): string {
  if (!markdown) {
    return ''
  }

  const lines = markdown.split('\n')
  const out: string[] = []

  let at = 0

  while (at < lines.length) {
    const raw = lines[at] ?? ''

    if (RULE_RE.test(raw)) {
      at += 1

      continue
    }

    // A fenced listing: collect to the closing fence, or to the end of what has arrived, and describe it rather
    // than recite it.
    if (FENCE_RE.test(raw)) {
      const body: string[] = []

      at += 1

      while (at < lines.length && !FENCE_RE.test(lines[at] ?? '')) {
        body.push(lines[at] ?? '')
        at += 1
      }

      // Past the closing fence when there was one; an unclosed block has already run off the end.
      at += 1

      const content = body.join('\n').trim()
      const count = body.filter(line => line.trim()).length

      if (content && count <= SHORT_CODE_LINES && content.length <= SHORT_CODE_CHARS) {
        out.push(stopped(content))
      } else if (count > 0) {
        out.push(stopped(strings.chat.voice.codeBlock({ lines: count })))
      }

      continue
    }

    // Display mathematics, in both spellings: the one block whose SOURCE is the content.
    const oneLineMath = MATH_ONE_LINE_RE.exec(raw)

    if (oneLineMath) {
      out.push(stopped(String(oneLineMath[1]).trim()))
      at += 1

      continue
    }

    if (MATH_FENCE_RE.test(raw)) {
      const body: string[] = []

      at += 1

      while (at < lines.length && !MATH_FENCE_RE.test(lines[at] ?? '')) {
        body.push(lines[at] ?? '')
        at += 1
      }

      at += 1

      const source = body.join(' ').replace(/\s+/gu, ' ').trim()

      if (source) {
        out.push(stopped(source))
      }

      continue
    }

    // A table: every row that follows, the delimiter dropped, each row ended so the engine pauses between them.
    if (TABLE_ROW_RE.test(raw)) {
      while (at < lines.length && TABLE_ROW_RE.test(lines[at] ?? '')) {
        const row = lines[at] ?? ''

        at += 1

        if (TABLE_DELIMITER_RE.test(row)) {
          continue
        }

        const joined = cells(row).join(', ')

        if (joined) {
          out.push(stopped(joined))
        }
      }

      continue
    }

    at += 1

    const text = inline(raw)

    if (text.trim()) {
      out.push(stopped(text))
    }
  }

  return out
    .join('\n')
    .replace(/\n{2,}/gu, '\n')
    .trim()
}

/**
 * The function words of the seven languages the apps' own copy is written in or near, counted over the first few
 * hundred characters of a reply.
 */
const MARKERS: Record<string, readonly string[]> = {
  en: ['the', 'and', 'that', 'with', 'this', 'from', 'you', 'have', 'which', 'would'],
  nl: ['de', 'het', 'een', 'niet', 'dat', 'van', 'voor', 'maar', 'zijn', 'wordt'],
  de: ['der', 'die', 'das', 'und', 'nicht', 'mit', 'ist', 'auch', 'werden', 'einen'],
  fr: ['les', 'des', 'une', 'est', 'pas', 'pour', 'dans', 'que', 'vous', 'avec'],
  es: ['los', 'las', 'una', 'que', 'por', 'para', 'con', 'como', 'pero', 'este'],
  it: ['che', 'per', 'con', 'una', 'del', 'nel', 'sono', 'come', 'questo', 'alla'],
  pt: ['que', 'não', 'uma', 'para', 'com', 'como', 'mas', 'dos', 'este', 'você']
}

/**
 * Which language a reply is probably in, or nothing.
 *
 * A **cheap** heuristic and nothing more: it exists because a Dutch reply read by an English voice is unpleasant in
 * a way a wrong REGION never is, and the alternative, a language-detection library, is a megabyte to answer a
 * question whose fallback (the browser's own voice) is already right most of the time. It answers `undefined` far
 * more readily than it guesses: two matches is the floor and the winner has to be clear of the runner-up, because a
 * confident wrong answer costs more than no answer.
 */
export function guessSpeechLanguage(text: string): string | undefined {
  const words = text
    .slice(0, LANGUAGE_SAMPLE_CHARS)
    .toLowerCase()
    .split(/[^\p{L}]+/u)
    .filter(Boolean)

  if (words.length < 4) {
    return undefined
  }

  const seen = new Set(words)
  const scores = Object.entries(MARKERS)
    .map(([code, markers]) => ({ code, score: markers.filter(marker => seen.has(marker)).length }))
    .sort((left, right) => right.score - left.score)

  const best = scores[0]
  const next = scores[1]

  // Two hits and a clear lead. A reply that scores 2 for Dutch and 2 for German cannot be told apart, and the
  // browser's own voice is the better answer.
  return best && best.score >= 2 && best.score > (next?.score ?? 0) ? best.code : undefined
}
