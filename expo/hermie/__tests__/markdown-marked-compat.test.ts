/**
 * The two inline rules this app rewrites before a lexer reads them.
 *
 * The first makes emphasis-around-code work on Hermes. Node's regex engine gets
 * marked's original pattern right, so no test running here can fail the way the
 * device failed — which is exactly the trap that let `**\`x\` y**` print its
 * asterisks on a phone through two green rounds. What a Node test CAN hold
 * still is the claim the rewrite makes: that it masks the same spans marked's
 * own rule masks. If a marked upgrade moves the pattern, the rewrite silently
 * stops applying and the equivalence below is what says so.
 *
 * The second narrows strikethrough to `~~`. That one DOES fail here when it
 * regresses, and it is tested on the rendered screen as well
 * (`chat-ui/markdown-strikethrough.test.tsx`); what belongs here is the same
 * upgrade tripwire — a rule set where the optional tilde survived is a rule set
 * where the rewrite stopped selecting the pattern.
 */
import { Lexer } from 'marked'

import { withoutAmbiguousCodeRuns, withoutSingleTildeStrikethrough } from '../src/markdown/marked-compat'

/** marked's own rule, as published, before this app touches it. */
const ORIGINAL =
  /\[(?:[^[\]`]|(?<a>`+)[^`]+\k<a>(?!`))*?\]\((?:\\[\s\S]|[^\\()]|\((?:\\[\s\S]|[^\\()])*\))*\)|(?<!`)()(?<b>`+)[^`]+\k<b>(?!`)|<(?! )[^<>]*?>/g

/**
 * marked's masking step, copied from `Lexer.inlineTokens`.
 *
 * The output is what matters, not the groups: the mask has to be the same
 * characters and — above all — the same LENGTH as the source, because
 * `emStrong` slices one by the other's length.
 */
function mask(line: string, rule: RegExp): string {
  return line.replace(rule, (whole: string, _first: string, second: string) => {
    const keep = second ? second.length : 0

    return `${whole.slice(0, keep)}[${'a'.repeat(whole.length - keep - 2)}]`
  })
}

const CORPUS = [
  'en **`example.nl` staat op autorenew=off** — dus',
  'a `x` b',
  'a ``x`` b',
  'x ```y``` z',
  '[a `b` c](http://x)',
  '<tag>',
  'no code here',
  '`a` and `b`',
  '[link](http://a) `c` <i>',
  'a **b `c` d** e',
  '**`only code`**',
  'trailing backtick `'
]

describe('the rewritten rule', () => {
  it('masks exactly what marked masks', () => {
    const rewritten = new RegExp(withoutAmbiguousCodeRuns(ORIGINAL.source), ORIGINAL.flags)

    for (const line of CORPUS) {
      expect(mask(line, rewritten)).toBe(mask(line, ORIGINAL))
    }
  })

  it('keeps the mask the same length as the source, which is the property that broke', () => {
    const rewritten = new RegExp(withoutAmbiguousCodeRuns(ORIGINAL.source), ORIGINAL.flags)

    for (const line of CORPUS) {
      expect(mask(line, rewritten)).toHaveLength(line.length)
    }
  })

  it('leaves the capturing groups where marked reads them', () => {
    const rewritten = new RegExp(withoutAmbiguousCodeRuns(ORIGINAL.source), ORIGINAL.flags)
    const match = /a `x` b/.test('a `x` b') ? new RegExp(rewritten.source).exec('a `x` b') : null

    // Group 2 is the empty marker marked measures for a prefix length; an
    // engine that hands back a run of backticks there would keep them unmasked.
    expect(match?.[2]).toBe('')
  })

  it('carries no backreference into the alternative that needs one counted', () => {
    const rewritten = withoutAmbiguousCodeRuns(ORIGINAL.source)

    // `\1` and nothing higher: the first group of the first alternative that
    // has any is the one number a global and a per-alternative count agree on.
    expect(rewritten).toContain('\\1')
    expect(rewritten).not.toContain('\\k<')
    expect(rewritten).not.toMatch(/\\[2-9]/)
  })

  it('gives a pattern it does not recognise back unchanged', () => {
    expect(withoutAmbiguousCodeRuns('^nothing to do here$')).toBe('^nothing to do here$')
  })
})

describe('the rule marked will actually use', () => {
  it('has been rewritten in place, on every rule set a lexer can pick', () => {
    for (const rules of Object.values(Lexer.rules.inline) as Record<string, RegExp>[]) {
      expect(rules.blockSkip?.source).not.toContain('\\k<')
    }
  })

  /**
   * The strikethrough rules are three — the whole construct, the opening run
   * and the six copies of the closing run — and the optional tilde has to be
   * gone from all of them. One survivor is enough to delete a terminal paste
   * again, because the tokenizer only demands that the two ends agree.
   */
  it('opens strikethrough on nothing shorter than two tildes', () => {
    let rewritten = 0

    for (const rules of Object.values(Lexer.rules.inline) as Record<string, RegExp>[]) {
      for (const [name, pattern] of Object.entries(rules)) {
        // Not every entry is a pattern: marked parks a `{ exec: () => null }`
        // stub where a rule set has no rule of that name.
        if (!(pattern instanceof RegExp)) {
          continue
        }

        expect(pattern.source).not.toContain('~~?')

        if (/^del/.test(name)) {
          rewritten += 1
        }
      }
    }

    // Two rule sets carry strikethrough — `gfm` and `breaks` — and three rules
    // each. A count of zero would pass every assertion above by finding nothing.
    expect(rewritten).toBe(6)
  })

  it('gives a pattern with no optional tilde back unchanged', () => {
    expect(withoutSingleTildeStrikethrough('^~~(?=[^\\s~])')).toBe('^~~(?=[^\\s~])')
  })
})
