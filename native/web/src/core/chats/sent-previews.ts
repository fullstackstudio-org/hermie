/**
 * The pictures the reader sent from this page, by chat and file name, so their
 * bubbles show the picture and not only its name.
 *
 * What the gateway keeps of an image is a path on its own disk, and no route
 * serves one back, so a bubble from history can only name it. The one picture
 * the page does have is the thumbnail it made from the bytes the reader picked
 * (`AttachmentTray`, a `data:` URL), and the tray hands its images here as a
 * send takes them (`onTake`), before the send paints its bubble. The bubble
 * looks its attachments up by file name (`attachmentName`), the one part of a
 * reference both sides of the wire agree on; the Expo app keeps its sent images
 * the same way.
 *
 * Memory only, and bounded: a page that sends a hundred pictures keeps the
 * newest `MAX_SENT_PREVIEWS`. Nothing here is ever written to storage or sent
 * anywhere.
 */
import type { SentImagePreview } from './attachments'

/** How many thumbnails are kept across every chat; the oldest goes first. */
export const MAX_SENT_PREVIEWS = 48

/** Insertion order is age: a `Map` keeps it. Keyed `<chat>\u0000<name>`. */
const previews = new Map<string, string>()

const keyOf = (chatKey: string, name: string): string => `${chatKey}\u0000${name}`

/** Remember the thumbnails of a send in `chatKey`. */
export function rememberSentPreviews(chatKey: string, images: readonly SentImagePreview[]): void {
  for (const image of images) {
    const key = keyOf(chatKey, image.name)

    previews.delete(key)
    previews.set(key, image.previewUrl)
  }

  while (previews.size > MAX_SENT_PREVIEWS) {
    const oldest = previews.keys().next().value

    if (oldest === undefined) {
      break
    }

    previews.delete(oldest)
  }
}

/** The thumbnail of the picture sent in `chatKey` under `name`, or `undefined`. */
export function sentPreviewFor(chatKey: string | undefined, name: string): string | undefined {
  return chatKey === undefined || !name ? undefined : previews.get(keyOf(chatKey, name))
}

/** Forget every thumbnail (tests). */
export function clearSentPreviews(): void {
  previews.clear()
}
