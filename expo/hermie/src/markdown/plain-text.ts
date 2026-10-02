/**
 * Markdown → the words, for a place that cannot render markdown.
 *
 * A preview line is one of those places. The gateway's `preview` field, an
 * Activity row's text and a bot-to-bot line's truncated message are all the raw
 * reply, and a reply from a model is markdown: the owner saw
 * `## Retry semantics: what actu…` on a chat row, which spends a third of the
 * line on syntax and then cuts the sentence anyway.
 *
 * It is deliberately NOT the markdown parser in this folder. That one produces
 * blocks and inline spans to render, keeps every position it needs for
 * highlighting, and costs real time; a list row needs a string, wants it on
 * every roster update for every row, and will throw away all but eighty
 * characters of it. So this is one pure pass with no state but a fence flag, and
 * the two are allowed to disagree on an exotic construct — the renderer is what
 * a reader opens the chat to see.
 *
 * What it drops, and why each one is here: heading hashes and setext underlines,
 * emphasis and strike runs, fence lines and inline backticks, list and task
 * markers, blockquote arrows, thematic breaks, and table pipes with their
 * delimiter row. Links collapse to their TEXT rather than their target, because
 * the text is the part a human wrote. Everything left is collapsed to single
 * spaces, so the result is always one line.
 */

/** ` ```ts `, ` ~~~ ` — a fence opening or closing, with any info string. */
const FENCE_RE = /^\s{0,3}(?:`{3,}|~{3,})/u

/** `# Heading`, up to six hashes, with the optional closing run. */
const HEADING_RE = /^\s{0,3}#{1,6}(?:\s+|$)/u

/** `===` / `---` under a paragraph, and `***` / `___` as a thematic break. */
const SETEXT_OR_RULE_RE = /^\s{0,3}(?:=+|-{2,}|\*{3,}|_{3,})\s*$/u

/** `- `, `* `, `+ `, `1. `, `1) `, and the `[ ]` / `[x]` of a task item. */
const LIST_MARKER_RE = /^\s*(?:[-*+]|\d{1,9}[.)])\s+(?:\[[ xX]\]\s+)?/u

/** `> `, however deeply nested. */
const QUOTE_MARKER_RE = /^\s*(?:>\s?)+/u

/** `|---|:--:|` — a table's delimiter row, which says nothing at all. */
const TABLE_DELIMITER_RE = /^\s*\|?[\s:|-]*-{2,}[\s:|-]*\|?\s*$/u

/** `![alt](src)` before `[text](href)`, so an image does not leave a `!`. */
const IMAGE_RE = /!\[([^\]]*)\]\([^)]*\)/gu
const LINK_RE = /\[([^\]]*)\]\((?:[^()]|\([^)]*\))*\)/gu
/** `[text][ref]` and the bare `[ref]` of a shortcut link. */
const REF_LINK_RE = /\[([^\]]*)\]\[[^\]]*\]/gu
/** `<https://example.com>` — the target IS the text here, so the brackets go. */
const AUTOLINK_RE = /<((?:https?|mailto):[^>\s]+)>/gu

/** `**bold**`, `*it*`, `~~struck~~`. */
const STAR_EMPHASIS_RE = /(\*{1,3}|~{2})(?!\s)([^\n]*?[^\s\\])\1/gu

/**
 * `__bold__`, `_it_` — but never `snake_case_name`.
 *
 * CommonMark forbids intraword `_` emphasis for exactly this reason, and a
 * preview that renamed `row_id` to `rowid` would be worse than one that left a
 * stray underscore in.
 */
const UNDER_EMPHASIS_RE = /(^|[^\w])(_{1,3})(?!\s)([^\n]*?[^\s\\])\2(?![\w])/gu

/** A backslash escape: the character it protects is the character we want. */
const ESCAPE_RE = /\\([\\`*_{}[\]()#+\-.!>~|])/gu

/** An inline code span, of any backtick run length. */
const CODE_SPAN_RE = /(`+)([^`]|[^`][\s\S]*?[^`])\1/gu

function inlineToText(line: string): string {
  let text = line

  // Code spans first: their content is literal, and a `*` inside one is not
  // emphasis. Stripping the ticks now and leaving the content alone until the
  // emphasis pass is a known, accepted imprecision — see the note above.
  text = text.replace(CODE_SPAN_RE, (_match, _ticks, body: string) => body.trim())
  text = text.replace(IMAGE_RE, '$1')
  text = text.replace(LINK_RE, '$1')
  text = text.replace(REF_LINK_RE, '$1')
  text = text.replace(AUTOLINK_RE, '$1')

  // Twice: `**a _b_ c**` needs the inner run resolved before the outer one can
  // match across it. Two passes cover every nesting a model actually writes.
  for (let pass = 0; pass < 2; pass += 1) {
    text = text.replace(STAR_EMPHASIS_RE, '$2').replace(UNDER_EMPHASIS_RE, '$1$3')
  }

  // Any backtick runs the span rule could not pair — an unclosed fence inside a
  // line, a lone tick — are syntax with no content, so they simply go.
  text = text.replace(/`/gu, '')
  text = text.replace(ESCAPE_RE, '$1')

  return text
}

/**
 * One line of plain text from a markdown source. Safe on an empty string and on
 * a partially streamed reply, which is the state a preview is usually read in.
 */
export function plainTextPreview(markdown: string): string {
  return plainTextLines(markdown).join(' ').replace(/\s+/gu, ' ').trim()
}

/**
 * The same words, with the LINES kept.
 *
 * A preview wants one line; Copy wants the message. The two differ only in how
 * the stripped lines are joined, so they share the pass rather than having a
 * second stripper that agrees with the first until it does not.
 */
export function plainTextBlock(markdown: string): string {
  return plainTextLines(markdown)
    .join('\n')
    .replace(/[ \t]+$/gmu, '')
    .replace(/\n{3,}/gu, '\n\n')
    .trim()
}

function plainTextLines(markdown: string): string[] {
  if (!markdown) {
    return []
  }

  const out: string[] = []
  let inFence = false

  for (const raw of markdown.split('\n')) {
    if (FENCE_RE.test(raw)) {
      // The fence line itself is never content, in either direction.
      inFence = !inFence

      continue
    }

    if (inFence) {
      // Verbatim: the point of a fence is that what is inside it is not markup.
      out.push(raw)

      continue
    }

    if (TABLE_DELIMITER_RE.test(raw) || SETEXT_OR_RULE_RE.test(raw)) {
      continue
    }

    let line = raw.replace(QUOTE_MARKER_RE, '')

    line = line.replace(HEADING_RE, '')
    line = line.replace(LIST_MARKER_RE, '')
    // A table row reads as its cells with the rails taken off.
    line = line
      .replace(/^\s*\|/u, '')
      .replace(/\|\s*$/u, '')
      .replace(/\|/gu, ' ')
    line = inlineToText(line)

    out.push(line)
  }

  return out
}
