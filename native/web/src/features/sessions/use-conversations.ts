/**
 * One bot's conversations, as `classifyConversations` groups them, kept fresh.
 *
 * Read with `controller.listConversations` (one `session.list` of the profile,
 * hidden rows included, because the Bot Chat is hidden) once the connection is
 * `ready`, again on every return to `ready` (a JSON-RPC call on a socket that is
 * still dialling rejects at once, the same reason `use-open-chat.ts` waits), and
 * again whenever the controller says the bot's list may have changed
 * (`onConversationsChanged`: a `sessions.changed` sweep, or an action it took).
 *
 * `reload` is what every action on the page ends with. The page re-reads rather
 * than patching its list, because three of the four actions change something the
 * GATEWAY owns (a title it may have refused, a row it deleted, a Bot Chat that
 * moved) and a list that guessed at the outcome is a list that lies about a
 * gateway it can simply ask (the Expo page's rule).
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { useStore } from 'zustand'

import type { ConversationGroups } from '../../core/sessions/session-model'
import { connectionStore } from '../../state/connection'
import type { ChatScreenController } from '../chat/chat-runtime'

/** Nothing read yet, a list, or why it could not be read. */
export type ConversationsState =
  { kind: 'loading' } | { kind: 'ready'; groups: ConversationGroups } | { kind: 'failed'; message: string }

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

export function useConversations(
  bot: string,
  controller: ChatScreenController | undefined
): { state: ConversationsState; reload: () => Promise<void> } {
  const ready = useStore(connectionStore, state => state.status === 'ready')
  const [state, setState] = useState<ConversationsState>({ kind: 'loading' })
  // Only the newest read may write: an answer that arrives after a newer read started is stale.
  const round = useRef(0)

  const reload = useCallback(async () => {
    if (!controller) {
      return
    }

    const mine = ++round.current

    try {
      const groups = await controller.listConversations(bot)

      if (round.current === mine) {
        setState({ kind: 'ready', groups })
      }
    } catch (error) {
      if (round.current === mine) {
        setState({ kind: 'failed', message: messageOf(error) })
      }
    }
  }, [bot, controller])

  useEffect(() => {
    if (ready) {
      void reload()
    }
  }, [ready, reload])

  useEffect(() => controller?.onConversationsChanged(bot, () => void reload()), [bot, controller, reload])

  return { state, reload }
}
