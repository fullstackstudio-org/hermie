/**
 * A field with an icon in front of it, and the one rule that keeps them on a line.
 *
 * "Search chats" came back from the owner's window with the magnifier and the
 * placeholder on two different centre lines — a few points apart, enough to read as
 * a rendering fault rather than as a style. Three separate things have to be true to
 * fix that, and each of them was individually invisible:
 *
 *  1. the icon's SLOT is the height of the text LINE, not the size of the mark;
 *  2. the field's leading is stated, so the box the icon was sized against exists;
 *  3. the field adds no vertical padding of its own, so the row's centring is the
 *     only thing positioning the text.
 *
 * All three are asserted, because a fix that lands two of them looks fixed at one
 * text size and wrong at the next.
 *
 * This file also stands in for "every field with a leading icon". There is exactly
 * one today, which is a fact worth pinning rather than a reason not to: the list
 * below is what a second one has to be added to, and `TextField` — the app's other
 * field — is asserted to still have no leading icon, so the day it grows one this
 * test is where the rule is waiting.
 */
import { render, screen } from '@testing-library/react-native'
import { StyleSheet, type TextStyle } from 'react-native'

import { BotsScreen } from '../src/features/bots'
import { type Bot, useBotsStore } from '../src/store/bots'
import { useChatLayoutStore } from '../src/store/chat-layout'
import { useChatsStore } from '../src/store/chats'
import { TextField } from '../src/ui/primitives'
import { ThemeProvider } from '../src/ui/theme'
import { CONTROL_MIN_HEIGHT, type as typeScale } from '../src/ui/tokens'
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
    changeGateway: jest.fn(),
    extraHeaders: {},
    signOut: jest.fn()
  })
}))

jest.mock('../src/features/chats/ChatRuntime', () => ({ useChatRuntime: () => null }))

const bot = (name: string): Bot => ({
  name,
  displayName: name,
  description: '',
  model: 'example-provider/example-model',
  provider: 'example-provider',
  isDefault: false,
  hasAvatar: false,
  uiMetaRevision: 0,
  canonical: { id: `stored-${name}`, resolvedId: `stored-${name}`, preview: 'Hello.', lastActive: 1, messageCount: 2 }
})

beforeEach(() => {
  useBotsStore.getState().reset()
  useChatsStore.getState().reset()
  useChatLayoutStore.getState().reset()
  useBotsStore.getState().setBots([bot('researcher'), bot('writer')])
})

/**
 * `includeHiddenElements` is load-bearing for the icon: an icon hides itself from
 * assistive technology, and a hidden element is outside the default query.
 */
const hidden = { includeHiddenElements: true } as const

const flat = (testID: string): TextStyle => StyleSheet.flatten(screen.getByTestId(testID, hidden).props.style as never)

describe('the search field', () => {
  beforeEach(() => {
    renderScreen(<BotsScreen currentTab="chats" onOpenBot={() => {}} onOpenSection={() => {}} />)
  })

  it('gives the icon a slot the height of the text line, not the size of the mark', () => {
    // `-box` is the SLOT; the bare id is the mark. `Icon` keeps the two reachable
    // separately for exactly this assertion.
    const slot = flat('bots-search-icon-box')

    expect(slot.height).toBe(typeScale.preview.lineHeight)
    expect(slot.width).toBe(typeScale.preview.lineHeight)
    expect(slot.alignItems).toBe('center')
    expect(slot.justifyContent).toBe('center')

    // …and the MARK inside it is still the small inline one, unchanged.
    expect(screen.getByTestId('bots-search-icon', hidden).props.height).toBe(15)
  })

  it('states the field’s leading, so the box the icon was sized against exists', () => {
    const input = flat('bots-search')

    expect(input.fontSize).toBe(typeScale.preview.fontSize)
    expect(input.lineHeight).toBe(typeScale.preview.lineHeight)
  })

  it('adds no vertical padding of its own, and no height for one to be measured in', () => {
    const input = flat('bots-search')

    // iOS adds a vertical inset to a `TextInput` over whatever the style says, and
    // it is not symmetric. Zero here leaves the row's `alignItems: 'center'` as the
    // only thing deciding where the text sits, which is the whole fix.
    expect(input.paddingVertical).toBe(0)
    // The 44pt target belongs to the CONTROL, not to the text inside it. While it
    // lived on the input, the input was a 44pt box with a 20pt line in it and the
    // platform decided where in that box the line went.
    expect(input.minHeight).toBeUndefined()
  })

  it('keeps the 44pt tap target, on the row', () => {
    expect(flat('bots-search-field').minHeight).toBe(CONTROL_MIN_HEIGHT)
    expect(flat('bots-search-field').alignItems).toBe('center')
  })
})

describe('what a field calls itself', () => {
  const name = (element: { props: Record<string, unknown> }) => element.props.accessibilityLabel

  it('is the label, the given name or the placeholder, in that order', () => {
    render(
      <ThemeProvider>
        <TextField placeholder="Every 15 minutes" testID="only-placeholder" />
        <TextField label="Name" placeholder="Source scan" testID="label-wins" />
      </ThemeProvider>
    )

    expect(name(screen.getByTestId('only-placeholder'))).toBe('Every 15 minutes')
    expect(name(screen.getByTestId('label-wins'))).toBe('Name')
  })

  it('is absent rather than empty when there is none of the three', () => {
    // The chain used to end `?? ''`, and an `aria-label=""` REMOVES a name
    // instead of falling through to whatever the browser would have computed.
    // Nothing visibly broke, because it is only reachable with no label and no
    // placeholder — which is exactly the field that needed the fallback.
    render(
      <ThemeProvider>
        <TextField testID="anonymous" />
      </ThemeProvider>
    )

    expect(name(screen.getByTestId('anonymous'))).toBeUndefined()
  })
})

describe('every other field', () => {
  it('has no leading icon, which is why there is one entry above', () => {
    // `TextField` and `SecretField` are the app's other two. Neither renders an icon
    // beside its input — the day one does, it belongs in the describe above, and this
    // assertion is what will say so.
    const sources = [
      require('fs').readFileSync(`${__dirname}/../src/ui/primitives/TextField.tsx`, 'utf8'),
      require('fs').readFileSync(`${__dirname}/../src/ui/primitives/SecretField.tsx`, 'utf8')
    ]

    for (const source of sources) {
      expect(source).not.toMatch(/<Icon\b/)
    }
  })
})
