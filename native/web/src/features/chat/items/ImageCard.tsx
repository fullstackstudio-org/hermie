/**
 * An attached picture, inside the bubble.
 *
 * The parity source is the Expo app's `chat-ui/ImageCard.tsx`, and its two
 * shapes: **in a grid** the card is a fixed height and the picture fills it,
 * cropped, so the cells read as a grid; **on its own** the picture keeps its
 * own aspect ratio up to a ceiling and is contained, because a lone attachment
 * is the message and a screenshot cropped to a card loses what it was attached
 * to show. A browser does that with `object-fit` and a `max-height`; nothing is
 * measured.
 *
 * **Only the gateway's own origin.** What an attachment points at is decided
 * here again, whatever the caller already decided (`gatewayImageSrc`): a picture
 * loads from the gateway the page belongs to, under its base path, or is a
 * thumbnail this page made itself of a file the reader picked (a raster
 * `data:` image, `sent-previews.ts`; or a `blob:` URL of the same origin).
 * Anything else is a request the reader did not make, to a host somebody else
 * chose, and is drawn as the file chip it would have been. A picture that
 * fails to load becomes the chip as well, so a dead link is never an empty frame.
 *
 * The card is a button that opens the viewer (`ImageViewer`), named by the file.
 */
import { memo, useState } from 'react'

import { resolveImage } from '../../../markdown/links'
import { BOT_NAME_LIMIT, displayText, NAME_LIMIT } from '../../../core/requests/secure-input'
import { FileChip } from './FileChip'
import { useItemContext } from './item-context'
import './media.css'

/** A raster image as base64: the thumbnails the attachment tray makes. No SVG, no other type. */
const RASTER_DATA_URL = /^data:image\/(?:png|jpeg|gif|webp|bmp|tiff);base64,[a-z0-9+/]+=*$/iu

/**
 * Where an `<img>` may load `src` from, or `null`: the gateway's origin under its
 * base path (`resolveImage`, the rule a picture in a message follows), a `blob:`
 * URL minted on that same origin, or a raster `data:` image. A URL with
 * credentials in it, any other scheme and any other host are refused.
 *
 * The `data:` case is safe because of where `src` comes from: never a message's
 * text (a picture in Markdown goes through `resolveImage`, which refuses it), only
 * the host's `attachmentSrc`, which holds thumbnails the page made of files the
 * reader picked. It loads nothing from anywhere.
 */
export function gatewayImageSrc(src: string | undefined, gatewayBaseUrl: string | undefined): string | null {
  const raw = src?.trim()

  if (!raw || !gatewayBaseUrl) {
    return null
  }

  if (/^data:/iu.test(raw)) {
    return RASTER_DATA_URL.test(raw) ? raw : null
  }

  if (/^blob:/iu.test(raw)) {
    try {
      const base = new URL(gatewayBaseUrl)
      // A blob URL's origin is the document's that created it; one of ours names the gateway's origin.
      const blob = new URL(raw)

      return blob.origin === base.origin && (base.protocol === 'http:' || base.protocol === 'https:') ? blob.href : null
    } catch {
      return null
    }
  }

  const resolved = resolveImage(raw, gatewayBaseUrl)

  return resolved.kind === 'image' ? resolved.src : null
}

export interface ImageCardProps {
  /** What to load; checked against the gateway's origin before anything is requested. */
  src: string
  /** The file name: the picture's text alternative and the button's name. */
  name: string
  /** `cell` is a fixed, cropped tile of a grid; `solo` keeps the picture's own shape. */
  layout?: 'solo' | 'cell'
  /** Inside the reader's own bubble. */
  onAccent?: boolean
  /**
   * Keep the frame of a card a picture is still on its way to (`RemotePicture`): the lone picture is drawn in a
   * frame of the card's own size and fitted, so the row is the same height before and after the bytes arrive.
   */
  reserve?: boolean
  /** Open the viewer; handed the card, so focus can go back to it. */
  onOpen?: (opener: HTMLElement) => void
  /** The card's own element, for a caller that watches whether it is on screen (`SharedFiles`). */
  rootRef?: (element: HTMLElement | null) => void
}

function ImageCardImpl({
  src,
  name,
  layout = 'solo',
  onAccent = false,
  reserve = false,
  onOpen,
  rootRef
}: ImageCardProps) {
  const { gatewayBaseUrl } = useItemContext()
  const [broken, setBroken] = useState<string | null>(null)
  const allowed = gatewayImageSrc(src, gatewayBaseUrl)
  const shownName = displayText(name, NAME_LIMIT) || displayText(src.split('/').pop(), BOT_NAME_LIMIT)

  if (!allowed || broken === allowed) {
    return <FileChip name={shownName} onAccent={onAccent} />
  }

  const picture = (
    <img
      className="hm-image__img"
      src={allowed}
      alt={shownName}
      loading="lazy"
      decoding="async"
      referrerPolicy="no-referrer"
      onError={() => setBroken(allowed)}
    />
  )

  if (!onOpen) {
    return (
      <span ref={rootRef} className="hm-image" data-layout={layout} data-reserved={reserve} data-on-accent={onAccent}>
        {picture}
      </span>
    )
  }

  return (
    <button
      ref={rootRef}
      type="button"
      className="hm-image"
      data-layout={layout}
      data-reserved={reserve}
      data-on-accent={onAccent}
      onClick={event => onOpen(event.currentTarget)}
    >
      {picture}
    </button>
  )
}

export const ImageCard = memo(ImageCardImpl)
