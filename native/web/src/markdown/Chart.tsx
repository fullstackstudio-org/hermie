/**
 * A ```hermie-chart fence, drawn (`docs/charts.md`).
 *
 * A lazy chunk (`lazy.ts`), as the Mermaid drawings are, and for the same reason: nothing a first screen needs. No
 * charting library. `markup/chart-spec.ts` decides whether the block is a chart at all (strict, bounded, the twin of
 * the native validator) and `markup/chart-layout.ts` turns a chart into numbers; the elements made here are `svg`,
 * `rect`, `path`, `line`, `circle`, `text` and `title`, with every label as a React text child and every colour a
 * class, so a drawing has no markup, no link and no inline style for a reply to reach.
 *
 * The drawing is in the width the box has (a `ResizeObserver` on it), so its labels are the page's own size and a
 * narrow bubble gets fewer labels, not smaller ones. It is one image to assistive technology, named by the same
 * sentence the native apps speak (`chartSummary`): the kind, the title, the unit and each series with its first
 * twelve points. The code block's box gives it the "Show source" toggle and a Copy button for the JSON.
 */
import { memo, useEffect, useMemo, useRef, useState, type RefObject } from 'react'

import { sheetStrings } from '../i18n/sheet-strings'
import { useLocale } from '../i18n/use-locale'
import { CodeBlock } from './CodeBlock'
import {
  CHAR_WIDTH,
  MARKER_SHAPES,
  MAX_WIDTH,
  MIN_WIDTH,
  PALETTE_SIZE,
  fit,
  layoutCartesian,
  layoutPie,
  type CartesianLayout
} from './markup/chart-layout'
import {
  chartSummary,
  formatNumber,
  parseChart,
  type ChartKind,
  type ChartSpec,
  type ChartWords
} from './markup/chart-spec'

/** The width the drawing is made in before the box has been measured (and where there is no `ResizeObserver`). */
const DEFAULT_WIDTH = 520

/** The pie is a ring this wide at most. */
const PIE_SIZE = 220

/** The width of the element, kept up to date; clamped to what a drawing can use. */
function useBoxWidth(host: RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(DEFAULT_WIDTH)

  useEffect(() => {
    const element = host.current

    if (!element || typeof ResizeObserver === 'undefined') {
      return undefined
    }

    const measure = (value: number): void => {
      if (value > 0) {
        setWidth(Math.min(Math.max(Math.floor(value), MIN_WIDTH), MAX_WIDTH))
      }
    }

    measure(element.getBoundingClientRect().width)

    const observer = new ResizeObserver(entries => {
      const entry = entries[0]

      if (entry) {
        measure(entry.contentRect.width)
      }
    })

    observer.observe(element)

    return () => observer.disconnect()
  }, [host])

  return width
}

/** The words of the spoken summary in the reader's language. */
function words(): ChartWords {
  const chart = sheetStrings.markdown.chart

  return {
    kind: (kind: ChartKind) => kindName(kind),
    titled: (kind, title) => chart.titled({ kind, title }),
    unit: unit => chart.unit({ unit }),
    point: (label, value) => chart.point({ label, value }),
    series: (name, points) => chart.series({ name, points }),
    more: count => chart.more({ count })
  }
}

function kindName(kind: ChartKind): string {
  const chart = sheetStrings.markdown.chart

  return kind === 'bar' ? chart.bar : kind === 'line' ? chart.line : chart.pie
}

/** The class that colours series (or slice) `index`. */
const colourClass = (index: number): string => `md-chart-s${index % PALETTE_SIZE}`

/** A mark of a line chart: a different shape for each series, so colour is not the only thing that tells them apart. */
function Marker({ x, y, shape, className }: { x: number; y: number; shape: number; className: string }) {
  switch (shape % MARKER_SHAPES) {
    case 0:
      return <circle className={className} cx={x} cy={y} r={3.5} />
    case 1:
      return <rect className={className} height={7} width={7} x={x - 3.5} y={y - 3.5} />
    case 2:
      return <path className={className} d={`M${x} ${y - 4.5}L${x + 4.5} ${y}L${x} ${y + 4.5}L${x - 4.5} ${y}Z`} />
    default:
      return <path className={className} d={`M${x} ${y - 4.5}L${x + 4.5} ${y + 3.5}L${x - 4.5} ${y + 3.5}Z`} />
  }
}

/** What the tooltip of one mark says: `Q1, 2026: 12 EUR`. */
const markTitle = (spec: ChartSpec, label: string, series: string, value: number): string =>
  `${label}, ${series}: ${formatNumber(value)}${spec.unit === undefined ? '' : ` ${spec.unit}`}`

