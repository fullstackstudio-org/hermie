/**
 * One row of the transcript: the view for its kind.
 *
 * The engine's kinds and the rows of the screen's own (`rows.ts`: a date
 * separator, the typing row and the tool being written; `dm-rollup.ts`: a run of
 * bot-to-bot asides rolled up; all of them `status` items under a kind the
 * gateway cannot send) are told apart here and nowhere else.
 */
import type { VisibleItem } from '@hermie/transcript'

import { isRollupRow } from '../dm-rollup'
import { isDateRow, isGeneratingRow, isTypingRow } from '../rows'
import { AssistantBubble } from './AssistantBubble'
import { BotDmAside } from './BotDmAside'
import { BotDmRollup } from './BotDmRollup'
import { CronDeliveryCard } from './CronDeliveryCard'
import { DateSeparator } from './DateSeparator'
import { NoticeRow } from './NoticeRow'
import { OtherRow } from './OtherRow'
import { StatusRow } from './StatusRow'
import { SubagentGroupCard } from './SubagentGroupCard'
import { isSystemLineNotice, SystemLine } from './SystemLine'
import { ToolCard } from './ToolCard'
import { ToolGenerating } from './ToolGenerating'
import { TypingRow } from './TypingRow'
import { UserBubble } from './UserBubble'
import './item-views.css'

export function ChatItem({ row }: { row: VisibleItem }) {
  const { item, presentation } = row

  switch (item.kind) {
    case 'user':
      return <UserBubble item={item} presentation={presentation} />
    case 'assistant':
      return <AssistantBubble item={item} presentation={presentation} />
    case 'tool':
      return <ToolCard item={item} presentation={presentation} />
    case 'bot_dm_in':
    case 'bot_dm_out':
      return <BotDmAside item={item} presentation={presentation} />
    case 'cron_delivery':
      return <CronDeliveryCard item={item} presentation={presentation} />
    case 'subagent_group':
      return <SubagentGroupCard item={item} presentation={presentation} />
    case 'notice':
      return isSystemLineNotice(item) ? (
        <SystemLine item={item} presentation={presentation} />
      ) : (
        <NoticeRow item={item} presentation={presentation} />
      )
    case 'status':
      if (isGeneratingRow(item)) {
        return <ToolGenerating name={item.text} />
      }

      if (isDateRow(item)) {
        return <DateSeparator item={item} presentation={presentation} />
      }

      if (isTypingRow(item)) {
        return <TypingRow />
      }

      if (isRollupRow(item)) {
        return <BotDmRollup item={item} presentation={presentation} />
      }

      return <StatusRow item={item} presentation={presentation} />
    default:
      return <OtherRow item={item} presentation={presentation} />
  }
}
