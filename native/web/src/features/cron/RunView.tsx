/**
 * One cron run, read-only: `#/crons/<job>/runs/<run>`.
 *
 * A run is an ordinary session, `cron_{job}_{timestamp}`, so it is read with `session.history` and drawn through
 * the same pipeline as a chat (`rowsToItems`, `visibleItems`, `transcriptRows`, the chat's item views): a tool call
 * in a run looks like a tool call in a conversation. It is NOT opened as a conversation: opening resumes a session,
 * and a cron run has no live agent behind it, so there is nothing to resume, nothing to send a prompt to, and
 * reading one must change nothing on the gateway. It is a chunk of its own because the item views are the heaviest
 * part of the chat screen and the list and the detail page do not need them.
 */
import { createChatState, rowsToItems, visibleItems, type VisibleItem } from '@hermie/transcript'
import { type ReactElement, useEffect, useId, useMemo, useState } from 'react'
import { useStore } from 'zustand'

import { messageOf } from '../../core/cron/controller'
import { deliveredBot, relativeEpoch, type CronJob } from '../../core/cron/model'
import { BOT_NAME_LIMIT, displayText } from '../../core/requests/secure-input'
import { strings } from '../../generated/strings'
import { cronWebStrings } from '../../i18n/cron-strings'
import { useLocale } from '../../i18n/use-locale'
import { botsStore } from '../../state/bots'
import { cronStore } from '../../state/cron'
import { transcriptRows } from '../chat/rows'
import { ChatItem } from '../chat/items/ChatItem'
import { ItemContext, type ItemContextValue } from '../chat/items/item-context'
import { WithName } from '../requests/with-name'
import { chatHref, cronHref } from '../shell/router'
import { cronName, useCronPage } from './cron-bits'

type RunState = { kind: 'loading' } | { kind: 'ready'; rows: VisibleItem[] } | { kind: 'failed'; message: string }

export function RunView({ job, runId }: { job: CronJob; runId: string }): ReactElement {
  useLocale()

  const { controller } = useCronPage()
  const run = useStore(cronStore, state => state.runs[job.id]?.find(entry => entry.id === runId))
  const bot = deliveredBot(job)
  const deliveredName = useStore(botsStore, state => (bot === null ? null : (state.byName[bot]?.displayName ?? null)))
  const [state, setState] = useState<RunState>({ kind: 'loading' })
  const name = cronName(job)
  const titleId = useId()

  useEffect(() => {
    if (!controller) {
      setState({ kind: 'ready', rows: [] })

      return
    }

    let current = true

    setState({ kind: 'loading' })
    controller
      .loadRunTranscript(runId, job.profile)
      .then(rows => {
        const chat = createChatState('', runId, runId)

        // Only `items` and `order` are filled: the indexes exist so live events can find the row they amend, and
        // nothing is ever going to amend this one.
        for (const item of rowsToItems(rows, 'rpc')) {
          chat.items[item.id] = item
          chat.order.push(item.id)
        }

        const shown = visibleItems(chat, { level: 'normal', showBotToBot: true, showThinking: false })

        if (current) {
          setState({
            kind: 'ready',
            rows: transcriptRows(shown, { busy: false, turnActive: false, draftingTool: undefined })
          })
        }
      })
      .catch((cause: unknown) => {
        if (current) {
          setState({ kind: 'failed', message: messageOf(cause) })
        }
      })

    return () => {
      current = false
    }
  }, [controller, job.profile, runId])

  const context = useMemo<ItemContextValue>(
    () => ({ botName: name, gatewayBaseUrl: undefined, ownAuthorId: undefined, groupChat: false }),
    [name]
  )
  const started = run ? relativeEpoch(run.startedAt ?? run.lastActive) : null

  return (
    <section className="hm-cron" aria-labelledby={titleId}>
      <p className="hm-cron__back">
        <a href={cronHref(job.id)}>
          <bdi>{name}</bdi>
        </a>
      </p>
      <h2 className="hm-cron__title" id={titleId}>
        {cronWebStrings.runHeading({ name })}
      </h2>
      {started ? <p className="hm-cron__schedule">{started}</p> : null}
      <p className="hm-cron-page__state">{strings.cron.run.readOnly}</p>
      {bot !== null && deliveredName !== null ? (
        <p>
          <a href={chatHref(bot)}>
            <WithName
              phrase={shown => cronWebStrings.deliveredChat({ name: shown })}
              name={displayText(deliveredName, BOT_NAME_LIMIT)}
            />
          </a>
        </p>
      ) : null}

      {state.kind === 'loading' ? (
        <p className="hm-cron-page__state" role="status">
          {strings.cron.run.loading}
        </p>
      ) : null}
      {state.kind === 'failed' ? (
        <p className="hm-cron-page__state" data-tone="danger" role="alert">
          {strings.cron.run.failed({ reason: state.message })}
        </p>
      ) : null}
      {state.kind === 'ready' && state.rows.length === 0 ? (
        <p className="hm-cron-page__state">{strings.cron.run.empty}</p>
      ) : null}

      {state.kind === 'ready' && state.rows.length > 0 ? (
        <ItemContext.Provider value={context}>
          <ol className="hm-cron-transcript">
            {state.rows.map(row => (
              <li key={row.item.id} className="hm-cron-transcript__row">
                <ChatItem row={row} />
              </li>
            ))}
          </ol>
        </ItemContext.Provider>
      ) : null}
    </section>
  )
}
