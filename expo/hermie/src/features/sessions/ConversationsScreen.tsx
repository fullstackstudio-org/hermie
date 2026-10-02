/**
 * Every conversation one bot has, on one page.
 *
 * ADR-0007 gives a bot exactly ONE chat and this page does not change that. What
 * it does is admit that the one chat has a past and can have branches, and give
 * the reader somewhere to see them — which is the half of the model that was
 * missing rather than a second chat list.
 *
 * ## Three groups, and why the first one is different from the other two
 *
 * **Bot Chat (current)** is the canonical session. It is drawn, it is named, and
 * it carries NO ACTIONS AT ALL. That is not a check made here; it is
 * `conversationActions` answering an empty list for a row whose `kind` is
 * `canonical` (see `session-model.ts`). A surface that renders whatever that
 * function returns cannot offer Delete on the one chat that may never be
 * deleted, because there is no branch of code in which it would.
 *
 * **Branches** are the conversations forked out of it, and **Past conversations**
 * are the retired `Bot Chat · <date time>` rows plus any other visible session
 * the profile has. Both carry the same four actions, because both are ordinary
 * sessions and the grouping is presentational — a branch that gets renamed out
 * of its prefix moves group and loses nothing.
 *
 * ## Why the destructive line is a two-step and the rename is not
 *
 * `session.delete` removes a conversation from the gateway and there is no undo
 * anywhere in this app or upstream, so it asks — inline, on the row, rather than
 * in a modal, because a modal here would be the second sheet in a stack that is
 * already two deep on a phone. Rename cannot lose anything (the gateway's own
 * refusals are the only way it fails, and they are reported), so it commits on
 * Return.
 *
 * ## "Make this the Bot Chat" is a swap, not a promotion
 *
 * It runs the exact machinery `/new` retires with, in the same load-bearing
 * order, because the title is the registry key and two rows cannot wear it at
 * once. `ChatController.adoptAsCanonical` owns that sequence and its rollback;
 * this page owns saying what happened.
 */
import { useCallback, useEffect, useState } from 'react'
import { Pressable, ScrollView, View } from 'react-native'

import { chatStrings } from '../../chat-ui/strings'
import { useBotsStore, useBotDisplayName } from '../../store/bots'
import { useMyChat } from '../../store/chat-layout'
import { PageChrome, usePageScroll } from '../../ui/chrome'
import { Button, Screen, Text, TextField } from '../../ui/primitives'
import { useTheme } from '../../ui/theme'
import { CONTROL_MIN_HEIGHT } from '../../ui/tokens'
import { useChatRuntime } from '../chats/ChatRuntime'
import { relativeEpoch } from '../cron/model'
import { ChatChoiceRow } from '../user-chats'
import { conversationActions, type Conversation, type ConversationGroups } from './session-model'

export interface ConversationsScreenProps {
  botName: string
  /** Open one of them. Absent where the shell has nowhere to put a transcript. */
  onOpenConversation?: (botName: string, storedId: string) => void
  onBack?: () => void
}

/** Nothing loaded yet, something loaded, or the gateway would not say. */
type LoadState =
  { kind: 'loading' } | { kind: 'ready'; groups: ConversationGroups } | { kind: 'failed'; message: string }

/** Which row, if any, has its inline editor or its confirm open. */
type RowMode = { kind: 'rename'; id: string; draft: string } | { kind: 'confirm'; id: string } | null

