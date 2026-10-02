/**
 * Markdown → the words, for something that is going to SAY them.
 *
 * The third stripper in this tree, and the one furthest from the other two, so
 * it is worth being explicit about why it is not either of them:
 *
 *  - `markdown/plain-text.ts` answers "what are the words" for a place that
 *    cannot render markdown — a chat-list preview, a Copy. It is a pure
 *    line-by-line pass and it keeps every line.
 *  - `markdown/` proper answers "what does this LOOK like" and produces blocks
 *    to draw.
 *
 * A speech engine wants neither. It reads characters aloud in order, has no way
 * to skim, and cannot go back — so the question here is not "what is the text"
 * but **"what is worth the listener's time, and in what order"**. Those differ
 * most on exactly the constructs this app spent a round rendering:
 *
 *  - **A code block is read as its shape, not its contents.** Forty lines of
 *    TypeScript spoken one character at a time is ninety seconds of noise that
 *    cannot be paused at a useful place. `code block, 40 lines` is the sentence
 *    a person would actually say. Short listings are the exception — a
 *    one-liner IS the answer often enough that summarising it would hide the
 *    reply — so up to `SHORT_CODE_LINES` short lines are read out.
 *  - **A table is read row by row**, cells separated by commas and rows by full
 *    stops, with the delimiter row dropped. Column alignment is a fact about a
 *    screen.
 *  - **Mathematics is read as its SOURCE**, un-stripped. `\frac{a}{b}` spoken
 *    as "backslash frac a b" is poor; spoken as "ab" — which is what an
 *    emphasis stripper turns `a_1 + b_2` into — is wrong, and wrong is worse
 *    than poor. So maths is masked out before the inline pass and put back
 *    afterwards, exactly as written.
 *  - **A link reads its label.** A URL read aloud is a minute of "h t t p s
 *    colon slash slash" and the label is the part a human wrote — the same call
 *    `plain-text.ts` makes, for the same reason.
 *
 * Block structure is this file's own; the INLINE pass is delegated to
 * `plainTextBlock`, because "strip emphasis, unwrap links, drop backticks" is
 * one decision and two copies of it would drift. What is added around it is the
 * masking, the block rules above, and a full stop at the end of a line that had
 * none — a heading without one runs into the paragraph below it, and an engine
 * pauses on punctuation rather than on a newline.
 */
import { plainTextBlock } from '../../markdown/plain-text'
import { chatStrings } from '../../chat-ui/strings'

/** How many lines a fenced block may have and still be read out in full. */
export const SHORT_CODE_LINES = 2

/** And how many characters, so two very long lines are still summarised. */
export const SHORT_CODE_CHARS = 80

