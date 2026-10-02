/**
 * A bot's conversations, drawn the way both the column (Task 7) and the sheet
 * show them: the group chat first, then the reader's own chats, a way to
 * start another one, and a link to the archive.
 *
 * Adopted from `ConversationsScreen`'s row — the loading state, the inline
 * rename, the two-step delete — and rewired to Task 4's list API
 * (`listBotConversations`, `selectConversation`, `startOwnChat`,
 * `renameOwnChat`, `deleteOwnChat`, `onConversationsChanged`) rather than the
 * ADR-0007 switch's `listConversations`/`chooseChat`. The switch itself is
 * untouched here and stops being drawn only in Task 10.
 *
 * One component rather than two, because a column and a sheet showing
 * different rows for the same bot is a bug reachable only by opening both at
 * once — which the sheet-host priority rules already prevent, but a shared
 * component makes it structurally impossible rather than merely untested.
 * Deliberately renders no `ScrollView` of its own: `ConversationSheet` puts it
 * inside `BottomSheet`'s own scroller, and the column will put it inside
 * whatever the regular shell scrolls.
 *
 * `canCreate === false` draws the group row and its note and nothing else —
 * no "Your chats", no "New chat" row, no archive link. Callers never mount
 * this component in that state at all (there is no entry point to reach it
 * from), so the branch below only ever runs in a test that asks the question
 * directly.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { Pressable, View } from 'react-native'

import { chatStrings } from '../../chat-ui/strings'
import { isOwnUnread, isUnread, useBotsStore } from '../../store/bots'
import { Button, Text, TextField } from '../../ui/primitives'
import { useTheme } from '../../ui/theme'
import { CONTROL_MIN_HEIGHT } from '../../ui/tokens'
import { useChatRuntime } from '../chats/ChatRuntime'
import { ConversationBusyError } from '../chats/chat-controller'
import { relativeEpoch } from '../cron/model'
import { ownChatActions, OWN_CHAT_LABEL_MAX, type ConversationList } from './conversation-list'
import { conversationKey, ownChatLabel, type Conversation } from './session-model'

/** Nothing loaded yet, something loaded, or the gateway would not say. */
export type ConversationListState =
  { kind: 'loading' } | { kind: 'ready'; list: ConversationList } | { kind: 'failed'; message: string }

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/**
 * One bot's conversation list, kept live.
 *
 * Loads on mount and on every bot change, and re-lists on
 * `onConversationsChanged` — after a `sessions.changed` sweep and after every
 * action this reads or writes takes. Shared by `ConversationListView` and by
 * `ChatHeader`'s own second line (`ChatScreen`), which is why it is exported
 * rather than kept private to the row list: both need the SAME answer to
 * "which conversation is the bot on, and what is it called", and two
 * independent reads of it are two chances to disagree for one frame.
 *
 * `enabled` (default `true`) skips the round trip entirely, and the listener,
 * while false — the state a gateway that named nobody stays in for as long as
 * `ChatScreen` reads it, so a `canCreate === false` chat costs no extra
 * `session.list` on every mount for a list nothing is going to draw.
 */
export function useConversationList(
  botName: string,
  enabled = true
): { state: ConversationListState; reload: () => Promise<void> } {
  const runtime = useChatRuntime()
  const controller = runtime?.controller
  const [state, setState] = useState<ConversationListState>({ kind: 'loading' })

  const reload = useCallback(async () => {
    if (!enabled) {
      return
    }

    if (!controller) {
      setState({ kind: 'failed', message: chatStrings.sessions.loadFailed })

      return
    }

    try {
      setState({ kind: 'ready', list: await controller.listBotConversations(botName) })
    } catch (error) {
      setState({ kind: 'failed', message: messageOf(error) })
    }
  }, [botName, controller, enabled])

  useEffect(() => {
    if (!enabled) {
      return
    }

    setState({ kind: 'loading' })
    void reload()
  }, [enabled, reload])

  useEffect(() => {
    if (!enabled) {
      return undefined
    }

    return controller?.onConversationsChanged(botName, () => void reload())
  }, [botName, controller, enabled, reload])

  return { state, reload }
}

