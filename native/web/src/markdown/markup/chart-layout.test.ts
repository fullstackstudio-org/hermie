/** The numbers behind a chart: a round axis, marks inside the plot, a ring that adds up. */
import { describe, expect, it } from 'vitest'

import { fit, formatTick, layoutCartesian, layoutPie, niceScale, PLOT_HEIGHT } from './chart-layout'
import { parseChart, type ChartSpec } from './chart-spec'

function specOf(source: object): ChartSpec {
  const result = parseChart(JSON.stringify(source))

  if (!result.ok) {
    throw new Error(result.error.rule)
  }

  return result.spec
}

describe('niceScale', () => {
  it('ends on round numbers that cover the data', () => {
    const scale = niceScale(0, 24)

    expect(scale.min).toBe(0)
    expect(scale.max).toBeGreaterThanOrEqual(24)
    expect(scale.ticks[0]).toBe(0)
    expect(scale.ticks.every((tick, index) => index === 0 || tick > (scale.ticks[index - 1] as number))).toBe(true)
    expect(scale.ticks.length).toBeGreaterThanOrEqual(3)
    expect(scale.ticks.length).toBeLessThanOrEqual(8)
  })

  it('covers negatives', () => {
    const scale = niceScale(-3, 7)

    expect(scale.min).toBeLessThanOrEqual(-3)
    expect(scale.max).toBeGreaterThanOrEqual(7)
    expect(scale.ticks).toContain(0)
  })

  it('gives a flat series a range, and an all-zero chart one too', () => {
    const flat = niceScale(5, 5)

    expect(flat.max).toBeGreaterThan(flat.min)
    expect(flat.min).toBeLessThanOrEqual(5)
    expect(flat.max).toBeGreaterThanOrEqual(5)
    expect(niceScale(0, 0).max).toBeGreaterThan(0)
  })

  it('has no float noise in its ticks', () => {
    const scale = niceScale(0, 0.7)

    for (const tick of scale.ticks) {
      expect(String(tick).length).toBeLessThan(8)
    }
  })

  it('copes with the largest values the format allows', () => {
    const scale = niceScale(-1e15, 1e15)

    expect(Number.isFinite(scale.min) && Number.isFinite(scale.max)).toBe(true)
    expect(scale.ticks.length).toBeLessThan(20)
  })
})

describe('formatTick', () => {
  it('writes whole steps as whole numbers, fractions to the step and big numbers compact', () => {
    expect(formatTick(20, 10)).toBe('20')
    expect(formatTick(0.5, 0.25)).toBe('0.50')
    expect(formatTick(25_000, 5000)).toBe('25K')
  })
})

describe('fit', () => {
  it('cuts a label that does not fit and leaves one that does', () => {
    expect(fit('Quarter', 10)).toBe('Quarter')
    expect(fit('Quarter one', 6)).toBe('Quart…')
    expect(fit('Quarter', 1)).toBe('…')
  })
})

describe('layoutCartesian', () => {
  const spec = specOf({
    type: 'bar',
    unit: 'EUR',
    x: ['Q1', 'Q2', 'Q3'],
    series: [{ name: '2026', values: [12, -4, 20] }]
  })

  it('puts every value inside the plot, and zero on the axis', () => {
    const layout = layoutCartesian(spec, 400)

    for (const value of [12, -4, 20]) {
      expect(layout.y(value)).toBeGreaterThanOrEqual(layout.plot.top - 0.001)
      expect(layout.y(value)).toBeLessThanOrEqual(layout.plot.bottom + 0.001)
    }

    expect(layout.y(layout.scale.min)).toBeCloseTo(layout.plot.bottom)
    expect(layout.y(layout.scale.max)).toBeCloseTo(layout.plot.top)
    expect(layout.plot.bottom - layout.plot.top).toBe(PLOT_HEIGHT)
    expect(layout.scale.ticks).toContain(0)
  })

  it('puts the categories in order, one band each, inside the width', () => {
    const layout = layoutCartesian(spec, 400)

    expect(layout.x(0)).toBeLessThan(layout.x(1))
    expect(layout.x(1)).toBeLessThan(layout.x(2))
    expect(layout.x(2) + layout.band / 2).toBeCloseTo(layout.plot.right)
    expect(layout.plot.right).toBeLessThanOrEqual(400)
  })

  it('labels about eight categories however many there are', () => {
    const many = specOf({
      type: 'line',
      x: Array.from({ length: 100 }, (_, index) => `p${index}`),
      series: [{ name: 's', values: Array.from({ length: 100 }, (_, index) => index) }]
    })

    expect(layoutCartesian(many, 600).stride).toBe(13)
    expect(layoutCartesian(spec, 600).stride).toBe(1)
  })

  it('floats a line chart whose values are all far from zero, and roots a bar chart at zero', () => {
    const values = [1000, 1010, 1020]
    const line = layoutCartesian(specOf({ type: 'line', x: ['a', 'b', 'c'], series: [{ name: 's', values }] }), 400)
    const barChart = layoutCartesian(specOf({ type: 'bar', x: ['a', 'b', 'c'], series: [{ name: 's', values }] }), 400)

    expect(line.scale.min).toBeGreaterThan(0)
    expect(barChart.scale.min).toBe(0)
  })
})

describe('layoutPie', () => {
  const spec = specOf({ type: 'pie', x: ['a', 'b', 'c', 'd'], series: [{ name: 's', values: [1, 2, 0, 1] }] })

  it('has a slice for every value above zero, and their shares add up to one', () => {
    const pie = layoutPie(spec, 200)

    expect(pie.slices.map(slice => slice.label)).toEqual(['a', 'b', 'd'])
    expect(pie.slices.map(slice => slice.index)).toEqual([0, 1, 3])
    expect(pie.slices.reduce((sum, slice) => sum + slice.share, 0)).toBeCloseTo(1)
    expect(pie.total).toBe(4)
  })

  it('draws every slice as a closed ring segment with numbers in it and nothing else', () => {
    for (const slice of layoutPie(spec, 200).slices) {
      expect(slice.path).toMatch(/^[MLAZ0-9., -]+$/u)
      expect(slice.path).not.toContain('NaN')
      expect(slice.path.endsWith('Z')).toBe(true)
    }
  })

  it('draws a single slice as a whole ring', () => {
    const whole = layoutPie(specOf({ type: 'pie', x: ['only'], series: [{ name: 's', values: [5] }] }), 200)

    expect(whole.slices).toHaveLength(1)
    expect(whole.slices[0]?.path).not.toContain('NaN')
    expect(whole.slices[0]?.share).toBe(1)
  })
})
