/**
 * One conversation that is NOT the bot's Bot Chat, on screen.
 *
 * The same transcript machinery, under a different key. `ChatController`'s
 * `openConversation` does `chats.ensure` with the stored id, `session.resume`,
 * the same history load and the same replay — all of it under
 * `conversationKey(bot, storedId)` rather than under the bot's name, so the
 * canonical chat's own transcript is untouched and the two never overwrite each
 * other. See `features/sessions/session-model.ts` for why a `#` cannot collide
 * with a profile name.
 *
 * ## Why there is no composer
 *
 * A branch is a real, resumable session and the gateway would accept a prompt on
 * it. What it would NOT accept is the consequence: ADR-0007's whole claim is
 * that a bot has one chat, and a second composer is how an app quietly grows a
 * second one — two places to talk to the same bot, two unread counts, two
 * notification streams, and a reader who cannot answer "where did I say that".
 *
 * So this reads. To CARRY ON in a branch, the reader makes it the Bot Chat from
 * the Conversations page, which swaps the two rather than running both. That is
 * the same door `/new` uses and it keeps the invariant exactly where it was.
 *
 * ## The banner
 *
 * One line at the top saying what this is and how to get back, because a
 * transcript of the same bot in the same bubbles with the same header is
 * otherwise indistinguishable from the chat the reader thinks they are in —
 * which is the one way this screen could cost somebody something.
 */
import { useEffect, useMemo, useState } from 'react'
import { Pressable, View } from 'react-native'

import { chatStrings } from '../../chat-ui/strings'
import { TranscriptList } from '../../chat-ui'
import { CANONICAL_CHAT_TITLE } from '../bots/bots-controller'
import { useBotsStore, useBotDisplayName } from '../../store/bots'
import { useChatsStore } from '../../store/chats'
import { useChatView } from '../../store/settings'
import { PageChrome, type PageChromeBack } from '../../ui/chrome'
import { Screen, Text } from '../../ui/primitives'
import { useTheme } from '../../ui/theme'
import { CONTROL_MIN_HEIGHT } from '../../ui/tokens'
import { useChatRuntime } from '../chats/ChatRuntime'
import { conversationKey } from './session-model'
import { itemsVersion, visibleItems } from '@hermie/transcript'

export interface ConversationViewScreenProps {
  botName: string
  /** The STORED id — what a listing hands out and what a resume takes. */
  storedId: string
  /** Back to the bot's own Bot Chat, which is what the banner offers. */
  onOpenChat?: (botName: string) => void
  /**
   * The way out, LABELLED by whoever pushed this page.
   *
   * A label rather than a bare `onBack`, because this page is reached from two
   * different places: the bot's list of other conversations, and a notice in
   * the chat itself that names one branch. It used to say "Conversations"
   * either way, which on the second path is a button that names a page the
   * reader was never on and does not return to.
   */
  back?: PageChromeBack
}

export function ConversationViewScreen({ botName, back, onOpenChat, storedId }: ConversationViewScreenProps) {
  const theme = useTheme()
  const runtime = useChatRuntime()
  const bot = useBotsStore(state => state.byName[botName])
  const display = useBotDisplayName(botName)
  const view = useChatView(botName)
  const key = conversationKey(botName, storedId)
  const chat = useChatsStore(state => state.chats[key])
  const [failed, setFailed] = useState('')
  const [chromeHeight, setChromeHeight] = useState(0)
  const controller = runtime?.controller

  useEffect(() => {
    if (!controller || !bot) {
      return
    }

    void controller.openConversation(bot, storedId).catch((error: unknown) => {
      setFailed(error instanceof Error ? error.message : String(error))
    })
  }, [bot, controller, storedId])

  /*
    The same projection the chat screen uses, with the same view settings. A
    branch drawn under different rules from the conversation it came out of
    would read as a different bot.
  */
  const version = chat ? itemsVersion(chat) : 0
  const items = useMemo(
    () => (chat ? visibleItems(chat, view) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [version, key, view.level, view.showBotToBot, view.showThinking]
  )

  return (
    <Screen testID="conversation-view">
      {/* Clears `PageChrome`, which is absolutely positioned and a sibling. */}
      <View style={{ height: chromeHeight }} />

      {/*
        The banner, and it is a ROW rather than a title: the two halves are a
        statement and a way out, and putting the way out anywhere else would
        make a reader who has realised they are in the wrong place go looking
        for it.
      */}
      <View
        style={{
          alignItems: 'center',
          backgroundColor: theme.elevation.e3c,
          flexDirection: 'row',
          gap: theme.space.sm,
          minHeight: CONTROL_MIN_HEIGHT,
          paddingHorizontal: theme.space.lg
        }}
        testID="conversation-view-banner"
      >
        <Text color="textMuted" numberOfLines={1} style={{ flex: 1 }} variant="preview">
          {chatStrings.sessions.branchOf(CANONICAL_CHAT_TITLE)}
        </Text>
        <Pressable
          accessibilityRole="button"
          onPress={() => (onOpenChat ? onOpenChat(botName) : back?.onPress())}
          testID="conversation-view-back-to-main"
        >
          <Text color="accentText" variant="preview">
            {chatStrings.sessions.backToMain}
          </Text>
        </Pressable>
      </View>

      {failed ? (
        <Text
          color="dangerText"
          style={{ padding: theme.space.lg }}
          testID="conversation-view-failed"
          variant="preview"
        >
          {failed}
        </Text>
      ) : null}

      <TranscriptList items={items} />

      <PageChrome {...(back ? { back } : {})} onHeightChange={setChromeHeight} title={display ?? botName} />
    </Screen>
  )
}
