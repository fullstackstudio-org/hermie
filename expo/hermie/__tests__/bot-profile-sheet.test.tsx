/**
 * The bot profile sheet: what it writes, and where each thing lands.
 *
 * The sheet edits three things that live in three different places, and the
 * point of most of these tests is that they stay in those places. A sheet is
 * the one kind of screen where it is easy to quietly centralise state —
 * everything is visible at once, so it looks like one form — and the cost
 * would be paid by whoever moves the chat colour to per-account storage next
 * round.
 *
 * So: the colour goes to `chat-layout`, and only the description and the
 * picture become gateway calls. The last of those is the one that cannot be
 * checked any other way — there is no photo library in a test, so the picker
 * is mocked and what is asserted is that the bytes it returns are the bytes
 * that reach `profiles.set_asset`.
 */
import { act, fireEvent, waitFor } from '@testing-library/react-native'

import { BotProfileSheet } from '../src/features/bot-profile'
import type { ChatGateway } from '../src/gateway/link'
import { useBotsStore, type Bot } from '../src/store/bots'
import { useChatLayoutStore } from '../src/store/chat-layout'
import { useDeviceContextStore } from '../src/store/device-context'
import { renderScreen } from './support/render'

const mockLaunch = jest.fn()
const mockManipulate = jest.fn()

jest.mock('expo-image-picker', () => ({
  launchImageLibraryAsync: (...args: unknown[]) => mockLaunch(...args)
}))

jest.mock('expo-image-manipulator', () => ({
  manipulateAsync: (...args: unknown[]) => mockManipulate(...args),
  SaveFormat: { JPEG: 'jpeg' }
}))

const BOT: Bot = {
  name: 'researcher',
  displayName: 'Researcher',
  description: 'Reads things so you do not have to.',
  model: 'claude-sonnet-4-6-20251001',
  provider: 'anthropic',
  isDefault: false,
  hasAvatar: false,
  canonical: { id: 'sess-7', resolvedId: 'sess-7', preview: '', lastActive: 0, messageCount: 0 },
  uiMetaRevision: 3
}

/** A gateway that records every call and answers whatever the contract needs. */
function fakeGateway(): { gateway: ChatGateway; calls: { method: string; params: unknown }[] } {
  const calls: { method: string; params: unknown }[] = []

  const gateway = {
    request: jest.fn(async (method: string, params: unknown) => {
      calls.push({ method, params })

      return method === 'profiles.set_asset'
        ? { ok: true, asset: 'avatar', size: 3 }
        : { ok: true, applied: { description: true } }
    }),
    on: () => () => undefined,
    onAny: () => () => undefined,
    onRequest: () => () => undefined,
    onStatus: () => () => undefined,
    fetchMessages: async () => null
  } as unknown as ChatGateway

  return { gateway, calls }
}

function sheet(gateway: ChatGateway | null, onSaved?: () => void) {
  return renderScreen(
    <BotProfileSheet
      bot={BOT}
      gateway={gateway}
      gatewayVersion="0.21.3"
      onClose={() => undefined}
      visible
      {...(onSaved ? { onSaved } : {})}
    />
  )
}

beforeEach(() => {
  jest.clearAllMocks()
  mockManipulate.mockResolvedValue({ base64: 'PICKED', uri: 'file:///tmp/avatar.jpg' })

  useBotsStore.getState().reset()
  useBotsStore.getState().setBots([BOT])
  useChatLayoutStore.setState({ accents: {} })
  useDeviceContextStore.getState().reset()
  useDeviceContextStore.setState({
    loaded: true,
    baseUrl: 'https://gateway.example',
    gated: false,
    userId: 'u1',
    displayName: 'Sebas'
  })
})

describe('the read-only block', () => {
  it('writes the model id the way its maker writes it, not the way the wire does', () => {
    const tree = sheet(fakeGateway().gateway)

    expect(tree.getByText('Claude Sonnet 4.6')).toBeTruthy()
    expect(tree.queryByText(BOT.model)).toBeNull()
  })

  it('shows the session id and the gateway version it was given', () => {
    const tree = sheet(fakeGateway().gateway)

    expect(tree.getByText('sess-7')).toBeTruthy()
    expect(tree.getByText('0.21.3')).toBeTruthy()
  })

  /**
   * The display name IS a field, and the name the gateway reports is what the
   * empty field falls back to.
   *
   * No call a client has writes a profile's `display_name`, so the field is
   * Hermie's own name for the bot — see `features/bot-rename`. The roster's copy
   * is the placeholder, which is what says "this is what you will get if you
   * leave it alone" without pretending to be a value somebody typed.
   */
  it('offers a display-name field seeded by nothing and falling back to the roster', () => {
    const tree = sheet(fakeGateway().gateway)
    const field = tree.getByTestId('bot-profile-name')

    expect(field.props.value).toBe('')
    expect(field.props.placeholder).toBe('Researcher')
  })

  /** The handle is a fact on this sheet; moving it is its own button. */
  it('shows the profile name as a fact, with the rename behind its own action', () => {
    const tree = sheet(fakeGateway().gateway)

    expect(tree.getByText('researcher')).toBeTruthy()
    // No REST half was handed in, so there is nothing that could rename it.
    expect(tree.queryByTestId('bot-profile-name-rename')).toBeNull()
  })
})

