/**
 * SHA-256 of a file's bytes, as 64 lowercase hex digits: what an `input.file` answer quotes for every file
 * (`contract/requests/README.md` §5), so the gateway can check what it received.
 *
 * `crypto.subtle.digest` where the browser has it. It exists only in a secure context (https, localhost), and a
 * gateway on a LAN address over plain http is not one, so there is a plain implementation for that page: slower,
 * the same answer. Both read the file once; nothing is kept.
 */

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98,
  0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8,
  0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819,
  0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
])

const rotr = (value: number, bits: number): number => (value >>> bits) | (value << (32 - bits))

/** SHA-256 of `bytes` in plain code. */
export function sha256Plain(bytes: Uint8Array): string {
  const state = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19
  ])
  const length = bytes.length
  // The message, a one bit, zeros, and the length in bits as 64 bits, in whole 64-byte blocks.
  const padded = new Uint8Array(Math.ceil((length + 9) / 64) * 64)
  const view = new DataView(padded.buffer)

  padded.set(bytes)
  padded[length] = 0x80
  view.setUint32(padded.length - 8, Math.floor(length / 0x20000000), false)
  view.setUint32(padded.length - 4, (length << 3) >>> 0, false)

  const words = new Uint32Array(64)

  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let index = 0; index < 16; index += 1) {
      words[index] = view.getUint32(offset + index * 4, false)
    }

    for (let index = 16; index < 64; index += 1) {
      const a = words[index - 15] ?? 0
      const b = words[index - 2] ?? 0
      const s0 = rotr(a, 7) ^ rotr(a, 18) ^ (a >>> 3)
      const s1 = rotr(b, 17) ^ rotr(b, 19) ^ (b >>> 10)

      words[index] = ((words[index - 16] ?? 0) + s0 + (words[index - 7] ?? 0) + s1) >>> 0
    }

    let [a, b, c, d, e, f, g, h] = state as unknown as [number, number, number, number, number, number, number, number]

    for (let index = 0; index < 64; index += 1) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)
      const choice = (e & f) ^ (~e & g)
      const temp1 = (h + s1 + choice + (K[index] ?? 0) + (words[index] ?? 0)) >>> 0
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)
      const majority = (a & b) ^ (a & c) ^ (b & c)
      const temp2 = (s0 + majority) >>> 0

      h = g
      g = f
      f = e
      e = (d + temp1) >>> 0
      d = c
      c = b
      b = a
      a = (temp1 + temp2) >>> 0
    }

    state[0] = ((state[0] ?? 0) + a) >>> 0
    state[1] = ((state[1] ?? 0) + b) >>> 0
    state[2] = ((state[2] ?? 0) + c) >>> 0
    state[3] = ((state[3] ?? 0) + d) >>> 0
    state[4] = ((state[4] ?? 0) + e) >>> 0
    state[5] = ((state[5] ?? 0) + f) >>> 0
    state[6] = ((state[6] ?? 0) + g) >>> 0
    state[7] = ((state[7] ?? 0) + h) >>> 0
  }

  return Array.from(state, word => word.toString(16).padStart(8, '0')).join('')
}

const hex = (digest: ArrayBuffer): string =>
  Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')

/** The bytes of a blob: `Blob.arrayBuffer` where there is one, a `FileReader` where there is not (an older browser). */
function bytesOf(blob: Blob): Promise<ArrayBuffer> {
  if (typeof blob.arrayBuffer === 'function') {
    return blob.arrayBuffer()
  }

  return new Promise((resolve, reject) => {
    const reader = new FileReader()

    reader.onload = () => resolve(reader.result as ArrayBuffer)
    reader.onerror = () => reject(reader.error ?? new Error('the file could not be read'))
    reader.readAsArrayBuffer(blob)
  })
}

/** The SHA-256 of a blob's bytes, lowercase hex. */
export async function sha256Hex(blob: Blob): Promise<string> {
  const bytes = await bytesOf(blob)
  const subtle = (globalThis.crypto as Crypto | undefined)?.subtle

  return subtle ? hex(await subtle.digest('SHA-256', bytes)) : sha256Plain(new Uint8Array(bytes))
}
