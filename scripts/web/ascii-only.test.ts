import { runInNewContext } from 'node:vm'

import { parseAst } from 'rollup/parseAst'
import { describe, expect, it } from 'vitest'

import { escapeNonAscii } from '../../native/web/scripts/ascii-only.mjs'

const escaped = (code: string): string => escapeNonAscii(code, parseAst, 'index.js')
const run = (code: string): unknown => runInNewContext(code)

describe('escapeNonAscii', () => {
  it('leaves a chunk that is already ASCII exactly as it is', () => {
    const code = 'const a="x";const b=`y${a}`;'

    expect(escaped(code)).toBe(code)
  })

  it('writes the character as \\uXXXX in a string, a template and a pattern, and the program means the same', () => {
    const code = 'const parts=["é",`“${1}”`,/[“”]+/.exec("x“”y")[0]];parts'
    const out = escaped(code)

    expect(out).toMatch(/^[\t\n\r\x20-\x7e]*$/u)
    expect(out).toContain('\\u00e9')
    expect(out).toContain('[\\u201c\\u201d]')
    expect(run(out)).toEqual(run(code))
  })

  it('writes a character outside the BMP as its surrogate pair, in a pattern too', () => {
    const code = 'const parts=["\u{1f600}",/^[\u{1f600}]$/u.test("\u{1f600}")];parts'
    const out = escaped(code)

    expect(out).toContain('\\ud83d\\ude00')
    expect(out).toMatch(/^[\t\n\r\x20-\x7e]*$/u)
    expect(run(out)).toEqual(run(code))
  })

  it('escapes after an even run of backslashes: the backslashes are a pair, the character is not escaped', () => {
    const code = 'const s="\\\\é";s'
    const out = escaped(code)

    expect(out).toBe('const s="\\\\\\u00e9";s')
    expect(run(out)).toBe(run(code))
  })

  it('fails the build after an odd run of backslashes, where \\uXXXX would change the text', () => {
    // `/[\<char>]/` is the character, escaped; `/[\\u201c]/` would be a backslash and the letters.
    expect(() => escaped('const r=/[\\“]/;')).toThrow(/follows a backslash/)
    expect(() => escaped('const s="\\é";')).toThrow(/follows a backslash/)
    expect(() => escaped('const s="\\\\\\é";')).toThrow(/follows a backslash/)
  })

  it('fails the build for a character inside a tagged template, whose tag gets the raw text', () => {
    expect(() => escaped('const s=String.raw`“`;')).toThrow(/tagged template/)
    expect(() => escaped('const s=tag`a${1}é`;')).toThrow(/tagged template/)
  })

  it('does not take what a tagged template merely contains for its text', () => {
    // The character is in a string inside a substitution: ordinary code, and an ordinary escape.
    const code = 'const s=String.raw`a${"é"}b`;s'
    const out = escaped(code)

    expect(out).toContain('${"\\u00e9"}')
    expect(run(out)).toBe(run(code))
  })

  it('names the chunk, the character and where it is', () => {
    expect(() => escaped('const s=String.raw`“`;')).toThrow('index.js: non-ASCII character U+201C at offset 19')
  })

  it('escapes a control character a minified chunk can only hold inside a literal', () => {
    expect(escaped('const s="\u0001";')).toBe('const s="\\u0001";')
  })
})
