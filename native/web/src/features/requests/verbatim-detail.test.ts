/**
 * The whitespace rule a confirmation's detail is drawn with (`verbatim-detail.ts`), the table the native
 * app's implementation shares.
 */
import { describe, expect, it } from 'vitest'

import { emptyLinesMarker, markVerbatimDetail } from './verbatim-detail'

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

  it('counts lines and the longest line on the verbatim text, in code points', () => {
    expect(markVerbatimDetail('ab\n🙂🙂🙂\n\n\n\n')).toMatchObject({ lines: 6, longestLine: 3 })
  })

  it('takes the words of the marker line from the sheet', () => {
    expect(markVerbatimDetail('a\n\n\n\nb', count => `⋯ ${count} lege regels ⋯`).text).toBe('a\n⋯ 3 lege regels ⋯\nb')
  })
})
