/**
 * `verbatim.ts`: the rules for text that is shown exactly as it is (`contract/requests/README.md` §6.2 and §6.3),
 * which a structured `confirm` field, a path and every line of a diff go through.
 */
import { describe, expect, it } from 'vitest'

import { codePointLength, defaultIgnorable, isPySpace, layoutProblem, pyRstrip, verbatimProblem } from './verbatim'

describe('verbatimProblem', () => {
  it('takes ordinary text, letters of any script and emoji', () => {
    for (const text of [
      'Pay 120.00 EUR to Example Plumbing B.V.',
      'Überweisung an die Bäckerei Größe',
      '支付发票 7',
      'ok \u{1f600}',
      'a\nb\n\nc'
    ]) {
      expect(verbatimProblem(text), text).toBe('')
    }
  })

  it.each([
    ['a tab', 'a\tb'],
    ['a carriage return', 'a\rb'],
    ['a vertical tab', 'a\u000bb'],
    ['a no-break space', 'a b'],
    ['an ideographic space', 'a　b'],
    ['a line separator', 'a b'],
    ['a zero-width space', 'a​b'],
    ['a right-to-left override', 'a‮b'],
    ['a soft hyphen', 'a­b'],
    ['an emoji variation selector', '❤️'],
    ['a Hangul filler', 'aㅤb'],
    ['the blank Braille pattern', 'a⠀b'],
    ['an unassigned code point', 'a͸b'],
    ['a private-use character', 'ab'],
    ['a lone surrogate', 'a\ud800b'],
    ['a NUL', 'a\u0000b']
  ])('refuses %s', (_name, text) => {
    expect(verbatimProblem(text)).toMatch(/cannot be shown as it is/)
  })

  it('refuses more than four combining marks in a row, and allows four', () => {
    expect(verbatimProblem(`e${'́'.repeat(4)}`)).toBe('')
    expect(verbatimProblem(`e${'́'.repeat(5)}`)).toBe('too many combining marks on one character')
    expect(verbatimProblem(`${'́'.repeat(5)}`)).toBe('too many combining marks on one character')
  })

  it('refuses whitespace at the end of a line or of the text', () => {
    expect(verbatimProblem('a ')).toMatch(/whitespace at the end/)
    expect(verbatimProblem('a \nb')).toMatch(/whitespace at the end/)
    expect(verbatimProblem('a\n')).toMatch(/whitespace at the end/)
    expect(verbatimProblem('a\n\nb')).toBe('')
  })

  it('refuses padding that could push part of a text out of view', () => {
    expect(verbatimProblem(`x${' '.repeat(16)}y`)).toBe('')
    expect(verbatimProblem(`x${' '.repeat(17)}y`)).toMatch(/17 spaces in a row/)
    expect(verbatimProblem(`${' '.repeat(32)}x`)).toBe('')
    expect(verbatimProblem(`${' '.repeat(33)}x`)).toMatch(/indented 33 spaces/)
    expect(verbatimProblem(`a\n\n\n\nb`)).toBe('')
    expect(verbatimProblem(`a\n\n\n\n\nb`)).toMatch(/more than 3 blank lines in a row/)
    expect(verbatimProblem('\n\n\n\nx')).toMatch(/more than 3 blank lines/)
    expect(verbatimProblem('x'.repeat(2000))).toBe('')
    expect(verbatimProblem('x'.repeat(2001))).toMatch(/2001 characters/)
  })
})

describe('the helpers', () => {
  it('counts code points, not UTF-16 units', () => {
    expect(codePointLength('\u{1f600}')).toBe(1)
    expect(codePointLength('á')).toBe(2)
  })

  it('knows Python’s isspace and the contract’s default-ignorable table', () => {
    for (const ch of ['\t', '\n', '\u001c', '\u0085', ' ', ' ', '　']) {
      expect(isPySpace(ch), JSON.stringify(ch)).toBe(true)
    }

    for (const ch of ['a', '​', '﻿', '᠎']) {
      expect(isPySpace(ch), JSON.stringify(ch)).toBe(false)
    }

    expect(pyRstrip('a \t　\n')).toBe('a')
    expect(defaultIgnorable('️')).toBe(true)
    expect(defaultIgnorable('\u{e0100}')).toBe(true)
    expect(defaultIgnorable('a')).toBe(false)
    expect(layoutProblem('plain text')).toBe('')
  })
})
