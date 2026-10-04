/**
 * Prepares a picked photo to be a bot's picture (the native app's `AvatarEncoder`): turned upright, cropped
 * to a square from the middle, scaled down to `AVATAR_SIDE` pixels and written as a JPEG, and handed back as
 * the bare base64 `profiles.set_asset` takes (PNG, JPEG or WebP up to 2 MB), with the same picture as a
 * `data:` URL for the preview (the page's policy allows `data:` for images, and no `blob:`).
 *
 * Nothing of the original is kept but its pixels: the photo is decoded and drawn again, so its metadata,
 * location included, does not travel to the gateway, where every client can read the picture.
 *
 * The browser's own seams (decoding, a canvas, encoding) are passed in (`ImageEnvironment`), so the rules
 * here (what is refused, how the square is cut, the quality that steps down until it fits) are asserted
 * without a browser; `browserImages` is the real one.
 */

/** The gateway's own limit on a picture's bytes. */
export const AVATAR_BYTE_LIMIT = 2_000_000
/** The edge of the square picture, in pixels. The largest place it is drawn is smaller. */
export const AVATAR_SIDE = 512
/** The largest file read at all: a photo is decoded in memory, and nothing larger is a photo to send. */
export const AVATAR_SOURCE_LIMIT = 40_000_000
/** The JPEG qualities tried, best first, until the result fits. */
export const AVATAR_QUALITIES: readonly number[] = [0.85, 0.7, 0.5]

/** Why a picture was not taken. */
export type AvatarProblem = 'not_image' | 'too_large' | 'unreadable'

export class AvatarError extends Error {
  constructor(readonly problem: AvatarProblem) {
    super(problem)
    this.name = 'AvatarError'
  }
}

/** A decoded picture, drawable onto a canvas. */
export interface DecodedImage {
  width: number
  height: number
  /** Draw the square `source` of it into the canvas, filling it. */
  drawSquare(canvas: AvatarCanvas, source: SquareCrop): void
  close(): void
}

export interface AvatarCanvas {
  readonly side: number
  /** The canvas as a JPEG of this quality, or `null` when the browser could not make one. */
  toJpeg(quality: number): Promise<Blob | null>
}

export interface ImageEnvironment {
  /** Decode a picked file, upright; rejects when it is not an image the browser reads. */
  decode(file: Blob): Promise<DecodedImage>
  canvas(side: number): AvatarCanvas
  /** The bytes of a blob as base64, bare. */
  base64(blob: Blob): Promise<string>
}

/** The square cut from the middle of a picture: its top-left corner and its edge. */
export interface SquareCrop {
  x: number
  y: number
  edge: number
}

/** The middle square of a `width` by `height` picture. */
export function squareCrop(width: number, height: number): SquareCrop {
  const edge = Math.min(width, height)

  return { x: Math.floor((width - edge) / 2), y: Math.floor((height - edge) / 2), edge }
}

export interface PreparedAvatar {
  /** Bare base64 of the JPEG, as `profiles.set_asset` takes it. */
  base64: string
  /** The same picture as a `data:` URL, for the preview. */
  dataUrl: string
}

/** A picked file as the picture `profiles.set_asset` takes. Rejects with an `AvatarError`. */
export async function prepareAvatar(file: Blob, env: ImageEnvironment = browserImages): Promise<PreparedAvatar> {
  if (!file.type.startsWith('image/')) {
    throw new AvatarError('not_image')
  }

  if (file.size > AVATAR_SOURCE_LIMIT) {
    throw new AvatarError('too_large')
  }

  let image: DecodedImage

  try {
    image = await env.decode(file)
  } catch {
    throw new AvatarError('unreadable')
  }

  try {
    const crop = squareCrop(image.width, image.height)

    if (crop.edge <= 0) {
      throw new AvatarError('unreadable')
    }

    const canvas = env.canvas(Math.min(crop.edge, AVATAR_SIDE))

    image.drawSquare(canvas, crop)

    for (const quality of AVATAR_QUALITIES) {
      const jpeg = await canvas.toJpeg(quality)

      if (jpeg && jpeg.size > 0 && jpeg.size <= AVATAR_BYTE_LIMIT) {
        const base64 = await env.base64(jpeg)

        return { base64, dataUrl: `data:image/jpeg;base64,${base64}` }
      }
    }

    throw new AvatarError('too_large')
  } finally {
    image.close()
  }
}

/** The page's own: `createImageBitmap`, a canvas element, `FileReader`. */
export const browserImages: ImageEnvironment = {
  async decode(file) {
    // `from-image` applies the photo's own orientation, so a phone's sideways photo is cut upright; an engine
    // that does not know the word draws it upright by default, so it is asked again without.
    const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' }).catch(() =>
      createImageBitmap(file)
    )

    return {
      width: bitmap.width,
      height: bitmap.height,
      drawSquare(canvas, source) {
        const context = (canvas as BrowserCanvas).element.getContext('2d')

        if (!context) {
          throw new AvatarError('unreadable')
        }

        context.imageSmoothingQuality = 'high'
        context.drawImage(bitmap, source.x, source.y, source.edge, source.edge, 0, 0, canvas.side, canvas.side)
      },
      close: () => bitmap.close()
    }
  },

  canvas(side) {
    const element = document.createElement('canvas')

    element.width = side
    element.height = side

    const canvas: BrowserCanvas = {
      side,
      element,
      toJpeg: quality => new Promise(resolve => element.toBlob(resolve, 'image/jpeg', quality))
    }

    return canvas
  },

  base64(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader()

      reader.onerror = () => reject(new AvatarError('unreadable'))
      reader.onload = () => {
        const url = typeof reader.result === 'string' ? reader.result : ''
        const comma = url.indexOf(',')

        if (comma < 0) {
          reject(new AvatarError('unreadable'))

          return
        }

        resolve(url.slice(comma + 1))
      }
      reader.readAsDataURL(blob)
    })
  }
}

interface BrowserCanvas extends AvatarCanvas {
  element: HTMLCanvasElement
}
