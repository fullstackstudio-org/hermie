/**
 * Preparing a picked photo to be a bot's picture: what is refused, the square cut from the middle, the
 * edge it is scaled to, and the quality that steps down until the JPEG fits the gateway's 2 MB.
 * The browser's own decoding, canvas and encoding are seams (`ImageEnvironment`), so none of it needs a
 * browser; the real ones run in the black-box suite (`e2e/bot-profile.spec.ts`).
 */
import { describe, expect, it, vi } from 'vitest'

import {
  AVATAR_BYTE_LIMIT,
  AVATAR_QUALITIES,
  AVATAR_SIDE,
  AvatarError,
  type AvatarCanvas,
  type ImageEnvironment,
  prepareAvatar,
  squareCrop
} from './avatar'

const png = (size = 10): Blob => new Blob([new Uint8Array(size)], { type: 'image/png' })

/** An environment whose JPEG of each quality has the size `sizes` says (`null`: the browser made none). */
function environment(width: number, height: number, sizes: (number | null)[]) {
  const drawn: { canvas: number; x: number; y: number; edge: number }[] = []
  const qualities: number[] = []
  const closed = vi.fn()
  const canvases: number[] = []

  const env: ImageEnvironment = {
    decode: async () => ({
      width,
      height,
      drawSquare: (canvas, source) => drawn.push({ canvas: canvas.side, x: source.x, y: source.y, edge: source.edge }),
      close: closed
    }),
    canvas: side => {
      canvases.push(side)

      const canvas: AvatarCanvas = {
        side,
        toJpeg: async quality => {
          const size = sizes[qualities.length]

          qualities.push(quality)

          return size === null || size === undefined ? null : new Blob([new Uint8Array(size)], { type: 'image/jpeg' })
        }
      }

      return canvas
    },
    base64: async blob => `b64:${blob.size}`
  }

  return { env, drawn, qualities, closed, canvases }
}

describe('squareCrop', () => {
  it('cuts the middle square of a landscape, a portrait and a square picture', () => {
    expect(squareCrop(400, 200)).toEqual({ x: 100, y: 0, edge: 200 })
    expect(squareCrop(200, 400)).toEqual({ x: 0, y: 100, edge: 200 })
    expect(squareCrop(300, 300)).toEqual({ x: 0, y: 0, edge: 300 })
    expect(squareCrop(301, 200)).toEqual({ x: 50, y: 0, edge: 200 })
  })
})

describe('prepareAvatar', () => {
  it('refuses what is not an image, without reading it', async () => {
    const { env, closed } = environment(10, 10, [1])

    await expect(prepareAvatar(new Blob(['x'], { type: 'text/plain' }), env)).rejects.toMatchObject({
      problem: 'not_image'
    })
    expect(closed).not.toHaveBeenCalled()
  })

  it('refuses a file too large to be a photo at all', async () => {
    const big = { type: 'image/png', size: 41_000_000 } as Blob

    await expect(prepareAvatar(big, environment(10, 10, [1]).env)).rejects.toMatchObject({ problem: 'too_large' })
  })

  it('says unreadable for an image the browser cannot decode', async () => {
    const env: ImageEnvironment = {
      ...environment(10, 10, [1]).env,
      decode: async () => Promise.reject(new Error('bad'))
    }

    await expect(prepareAvatar(png(), env)).rejects.toMatchObject({ problem: 'unreadable' })
    await expect(prepareAvatar(png(), env)).rejects.toBeInstanceOf(AvatarError)
  })

  it('cuts the middle square, scales it to the side, and answers bare base64 with the same picture as a data URL', async () => {
    const { env, drawn, canvases, closed } = environment(2000, 1000, [50_000])
    const prepared = await prepareAvatar(png(), env)

    expect(canvases).toEqual([AVATAR_SIDE])
    expect(drawn).toEqual([{ canvas: AVATAR_SIDE, x: 500, y: 0, edge: 1000 }])
    expect(prepared).toEqual({ base64: 'b64:50000', dataUrl: 'data:image/jpeg;base64,b64:50000' })
    expect(closed).toHaveBeenCalledTimes(1)
  })

  it('does not scale a small picture up', async () => {
    const { env, canvases } = environment(120, 90, [1000])

    await prepareAvatar(png(), env)

    expect(canvases).toEqual([90])
  })

  it('steps the quality down until the result fits the gateway’s limit', async () => {
    const { env, qualities } = environment(800, 800, [AVATAR_BYTE_LIMIT + 1, AVATAR_BYTE_LIMIT, 10])
    const prepared = await prepareAvatar(png(), env)

    expect(qualities).toEqual([...AVATAR_QUALITIES].slice(0, 2))
    expect(prepared.base64).toBe(`b64:${AVATAR_BYTE_LIMIT}`)
  })

  it('says too large when even the lowest quality does not fit, and an encoder that gave nothing is a miss', async () => {
    const { env, qualities, closed } = environment(800, 800, [null, AVATAR_BYTE_LIMIT + 1, AVATAR_BYTE_LIMIT + 5])

    await expect(prepareAvatar(png(), env)).rejects.toMatchObject({ problem: 'too_large' })
    expect(qualities).toEqual([...AVATAR_QUALITIES])
    // The decoded picture is let go of whatever happened.
    expect(closed).toHaveBeenCalledTimes(1)
  })

  it('says unreadable for a picture with nothing in it', async () => {
    const { env, closed } = environment(0, 100, [1])

    await expect(prepareAvatar(png(), env)).rejects.toMatchObject({ problem: 'unreadable' })
    expect(closed).toHaveBeenCalledTimes(1)
  })
})
