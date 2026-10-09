/**
 * `hermie-chart`: numbers a bot returns, as a chart. The validator, the web twin of `HermieChart.swift`, which
 * `docs/charts.md` describes in prose; the three are to be read together.
 *
 * The rule is the one every `hermie-*` block follows: a block that is not exactly what the format says is NOT
 * drawn and the caller shows the code block it is. A picture that quietly leaves out or bends what the author sent
 * is worse than the source it was made from. So this is strict (an unknown key, a string where a number belongs, a
 * series of the wrong length, a number that is not finite: refusals) and bounded (a cap on the size of the block,
 * the number of series and points and the length of every label), so a reply cannot make the page draw ten
 * thousand marks.
 *
 * Pure and total: no DOM, never throws. The drawing is `../Chart.tsx`.
 */
import { characters, isRecord, utf8Bytes } from './text'

export type ChartKind = 'bar' | 'line' | 'pie'

export interface ChartSeries {
  name: string
  values: number[]
}

/** A chart that passed validation. Every field is within `CHART_LIMITS`. */
export interface ChartSpec {
  kind: ChartKind
  title?: string
  /** What the numbers are counted in (`EUR`, `%`, `ms`): shown on the value axis and read aloud. */
  unit?: string
  /** The categories, one per point; unique. For a pie, the slices. */
  x: string[]
  /** One series for a pie; one or more for a bar or line chart. */
  series: ChartSeries[]
}

export const CHART_LANGUAGE = 'hermie-chart'

export const CHART_LIMITS = {
  /** The block's text, in UTF-8 bytes. Checked before anything is parsed. */
  maxSourceBytes: 16 * 1024,
  maxSeries: 8,
  /** Categories, which is to say points per series. */
  maxPoints: 100,
  /** Slices of a pie. */
  maxSlices: 24,
  maxLabelLength: 60,
  maxTitleLength: 120,
  maxUnitLength: 12,
  /** A value beyond this is a mistake or an attack, and would not draw anyway. */
  maxMagnitude: 1e15
} as const

/** Why a block is not a chart. Each rule of the format is one case, so a test can name the rule it breaks. */
export type ChartRule =
  | 'tooLarge'
  | 'notJSON'
  | 'notAnObject'
  | 'unknownKey'
  | 'missing'
  | 'wrongType'
  | 'unknownType'
  | 'tooManySeries'
  | 'tooManyPoints'
  | 'noPoints'
  | 'noSeries'
  | 'labelTooLong'
  | 'emptyLabel'
  | 'duplicateLabel'
  | 'lengthMismatch'
  | 'notNumeric'
  | 'notFinite'
  | 'pieNeedsOneSeries'
  | 'pieNeedsPositiveValues'

export interface ChartError {
  rule: ChartRule
  /** The key, label or series the rule is about, where it has one. */
  key?: string
}

export type ChartResult = { ok: true; spec: ChartSpec } | { ok: false; error: ChartError }

class Refusal extends Error {
  constructor(readonly error: ChartError) {
    super(error.rule)
  }
}

const refuse = (rule: ChartRule, key?: string): never => {
  throw new Refusal(key === undefined ? { rule } : { rule, key })
}

const TOP_LEVEL_KEYS: ReadonlySet<string> = new Set(['type', 'title', 'x', 'series', 'unit'])
const SERIES_KEYS: ReadonlySet<string> = new Set(['name', 'values'])
const KINDS: ReadonlySet<string> = new Set(['bar', 'line', 'pie'])

/** Whether a fence's language names a chart block. Case does not matter: models capitalise. */
export function isChartFence(language: string | undefined): boolean {
  return language?.toLowerCase() === CHART_LANGUAGE
}

/** Validate a block's body. */
export function parseChart(source: string): ChartResult {
  try {
    return { ok: true, spec: validated(source) }
  } catch (error) {
    return { ok: false, error: error instanceof Refusal ? error.error : { rule: 'notJSON' } }
  }
}