/**
 * An own chat's display label — the reader's own words, or `firstChat`
 * ("My chat") for the bare lead nobody has renamed yet.
 *
 * The pure half (`ownChatLabel`) answers `''` for the bare lead because it has
 * no English word to reach for; this is the one place that supplies one, so
 * every surface that shows an own chat's name says the same thing for the
 * same title rather than each inventing its own fallback.
 */
export function ownChatDisplayLabel(title: string, lead: string): string {
  return ownChatLabel(title, lead) || chatStrings.conversations.firstChat
}

/** Which row, if any, has its inline editor or its confirm open, and what it said last. */
type RowMode =
  { kind: 'rename'; id: string; draft: string; error?: string } | { kind: 'confirm'; id: string; error?: string } | null

export interface ConversationListViewProps {
  botName: string
  /**
   * A row was opened or started successfully. The column (Task 7) has no use
   * for this; `ConversationSheet` closes on it.
   */
  onPicked?: () => void
  /** The footer's "All conversations" link, to the archive page. Absent hides the footer. */
  onOpenArchive?: () => void
  testID?: string
}

/** A small filled dot, the same shape whichever row it marks. */
function UnreadDot({ id, testID }: { id: string; testID: string }) {
  const theme = useTheme()

  return (
    <View
      accessibilityElementsHidden
      aria-hidden
      importantForAccessibility="no-hide-descendants"
      key={id}
      style={{ backgroundColor: theme.accent().fill, borderRadius: 5, height: 10, width: 10 }}
      testID={testID}
    />
  )
}

