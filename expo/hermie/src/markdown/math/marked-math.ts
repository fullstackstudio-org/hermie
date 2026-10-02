/**
 * The four maths delimiters as tokens, so the lexer stops eating the mathematics.
 *
 * Without this the markdown lexer reads an expression as prose: `a_i` opens
 * emphasis, `\\` is an escape, `x^2*y` italicises the rest of the line, and what
 * reaches the renderer is no longer what the model wrote. Protecting the spans in
 * `preprocess.ts` — the desktop app's approach — would mean masking and
 * unmasking around every other rewrite in that file; a tokenizer says the same
 * thing once, at the only level that actually owns it.
 *
 * ## Why the dollar has to be defended
 *
 * `$` is money far more often than it is mathematics, and a chat with an agent is
 * full of both. Three rules keep `costs $5 and $7` out of the renderer:
 *
 *  - the opening `$` is followed by something that is not a space, and the
 *    closing one is preceded by something that is not a space;
 *  - neither `$` has a digit on its outer side, so `$5` cannot open and `7$`
 *    cannot close;
 *  - the span holds no blank line, because an expression does not span
 *    paragraphs and a run of prose between two prices very often does.
 *
 * A span that fails any of them is not a token at all, so the characters fall
 * through to the ordinary rules and print as themselves. That is the safe
 * direction: a missed expression renders as the LaTeX a reader can still read,
 * while a false positive would silently rewrite a sentence about prices.
 *
 * ## Why `\(…\)` and `\[…\]` are NOT defended the same way
 *
 * They are the other half of what a model writes, and without them the backslash
 * pairs are read by the markdown lexer as ESCAPES — `\(x\)` renders as `(x)` with
 * the mathematics inside it set as prose, which is the worst of the three possible
 * outcomes because it looks deliberate.
 *
 * The no-space rule above does not carry over to them, and that is deliberate
 * rather than an oversight. It exists because `$` is money: `costs $5 and $7` has
 * to stay a sentence. A backslash-paren has no such twin — nothing in prose spells
 * it — while `\( x^2 \)` with spaces inside the fence is how half of all real
 * LaTeX is written. Requiring the tight form would refuse the common spelling to
 * defend against an ambiguity that does not exist. What IS kept is the rest: the
 * span may not be empty, and it may not cross a blank line, because an expression
 * does not span paragraphs and an unterminated one mid-stream otherwise swallows
 * the rest of the reply.
 *
 * ## Shape rather than import
 *
 * These are plain objects, described structurally, because `marked-compat.ts` is
 * the one place `marked` is imported from — it has to rewrite two inline rules
 * before any lexer is constructed, and a second import of the package here would
 * make the order that matters depend on module resolution.
 */

/** The token a block expression produces. */
export const MATH_BLOCK_TOKEN = 'mathBlock'

/** The token an inline expression produces. */
export const MATH_INLINE_TOKEN = 'mathInline'

export interface MathToken {
  type: typeof MATH_BLOCK_TOKEN | typeof MATH_INLINE_TOKEN
  raw: string
  /** The LaTeX between the delimiters, delimiters excluded. */
  text: string
}

/**
 * `$$ … $$` as its own block, with the blank lines after it.
 *
 * The trailing newlines are part of `raw` so the block splitter's
 * `blocks.join('') === text` invariant still holds — see `blocks.ts`, which falls
 * back to one undivided block the moment a token's `raw` does not round-trip.
 */
const BLOCK_RE = /^ {0,3}\$\$([^$][\s\S]*?)\$\$[ \t]*(?:\n+|$)/

/**
 * `$ … $` inside a line.
 *
 * Anchored, because a tokenizer is only ever offered the remainder of the line.
 * The lookarounds carry the three rules above; the body excludes `$` outright, so
 * the match is always the NEAREST closing delimiter and a stray dollar later in
 * the sentence cannot be dragged into the expression.
 */
const INLINE_RE = /^\$(?![\s$])((?:[^$\n]|\n(?!\s*\n))*?[^\s$])\$(?!\d)/

/**
 * `\[ … \]` as its own block, the display form of the pair above.
 *
 * Block level only, which is where a model puts it: on its own lines, between two
 * paragraphs. A `\[` in the MIDDLE of a sentence is left to the ordinary rules,
 * because the block tokenizer is only ever offered the start of a block and an
 * inline display expression would have to be set on one line anyway — at which
 * point it is the inline form with different characters around it.
 */
const BRACKET_BLOCK_RE = /^ {0,3}\\\[([\s\S]*?)\\\][ \t]*(?:\n+|$)/

/**
 * `\( … \)` inside a line.
 *
 * Anchored, because a tokenizer is only offered the remainder of the line. The
 * body may not contain a blank line and may not be empty; it may otherwise hold
 * anything, including the spaces the dollar form refuses.
 */
const PAREN_INLINE_RE = /^\\\(((?:[^\n]|\n(?!\s*\n))*?)\\\)/

/** A tokenizer, in the shape marked's extension API asks for. */
export interface MathExtension {
  name: string
  level: 'block' | 'inline'
  start: (src: string) => number | undefined
  tokenizer: (src: string) => MathToken | undefined
}

/**
 * Where the next expression might begin.
 *
 * marked uses this to decide how much plain text it may consume in one go, so an
 * answer that is too LATE loses the expression and one that is too early only
 * costs a tokenizer call that declines.
 */
function earliest(src: string, ...markers: string[]): number | undefined {
  const found = markers.map(marker => src.indexOf(marker)).filter(at => at !== -1)

  return found.length ? Math.min(...found) : undefined
}

export const mathBlockExtension: MathExtension = {
  level: 'block',
  name: MATH_BLOCK_TOKEN,
  start: src => earliest(src, '$$', '\\['),
  tokenizer: src => {
    const match = BLOCK_RE.exec(src) ?? BRACKET_BLOCK_RE.exec(src)

    if (!match) {
      return undefined
    }

    const text = match[1] ?? ''

    // An empty fence is two delimiters and nothing between them, which is what
    // the first flush of `$$` on its own line looks like. Declining leaves the
    // characters as themselves rather than claiming an expression with no body.
    if (!text.trim()) {
      return undefined
    }

    return { raw: match[0], text, type: MATH_BLOCK_TOKEN }
  }
}

export const mathInlineExtension: MathExtension = {
  level: 'inline',
  name: MATH_INLINE_TOKEN,
  start: src => earliest(src, '$', '\\('),
  tokenizer: src => {
    // `$$` at an inline position is a block delimiter that ended up in a
    // paragraph — an unterminated one, usually, mid-stream. Declining leaves it
    // as characters rather than opening an expression that swallows the reply.
    if (src.startsWith('$$')) {
      return undefined
    }

    const match = INLINE_RE.exec(src) ?? PAREN_INLINE_RE.exec(src)

    if (!match) {
      return undefined
    }

    const text = match[1] ?? ''

    if (!text.trim()) {
      return undefined
    }

    return { raw: match[0], text, type: MATH_INLINE_TOKEN }
  }
}

/** Both extensions, in the order marked wants them registered. */
export const mathExtensions: MathExtension[] = [mathBlockExtension, mathInlineExtension]

/** Whether a token came out of one of the two tokenizers above. */
export function isMathToken(token: { type?: string }): token is MathToken {
  return token.type === MATH_BLOCK_TOKEN || token.type === MATH_INLINE_TOKEN
}
