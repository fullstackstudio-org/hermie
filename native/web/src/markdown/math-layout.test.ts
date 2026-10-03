// @vitest-environment node
/**
 * The mathematics layout, read back as structure: which primitives a construct
 * makes, where they sit relative to each other, and that the heights agree with
 * the package's `mathHeight` wherever the construct is symmetric (the arithmetic
 * the Expo app sets its boxes with).
 */
import { mathHeight, mathLineHeight, parseMath, type MathNode } from '@hermie/markdown'
import { OPERATOR_SCALE, RULE, SCRIPT_SCALE } from '@hermie/markdown/math/metrics'
import { describe, expect, it } from 'vitest'

import { AXIS, estimateText, layoutMath, layoutNode, type MathLayout, type MathText } from './math-layout'

const SIZE = 16

function parsed(source: string): MathNode {
  const node = parseMath(source)

  if (!node) {
    throw new Error(`does not parse: ${source}`)
  }

  return node
}

const layout = (source: string): MathLayout => layoutNode(parsed(source), SIZE, estimateText)

const textOf = (text: MathText): string => text.runs.map(run => run.text).join('')

function textNamed(box: MathLayout, wanted: string): MathText {
  const text = box.texts.find(entry => textOf(entry) === wanted)

  if (!text) {
    throw new Error(`no text "${wanted}" in ${JSON.stringify(box.texts.map(textOf))}`)
  }

  return text
}

/** Where a line of text puts the maths axis: a quarter of its size above the baseline. */
const axisOf = (text: MathText): number => text.y - AXIS * text.size

describe('one line', () => {
  it('sets an expression with no box in it as one run of text, scripts in Unicode, as the Expo app does', () => {
    const box = layout('x^2 + y_i = 1')

    expect(box.texts).toHaveLength(1)
    expect(textOf(box.texts[0] as MathText)).toBe('x² + yᵢ = 1')
    expect(box.rules).toEqual([])
    expect(box.strokes).toEqual([])
    expect(box.height).toBe(mathLineHeight(SIZE))
  })

  it('sets a fence round one line as the face’s own glyphs', () => {
    const box = layout(String.raw`\left(a + b\right)`)

    expect(box.strokes).toEqual([])
    expect(box.texts.map(textOf).join('')).toBe('(a + b)')
  })

  it('sets a big operator without limits on the line', () => {
    const box = layout(String.raw`\sum x`)

    expect(box.texts).toHaveLength(1)
    expect(box.texts[0]?.size).toBe(SIZE)
  })
})

describe('a fraction', () => {
  it('is a numerator, a rule as wide as the wider side and a denominator, in that order', () => {
    const box = layout(String.raw`\frac{a+b}{c}`)
    const numerator = textNamed(box, 'a+b')
    const denominator = textNamed(box, 'c')

    expect(box.rules).toHaveLength(1)

    const rule = box.rules[0] as (typeof box.rules)[0]

    expect(rule.height).toBe(RULE)
    expect(numerator.y).toBeLessThan(rule.y)
    expect(denominator.y).toBeGreaterThan(rule.y)
    expect(rule.width).toBeCloseTo(estimateText('a+b', 'italic', SIZE))
    // The shorter side is centred over the rule.
    expect(denominator.x + estimateText('c', 'italic', SIZE) / 2).toBeCloseTo(rule.x + rule.width / 2)
  })

  it('puts its rule on the axis of the text beside it', () => {
    const box = layout(String.raw`x = \frac{1}{2}`)
    const rule = box.rules[0] as (typeof box.rules)[0]

    expect(axisOf(textNamed(box, 'x = '))).toBeCloseTo(rule.y + rule.height / 2)
  })

  it('keeps that true when the numerator is taller than the denominator', () => {
    const box = layout(String.raw`\frac{\frac{a}{b}}{c} = d`)
    const outer = [...box.rules].sort((a, b) => b.width - a.width || b.y - a.y)
    const bars = box.rules.map(rule => rule.y)
    // The outer bar is the lower of the two.
    const main = box.rules.find(rule => rule.y === Math.max(...bars)) as (typeof box.rules)[0]

    expect(outer).toHaveLength(2)
    expect(axisOf(textNamed(box, ' = d'))).toBeCloseTo(main.y + main.height / 2)
  })

  it('is as tall as mathHeight says', () => {
    expect(layout(String.raw`\frac{a}{b}`).height).toBe(mathHeight(parsed(String.raw`\frac{a}{b}`), SIZE))
  })
})

describe('a root', () => {
  it('is one stroked sign with its overline, over the radicand', () => {
    const box = layout(String.raw`\sqrt{x+1}`)
    const radicand = textNamed(box, 'x+1')

    expect(box.strokes).toHaveLength(1)
    expect(box.strokes[0]?.d).toMatch(/^M[\d.]+,[\d.]+( L[\d.]+,[\d.]+){4}$/)
    expect(box.height).toBe(mathHeight(parsed(String.raw`\sqrt{x+1}`), SIZE))
    expect(radicand.x).toBeGreaterThan(0)
  })

  it('sets an index smaller, to the left of the radicand', () => {
    const box = layout(String.raw`\sqrt[n]{x}`)
    const index = textNamed(box, 'n')

    expect(index.size).toBe(Math.round(SIZE * SCRIPT_SCALE))
    expect(index.x).toBeLessThan(textNamed(box, 'x').x)
  })
})

