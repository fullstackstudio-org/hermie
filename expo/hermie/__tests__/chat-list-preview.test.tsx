/**
 * What a chat-list row says under the bot's name.
 *
 * The row Sebas photographed read `[System: The active model for th…`: the
 * gateway's `canonical_session.preview` is the raw text of the last row, that
 * row was a marker addressed to the model, and the whole width went on the
 * wrapper. Two rules came out of it — never the wrapper, and prefer a real
 * message when this client holds one.
 */
import { screen } from '@testing-library/react-native'
import { reconcile, rowsToItems, createChatState, type TranscriptRow } from '@hermie/transcript'

import { BotRow } from '../src/features/bots/BotRow'
import type { Bot } from '../src/store/bots'
import { useChatsStore } from '../src/store/chats'
import { renderScreen } from './support/render'

const MARKER =
  '[System: The active model for this chat has changed to k3 via provider moonshot. From this point forward, use ' +
  'this runtime metadata when answering questions about what model/provider is active.]'

const bot = (preview: string): Bot => ({
  name: 'abuse',
  displayName: 'Abuse agent',
  description: 'Handles abuse reports.',
  model: 'example-provider/example-model',
  provider: 'example-provider',
  isDefault: false,
  hasAvatar: false,
  uiMetaRevision: 0,
  canonical: { id: 'stored-abuse', resolvedId: 'stored-abuse', preview, lastActive: 1, messageCount: 4 }
})

function seedChat(rows: readonly TranscriptRow[]): void {
  useChatsStore
    .getState()
    .hydrate('abuse', reconcile(createChatState('abuse', 'stored-abuse', 'stored-abuse'), rowsToItems(rows, 'rpc')))
}

function renderRow(preview: string) {
  renderScreen(
    <BotRow
      accent="default"
      archived={false}
      bot={bot(preview)}
      compact={false}
      editing={false}
      menuFolders={[]}
      mutedUntil={null}
      onMenuSelect={() => undefined}
      onOpenMenu={() => undefined}
      onPress={() => undefined}
      presence={{ state: 'online' }}
      selected={false}
      unread={false}
      unreadCount={0}
    />
  )

  return screen.getByTestId('bot-preview-abuse')
}

describe('the chat-list preview', () => {
  beforeEach(() => {
    useChatsStore.getState().reset()
  })

  it('never shows the [System: …] wrapper, even with no transcript to fall back on', () => {
    const line = renderRow(MARKER)

    expect(String(line.props.children)).not.toContain('[System:')
    expect(String(line.props.children)).toContain('The active model for this chat has changed to k3')
  })

  it('draws a line nobody said in a quieter style than speech', () => {
    const line = renderRow(MARKER)
    const style = Array.isArray(line.props.style) ? Object.assign({}, ...line.props.style.flat()) : line.props.style

    expect(style.fontStyle).toBe('italic')
  })

  it('prefers the last real message the transcript holds over the marker', () => {
    seedChat([
      { role: 'user', row_id: 1, text: 'any new reports?' },
      { role: 'assistant', row_id: 2, text: 'Two overnight, both closed.' },
      { role: 'user', row_id: 3, text: MARKER, display_kind: 'model_switch' }
    ])

    const line = renderRow(MARKER)
    const style = Array.isArray(line.props.style) ? Object.assign({}, ...line.props.style.flat()) : line.props.style

    expect(line.props.children).toBe('Two overnight, both closed.')
    // It is speech again, so it loses the quieter style with it.
    expect(style.fontStyle).toBeUndefined()
  })

  it('falls back to the description when there is nothing to preview at all', () => {
    expect(renderRow('').props.children).toBe('Handles abuse reports.')
  })
})
