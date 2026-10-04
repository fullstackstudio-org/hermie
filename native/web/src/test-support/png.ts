/**
 * PNG files made of the chunks a test names, and the chunk types of one: enough of the format (signature, then length,
 * type, data and checksum per chunk) to hold a signature's encoder to what it may put in a file. The data and the
 * checksums are filler: nothing here is decoded.
 */

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

/** One chunk: 13 bytes of data for `IHDR`, none for `IEND`, five of `x` for anything else. */
export function pngChunk(type: string): Uint8Array {
  const size = type === 'IHDR' ? 13 : type === 'IEND' ? 0 : 5
  const chunk = new Uint8Array(12 + size)

  new DataView(chunk.buffer).setUint32(0, size)
  chunk.set(new TextEncoder().encode(type), 4)
  chunk.fill(0x78, 8, 8 + size)

  return chunk
}

/** A PNG whose chunks are `types`, in that order (a test makes `IHDR` first, `IEND` last, and the picture between). */
export function pngOf(types: readonly string[]): Uint8Array<ArrayBuffer> {
  const chunks = types.map(pngChunk)
  const png = new Uint8Array(8 + chunks.reduce((sum, chunk) => sum + chunk.length, 0))
  let offset = 8

  png.set(SIGNATURE, 0)

  for (const chunk of chunks) {
    png.set(chunk, offset)
    offset += chunk.length
  }

  return png
}

/** The types of a PNG's chunks, in order. */
export function pngChunkTypes(png: Uint8Array): string[] {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength)
  const types: string[] = []
  let at = 8

  while (at + 12 <= png.length) {
    types.push(String.fromCharCode(...png.subarray(at + 4, at + 8)))
    at += 12 + view.getUint32(at)
  }

  return types
}
