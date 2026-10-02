/**
 * Holding a row, and the two things that hold can turn out to mean.
 *
 * The owner rejected the list's arrangement twice over the same sentence:
 * _"When I hold a chat I want to be able to move it right away."_ Holding one
 * did nothing. The reason was not the gesture — it was a key: the row's long
 * press armed the drag with the BOT'S NAME while the pan responder that claims
 * the gesture is keyed by the ROW KEY, `bot:<name>`. The two could never match,
 * so the responder never claimed anything and the only way to move a row was the
 * grip an edit mode used to reveal. A folder's header got this right, which is
 * why a folder could be dragged and a chat could not.
 *
 * So the first two assertions here are about the key, and they would both have
 * failed before this round.
 *
 * The rest is the conflict a long press now has to settle. Where the platform
 * draws its own context menu, UIKit opens one on the hold and cancels it when
 * the touch moves, and the drag arms underneath — that split is the platform's
 * and this app only stays out of its way. Where it does NOT (Android, the
 * browser, and this test environment), the app has to be the thing that
 * arbitrates: the sheet is held back until the press ends, and a press that
 * became a drag never opens it.
 *
 * `use-row-drag` is mocked, because what is under test is the WIRING — which key
 * the screen arms, and when it decides the hold was a menu. The hook's own
 * arithmetic is tested in `drag-reorder.test.ts` and `folders.test.ts`.
 */
import { act, fireEvent, screen } from '@testing-library/react-native'

import { BotsScreen } from '../src/features/bots'
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

/** Every key the screen armed, in order, and the drag's own report back to it. */
const armed: string[] = []
let startDrag: (rowKey: string) => void = () => undefined

jest.mock('../src/features/bots/use-row-drag', () => {
  const { Animated } = jest.requireActual('react-native')

  return {
    LIFT_SCALE: 1.03,
    useRowDrag: (options: { onDragStart?: (rowKey: string) => void }) => {
      // The one thing the screen gives the hook that this file cares about: the
      // callback that says the hold became a drag. Held in a module variable so
      // a test can fire it at the exact moment a real gesture would.
      startDrag = rowKey => options.onDragStart?.(rowKey)

      return {
        arm: (rowKey: string) => armed.push(rowKey),
        disarm: () => undefined,
        draggingKey: null,
        dropKey: null,
        lift: new Animated.Value(0),
        liftedKey: null,
        measure: () => undefined,
        offsetFor: () => new Animated.Value(0),
        onListLayout: () => undefined,
        onListScroll: () => undefined,
        onListTop: () => undefined,
        rowHandlers: () => ({}),
        translateY: new Animated.Value(0)
      }
    }
  }
})

const ROSTER: Bot[] = ['researcher', 'writer'].map(name => ({
  name,
  displayName: name,
  description: '',
  model: 'example-provider/example-model',
  provider: 'example-provider',
  isDefault: false,
  hasAvatar: false,
  uiMetaRevision: 0
}))

beforeEach(() => {
  armed.length = 0
  useBotsStore.getState().reset()
  useChatsStore.getState().reset()
  useChatLayoutStore.getState().reset()
  useBotsStore.getState().setBots(ROSTER)
})

describe('what a hold arms', () => {
  it('arms a chat with its ROW key, which is what the responder is keyed by', () => {
    renderScreen(<BotsScreen />)

    fireEvent(screen.getByTestId('bot-row-writer'), 'longPress')

    // Not `writer`. That was the whole defect.
    expect(armed).toEqual(['bot:writer'])
  })

  it('arms a folder with its own row key, the way it always did', () => {
    act(() => {
      useChatLayoutStore.getState().reconcile(['researcher', 'writer'])
    })

    const id = useChatLayoutStore.getState().addFolder('Finance')

    renderScreen(<BotsScreen />)
    fireEvent(screen.getByTestId(`folder-${id}`), 'longPress')

    expect(armed).toEqual([`folder:${id}`])
  })

  it('arms on every platform, not only where the system draws a menu', () => {
    // This environment has no native context menu — `HAS_NATIVE_CONTEXT_MENU`
    // probes for the local module and finds none — and arming used to be gated
    // on exactly that, so a phone's hold did nothing at all.
    renderScreen(<BotsScreen />)

    fireEvent(screen.getByTestId('bot-row-researcher'), 'longPress')

    expect(armed).toEqual(['bot:researcher'])
  })
})

describe('the menu a hold might have meant', () => {
  it('holds the sheet back while the press is still going', () => {
    renderScreen(<BotsScreen />)

    fireEvent(screen.getByTestId('bot-row-writer'), 'longPress')

    // Nothing yet: this press can still become a drag, and a sheet over the row
    // being lifted is the thing that cannot be taken back.
    expect(screen.queryByTestId('row-menu-open')).toBeNull()
  })

  it('opens it when the hold ends without moving', () => {
    renderScreen(<BotsScreen />)

    fireEvent(screen.getByTestId('bot-row-writer'), 'longPress')
    fireEvent(screen.getByTestId('bot-row-writer'), 'pressOut')

    expect(screen.getByTestId('row-menu-open')).toBeTruthy()
  })

  it('never opens it for a hold that became a drag', () => {
    renderScreen(<BotsScreen />)

    fireEvent(screen.getByTestId('bot-row-writer'), 'longPress')

    // The first move past the slop, which is where the hook reports back.
    act(() => startDrag('bot:writer'))

    // The press ends the moment the responder is claimed, so this fires during
    // the drag rather than after it — and it must not put a sheet over a row
    // that is in the air.
    fireEvent(screen.getByTestId('bot-row-writer'), 'pressOut')

    expect(screen.queryByTestId('row-menu-open')).toBeNull()
  })

  it('opens nothing for an ordinary tap, which arms nothing', () => {
    renderScreen(<BotsScreen />)

    fireEvent(screen.getByTestId('bot-row-writer'), 'pressOut')

    expect(screen.queryByTestId('row-menu-open')).toBeNull()
    expect(armed).toEqual([])
  })

  /**
   * The drawer's rows are keyed differently, and still reach their own menu.
   *
   * An archived chat is not in the arrangement's rows, so its key is
   * `archived:<name>` rather than `bot:<name>` — and the sheet is opened from
   * that key. A row whose key the screen could not read back would be a row with
   * no menu, which is how an archived chat would stop being unarchivable.
   */
  it('opens the sheet for an archived row, whose key is spelled differently', () => {
    act(() => {
      useChatLayoutStore.getState().reconcile(['researcher', 'writer'])
      useChatLayoutStore.getState().setArchived('writer', true)
    })

    renderScreen(<BotsScreen />)
    fireEvent.press(screen.getByTestId('archived-row'))

    fireEvent(screen.getByTestId('bot-row-writer'), 'longPress')
    fireEvent(screen.getByTestId('bot-row-writer'), 'pressOut')

    expect(screen.getByTestId('row-menu-open')).toBeTruthy()
  })
})
