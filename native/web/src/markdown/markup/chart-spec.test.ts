/**
 * `hermie-chart`, held to `docs/charts.md` and to the native validator (`HermieChart.swift`): the same refusals, one
 * test per rule, the same limits, the same spoken sentence.
 */
import { describe, expect, it } from 'vitest'

import {
  CHART_LIMITS,
  chartSummary,
  decideChart,
  formatNumber,
  parseChart,
  type ChartRule,
  type ChartWords
} from './chart-spec'

const bar = (extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ type: 'bar', x: ['Q1', 'Q2'], series: [{ name: '2026', values: [12, 15] }], ...extra })

const refusal = (source: string): { rule: ChartRule; key?: string } | undefined => {
  const result = parseChart(source)

  return result.ok ? undefined : result.error
}

describe('a chart that validates', () => {
  it('is the spec, trimmed, with absent title and unit left out', () => {
    expect(parseChart(bar({ title: '  Sales  ', unit: ' EUR ' }))).toEqual({
      ok: true,
      spec: {
        kind: 'bar',
        title: 'Sales',
        unit: 'EUR',
        x: ['Q1', 'Q2'],
        series: [{ name: '2026', values: [12, 15] }]
      }
    })
    expect(parseChart(bar())).toMatchObject({ ok: true, spec: { kind: 'bar' } })
    expect((parseChart(bar()) as { spec: object }).spec).not.toHaveProperty('title')
  })

  it('takes a null or an empty title and unit as none', () => {
    const result = parseChart(bar({ title: null, unit: '   ' }))

    expect(result.ok && 'title' in result.spec).toBe(false)
    expect(result.ok && 'unit' in result.spec).toBe(false)
  })

  it('writes numeric categories out as text (a year)', () => {
    const result = parseChart(
      JSON.stringify({ type: 'line', x: [2025, 2026, 1.5], series: [{ name: 'a', values: [1, 2, 3] }] })
    )

    expect(result.ok && result.spec.x).toEqual(['2025', '2026', '1.5'])
  })

  it('draws a line chart and a pie', () => {
    expect(parseChart(JSON.stringify({ type: 'line', x: ['a'], series: [{ name: 's', values: [-3] }] })).ok).toBe(true)
    expect(parseChart(JSON.stringify({ type: 'pie', x: ['a', 'b'], series: [{ name: 's', values: [0, 4] }] })).ok).toBe(
      true
    )
  })

  it('accepts the limits exactly', () => {
    const points = Array.from({ length: CHART_LIMITS.maxPoints }, (_, index) => `p${index}`)
    const series = Array.from({ length: CHART_LIMITS.maxSeries }, (_, index) => ({
      name: `s${index}`,
      values: points.map(() => 1)
    }))

    expect(parseChart(JSON.stringify({ type: 'bar', x: points, series })).ok).toBe(true)
    expect(
      parseChart(
        JSON.stringify({
          type: 'pie',
          title: 't'.repeat(120),
          unit: 'u'.repeat(12),
          x: Array.from({ length: CHART_LIMITS.maxSlices }, (_, index) => `slice ${index}`),
          series: [{ name: 'n'.repeat(60), values: Array.from({ length: CHART_LIMITS.maxSlices }, () => 1) }]
        })
      ).ok
    ).toBe(true)
    expect(parseChart(bar({ x: ['x'.repeat(60), 'y'], series: [{ name: 's', values: [1e15, -1e15] }] })).ok).toBe(true)
  })
})