/** The one decision the renderer makes: the chart, or `undefined` for the code block it came from. */
export function decideChart(language: string | undefined, source: string): ChartSpec | undefined {
  if (!isChartFence(language)) {
    return undefined
  }

  const result = parseChart(source)

  return result.ok ? result.spec : undefined
}

function validated(source: string): ChartSpec {
  // A string longer than the cap in UTF-16 units is longer in bytes; only the unclear middle is encoded.
  if (source.length > CHART_LIMITS.maxSourceBytes || utf8Bytes(source) > CHART_LIMITS.maxSourceBytes) {
    refuse('tooLarge')
  }

  let parsed: unknown

  try {
    parsed = JSON.parse(source)
  } catch {
    return refuse('notJSON')
  }

  if (!isRecord(parsed)) {
    return refuse('notAnObject')
  }

  const unknown = Object.keys(parsed)
    .filter(key => !TOP_LEVEL_KEYS.has(key))
    .sort()[0]

  if (unknown !== undefined) {
    refuse('unknownKey', unknown)
  }

  const kind = kindOf(parsed)
  const title = optionalLabel(parsed.title, 'title', CHART_LIMITS.maxTitleLength)
  const unit = optionalLabel(parsed.unit, 'unit', CHART_LIMITS.maxUnitLength)
  const x = categories(parsed.x, kind)
  const series = seriesList(parsed.series, kind, x.length)

  return { kind, ...(title === undefined ? {} : { title }), ...(unit === undefined ? {} : { unit }), x, series }
}

function kindOf(object: Record<string, unknown>): ChartKind {
  const raw = object.type

  if (raw === undefined) {
    return refuse('missing', 'type')
  }

  if (typeof raw !== 'string') {
    return refuse('wrongType', 'type')
  }

  if (!KINDS.has(raw)) {
    return refuse('unknownType', raw)
  }

  return raw as ChartKind
}

/** A string label, trimmed. Absent or JSON `null` is no label; an empty one is no label too. */
function optionalLabel(value: unknown, key: string, limit: number): string | undefined {
  if (value === undefined || value === null) {
    return undefined
  }

  if (typeof value !== 'string') {
    return refuse('wrongType', key)
  }

  const trimmed = value.trim()

  if (characters(trimmed) > limit) {
    refuse('labelTooLong', key)
  }

  return trimmed === '' ? undefined : trimmed
}

/** `x`: strings, or numbers (a year) that are written out as text. Every one non-empty, short, unique. */
function categories(value: unknown, kind: ChartKind): string[] {
  if (value === undefined) {
    return refuse('missing', 'x')
  }

  if (!Array.isArray(value)) {
    return refuse('wrongType', 'x')
  }

  if (value.length === 0) {
    refuse('noPoints')
  }

  if (value.length > (kind === 'pie' ? CHART_LIMITS.maxSlices : CHART_LIMITS.maxPoints)) {
    refuse('tooManyPoints')
  }

  const seen = new Set<string>()
  const labels: string[] = []

  for (const item of value as unknown[]) {
    let text: string

    if (typeof item === 'string') {
      text = item.trim()
    } else if (typeof item === 'number') {
      text = formatNumber(item)
    } else {
      return refuse('wrongType', 'x')
    }

    if (text === '') {
      refuse('emptyLabel', 'x')
    }

    if (characters(text) > CHART_LIMITS.maxLabelLength) {
      refuse('labelTooLong', 'x')
    }

    if (seen.has(text)) {
      refuse('duplicateLabel', text)
    }

    seen.add(text)
    labels.push(text)
  }

  return labels
}

