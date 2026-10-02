/**
 * The chat list's header, which is now the same header at every width.
 *
 * It used to hold four controls beside a `flex: 1` title — Boards, New bot,
 * `+`, Edit — and fold three of them into a `…` below a measured width. The
 * owner's report was about the width ABOVE that threshold: the Mac sidebar, at
 * which all four fitted and read as one cramped run of words. So there is no
 * threshold any more, and there is no Edit either: the mode it toggled is gone,
 * so the row is the title and one `…`. This file is the proof that the
 * arrangement does not depend on the width — hence the two extremes, 300pt and
 * 900pt, asserted against the same expectations.
 *
 * Width is still delivered through `onLayout` rather than by rendering at a
 * real size, because nothing in this environment lays anything out: every
 * measurement is zero unless a test provides one. The point of the assertions
 * is now that providing one changes nothing.
 */
import { fireEvent, screen } from '@testing-library/react-native'
import { StyleSheet } from 'react-native'

import { BotsScreen } from '../src/features/bots'
import { strings } from '../src/i18n/strings'
import { kanbanStrings } from '../src/features/kanban'
import { profileStrings } from '../src/features/profiles/strings'
import { CONTROL_SIZE, SIDEBAR_WIDTH, SIDEBAR_WIDTH_NARROW } from '../src/ui/tokens'
import { type Bot, useBotsStore } from '../src/store/bots'
import { useChatLayoutStore } from '../src/store/chat-layout'
import { useChatsStore } from '../src/store/chats'
import { renderScreen } from './support/render'

const gateway = { status: 'ready', config: { baseUrl: 'https://gateway.example.com', authMode: 'native_pkce' } }

