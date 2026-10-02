/**
 * What a reply sounds like once it has been flattened for a speech engine.
 *
 * The cases here are the four constructs where speaking and reading genuinely
 * disagree — a code listing, a table, mathematics and a link — plus the two
 * boundaries every stripper in this tree is asked about: an empty string and a
 * half-streamed reply with an unclosed fence.
 */
import { guessSpeechLanguage, SHORT_CODE_CHARS, SHORT_CODE_LINES, speechText } from '../src/features/voice/speech-text'

describe('speechText', () => {
  it('drops the markdown syntax and keeps the words', () => {
    const spoken = speechText('## Retry semantics\n\nThe **gateway** re-runs the `turn` itself.')

    expect(spoken).toBe('Retry semantics.\nThe gateway re-runs the turn itself.')
  })

  it('reads a link by its label and never by its target', () => {
    const spoken = speechText('See [the release notes](https://example.com/notes?v=2) for details.')

    expect(spoken).toBe('See the release notes for details.')
    expect(spoken).not.toContain('example.com')
  })

  it('describes a long listing instead of reciting it', () => {
    const body = Array.from({ length: 12 }, (_, line) => `const value${line} = ${line}`).join('\n')
    const spoken = speechText(`Here:\n\n\`\`\`ts\n${body}\n\`\`\``)

    expect(spoken).toBe('Here:\nCode block, 12 lines.')
  })

  it('reads a short listing out, because a one-liner is often the answer', () => {
    const spoken = speechText('```sh\nnpm run typecheck\n```')

    expect(spoken).toBe('npm run typecheck.')
  })

  it('summarises a listing that is short in LINES but long in characters', () => {
    const long = 'x'.repeat(SHORT_CODE_CHARS + 10)

    expect(speechText(`\`\`\`\n${long}\n\`\`\``)).toBe('Code block, 1 line.')
  })

  it('says "1 line" rather than "1 lines"', () => {
    // Long enough to be summarised, short enough to be one line.
    const long = `a = ${'b'.repeat(SHORT_CODE_CHARS)}`

    expect(speechText(`\`\`\`\n${long}\n\`\`\``)).toContain('1 line.')
  })

  it('summarises a fence the reply has not closed yet', () => {
    // The state an automatic read can genuinely meet: a turn that ended between
    // the opening fence and the closing one is rare, but a menu opened on a
    // streaming reply is not.
    const spoken = speechText('Working on it:\n```py\nimport os\nimport sys\nprint(os.getcwd())')

    expect(spoken).toBe('Working on it:\nCode block, 3 lines.')
  })

  it('reads a table one row at a time, without its delimiter row', () => {
    const spoken = speechText(
      ['| Model | Window |', '| --- | ---: |', '| Opus | 200k |', '| Haiku | 100k |'].join('\n')
    )

    expect(spoken).toBe('Model, Window.\nOpus, 200k.\nHaiku, 100k.')
  })

  it('reads mathematics as its source, subscripts and all', () => {
    // The case that makes masking necessary: an emphasis stripper turns
    // `a_1 + b_2` into `a1 + b2`, which silently deletes both subscripts.
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

  it('keeps the short-listing threshold in agreement with its own constant', () => {
    const body = Array.from({ length: SHORT_CODE_LINES }, () => 'ok').join('\n')

    expect(speechText(`\`\`\`\n${body}\n\`\`\``)).not.toContain('Code block')
    expect(speechText(`\`\`\`\n${body}\nok\n\`\`\``)).toContain('Code block')
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
    // A tie is exactly the case where the device's own locale is the better
    // answer, so the heuristic has to say nothing rather than pick a side.
    expect(guessSpeechLanguage('que con')).toBeUndefined()
  })
})