describe('a block that is not a chart is refused for the rule it breaks', () => {
  const cases: [string, string, ChartRule, string?][] = [
    ['text over 16 KiB', bar() + ' '.repeat(CHART_LIMITS.maxSourceBytes), 'tooLarge'],
    ['text that is not JSON', 'Q1: 12, Q2: 15', 'notJSON'],
    ['JSON cut off while streaming', '{"type": "bar", "x": ["Q1", "Q', 'notJSON'],
    ['an array', '[1, 2]', 'notAnObject'],
    ['a string', '"bar"', 'notAnObject'],
    ['an unknown key at the top', bar({ colour: 'red' }), 'unknownKey', 'colour'],
    [
      'an unknown key in a series',
      JSON.stringify({ type: 'bar', x: ['a'], series: [{ name: 's', values: [1], colour: 'red' }] }),
      'unknownKey',
      'colour'
    ],
    ['no type', JSON.stringify({ x: ['a'], series: [{ name: 's', values: [1] }] }), 'missing', 'type'],
    ['no x', JSON.stringify({ type: 'bar', series: [{ name: 's', values: [1] }] }), 'missing', 'x'],
    ['no series', JSON.stringify({ type: 'bar', x: ['a'] }), 'missing', 'series'],
    ['a series with no name', JSON.stringify({ type: 'bar', x: ['a'], series: [{ values: [1] }] }), 'missing', 'name'],
    [
      'a series with no values',
      JSON.stringify({ type: 'bar', x: ['a'], series: [{ name: 's' }] }),
      'missing',
      'values'
    ],
    ['a numeric type', bar({ type: 1 }), 'wrongType', 'type'],
    ['x that is not a list', bar({ x: 'Q1' }), 'wrongType', 'x'],
    ['a category that is a boolean', bar({ x: [true, 'Q2'] }), 'wrongType', 'x'],
    ['series that is not a list', bar({ series: {} }), 'wrongType', 'series'],
    ['a series that is not an object', bar({ series: [5] }), 'wrongType', 'series'],
    ['a series name that is a number', bar({ series: [{ name: 1, values: [1, 2] }] }), 'wrongType', 'name'],
    ['values that are not a list', bar({ series: [{ name: 's', values: 'x' }] }), 'wrongType', 'values'],
    ['a title that is a number', bar({ title: 3 }), 'wrongType', 'title'],
    ['an unknown type', bar({ type: 'radar' }), 'unknownType', 'radar'],
    ['a capitalised type', bar({ type: 'Bar' }), 'unknownType', 'Bar'],
    [
      'more than 8 series',
      bar({ series: Array.from({ length: 9 }, (_, index) => ({ name: `s${index}`, values: [1, 2] })) }),
      'tooManySeries'
    ],
    [
      'more than 100 points',
      JSON.stringify({
        type: 'bar',
        x: Array.from({ length: 101 }, (_, index) => `p${index}`),
        series: [{ name: 's', values: Array.from({ length: 101 }, () => 1) }]
      }),
      'tooManyPoints'
    ],
    [
      'more than 24 slices',
      JSON.stringify({
        type: 'pie',
        x: Array.from({ length: 25 }, (_, index) => `p${index}`),
        series: [{ name: 's', values: Array.from({ length: 25 }, () => 1) }]
      }),
      'tooManyPoints'
    ],
    ['no points', bar({ x: [], series: [{ name: 's', values: [] }] }), 'noPoints'],
    ['no series at all', bar({ series: [] }), 'noSeries'],
    ['a title over 120 characters', bar({ title: 't'.repeat(121) }), 'labelTooLong', 'title'],
    ['a unit over 12 characters', bar({ unit: 'u'.repeat(13) }), 'labelTooLong', 'unit'],
    ['a category over 60 characters', bar({ x: ['x'.repeat(61), 'b'] }), 'labelTooLong', 'x'],
    [
      'a series name over 60 characters',
      bar({ series: [{ name: 'n'.repeat(61), values: [1, 2] }] }),
      'labelTooLong',
      'name'
    ],
    ['an empty category', bar({ x: ['Q1', '  '] }), 'emptyLabel', 'x'],
    ['an empty series name', bar({ series: [{ name: ' ', values: [1, 2] }] }), 'emptyLabel', 'name'],
    ['a duplicate category', bar({ x: ['Q1', ' Q1 '] }), 'duplicateLabel', 'Q1'],
    ['a category that repeats as a number', bar({ x: [1, '1'] }), 'duplicateLabel', '1'],
    [
      'a duplicate series name',
      bar({
        series: [
          { name: 'a', values: [1, 2] },
          { name: 'a', values: [3, 4] }
        ]
      }),
      'duplicateLabel',
      'a'
    ],
    ['a series that is too short', bar({ series: [{ name: 's', values: [1] }] }), 'lengthMismatch', 's'],
    ['a series that is too long', bar({ series: [{ name: 's', values: [1, 2, 3] }] }), 'lengthMismatch', 's'],
    ['a value that is a string', bar({ series: [{ name: 's', values: [1, '2'] }] }), 'notNumeric', 's'],
    ['a value that is null (a gap)', bar({ series: [{ name: 's', values: [1, null] }] }), 'notNumeric', 's'],
    ['a value that is a boolean', bar({ series: [{ name: 's', values: [true, 2] }] }), 'notNumeric', 's'],
    ['a value past 1e15', bar({ series: [{ name: 's', values: [1, 1.0000001e15] }] }), 'notFinite', 's'],
    [
      'a value that overflows to infinity',
      '{"type":"bar","x":["a"],"series":[{"name":"s","values":[1e999]}]}',
      'notFinite',
      's'
    ],
    [
      'a pie with two series',
      JSON.stringify({
        type: 'pie',
        x: ['a', 'b'],
        series: [
          { name: 'a', values: [1, 2] },
          { name: 'b', values: [1, 2] }
        ]
      }),
      'pieNeedsOneSeries'
    ],
    [
      'a pie with a negative value',
      JSON.stringify({ type: 'pie', x: ['a', 'b'], series: [{ name: 's', values: [-1, 3] }] }),
      'pieNeedsPositiveValues'
    ],
    [
      'a pie with nothing above zero',
      JSON.stringify({ type: 'pie', x: ['a', 'b'], series: [{ name: 's', values: [0, 0] }] }),
      'pieNeedsPositiveValues'
    ]
  ]

  for (const [name, source, rule, key] of cases) {
    it(name, () => {
      expect(refusal(source)).toEqual(key === undefined ? { rule } : { rule, key })
    })
  }

  it('has a case for every rule of the format', () => {
    const covered = new Set(cases.map(([, , rule]) => rule))

    for (const rule of [
      'tooLarge',
      'notJSON',
      'notAnObject',
      'unknownKey',
      'missing',
      'wrongType',
      'unknownType',
      'tooManySeries',
      'tooManyPoints',
      'noPoints',
      'noSeries',
      'labelTooLong',
      'emptyLabel',
      'duplicateLabel',
      'lengthMismatch',
      'notNumeric',
      'notFinite',
      'pieNeedsOneSeries',
      'pieNeedsPositiveValues'
    ] as ChartRule[]) {
      expect(covered.has(rule), rule).toBe(true)
    }
  })

  it('counts a label in characters a reader sees: 60 family emoji pass, 61 do not', () => {
    const family = '\u{1F468}‍\u{1F469}‍\u{1F467}'

    expect(parseChart(bar({ x: [family.repeat(60), 'b'] })).ok).toBe(true)
    expect(refusal(bar({ x: [family.repeat(61), 'b'] }))).toEqual({ rule: 'labelTooLong', key: 'x' })
  })
})

