/**
 * The preview stripper.
 *
 * The regression it exists for is the first case: the owner read
 * `## Retry semantics: what actu…` off a chat-list row on a real device, which is
 * a preview spending two characters and a space on syntax and then truncating
 * the sentence it was supposed to show.
 */
import { plainTextPreview } from '../src/markdown/plain-text'
import { formatPreview, previewLine } from '../src/chat-ui/format'

describe('plainTextPreview', () => {
  it('drops the heading hashes the owner saw on a chat row', () => {
    expect(plainTextPreview('## Retry semantics: what actually happens')).toBe('Retry semantics: what actually happens')
  })

  it('takes every heading level, and a setext underline with it', () => {
    expect(plainTextPreview('###### Deep\n\nTitle\n=====\n\nBody')).toBe('Deep Title Body')
  })

  it('unwraps emphasis, strong and strike', () => {
    expect(plainTextPreview('**Done** — *mostly*, and ~~not~~ ___quite___')).toBe('Done — mostly, and not quite')
  })

  it('leaves an identifier with underscores alone', () => {
    // CommonMark forbids intraword `_` emphasis, and a preview that renamed
    // `row_id` to `rowid` would be worse than one that kept an underscore.
    expect(plainTextPreview('`row_id` pairs a live item with snake_case_name')).toBe(
      'row_id pairs a live item with snake_case_name'
    )
  })

  it('keeps the contents of a fenced block and drops the fence', () => {
    expect(plainTextPreview('Run it:\n\n```sh\nnpm run mac -- --no-open\n```\n\nThen look.')).toBe(
      'Run it: npm run mac -- --no-open Then look.'
    )
  })

  it('does not read markup inside a fence', () => {
    expect(plainTextPreview('```\n# not a heading\n- not a list\n**not bold**\n```')).toBe(
      '# not a heading - not a list **not bold**'
    )
  })

  it('strips inline code ticks of any run length, including one left over', () => {
    // The brief for a preview is "no backticks", so the tick the multi-tick span
    // legitimately protected goes too: a lone ` on a list row reads as damage.
    expect(plainTextPreview('use ``a ` b`` and `c`')).toBe('use a b and c')
  })

  it('collapses a link to its text and an image to its alt', () => {
    expect(plainTextPreview('See [the notes](https://example.com/a_b) and ![a chart](chart.png)')).toBe(
      'See the notes and a chart'
    )
  })

  it('keeps an autolink as its target, because that is the text', () => {
    expect(plainTextPreview('at <https://example.com/x>')).toBe('at https://example.com/x')
  })

  it('takes a reference link down to its text', () => {
    expect(plainTextPreview('per [ADR-0013][adr] this is a card')).toBe('per ADR-0013 this is a card')
  })

  it('removes list markers, ordered and unordered and task', () => {
    expect(plainTextPreview('- one\n* two\n+ three\n1. four\n2) five\n- [x] six\n- [ ] seven')).toBe(
      'one two three four five six seven'
    )
  })

  it('removes blockquote arrows however nested', () => {
    expect(plainTextPreview('> > quoted thing')).toBe('quoted thing')
  })

  it('removes a thematic break', () => {
    expect(plainTextPreview('before\n\n***\n\nafter')).toBe('before after')
  })

  it('reads a table as its cells and drops the delimiter row', () => {
    expect(plainTextPreview('| Rung | Hex |\n| --- | :-: |\n| e1 | #1C2A45 |')).toBe('Rung Hex e1 #1C2A45')
  })

  it('resolves a backslash escape to the character it protected', () => {
    expect(plainTextPreview('a literal \\*star\\* and a \\# hash')).toBe('a literal *star* and a # hash')
  })

  it('collapses every run of whitespace to one space and trims', () => {
    expect(plainTextPreview('  a\r\n\n\n   b\t\tc  ')).toBe('a b c')
  })

  it('is safe on empty input and on a half-streamed reply', () => {
    expect(plainTextPreview('')).toBe('')
    expect(plainTextPreview('## Retry sem')).toBe('Retry sem')
    // An opening fence with nothing closing it: everything after is verbatim.
    expect(plainTextPreview('Look:\n\n```ts\nconst a = 1')).toBe('Look: const a = 1')
  })
})

describe('previewLine', () => {
  it('strips first and clips second, so the budget buys words', () => {
    const value = previewLine('## Retry semantics: what actually happens when a socket drops mid-turn', 24)

    expect(value).toBe('Retry semantics: what a…')
    expect(value).not.toContain('#')
  })
})

describe('formatPreview', () => {
  it('folds a teammate message and strips the body it carries', () => {
    expect(formatPreview('Message from 🤖 Writer (@writer): ## Draft ready\n\n- one')).toBe(
      '🤖 @writer: Draft ready one'
    )
  })

  it('strips a plain gateway preview too', () => {
    expect(formatPreview('**Done.** See `notes.md`')).toBe('Done. See notes.md')
  })
})
