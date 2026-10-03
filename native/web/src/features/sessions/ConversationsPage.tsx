/**
 * Every conversation one bot has, on one page: `#/chat/<bot>/conversations`.
 *
 * ADR-0007 gives a bot exactly ONE chat and this page does not change that. What
 * it does is admit that the one chat has a past and can have branches, and give
 * the reader somewhere to see them, open them (read-only, in the viewer at
 * `#/chat/<bot>/s/<id>`), name them, delete them, make one the Bot Chat again,
 * or put the current one away and start anew. The Expo app's
 * `ConversationsScreen`, on the web's shell.
 *
 * ## The groups, and why the first one is different
 *
 * **Current conversation** is the canonical session. It is drawn and named and
 * carries NO ACTIONS AT ALL. That is not a check made here: the action row of
 * every conversation is `conversationActions(conversation)` and nothing else,
 * and that answers an empty list for a row whose `kind` is `canonical`
 * (`core/sessions/session-model.ts`). A surface that renders whatever it returns
 * cannot offer Delete on the one chat that may never be deleted.
 *
 * **My chat** (the reader's own chat, where the gateway names the reader and the
 * client has one) may only be opened. **Branches** and **Past conversations**
 * carry the same four actions, because both are ordinary sessions and the
 * grouping is presentational: a branch renamed out of its prefix moves group and
 * loses nothing.
 *
 * ## Which steps ask first
 *
 * `session.delete` has no undo anywhere, so Delete asks, inline on the row
 * rather than in a dialog. A new conversation puts the group chat away for
 * everybody on the gateway, so it asks too. Rename cannot lose anything (the
 * gateway's refusals are reported) and commits on Return; "Make this the Bot
 * Chat" is a swap the controller rolls back on failure (`adoptAsCanonical`) and
 * runs at once, as in the Expo app.
 *
 * Every action ends the same way: say what happened, then read the list again
 * (`use-conversations.ts`). A new conversation and a swap open the chat first
 * when it is not live, because both retire the conversation the bot's key is on
 * and need its runtime session; after a new conversation the reader is taken to
 * the chat, where it starts.
 *
 * Titles are the gateway's and bots' text: cleaned and bounded (`displayText`),
 * isolated in `<bdi>`, drawn as characters.
 */
import { type FormEvent, type ReactElement, type ReactNode, useCallback, useId, useState } from 'react'
import { useStore } from 'zustand'

import { ConversationBusyError } from '../../core/chat-controller'
import { BOT_NAME_LIMIT, displayText } from '../../core/requests/secure-input'
import { type Conversation, type ConversationAction, conversationActions } from '../../core/sessions/session-model'
import { strings } from '../../generated/strings'
import { useLocale } from '../../i18n/use-locale'
import { webStrings } from '../../i18n/web-strings'
import { type HashRouter, pageHashRouter } from '../../platform/hash-router'
import { botsStore } from '../../state/bots'
import { chatsStore } from '../../state/chats'
import { Button } from '../../ui/primitives'
import { formatListTime } from '../bots/list-time'
import { useChatRuntime } from '../chat/chat-runtime'
import { WithName } from '../requests/with-name'
import { chatHref, conversationHref } from '../shell/router'
import { useConversations } from './use-conversations'
import './conversations.css'

/** The longest conversation title drawn, in code points. */
export const TITLE_LIMIT = 120

/** The longest preview drawn, in code points. */
const PREVIEW_LIMIT = 160

export interface ConversationsPageProps {
  /** The bot of the route. */
  bot: string
  /** The page's address, unless a test hands in its own. */
  router?: HashRouter
}

/** Which row, if any, has its rename field or its delete question open; `new` is the new-conversation question. */
type Mode = { kind: 'rename'; id: string; draft: string } | { kind: 'confirm'; id: string } | { kind: 'new' } | null

/** What the page last said: an outcome (polite) or a refusal (an alert). */
type Notice = { tone: 'done' | 'failed'; text: string } | null

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/** A refusal as the reader is told it: busy has its own sentence, everything else carries the gateway's reason. */
const failureOf = (error: unknown): string =>
  error instanceof ConversationBusyError
    ? strings.chat.sessions.busy
    : webStrings.sessions.actionFailed({ message: messageOf(error) })

/** Built on call, in the active language. */
const actionLabel = (action: ConversationAction): string => {
  switch (action) {
    case 'open':
      return strings.chat.sessions.open
    case 'rename':
      return strings.chat.sessions.rename
    case 'delete':
      return strings.chat.sessions.delete
    case 'adopt':
      return strings.chat.sessions.adopt
  }
}

