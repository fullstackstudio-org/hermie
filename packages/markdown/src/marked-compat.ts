/**
 * The one place `marked` is imported from, because two of its inline rules have
 * to be rewritten before any lexer reads them.
 *
 * ## 1. `blockSkip`, which on Hermes does not do what it says
 *
 * `blockSkip` is the rule marked uses to MASK inline code, links and tags out of
 * a line before it looks for the closing half of an emphasis run. The mask has
 * to stay character-aligned with the real source — `emStrong` slices one by the
 * other's length — so masking the WRONG span does not merely lose a code chip:
 * it stops emphasis being found at all. On a device, every `**bold**` that
 * contained a code span printed its asterisks literally, while the same string
 * came out bold in every Node test. That gap is the whole reason a green suite
 * sat next to a wrong screen for two rounds.
 *
 * Measured on an iPad simulator (iOS 26.5, RN 0.81's Hermes):
 *
 * ```js
 * 'a `x` b'.match(Lexer.rules.inline.gfm.blockSkip)   // node:   ['`x`']
 *                                                     // Hermes: ['` b']
 * ```
 *
 * '` b' is what the pattern degrades to when its BACKREFERENCE — "the same run
 * of backticks again" — matches the empty string. Naming has nothing to do with
 * it (rewriting `\k<b>` to `\3` changed nothing on the device), and a
 * backreference on its own is fine there: /(`+)[^`]+\1(?!`)/ matches '`x`' on
 * Hermes. Something about the surrounding alternation defeats it, and the app
 * does not need to know what — the rule can say the same thing with no
 * backreference at all.
 *
 * So the code-run construct is rewritten to an explicit alternation over run
 * lengths. `__tests__/markdown-marked-compat.test.ts` pins that the rewrite
 * masks the same spans as marked's own rule, which is what fails loudly if a
 * marked upgrade changes the pattern's shape.
 *
 * Worth filing upstream against Hermes; marked is doing nothing wrong.
 *
 * ## 2. Strikethrough, which GFM opens on a SINGLE tilde
 *
 * That one is marked being faithful to GFM, and GFM being wrong for a chat app.
 * See `restrictStrikethroughToDoubleTilde` below.
 *
 * ## 3. Mathematics, which the lexer would otherwise eat
 *
 * `$…$` and `$$…$$` are registered as real tokens here rather than masked in
 * `preprocess.ts`, so `a_i` stops opening emphasis and `\\` stops being an
 * escape. `math/marked-math.ts` holds the two tokenizers and the rules that keep
 * a price out of them; this is only where they are attached, because attaching
 * them anywhere else would put a second import of `marked` in front of the two
 * rewrites above.
 */
import { Lexer, marked } from 'marked'

import { mathExtensions } from './math/marked-math'

/**
 * marked's code-run construct: an opening run of backticks, content, the SAME
 * run again. It appears twice — once inside the link alternative, once as the
 * code alternative of its own — and both are this exact shape, named or not.
 */
const BACKREFERENCED_CODE_RUN = /\((?:\?<[A-Za-z][A-Za-z0-9]*>)?`\+\)\[\^`\]\+(?:\\k<[A-Za-z][A-Za-z0-9]*>|\\\d+)/g

/** The code alternative in full, with the empty marker marked reads for a length. */
const CODE_ALTERNATIVE = new RegExp(`\\(\\?<!\`\\)\\(\\)${BACKREFERENCED_CODE_RUN.source}`, 'g')

/**
 * The same alternative with its groups SWAPPED: the backtick run first, the
 * empty marker second.
 *
 * Both orders say the same thing to a correct engine and to marked — which
 * reads the second group, and gets the same empty string either way. The
 * difference is the backreference: `\1` is the first group of the first
 * alternative that has any, which is the one number both a global and a
 * per-alternative count agree on. Keeping the pattern this close to marked's own
 * is deliberate; an earlier attempt spelled the run out as an eight-way
 * alternation instead, and Hermes matched THAT as the empty string.
 */
const CODE_ALTERNATIVE_FIRST_GROUP = '(?<!`)(`+)()[^`]+\\1'

/**
 * The run with no group at all, for the copy inside the link alternative.
 *
 * Looser than marked's — it does not insist the closing run is as long as the
 * opening one — and that is the point: it leaves the code alternative holding
 * the only capturing groups in the rule, so `\1` cannot be counted two ways.
 * A label whose backtick runs differ in length is the only thing that masks
 * differently, and the label is inside a span that is masked whole anyway.
 */
const GROUPLESS_CODE_RUN = '`+[^`]+`+'

