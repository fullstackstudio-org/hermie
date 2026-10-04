/**
 * What every item view needs and none of them should be handed one by one: a
 * row's props are `(item, presentation)` so that a row is memoised on exactly
 * `(id, version, presentation)`, and the few things that are the chat's and not
 * the row's come through a context whose value does not change while the chat is
 * open.
 */
import { createContext, useContext } from 'react'

export interface ItemContextValue {
  /** The bot's display name, for the name a reply is announced under. */
  botName: string
  /** The gateway's base URL: where a Markdown image resolves. */
  gatewayBaseUrl: string | undefined
  /** The chat's bot, which is its profile: what a shared file's address names as `?profile=`. */
  profile?: string | undefined
  /** The reader's own author id, when the gateway said who they are. */
  ownAuthorId: string | undefined
  /**
   * The transcript is the group chat: a row whose stamped author is not the
   * reader's is somebody else's and is drawn as theirs. Everywhere else every
   * `user` row is the reader's own (HERM-83, D6).
   */
  groupChat: boolean
  /**
   * The chat's key in the chat store, for the rows that read what changes
   * without their item changing (a fan-out's children, `SubagentGroupCard`).
   */
  chatKey?: string | undefined
}

export const ItemContext = createContext<ItemContextValue>({
  botName: '',
  gatewayBaseUrl: undefined,
  ownAuthorId: undefined,
  groupChat: false
})

export const useItemContext = (): ItemContextValue => useContext(ItemContext)
