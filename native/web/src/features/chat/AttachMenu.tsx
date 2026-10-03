/**
 * The composer's way to pick files: one button and the browser's own file
 * dialog, several files at a time.
 *
 * Not a menu, although the native apps have one ("Photo library", "File"): those
 * two entries open two pickers there, and a browser has one, which already shows
 * images and every other file side by side. Which road a picked file takes
 * (an image over the socket, anything else uploaded) is decided by the tray from
 * the file itself (`core/chats/attachments.ts`), not by which entry was chosen.
 *
 * The `<input type="file">` is kept out of the tab order and out of the
 * accessibility tree: the button is the control, and it opens the input's dialog.
 * No `<form>` around it; nothing in the client submits one.
 */
import { type ChangeEvent, type ReactElement, useCallback, useRef } from 'react'

import { strings } from '../../generated/strings'
import { useLocale } from '../../i18n/use-locale'
import { Icon } from '../../ui/icons'
import { Button, VisuallyHidden } from '../../ui/primitives'

export interface AttachMenuProps {
  /** Files were picked, in the order the dialog gave them. */
  onFiles: (files: File[]) => void
  disabled?: boolean
}

export function AttachMenu({ onFiles, disabled = false }: AttachMenuProps): ReactElement {
  useLocale()

  const input = useRef<HTMLInputElement>(null)

  const open = useCallback(() => input.current?.click(), [])

  const picked = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(event.target.files ?? [])

      // Emptied, so picking the same file again is a change the input reports.
      event.target.value = ''

      if (files.length > 0) {
        onFiles(files)
      }
    },
    [onFiles]
  )

  return (
    <>
      <Button
        variant="quiet"
        className="hm-composer__attach"
        disabled={disabled}
        onClick={open}
        title={strings.chat.composer.attach}
      >
        <Icon name="paperclip" />
        <VisuallyHidden>{strings.chat.composer.attach}</VisuallyHidden>
      </Button>
      <input
        ref={input}
        className="hm-composer__picker"
        type="file"
        multiple
        hidden
        tabIndex={-1}
        aria-hidden="true"
        onChange={picked}
      />
    </>
  )
}
