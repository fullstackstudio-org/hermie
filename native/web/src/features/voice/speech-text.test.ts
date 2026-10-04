/**
 * What a reply sounds like once it has been flattened for a speech engine: the four constructs where speaking and
 * reading disagree (a code listing, a table, mathematics and a link), plus the two boundaries every stripper in this
 * tree is asked about (an empty string, and a half-streamed reply with an unclosed fence). The expectations are the
 * Expo app's and the native apps': the three clients read a reply the same way.
 */
import { afterEach, describe, expect, it } from 'vitest'

import { resetActiveLocale } from '../../i18n/active-locale'
import { guessSpeechLanguage, SHORT_CODE_CHARS, SHORT_CODE_LINES, speechText } from './speech-text'

afterEach(resetActiveLocale)

describe('speechText', () => {
  it('drops the markdown syntax and keeps the words', () => {
    expect(speechText('## Retry semantics\n\nThe **gateway** re-runs the `turn` itself.')).toBe(
      'Retry semantics.\nThe gateway re-runs the turn itself.'
    )
  })

  it('reads a link by its label and never by its target', () => {
    const spoken = speechText('See [the release notes](https://example.com/notes?v=2) for details.')

    expect(spoken).toBe('See the release notes for details.')
    expect(spoken).not.toContain('example.com')
  })

  it('describes a long listing instead of reciting it', () => {
    const body = Array.from({ length: 12 }, (_, line) => `const value${line} = ${line}`).join('\n')

    expect(speechText(`Here:\n\n\`\`\`ts\n${body}\n\`\`\``)).toBe('Here:\nCode block, 12 lines.')
  })

  it('reads a short listing out, because a one-liner is often the answer', () => {
    expect(speechText('```sh\nnpm run typecheck\n```')).toBe('npm run typecheck.')
  })

  it('summarises a listing that is short in lines but long in characters, in the singular', () => {
    const long = 'x'.repeat(SHORT_CODE_CHARS + 10)

    expect(speechText(`\`\`\`\n${long}\n\`\`\``)).toBe('Code block, 1 line.')
  })

  it('summarises a fence the reply has not closed yet', () => {
    // The state an automatic read can meet, and a menu opened on a streaming reply certainly does.
    expect(speechText('Working on it:\n```py\nimport os\nimport sys\nprint(os.getcwd())')).toBe(
      'Working on it:\nCode block, 3 lines.'
    )
  })

  it('keeps the short-listing threshold in agreement with its own constant', () => {
    const body = Array.from({ length: SHORT_CODE_LINES }, () => 'ok').join('\n')

    expect(speechText(`\`\`\`\n${body}\n\`\`\``)).not.toContain('Code block')
    expect(speechText(`\`\`\`\n${body}\nok\n\`\`\``)).toContain('Code block')
  })

  it('reads a table a row at a time, without its delimiter row', () => {
    expect(speechText(['| Model | Window |', '| --- | ---: |', '| Opus | 200k |', '| Haiku | 100k |'].join('\n'))).toBe(
      'Model, Window.\nOpus, 200k.\nHaiku, 100k.'
    )
  })

  it('reads mathematics as its source, subscripts and all', () => {
    // The case that makes masking necessary: an emphasis stripper turns `a_1 + b_2` into `a1 + b2`.
    expect(speechText('The sum is $a_1 + b_2$ exactly.')).toBe('The sum is a_1 + b_2 exactly.')
    expect(speechText('$$\n\\frac{a}{b}\n$$')).toBe('\\frac{a}{b}.')
    expect(speechText('$$x^2 + y^2 = z^2$$')).toBe('x^2 + y^2 = z^2.')
  })

  it('leaves a line that already ends in punctuation alone', () => {
    expect(speechText('Done!')).toBe('Done!')
    expect(speechText('Is it?')).toBe('Is it?')
  })

  it('answers an empty string for nothing at all', () => {
    expect(speechText('')).toBe('')
    expect(speechText('\n\n---\n\n')).toBe('')
  })

  it('reads a list as sentences rather than as bullets', () => {
    expect(speechText('- first\n- second\n')).toBe('first.\nsecond.')
  })
})

describe('guessSpeechLanguage', () => {
  it('names a language it is confident about', () => {
    expect(guessSpeechLanguage('Het is niet duidelijk dat de gateway een antwoord voor ons heeft.')).toBe('nl')
    expect(guessSpeechLanguage('The gateway said that this would have been the answer you want.')).toBe('en')
  })

  it('declines rather than guessing on something too short', () => {
    expect(guessSpeechLanguage('ok')).toBeUndefined()
    expect(guessSpeechLanguage('')).toBeUndefined()
  })

  it('declines when two languages score the same', () => {
    // A tie is exactly the case where the browser's own voice is the better answer.
    expect(guessSpeechLanguage('que con')).toBeUndefined()
  })
})
