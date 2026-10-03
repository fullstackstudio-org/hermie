/**
 * The id a screen compares a row's author with to tell the reader's own messages
 * from a colleague's: the reader's own (`ownAuthorStore`, from `/api/auth/me`), but
 * only on a gateway that vouches for the authors on its rows
 * (`gateway.capabilities.per_message_author`, `rowAuthorsTrusted`). Without that an
 * author on a row is not the gateway's word, and nothing may be drawn as somebody
 * else's on the strength of it: `undefined`, so every row reads as the reader's
 * own, as before authors existed. The native apps' `GatewaySession.ownAuthorID`.
 */
import { useStore } from 'zustand'

import { ownAuthorId, ownAuthorStore } from '../../core/chats/own-author'
import { rowAuthorsTrusted, sessionStatusStore } from '../../state/session-status'

export function useOwnAuthorId(): string | undefined {
  const id = useStore(ownAuthorStore, ownAuthorId)
  const trusted = useStore(sessionStatusStore, rowAuthorsTrusted)

  return trusted ? id : undefined
}