export function ConversationsPage({ bot, router = pageHashRouter }: ConversationsPageProps): ReactElement {
  useLocale()

  const runtime = useChatRuntime()
  const controller = runtime?.controller
  const record = useStore(botsStore, state => state.byName[bot])
  const { state, reload } = useConversations(bot, controller)
  const [mode, setMode] = useState<Mode>(null)
  const [notice, setNotice] = useState<Notice>(null)
  const [busy, setBusy] = useState(false)
  const name = displayText(record?.displayName ?? bot, BOT_NAME_LIMIT) || bot

  /** The chat live under the bot's key, opened if it is not: a swap and a new conversation retire it. */
  const ensureOpen = useCallback(async () => {
    if (!controller || !record) {
      throw new Error(webStrings.chat.notOnGateway)
    }

    if (!chatsStore.getState().chats[bot]?.runtimeSessionId) {
      await controller.openChat(record)
    }
  }, [bot, controller, record])

  /** Run one action: one at a time, say what happened, close the row's form, read the list again. */
  const run = useCallback(
    async (work: () => Promise<string | null>) => {
      if (busy) {
        return
      }

      setBusy(true)

      try {
        const done = await work()

        setNotice(done === null ? null : { tone: 'done', text: done })
        setMode(null)
      } catch (error) {
        setNotice({ tone: 'failed', text: failureOf(error) })
      } finally {
        setBusy(false)
      }

      await reload()
    },
    [busy, reload]
  )

  const startNew = (): void => {
    void run(async () => {
      if (!controller) {
        return null
      }

      await ensureOpen()
      await controller.startNewConversation(bot)
      router.navigate(chatHref(bot))

      return null
    })
  }

  const groups = state.kind === 'ready' ? state.groups : null
  const failed = !controller ? strings.chat.sessions.loadFailed : state.kind === 'failed' ? state.message : null

  const rowProps = {
    bot,
    mode,
    busy,
    setMode,
    onRename: (conversation: Conversation, title: string) =>
      void run(async () => {
        await controller?.renameConversation(bot, conversation.id, title)

        return webStrings.sessions.renamed
      }),
    onDelete: (conversation: Conversation) =>
      void run(async () => {
        await controller?.deleteConversation(bot, conversation.id)

        return webStrings.sessions.deleted
      }),
    onAdopt: (conversation: Conversation) =>
      void run(async () => {
        await ensureOpen()
        await controller?.adoptAsCanonical(bot, conversation.id)

        return webStrings.sessions.adopted
      })
  }

  return (
    <div className="hm-main__body hm-conversations">
      <p className="hm-conversations__bot">
        <a href={chatHref(bot)}>
          <bdi>{name}</bdi>
        </a>
      </p>

      {/* Polite for an outcome, an alert for a refusal; present before it speaks, so it is heard. */}
      <p className={notice?.tone === 'done' ? 'hm-conversations__notice' : 'hm-sr'} role="status">
        {notice?.tone === 'done' ? notice.text : ''}
      </p>
      {notice?.tone === 'failed' ? (
        <p className="hm-conversations__notice" data-tone="danger" role="alert">
          {notice.text}
        </p>
      ) : null}

      {controller && record ? (
        <div className="hm-conversations__new">
          {mode?.kind === 'new' ? (
            <div className="hm-conversations__confirm">
              <p>{webStrings.sessions.newConfirmBody}</p>
              <div className="hm-conversations__buttons">
                <Button onClick={startNew} disabled={busy}>
                  {webStrings.sessions.newConfirm}
                </Button>
                <Button variant="quiet" onClick={() => setMode(null)} disabled={busy}>
                  {strings.chat.sessions.cancel}
                </Button>
              </div>
            </div>
          ) : (
            <Button variant="quiet" onClick={() => setMode({ kind: 'new' })} disabled={busy}>
              {webStrings.sessions.newConversation}
            </Button>
          )}
        </div>
      ) : null}

      {state.kind === 'loading' && controller ? (
        <p className="hm-conversations__state" role="status">
          {strings.chat.sessions.loading}
        </p>
      ) : null}

      {failed !== null ? (
        <p className="hm-conversations__state" data-tone="danger" role="alert">
          {failed}
        </p>
      ) : null}

      {groups?.canonical ? (
        <Group title={strings.chat.sessions.canonical}>
          <Row conversation={groups.canonical} {...rowProps} />
        </Group>
      ) : null}

      {groups?.mine ? (
        <Group title={strings.chat.sessions.mineGroup}>
          <Row conversation={groups.mine} {...rowProps} />
        </Group>
      ) : null}

      {groups && groups.branches.length > 0 ? (
        <Group title={strings.chat.sessions.branches}>
          {groups.branches.map(conversation => (
            <Row key={conversation.id} conversation={conversation} {...rowProps} />
          ))}
        </Group>
      ) : null}

      {groups ? (
        <Group
          title={strings.chat.sessions.past}
          {...(groups.past.length === 0 ? { empty: strings.chat.sessions.pastEmpty } : {})}
        >
          {groups.past.map(conversation => (
            <Row key={conversation.id} conversation={conversation} {...rowProps} />
          ))}
        </Group>
      ) : null}
    </div>
  )
}