describe('a big operator with limits', () => {
  it('stacks the upper limit, the enlarged glyph and the lower limit, centred', () => {
    const box = layout(String.raw`\sum_{i=1}^{n}`)
    const upper = textNamed(box, 'n')
    const glyph = textNamed(box, '∑')
    const lower = textNamed(box, 'i=1')

    expect(glyph.size).toBe(Math.round(SIZE * OPERATOR_SCALE))
    expect(upper.size).toBe(Math.round(SIZE * SCRIPT_SCALE))
    expect(lower.size).toBe(Math.round(SIZE * SCRIPT_SCALE))
    expect(upper.y).toBeLessThan(glyph.y)
    expect(glyph.y).toBeLessThan(lower.y)
    expect(box.height).toBe(mathHeight(parsed(String.raw`\sum_{i=1}^{n}`), SIZE))
    // The axis is the middle of the glyph's own line.
    expect(box.axis).toBeCloseTo(axisOf(glyph))
  })
})

describe('a grid', () => {
  it('draws a matrix with fences the height of its rows, and centres each column', () => {
    const box = layout(String.raw`\begin{pmatrix} 1 & 22 \\ 333 & 4 \end{pmatrix}`)

    expect(box.strokes).toHaveLength(2)
    expect(box.height).toBe(mathHeight(parsed(String.raw`\begin{pmatrix} 1 & 22 \\ 333 & 4 \end{pmatrix}`), SIZE))

    const centre = (text: MathText): number => text.x + estimateText(textOf(text), 'roman', SIZE) / 2

    expect(centre(textNamed(box, '1'))).toBeCloseTo(centre(textNamed(box, '333')))
    expect(centre(textNamed(box, '22'))).toBeCloseTo(centre(textNamed(box, '4')))
    // Rows: the second sits a line and a row gap below the first.
    expect(textNamed(box, '333').y).toBeGreaterThan(textNamed(box, '1').y)
    expect(textNamed(box, '333').y).toBe(textNamed(box, '4').y)
  })

  it('sets cases flush left, with an opening brace and no closing fence', () => {
    const box = layout(String.raw`\begin{cases} 0 & x < 0 \\ 100 & x \ge 0 \end{cases}`)

    expect(box.strokes).toHaveLength(1)
    expect(textNamed(box, '0').x).toBeCloseTo(textNamed(box, '100').x)
    expect(textNamed(box, 'x < 0').x).toBeCloseTo(textNamed(box, 'x ≥ 0').x)
  })

  it('aligns a derivation on its relation signs: right, then left', () => {
    const box = layout(String.raw`\begin{aligned} a &= b \\ ccc &= d \end{aligned}`)
    const end = (text: MathText): number => text.x + estimateText(textOf(text), 'italic', SIZE)

    expect(end(textNamed(box, 'a'))).toBeCloseTo(end(textNamed(box, 'ccc')))
    expect(textNamed(box, '= b').x).toBeCloseTo(textNamed(box, '= d').x)
    expect(box.strokes).toEqual([])
  })
})

describe('fences and scripts round a box', () => {
  it('draws the fences of a tall body, and hangs a script at the top of the fence', () => {
    const box = layout(String.raw`\left( \frac{1}{n} \right)^n`)
    const power = box.texts.find(text => textOf(text) === 'n' && text.size < SIZE) as MathText

    expect(box.strokes).toHaveLength(2)
    expect(box.strokes.every(stroke => stroke.d.startsWith('M'))).toBe(true)
    expect(power.size).toBe(Math.round(SIZE * SCRIPT_SCALE))
    // At the top: above the fraction's rule.
    expect(power.y).toBeLessThan((box.rules[0] as (typeof box.rules)[0]).y)
  })

  it('draws every fence the notation grows: brackets, braces, bars, angles, floors and ceilings', () => {
    for (const [open, close] of [
      ['[', ']'],
      [String.raw`\{`, String.raw`\}`],
      ['|', '|'],
      [String.raw`\|`, String.raw`\|`],
      [String.raw`\langle`, String.raw`\rangle`],
      [String.raw`\lfloor`, String.raw`\rfloor`],
      [String.raw`\lceil`, String.raw`\rceil`]
    ]) {
      const box = layout(String.raw`\left${open} \frac{a}{b} \right${close}`)

      expect(box.strokes, `${open} ${close}`).toHaveLength(2)
    }
  })
})

describe('the whole expression', () => {
  it('has a margin round it, and the same source always gives the same drawing', () => {
    const node = parsed(String.raw`x = \frac{-b \pm \sqrt{b^2 - 4ac}}{2a}`)
    const inner = layoutNode(node, SIZE, estimateText)
    const whole = layoutMath(node, SIZE, estimateText)

    expect(whole.width).toBeCloseTo(inner.width + 4)
    expect(whole.height).toBeCloseTo(inner.height + 4)
    expect(whole.texts.length).toBe(inner.texts.length)
    expect(layoutMath(node, SIZE, estimateText)).toEqual(whole)

    for (const text of whole.texts) {
      expect(text.x).toBeGreaterThanOrEqual(2)
      expect(text.y).toBeLessThanOrEqual(whole.height)
    }
  })
})
