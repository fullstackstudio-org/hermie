/**
 * The small formatting the item views share. All of it goes through `Intl`
 * (`i18n/format.ts`), so a clock reads as the reader's language writes it.
 */
import { formatNumber, formatTime } from '../../i18n/format'

/** The time of day a message was stamped, or an empty string when it carries no stamp. */
export function clockOf(unixSeconds: number | undefined): string {
  if (!unixSeconds || unixSeconds <= 0) {
    return ''
  }

  return formatTime(unixSeconds * 1000)
}

/** The `dateTime` attribute of a stamp: an ISO string, or `undefined` when there is none. */
export function isoOf(unixSeconds: number | undefined): string | undefined {
  if (!unixSeconds || unixSeconds <= 0) {
    return undefined
  }

  const date = new Date(unixSeconds * 1000)

  return Number.isNaN(date.getTime()) ? undefined : date.toISOString()
}

/** `1.2s`, `12s`, `1m 12s`, `1h 5m`: how long a reply or a tool call took. */
export function formatDuration(seconds: number | undefined): string {
  if (seconds === undefined || !Number.isFinite(seconds) || seconds < 0) {
    return ''
  }

  if (seconds < 10) {
    return `${Math.round(seconds * 10) / 10}s`
  }

  if (seconds < 60) {
    return `${Math.round(seconds)}s`
  }

  const minutes = Math.floor(seconds / 60)
  const rest = Math.round(seconds % 60)

  if (minutes < 60) {
    return rest ? `${minutes}m ${rest}s` : `${minutes}m`
  }

  const hours = Math.floor(minutes / 60)

  return minutes % 60 ? `${hours}h ${minutes % 60}m` : `${hours}h`
}

/** One line of `value`: whitespace collapsed, cut at `max` characters with an ellipsis. */
export function clipLine(value: string, max: number): string {
  const collapsed = value.replace(/\s+/gu, ' ').trim()
  const characters = Array.from(collapsed)

  return characters.length > max ? `${characters.slice(0, max - 1).join('')}…` : collapsed
}

/**
 * A file size in the reader's digits: `812 B`, `14 kB`, `2.4 MB`, in steps of
 * 1024. The gateway's caps are said through `megabytesOf` instead.
 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return formatNumber(bytes, { style: 'unit', unit: 'byte', unitDisplay: 'narrow' })
  }

  if (bytes < 1024 * 1024) {
    return formatNumber(bytes / 1024, { style: 'unit', unit: 'kilobyte', maximumFractionDigits: 0 })
  }

  return formatNumber(bytes / (1024 * 1024), { style: 'unit', unit: 'megabyte', maximumFractionDigits: 1 })
}

/** A cap in whole binary megabytes, as the gateway states it (`25`, `100`). */
export const megabytesOf = (bytes: number): number => Math.round(bytes / (1024 * 1024))
