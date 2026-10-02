/**
 * Hermes-specific Markdown fixes, applied before the lexer sees the text.
 *
 * This is the subset of `apps/desktop/src/lib/markdown-preprocess.ts` that
 * still applies here. Deliberately dropped: preview targets, session-ref
 * linkification and the HTML nesting clamp — all three route into desktop-only
 * renderers that do not exist on this side.
 *
 * **Mathematics is not here either, and that is a decision rather than a gap.**
 * There IS a math renderer now (ADR-0020), and the desktop app protects `$…$`
 * from the lexer by rewriting it in a file like this one. Hermie does it one
 * level down instead, as real tokens — `markdown/math/marked-math.ts` — because
 * a mask applied here would have to survive every other rewrite below it, and
 * each of those is a pass over the same string that does not know what it is
 * stepping through. A tokenizer says it once, at the level that owns it.
 *
 * What is ported, and why each one matters while a reply is still streaming:
 *
 *   - Reasoning blocks (`<think>…`). Runs on the ACCUMULATED text on every
 *     flush, so an unterminated block has to be hidden here. Otherwise the
 *     chain of thought paints as prose until the close tag lands and then the
 *     whole span vanishes in one frame.
 *   - Fence normalisation. An unterminated fence mid-stream must already read
 *     as a code block, not as prose that turns into code a second later.
 *   - `MEDIA:` delivery tags, which the gateway emits as a bare line and which
 *     are a link, not literal text.
 *   - Table spacing. Models routinely emit a table with no blank line above
 *     it; GFM then reads the header row as the tail of the paragraph and the
 *     table renders as pipes.
 *   - Stray spaces inside an emphasis run (`** bold**`). CommonMark says that
 *     opens nothing, so the lexer emits no `strong` token at all and the reader
 *     sees the asterisks.
 */

// Same tag set as the upstream scrubber, plus the desktop-only `scratchpad`
// and `analysis`.
const REASONING_TAGS = 'think|thinking|reasoning|thought|reasoning_scratchpad|scratchpad|analysis'

// A run of adjacent closed blocks is one match, so the seam check below sees
// the prose on either side of the whole run rather than the previous block's
// closing tag.
const REASONING_BLOCK_RE = new RegExp(`(?:<(${REASONING_TAGS})>[\\s\\S]*?<\\/\\1>\\s*)+`, 'gi')

// An open tag that starts its own block with no close tag yet. The
// block-boundary requirement is what lets a real reasoning preamble (always its
// own block) vanish while prose that merely mentions `<thinking>` mid-sentence
// survives.
const OPEN_REASONING_BLOCK_RE = new RegExp(`(^|\\n)[ \\t]*<(${REASONING_TAGS})>[\\s\\S]*$`, 'i')

// A half-arrived open tag (`<thin`) at a block boundary is not a tag yet, so
// without this it paints as prose for one frame and is then erased.
const REASONING_TAG_PREFIXES = Array.from(
  new Set(REASONING_TAGS.split('|').flatMap(tag => Array.from({ length: tag.length }, (_, i) => tag.slice(0, i + 1))))
).join('|')

const PARTIAL_OPEN_REASONING_TAG_RE = new RegExp(`(^|\\n)[ \\t]*<(?:${REASONING_TAG_PREFIXES})?$`, 'i')

