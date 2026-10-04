/**
 * What a drawn signature becomes (`SignatureSheet.tsx`): one path per stroke, the same path in the SVG file and on the
 * canvas the PNG is drawn on, so the two files show one signature.
 *
 * **The SVG is built to the gateway's allowlist exactly** (`contract/requests/README.md` section 8), by writing only
 * what it accepts, never by filtering: UTF-8 without a declaration, no entity and no `&`, no text at all (not even an
 * empty `title`), only `svg`, `rect`, `g` and `path`, no prefix, ASCII whitespace only, every keyword lowercase, every
 * number at most 32 characters and written without an exponent, `d` made of command letters and numbers, and no
 * attribute but the ones the grammar lists (`xmlns`, `width`, `height`, `viewBox`, `fill`, `stroke`, `stroke-width`,
 * `stroke-linecap`, `stroke-linejoin`, `d`). A pointer's coordinates are clamped to the pad and rounded to a tenth, so a
 * number is never longer than a few characters whatever the device reports (NaN and infinity are left out).
 *
 * Pressure is ignored: a stroke is a line of one width. A single touch is a dot (a zero-length segment with a round cap).
 */
import { bytesOf, sha256Hex } from '../../core/requests/sha256'

/** The pad's own coordinate system, in CSS pixels; the canvas is drawn at `scale` times it. */
export const PAD = Object.freeze({ width: 600, height: 200, ink: 2.5, scale: 2 })

/** The most points one signature keeps; the rest of a longer scribble is not drawn. */
export const MAX_POINTS = 20_000
/** A point closer than this to the one before it is not kept. */
const MIN_STEP = 0.5
/** The least ink (total length of the strokes, in pad pixels) a signature has: a stray touch is not one. */
export const MIN_INK = 12

export interface Point {
  x: number
  y: number
}

export type Stroke = readonly Point[]

/** A coordinate as the SVG writes it: clamped to `[0, max]`, rounded to a tenth, no exponent, never `-0`. */
const num = (value: number, max: number): string => {
  const rounded = Math.round(Math.min(Math.max(value, 0), max) * 10) / 10

  return String(rounded === 0 ? 0 : rounded)
}

const x = (value: number): string => num(value, PAD.width)
const y = (value: number): string => num(value, PAD.height)

/** Only the finite points: a device that reports NaN does not put one in the file. */
const finite = (stroke: Stroke): Point[] => stroke.filter(point => Number.isFinite(point.x) && Number.isFinite(point.y))

/** Total length of the strokes, in pad pixels. */
export function inkOf(strokes: readonly Stroke[]): number {
  let total = 0

  for (const stroke of strokes) {
    const points = finite(stroke)

    for (let index = 1; index < points.length; index += 1) {
      total += Math.hypot(
        (points[index]?.x ?? 0) - (points[index - 1]?.x ?? 0),
        (points[index]?.y ?? 0) - (points[index - 1]?.y ?? 0)
      )
    }
  }

  return total
}

/**
 * The `d` of one stroke, or `''` for one with no usable point: a line through the midpoints of its points (each point
 * the control of a quadratic curve), which is smooth where a polyline of a pointer's samples is not.
 */
export function strokePath(stroke: Stroke): string {
  const points = finite(stroke)
  const first = points[0]

  if (!first) {
    return ''
  }

  const pair = (point: Point): string => `${x(point.x)} ${y(point.y)}`
  const mid = (a: Point, b: Point): string => `${x((a.x + b.x) / 2)} ${y((a.y + b.y) / 2)}`
  const last = points[points.length - 1] as Point

  if (points.length === 1) {
    // A dot: a segment of no length, which a round cap draws as a disc.
    return `M${pair(first)}L${pair(first)}`
  }

  let path = `M${pair(first)}`

  for (let index = 1; index < points.length - 1; index += 1) {
    const point = points[index] as Point

    path += `Q${pair(point)} ${mid(point, points[index + 1] as Point)}`
  }

  return `${path}L${pair(last)}`
}

/** Add `point` to `stroke` unless it is no step from the last one (a pad reports the same place many times). */
export function extend(stroke: Stroke, point: Point): Stroke {
  const last = stroke[stroke.length - 1]

  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) {
    return stroke
  }

  return last && Math.hypot(point.x - last.x, point.y - last.y) < MIN_STEP ? stroke : [...stroke, point]
}

