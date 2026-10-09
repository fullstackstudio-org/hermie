/**
 * The numbers behind a `hermie-chart` drawing: the value axis, where each mark goes and the slices of a pie. Pure, in
 * pixels of the viewBox the drawing is made in (the width the box has, so a label is as big as the page's own text and
 * never scaled down with the picture). `../Chart.tsx` turns them into SVG elements; there is no library.
 */
import { formatNumber, type ChartSpec } from './chart-spec'

export const FONT = 11
/** What a character of a tick or category label is taken to measure. */
export const CHAR_WIDTH = 6.4
export const PLOT_HEIGHT = 200
export const MIN_WIDTH = 220
export const MAX_WIDTH = 960
/** The colours a chart cycles through (`markdown-chart.css`: `md-chart-s0`..`md-chart-s7`). */
export const PALETTE_SIZE = 8
export const MARKER_SHAPES = 4

export interface Scale {
  min: number
  max: number
  step: number
  ticks: number[]
}

/** A step of 1, 2, 2.5, 5 times a power of ten: the axis counts in units a reader can follow. */
function niceStep(raw: number): number {
  const exponent = Math.floor(Math.log10(raw))
  const base = 10 ** exponent
  const fraction = raw / base
  const nice = fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 5 ? 5 : 10

  return nice * base
}

/** Fix the float noise of repeated addition: a step has at most this many decimals. */
function decimalsOf(step: number): number {
  const text = step.toString()

  if (text.includes('e-')) {
    return Number(text.split('e-')[1])
  }

  return text.includes('.') ? (text.split('.')[1] ?? '').length : 0
}

/** An axis that covers `[low, high]` with about `target` ticks, ending on round numbers. */
export function niceScale(low: number, high: number, target = 5): Scale {
  let min = low
  let max = high

  if (min === max) {
    // A flat series: give the axis a range to draw it in.
    if (min === 0) {
      max = 1
    } else {
      const pad = Math.abs(min) * 0.1

      min -= pad
      max += pad
    }
  }

  const step = niceStep((max - min) / Math.max(target - 1, 1))
  const decimals = decimalsOf(step)
  const first = Math.floor(min / step + 1e-9) * step
  const last = Math.ceil(max / step - 1e-9) * step
  const ticks: number[] = []

  for (let value = first; value <= last + step / 1e6; value += step) {
    ticks.push(Number(value.toFixed(decimals)))
  }

  return { min: ticks[0] ?? min, max: ticks[ticks.length - 1] ?? max, step, ticks }
}

/** A tick label: whole numbers as they are, big ones compact, the rest to the step's decimals. */
export function formatTick(value: number, step: number): string {
  if (Math.abs(value) >= 10_000) {
    return new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(value)
  }

  const decimals = decimalsOf(step)

  return decimals === 0 ? formatNumber(value) : value.toFixed(Math.min(decimals, 3))
}

/** A label cut to what fits `chars` characters, with an ellipsis where it was cut. */
export function fit(label: string, chars: number): string {
  const units = Array.from(label)

  if (units.length <= chars) {
    return label
  }

  return chars <= 1 ? '…' : `${units.slice(0, chars - 1).join('')}…`
}

export interface CartesianLayout {
  width: number
  height: number
  plot: { left: number; top: number; right: number; bottom: number }
  scale: Scale
  /** Every n-th category is labelled. */
  stride: number
  /** The width of one category's band. */
  band: number
  /** Where the value `v` is drawn, from the top. */
  y: (value: number) => number
  /** The centre of category `i`. */
  x: (index: number) => number
  tickLabels: string[]
}

/** A bar or line chart in `width` pixels. */
export function layoutCartesian(spec: ChartSpec, width: number): CartesianLayout {
  const all = spec.series.flatMap(series => series.values)
  const low = Math.min(...all)
  const high = Math.max(...all)
  // A bar grows from zero, so zero is always on the axis; a line may float.
  const scale = spec.kind === 'bar' ? niceScale(Math.min(low, 0), Math.max(high, 0)) : niceScale(low, high)
  const tickLabels = scale.ticks.map(tick => formatTick(tick, scale.step))
  const labelWidth = Math.max(...tickLabels.map(label => label.length)) * CHAR_WIDTH
  const top = spec.unit === undefined ? 10 : 24
  const left = Math.ceil(labelWidth) + 12
  const right = 10
  const bottom = 28
  const plot = { left, top, right: width - right, bottom: top + PLOT_HEIGHT }
  const count = spec.x.length
  const band = (plot.right - plot.left) / count
  // At most about eight labels under the axis, however many points there are.
  const stride = Math.max(1, Math.ceil(count / 8))
  const span = scale.max - scale.min || 1

  return {
    width,
    height: plot.bottom + bottom,
    plot,
    scale,
    stride,
    band,
    y: value => plot.bottom - ((value - scale.min) / span) * PLOT_HEIGHT,
    x: index => plot.left + band * (index + 0.5),
    tickLabels
  }
}

export interface Slice {
  index: number
  label: string
  value: number
  share: number
  /** The path of the slice, a ring segment. */
  path: string
}

export interface PieLayout {
  size: number
  slices: Slice[]
  total: number
}

const TAU = Math.PI * 2

function point(cx: number, cy: number, r: number, angle: number): string {
  return `${(cx + r * Math.sin(angle)).toFixed(2)} ${(cy - r * Math.cos(angle)).toFixed(2)}`
}

/** The ring of a pie, in a square of `size` pixels, starting at twelve o'clock and going clockwise. */
export function layoutPie(spec: ChartSpec, size: number): PieLayout {
  const series = spec.series[0]
  const values = series?.values ?? []
  const total = values.reduce((sum, value) => sum + value, 0)
  const centre = size / 2
  const outer = size / 2 - 2
  const inner = outer * 0.55
  const slices: Slice[] = []
  let start = 0

  values.forEach((value, index) => {
    if (value <= 0 || total <= 0) {
      return
    }

    const share = value / total
    const end = start + share * TAU
    let path: string

    if (share > 0.9999) {
      // One slice is the whole ring: two half circles per edge, since an arc cannot start where it ends.
      path =
        `M${point(centre, centre, outer, 0)}A${outer} ${outer} 0 1 1 ${point(centre, centre, outer, Math.PI)}` +
        `A${outer} ${outer} 0 1 1 ${point(centre, centre, outer, TAU)}` +
        `M${point(centre, centre, inner, TAU)}A${inner} ${inner} 0 1 0 ${point(centre, centre, inner, Math.PI)}` +
        `A${inner} ${inner} 0 1 0 ${point(centre, centre, inner, 0)}Z`
    } else {
      const large = end - start > Math.PI ? 1 : 0

      path =
        `M${point(centre, centre, outer, start)}A${outer} ${outer} 0 ${large} 1 ${point(centre, centre, outer, end)}` +
        `L${point(centre, centre, inner, end)}A${inner} ${inner} 0 ${large} 0 ${point(centre, centre, inner, start)}Z`
    }

    slices.push({ index, label: spec.x[index] ?? '', value, share, path })
    start = end
  })

  return { size, slices, total }
}