export function ConversationsScreen({ botName, onBack, onOpenConversation }: ConversationsScreenProps) {
  const theme = useTheme()
  const runtime = useChatRuntime()
  const display = useBotDisplayName(botName)
  const mine = useMyChat(botName)
  const bot = useBotsStore(store => store.byName[botName])
  const [state, setState] = useState<LoadState>({ kind: 'loading' })
  const [mode, setMode] = useState<RowMode>(null)
  const [notice, setNotice] = useState<string>('')
  const [chromeHeight, setChromeHeight] = useState(0)
  const controller = runtime?.controller
  const userChats = runtime?.userChats ?? null

  const load = useCallback(async () => {
    if (!controller) {
      setState({ kind: 'failed', message: chatStrings.sessions.loadFailed })

      return
    }

    try {
      setState({ kind: 'ready', groups: await controller.listConversations(botName) })
    } catch (error) {
      setState({ kind: 'failed', message: messageOf(error) })
    }
  }, [botName, controller])

  useEffect(() => {
    void load()
  }, [load])

  /**
   * Every action ends the same way: say what happened, then re-read.
   *
   * Re-reading rather than patching the list in place, because three of the four
   * actions change something the GATEWAY owns — a title it may have refused, a
   * row it has deleted, a canonical chat that has moved — and a local patch that
   * guessed at the outcome is how a list starts lying about a gateway it can
   * simply ask.
   */
  const run = useCallback(
    async (work: () => Promise<string>) => {
      try {
        setNotice(await work())
      } catch (error) {
        setNotice(messageOf(error))
      }

      setMode(null)
      await load()
    },
    [load]
  )

  const groups = state.kind === 'ready' ? state.groups : null
  const pageScroll = usePageScroll(chromeHeight)

  return (
    <Screen testID="conversations-screen">
      <ScrollView
        {...pageScroll}
        contentContainerStyle={[{ gap: theme.space.lg, padding: theme.space.lg }, pageScroll.contentContainerStyle]}
      >
        <Text color="textMuted" variant="preview">
          {display}
        </Text>

        {notice ? (
          <Text color="textMuted" testID="conversations-notice" variant="preview">
            {notice}
          </Text>
        ) : null}

        {state.kind === 'loading' ? (
          <Text color="textFaint" testID="conversations-loading" variant="preview">
            {chatStrings.sessions.loading}
          </Text>
        ) : null}

        {state.kind === 'failed' ? (
          <Text color="dangerText" testID="conversations-failed" variant="preview">
            {state.message}
          </Text>
        ) : null}

        {/*
          The switch sits ABOVE the groups, because it decides which of them the
          bot's row in the chat list opens — it is not one of the conversations,
          it is the question the list below is an answer to.
        */}
        <ChatChoiceRow
          available={Boolean(controller && bot && userChats?.available)}
          choice={mine ? 'mine' : 'shared'}
          onChoose={async choice => {
            if (!bot) {
              return
            }

            await controller?.chooseChat(bot, choice)
            await load()
          }}
          onFailed={setNotice}
          testID="conversations-choice"
        />

        {groups?.mine ? (
          <Group title={chatStrings.sessions.mineGroup}>
            <Row
              conversation={groups.mine}
              mode={mode}
              onAdopt={() => undefined}
              onDelete={() => undefined}
              onOpen={() => onOpenConversation?.(botName, groups.mine?.id ?? '')}
              onRename={() => undefined}
              setMode={setMode}
            />
          </Group>
        ) : null}

        {groups?.canonical ? (
          <Group title={chatStrings.sessions.canonical}>
            <Row
              conversation={groups.canonical}
              mode={mode}
              onAdopt={() => undefined}
              onDelete={() => undefined}
              onOpen={() => undefined}
              onRename={() => undefined}
              setMode={setMode}
            />
          </Group>
        ) : null}

        {groups?.branches.length ? (
          <Group title={chatStrings.sessions.branches}>
            {groups.branches.map(conversation => (
              <Row
                conversation={conversation}
                key={conversation.id}
                mode={mode}
                onAdopt={() =>
                  void run(async () => {
                    await controller?.adoptAsCanonical(botName, conversation.id)

                    return chatStrings.sessions.adopt
                  })
                }
                onDelete={() =>
                  void run(async () => {
                    await controller?.deleteConversation(botName, conversation.id)

                    return chatStrings.sessions.delete
                  })
                }
                onOpen={() => onOpenConversation?.(botName, conversation.id)}
                onRename={title =>
                  void run(async () => controller?.renameConversation(botName, conversation.id, title) ?? title)
                }
                setMode={setMode}
              />
            ))}
          </Group>
        ) : null}

        {groups ? (
          <Group title={chatStrings.sessions.past}>
            {groups.past.length ? (
              groups.past.map(conversation => (
                <Row
                  conversation={conversation}
                  key={conversation.id}
                  mode={mode}
                  onAdopt={() =>
                    void run(async () => {
                      await controller?.adoptAsCanonical(botName, conversation.id)

                      return chatStrings.sessions.adopt
                    })
                  }
                  onDelete={() =>
                    void run(async () => {
                      await controller?.deleteConversation(botName, conversation.id)

                      return chatStrings.sessions.delete
                    })
                  }
                  onOpen={() => onOpenConversation?.(botName, conversation.id)}
                  onRename={title =>
                    void run(async () => controller?.renameConversation(botName, conversation.id, title) ?? title)
                  }
                  setMode={setMode}
                />
              ))
            ) : (
              <Text color="textFaint" testID="conversations-past-empty" variant="preview">
                {chatStrings.sessions.pastEmpty}
              </Text>
            )}
          </Group>
        ) : null}
      </ScrollView>

      <PageChrome
        {...(onBack ? { back: { label: display ?? botName, onPress: onBack } } : {})}
        onHeightChange={setChromeHeight}
        title={chatStrings.sessions.conversations}
      />
    </Screen>
  )
}

function Group({ children, title }: { children: React.ReactNode; title: string }) {
  const theme = useTheme()

  return (
    <View style={{ gap: theme.space.sm }}>
      <Text color="textFaint" variant="micro">
        {title.toUpperCase()}
      </Text>
      {children}
    </View>
  )
}

