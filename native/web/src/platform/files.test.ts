/**
 * The name a download is saved under (`downloadNameOf`): the last segment, nothing a file system refuses, and none of
 * the characters the card's name is shown without, so the saved name is the one the reader saw.
 */
import { describe, expect, it } from 'vitest'

import { downloadNameOf } from './files'

describe('downloadNameOf', () => {
  it.each([
    ['report.pdf', 'report.pdf'],
    ['Q3 report.html', 'Q3 report.html'],
    ['a/b/c.txt', 'c.txt'],
    ['a\\b\\c.txt', 'c.txt'],
    ['a<b>:"|?*.txt', 'a_b______.txt'],
    ['  padded.txt  ', 'padded.txt'],
    ['', 'file'],
    ['   ', 'file']
  ])('turns %j into %j', (name, expected) => {
    expect(downloadNameOf(name)).toBe(expected)
  })

  it('drops control characters', () => {
    expect(downloadNameOf('a\u0000b\u0007c\u009fd.txt')).toBe('abcd.txt')
    expect(downloadNameOf('line\nbreak\r.txt')).toBe('linebreak.txt')
  })

  it('drops format characters: a right-to-left override cannot swap the extension, nor a joiner hide in the name', () => {
    expect(downloadNameOf('invoice‮txt.exe')).toBe('invoicetxt.exe')
    expect(downloadNameOf('a​b‍c⁦d﻿.pdf')).toBe('abcd.pdf')
  })

  it('keeps letters of every script and emoji', () => {
    expect(downloadNameOf('日本語 – résumé 😀.docx')).toBe('日本語 – résumé 😀.docx')
  })

  it('is empty-safe when nothing is left after cleaning', () => {
    expect(downloadNameOf('​‮')).toBe('file')
  })
})