export function ConversationListView({
  botName,
  onPicked,
  onOpenArchive,
  testID = 'conversation-list-view'
}: ConversationListViewProps) {
  const theme = useTheme()
  const runtime = useChatRuntime()
  const bot = useBotsStore(state => state.byName[botName])
  const lastSeen = useBotsStore(state => state.lastSeen)
  const seenCounts = useBotsStore(state => state.seenCounts)
  const byNameForUnread = useBotsStore(state => state.byName)
  const { state, reload } = useConversationList(botName)
  const [mode, setMode] = useState<RowMode>(null)
  const [notice, setNotice] = useState('')
  const controller = runtime?.controller
  const lead = runtime?.userChats?.title ?? ''

  // A rename or delete that is mid-flight is not one Return or a second tap
  // should restart; `busy` names the row so the buttons can disable themselves.
  const busy = useRef<string | null>(null)

  const groupUnread = isUnread({ byName: byNameForUnread, lastSeen }, botName)

  if (state.kind === 'loading') {
    return (
      <View style={{ padding: theme.space.lg }} testID={testID}>
        <Text color="textFaint" testID={`${testID}-loading`} variant="preview">
          {chatStrings.sessions.loading}
        </Text>
      </View>
    )
  }

  if (state.kind === 'failed') {
    return (
      <View style={{ padding: theme.space.lg }} testID={testID}>
        <Text color="dangerText" testID={`${testID}-failed`} variant="preview">
          {state.message}
        </Text>
      </View>
    )
  }

  const { list } = state
  const groupId = list.group?.id ?? bot?.canonical?.id ?? 'group'

  const openGroup = () => {
    if (!bot || !controller) {
      return
    }

    void controller
      .selectConversation(bot, null)
      .then(() => {
        onPicked?.()
        void reload()
      })
      .catch(error =>
        setNotice(
          error instanceof ConversationBusyError ? chatStrings.sessions.busy : chatStrings.conversations.openFailed
        )
      )
  }

  const openOwn = (conversation: Conversation) => {
    if (!bot || !controller) {
      return
    }

    void controller
      .selectConversation(bot, conversation)
      .then(() => {
        onPicked?.()
        void reload()
      })
      .catch(error =>
        setNotice(
          error instanceof ConversationBusyError ? chatStrings.sessions.busy : chatStrings.conversations.openFailed
        )
      )
  }

  const startNew = () => {
    if (!bot || !controller || busy.current) {
      return
    }

    busy.current = 'new-chat'
    void controller
      .startOwnChat(bot, {})
      .then(() => {
        busy.current = null
        onPicked?.()
        void reload()
      })
      .catch(error => {
        busy.current = null
        setNotice(
          error instanceof ConversationBusyError ? chatStrings.sessions.busy : chatStrings.conversations.newChatFailed
        )
      })
  }

  const commitRename = (conversation: Conversation, draft: string) => {
    if (!bot || !controller || busy.current) {
      return
    }

    busy.current = conversation.id
    void controller
      .renameOwnChat(bot, conversation.id, draft)
      .then(() => {
        busy.current = null
        setMode(null)
        void reload()
      })
      .catch(error => {
        busy.current = null
        setMode({ kind: 'rename', id: conversation.id, draft, error: messageOf(error) })
      })
  }

  const confirmDelete = (conversation: Conversation) => {
    if (!bot || !controller || busy.current) {
      return
    }

    busy.current = conversation.id
    void controller
      .deleteOwnChat(bot, conversation.id)
      .then(() => {
        busy.current = null
        setMode(null)
        void reload()
      })
      .catch(error => {
        busy.current = null
        setMode({
          kind: 'confirm',
          id: conversation.id,
          error: error instanceof ConversationBusyError ? chatStrings.sessions.busy : messageOf(error)
        })
      })
  }

  return (
    <View style={{ gap: theme.space.lg }} testID={testID}>
      {notice ? (
        <Text color="textMuted" testID={`${testID}-notice`} variant="preview">
          {notice}
        </Text>
      ) : null}

      {/*
        The group chat. Always first, never renamed or deleted from here —
        `ownChatActions` answers an empty list for every kind but `mine`, and
        this row is drawn from `list.group`/the roster rather than from that
        list at all, so there is no branch of code that could put buttons on it.
      */}
      <Pressable accessibilityRole="button" onPress={openGroup} testID={`${testID}-row-${groupId}`}>
        <View style={{ alignItems: 'center', flexDirection: 'row', gap: theme.space.sm }}>
          <View style={{ flex: 1, gap: theme.space.xs }}>
            <Text numberOfLines={1} variant="name">
              {chatStrings.conversations.groupChat}
            </Text>
            <Text color="textFaint" numberOfLines={1} variant="micro">
              {chatStrings.sessions.sharedNote}
            </Text>
          </View>
          {groupUnread ? <UnreadDot id={groupId} testID={`${testID}-unread-${groupId}`} /> : null}
        </View>
      </Pressable>

      {list.canCreate ? (
        <View style={{ gap: theme.space.md }}>
          <Text color="textFaint" variant="micro">
            {chatStrings.conversations.yourChats.toUpperCase()}
          </Text>

          {list.own.length === 0 ? (
            <Text color="textFaint" testID={`${testID}-empty`} variant="preview">
              {chatStrings.conversations.yoursEmpty}
            </Text>
          ) : (
            list.own.map(conversation => {
              const key = conversationKey(botName, conversation.id)
              const unread = isOwnUnread({ seenCounts }, key, conversation.messageCount)
              const renaming = mode?.kind === 'rename' && mode.id === conversation.id
              const confirming = mode?.kind === 'confirm' && mode.id === conversation.id
              const actions = ownChatActions(conversation)
              const label = ownChatDisplayLabel(conversation.title, lead)

              return (
                <View key={conversation.id} style={{ gap: theme.space.xs }}>
                  <Pressable
                    accessibilityRole="button"
                    disabled={renaming || confirming}
                    onPress={() => openOwn(conversation)}
                    testID={`${testID}-row-${conversation.id}`}
                  >
                    <View style={{ alignItems: 'center', flexDirection: 'row', gap: theme.space.sm }}>
                      <View style={{ flex: 1, gap: theme.space.xs }}>
                        <Text numberOfLines={1} variant="name">
                          {label}
                        </Text>
                        {conversation.preview ? (
                          <Text color="textMuted" numberOfLines={1} variant="preview">
                            {conversation.preview}
                          </Text>
                        ) : null}
                        {conversation.lastActive ? (
                          <Text color="textFaint" variant="micro">
                            {relativeEpoch(conversation.lastActive) ?? ''}
                          </Text>
                        ) : null}
                      </View>
                      {unread ? (
                        <UnreadDot id={conversation.id} testID={`${testID}-unread-${conversation.id}`} />
                      ) : null}
                    </View>
                  </Pressable>

                  {renaming ? (
                    <View style={{ gap: theme.space.xs }}>
                      <TextField
                        accessibilityLabel={chatStrings.conversations.renameLabel}
                        autoFocus
                        maxLength={OWN_CHAT_LABEL_MAX}
                        onChangeText={draft => setMode({ kind: 'rename', id: conversation.id, draft })}
                        onSubmitEditing={() => commitRename(conversation, mode.draft)}
                        testID={`${testID}-rename-${conversation.id}`}
                        value={mode.draft}
                      />
                      {mode.error ? (
                        <Text color="dangerText" testID={`${testID}-rename-error-${conversation.id}`} variant="micro">
                          {mode.error}
                        </Text>
                      ) : null}
                      <View style={{ flexDirection: 'row', gap: theme.space.md }}>
                        <Button
                          onPress={() => commitRename(conversation, mode.draft)}
                          title={chatStrings.sessions.rename}
                        />
                        <Button onPress={() => setMode(null)} title={chatStrings.sessions.cancel} />
                      </View>
                    </View>
                  ) : null}

                  {confirming ? (
                    <View style={{ gap: theme.space.xs }}>
                      <Text color="dangerText" variant="preview">
                        {chatStrings.sessions.deleteBody(label)}
                      </Text>
                      {mode.error ? (
                        <Text color="dangerText" testID={`${testID}-delete-error-${conversation.id}`} variant="micro">
                          {mode.error}
                        </Text>
                      ) : null}
                      <View style={{ flexDirection: 'row', gap: theme.space.md }}>
                        <Button
                          onPress={() => confirmDelete(conversation)}
                          testID={`${testID}-delete-confirm-${conversation.id}`}
                          title={chatStrings.sessions.deleteConfirm}
                          variant="danger"
                        />
                        <Button onPress={() => setMode(null)} title={chatStrings.sessions.cancel} />
                      </View>
                    </View>
                  ) : null}

                  {renaming || confirming ? null : (
                    <View style={{ flexDirection: 'row', gap: theme.space.md }}>
                      {actions.includes('rename') ? (
                        <Pressable
                          accessibilityRole="button"
                          onPress={() => setMode({ kind: 'rename', id: conversation.id, draft: label })}
                          style={{ justifyContent: 'center', minHeight: CONTROL_MIN_HEIGHT }}
                          testID={`${testID}-rename-start-${conversation.id}`}
                        >
                          <Text color="accentText" variant="preview">
                            {chatStrings.sessions.rename}
                          </Text>
                        </Pressable>
                      ) : null}
                      {actions.includes('delete') ? (
                        <Pressable
                          accessibilityRole="button"
                          onPress={() => setMode({ kind: 'confirm', id: conversation.id })}
                          style={{ justifyContent: 'center', minHeight: CONTROL_MIN_HEIGHT }}
                          testID={`${testID}-delete-start-${conversation.id}`}
                        >
                          <Text color="dangerText" variant="preview">
                            {chatStrings.sessions.delete}
                          </Text>
                        </Pressable>
                      ) : null}
                    </View>
                  )}
                </View>
              )
            })
          )}

          <Pressable accessibilityRole="button" onPress={startNew} testID={`${testID}-new-chat`}>
            <Text color="accentText" variant="preview">
              {chatStrings.conversations.newChat}
            </Text>
          </Pressable>
        </View>
      ) : null}

      {list.canCreate && onOpenArchive ? (
        <Pressable accessibilityRole="button" onPress={onOpenArchive} testID={`${testID}-archive`}>
          <Text color="accentText" variant="preview">
            {chatStrings.conversations.allConversations}
          </Text>
        </Pressable>
      ) : null}
    </View>
  )
}
