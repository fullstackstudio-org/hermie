/**
 * The big inputs of the inline-image tests, run here so the golden recorder, which only sees
 * calls a test file makes itself, does not write a 90 MB corpus file for them.
 */
import { INLINE_IMAGE_MAX_BYTES, INLINE_IMAGE_MAX_COUNT, scanInlineImages } from '../inline-images'

export { INLINE_IMAGE_MAX_BYTES, INLINE_IMAGE_MAX_COUNT }

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

/** A PNG signature, then zeros: a body of about `bytes` decoded bytes, in whole groups. */
export function pngBody(bytes: number): string {
  const groups = Math.floor(bytes / 3)

  return 'iVBORw0KGgo' + 'A'.repeat(groups * 4 - 11)
}

export function scanOverTheCap() {
  return scanInlineImages(
    `[Image attached at: /x/huge.png]\ndata:image/png;base64,${pngBody(INLINE_IMAGE_MAX_BYTES + 4096)}\nafter`
  )
}

export function scanUnderTheCap() {
  const body = pngBody(INLINE_IMAGE_MAX_BYTES - 16)

  return { body, scan: scanInlineImages(`data:image/png;base64,${body}`) }
}

export function scanLongText() {
  const filler = 'x'.repeat(2_000_000)
  const started = Date.now()
  const scan = scanInlineImages(`${filler}\ndata:image/png;base64,${PNG}\n${filler}`)

  return { scan, fillerLength: filler.length, elapsedMs: Date.now() - started }
}

export function scanTooMany() {
  const many = Array.from({ length: INLINE_IMAGE_MAX_COUNT + 5 }, () => `data:image/png;base64,${PNG}`).join('\n')

  return scanInlineImages(`hi\n${many}`)
}
