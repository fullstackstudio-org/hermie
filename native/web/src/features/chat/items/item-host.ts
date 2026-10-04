/**
 * What a row, and the transcript's one message menu (`MessageMenuLayer`), can ask
 * the chat screen for: a picture to load for an attachment, the image viewer, a
 * message by id, a copy, the last reply again, a turn put back in the composer
 * and a fork of the conversation.
 *
 * Its own context beside `ItemContext`, and for the same reason: rows are
 * memoised on `(id, version, presentation)`, so whatever else they read has to
 * hold still while the chat is open. The host is one object per screen whose
 * identity never changes; what does change (whether a turn runs, which reply
 * may be regenerated) is read through `subscribe` and a snapshot, so only a menu
 * that is open re-renders when it moves, never a settled row.
 *
 * Nothing here talks to the gateway. The screen does, behind `regenerate` and
 * `branch`.
 */
import type { TranscriptItem } from '@hermie/transcript'
import { createContext, useContext } from 'react'

import type { LoadedAttachment } from '../../../core/chats/attachment-fetch'
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
  /**
   * Fetch what an attachment reference names through the gateway's own files routes
   * (`core/chats/attachment-fetch.ts`): a picture the browser can draw, a file to save, or `null` when
   * the gateway does not hand it over. Absent where the host has no gateway to ask (a test of one view,
   * a gallery): a chip is then not a control.
   */
  loadAttachment?(reference: string): Promise<LoadedAttachment | null>
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
  /**
   * Put one of the reader's own turns back in the composer, its attachments as references (`core/chats/edit-resend.ts`).
   * The turn in the conversation is left where it is: sending starts a new one.
   */
  editResend(text: string, attachments: readonly string[]): void
  /** Fork the conversation at this row, named after `text`, and open the branch (`core/chats/branch-here.ts`). */
  branch(id: string, text: string): void
  /** Called when `turnActive`, `regenerateTarget`, `editTarget`, `canBranch` or `readingIds` may have changed. */
  subscribe(listener: () => void): () => void
  /** Whether a turn runs on this chat right now. */
  turnActive(): boolean
  /** The one reply that may be regenerated, or `null` where none may. */
  regenerateTarget(): string | null
  /** The reader's newest turn, when it may be put back in the composer, or `null` where none may. */
  editTarget(): string | null
  /** Whether this chat can be forked at a row: not a past conversation or a branch, not while a request is open. */
  canBranch(): boolean
  /**
   * Whether a reply can be read aloud here: the browser can speak and the microphone is not open. Absent where the
   * host has no speaker (a gallery): the menu has no such line.
   */
  canReadAloud?(): boolean
  /** The rows being read aloud or waiting to be, speaking one first; the same array until it changes. */
  readingIds?(): readonly string[]
  /** "Read aloud" and "Stop reading" in one: say this row's Markdown, or stop saying it. */
  toggleReadAloud?(id: string, markdown: string): void
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
  editResend: NOTHING,
  branch: NOTHING,
  subscribe: () => NOTHING,
  turnActive: () => false,
  regenerateTarget: () => null,
  editTarget: () => null,
  canBranch: () => false
}

export const ItemHostContext = createContext<ItemHost>(DETACHED_ITEM_HOST)

export const useItemHost = (): ItemHost => useContext(ItemHostContext)