function Cartesian({ spec, layout, summary }: { spec: ChartSpec; layout: CartesianLayout; summary: string }) {
  const { plot, scale, band, stride, tickLabels } = layout
  const zero = layout.y(Math.min(Math.max(0, scale.min), scale.max))
  const barWidth = Math.max((band * 0.76) / spec.series.length, 1)
  const slot = band * stride
  const maxChars = Math.max(Math.floor(slot / CHAR_WIDTH) - 1, 1)

  return (
    <svg
      aria-label={summary}
      className={`md-chart-svg md-chart-${spec.kind}`}
      height={layout.height}
      role="img"
      viewBox={`0 0 ${layout.width} ${layout.height}`}
      width={layout.width}
    >
      {spec.unit === undefined ? null : (
        <text className="md-chart-unit" x={plot.left} y={12}>
          {spec.unit}
        </text>
      )}
      {scale.ticks.map((tick, index) => (
        <g key={tick}>
          <line className="md-chart-grid" x1={plot.left} x2={plot.right} y1={layout.y(tick)} y2={layout.y(tick)} />
          <text className="md-chart-tick" dy="0.32em" textAnchor="end" x={plot.left - 6} y={layout.y(tick)}>
            {tickLabels[index]}
          </text>
        </g>
      ))}
      <line className="md-chart-axis" x1={plot.left} x2={plot.right} y1={zero} y2={zero} />
      {spec.x.map((label, index) =>
        index % stride === 0 ? (
          <text className="md-chart-tick" key={label} textAnchor="middle" x={layout.x(index)} y={plot.bottom + 18}>
            {fit(label, maxChars)}
          </text>
        ) : null
      )}
      {spec.kind === 'bar'
        ? spec.series.map((series, seriesIndex) =>
            series.values.map((value, index) => {
              const top = layout.y(value)
              const x = layout.x(index) - (barWidth * spec.series.length) / 2 + barWidth * seriesIndex
              const label = spec.x[index] ?? ''

              return value === 0 ? null : (
                <rect
                  className={`md-chart-bar ${colourClass(seriesIndex)}`}
                  height={Math.max(Math.abs(zero - top), 1)}
                  key={`${seriesIndex}.${index}`}
                  rx={Math.min(2, barWidth / 3)}
                  width={barWidth}
                  x={x}
                  y={Math.min(top, zero)}
                >
                  <title>{markTitle(spec, label, series.name, value)}</title>
                </rect>
              )
            })
          )
        : spec.series.map((series, seriesIndex) => (
            <g className={colourClass(seriesIndex)} key={seriesIndex}>
              <path
                className="md-chart-line-path"
                d={series.values
                  .map((value, index) => `${index === 0 ? 'M' : 'L'}${layout.x(index)} ${layout.y(value)}`)
                  .join('')}
              />
              {series.values.map((value, index) => (
                <Marker
                  className="md-chart-mark"
                  key={index}
                  shape={seriesIndex}
                  x={layout.x(index)}
                  y={layout.y(value)}
                />
              ))}
            </g>
          ))}
    </svg>
  )
}

function Pie({ spec, size, summary }: { spec: ChartSpec; size: number; summary: string }) {
  const pie = useMemo(() => layoutPie(spec, size), [spec, size])

  return (
    <svg
      aria-label={summary}
      className="md-chart-svg md-chart-pie"
      height={size}
      role="img"
      viewBox={`0 0 ${size} ${size}`}
      width={size}
    >
      {pie.slices.map(slice => (
        <path
          className={`md-chart-slice ${colourClass(slice.index)}`}
          d={slice.path}
          data-cycle={Math.floor(slice.index / PALETTE_SIZE)}
          key={slice.index}
        >
          <title>{markTitle(spec, slice.label, spec.series[0]?.name ?? '', slice.value)}</title>
        </path>
      ))}
    </svg>
  )
}

/** The key to the colours: the series of a bar or line chart (when there are several), the slices of a pie. */
function Legend({ spec }: { spec: ChartSpec }) {
  if (spec.kind !== 'pie' && spec.series.length < 2) {
    return null
  }

  const series = spec.series[0]
  const total = series?.values.reduce((sum, value) => sum + value, 0) ?? 0

  return (
    // The summary names everything this lists, so it is not read twice.
    <ul aria-hidden="true" className="md-chart-legend">
      {spec.kind === 'pie'
        ? spec.x.map((label, index) => {
            const value = series?.values[index] ?? 0

            return (
              <li key={label}>
                <span
                  className={`md-chart-swatch ${colourClass(index)}`}
                  data-cycle={Math.floor(index / PALETTE_SIZE)}
                />
                <span className="md-chart-legend-label">{label}</span>
                <span className="md-chart-legend-value">
                  {formatNumber(value)}
                  {spec.unit === undefined ? '' : ` ${spec.unit}`}
                  {total > 0 ? ` (${formatNumber(Math.round((value / total) * 1000) / 10)}%)` : ''}
                </span>
              </li>
            )
          })
        : spec.series.map((entry, index) => (
            <li key={entry.name}>
              <span className={`md-chart-swatch ${colourClass(index)}`} />
              <span className="md-chart-legend-label">{entry.name}</span>
            </li>
          ))}
    </ul>
  )
}

function ChartFigure({ spec, summary }: { spec: ChartSpec; summary: string }) {
  const host = useRef<HTMLDivElement>(null)
  const width = useBoxWidth(host)
  const layout = useMemo(() => (spec.kind === 'pie' ? undefined : layoutCartesian(spec, width)), [spec, width])

  return (
    <div className="md-chart" ref={host}>
      {spec.title === undefined ? null : (
        <div aria-hidden="true" className="md-chart-title">
          {spec.title}
        </div>
      )}
      {layout ? (
        <Cartesian layout={layout} spec={spec} summary={summary} />
      ) : (
        <Pie size={Math.min(width, PIE_SIZE)} spec={spec} summary={summary} />
      )}
      <Legend spec={spec} />
    </div>
  )
}

function ChartDiagramView({ source, language }: { source: string; language?: string | undefined }) {
  useLocale()

  const result = useMemo(() => parseChart(source), [source])

  if (!result.ok) {
    // Not a chart: the block it came from.
    return <CodeBlock code={source} {...(language ? { language } : {})} />
  }

  const { spec } = result

  return (
    <CodeBlock
      code={source}
      drawing={<ChartFigure spec={spec} summary={chartSummary(spec, words())} />}
      kind="chart"
      label={kindName(spec.kind)}
    />
  )
}

/**
 * Memoised on the source: a streaming reply re-renders its last block on every delta, and a settled chart is not
 * validated and laid out again.
 */
export const ChartDiagram = memo(ChartDiagramView)
