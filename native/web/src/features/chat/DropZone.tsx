/**
 * Files dragged over the chat: a target that says where they will go, and the
 * drop handed to the composer's tray.
 *
 * The zone is the whole chat (the transcript and the composer), because that is
 * where a reader aims a file, not at a small box. While a drag that carries files
 * is over it, a target is drawn over the chat with the words of the native apps
 * ("Drop file to attach"), and a polite region says the same once, so a screen
 * reader user who drags hears where they are. A drag of text or of a link from
 * the page is left alone: only `Files` turns the zone on.
 *
 * `dragenter` and `dragleave` fire for every child the pointer crosses, so the
 * zone counts them rather than trusting the last one; a drop, a `dragend` or the
 * count reaching zero turns the target off.
 *
 * While the zone is on screen, enabled or not, a file dropped anywhere else on the
 * page is ignored instead of being opened by the browser in place of the app
 * (`guardStrayFileDrops`): a chat that takes no attachments (a past conversation,
 * one not attached to a session yet) must not lose the app to a file either, and
 * the pointer shows that nothing will be taken.
 *
 * The drop is the mouse's way in. The keyboard's is the composer's attach
 * button, which offers the same files through the browser's dialog.
 */
import { type DragEvent, type ReactElement, type ReactNode, useCallback, useEffect, useRef, useState } from 'react'

import { strings } from '../../generated/strings'
import { useLocale } from '../../i18n/use-locale'
import { dragCarriesFiles, filesOf, guardStrayFileDrops } from '../../platform/files'

export interface DropZoneProps {
  /** Files were dropped, in the order the drag carried them. */
  onFiles: (files: File[]) => void
  /** Off where nothing can be attached: a chat that is read only, or not open yet. */
  enabled: boolean
  className?: string
  children: ReactNode
}

export function DropZone({ onFiles, enabled, className, children }: DropZoneProps): ReactElement {
  useLocale()

  const [over, setOver] = useState(false)
  const depth = useRef(0)

  useEffect(() => guardStrayFileDrops(), [])

  useEffect(() => {
    if (!enabled) {
      depth.current = 0
      setOver(false)
    }
  }, [enabled])

  const reset = useCallback(() => {
    depth.current = 0
    setOver(false)
  }, [])

  const onDragEnter = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      if (!enabled || !dragCarriesFiles(event.dataTransfer)) {
        return
      }

      event.preventDefault()
      depth.current += 1
      setOver(true)
    },
    [enabled]
  )

  const onDragOver = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      if (!enabled || !dragCarriesFiles(event.dataTransfer)) {
        return
      }

      // Without this the browser does not offer the drop at all.
      event.preventDefault()
      event.dataTransfer.dropEffect = 'copy'
    },
    [enabled]
  )

  const onDragLeave = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      if (!enabled || !dragCarriesFiles(event.dataTransfer)) {
        return
      }

      depth.current = Math.max(0, depth.current - 1)

      if (depth.current === 0) {
        setOver(false)
      }
    },
    [enabled]
  )

  const onDrop = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      if (!enabled || !dragCarriesFiles(event.dataTransfer)) {
        return
      }

      event.preventDefault()
      reset()

      const files = filesOf(event.dataTransfer)

      if (files.length > 0) {
        onFiles(files)
      }
    },
    [enabled, onFiles, reset]
  )

  return (
    <div
      className={className ? `hm-dropzone ${className}` : 'hm-dropzone'}
      data-drop-active={over ? 'true' : 'false'}
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      onDragEnd={reset}
    >
      {children}

      {over ? (
        <div className="hm-dropzone__target" aria-hidden="true">
          <p className="hm-dropzone__words">{strings.chat.drop.invitation}</p>
        </div>
      ) : null}

      <div className="hm-sr" role="status" aria-live="polite">
        {over ? strings.chat.drop.region : ''}
      </div>
    </div>
  )
}
