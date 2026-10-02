/**
 * Chat text size: the transcript's own type scale.
 *
 * Four things have to be true and each one is a different kind of failure:
 *
 *  1. the provider multiplies the tokens, and a scale of exactly 1 hands the
 *     SAME theme object through — a copy would invalidate every memo in the
 *     transcript for nothing;
 *  2. the scale reaches the conversation and stops there. A setting that also
 *     grew the header pill and the composer would be Dynamic Type with extra
 *     steps, and the footer in Settings promises it does not;
 *  3. it survives a round trip through `ui_meta`, tolerantly: a section written
 *     by a build that never heard of the field must leave this reader on their
 *     own size rather than be read as "they chose Default";
 *  4. it is reachable from Settings → Appearance.
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native'
import { Text as RNText } from 'react-native'

import { chatStrings } from '../src/chat-ui/strings'
import { ChatScreen } from '../src/features/chats/ChatScreen'
import { AppearanceSection } from '../src/features/settings/AppearanceSection'
import { resetActiveLocale, setActiveLocale } from '../src/i18n/active-locale'
import { type Bot, useBotsStore } from '../src/store/bots'
import { useChatsStore } from '../src/store/chats'
import { resetLanguageStore } from '../src/store/language'
import { useSettingsStore } from '../src/store/settings'
import { applySnapshot, snapshotFromStores } from '../src/store/ui-meta-bridge'
import { asTextSize, TEXT_SIZE_SCALE, textSizeScale } from '../src/store/text-size'
import { Text } from '../src/ui/primitives'
import { TypeScaleProvider, useTheme } from '../src/ui/theme'
import { renderScreen, withProviders } from './support/render'

let mockController: Record<string, jest.Mock>
let mockRuntime: {
  controller: Record<string, jest.Mock>
  bots: Record<string, never>
  push: { setOpenChat: jest.Mock }
}

jest.mock('../src/gateway', () => ({
  useGateway: () => ({ config: { baseUrl: 'https://gateway.example.com' }, http: null, status: 'ready' })
}))

jest.mock('../src/features/chats/ChatRuntime', () => ({
  useChatRuntime: () => mockRuntime
}))

jest.mock('../src/platform/haptics', () => ({ haptic: jest.fn() }))

jest.mock('../src/features/chats/attachments', () => ({
  MAX_ATTACHMENT_EDGE: 1568,
  openAppSettings: jest.fn(),
  pickAttachment: jest.fn(async () => null)
}))

const BOT: Bot = {
  name: 'researcher',
  displayName: 'Researcher',
  description: 'Finds things out.',
  model: 'example-provider/example-model',
  provider: 'example-provider',
  isDefault: false,
  hasAvatar: false,
  uiMetaRevision: 0,
  canonical: {
    id: 'stored-researcher',
    resolvedId: 'stored-researcher',
    preview: 'hello',
    lastActive: 1,
    messageCount: 2
  }
}

function makeController() {
  return {
    openChat: jest.fn(async () => undefined),
    closeChat: jest.fn(async () => undefined),
    readKeyFor: (name: string) => name,
    send: jest.fn(async () => undefined),
    stopTurn: jest.fn(async () => undefined),
    acknowledgeApproval: jest.fn(async () => undefined),
    respondApproval: jest.fn(async () => undefined),
    respondClarify: jest.fn(async () => undefined),
    lockClarify: jest.fn(async () => undefined),
    steerQueued: jest.fn(async () => 'queued'),
    editQueued: jest.fn(() => ''),
    deleteQueued: jest.fn(),
    steerSubagent: jest.fn(async () => 'ok'),
    interruptSubagent: jest.fn(async () => true),
    tailSubagent: jest.fn(async () => ''),
    querySlash: jest.fn(async () => ({ items: [] })),
    knowsSlashCommand: jest.fn(() => false),
    runSlash: jest.fn(async () => undefined),
    setOption: jest.fn(async () => ({})),
    refreshOptions: jest.fn(async () => null),
    refreshUsage: jest.fn(async () => null),
    modelOptions: jest.fn(async () => [])
  }
}

function seedChat() {
  useBotsStore.getState().reset()
  useChatsStore.getState().reset()
  useSettingsStore.getState().reset()
  useBotsStore.getState().setBots([BOT])

  const chats = useChatsStore.getState()

  chats.ensure('researcher', { storedSessionId: 'stored-researcher', resolvedSessionId: 'stored-researcher' })
  chats.bindRuntime('researcher', 'runtime-1')
  chats.dispatchEvent('researcher', {
    type: 'message.complete',
    session_id: 'runtime-1',
    payload: { text: 'Here is what I found.', status: 'ok' }
  })
}

beforeEach(() => {
  mockController = makeController()
  mockRuntime = { bots: {}, controller: mockController, push: { setOpenChat: jest.fn() } }
  seedChat()
})

/** The `fontSize` a rendered `Text` actually resolved to. */
function fontSizeOf(node: { props: { style?: unknown } }): number | undefined {
  const flat = ([] as unknown[]).concat(node.props.style as unknown[])

  for (const entry of flat) {
    const size = (entry as { fontSize?: number } | null)?.fontSize

    if (typeof size === 'number') {
      return size
    }
  }

  return undefined
}