function seriesList(value: unknown, kind: ChartKind, points: number): ChartSeries[] {
  if (value === undefined) {
    return refuse('missing', 'series')
  }

  if (!Array.isArray(value)) {
    return refuse('wrongType', 'series')
  }

  if (value.length === 0) {
    refuse('noSeries')
  }

  if (value.length > CHART_LIMITS.maxSeries) {
    refuse('tooManySeries')
  }

  if (kind === 'pie' && value.length !== 1) {
    refuse('pieNeedsOneSeries')
  }

  const names = new Set<string>()
  const out: ChartSeries[] = []

  for (const item of value as unknown[]) {
    if (!isRecord(item)) {
      return refuse('wrongType', 'series')
    }

    const unknown = Object.keys(item)
      .filter(key => !SERIES_KEYS.has(key))
      .sort()[0]

    if (unknown !== undefined) {
      refuse('unknownKey', unknown)
    }

    if (item.name === undefined) {
      refuse('missing', 'name')
    }

    if (typeof item.name !== 'string') {
      return refuse('wrongType', 'name')
    }

    const name = item.name.trim()

    if (name === '') {
      refuse('emptyLabel', 'name')
    }

    if (characters(name) > CHART_LIMITS.maxLabelLength) {
      refuse('labelTooLong', 'name')
    }

    if (names.has(name)) {
      refuse('duplicateLabel', name)
    }

    names.add(name)

    if (item.values === undefined) {
      refuse('missing', 'values')
    }

    if (!Array.isArray(item.values)) {
      return refuse('wrongType', 'values')
    }

    // Counted before any element is read: a long list of the wrong length is refused whole.
    if (item.values.length !== points) {
      refuse('lengthMismatch', name)
    }

    const values: number[] = []

    for (const element of item.values as unknown[]) {
      if (typeof element !== 'number') {
        return refuse('notNumeric', name)
      }

      if (!Number.isFinite(element) || Math.abs(element) > CHART_LIMITS.maxMagnitude) {
        refuse('notFinite', name)
      }

      values.push(element)
    }

    if (kind === 'pie' && (values.some(v => v < 0) || !values.some(v => v > 0))) {
      refuse('pieNeedsPositiveValues')
    }

    out.push({ name, values })
  }

  return out
}

/** A number as a short, locale-neutral label: whole numbers without a fraction, the rest with at most three digits. */
export function formatNumber(value: number): string {
  if (Number.isInteger(value) && Math.abs(value) < 1e15) {
    // `-0` is "0".
    return String(value === 0 ? 0 : value)
  }

  let text = value.toFixed(3)

  while (text.endsWith('0')) {
    text = text.slice(0, -1)
  }

  if (text.endsWith('.')) {
    text = text.slice(0, -1)
  }

  return text
}

/** How many points of each series are read. */
export const MAX_POINTS_READ = 12

/** The words of the spoken summary, in the reader's language: the sentence is ordered by the language. */
export interface ChartWords {
  kind: (kind: ChartKind) => string
  /** "{kind}, {title}." */
  titled: (kind: string, title: string) => string
  /** "In {unit}." */
  unit: (unit: string) => string
  /** "{label} {value}" */
  point: (label: string, value: string) => string
  /** "{series}: {points}." */
  series: (name: string, points: string) => string
  /** "and {n} more" */
  more: (count: number) => string
}

/**
 * What a chart is read as: its kind, its title, the unit, and each series with its first twelve points. The same
 * sentence as the native apps' (`HermieChartSpeech.summary`), numbers capped so a chart of 800 marks is not read out
 * mark by mark.
 */
export function chartSummary(spec: ChartSpec, words: ChartWords): string {
  const parts: string[] = []
  const kind = words.kind(spec.kind)

  parts.push(spec.title === undefined ? kind : words.titled(kind, spec.title))

  if (spec.unit !== undefined) {
    parts.push(words.unit(spec.unit))
  }

  for (const series of spec.series) {
    const points = spec.x
      .slice(0, MAX_POINTS_READ)
      .map((label, index) => words.point(label, formatNumber(series.values[index] ?? 0)))

    if (series.values.length > MAX_POINTS_READ) {
      points.push(words.more(series.values.length - MAX_POINTS_READ))
    }

    parts.push(words.series(series.name, points.join(', ')))
  }

  return parts.join(' ')
}
