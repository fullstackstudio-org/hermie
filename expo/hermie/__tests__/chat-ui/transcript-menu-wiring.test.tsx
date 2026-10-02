/**
 * The menu a row is actually GIVEN, rather than the menu `messageMenuItems`
 * would build if it were asked.
 *
 * This is the gap the round's voice work fell into, and it is worth a suite of
 * its own because nothing else could see it. `message-actions.test.ts` calls
 * `messageMenuItems` directly and has always passed; the list, meanwhile, built
 * its row context by naming each field one at a time — and four of the fields
 * `TranscriptContext` declares were never named. `onEditResend`, `onRegenerate`,
 * `turnRunning` and `lastAssistantId` all arrived `undefined` at every row, so
 * `Edit and resend` and `Regenerate` were not drawn anywhere in the app while
 * being fully covered by unit tests.
 *
 * `ContextMenuHost` renders its children bare where there is no native menu,
 * which is every test environment — so the items never reach the tree and no
 * ordinary query can see them. The stand-in below puts them there.
 */
import { screen } from '@testing-library/react-native'

import { TranscriptList } from '../../src/chat-ui'
import { assistantItem, userItem } from '../../src/chat-ui/fixtures'
import type { MenuItem } from '../../src/ui/menu'
import { renderScreen } from '../support/render'

jest.mock('../../src/platform/context-menu', () => {
  const React = require('react')
  const { Text, View } = require('react-native')

  return {
    HAS_NATIVE_CONTEXT_MENU: false,
    ContextMenuHost: ({
      children,
      items,
      testID
    }: {
      children: React.ReactNode
      items: readonly MenuItem[]
      testID?: string
    }) =>
      React.createElement(
        View,
        { testID },
        // The ids and the labels, flattened: a submenu's leaves matter as much
        // as a top-level line, and `Stop reading` versus `Read aloud` is a
        // LABEL difference on one id.
        React.createElement(
          Text,
          { testID: testID ? `${testID}-ids` : undefined },
          items.map(item => `${item.id}${item.disabled ? ':disabled' : ''}|${item.title}`).join(',')
        ),
        children
      )
  }
})

const menuFor = (id: string): string => screen.getByTestId(`transcript-menu-${id}-ids`).props.children as string

describe('the menu a transcript row is handed', () => {
  it('carries the turn-starting lines the host passed in', () => {
    renderScreen(
      <TranscriptList
        items={[{ item: assistantItem, presentation: 'full' }]}
        lastAssistantId={assistantItem.id}
        onEditResend={() => undefined}
        onRegenerate={() => undefined}
        turnRunning={false}
      />
    )

    expect(menuFor(assistantItem.id)).toContain('regenerate|')
  })

  it('greys them while a turn runs, rather than dropping them', () => {
    renderScreen(
      <TranscriptList items={[{ item: userItem, presentation: 'full' }]} onEditResend={() => undefined} turnRunning />
    )

    expect(menuFor(userItem.id)).toContain('editResend:disabled|')
  })

  it('offers Read aloud on a reply when the host can speak', () => {
    renderScreen(
      <TranscriptList items={[{ item: assistantItem, presentation: 'full' }]} onReadAloud={() => undefined} />
    )

    expect(menuFor(assistantItem.id)).toContain('readAloud|Read aloud')
  })

  it('says Stop reading on the row that is being read', () => {
    renderScreen(
      <TranscriptList
        items={[{ item: assistantItem, presentation: 'full' }]}
        onReadAloud={() => undefined}
        readingItemIds={[assistantItem.id]}
      />
    )

    expect(menuFor(assistantItem.id)).toContain('readAloud|Stop reading')
  })

  it('draws no Read aloud line where the platform cannot speak', () => {
    // The host passes no handler at all on a browser with no `speechSynthesis`,
    // which is the whole of the capability gate.
    renderScreen(<TranscriptList items={[{ item: assistantItem, presentation: 'full' }]} />)

    expect(menuFor(assistantItem.id)).not.toContain('readAloud')
  })

  it('never offers Read aloud on the reader’s own turn', () => {
    renderScreen(<TranscriptList items={[{ item: userItem, presentation: 'full' }]} onReadAloud={() => undefined} />)

    expect(menuFor(userItem.id)).not.toContain('readAloud')
  })
})

/**
 * HERM-83: whose turn `Edit and resend` and `Regenerate` can touch, in the
 * group chat. Both facts — a row's own `author` for Edit, and the host's
 * `regeneratePromptIsOwn` for Regenerate — arrive as plain context here, the
 * same way `groupChat` and `ownAuthorId` already did for names; this proves
 * the MENU reads them, not just the bubble.
 */
describe('whose turn a menu can touch, in the group chat', () => {
  const ME = 'authentik:me'
  const COLLEAGUE = { id: 'authentik:robin', name: 'Robin Vale' }

  it('hides Edit and resend on a colleague’s message', () => {
    renderScreen(
      <TranscriptList
        groupChat
        items={[{ item: { ...userItem, author: COLLEAGUE }, presentation: 'full' }]}
        onEditResend={() => undefined}
        ownAuthorId={ME}
      />
    )

    expect(menuFor(userItem.id)).not.toContain('editResend')
  })

  it('offers Edit and resend on the reader’s own message', () => {
    renderScreen(
      <TranscriptList
        groupChat
        items={[{ item: { ...userItem, author: { id: ME } }, presentation: 'full' }]}
        onEditResend={() => undefined}
        ownAuthorId={ME}
      />
    )

    expect(menuFor(userItem.id)).toContain('editResend|')
  })

  it('still offers Edit and resend on an unattributed message', () => {
    renderScreen(
      <TranscriptList
        groupChat
        items={[{ item: userItem, presentation: 'full' }]}
        onEditResend={() => undefined}
        ownAuthorId={ME}
      />
    )

    expect(menuFor(userItem.id)).toContain('editResend|')
  })

  it('does not offer Regenerate when the host says the prompt it would resend is a colleague’s', () => {
    renderScreen(
      <TranscriptList
        items={[{ item: assistantItem, presentation: 'full' }]}
        lastAssistantId={assistantItem.id}
        onRegenerate={() => undefined}
        regeneratePromptIsOwn={false}
      />
    )

    expect(menuFor(assistantItem.id)).not.toContain('regenerate')
  })

  it('still offers Regenerate when the host says nothing about it, unchanged from before this flag existed', () => {
    renderScreen(
      <TranscriptList
        items={[{ item: assistantItem, presentation: 'full' }]}
        lastAssistantId={assistantItem.id}
        onRegenerate={() => undefined}
      />
    )

    expect(menuFor(assistantItem.id)).toContain('regenerate|')
  })
})