describe('the type scale provider', () => {
  it('multiplies the tokens for its subtree', () => {
    render(
      withProviders(
        <TypeScaleProvider scale={TEXT_SIZE_SCALE.large}>
          <Text testID="scaled" variant="body">
            {'words'}
          </Text>
        </TypeScaleProvider>
      )
    )

    // 17 × 1.15 is 19.55, and the token is rounded to a tenth.
    expect(fontSizeOf(screen.getByTestId('scaled'))).toBe(19.5)
  })

  it('hands the same theme through at a scale of 1, so nothing memoised re-renders', () => {
    const seen: unknown[] = []

    function Probe() {
      seen.push(useTheme())

      return <RNText>{'.'}</RNText>
    }

    function Both() {
      const outer = useTheme()

      seen.push(outer)

      return (
        <TypeScaleProvider scale={1}>
          <Probe />
        </TypeScaleProvider>
      )
    }

    render(withProviders(<Both />))

    expect(seen).toHaveLength(2)
    expect(seen[0]).toBe(seen[1])
  })

  it('leaves everything but the type tokens alone', () => {
    const seen: { type: unknown; colors: unknown }[] = []

    function Probe() {
      const theme = useTheme()

      seen.push({ colors: theme.colors, type: theme.type })

      return <RNText>{'.'}</RNText>
    }

    function Both() {
      const outer = useTheme()

      seen.push({ colors: outer.colors, type: outer.type })

      return (
        <TypeScaleProvider scale={1.3}>
          <Probe />
        </TypeScaleProvider>
      )
    }

    render(withProviders(<Both />))

    expect(seen[0]?.colors).toBe(seen[1]?.colors)
    expect(seen[0]?.type).not.toBe(seen[1]?.type)
  })
})

describe('what the setting reaches', () => {
  it('grows the words in the transcript and leaves the header pill alone', async () => {
    renderScreen(<ChatScreen bot="researcher" />)

    await waitFor(() => expect(screen.getByText('Here is what I found.')).toBeTruthy())

    const before = fontSizeOf(screen.getByText('Here is what I found.'))
    const headerBefore = fontSizeOf(screen.getByText('researcher'))

    act(() => {
      useSettingsStore.getState().setTextSize('xlarge')
    })

    await waitFor(() => expect(fontSizeOf(screen.getByText('Here is what I found.'))).not.toBe(before))

    expect(fontSizeOf(screen.getByText('Here is what I found.'))).toBeGreaterThan(before ?? 0)
    // The chrome is outside the provider, which is the whole of the promise the
    // footer in Settings makes.
    expect(fontSizeOf(screen.getByText('researcher'))).toBe(headerBefore)
  })
})

describe('the setting itself', () => {
  it('is on Settings → Appearance, and writes the store', () => {
    renderScreen(<AppearanceSection onOpenAdvanced={() => undefined} />)

    fireEvent.press(screen.getByTestId('settings-text-size-large'))

    expect(useSettingsStore.getState().textSize).toBe('large')
  })

  it('rides in the app-wide ui_meta section', () => {
    act(() => {
      useSettingsStore.getState().setTextSize('small')
    })

    const app = snapshotFromStores().app as { textSize?: string }

    expect(app.textSize).toBe('small')
  })

  it('comes back from a gateway', () => {
    act(() => {
      applySnapshot({ app: { v: 1, textSize: 'xlarge' }, bots: {} })
    })

    expect(useSettingsStore.getState().textSize).toBe('xlarge')
  })

  it('leaves the reader on their own size when a section does not mention it', () => {
    act(() => {
      useSettingsStore.getState().setTextSize('large')
      applySnapshot({ app: { v: 1 }, bots: {} })
    })

    expect(useSettingsStore.getState().textSize).toBe('large')
  })

  it('ignores a value no build of this app ever wrote', () => {
    act(() => {
      useSettingsStore.getState().setTextSize('large')
      applySnapshot({ app: { v: 1, textSize: 'enormous' }, bots: {} })
    })

    expect(useSettingsStore.getState().textSize).toBe('large')
    expect(asTextSize('enormous')).toBeUndefined()
    expect(textSizeScale(undefined)).toBe(1)
  })
})

/**
 * HERM-125: the same four options — Small/Default/Large/Extra large — sit on
 * the identical `SegmentedRow` in Settings → Appearance and in the chat's own
 * options popover (`chatStrings.options.textSize`). Four segments leave far
 * less room per label than the three-way rows next to them, and "Extra
 * large"/"Extra groot"/"Sehr groß" do not fit one line at a phone's width in
 * any of the three languages — `numberOfLines={1}` clipped them to
 * "Standaa…" and "Extra gr…" rather than wrapping.
 *
 * The fix is in the shared control (`ui/sheets/controls.tsx`), so this proves
 * it once, on the Settings surface that needs no `ChatScreen` scaffolding —
 * the popover draws the exact same control from the exact same options.
 */
describe('the text-size segments do not truncate their labels (HERM-125)', () => {
  afterEach(() => {
    act(() => {
      resetLanguageStore()
    })
    resetActiveLocale()
  })

  it.each(['en', 'nl', 'de'] as const)('wraps rather than clipping the longest label in %s', locale => {
    setActiveLocale(locale)
    render(withProviders(<AppearanceSection onOpenAdvanced={() => undefined} />))

    // The label is unabridged — nobody shortened the string to make it fit —
    // and it is now allowed a second line instead of being forced onto one.
    const longest = screen.getByText(chatStrings.options.textSizes.xlarge as string)

    expect(longest.props.numberOfLines).toBe(2)

    // The shortest label is untouched: a row that already fit keeps fitting,
    // wrapping only where a label actually needs it.
    const shortest = screen.getByText(chatStrings.options.textSizes.small as string)

    expect(shortest.props.numberOfLines).toBe(2)
  })
})
