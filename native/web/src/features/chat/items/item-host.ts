/**
 * What a row, and the transcript's one message menu (`MessageMenuLayer`), can ask
 * the chat screen for: a picture to load for an attachment, the image viewer, a
 * message by id, a copy, and the last reply again.
 *
 * Its own context beside `ItemContext`, and for the same reason: rows are
 * memoised on `(id, version, presentation)`, so whatever else they read has to
 * hold still while the chat is open. The host is one object per screen whose
 * identity never changes; what does change (whether a turn runs, which reply
 * may be regenerated) is read through `subscribe` and a snapshot, so only a menu
 * that is open re-renders when it moves, never a settled row.
 *
 * Nothing here talks to the gateway. The screen does, behind `regenerate`.
 */
import type { TranscriptItem } from '@hermie/transcript'
import { createContext, useContext } from 'react'

import { writeClipboard } from '../../../platform/clipboard'

/** A picture the viewer shows: a source already checked against the gateway's origin, and its name. */
export interface ViewedImage {
  src: string
  name: string
}

export interface ItemHost {
  /**
   * Something an `<img>` may load for an attachment reference, or `undefined`
   * (a chip). Only the host knows: a reference is a path on the gateway's disk,
   * and no route serves one back. The answer is checked again before it is used.
   */
  attachmentSrc(reference: string): string | undefined
  /** The item a message element (`data-message-id`) stands for, as it is now; `undefined` once it is gone. */
  itemById(id: string): TranscriptItem | undefined
  /** Show a picture full size; focus goes back to `opener` when it closes. */
  openImage(image: ViewedImage, opener: HTMLElement | null): void
  /** Put text on the clipboard, and say whether it worked. */
  copy(text: string): Promise<boolean>
  /** Say something politely, once (a copy that worked, a regenerate that was refused). */
  announce(text: string): void
  /** Run the last reply again (`core/chats/regenerate.ts`). */
  regenerate(): void
  /** Called when `turnActive` or `regenerateTarget` may have changed. */
  subscribe(listener: () => void): () => void
  /** Whether a turn runs on this chat right now. */
  turnActive(): boolean
  /** The one reply that may be regenerated, or `null` where none may. */
  regenerateTarget(): string | null
}

const NOTHING = (): void => undefined

/** What a row is drawn with outside a chat screen (a test of one view, a gallery): copies, and nothing else. */
export const DETACHED_ITEM_HOST: ItemHost = {
  attachmentSrc: () => undefined,
  itemById: () => undefined,
  openImage: NOTHING,
  copy: text => writeClipboard(text),
  announce: NOTHING,
  regenerate: NOTHING,
  subscribe: () => NOTHING,
  turnActive: () => false,
  regenerateTarget: () => null
}

export const ItemHostContext = createContext<ItemHost>(DETACHED_ITEM_HOST)

export const useItemHost = (): ItemHost => useContext(ItemHostContext)
