/**
 * HERM-83, Task 5: one gate, drawn on four surfaces.
 *
 * `TranscriptList`/`UserBubble` (Task 3), `chatRowPreview` and `exportTranscript`
 * (this task) each decide, independently, whether a `user` row is somebody
 * else's speech in the group chat — and each has its own exhaustive suite for
 * that decision on its own terms. What none of those suites can catch is the
 * four of them disagreeing about the SAME row: the transcript naming somebody
 * the list preview or the exported file stays quiet about, or the reverse.
 * This file builds one row and feeds it to all four with the same options.
 */
import { screen } from '@testing-library/react-native'

import {
  chatRowPreview,
  createChatState,
  exportTranscript,
  reconcile,
  rowsToItems,
  type TranscriptRow
} from '@hermie/transcript'

import { fallbackSenderName, TranscriptList } from '../../src/chat-ui'
import type { MessageAuthor } from '../../src/chat-ui'
import { renderScreen } from '../support/render'

const ME = 'authentik:me'
const WRITER: MessageAuthor = { id: 'authentik:writer', name: 'Robin' }

const ROW: TranscriptRow = {
  role: 'user',
  row_id: 1,
  text: 'draft is ready',
  display_metadata: { author: WRITER }
}

function chatOf(rows: readonly TranscriptRow[]) {
  return reconcile(createChatState('researcher', 'stored-1', 'resolved-1'), rowsToItems(rows, 'rpc'))
}

describe('the transcript, the preview and the export agree on one row', () => {
  it('all three name the sender in the group chat', () => {
    const chat = chatOf([ROW])
    const item = chat.items[chat.order[0] ?? '']!

    renderScreen(<TranscriptList groupChat items={[{ item, presentation: 'full' }]} ownAuthorId={ME} />)
    expect(screen.getByTestId(`user-sender-name-${item.id}`)).toHaveTextContent('Robin')

    const preview = chatRowPreview(chat, '', {
      groupChat: true,
      ownAuthorId: ME,
      resolveSenderName: fallbackSenderName
    })
    expect(preview?.senderName).toBe('Robin')

    const { markdown } = exportTranscript([item], {
      botName: 'Researcher',
      groupChat: true,
      ownAuthorId: ME,
      resolveSenderName: fallbackSenderName
    })
    expect(markdown).toContain('**Robin**')
  })

  it('all three stay silent outside the group chat, for the identical row', () => {
    const chat = chatOf([ROW])
    const item = chat.items[chat.order[0] ?? '']!

    renderScreen(<TranscriptList groupChat={false} items={[{ item, presentation: 'full' }]} ownAuthorId={ME} />)
    expect(screen.queryByTestId(`user-sender-name-${item.id}`)).toBeNull()

    const preview = chatRowPreview(chat, '', {
      groupChat: false,
      ownAuthorId: ME,
      resolveSenderName: fallbackSenderName
    })
    expect(preview?.senderName).toBeUndefined()

    const { markdown } = exportTranscript([item], {
      botName: 'Researcher',
      groupChat: false,
      ownAuthorId: ME,
      resolveSenderName: fallbackSenderName
    })
    expect(markdown).not.toContain('**Robin**')
  })

  it('all three stay silent for the reader’s own attributed row', () => {
    const own: TranscriptRow = { role: 'user', row_id: 2, text: 'ship it', display_metadata: { author: { id: ME } } }
    const chat = chatOf([own])
    const item = chat.items[chat.order[0] ?? '']!

    renderScreen(<TranscriptList groupChat items={[{ item, presentation: 'full' }]} ownAuthorId={ME} />)
    expect(screen.queryByTestId(`user-sender-${item.id}`)).toBeNull()

    const preview = chatRowPreview(chat, '', {
      groupChat: true,
      ownAuthorId: ME,
      resolveSenderName: fallbackSenderName
    })
    expect(preview?.senderName).toBeUndefined()

    const { markdown } = exportTranscript([item], {
      botName: 'Researcher',
      groupChat: true,
      ownAuthorId: ME,
      resolveSenderName: fallbackSenderName
    })
    expect(markdown).toContain('**You**')
  })
})
