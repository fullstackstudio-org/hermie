/**
 * The rule that tells the next message from an echo of the last one.
 *
 * The composer-level cases, with the text view's event counter modelled, are in
 * `composer.test.tsx` ("the field after a send"); these pin the arithmetic.
 */
import { characters, editSize, withoutSentText } from '../../src/chat-ui/send-echo'

describe('characters', () => {
  it('keeps what one key types together', () => {
    expect(characters('a👍🏽b')).toEqual(['a', '👍🏽', 'b'])
    expect(characters('👩\u200D💻!')).toEqual(['👩\u200D💻', '!'])
    expect(characters('❤\uFE0F')).toEqual(['❤\uFE0F'])
    expect(characters('e\u0301')).toEqual(['e\u0301'])
    expect(characters('🇳🇱🇩🇪')).toEqual(['🇳🇱', '🇩🇪'])
    expect(characters('1\uFE0F\u20E3')).toEqual(['1\uFE0F\u20E3'])
  })

  it('keeps a decomposed Hangul syllable together, as well as a precomposed one', () => {
    // \uB124 as conjoining jamo: \u1102 + \u1166, and \uB135 as \u1102 + \u1166 + \u11B8.
    expect(characters('\u1102\u1166')).toEqual(['\u1102\u1166'])
    expect(characters('\u1102\u1166\u11B8!')).toEqual(['\u1102\u1166\u11B8', '!'])
    expect(characters('\uB124\uB124')).toEqual(['\uB124', '\uB124'])
  })
})

describe('editSize', () => {
  it('counts one keystroke as one, wherever it lands', () => {
    expect(editSize('', 'n')).toBe(1)
    expect(editSize('hello', 'hellon')).toBe(1)
    expect(editSize('hello', 'hllo')).toBe(1)
    expect(editSize('ab', 'axb')).toBe(1)
  })

  it('counts an emoji typed from the keyboard as one character, skin tone and all', () => {
    expect(editSize('', '👍')).toBe(1)
    expect(editSize('', '👍🏽')).toBe(1)
    expect(editSize('', '👩\u200D💻')).toBe(1)
  })

  it('counts a replacement as what went plus what came', () => {
    // `eh` out, `he` in.
    expect(editSize('teh', 'the')).toBe(4)
    expect(editSize('', 'hello')).toBe(5)
    expect(editSize('same', 'same')).toBe(0)
  })
})

describe('withoutSentText', () => {
  it('takes the sent words off a report the view made before it cleared', () => {
    expect(withoutSentText('hello', '', 'hellon')).toBe('n')
    expect(withoutSentText('hello', 'n', 'hellone')).toBe('ne')
    expect(withoutSentText('hello', 'ne', 'hellonew')).toBe('new')
  })

  it('reads a Backspace inside an echo as a Backspace on the next message', () => {
    expect(withoutSentText('hello', 'n', 'hello')).toBe('')
  })

  it('leaves the sent text on screen for a Backspace inside an echo of a one-character message', () => {
    // `k` sent, `n` caught, Backspace reports `k` — which is also what `n`
    // REPLACED by `k` looks like. The safe reading keeps the text.
    expect(withoutSentText('k', 'n', 'k')).toBeNull()
  })

  it('never takes a key that builds on the last character for an echo', () => {
    // Korean: ㄴ then ㅔ rewrites the jamo into the syllable 네.
    expect(withoutSentText('네', 'ㄴ', '네')).toBeNull()
    // Japanese 12-key: か tapped again is き; the voiced-sound key makes が.
    expect(withoutSentText('き', 'か', 'き')).toBeNull()
    expect(withoutSentText('が', 'か', 'が')).toBeNull()
  })

  it('keeps a QuickType word that replaces a caught character with the sent word and a space', () => {
    // `ok` sent, a fast `o` caught, then the suggestion turns `o` into `ok `.
    expect(withoutSentText('ok', 'o', 'ok ')).toBeNull()
    expect(withoutSentText('hi', 'h', 'hi ')).toBeNull()
  })

  it('takes the echo off a key that builds on the last character, when the view still held the sent text', () => {
    expect(withoutSentText('네', 'ㄴ', '네네')).toBe('네')
    expect(withoutSentText('が', 'か', 'がが')).toBe('が')
  })

  it('never touches a keystroke on the field as it should be', () => {
    // A one-letter message and the same letter again: the view did clear.
    expect(withoutSentText('k', '', 'k')).toBeNull()
    expect(withoutSentText('k', 'k', 'ko')).toBeNull()
    // The next message begins with the whole of the last one.
    expect(withoutSentText('ok', 'o', 'ok')).toBeNull()
    expect(withoutSentText('ok', 'ok', 'oka')).toBeNull()
  })

  it('refuses a paste outright: the rest is more than one edit from the field', () => {
    expect(withoutSentText('1', '', '10.0.0.5 is the IP')).toBeNull()
    expect(withoutSentText('y', '', 'yarn build failed')).toBeNull()
    expect(withoutSentText('https://x.io/a', '', 'https://x.io/a/b')).toBeNull()
    expect(withoutSentText('ok', '', 'okay')).toBeNull()
  })

  it('never cuts a character in half', () => {
    expect(withoutSentText('👍', '', '👍🏽')).toBeNull()
    expect(withoutSentText('e', '', 'e\u0301!')).toBeNull()
  })

  it('leaves a report that does not start with the sent text', () => {
    expect(withoutSentText('hello', '', 'hell')).toBeNull()
    expect(withoutSentText('hello', '', 'xhello')).toBeNull()
  })

  it('does nothing for a send that carried no text', () => {
    expect(withoutSentText('', '', 'abc')).toBeNull()
  })

  it('reads the sent text plus one character, in one go, as an echo — which is why the composer bounds it in time', () => {
    expect(withoutSentText('Thanks', '', 'Thanks ')).toBe(' ')
  })
})
