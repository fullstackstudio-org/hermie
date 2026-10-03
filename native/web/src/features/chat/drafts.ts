/**
 * What the reader has typed in a chat and not sent, kept per chat.
 *
 * The words are in the browser's own store (`platform/key-value-store.ts`, under
 * this gateway's base path), so a reload, or leaving for another chat and coming
 * back, finds them where they were left. The key is not a `device.` key: a draft
 * is the signed-in person's, and a sign-out takes it away with the rest of what
 * is identity-bound.
 *
 * A store of its own rather than the chat store's `draft` field. That field is
 * written through the ingest (one commit per frame), and a text field bound to
 * it would hand every keystroke back a frame late; the composer keeps what is
 * typed in its own state and writes it here once the reader pauses.
 */
import type { WebKeyValueStore } from '../../platform/key-value-store'

export interface DraftStore {
  /** The unsent words of this chat, or an empty string. */
  read(chatKey: string): string
  /** Keep them; an empty text forgets the draft. */
  write(chatKey: string, text: string): void
}

/** The key one chat's draft is stored under (identity-bound: no `device.` prefix). */
export const draftKey = (chatKey: string): string => `draft.${chatKey}`

/** Drafts on the page's key-value store. */
export function createDraftStore(storage: Pick<WebKeyValueStore, 'getSync' | 'setSync' | 'deleteSync'>): DraftStore {
  return {
    read: chatKey => storage.getSync(draftKey(chatKey)) ?? '',
    write(chatKey, text) {
      if (text === '') {
        storage.deleteSync(draftKey(chatKey))
      } else {
        storage.setSync(draftKey(chatKey), text)
      }
    }
  }
}
