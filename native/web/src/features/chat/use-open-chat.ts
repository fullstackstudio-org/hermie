/**
 * Opening the chat a route names, once the connection can carry it, and leaving
 * it again.
 *
 * When it opens is the part worth stating. Opening ends in `session.resume`, and
 * a JSON-RPC call on a socket that is still dialling rejects at once: it does not
 * queue. Opening on mount therefore failed outright on a cold start or in the
 * middle of a reconnect, with a "gateway not connected" that nobody should have
 * had to read. So the open waits for the connection to be `ready` and runs on the
 * transition to it, which also covers every reconnect for free (the Expo hook's
 * rule, `useChat` there).
 *
 * What it opens:
 *
 *  - `#/chat/<bot>`: the bot's chat (`openChat`, `follow: true`: the reader
 *    opening the screen is the "next open" a conversation chosen on another
 *    device waits for). It is held in the chat store under the bot's name.
 *  - `#/chat/<bot>/s/<session>`: `openSession` says where the id belongs. One of
 *    the reader's own chats or the group chat becomes what the bot is on, and is
 *    held under the bot's name like the first. A branch or a past conversation
 *    opens read-only (`openConversation`) under `bot#<session>`; reading it marks
 *    nothing read, because it is not what arrived in the bot's chat.
 *
 * Leaving writes the transcript to the cache and marks the chat read
 * (`closeChat`). It does not detach: a teammate bot's message has to keep
 * arriving. A chat that never opened is not left, so a StrictMode double
 * mount cannot mark an unread chat read.
 */
import { useCallback, useEffect, useRef, useState } from 'react'

import type { Bot } from '../../state/bots'
import { chatsStore } from '../../state/chats'
import { conversationKey } from '../../core/sessions/session-model'
import type { ChatScreenController, ChatSessionRuntime } from './chat-runtime'

export interface UseOpenChatOptions {
  runtime: ChatSessionRuntime | null
  /** The bot of the route, as the roster holds it; `undefined` while the roster is unread or does not list it. */
  record: Bot | undefined
  bot: string
  session: string | undefined
  /** The connection is `ready`. */
  ready: boolean
}

export interface OpenChat {
  /** Where the chat is held in the chat store; `undefined` until the route's chat is known. */
  key: string | undefined
  /** The route's chat is a past conversation or a branch: it can be read and not answered. */
  viewer: boolean
  /** Why the open failed, while it has. */
  error: string | null
  /** Open again after a failure. */
  retry: () => void
}

interface Attempt {
  bot: string
  session: string | undefined
  controller: ChatScreenController
  round: number
  failed: boolean
}

interface Opened {
  bot: string
  session: string | undefined
  key: string
  viewer: boolean
  controller: ChatScreenController
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

export function useOpenChat({ runtime, record, bot, session, ready }: UseOpenChatOptions): OpenChat {
  const controller = runtime?.controller
  const [opened, setOpened] = useState<Opened | null>(null)
  const [failure, setFailure] = useState<{ bot: string; session: string | undefined; message: string } | null>(null)
  const [round, setRound] = useState(0)
  const attempt = useRef<Attempt | null>(null)
  // What the leave-effect needs, kept apart from state so it reads the latest and re-runs nothing.
  const openedRef = useRef<Opened | null>(null)

  useEffect(() => {
    if (!controller || !record || !ready) {
      return
    }

    const previous = attempt.current

    // The same chat on the same connection, opened and not failed: nothing to do.
    if (
      previous &&
      previous.bot === bot &&
      previous.session === session &&
      previous.controller === controller &&
      previous.round === round &&
      !previous.failed
    ) {
      return
    }

    const current: Attempt = { bot, session, controller, round, failed: false }

    attempt.current = current
    setFailure(null)

    // An answer that arrives after the route moved on, or after this attempt was replaced, is not for this screen.
    const stillCurrent = (): boolean => attempt.current === current

    void (async () => {
      try {
        let key = bot
        let viewer = false

        if (session === undefined) {
          await controller.openChat(record, { follow: true })
        } else {
          const where = await controller.openSession(record, session)

          if (where.kind === 'viewer') {
            key = conversationKey(bot, session)
            viewer = true
            await controller.openConversation(record, session)
          } else if (!chatsStore.getState().chats[bot]) {
            await controller.openChat(record)
          }
        }

        if (stillCurrent()) {
          const next: Opened = { bot, session, key, viewer, controller }

          openedRef.current = next
          setOpened(next)
        }
      } catch (caught) {
        current.failed = true

        if (stillCurrent()) {
          setFailure({ bot, session, message: messageOf(caught) })
        }
      }
    })()
  }, [bot, controller, ready, record, round, session])

  // Leaving the screen (or moving to another chat): write the cache and mark the chat read.
  useEffect(
    () => () => {
      const was = openedRef.current

      openedRef.current = null
      attempt.current = null

      if (was && !was.viewer) {
        void was.controller.closeChat(was.bot).catch(() => undefined)
      }
    },
    [bot, controller, session]
  )

  const settled = opened && opened.bot === bot && opened.session === session ? opened : null
  const own = session === undefined

  return {
    // The bot's own chat is read at once: a chat opened before paints before this one has answered.
    key: own ? bot : settled?.key,
    viewer: settled?.viewer ?? false,
    error: failure && failure.bot === bot && failure.session === session ? failure.message : null,
    retry: useCallback(() => setRound(current => current + 1), [])
  }
}