/** ` ```ts `, ` ~~~ ` — a fence in either flavour, with any info string. */
const FENCE_RE = /^\s{0,3}(?:`{3,}|~{3,})/u

/** `$$` on a line of its own: a display-maths block opening or closing. */
const MATH_FENCE_RE = /^\s*\$\$\s*$/u

/** `$$x^2$$` all on one line. */
const MATH_ONE_LINE_RE = /^\s*\$\$(.+)\$\$\s*$/u

/** A row of a pipe table: at least one `|` with something either side of it. */
const TABLE_ROW_RE = /^\s*\|.*\|\s*$/u

/** `|---|:--:|` — the row that describes the columns and says nothing. */
const TABLE_DELIMITER_RE = /^\s*\|?[\s:|-]*-{2,}[\s:|-]*\|?\s*$/u

/** `---`, `***`, `___` on their own: a rule, which has no sound. */
const RULE_RE = /^\s{0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/u

/** `$x^2$` inside a line, non-greedy, never spanning a blank. */
const INLINE_MATH_RE = /\$([^$\n]+)\$/gu

/**
 * The character a masked span is parked under.
 *
 * NUL, because it is the one character neither a model nor `plainTextBlock`
 * will produce or act on: every rule in that file matches punctuation, letters
 * or whitespace, and a mask made of any of those could be rewritten by the very
 * pass it exists to survive.
 *
 * Built from its code point rather than written as `'\u0000'`, because Prettier
 * rewrites that escape to the RAW BYTE and a source file with a NUL in it is one
 * that editors, diff tools and `grep` all treat as binary.
 */
const MASK = String.fromCharCode(0)

/** Put a full stop on a line that ends without one, so the engine pauses. */
function stopped(line: string): string {
  const text = line.trim()

  if (!text) {
    return ''
  }

  return /[.!?:;,]$/u.test(text) ? text : `${text}.`
}

/**
 * One line's inline markup removed, with any mathematics left exactly as it was.
 *
 * The masking is the whole of the interesting part. `a_1 + b_2` is a perfectly
 * ordinary thing to write inside `$…$`, and CommonMark's intraword rule does not
 * save it: `_1 + b_` is a legal emphasis run between two non-word characters, so
 * an unmasked pass reads it as "a1 + b2" and silently deletes two subscripts.
 */
function inline(line: string): string {
  const spans: string[] = []
  const masked = line.replace(INLINE_MATH_RE, (_match, body: string) => {
    spans.push(String(body).trim())

    return `${MASK}${spans.length - 1}${MASK}`
  })

  const stripped = plainTextBlock(masked)

  return spans.length
    ? stripped.replace(new RegExp(`${MASK}(\\d+)${MASK}`, 'gu'), (_match, index: string) => spans[Number(index)] ?? '')
    : stripped
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

/**
 * What a speech engine should be handed for this markdown.
 *
 * Safe on an empty string and on a partially streamed reply — the same states
 * `plainTextPreview` is read in — which matters because an auto-read is armed
 * while a turn is still running and a fence may well be open when it fires.
 * An unclosed fence is summarised from what has arrived, not dropped.
 */
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

    // A fenced listing: collect to the closing fence, or to the end of what has
    // arrived so far, and describe it rather than recite it.
    if (FENCE_RE.test(raw)) {
      const body: string[] = []

      at += 1

      while (at < lines.length && !FENCE_RE.test(lines[at] ?? '')) {
        body.push(lines[at] ?? '')
        at += 1
      }

      // Step over the closing fence when there was one; an unclosed block has
      // already run off the end and `at` is past it either way.
      at += 1

      const content = body.join('\n').trim()
      const count = body.filter(line => line.trim()).length

      if (content && count <= SHORT_CODE_LINES && content.length <= SHORT_CODE_CHARS) {
        out.push(stopped(content))
      } else if (count > 0) {
        out.push(stopped(chatStrings.voice.codeBlock(count)))
      }

      continue
    }

    // Display mathematics, in both the fenced and the one-line spelling. Read
    // verbatim: this is the one block whose SOURCE is the content.
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

    // A table: every row that follows, with the delimiter dropped and each row
    // ended so the engine pauses between them.
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
 * Which language a reply is probably in, or nothing.
 *
 * A **cheap** heuristic and nothing more: the most common function words of the
 * seven languages this app's own copy and its README are written in or near,
 * counted over the first few hundred characters. It exists because a Dutch reply
 * read by an English voice is unpleasant in a way a wrong REGION never is, and
 * because the alternative — a language-detection library — is a megabyte to
 * answer a question whose fallback (the device's own locale) is already right
 * most of the time.
 *
 * It answers `undefined` far more readily than it guesses. Two matches is the
 * floor and the winner has to be clear of the runner-up, because a confident
 * wrong answer here costs more than no answer: no answer means the device
 * locale, which is the reader's own language by construction.
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

/** How much of a reply is sampled. Enough for function words to show up. */
export const LANGUAGE_SAMPLE_CHARS = 600

export function guessSpeechLanguage(text: string): string | undefined {
  const words = text
    .slice(0, LANGUAGE_SAMPLE_CHARS)
    .toLowerCase()
    .split(/[^\p{L}]+/u)
    .filter(Boolean)

  if (words.length < 4) {
    return undefined
  }

  const counted = new Set(words)
  const scores = Object.entries(MARKERS)
    .map(([code, markers]) => ({ code, score: markers.filter(marker => counted.has(marker)).length }))
    .sort((left, right) => right.score - left.score)

  const best = scores[0]
  const next = scores[1]

  // Two hits, and a clear lead. A reply that scores 2 for Dutch and 2 for German
  // is a reply this cannot tell apart, and the device locale is the better answer.
  return best && best.score >= 2 && best.score > (next?.score ?? 0) ? best.code : undefined
}