/**
 * Rewrite one pattern's backreferenced code runs, or give it back unchanged.
 */
export function withoutAmbiguousCodeRuns(pattern: string): string {
  return pattern
    .replace(CODE_ALTERNATIVE, CODE_ALTERNATIVE_FIRST_GROUP)
    .replace(BACKREFERENCED_CODE_RUN, GROUPLESS_CODE_RUN)
}

/**
 * Rewrite every inline rule that carries one, in place.
 *
 * In place because `Lexer.rules` is what a lexer reads its rules from on
 * construction: there is no supported hook that reaches `blockSkip`, and
 * re-implementing the emphasis tokenizer to avoid one line of regex would be a
 * far larger thing to be wrong about. Idempotent — a rewritten pattern no longer
 * matches the thing that selects it.
 */
export function patchBackreferencedCodeRuns(): void {
  for (const rules of Object.values(Lexer.rules.inline) as Record<string, RegExp>[]) {
    for (const [name, pattern] of Object.entries(rules)) {
      if (!(pattern instanceof RegExp)) {
        continue
      }

      const rewritten = withoutAmbiguousCodeRuns(pattern.source)

      if (rewritten !== pattern.source) {
        rules[name] = new RegExp(rewritten, pattern.flags)
      }
    }
  }
}

/**
 * GFM's optional second tilde: the one character that makes `~x~` a deletion.
 *
 * It appears in all three strikethrough rules and nowhere else in the inline
 * rule set — `del` (the whole construct), `delLDelim` (the opening run) and
 * `delRDelim` (six capturing copies of the closing run). The tokenizer counts
 * the tildes it found on the left and demands the same count on the right, so
 * rewriting every copy to a fixed pair says one thing: two tildes open, two
 * close, and a lone `~` is a character.
 */
const OPTIONAL_SECOND_TILDE = /~~\?/g

/** `~~` where marked wrote `~~?`, or the pattern back unchanged. */
export function withoutSingleTildeStrikethrough(pattern: string): string {
  return pattern.replace(OPTIONAL_SECOND_TILDE, '~~')
}

/**
 * Make `~~text~~` the only strikethrough, on every rule set a lexer can pick.
 *
 * GFM says a single `~` pair deletes, and marked implements exactly that. In
 * prose that is nearly always right and in a chat with an agent it is nearly
 * always wrong, because the text people paste is shell:
 *
 * ```text
 * root@hermes:~# stat -c '%u:%g %n' /usr/bin/sudo
 * 0:0 /usr/bin/sudo
 * root@hermes:~#
 * ```
 *
 * Two prompts, two tildes, and everything between them renders struck through
 * with both tildes eaten — the reader loses the marker AND the text is crossed
 * out as if the agent had retracted it. A path like `~/dir` in a sentence pairs
 * with the next `~` just as happily.
 *
 * Nothing real is lost. A model that means strikethrough writes `~~`; a person
 * who types one tilde means a tilde. The rewrite is in the lexer rather than in
 * `preprocess`, so it holds for every surface at once — bubbles, the selectable
 * flattening in `attributed.ts` and the block splitter — and for what the user
 * typed exactly as much as for what the agent replied.
 *
 * In place, and idempotent, for the same reasons as the rewrite above: `~~` no
 * longer matches the construct that selects it.
 */
export function restrictStrikethroughToDoubleTilde(): void {
  for (const rules of Object.values(Lexer.rules.inline) as Record<string, RegExp>[]) {
    for (const [name, pattern] of Object.entries(rules)) {
      if (!(pattern instanceof RegExp)) {
        continue
      }

      const rewritten = withoutSingleTildeStrikethrough(pattern.source)

      if (rewritten !== pattern.source) {
        rules[name] = new RegExp(rewritten, pattern.flags)
      }
    }
  }
}

/**
 * Attach the two math tokenizers to the default instance.
 *
 * The default instance is what `marked.lexer` reads, and `marked.lexer` is what
 * every surface in this folder calls — the renderer, the block splitter and the
 * selectable flattening — so one registration covers all three and they cannot
 * disagree about where an expression begins.
 *
 * Idempotent in the only sense that matters here: this module is evaluated once,
 * and `marked.use` appends, so it must not be called from anywhere else.
 */
export function registerMathTokenizers(): void {
  marked.use({ extensions: mathExtensions as never })
}

patchBackreferencedCodeRuns()
restrictStrikethroughToDoubleTilde()
registerMathTokenizers()

export { marked }
export type { Token, Tokens } from 'marked'
