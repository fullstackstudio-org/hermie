/**
 * The attachment tray of the chat on screen, and a component's view of it.
 *
 * One tray per chat key, made by the chat screen and handed to both the composer
 * (the picker, a paste, the chips, the send) and the drop zone over the chat, so
 * the three ways in end in the same place. Uploads go through the controller's
 * `uploadFile`, which knows where in the session's workspace a file has to land.
 * Leaving the chat stops what is still uploading.
 */
import { useEffect, useMemo, useSyncExternalStore } from 'react'

import { AttachmentTray, type StagedAttachment } from '../../core/chats/attachments'
import { readFileAsBase64 } from '../../platform/files'
import type { ChatScreenController } from './chat-runtime'

const NONE: readonly StagedAttachment[] = []
const noSubscription = (): (() => void) => () => undefined
const noAttachments = (): readonly StagedAttachment[] => NONE

/** The tray of `chatKey`, or `null` while there is no chat or no controller to upload through. */
export function useAttachmentTray(
  chatKey: string | undefined,
  controller: Pick<ChatScreenController, 'uploadFile'> | undefined
): AttachmentTray | null {
  const tray = useMemo(
    () =>
      chatKey === undefined || !controller
        ? null
        : new AttachmentTray({
            upload: (file, options) => controller.uploadFile(chatKey, file, options),
            readBase64: readFileAsBase64
          }),
    [chatKey, controller]
  )

  // `clear` leaves the tray usable, so React's development double mount costs nothing.
  useEffect(() => () => tray?.clear(), [tray])

  return tray
}

/** What a tray holds, as a render-time value: the same array until it changes. */
export function useStagedAttachments(tray: AttachmentTray | null | undefined): readonly StagedAttachment[] {
  return useSyncExternalStore(tray?.subscribe ?? noSubscription, tray?.getSnapshot ?? noAttachments)
}
