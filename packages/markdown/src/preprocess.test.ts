/**
 * Citation markers: stripped from prose, never from mathematics.
 *
 * `word[1]` is a search tool's footnote and goes; `\sqrt[3]{x}` is a cube root
 * whose index is a `[3]` glued to a letter, so the same rule used to turn it into
 * a square root. The Swift port (`MarkdownPreprocessor.swift`) runs the same
 * patterns, and the cases below are mirrored in the golden corpus
 * (`scripts/golden/markdown-corpus.ts`) that holds the two together.
 */
import { describe, expect, it } from 'vitest'

import { preprocessMarkdown } from './preprocess'

describe('citation markers', () => {
  it('strips a marker glued to a word, and a list of them', () => {
    expect(preprocessMarkdown('The sky is blue[1] and grass is green[2, 3].')).toBe(
      'The sky is blue and grass is green.'
    )
  })

  it('keeps the index of a root inside $…$', () => {
    expect(preprocessMarkdown('The cube root is $\\sqrt[3]{x}$ today.')).toBe('The cube root is $\\sqrt[3]{x}$ today.')
  })

  it('keeps the index of a root inside \\(…\\)', () => {
    expect(preprocessMarkdown('The cube root is \\(\\sqrt[3]{x}\\) today.')).toBe(
      'The cube root is \\(\\sqrt[3]{x}\\) today.'
    )
  })

  it('keeps the index of a root inside $$…$$, on one line and across lines', () => {
    expect(preprocessMarkdown('$$\\sqrt[3]{x}$$')).toBe('$$\\sqrt[3]{x}$$')
    expect(preprocessMarkdown('Before[1]\n\n$$\n\\sqrt[3]{x}\n$$\n\nAfter[2]')).toBe(
      'Before\n\n$$\n\\sqrt[3]{x}\n$$\n\nAfter'
    )
  })

  it('keeps the index of a root inside \\[…\\]', () => {
    expect(preprocessMarkdown('Before[1]\n\n\\[\n\\sqrt[3]{x}\n\\]\n\nAfter[2]')).toBe(
      'Before\n\n\\[\n\\sqrt[3]{x}\n\\]\n\nAfter'
    )
  })

  it('never strips anything that is inside a math span, a plain `y[2]` included', () => {
    expect(preprocessMarkdown('Roots $\\sqrt[3]{x}$ are odd[1] and $y[2]$ stay.')).toBe(
      'Roots $\\sqrt[3]{x}$ are odd and $y[2]$ stay.'
    )
  })

  it('keeps a root index after a LaTeX command while the expression is still arriving', () => {
    // No closing `$` yet: there is no span to protect, so the command is what does.
    expect(preprocessMarkdown('half an expression $x = \\sqrt[3]')).toBe('half an expression $x = \\sqrt[3]')
    expect(preprocessMarkdown('half an expression $x = \\sqrt[3]{')).toBe('half an expression $x = \\sqrt[3]{')
  })

  it('treats a marker after any LaTeX command as an argument, not a citation', () => {
    expect(preprocessMarkdown('see \\binom[2]{n}{k}')).toBe('see \\binom[2]{n}{k}')
  })

  it('still strips a marker after prices, which are not mathematics', () => {
    expect(preprocessMarkdown('It costs $5 and $7 today[1].')).toBe('It costs $5 and $7 today.')
  })

  it('does not let an unterminated \\( swallow the rest of the reply into a span', () => {
    expect(preprocessMarkdown('half \\( x\n\nthen a claim[1].')).toBe('half \\( x\n\nthen a claim.')
  })

  it('leaves a code span and a fence alone', () => {
    expect(preprocessMarkdown('call `a[1]` and b[2]')).toBe('call `a[1]` and b')
    expect(preprocessMarkdown('```\na[1]\n```')).toBe('```\na[1]\n```')
  })
})