describe('saving', () => {
  it('sends nothing at all until something has actually changed', () => {
    const tree = sheet(fakeGateway().gateway)

    expect(tree.getByTestId('bot-profile-save').props.accessibilityState.disabled).toBe(true)
  })

  it('writes an edited description through profiles.configure, under the profile name', async () => {
    const { gateway, calls } = fakeGateway()
    const tree = sheet(gateway)

    fireEvent.changeText(tree.getByTestId('bot-profile-description'), 'Reads the web.')
    await act(async () => {
      fireEvent.press(tree.getByTestId('bot-profile-save'))
    })

    await waitFor(() => expect(calls).toHaveLength(1))
    expect(calls[0]).toEqual({
      method: 'profiles.configure',
      params: { name: 'researcher', description: 'Reads the web.' }
    })
  })

  it('reports a refusal on the sheet rather than closing as though it had saved', async () => {
    const gateway = {
      request: jest.fn(async () => {
        throw new Error('Unknown profile: researcher')
      })
    } as unknown as ChatGateway

    const tree = sheet(gateway)

    fireEvent.changeText(tree.getByTestId('bot-profile-description'), 'Changed.')
    await act(async () => {
      fireEvent.press(tree.getByTestId('bot-profile-save'))
    })

    await waitFor(() => expect(tree.getByTestId('bot-profile-error')).toBeTruthy())
    expect(tree.getByTestId('bot-profile-error').props.children).toBe('Unknown profile: researcher')
  })

  it('has nothing to send while the connection is down', () => {
    const tree = sheet(null)

    fireEvent.changeText(tree.getByTestId('bot-profile-description'), 'Changed.')

    expect(tree.getByTestId('bot-profile-save').props.accessibilityState.disabled).toBe(true)
  })
})

describe('the picture', () => {
  /**
   * The upload path end to end: the bytes the picker produced are the bytes
   * `profiles.set_asset` is given, under the asset name the gateway stores a
   * profile picture as.
   */
  it('sends the picked bytes as the avatar asset', async () => {
    mockLaunch.mockResolvedValue({
      canceled: false,
      assets: [{ uri: 'file:///tmp/shot.png', width: 1200, height: 800 }]
    })

    const { gateway, calls } = fakeGateway()
    const tree = sheet(gateway)

    await act(async () => {
      fireEvent.press(tree.getByTestId('bot-profile-photo'))
    })
    await act(async () => {
      fireEvent.press(tree.getByTestId('bot-profile-save'))
    })

    await waitFor(() => expect(calls).toHaveLength(1))
    expect(calls[0]).toEqual({
      method: 'profiles.set_asset',
      params: { name: 'researcher', asset: 'avatar', data: 'PICKED' }
    })
  })

  it('crops to the centre square before it encodes, so the long edge is not kept', async () => {
    mockLaunch.mockResolvedValue({
      canceled: false,
      assets: [{ uri: 'file:///tmp/shot.png', width: 1200, height: 800 }]
    })

    const tree = sheet(fakeGateway().gateway)

    await act(async () => {
      fireEvent.press(tree.getByTestId('bot-profile-photo'))
    })

    const [, actions] = mockManipulate.mock.calls[0] as [string, Record<string, unknown>[]]

    expect(actions[0]).toEqual({ crop: { originX: 200, originY: 0, width: 800, height: 800 } })
    expect(actions[1]).toEqual({ resize: { width: 512, height: 512 } })
  })

  it('removes a picture with clear rather than by uploading nothing', async () => {
    const { gateway, calls } = fakeGateway()
    const tree = renderScreen(
      <BotProfileSheet
        avatarUri="data:image/png;base64,AAAA"
        bot={BOT}
        gateway={gateway}
        onClose={() => undefined}
        visible
      />
    )

    fireEvent.press(tree.getByTestId('bot-profile-photo-remove'))
    await act(async () => {
      fireEvent.press(tree.getByTestId('bot-profile-save'))
    })

    await waitFor(() => expect(calls).toHaveLength(1))
    expect(calls[0]).toEqual({
      method: 'profiles.set_asset',
      params: { name: 'researcher', asset: 'avatar', clear: true }
    })
  })

  it('treats a cancelled pick as nothing picked, not as a removal', async () => {
    mockLaunch.mockResolvedValue({ canceled: true, assets: null })

    const { gateway, calls } = fakeGateway()
    const tree = sheet(gateway)

    await act(async () => {
      fireEvent.press(tree.getByTestId('bot-profile-photo'))
    })

    expect(tree.getByTestId('bot-profile-save').props.accessibilityState.disabled).toBe(true)
    expect(calls).toHaveLength(0)
  })
})

describe('the colour', () => {
  /**
   * The sheet calls the EXISTING setter and stores nothing of its own. That is
   * the whole assertion: the colour is moving to per-account storage in another
   * round, and a second writer would have to be found and moved with it.
   */
  it('goes to the chat layout store, on the tap rather than on Save', () => {
    const { calls } = fakeGateway()
    const tree = sheet(fakeGateway().gateway)

    fireEvent.press(tree.getByTestId('swatch-bot-profile-researcher-teal'))

    expect(useChatLayoutStore.getState().accents.researcher).toBe('teal')
    expect(calls).toHaveLength(0)
  })
})