/** A titled group of rows, or a sentence where it has none. */
function Group({ title, empty, children }: { title: string; empty?: string; children: ReactNode }): ReactElement {
  const id = useId()

  return (
    <section className="hm-conversations__group" aria-labelledby={id}>
      <h2 className="hm-conversations__group-title" id={id}>
        {title}
      </h2>
      {empty === undefined ? (
        <ul className="hm-conversations__rows">{children}</ul>
      ) : (
        <p className="hm-conversations__empty">{empty}</p>
      )}
    </section>
  )
}

interface RowProps {
  bot: string
  conversation: Conversation
  mode: Mode
  busy: boolean
  setMode: (mode: Mode) => void
  onRename: (conversation: Conversation, title: string) => void
  onDelete: (conversation: Conversation) => void
  onAdopt: (conversation: Conversation) => void
}

/**
 * One conversation, and whatever it is allowed to do.
 *
 * The action row is `conversationActions(conversation).map(...)` and nothing
 * else: there is no `kind === 'canonical'` test anywhere in this component, which
 * is what makes the ADR-0007 guard structural rather than a line somebody could
 * delete while tidying.
 */
function Row({ bot, conversation, mode, busy, setMode, onRename, onDelete, onAdopt }: RowProps): ReactElement {
  const fieldId = useId()
  const actions = conversationActions(conversation)
  const title = displayText(conversation.title, TITLE_LIMIT) || conversation.id
  const preview = displayText(conversation.preview, PREVIEW_LIMIT)
  const time = formatListTime(conversation.lastActive)
  const renaming = mode?.kind === 'rename' && mode.id === conversation.id ? mode : null
  const confirming = mode?.kind === 'confirm' && mode.id === conversation.id

  const submitRename = (event: FormEvent): void => {
    event.preventDefault()

    if (renaming) {
      onRename(conversation, renaming.draft)
    }
  }

  return (
    <li className="hm-conversation" data-conversation={conversation.id} data-kind={conversation.kind}>
      <p className="hm-conversation__title">
        <bdi>{title}</bdi>
      </p>
      {preview ? (
        <p className="hm-conversation__preview" dir="auto">
          {preview}
        </p>
      ) : null}
      <p className="hm-conversation__meta">
        {strings.chat.sessions.messages({ count: conversation.messageCount })}
        {time ? ` · ${time}` : ''}
      </p>

      {renaming ? (
        <form className="hm-conversation__form" onSubmit={submitRename}>
          <label className="hm-conversation__label" htmlFor={fieldId}>
            {strings.chat.sessions.renameTitle}
          </label>
          <input
            id={fieldId}
            className="hm-conversation__field"
            value={renaming.draft}
            onChange={event => setMode({ kind: 'rename', id: conversation.id, draft: event.target.value })}
            onKeyDown={event => {
              if (event.key === 'Escape') {
                event.preventDefault()
                setMode(null)
              }
            }}
            autoComplete="off"
            // The reader asked for this field by pressing Rename; it is where they are now.
            autoFocus
          />
          <div className="hm-conversations__buttons">
            <Button type="submit" disabled={busy}>
              {strings.chat.sessions.rename}
            </Button>
            <Button variant="quiet" onClick={() => setMode(null)} disabled={busy}>
              {strings.chat.sessions.cancel}
            </Button>
          </div>
        </form>
      ) : null}

      {confirming ? (
        <div className="hm-conversations__confirm">
          <p data-tone="danger">
            <WithName phrase={shown => strings.chat.sessions.deleteBody({ title: shown })} name={title} />
          </p>
          <div className="hm-conversations__buttons">
            <Button className="hm-button--danger" onClick={() => onDelete(conversation)} disabled={busy}>
              {strings.chat.sessions.deleteConfirm}
            </Button>
            <Button variant="quiet" onClick={() => setMode(null)} disabled={busy}>
              {strings.chat.sessions.cancel}
            </Button>
          </div>
        </div>
      ) : null}

      {renaming || confirming || actions.length === 0 ? null : (
        <div
          className="hm-conversation__actions"
          role="group"
          aria-label={webStrings.sessions.actionsFor({ name: title })}
        >
          {actions.map(action =>
            action === 'open' ? (
              <a key={action} className="hm-conversation__action" href={conversationHref(bot, conversation.id)}>
                {actionLabel(action)}
              </a>
            ) : (
              <button
                key={action}
                type="button"
                className="hm-conversation__action"
                data-tone={action === 'delete' ? 'danger' : undefined}
                disabled={busy}
                onClick={() => {
                  if (action === 'rename') {
                    setMode({ kind: 'rename', id: conversation.id, draft: conversation.title })
                  } else if (action === 'delete') {
                    setMode({ kind: 'confirm', id: conversation.id })
                  } else {
                    onAdopt(conversation)
                  }
                }}
              >
                {actionLabel(action)}
              </button>
            )
          )}
        </div>
      )}
    </li>
  )
}
