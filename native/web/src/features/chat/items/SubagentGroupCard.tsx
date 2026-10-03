/**
 * One `delegate_task` fan-out: the goals that were handed out, a status per
 * child, and the summary once they all land.
 *
 * - **Chip** (`quiet`, or bot-to-bot hidden): `Agents · Running · 3 goals`.
 * - **Collapsed** (normal): a card whose goals are one line each.
 * - **Full** (verbose): the same card with every goal written out.
 *
 * The children live in `ChatState.subagents`, not on the item, and change
 * without the group's version changing, so the card reads them from the chat
 * store itself (the chat's key comes through `ItemContext`); a child's status
 * is shown against the goal it was handed (`rootIds` in goal order). A goal no
 * child has reported on yet takes the group's own status, as the Swift card
 * draws it. The status is a glyph for the eye and a word for assistive
 * technology.
 *
 * A child's own transcript and its controls (steer, stop) are the agents
 * sheet's, not this row's. Goals and the summary are the agent's text, cleaned
 * and bounded (`displayText`).
 */
import type { Subagent, SubagentGroupItem, SubagentStatus } from '@hermie/transcript'
import { memo } from 'react'
import { useStore } from 'zustand'

import { displayText } from '../../../core/requests/secure-input'
import { strings } from '../../../generated/strings'
import { useLocale } from '../../../i18n/use-locale'
import { chatsStore } from '../../../state/chats'
import { VisuallyHidden } from '../../../ui/primitives'
import { formatDuration } from '../chat-format'
import { useItemContext } from './item-context'
import { type RowViewProps, sameRowView } from './row-view'

/** The longest goal a line holds, and the longest summary. */
const GOAL_CHARS = 600
const COMPLETION_CHARS = 4_000

/** A group's status, as the status of one of its children. */
function childStatusOf(group: SubagentGroupItem['status']): SubagentStatus {
  switch (group) {
    case 'done':
      return 'completed'
    case 'failed':
      return 'failed'
    case 'running':
      return 'running'
    default:
      return 'queued'
  }
}

export function statusGlyph(status: SubagentStatus): string {
  switch (status) {
    case 'completed':
      return '✓'
    case 'failed':
      return '✕'
    case 'interrupted':
      return '■'
    case 'running':
      return '●'
    default:
      return '○'
  }
}

/** The children of this fan-out, by goal: `rootIds[i]` is the child handed goal `i`. */
function useChildren(item: SubagentGroupItem): (Subagent | undefined)[] {
  const { chatKey } = useItemContext()
  const subagents = useStore(chatsStore, state => (chatKey === undefined ? undefined : state.chats[chatKey]?.subagents))

  return item.goals.map((_goal, index) => {
    const id = item.rootIds[index]

    return id === undefined ? undefined : subagents?.[id]
  })
}

function SubagentGroupCardView({ item, presentation }: RowViewProps<SubagentGroupItem>) {
  useLocale()

  const children = useChildren(item)

  if (presentation === 'hidden-placeholder') {
    return null
  }

  const groupStatus = strings.chat.subagents.groupStatus[item.status] ?? displayText(item.status, 40)
  const title = `${strings.chat.subagents.title} · ${groupStatus}`
  const goals = strings.chat.subagents.goals({ count: item.goals.length })

  if (presentation === 'chip') {
    return (
      <p className="hm-chip" data-kind="subagent_group" data-status={item.status}>
        {`${title} · ${goals}`}
      </p>
    )
  }

  const completion = item.completion ? displayText(item.completion, COMPLETION_CHARS) : ''

  return (
    <article
      className="hm-agents"
      data-status={item.status}
      data-detailed={presentation === 'full' ? 'true' : 'false'}
      aria-label={title}
    >
      <p className="hm-agents__header">
        <span className="hm-agents__title">{title}</span>
        <span className="hm-agents__count">{goals}</span>
      </p>
      {item.goals.length > 0 ? (
        <ul className="hm-agents__goals">
          {item.goals.map((goal, index) => {
            const child = children[index]
            const status = child?.status ?? childStatusOf(item.status)
            const duration = formatDuration(child?.durationSeconds)

            return (
              <li key={index} className="hm-agents__goal" data-status={status}>
                <span className="hm-agents__glyph" aria-hidden="true">
                  {statusGlyph(status)}
                </span>
                <VisuallyHidden>{`${strings.chat.subagents.status[status]}: `}</VisuallyHidden>
                <span className="hm-agents__text">
                  <bdi>{displayText(goal, GOAL_CHARS)}</bdi>
                </span>
                {duration ? <span className="hm-agents__duration">{duration}</span> : null}
              </li>
            )
          })}
        </ul>
      ) : null}
      {completion ? (
        <p className="hm-agents__completion" dir="auto">
          {completion}
        </p>
      ) : null}
    </article>
  )
}

export const SubagentGroupCard = memo(SubagentGroupCardView, sameRowView)
