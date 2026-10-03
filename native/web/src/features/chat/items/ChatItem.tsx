/**
 * One row of the transcript: the view for its kind.
 *
 * The engine's kinds and the two rows of the screen's own (`rows.ts`: a date
 * separator and the typing row, which are `status` items under a kind the
 * gateway cannot send) are told apart here and nowhere else.
 */
import type { VisibleItem } from '@hermie/transcript'

import { isDateRow, isTypingRow } from '../rows'
import { AssistantBubble } from './AssistantBubble'
import { DateSeparator } from './DateSeparator'
import { NoticeRow } from './NoticeRow'
import { OtherRow } from './OtherRow'
import { StatusRow } from './StatusRow'
import { ToolRow } from './ToolRow'
import { TypingRow } from './TypingRow'
import { UserBubble } from './UserBubble'

export function ChatItem({ row }: { row: VisibleItem }) {
  const { item, presentation } = row

  switch (item.kind) {
    case 'user':
      return <UserBubble item={item} presentation={presentation} />
    case 'assistant':
      return <AssistantBubble item={item} presentation={presentation} />
    case 'tool':
      return <ToolRow item={item} presentation={presentation} />
    case 'notice':
      return <NoticeRow item={item} presentation={presentation} />
    case 'status':
      if (isDateRow(item)) {
        return <DateSeparator item={item} presentation={presentation} />
      }

      if (isTypingRow(item)) {
        return <TypingRow />
      }

      return <StatusRow item={item} presentation={presentation} />
    default:
      return <OtherRow item={item} presentation={presentation} />
  }
}