/**
 * One conversation, and whatever it is allowed to do.
 *
 * The action row is `conversationActions(conversation).map(...)` and nothing
 * else — no `kind === 'canonical'` test anywhere in this component — which is
 * what makes the ADR-0007 guard structural rather than a line somebody could
 * delete while tidying.
 */
function Row({
  conversation,
  mode,
  onAdopt,
  onDelete,
  onOpen,
  onRename,
  setMode
}: {
  conversation: Conversation
  mode: RowMode
  onAdopt: () => void
  onDelete: () => void
  onOpen: () => void
  onRename: (title: string) => void
  setMode: (mode: RowMode) => void
}) {
  const theme = useTheme()
  const actions = conversationActions(conversation)
  const renaming = mode?.kind === 'rename' && mode.id === conversation.id
  const confirming = mode?.kind === 'confirm' && mode.id === conversation.id

  const press = (action: (typeof actions)[number]): void => {
    switch (action) {
      case 'open':
        onOpen()

        return
      case 'rename':
        setMode({ kind: 'rename', id: conversation.id, draft: conversation.title })

        return
      case 'delete':
        setMode({ kind: 'confirm', id: conversation.id })

        return
      case 'adopt':
        onAdopt()
    }
  }

  return (
    <View style={{ gap: theme.space.xs, paddingVertical: theme.space.sm }} testID={`conversation-${conversation.id}`}>
      <Text numberOfLines={1} variant="name">
        {conversation.title}
      </Text>

      {conversation.preview ? (
        <Text color="textMuted" numberOfLines={1} variant="preview">
          {conversation.preview}
        </Text>
      ) : null}

      {/*
        The count and the clock on one line, because they answer one question —
        how much is in here and how long ago — and a reader scanning nine rows
        is comparing that pair across them rather than reading either alone.
      */}
      <Text color="textFaint" testID={`conversation-meta-${conversation.id}`} variant="micro">
        {chatStrings.sessions.messages(conversation.messageCount)}
        {/*
          The crons' own phrasebook rather than a second one written here. Two
          relative-time vocabularies in one app is how "3 days ago" and "3d"
          end up on adjacent screens.
        */}
        {conversation.lastActive ? ` · ${relativeEpoch(conversation.lastActive) ?? ''}` : ''}
      </Text>

      {renaming ? (
        <View style={{ gap: theme.space.xs }}>
          <TextField
            autoFocus
            onChangeText={draft => setMode({ kind: 'rename', id: conversation.id, draft })}
            onSubmitEditing={() => onRename(mode.draft)}
            testID={`conversation-rename-${conversation.id}`}
            value={mode.draft}
          />
          <View style={{ flexDirection: 'row', gap: theme.space.md }}>
            <Button onPress={() => onRename(mode.draft)} title={chatStrings.sessions.rename} />
            <Button onPress={() => setMode(null)} title={chatStrings.sessions.cancel} />
          </View>
        </View>
      ) : null}

      {confirming ? (
        <View style={{ gap: theme.space.xs }}>
          <Text color="dangerText" variant="preview">
            {chatStrings.sessions.deleteBody(conversation.title)}
          </Text>
          <View style={{ flexDirection: 'row', gap: theme.space.md }}>
            <Button
              onPress={onDelete}
              testID={`conversation-delete-confirm-${conversation.id}`}
              title={chatStrings.sessions.deleteConfirm}
              variant="danger"
            />
            <Button onPress={() => setMode(null)} title={chatStrings.sessions.cancel} />
          </View>
        </View>
      ) : null}

      {renaming || confirming ? null : (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: theme.space.md }}>
          {actions.map(action => (
            <Pressable
              accessibilityRole="button"
              key={action}
              onPress={() => press(action)}
              style={{ justifyContent: 'center', minHeight: CONTROL_MIN_HEIGHT }}
              testID={`conversation-${action}-${conversation.id}`}
            >
              <Text color={action === 'delete' ? 'dangerText' : 'accentText'} variant="preview">
                {actionLabels()[action]}
              </Text>
            </Pressable>
          ))}
        </View>
      )}
    </View>
  )
}

/*
 * Built on CALL rather than at import.
 *
 * A module-level literal would freeze whatever language was active when the
 * bundle loaded, which on a cold start is always English — see
 * `i18n/catalogue.ts`. The list is three entries and it is rebuilt per render;
 * the alternative is a screen that keeps its old language until it is remounted.
 */
const actionLabels = (): Record<'open' | 'rename' | 'delete' | 'adopt', string> => ({
  open: chatStrings.sessions.open,
  rename: chatStrings.sessions.rename,
  delete: chatStrings.sessions.delete,
  adopt: chatStrings.sessions.adopt
})

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))
