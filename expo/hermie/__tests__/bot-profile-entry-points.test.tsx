/**
 * The two ways into the profile sheet, and the one rule they share.
 *
 * There is ONE editor, reached from the chat header's pill and from the chat
 * row's menu, and the thing worth pinning is that neither of them is a second
 * implementation: the menu carries an item that parses back to an intention,
 * and the pill is a button whose press is the screen's to route. A build where
 * one of the two quietly grew its own smaller form is exactly what
 * `row-menu-items.ts` opens by warning about.
 */
import { fireEvent } from '@testing-library/react-native'

import { ChatHeader } from '../src/chat-ui/ChatHeader'
import { parseRowMenuAction, rowMenuItems } from '../src/features/bots/row-menu-items'
import { targetSheet } from '../src/features/chats/sheet-host'
import { renderScreen } from './support/render'

describe('the chat header pill', () => {
  it('opens the profile, because the pill IS the bot', () => {
    const onOpenProfile = jest.fn()
    const tree = renderScreen(
      <ChatHeader name="Researcher" onOpenOptions={() => undefined} onOpenProfile={onOpenProfile} presence="idle" />
    )

    fireEvent.press(tree.getByTestId('chat-header-profile'))

    expect(onOpenProfile).toHaveBeenCalledTimes(1)
  })

  /**
   * The options button is a different button with a different sheet. They sat
   * next to each other in the same row, and a pill that opened the options menu
   * would be the kind of mistake nothing else on the screen would reveal.
   */
  it('does not reach the options sheet on its way there', () => {
    const onOpenOptions = jest.fn()
    const tree = renderScreen(
      <ChatHeader name="Researcher" onOpenOptions={onOpenOptions} onOpenProfile={() => undefined} presence="idle" />
    )

    fireEvent.press(tree.getByTestId('chat-header-profile'))

    expect(onOpenOptions).not.toHaveBeenCalled()
  })

  /**
   * A surface with nowhere to put a sheet — the component gallery — passes no
   * handler, and the pill is then inert rather than a button that does nothing.
   */
  it('is not a button at all where there is no profile to open', () => {
    const tree = renderScreen(<ChatHeader name="Researcher" onOpenOptions={() => undefined} presence="idle" />)

    expect(tree.getByTestId('chat-header-profile').props.accessibilityState.disabled).toBe(true)
  })
})

describe('the row menu', () => {
  const model = {
    accent: 'default' as const,
    archived: false,
    botName: 'researcher',
    displayName: 'Researcher',
    movable: true,
    unread: false
  }

  it('offers Edit profile, above the decoration and below the two obvious lines', () => {
    const ids = rowMenuItems(model).map(item => item.id)

    expect(ids).toContain('editProfile')
    expect(ids.indexOf('editProfile')).toBeGreaterThan(ids.indexOf('markRead'))
    expect(ids.indexOf('editProfile')).toBeLessThan(ids.indexOf('colour'))
  })

  it('offers it in the archive drawer too, where a bot still has a profile', () => {
    const ids = rowMenuItems({ ...model, archived: true, movable: false }).map(item => item.id)

    expect(ids).toContain('editProfile')
  })

  it('parses the selection back to an intention rather than a string', () => {
    expect(parseRowMenuAction('editProfile')).toEqual({ kind: 'editProfile' })
  })
})

describe('the chat’s one sheet', () => {
  /**
   * The profile sheet is one of the sheets a reader opens, so it loses to a
   * question the agent is blocked on exactly as the other two do. That ordering
   * is the whole reason `sheet-host.ts` exists.
   */
  it('gives way to a question the agent is waiting on', () => {
    expect(targetSheet('profile', false)).toBe('profile')
    expect(targetSheet('profile', true)).toBe('request')
  })
})