jest.mock('../src/gateway', () => ({
  useGateway: () => gateway,
  hostOf: (url: string) => url.replace(/^https:\/\//, '')
}))

jest.mock('../src/gateway/GatewayProvider', () => ({
  useGateway: () => ({
    ...gateway,
    adoptTokens: jest.fn(),
    signOut: jest.fn(),
    changeGateway: jest.fn(),
    extraHeaders: {}
  })
}))

jest.mock('../src/features/chats/ChatRuntime', () => ({ useChatRuntime: () => null }))

const ROSTER: Bot[] = [
  {
    name: 'researcher',
    displayName: 'Researcher',
    description: 'Finds things out.',
    model: 'example-provider/example-model',
    provider: 'example-provider',
    isDefault: false,
    hasAvatar: false,
    uiMetaRevision: 0
  }
]

/** The header row, and the width the shell would have given it. */
function layOutHeadAt(width: number) {
  fireEvent(screen.getByTestId('bots-head'), 'layout', { nativeEvent: { layout: { width, height: 60 } } })
}

/**
 * The two widths that have to agree.
 *
 * `SIDEBAR_WIDTH_NARROW` is the narrowest the list is ever drawn — an iPad in
 * portrait. 900 stands for the other end: a Mac window with the sidebar given
 * far more room than its own width, which is where a width-dependent layout
 * would have taken the other branch.
 */
const WIDTHS: [string, number][] = [
  ['the narrow sidebar width', SIDEBAR_WIDTH_NARROW],
  ['a width with room to spare', 900]
]

beforeEach(() => {
  useBotsStore.setState({ bots: ROSTER, running: {}, lastSeen: {} })
  useChatsStore.setState({ chats: {} })
  useChatLayoutStore.setState({ layouts: {} })
})

describe.each(WIDTHS)('the header at %s', (_label, width) => {
  it('offers exactly one control, and no inline word actions', () => {
    renderScreen(<BotsScreen sidebar onOpenSection={jest.fn()} />)

    layOutHeadAt(width)

    expect(screen.getByTestId('bots-head-overflow')).toBeTruthy()

    expect(screen.queryByTestId('bots-edit')).toBeNull()
    expect(screen.queryByTestId('bots-boards')).toBeNull()
    expect(screen.queryByTestId('bots-new-bot')).toBeNull()
  })

  /**
   * The `…` is the chat header's button, not a glyph in a gap.
   *
   * The owner's verdict was that it "could be prettier", and what the app
   * already has for a control floating over a surface is `RoundIconButton` — a
   * glass circle with the mark centred in it. Its own surface is what says the
   * button is that component rather than a `Pressable` with a radius: the
   * circle is drawn by `GlassSurface`, which names itself `-surface`.
   */
  it('draws the overflow control as a round glass button', () => {
    renderScreen(<BotsScreen sidebar onOpenSection={jest.fn()} />)

    layOutHeadAt(width)

    const button = screen.getByTestId('bots-head-overflow')
    const style = StyleSheet.flatten(
      typeof button.props.style === 'function' ? button.props.style({ pressed: false }) : button.props.style
    ) as { borderRadius?: number; height?: number; width?: number }

    // The chat header's own measurements: a `CONTROL_SIZE.regular` circle.
    expect(style.height).toBe(CONTROL_SIZE.regular)
    expect(style.width).toBe(CONTROL_SIZE.regular)
    expect(style.borderRadius).toBe(CONTROL_SIZE.regular / 2)

    // And the glass under it, which is the material the header's buttons carry.
    expect(screen.getByTestId('bots-head-overflow-surface')).toBeTruthy()
  })

  it('has no cron control at all — a cron is made on the Crons tab', () => {
    const onOpenSection = jest.fn()
    renderScreen(<BotsScreen sidebar onOpenSection={onOpenSection} />)

    layOutHeadAt(width)

    expect(screen.queryByTestId('bots-new-cron')).toBeNull()
    expect(onOpenSection).not.toHaveBeenCalled()
  })

  it('names the overflow control for a reader who cannot see the glyph', () => {
    renderScreen(<BotsScreen sidebar onOpenSection={jest.fn()} />)

    layOutHeadAt(width)

    expect(screen.getByLabelText(strings.bots.moreActions)).toBeTruthy()
  })

  it('holds New bot, New folder and Boards behind the overflow control', () => {
    renderScreen(<BotsScreen sidebar onOpenSection={jest.fn()} />)

    layOutHeadAt(width)
    fireEvent.press(screen.getByTestId('bots-head-overflow'))

    expect(screen.getByTestId('bots-head-overflow-new-bot')).toHaveTextContent(profileStrings.settings.newBot)
    // New folder is what is left of the edit mode that used to reveal a bar with
    // this action in it. It is used now and then, which is what this menu is for.
    expect(screen.getByTestId('bots-head-overflow-new-folder')).toHaveTextContent(strings.layout.newFolder)
    expect(screen.getByTestId('bots-head-overflow-boards')).toHaveTextContent(kanbanStrings.menu)
  })

  it('draws the title on one line, so "Chats" cannot stack its letters', () => {
    renderScreen(<BotsScreen sidebar onOpenSection={jest.fn()} />)

    layOutHeadAt(width)

    // By ROLE, not by text: "Chats" is also the tab, and the assertion is about
    // the one that is this screen's heading.
    expect(screen.getByRole('header', { name: strings.bots.title }).props.numberOfLines).toBe(1)
  })
})

describe('the header as the width changes under it', () => {
  it('keeps the same control when a narrow window is widened', () => {
    renderScreen(<BotsScreen sidebar onOpenSection={jest.fn()} />)

    layOutHeadAt(SIDEBAR_WIDTH_NARROW)
    expect(screen.getByTestId('bots-head-overflow')).toBeTruthy()

    layOutHeadAt(SIDEBAR_WIDTH)
    expect(screen.getByTestId('bots-head-overflow')).toBeTruthy()
    expect(screen.queryByTestId('bots-edit')).toBeNull()
    expect(screen.queryByTestId('bots-boards')).toBeNull()
  })

  it('is the same header on a phone, which never measures the row at all', () => {
    renderScreen(<BotsScreen onOpenSection={jest.fn()} />)

    expect(screen.getByTestId('bots-head-overflow')).toBeTruthy()
    expect(screen.queryByTestId('bots-edit')).toBeNull()
    expect(screen.queryByTestId('bots-new-cron')).toBeNull()
  })
})