/** The signature as an SVG file's text. */
export function signatureSvg(strokes: readonly Stroke[]): string {
  const paths = strokes
    .map(strokePath)
    .filter(path => path !== '')
    .map(path => `<path d="${path}"/>`)
    .join('')
  const size = `width="${PAD.width}" height="${PAD.height}"`

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" ${size} viewBox="0 0 ${PAD.width} ${PAD.height}">` +
    `<rect ${size} fill="#ffffff"/>` +
    `<g fill="none" stroke="#000000" stroke-width="${PAD.ink}" stroke-linecap="round" stroke-linejoin="round">` +
    `${paths}</g></svg>`
  )
}

/** The pad's drawing of the signature on `context` (a canvas of `PAD.scale` times the pad's size), on white. */
export function drawSignature(context: CanvasRenderingContext2D, strokes: readonly Stroke[]): void {
  context.save()
  context.setTransform(PAD.scale, 0, 0, PAD.scale, 0, 0)
  context.fillStyle = '#ffffff'
  context.fillRect(0, 0, PAD.width, PAD.height)
  context.strokeStyle = '#000000'
  context.lineWidth = PAD.ink
  context.lineCap = 'round'
  context.lineJoin = 'round'

  for (const stroke of strokes) {
    const path = strokePath(stroke)

    if (path !== '') {
      context.stroke(new Path2D(path))
    }
  }

  context.restore()
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

/**
 * The chunks of a PNG that are the picture, and the few that say how to show it: everything else (`tEXt`, `iTXt`,
 * `zTXt`, `eXIf`, `tIME`, `iCCP`, a browser's own additions) is left out, so a file made by any encoder says nothing
 * about the device or the person.
 */
const KEPT_CHUNKS = new Set(['IHDR', 'PLTE', 'tRNS', 'IDAT', 'IEND', 'sRGB', 'gAMA', 'cHRM', 'pHYs'])

/**
 * `png` with only its `KEPT_CHUNKS`, each copied whole (its checksum stays right), and nothing after `IEND`. A file
 * that is not a whole PNG (no signature, a chunk that runs past the end, no `IHDR` first, no picture, no `IEND`) throws:
 * nothing is sent that could not be cleaned.
 */
export function stripPngMetadata(png: Uint8Array): Uint8Array<ArrayBuffer> {
  if (png.length < 8 || !PNG_SIGNATURE.every((byte, index) => png[index] === byte)) {
    throw new Error('no png')
  }

  const view = new DataView(png.buffer, png.byteOffset, png.byteLength)
  const kept: Uint8Array[] = [png.subarray(0, 8)]
  let at = 8
  let first = ''
  let last = ''
  let picture = false

  while (at < png.length && last !== 'IEND') {
    // Length, type, data, checksum.
    if (at + 12 > png.length) {
      throw new Error('no png')
    }

    const end = at + 12 + view.getUint32(at)

    if (end > png.length) {
      throw new Error('no png')
    }

    last = String.fromCharCode(...png.subarray(at + 4, at + 8))
    first = first || last

    if (KEPT_CHUNKS.has(last)) {
      kept.push(png.subarray(at, end))
      picture ||= last === 'IDAT'
    }

    at = end
  }

  if (first !== 'IHDR' || last !== 'IEND' || !picture) {
    throw new Error('no png')
  }

  const out = new Uint8Array(kept.reduce((sum, part) => sum + part.length, 0))
  let offset = 0

  for (const part of kept) {
    out.set(part, offset)
    offset += part.length
  }

  return out
}

/** The signature as a PNG: the canvas the same path is drawn on, encoded, with nothing in it but the picture. */
export async function signaturePng(strokes: readonly Stroke[]): Promise<Blob> {
  const canvas = document.createElement('canvas')

  canvas.width = PAD.width * PAD.scale
  canvas.height = PAD.height * PAD.scale

  const context = canvas.getContext('2d')

  if (!context) {
    throw new Error('no canvas')
  }

  drawSignature(context, strokes)

  const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/png'))

  if (!blob || blob.type !== 'image/png') {
    throw new Error('no png')
  }

  // A browser's encoder may add what it likes (WebKit writes an `eXIf` chunk): the file that goes up is the picture.
  return new Blob([stripPngMetadata(new Uint8Array(await bytesOf(blob)))], { type: 'image/png' })
}

/**
 * The SHA-256, as 64 lowercase hex digits, of the UTF-8 bytes of the statement exactly as the frame carried it: no
 * normalisation, no trimming, no change of line ending (`contract/requests/README.md` section 8). The sheet hashes what
 * it showed.
 */
export const statementSha256 = (statement: string): Promise<string> =>
  sha256Hex(new Blob([new TextEncoder().encode(statement)]))
