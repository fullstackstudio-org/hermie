/**
 * One picture, over the whole page: a modal dialog named by the file, with a
 * way to save it and a way out.
 *
 * The parity source is the Expo app's `chat-ui/ImageViewer.tsx`. What a phone
 * does with gestures a browser already does: the picture is contained in the
 * window, and the browser's own zoom enlarges it. What the page adds is what a
 * dialog owes a keyboard and a screen reader:
 *
 *  - `role="dialog"` and `aria-modal`, named by its heading (the file name,
 *    cleaned and bounded, in `<bdi>`); the picture's text alternative is the same
 *    name. Everything behind it is `inert` while it is open (`isolateModal`).
 *  - Focus moves to Close when it opens, Tab stays inside it, and when it closes
 *    focus goes back to the card that opened it.
 *  - Escape closes it, and so does a press on the backdrop. Nothing here answers
 *    anything, so leaving is always safe.
 *
 * It is mounted by the chat screen, outside the transcript, and portalled to the
 * body: a row of the list is drawn in a chunk that contains its own painting, and
 * a viewer inside one would be clipped to it.
 *
 * The source has been checked against the gateway's origin before it gets here
 * (`gatewayImageSrc`); it is checked again, and a source that fails is not shown.
 */
import { type KeyboardEvent, type ReactElement, useEffect, useId, useRef } from 'react'
import { createPortal } from 'react-dom'

import { BOT_NAME_LIMIT, displayText, NAME_LIMIT } from '../../core/requests/secure-input'
import { strings } from '../../generated/strings'
import { useLocale } from '../../i18n/use-locale'
import { isolateModal } from '../../platform/modal-isolation'
import { gatewayImageSrc } from './items/ImageCard'
import type { ViewedImage } from './items/item-host'
import './items/media.css'

export interface ImageViewerProps {
  image: ViewedImage
  /** The gateway's base URL, which the source must be under. */
  gatewayBaseUrl: string | undefined
  onClose: () => void
  /** Where focus goes back to when the viewer closes. */
  opener?: HTMLElement | null
}

const FOCUSABLE = 'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])'

/** The file name a download is offered under: the last segment, without anything a file system would refuse. */
export function downloadName(name: string): string {
  const base = name.split(/[/\\]/u).pop() ?? ''

  return base.replace(/[<>:"|?*]/gu, '_').trim() || 'image'
}

export function ImageViewer({ image, gatewayBaseUrl, onClose, opener }: ImageViewerProps): ReactElement | null {
  useLocale()

  const titleId = useId()
  const overlay = useRef<HTMLDivElement>(null)
  const dialog = useRef<HTMLDivElement>(null)
  const close = useRef<HTMLButtonElement>(null)
  const src = gatewayImageSrc(image.src, gatewayBaseUrl)
  const name = displayText(image.name, NAME_LIMIT) || displayText(image.src.split('/').pop(), BOT_NAME_LIMIT)

  useEffect(() => {
    if (!overlay.current) {
      return undefined
    }

    const undo = isolateModal(overlay.current)

    close.current?.focus()

    return () => {
      undo()
      // Back where the reader was, if it is still on the page.
      if (opener?.isConnected) {
        opener.focus({ preventScroll: true })
      }
    }
  }, [opener])

  if (!src) {
    return null
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      onClose()

      return
    }

    if (event.key !== 'Tab' || !dialog.current) {
      return
    }

    const focusable = Array.from(dialog.current.querySelectorAll<HTMLElement>(FOCUSABLE))
    const first = focusable[0]
    const last = focusable[focusable.length - 1]

    if (!first || !last) {
      return
    }

    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first.focus()
    }
  }

  return createPortal(
    <div
      className="hm-viewer"
      ref={overlay}
      onKeyDown={onKeyDown}
      onClick={event => {
        // The backdrop, not the picture or the bar.
        if (event.target === event.currentTarget) {
          onClose()
        }
      }}
    >
      <div className="hm-viewer__dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} ref={dialog}>
        <div className="hm-viewer__bar">
          <h2 className="hm-viewer__title" id={titleId}>
            <bdi>{name}</bdi>
          </h2>
          <a className="hm-viewer__action" href={src} download={downloadName(name)}>
            {strings.chat.viewer.download}
          </a>
          <button type="button" className="hm-viewer__action" ref={close} onClick={onClose}>
            {strings.chat.viewer.close}
          </button>
        </div>
        <div
          className="hm-viewer__stage"
          onClick={event => {
            if (event.target === event.currentTarget) {
              onClose()
            }
          }}
        >
          <img className="hm-viewer__img" src={src} alt={name} referrerPolicy="no-referrer" />
        </div>
      </div>
    </div>,
    document.body
  )
}
