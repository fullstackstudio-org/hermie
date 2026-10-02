/**
 * Splitting a paste's files by which pipeline they belong to.
 *
 * An image goes through the same resize-and-attach road the "+" menu's photo
 * option does — `resizeToBase64`, then `image.attach_bytes` — because that is
 * what makes it a thumbnail with a remove control rather than a chip with a
 * generic glyph. Anything else goes through the file upload the "+" menu's other
 * option and a Finder drop both already use.
 *
 * The rule is the MIME type alone, read off the same `DroppedFile` a drop
 * produces: a HEIC screenshot and a PNG copied out of Preview both start with
 * `image/`, and a paste never carries the kind of filename-only ambiguity a bare
 * extension would.
 */
import type { DroppedFile } from '../../platform/file-drop'

export interface SplitPastedFiles {
  images: readonly DroppedFile[]
  files: readonly DroppedFile[]
}

/** Every file in one paste, in order, sorted into the two roads a chat takes. */
export function splitPastedFiles(files: readonly DroppedFile[]): SplitPastedFiles {
  const images: DroppedFile[] = []
  const rest: DroppedFile[] = []

  for (const file of files) {
    ;(file.mimeType.startsWith('image/') ? images : rest).push(file)
  }

  return { files: rest, images }
}