describe('the decision the renderer makes', () => {
  it('is the chart for a chart fence that validates, in any case, and the code block otherwise', () => {
    expect(decideChart('hermie-chart', bar())?.kind).toBe('bar')
    expect(decideChart('HERMIE-CHART', bar())?.kind).toBe('bar')
    expect(decideChart('json', bar())).toBeUndefined()
    expect(decideChart(undefined, bar())).toBeUndefined()
    expect(decideChart('hermie-chart', '{"type": "bar"')).toBeUndefined()
  })
})

describe('a hostile block never throws', () => {
  for (const source of [
    '',
    '{',
    'null',
    '[]',
    '{"__proto__": 1}',
    '1e999',
    '{"type":"bar","x":[],"series":[]}',
    '['.repeat(20_000)
  ]) {
    it(JSON.stringify(source.slice(0, 20)), () => {
      expect(() => parseChart(source)).not.toThrow()
      expect(parseChart(source).ok).toBe(false)
    })
  }
})

describe('formatNumber', () => {
  it('writes whole numbers without a fraction and the rest with at most three digits', () => {
    expect(formatNumber(12)).toBe('12')
    expect(formatNumber(-0)).toBe('0')
    expect(formatNumber(1.5)).toBe('1.5')
    expect(formatNumber(1 / 3)).toBe('0.333')
    expect(formatNumber(2.0004)).toBe('2')
    expect(formatNumber(1e15)).toBe('1000000000000000')
  })
})

describe('the spoken sentence', () => {
  const words: ChartWords = {
    kind: kind => ({ bar: 'Bar chart', line: 'Line chart', pie: 'Pie chart' })[kind],
    titled: (kind, title) => `${kind}, ${title}.`,
    unit: unit => `In ${unit}.`,
    point: (label, value) => `${label} ${value}`,
    series: (name, points) => `${name}: ${points}.`,
    more: count => `and ${count} more`
  }

  it('is the kind, the title, the unit and each series, the same as the native apps say it', () => {
    const result = parseChart(bar({ title: 'Sales', unit: 'EUR' }))

    expect(result.ok && chartSummary(result.spec, words)).toBe('Bar chart, Sales. In EUR. 2026: Q1 12, Q2 15.')
  })

  it('reads the kind alone when there is no title and no unit', () => {
    const result = parseChart(bar())

    expect(result.ok && chartSummary(result.spec, words)).toBe('Bar chart 2026: Q1 12, Q2 15.')
  })

  it('reads the first twelve points of each series and says how many more', () => {
    const x = Array.from({ length: 15 }, (_, index) => `p${index + 1}`)
    const result = parseChart(
      JSON.stringify({ type: 'line', x, series: [{ name: 's', values: x.map((_, index) => index) }] })
    )

    expect(result.ok && chartSummary(result.spec, words)).toBe(
      `Line chart s: ${x
        .slice(0, 12)
        .map((label, index) => `${label} ${index}`)
        .join(', ')}, and 3 more.`
    )
  })
})
