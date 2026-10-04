/**
 * The attachments of one message, laid out the way a messenger lays them out.
 *
 * The parity source is the Expo app's `chat-ui/AttachmentGallery.tsx`:
 *
 *  - **A picture is a picture only when it can be loaded.** Which an attachment
 *    becomes is decided by whether the host has something to load for it
 *    (`ItemHost.attachmentSrc`), never by its file name: a `.png` the gateway
 *    holds on its own disk is a name and nothing more, and an `<img>` pointed at
 *    a path draws a broken frame where a chip would have said something true.
 *  - **An image the gateway named no file for** (the `[image]` line of its history, `@image:Image`) has nothing to
 *    fetch and nothing to open: it is a plain chip with its name and no control.
 *  - **The grid counts pictures, not attachments.** One fills the width, two and
 *    four go two across, three or more go three across. A file beside them takes
 *    a full row of its own: a name squeezed into a third of a bubble is a name
 *    nobody can read.
 *
 *  - **A picture the message holds itself** (`src`, a raster `data:` URI the transcript lifted out of
 *    the text) is drawn as it is. A picture the gateway holds on its disk (an attached image's handle) is
 *    fetched through the host (`RemotePicture`) in a frame of its card's size; and any other chip is a
 *    control that opens what it names (`OpenableChip`), where the host can fetch it.
 *
 * It is a list named "Attachments", one item per attachment, in the order the
 * message holds them.
 */
import { isImagePlaceholder } from '@hermie/transcript'
import { memo, useCallback } from 'react'

import { namesAPicture } from '../../../core/chats/attachment-fetch'
import { useLocale } from '../../../i18n/use-locale'
import { webStrings } from '../../../i18n/web-strings'
import { OpenableChip, RemotePicture } from './AttachmentEntries'
import { FileChip } from './FileChip'
import { gatewayImageSrc, ImageCard } from './ImageCard'
import { useItemContext } from './item-context'
import { useItemHost } from './item-host'
import './media.css'

/** One attachment as the bubble holds it. */
export interface GalleryAttachment {
  /** The stored reference (`@image:/srv/shot.png`, `@file:...`): the key, and what the host resolves. */
  reference: string
  /** The file name, derived from the reference (`attachmentName`). */
  name: string
  /** Bytes, when known. */
  size?: number
  /** A picture the message holds itself, as a raster `data:` URI: drawn as it is, never fetched. */
  src?: string
}

export interface AttachmentGalleryProps {
  attachments: readonly GalleryAttachment[]
  /** Inside the reader's own bubble: the chips take the bubble's ink. */
  onAccent?: boolean
}

/** How many pictures go across, given how many there are. */
export function gridColumns(pictures: number): number {
  if (pictures <= 1) {
    return 1
  }

  return pictures === 2 || pictures === 4 ? 2 : 3
}

function AttachmentGalleryImpl({ attachments, onAccent = false }: AttachmentGalleryProps) {
  useLocale()

  const host = useItemHost()
  const { gatewayBaseUrl } = useItemContext()
  const open = useCallback(
    (src: string, name: string) => (opener: HTMLElement) => host.openImage({ src, name }, opener),
    [host]
  )

  if (attachments.length === 0) {
    return null
  }

  const canFetch = host.loadAttachment !== undefined
  const resolved = attachments.map(entry => {
    const src = gatewayImageSrc(entry.src ?? host.attachmentSrc(entry.reference), gatewayBaseUrl)
    // A picture by what the reference says it is, fetched when the host can: otherwise it is the chip it always was.
    const placeholder = src === null && isImagePlaceholder(entry.reference)
    const remote =
      src === null &&
      canFetch &&
      !placeholder &&
      !entry.reference.startsWith('inline:') &&
      namesAPicture(entry.reference)

    return { ...entry, src, remote, placeholder, held: entry.src !== undefined }
  })
  const columns = gridColumns(resolved.filter(entry => entry.src !== null || entry.remote).length)
  const layout = columns > 1 ? 'cell' : 'solo'

  return (
    <ul className="hm-gallery" data-columns={columns} aria-label={webStrings.chat.attachments}>
      {resolved.map(entry => (
        <li
          key={entry.reference}
          className="hm-gallery__entry"
          data-kind={entry.src || entry.remote ? 'image' : 'file'}
        >
          {entry.src ? (
            <ImageCard
              src={entry.src}
              name={entry.name}
              layout={layout}
              onAccent={onAccent}
              reserve={entry.held}
              onOpen={open(entry.src, entry.name)}
            />
          ) : entry.remote ? (
            <RemotePicture reference={entry.reference} name={entry.name} layout={layout} onAccent={onAccent} />
          ) : entry.placeholder || entry.reference.startsWith('inline:') ? (
            // A picture the message held and the page cannot draw (a type the browser has no decoder for), or an
            // image the gateway named no file for: a name, not a control.
            <FileChip name={entry.name} onAccent={onAccent} />
          ) : (
            <OpenableChip
              reference={entry.reference}
              name={entry.name}
              onAccent={onAccent}
              {...(entry.size !== undefined ? { size: entry.size } : {})}
            />
          )}
        </li>
      ))}
    </ul>
  )
}

export const AttachmentGallery = memo(AttachmentGalleryImpl)