const FENCE_LINE_RE = /^([ \t]*)(`{3,}|~{3,})([^\n]*)$/
const EMPTY_FENCE_BLOCK_RE = /(^|\n)[ \t]*(?:`{3,}|~{3,})[^\n]*\n[ \t]*(?:`{3,}|~{3,})[ \t]*(?=\n|$)/g
const CODE_FENCE_SPLIT_RE = /((?:```|~~~)[\s\S]*?(?:```|~~~|$))/g
const INLINE_CODE_SPLIT_RE = /(`[^`\n]+`)/g
const URL_ONLY_LINE_RE = /^\s*https?:\/\/\S+\s*$/i
const VALID_LANGUAGE_RE = /^[a-z0-9][a-z0-9+#-]*$/i

// `[1]` / `[1, 2]` glued to the end of a word: a citation marker from a search
// tool, not a link and not a footnote we can resolve.
const CITATION_MARKER_RE = /(?<=[\p{L}\p{N})\].,!?:;"'”’])\[(?:\d+(?:\s*,\s*\d+)*)\](?!\()/gu

// Bare-URL autolink. The character classes exclude `*` so a URL that abuts
// emphasis with no separating space (`**see https://x**`, a very common model
// pattern) does not swallow the trailing `**` into the href.
const RAW_URL_RE = /https?:\/\/[^\s<>"'`*]+[^\s<>"'`*.,;:!?]/g

/**
 * Markdown that already links, so the autolinker leaves it alone.
 *
 * Only the DESTINATION used to be protected, by peeking at the two characters
 * before the match. That left the label: `[https://foo.dev](https://foo.dev)`
 * came out as `[<https://foo.dev>](https://foo.dev)`, which renders as a link
 * whose visible text is a second, nested link. Splitting the prose on whole
 * link constructs protects both halves at once, and images with it.
 */
const LINK_SYNTAX = String.raw`!?\[[^\]\n]*\](?:\([^)\n]*\)|\[[^\]\n]*\])|<[^\s<>]*>`
const LINK_SYNTAX_SPLIT_RE = new RegExp(`(${LINK_SYNTAX})`, 'g')
// Its own copy, without `g`: a global regex carries `lastIndex` between calls,
// and `test` on one is a different answer every other time it is asked.
const LINK_SYNTAX_RE = new RegExp(`^(?:${LINK_SYNTAX})$`)

// Trailing punctuation a sentence owns rather than the URL: `see https://x.`
// is a URL and a full stop. `)` and `]` are handled separately, because
// `…/Foo_(bar)` genuinely ends in one.
const URL_TAIL_PUNCTUATION = new Set(['!', '"', "'", '*', ',', '.', ':', ';', '?', '_', '~'])

function countChar(value: string, char: string): number {
  let total = 0

  for (const candidate of value) {
    if (candidate === char) {
      total += 1
    }
  }

  return total
}

/**
 * Give back the trailing characters the sentence owns, the way marked's
 * `_backpedal` does.
 *
 * A closing bracket stays only when the URL opened one: `(see
 * https://example.com)` ends a parenthesis, while
 * `https://en.wikipedia.org/wiki/Foo_(bar)` ends a path. Counting is what tells
 * the two apart, and it is the whole reason this is not a regex.
 */
export function trimUrlTail(url: string): string {
  let out = url

  for (;;) {
    const last = out.at(-1)

    if (!last) {
      return out
    }

    if (last === ')' || last === ']') {
      const opener = last === ')' ? '(' : '['

      if (countChar(out, last) <= countChar(out, opener)) {
        return out
      }

      out = out.slice(0, -1)

      continue
    }

    if (!URL_TAIL_PUNCTUATION.has(last)) {
      return out
    }

    out = out.slice(0, -1)
  }
}

// Mirrors `MEDIA_DELIVERY_EXTS` in the gateway's `platforms/base.py`: the
// extensions a `MEDIA:` tag is allowed to end on. Anchoring on the extension is
// what lets an unquoted path contain spaces.
const MEDIA_DELIVERY_EXTS = [
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'bmp',
  'tiff',
  'svg',
  'mp4',
  'mov',
  'avi',
  'mkv',
  'webm',
  '3gp',
  'mp3',
  'm2a',
  'wav',
  'ogg',
  'opus',
  'm4a',
  'flac',
  'pdf',
  'docx',
  'doc',
  'odt',
  'rtf',
  'txt',
  'md',
  'epub',
  'xlsx',
  'xls',
  'ods',
  'csv',
  'tsv',
  'json',
  'xml',
  'yaml',
  'yml',
  'kmz',
  'kml',
  'geojson',
  'gpx',
  'pptx',
  'ppt',
  'odp',
  'key',
  'zip',
  'tar',
  'gz',
  'tgz',
  'bz2',
  'xz',
  '7z',
  'rar',
  'apk',
  'ipa',
  'html',
  'htm'
]

// Longest first, so the alternation never matches a short extension as the
// prefix of a longer one.
const MEDIA_EXT_ALTERNATION = [...MEDIA_DELIVERY_EXTS].sort((a, b) => b.length - a.length).join('|')

const MEDIA_PATH_ANCHORED =
  `(?:~/|/|[A-Za-z]:[/\\\\])\\S+?(?:[^\\S\\n]+\\S+?)*?\\.(?:${MEDIA_EXT_ALTERNATION})` +
  `(?=[\\s\`"'*_,;:)\\]}]|MEDIA:|$)`

const MEDIA_VALUE = `\`[^\`\\n]+\`|"[^"\\n]+"|'[^'\\n]+'|${MEDIA_PATH_ANCHORED}|\\S+`

const MEDIA_LINE_RE = new RegExp(`(^|\\n)[\\t ]*[\`"']?MEDIA:\\s*(${MEDIA_VALUE})[\`"']?[\\t ]*(\\n|$)`, 'g')
const MEDIA_TAG_RE = new RegExp(`[\`"']?MEDIA:\\s*(${MEDIA_VALUE})[\`"']?`, 'g')

// A GFM delimiter row: `|---|:--:|`. The header row above it is whatever line
// precedes it, which is exactly why the blank line matters.
const TABLE_DELIMITER_RE = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/
const TABLE_ROW_RE = /\|/

function sanitizeLanguageTag(tag: string): string {
  const first = tag.trim().split(/\s/, 1)[0] ?? ''

  return VALID_LANGUAGE_RE.test(first) && first.length <= 16 ? first.toLowerCase() : ''
}

function stripReasoningBlocks(text: string): string {
  // Removing a closed block between two words keeps one space, so `no` and
  // `Hermes` do not fuse into `noHermes`.
  const closed = text.replace(REASONING_BLOCK_RE, (match, _tag: string, offset: number, whole: string) => {
    const previous = whole[offset - 1]
    const next = whole[offset + match.length]

    return previous && next && !/\s/.test(previous) && !/\s/.test(next) ? ' ' : ''
  })

  return closed.replace(OPEN_REASONING_BLOCK_RE, '$1').replace(PARTIAL_OPEN_REASONING_TAG_RE, '$1')
}

function unquoteMediaPath(value: string): string {
  const trimmed = value.trim()
  const quote = trimmed[0]

  return quote && quote === trimmed.at(-1) && ['"', "'", '`'].includes(quote) ? trimmed.slice(1, -1) : trimmed
}

function mediaLabel(path: string): string {
  const base = path.replace(/\\/g, '/').split('/').pop() ?? path

  return base || path
}

function mediaLink(value: string): string {
  const path = unquoteMediaPath(value)

  // The label is the file name; the href stays the raw path. Hermie cannot
  // open a path on the gateway's disk, so the link renders as an inert,
  // copyable filename rather than a dead `file://` anchor.
  return `[${mediaLabel(path)}](${path})`
}

/** `MEDIA:/srv/out/report.pdf` → `[report.pdf](/srv/out/report.pdf)`. */
export function renderMediaTags(text: string): string {
  if (!text.includes('MEDIA:')) {
    return text
  }

  return text
    .replace(MEDIA_LINE_RE, (_match, lead: string, value: string, trailer: string) => {
      return `${lead}${mediaLink(value)}${trailer}`
    })
    .replace(MEDIA_TAG_RE, (_match, value: string) => mediaLink(value))
}

/** The raw `MEDIA:` values in `text`, quotes intact. */
export function mediaTagValues(text: string): string[] {
  return [...text.matchAll(MEDIA_TAG_RE)].map(match => match[1] ?? '')
}

function stripEmptyFenceBlocks(text: string): string {
  return text.replace(EMPTY_FENCE_BLOCK_RE, '$1')
}

function isUrlOnlyBlock(lines: string[]): boolean {
  const nonEmpty = lines.filter(line => line.trim())

  return nonEmpty.length > 0 && nonEmpty.every(line => URL_ONLY_LINE_RE.test(line))
}

function findClosingFence(lines: string[], start: number, marker: string): number {
  for (let cursor = start + 1; cursor < lines.length; cursor += 1) {
    const closeMatch = (lines[cursor] ?? '').match(FENCE_LINE_RE)

    if (!closeMatch) {
      continue
    }

    const closeMarker = closeMatch[2] ?? ''
    const closeInfo = (closeMatch[3] ?? '').trim()

    if (!closeInfo && closeMarker[0] === marker[0] && closeMarker.length >= marker.length) {
      return cursor
    }
  }

  return -1
}

/**
 * Rewrite every fence to `marker + sanitized language`, drop empty and
 * URL-only fences, and leave an unterminated fence open so the lexer still
 * reads it as code. That last part is the whole point during streaming: the
 * half-arrived block paints as a code block from the first line and stays one.
 */
function normalizeFenceBlocks(text: string): string {
  const sourceLines = text.split('\n')
  const out: string[] = []
  let index = 0

  while (index < sourceLines.length) {
    const line = sourceLines[index] ?? ''
    const match = line.match(FENCE_LINE_RE)

    if (!match) {
      out.push(line)
      index += 1

      continue
    }

    const indent = match[1] ?? ''
    const marker = match[2] ?? '```'
    const infoRaw = (match[3] ?? '').trim()
    const languageToken = infoRaw.split(/\s+/, 1)[0] ?? ''
    const language = sanitizeLanguageTag(languageToken)

    // An info string that is not a language tag at all (`\`\`\`- a bullet`) is
    // prose the model fenced by accident.
    if (infoRaw && !language) {
      out.push(`${indent}${infoRaw}`.trimEnd())
      index += 1

      continue
    }

    const closeIndex = findClosingFence(sourceLines, index, marker)
    const bodyLines = sourceLines.slice(index + 1, closeIndex === -1 ? sourceLines.length : closeIndex)
    const body = bodyLines.join('\n')

    if (closeIndex !== -1 && !body.trim()) {
      index = closeIndex + 1

      continue
    }

    if (closeIndex !== -1 && isUrlOnlyBlock(bodyLines)) {
      out.push(...bodyLines)
      index = closeIndex + 1

      continue
    }

    if (closeIndex === -1) {
      if (!body.trim()) {
        index += 1

        continue
      }

      out.push(`${indent}${marker}${language}`, ...bodyLines)

      break
    }

    out.push(`${indent}${marker}${language}`, ...bodyLines, `${indent}${marker}`)
    index = closeIndex + 1
  }

  return out.join('\n')
}

/**
 * Insert the blank line GFM wants above a table, and below it when the next
 * line is ordinary prose. A table is recognised by its delimiter row, because
 * that is the only row whose shape is unambiguous.
 */
function spaceTableBlocks(text: string): string {
  if (!text.includes('|')) {
    return text
  }

  const lines = text.split('\n')
  const out: string[] = []

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    const previous = lines[index - 1]
    const delimiterFollows = TABLE_DELIMITER_RE.test(lines[index + 1] ?? '') && (lines[index + 1] ?? '').includes('-')

    // A header row: it has pipes, the next line is the delimiter row, and the
    // line above is prose rather than a blank.
    if (
      delimiterFollows &&
      TABLE_ROW_RE.test(line) &&
      previous !== undefined &&
      previous.trim() &&
      !TABLE_ROW_RE.test(previous)
    ) {
      out.push('')
    }

    out.push(line)

    // Closing seam: the last row of the table followed directly by prose.
    const next = lines[index + 1]

    if (
      TABLE_ROW_RE.test(line) &&
      !TABLE_DELIMITER_RE.test(line) &&
      next !== undefined &&
      next.trim() &&
      !TABLE_ROW_RE.test(next) &&
      out.some(candidate => TABLE_DELIMITER_RE.test(candidate) && candidate.includes('-'))
    ) {
      out.push('')
    }
  }

  return out.join('\n')
}

function autolinkBareUrls(segment: string): string {
  return segment.replace(RAW_URL_RE, (url: string) => {
    const href = trimUrlTail(url)

    // Everything the URL gave back stays in the prose, outside the link.
    return href ? `<${href}>${url.slice(href.length)}` : url
  })
}

function rewriteProseSegment(segment: string): string {
  const withoutCitations = segment.replace(CITATION_MARKER_RE, '')

  return withoutCitations
    .split(LINK_SYNTAX_SPLIT_RE)
    .map(part => (LINK_SYNTAX_RE.test(part) ? part : autolinkBareUrls(part)))
    .join('')
}

function normalizeVisibleProse(text: string): string {
  return text
    .split(INLINE_CODE_SPLIT_RE)
    .map(part => (part.startsWith('`') ? part : rewriteProseSegment(part)))
    .join('')
}

/**
 * A maximal run of `*` or `_`. Only runs of exactly two are candidates below,
 * which is what keeps `***bold italic***` (one run of three) and a `* item`
 * bullet (one run of one) out of the transform entirely.
 */
const DELIMITER_RUN_RE = /\*+|_+/g
const EMPHASIS_PUNCTUATION_RE = /[\p{P}\p{S}]/u

interface DelimiterRun {
  char: string
  start: number
  end: number
}

/**
 * Inline code replaced by a filler of the same length, so a `**` inside a code
 * span is invisible to the scan while the two halves of ``** `x` y**`` can
 * still find each other. Same length means every index maps straight back onto
 * the original line. NUL is the filler because it reads as a word character to
 * the flanking checks — which is what a code span is — and cannot occur in text.
 */
function maskInlineCode(line: string): string {
  return line
    .split(INLINE_CODE_SPLIT_RE)
    .map(part => (part.startsWith('`') ? '\0'.repeat(part.length) : part))
    .join('')
}

function isSpaceAt(text: string, index: number): boolean {
  const char = text[index]

  // Off the end of the line counts as whitespace, the way CommonMark treats the
  // start and end of a line.
  return char === undefined || /\s/.test(char)
}

function isPunctuationAt(text: string, index: number): boolean {
  const char = text[index]

  return char !== undefined && EMPHASIS_PUNCTUATION_RE.test(char)
}

// CommonMark's flanking rules, only as far as a two-character run needs them.
// Without these the transform would happily produce a delimiter pair the lexer
// still refuses — `see** (x)**` → `see**(x)**` opens nothing either — and churn
// text for no gain.
function isLeftFlanking(text: string, start: number, end: number): boolean {
  if (isSpaceAt(text, end)) {
    return false
  }

  return !isPunctuationAt(text, end) || isSpaceAt(text, start - 1) || isPunctuationAt(text, start - 1)
}

function isRightFlanking(text: string, start: number, end: number): boolean {
  if (isSpaceAt(text, start - 1)) {
    return false
  }

  return !isPunctuationAt(text, start - 1) || isSpaceAt(text, end) || isPunctuationAt(text, end)
}

function canOpen(text: string, run: DelimiterRun): boolean {
  if (!isLeftFlanking(text, run.start, run.end)) {
    return false
  }

  // `_` is the intraword-safe delimiter: it may only open when it is not also a
  // closer, so `snake_case` stays prose.
  return run.char !== '_' || !isRightFlanking(text, run.start, run.end) || isPunctuationAt(text, run.start - 1)
}

function canClose(text: string, run: DelimiterRun): boolean {
  if (!isRightFlanking(text, run.start, run.end)) {
    return false
  }

  return run.char !== '_' || !isLeftFlanking(text, run.start, run.end) || isPunctuationAt(text, run.end)
}

function delimiterRuns(masked: string): DelimiterRun[] {
  const runs: DelimiterRun[] = []

  for (const match of masked.matchAll(DELIMITER_RUN_RE)) {
    const run = match[0]

    if (run.length === 2) {
      runs.push({ char: run[0] ?? '*', start: match.index, end: match.index + run.length })
    }
  }

  return runs
}

function whitespaceEndAfter(text: string, from: number): number {
  let cursor = from

  while (cursor < text.length && /[^\S\n]/.test(text[cursor] ?? '')) {
    cursor += 1
  }

  return cursor
}

function whitespaceStartBefore(text: string, before: number): number {
  let cursor = before

  while (cursor > 0 && /[^\S\n]/.test(text[cursor - 1] ?? '')) {
    cursor -= 1
  }

  return cursor
}

/**
 * Drop the stray space out of one line's emphasis runs.
 *
 * Runs are paired left to right, and a pair is only repaired when exactly ONE
 * of its two ends is broken by whitespace. That single rule is what keeps the
 * transform off `a ** b ** c` — arithmetic and literal asterisks break BOTH
 * ends, so there is nothing to anchor the intent on — while still catching the
 * two shapes a model actually emits, `** bold**` and `**bold **`. It also makes
 * the transform idempotent: a repaired pair has no broken end left.
 */
function repairEmphasisLine(line: string): string {
  const masked = maskInlineCode(line)
  const runs = delimiterRuns(masked)
  const cuts: { start: number; end: number }[] = []

  for (let index = 0; index + 1 < runs.length; index += 2) {
    const open = runs[index]
    const close = runs[index + 1]

    if (!open || !close || open.char !== close.char) {
      continue
    }

    const openSpaceEnd = whitespaceEndAfter(masked, open.end)
    const closeSpaceStart = whitespaceStartBefore(masked, close.start)
    const openBroken = openSpaceEnd > open.end
    const closeBroken = closeSpaceStart < close.start

    if (openBroken === closeBroken) {
      continue
    }

    const cut = openBroken ? { start: open.end, end: openSpaceEnd } : { start: closeSpaceStart, end: close.start }
    const content = masked.slice(openBroken ? openSpaceEnd : open.end, openBroken ? close.start : closeSpaceStart)

    if (!content.trim()) {
      continue
    }

    // Verify against the repaired line rather than trusting the shape: the cut
    // has to leave a run the lexer will really treat as a delimiter pair.
    const repaired = masked.slice(0, cut.start) + masked.slice(cut.end)
    const shift = cut.end - cut.start
    const movedClose = { char: close.char, start: close.start - shift, end: close.end - shift }

    if (canOpen(repaired, open) && canClose(repaired, movedClose)) {
      cuts.push(cut)
    }
  }

  // Right to left, so an earlier cut does not move a later one's indices.
  let out = line

  for (const cut of cuts.reverse()) {
    out = out.slice(0, cut.start) + out.slice(cut.end)
  }

  return out
}

/**
 * `** bold**` and `**bold **` → `**bold**`.
 *
 * Line by line, because emphasis that has to reach across a line break is not a
 * shape worth guessing at. Fenced blocks never get here — `preprocessMarkdown`
 * splits them off first — and inline code is masked out per line.
 */
export function repairStrayEmphasisSpaces(text: string): string {
  if (!text.includes('**') && !text.includes('__')) {
    return text
  }

  return text.split('\n').map(repairEmphasisLine).join('\n')
}

/**
 * The one entry point. Safe to call on every streaming flush: it is pure, and
 * every transform is written so that a half-arrived construct settles into its
 * final shape rather than flipping between two renderings.
 */
export function preprocessMarkdown(text: string): string {
  const cleaned = stripReasoningBlocks(text)
  const normalizedFences = normalizeFenceBlocks(cleaned)
  const withoutEmptyFences = stripEmptyFenceBlocks(normalizedFences)

  return withoutEmptyFences
    .split(CODE_FENCE_SPLIT_RE)
    .map(part => {
      // Fenced blocks pass through untouched: a `[1]` or a bare URL inside a
      // listing is the listing's own text.
      if (/^(?:```|~~~)/.test(part)) {
        return part
      }

      return spaceTableBlocks(normalizeVisibleProse(repairStrayEmphasisSpaces(renderMediaTags(part))))
    })
    .join('')
}
