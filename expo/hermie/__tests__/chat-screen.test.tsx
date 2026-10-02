/**
 * The chat screen's wiring.
 *
 * The stores, the selectors and `useChat` are all real here; only the
 * controller is a stand-in, because everything past it is a socket. So what
 * these assertions actually check is the path the screen is responsible for:
 * a reducer state becomes a rendered transcript, an open request becomes the
 * right sheet, and a tap becomes the right controller call with the right
 * arguments. The controller's own round trips are covered in
 * `chat-mockController.test.ts`.
 */
import { act, fireEvent, screen, waitFor } from '@testing-library/react-native'
import type * as ReactModule from 'react'
import { FlatList } from 'react-native'
import type * as ReactNativeModule from 'react-native'

import { ChatScreen } from '../src/features/chats/ChatScreen'
import { FileUploadError } from '../src/features/chats/file-upload'
import { haptic } from '../src/platform/haptics'
import { type Bot, useBotsStore } from '../src/store/bots'
import { useChatsStore } from '../src/store/chats'
import { useSettingsStore } from '../src/store/settings'
import { deferred, renderScreen, waitForGone } from './support/render'

// `mock`-prefixed so the factory below may close over it (Jest's hoisting rule).
let mockController: Record<string, jest.Mock>
// One runtime object per test, not one per render: `useChat` re-opens the chat
// whenever the runtime's identity changes, and a factory that built a fresh
// object every render re-ran `openChat` on every single re-render.
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

/*
  The keyboard seam, so a shortcut can be delivered without a keyboard.

  `mock`-prefixed, which is the only way a `jest.mock` factory may reach out of
  scope. Without this the real seam loads, asks the registry for `HermieMac`,
  gets nothing and subscribes to a module that is not there — which is the honest
  behaviour in a test renderer and also means nothing would ever fire.
*/
const mockShortcutListeners = new Set<(event: { action: string; typing: boolean }) => void>()

jest.mock('../src/platform/desktop-shortcuts', () => ({
  subscribeToShortcuts: (handler: (event: { action: string; typing: boolean }) => void) => {
    mockShortcutListeners.add(handler)

    return () => mockShortcutListeners.delete(handler)
  },
  setMenuBar: jest.fn(),
  isMenuBarInstalled: jest.fn(() => false)
}))

/*
  The memory browser is a page of its own, with its own plugin route and its own
  three empty states. What THIS file is responsible for is the swap — that the
  chat hands the browser a profile name and gets out of the way — so the browser
  stands in for itself here rather than dragging a gateway in behind it.
*/
jest.mock('../src/features/memory', () => {
  const { createElement } = jest.requireActual<typeof ReactModule>('react')
  const { Text: RNText } = jest.requireActual<typeof ReactNativeModule>('react-native')

  return {
    MemoryBotsScreen: ({ initialProfile, onClose }: { initialProfile?: string; onClose: () => void }) =>
      createElement(RNText, { onPress: onClose, testID: 'memory-bots' }, initialProfile)
  }
})

// The picker is a native module with no test implementation; the screen only
// ever awaits what it returns.
jest.mock('../src/features/chats/attachments', () => ({
  MAX_ATTACHMENT_EDGE: 1568,
  imageDimensions: jest.fn(async () => ({ height: 100, width: 100 })),
  openAppSettings: jest.fn(),
  pickAttachment: jest.fn(async () => null),
  resizeToBase64: jest.fn(async (uri: string, filename: string) => ({
    id: 'pasted-1',
    filename,
    base64: 'AAAA',
    uri
  }))
}))

const attachments = jest.requireMock('../src/features/chats/attachments') as {
  imageDimensions: jest.Mock
  openAppSettings: jest.Mock
  pickAttachment: jest.Mock
  resizeToBase64: jest.Mock
}

/*
  ⌘V's second half — see `composer.test.tsx` for the same mock and the reason
  it needs a `get`: `native-paste.ts` reads the registry once, at its own
  module load, so a captured reference would answer for the value it had at
  import time rather than whatever a test sets afterwards.
*/
let mockHasNativePasteboard = false
const mockReadPasteboardAttachment = jest.fn()

jest.mock('../src/platform/native-paste', () => ({
  get HAS_NATIVE_PASTEBOARD() {
    return mockHasNativePasteboard
  },
  readPasteboardAttachment: () => mockReadPasteboardAttachment()
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
    editQueued: jest.fn(() => 'and one more thing'),
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
    modelOptions: jest.fn(async () => [{ id: 'example-provider/other', label: 'other', provider: 'Example' }]),
    uploadFile: jest.fn(async (_botName: string, file: { name: string }) => ({
      path: `/work/project/uploads/hermie/2026-09-22/tok-${file.name}`,
      reference: `@file:/work/project/uploads/hermie/2026-09-22/tok-${file.name}`,
      filename: file.name,
      size: 10
    }))
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
    type: 'session.info',
    session_id: 'runtime-1',
    payload: { model: 'example-provider/example-model', yolo: false, fast: false, reasoning_effort: 'medium' }
  })
}

const renderChat = () => renderScreen(<ChatScreen bot="researcher" />)

beforeEach(() => {
  mockController = makeController()
  mockRuntime = { bots: {}, controller: mockController, push: { setOpenChat: jest.fn() } }
  attachments.openAppSettings.mockClear()
  attachments.pickAttachment.mockReset().mockResolvedValue(null)
  attachments.imageDimensions.mockReset().mockResolvedValue({ height: 100, width: 100 })
  attachments.resizeToBase64.mockReset().mockImplementation(async (uri: string, filename: string) => ({
    id: 'pasted-1',
    filename,
    base64: 'AAAA',
    uri
  }))
  mockHasNativePasteboard = true
  mockReadPasteboardAttachment.mockReset().mockResolvedValue([])
  seedChat()
})

/** ⌘V, as `desktop-shortcuts.ts` delivers it. */
function pressPaste() {
  act(() => {
    for (const listener of [...mockShortcutListeners]) {
      listener({ action: 'paste', typing: true })
    }
  })
}

describe('ChatScreen', () => {
  it('opens the chat and shows the bot in its header', async () => {
    renderChat()

    await waitFor(() =>
      expect(mockController.openChat).toHaveBeenCalledWith(expect.objectContaining({ name: 'researcher' }), {
        follow: true
      })
    )
    expect(screen.getByTestId('chat-header')).toBeTruthy()
    // The header leads with the profile name. `Researcher` is that handle in
    // different case, so there is one name here and the second line is the
    // status on its own.
    expect(screen.getByText('researcher')).toBeTruthy()
  })

  /**
   * HERM-110, the owner's call: the display name wins in the header outright
   * while the setting is on, whichever order `botNameOrder` is set to — the
   * order is what decides the second line's PRESENCE, not merely which of the
   * two names leads.
   */
  it('drops the second name from the header when Hide profile name is on, in either order', async () => {
    useBotsStore.getState().setBots([{ ...BOT, displayName: 'Netwerkbeheerder' }])
    // 'profile' would normally lead with the handle and print the display name
    // second; Hide profile name overrides that too.
    useSettingsStore.getState().setBotNameOrder('profile')

    renderChat()

    await waitFor(() => expect(screen.getByTestId('chat-header')).toBeTruthy())
    expect(screen.getByText('Netwerkbeheerder')).toBeTruthy()
    await waitForGone(() => screen.queryByTestId('chat-header-handle'), 'the handle under the header name')
  })

  it('shows the handle under the header when Hide profile name is off', async () => {
    useBotsStore.getState().setBots([{ ...BOT, displayName: 'Netwerkbeheerder' }])

    renderChat()

    // After the mount settles, not before: `ThemeProvider` hydrates the same
    // device-local key on mount, and asserting past that point is what makes
    // this the reader's own change rather than a race with it.
    await waitFor(() => expect(screen.getByTestId('chat-header')).toBeTruthy())

    act(() => {
      useSettingsStore.getState().setHideHandleWhenNamed(false)
    })

    expect(screen.getByTestId('chat-header-handle')).toHaveTextContent('researcher')
  })

  it('renders the transcript through the view settings', async () => {
    act(() => {
      useChatsStore.getState().dispatchEvent('researcher', {
        type: 'message.complete',
        session_id: 'runtime-1',
        payload: { text: 'Here is what I found.', status: 'ok' }
      })
    })

    renderChat()

    await waitFor(() => expect(screen.getByText('Here is what I found.')).toBeTruthy())
  })

  it('sends the draft through the controller and clears it', async () => {
    renderChat()

    fireEvent.changeText(screen.getByTestId('composer-input'), 'hello')
    fireEvent.press(screen.getByTestId('composer-send'))

    await waitFor(() => expect(mockController.send).toHaveBeenCalledWith('researcher', 'hello', []))
    expect(useChatsStore.getState().chats.researcher?.draft).toBe('')
    expect(haptic).toHaveBeenCalledWith('send')
  })

  it('goes to the END of the conversation on send, from wherever the reader was', async () => {
    // Reported from the iPad build: the transcript jumped to the TOP right after
    // a message went. Whatever produced it, the requirement is one line — your
    // own message is at the bottom and the bottom is where you are — and on an
    // inverted list that bottom is offset 0. Anything that scrolls by INDEX can
    // land at the far end; this never asks for one.
    const scrollToOffset = jest.spyOn(FlatList.prototype, 'scrollToOffset').mockImplementation(() => {})

    try {
      renderChat()

      // Up in the history, which is the case the jump was reported from.
      fireEvent.scroll(screen.getByTestId('transcript-list-scroll'), {
        nativeEvent: {
          contentOffset: { x: 0, y: 900 },
          contentSize: { height: 4000, width: 402 },
          layoutMeasurement: { height: 800, width: 402 }
        }
      })

      scrollToOffset.mockClear()

      fireEvent.changeText(screen.getByTestId('composer-input'), 'hello')
      fireEvent.press(screen.getByTestId('composer-send'))

      await waitFor(() => expect(mockController.send).toHaveBeenCalled())

      expect(scrollToOffset).toHaveBeenCalledWith({ animated: true, offset: 0 })
      // Nothing ever asked for the other end.
      for (const [call] of scrollToOffset.mock.calls) {
        expect((call as { offset: number }).offset).toBe(0)
      }
    } finally {
      scrollToOffset.mockRestore()
    }
  })

  it('keeps a staged attachment on screen until the send is actually accepted', async () => {
    // It used to be cleared optimistically, beside the draft. On a failure the
    // draft came back and the file did not — so the one thing the reader could
    // not retype was the one thing that vanished.
    attachments.pickAttachment.mockResolvedValueOnce({
      id: 'a1',
      filename: 'shot.jpg',
      base64: 'AAAA',
      uri: 'file:///tmp/shot.jpg'
    })
    mockController.send.mockRejectedValueOnce(new Error('gateway not connected'))
    renderChat()

    fireEvent.press(screen.getByTestId('composer-attach'))
    fireEvent.press(screen.getByTestId('composer-attach-menu-photo'))
    await waitFor(() => expect(screen.getByTestId('composer-attachments')).toBeTruthy())

    fireEvent.changeText(screen.getByTestId('composer-input'), 'look')
    fireEvent.press(screen.getByTestId('composer-send'))

    await waitFor(() => expect(screen.getByText(/gateway not connected/u)).toBeTruthy())
    expect(screen.getByTestId('composer-attachments')).toBeTruthy()

    // And it does go once a send lands, so the tray is not simply sticky.
    fireEvent.press(screen.getByTestId('composer-send'))
    await waitForGone(() => screen.queryByTestId('composer-attachments'), 'composer-attachments')
  })

  /**
   * HERM-126: a second Enter, or a tap on the send button, landing while the
   * first send was still in flight used to find the same chip still staged —
   * the tray only cleared once `chat.send` resolved — and fired the same
   * attachment a second time. A second, identical agent turn, with no undo.
   *
   * `mockController.send` is held open with a controllable promise so these
   * tests can assert what happens WHILE a send is outstanding, not only
   * before or after it.
   */
  describe('HERM-126: a second send while one is in flight', () => {
    async function attachPhoto(picked: { id: string; filename: string; base64: string; uri: string }) {
      attachments.pickAttachment.mockResolvedValueOnce(picked)

      fireEvent.press(screen.getByTestId('composer-attach'))
      fireEvent.press(screen.getByTestId('composer-attach-menu-photo'))
      // An image chip carries the id only on its own remove button — see
      // `Composer.tsx`, where a file chip's outer view gets
      // `composer-attachment-${id}` but an image's does not.
      await waitFor(() => expect(screen.getByTestId(`composer-attachment-remove-${picked.id}`)).toBeTruthy())
    }

    const SHOT = { id: 'a1', filename: 'shot.jpg', base64: 'AAAA', uri: 'file:///tmp/shot.jpg' }

    it('sends an attachment once when Enter is pressed twice before the first send settles', async () => {
      const first = deferred<void>()

      mockController.send.mockReturnValueOnce(first.promise)
      renderChat()
      await attachPhoto(SHOT)

      // The field is empty on both presses — the shape the owner reported.
      fireEvent(screen.getByTestId('composer-input'), 'submitEditing')
      await waitFor(() => expect(mockController.send).toHaveBeenCalledTimes(1))

      fireEvent(screen.getByTestId('composer-input'), 'submitEditing')

      first.resolve()
      await waitForGone(() => screen.queryByTestId('composer-attachments'), 'composer-attachments')
      expect(mockController.send).toHaveBeenCalledTimes(1)
      expect(mockController.send).toHaveBeenCalledWith('researcher', '', [{ filename: 'shot.jpg', base64: 'AAAA' }])
    })

    it('sends an attachment once when Enter is followed by a tap on the send button before the first send settles', async () => {
      const first = deferred<void>()

      mockController.send.mockReturnValueOnce(first.promise)
      renderChat()
      await attachPhoto(SHOT)

      fireEvent(screen.getByTestId('composer-input'), 'submitEditing')
      await waitFor(() => expect(mockController.send).toHaveBeenCalledTimes(1))

      fireEvent.press(screen.getByTestId('composer-send'))

      first.resolve()
      await waitForGone(() => screen.queryByTestId('composer-attachments'), 'composer-attachments')
      expect(mockController.send).toHaveBeenCalledTimes(1)
      expect(mockController.send).toHaveBeenCalledWith('researcher', '', [{ filename: 'shot.jpg', base64: 'AAAA' }])
    })

    it('restores every attachment exactly, in order and without duplicates, when the in-flight send fails', async () => {
      const first = { id: 'a1', filename: 'first.jpg', base64: 'AAAA', uri: 'file:///tmp/first.jpg' }
      const second = { id: 'a2', filename: 'second.jpg', base64: 'BBBB', uri: 'file:///tmp/second.jpg' }
      const failing = deferred<void>()

      mockController.send.mockReturnValueOnce(failing.promise)
      renderChat()
      await attachPhoto(first)
      await attachPhoto(second)

      fireEvent(screen.getByTestId('composer-input'), 'submitEditing')
      await waitFor(() => expect(mockController.send).toHaveBeenCalledTimes(1))

      failing.reject(new Error('gateway not connected'))
      await waitFor(() => expect(screen.getByText(/gateway not connected/u)).toBeTruthy())

      // Both chips are back, each exactly once — never dropped, never doubled.
      expect(screen.getAllByTestId('composer-attachment-remove-a1')).toHaveLength(1)
      expect(screen.getAllByTestId('composer-attachment-remove-a2')).toHaveLength(1)

      // And in the order they were staged in, which the next, successful
      // send proves: `first` still comes before `second` in the payload.
      mockController.send.mockResolvedValueOnce(undefined)
      fireEvent.press(screen.getByTestId('composer-send'))

      await waitFor(() => expect(mockController.send).toHaveBeenCalledTimes(2))
      expect(mockController.send).toHaveBeenNthCalledWith(2, 'researcher', '', [
        { filename: 'first.jpg', base64: 'AAAA' },
        { filename: 'second.jpg', base64: 'BBBB' }
      ])
    })

    it('still lets a genuine next send through once the first one has completed', async () => {
      const first = deferred<void>()

      mockController.send.mockReturnValueOnce(first.promise)
      renderChat()
      await attachPhoto(SHOT)

      fireEvent(screen.getByTestId('composer-input'), 'submitEditing')
      await waitFor(() => expect(mockController.send).toHaveBeenCalledTimes(1))

      first.resolve()
      await waitForGone(() => screen.queryByTestId('composer-attachments'), 'composer-attachments')

      // A second, later, and entirely different message — not a repeat of
      // the first — sent only after the first one is done.
      fireEvent.changeText(screen.getByTestId('composer-input'), 'and one more thing')
      fireEvent.press(screen.getByTestId('composer-send'))

      await waitFor(() => expect(mockController.send).toHaveBeenCalledTimes(2))
      expect(mockController.send).toHaveBeenLastCalledWith('researcher', 'and one more thing', [])
    })
  })

  it('stages a pasted image the same way the photo picker does', async () => {
    mockReadPasteboardAttachment.mockResolvedValue([
      {
        uri: 'file:///tmp/hermie-paste/1/pasted-image.png',
        name: 'pasted-image.png',
        size: 4096,
        mimeType: 'image/png'
      }
    ])
    renderChat()

    fireEvent(screen.getByTestId('composer-input'), 'focus')
    pressPaste()

    await waitFor(() => expect(screen.getByTestId('composer-attachments')).toBeTruthy())
    expect(attachments.imageDimensions).toHaveBeenCalledWith('file:///tmp/hermie-paste/1/pasted-image.png')
    expect(attachments.resizeToBase64).toHaveBeenCalledWith(
      'file:///tmp/hermie-paste/1/pasted-image.png',
      'pasted-image.png',
      100,
      100
    )

    fireEvent.changeText(screen.getByTestId('composer-input'), 'look')
    fireEvent.press(screen.getByTestId('composer-send'))

    await waitFor(() => expect(mockController.send).toHaveBeenCalled())
  })

  it('stages a pasted file through the same upload the "+" menu uses, and shows the existing error when it is too large', async () => {
    mockReadPasteboardAttachment.mockResolvedValue([
      { uri: 'file:///tmp/hermie-paste/2/report.pdf', name: 'report.pdf', size: 4096, mimeType: 'application/pdf' }
    ])
    mockController.uploadFile.mockRejectedValueOnce(
      new FileUploadError('too-large', 'report.pdf is 200.0 MB. The gateway accepts up to 100.0 MB.')
    )
    renderChat()

    fireEvent(screen.getByTestId('composer-input'), 'focus')
    pressPaste()

    // The existing chip error, unchanged by which door the file came through —
    // `uploadChipError` reads `FileUploadError.reason`, not how `stageFile` was
    // reached. The chip stays on screen with the error rather than vanishing:
    // `stageFile` marks it `'error'`, it does not remove it.
    await waitFor(() => expect(screen.getByText(/100 MB max/u)).toBeTruthy())
    expect(screen.getByTestId('composer-attachments-pending')).toBeTruthy()
  })

  it('adds every file from one paste, sorted onto the right road each', async () => {
    mockReadPasteboardAttachment.mockResolvedValue([
      { uri: 'file:///tmp/a.png', name: 'a.png', size: 10, mimeType: 'image/png' },
      { uri: 'file:///tmp/b.pdf', name: 'b.pdf', size: 20, mimeType: 'application/pdf' }
    ])
    renderChat()

    fireEvent(screen.getByTestId('composer-input'), 'focus')
    pressPaste()

    await waitFor(() => expect(attachments.resizeToBase64).toHaveBeenCalled())
    await waitFor(() => expect(mockController.uploadFile).toHaveBeenCalled())
  })

  it('leaves the field alone for a plain-text paste: no attachment, no upload', async () => {
    mockReadPasteboardAttachment.mockResolvedValue([])
    renderChat()

    fireEvent(screen.getByTestId('composer-input'), 'focus')
    fireEvent.changeText(screen.getByTestId('composer-input'), 'copied words')
    pressPaste()

    await waitFor(() => expect(mockReadPasteboardAttachment).toHaveBeenCalled())
    expect(attachments.resizeToBase64).not.toHaveBeenCalled()
    expect(mockController.uploadFile).not.toHaveBeenCalled()
    expect(screen.queryByTestId('composer-attachments')).toBeNull()
  })

  it('buzzes once when a reply lands and not when a turn merely runs', async () => {
    renderChat()

    act(() => {
      useChatsStore.getState().beginTurn('researcher', 'do a thing')
    })
    await waitFor(() => expect(screen.getByTestId('composer-stop')).toBeTruthy())

    expect(jest.mocked(haptic).mock.calls.filter(([moment]) => moment === 'complete')).toHaveLength(0)

    act(() => {
      useChatsStore
        .getState()
        .dispatchEvent('researcher', { type: 'message.complete', seq: 90, payload: { text: 'done' } })
    })

    await waitFor(() =>
      expect(jest.mocked(haptic).mock.calls.filter(([moment]) => moment === 'complete')).toHaveLength(1)
    )
  })

  /**
   * The line under the bot's name, driven the way a turn drives it.
   *
   * The selector has its own table in `@hermie/transcript`; what is asserted
   * here is that the header is reading it at all — the previous line said
   * `Working…` from the first frame of a turn to the last, and the way that
   * survived was that nothing ever looked at it.
   */
  it('says what the bot is doing, and goes quiet when it stops', async () => {
    renderChat()

    act(() => {
      useChatsStore.getState().beginTurn('researcher', 'do a thing')
    })
    await waitFor(() => expect(screen.getByText('Working…')).toBeTruthy())

    act(() => {
      useChatsStore
        .getState()
        .dispatchEvent('researcher', { type: 'reasoning.delta', seq: 91, payload: { text: 'Let me think.' } })
    })
    await waitFor(() => expect(screen.getByText('Thinking…')).toBeTruthy())

    act(() => {
      useChatsStore
        .getState()
        .dispatchEvent('researcher', { type: 'message.delta', seq: 92, payload: { text: 'Right — ' } })
    })
    await waitFor(() => expect(screen.getByText('Typing…')).toBeTruthy())

    act(() => {
      useChatsStore
        .getState()
        .dispatchEvent('researcher', { type: 'tool.start', seq: 93, payload: { tool_id: 'c1', name: 'terminal' } })
    })
    await waitFor(() => expect(screen.getByText('Running terminal…')).toBeTruthy())

    act(() => {
      useChatsStore
        .getState()
        .dispatchEvent('researcher', { type: 'message.complete', seq: 94, payload: { text: 'Right — done.' } })
    })
    await waitFor(() => expect(screen.getByText('Online')).toBeTruthy())
  })

  it('stops a running turn instead of sending', async () => {
    renderChat()

    act(() => {
      useChatsStore.getState().beginTurn('researcher', 'do a thing')
    })

    // The one round button becomes a stop square while a turn runs.
    await waitFor(() => expect(screen.getByTestId('composer-stop')).toBeTruthy())
    fireEvent.press(screen.getByTestId('composer-stop'))

    await waitFor(() => expect(mockController.stopTurn).toHaveBeenCalledWith('researcher'))
    expect(mockController.send).not.toHaveBeenCalled()
  })

  it('raises the approval sheet for an open request and answers it', async () => {
    renderChat()

    act(() => {
      useChatsStore.getState().dispatchServerRequest('researcher', {
        id: 'srq-7',
        method: 'approval',
        params: { command: 'rm -rf build', choices: ['once', 'deny'], request_id: 'appr-7' }
      })
    })

    await waitFor(() => expect(screen.getByTestId('approval-sheet')).toBeTruthy())
    expect(screen.getByTestId('approval-command')).toHaveTextContent('rm -rf build')

    // The queue is told a human is looking before any answer goes back.
    await waitFor(() => expect(mockController.acknowledgeApproval).toHaveBeenCalledWith('researcher', 'srq-7'))

    // The choices are disabled for 400 ms after the sheet appears (ADR-0010:
    // a sheet that opens under a travelling finger must not answer for it), so
    // the press is retried until the guard has released.
    await waitFor(() => {
      fireEvent.press(screen.getByTestId('approval-choice-once'))

      expect(mockController.respondApproval).toHaveBeenCalledWith('researcher', 'srq-7', 'once', undefined)
    })
    expect(haptic).toHaveBeenCalledWith('choice')
  })

  it('closes the approval sheet on the tap, with the answer still in flight', async () => {
    // The sheet used to wait for `approval.respond` to come back and then sit
    // for two seconds saying "Answered: Allow once". It leaves on the tap now:
    // the RPC is a background errand, and the only thing that waits for it is
    // the question's own row in the transcript.
    const answering = deferred<undefined>()
    let settled = false

    void answering.promise.then(() => {
      settled = true
    })

    mockController.respondApproval.mockImplementationOnce(() => answering.promise)

    renderChat()

    act(() => {
      useChatsStore.getState().dispatchServerRequest('researcher', {
        id: 'srq-8',
        method: 'approval',
        params: { command: 'rm -rf build', choices: ['once', 'deny'], request_id: 'appr-8' }
      })
    })

    await waitFor(() => expect(screen.getByTestId('approval-sheet')).toBeTruthy())

    await waitFor(() => {
      fireEvent.press(screen.getByTestId('approval-choice-once'))

      expect(mockController.respondApproval).toHaveBeenCalledWith('researcher', 'srq-8', 'once', undefined)
    })

    // Gone one slide-out later — and the answer has not been anywhere: nothing
    // resolves that promise until the assertion below has run.
    await waitForGone(() => screen.queryByTestId('approval-sheet'), 'approval-sheet', { timeout: 4000 })
    expect(settled).toBe(false)

    // Still open, still in the transcript, with the way back to it.
    expect(screen.getByText('Answer')).toBeTruthy()

    answering.resolve(undefined)
  })

  it('shows one question at a time, oldest first', async () => {
    renderChat()

    act(() => {
      const chats = useChatsStore.getState()

      chats.dispatchServerRequest('researcher', {
        id: 'srq-1',
        method: 'approval',
        params: { command: 'first', choices: ['once'], request_id: 'appr-1' }
      })
      chats.dispatchServerRequest('researcher', {
        id: 'srq-2',
        method: 'clarify',
        params: { question: 'Which tone?', choices: ['Formal'], request_id: 'clar-2' }
      })
    })

    await waitFor(() => expect(screen.getByTestId('approval-sheet')).toBeTruthy())
    expect(screen.queryByTestId('clarify-sheet')).toBeNull()
  })

  it('answers a clarify through the controller', async () => {
    renderChat()

    act(() => {
      useChatsStore.getState().dispatchServerRequest('researcher', {
        id: 'srq-9',
        method: 'clarify',
        params: { question: 'Which tone?', choices: ['Formal', 'Playful'], request_id: 'clar-9' }
      })
    })

    await waitFor(() => expect(screen.getByTestId('clarify-sheet')).toBeTruthy())

    fireEvent.press(screen.getByTestId('clarify-choice-Playful'))
    fireEvent.press(screen.getByTestId('clarify-submit'))

    await waitFor(() =>
      expect(mockController.respondClarify).toHaveBeenCalledWith('researcher', 'srq-9', { 'clar-9': 'Playful' })
    )
  })

  it('sets a gateway option from the options sheet', async () => {
    renderChat()

    fireEvent.press(screen.getByTestId('chat-header-options'))

    await waitFor(() => expect(screen.getByTestId('chat-options-sheet')).toBeTruthy())
    fireEvent.press(screen.getByTestId('option-yolo'))

    await waitFor(() =>
      expect(mockController.setOption).toHaveBeenCalledWith('researcher', 'yolo', 'true', {
        confirmExpensiveModel: false
      })
    )
  })

  /**
   * The one switch whose values are not booleans.
   *
   * `config.set {key:'fast'}` is parsed against the gateway's own word list, so
   * `true` came back as 4002 "unknown fast mode: true" and the switch snapped
   * back on every tap. Its neighbour really does take `true`, which is why this
   * went unnoticed: one of the two worked.
   */
  it('sends fast mode as a word the gateway knows, not as a boolean', async () => {
    renderChat()

    fireEvent.press(screen.getByTestId('chat-header-options'))

    await waitFor(() => expect(screen.getByTestId('chat-options-sheet')).toBeTruthy())
    fireEvent.press(screen.getByTestId('option-fast'))

    await waitFor(() =>
      expect(mockController.setOption).toHaveBeenCalledWith('researcher', 'fast', 'fast', {
        confirmExpensiveModel: false
      })
    )
  })

  it('switches fast mode back off with the word for off, not with false', async () => {
    act(() => {
      useChatsStore.getState().dispatchEvent('researcher', {
        type: 'session.info',
        session_id: 'runtime-1',
        payload: { model: 'example-provider/example-model', yolo: false, fast: true, reasoning_effort: 'medium' }
      })
    })
    renderChat()

    fireEvent.press(screen.getByTestId('chat-header-options'))

    await waitFor(() => expect(screen.getByTestId('chat-options-sheet')).toBeTruthy())
    fireEvent.press(screen.getByTestId('option-fast'))

    await waitFor(() =>
      expect(mockController.setOption).toHaveBeenCalledWith('researcher', 'fast', 'normal', {
        confirmExpensiveModel: false
      })
    )
  })

  /**
   * A gateway may refuse the mode itself — "fast mode is not available for this
   * model" is a 4002 as well. The reader has to be told, and the switch has to
   * go back to what the gateway holds rather than sit there claiming a mode
   * nothing accepted.
   */
  it('reports a refused fast mode and leaves the switch where the gateway has it', async () => {
    mockController.setOption.mockRejectedValueOnce(new Error('fast mode is not available for this model'))
    renderChat()

    fireEvent.press(screen.getByTestId('chat-header-options'))

    await waitFor(() => expect(screen.getByTestId('chat-options-sheet')).toBeTruthy())
    fireEvent.press(screen.getByTestId('option-fast'))

    await waitFor(() => expect(mockController.setOption).toHaveBeenCalled())

    // Nothing dispatched a `session.info`, so the switch still reads what the
    // gateway last said — off — rather than staying where the tap put it.
    expect(screen.getByTestId('option-fast').props.accessibilityState?.checked).toBe(false)

    // The sheet is a modal, so the banner underneath it is only reachable once
    // the reader is done with the sheet. That is where the refusal is waiting.
    fireEvent.press(screen.getByTestId('chat-options-done'))

    await waitFor(() =>
      expect(screen.getByTestId('chat-notice')).toHaveTextContent(
        'Setting not changed: fast mode is not available for this model'
      )
    )
    // NOT the open-failure sentence. The conversation is open, readable and
    // still streaming; only the setting was refused.
    expect(screen.queryByText(/could not be opened/u)).toBeNull()
    // And no Try again: reloading rebuilds a conversation that is already here.
    expect(screen.queryByText('Try again')).toBeNull()
    expect(screen.getByTestId('chat-error-dismiss')).toBeTruthy()
  })

  it('keeps verbosity local to the app rather than sending it to the gateway', async () => {
    renderChat()

    fireEvent.press(screen.getByTestId('chat-header-options'))
    await waitFor(() => expect(screen.getByTestId('chat-options-sheet')).toBeTruthy())

    fireEvent.press(screen.getByTestId('option-verbosity-quiet'))

    await waitFor(() => expect(useSettingsStore.getState().perChat.researcher?.level).toBe('quiet'))
    expect(mockController.setOption).not.toHaveBeenCalled()
  })

  it('offers "use the default" once the chat pins its own view, and resets it', async () => {
    useSettingsStore.getState().setChatView('researcher', { level: 'verbose' })
    renderChat()

    fireEvent.press(screen.getByTestId('chat-header-options'))
    await waitFor(() => expect(screen.getByTestId('option-use-default')).toBeTruthy())

    fireEvent.press(screen.getByTestId('option-use-default'))

    await waitFor(() => expect(useSettingsStore.getState().perChat.researcher).toBeUndefined())
  })

  it('asks before switching to a model the gateway flagged as expensive', async () => {
    mockController.setOption.mockResolvedValueOnce({ confirmRequired: true, confirmMessage: 'That one bills more.' })
    renderChat()

    fireEvent.press(screen.getByTestId('chat-header-options'))
    await waitFor(() => expect(screen.getByTestId('chat-options-sheet')).toBeTruthy())

    fireEvent.press(screen.getByTestId('option-model'))
    await waitFor(() => expect(screen.getByTestId('picker-option-example-provider/other')).toBeTruthy())
    fireEvent.press(screen.getByTestId('picker-option-example-provider/other'))

    await waitFor(() => expect(screen.getByTestId('option-model-confirm')).toBeTruthy())
    fireEvent.press(screen.getByTestId('option-model-confirm'))

    await waitFor(() =>
      expect(mockController.setOption).toHaveBeenLastCalledWith('researcher', 'model', 'example-provider/other', {
        confirmExpensiveModel: true
      })
    )
  })

  it('pins the agents bar while children are running', async () => {
    renderChat()

    expect(screen.queryByTestId('agents-bar')).toBeNull()

    act(() => {
      useChatsStore.getState().dispatchEvent('researcher', {
        type: 'subagent.start',
        session_id: 'runtime-1',
        payload: { subagent_id: 'sub-1', goal: 'Read the docs', task_index: 0, task_count: 1 }
      })
    })

    await waitFor(() => expect(screen.getByTestId('agents-bar')).toBeTruthy())
  })

  it('says so when no bot is selected', () => {
    renderScreen(<ChatScreen />)

    expect(screen.getByText('Pick a conversation to start reading.')).toBeTruthy()
  })

  it('presents a request that arrives while the options sheet is open', async () => {
    renderChat()

    fireEvent.press(screen.getByTestId('chat-header-options'))
    await waitFor(() => expect(screen.getByTestId('chat-options-sheet')).toBeTruthy())

    act(() => {
      useChatsStore.getState().dispatchServerRequest('researcher', {
        id: 'srq-11',
        method: 'approval',
        params: { command: 'rm -rf build', choices: ['once', 'deny'], request_id: 'appr-11' }
      })
    })

    // This is the one the four sibling modals lost: iOS presented the options
    // sheet and never showed the question underneath it.
    await waitFor(() => expect(screen.getByTestId('approval-sheet')).toBeTruthy())
    expect(screen.queryByTestId('chat-options-sheet')).toBeNull()
  })

  it('keeps saying it is waiting for you after a question is put aside', async () => {
    renderChat()

    act(() => {
      useChatsStore.getState().dispatchServerRequest('researcher', {
        id: 'srq-12',
        method: 'clarify',
        params: { question: 'Which tone?', choices: ['Formal'], request_id: 'clar-12' }
      })
    })

    await waitFor(() => expect(screen.getByTestId('clarify-sheet')).toBeTruthy())
    fireEvent.press(screen.getByTestId('clarify-skip'))

    // "Later" takes the sheet away and nothing else: the agent is still
    // blocked, so the header must not go back to the idle label.
    // The sheet leaves after its close animation (or the host's settle
    // fallback), which can take longer than the default wait on a slow runner.
    await waitForGone(() => screen.queryByTestId('clarify-sheet'), 'clarify-sheet', { timeout: 4000 })
    expect(screen.getByText('Waiting for you')).toBeTruthy()
    // …and the transcript still offers the way back to it.
    expect(screen.getByText('Answer')).toBeTruthy()
  })

  it('counts messages rather than rows in the jump-to-latest pill', async () => {
    renderChat()

    // Scroll away from the bottom (the list is inverted: offset 0 IS the
    // bottom), which is the only state in which the pill counts anything.
    act(() => {
      fireEvent.scroll(screen.getByTestId('transcript-list-scroll'), {
        nativeEvent: {
          contentInset: { bottom: 0, left: 0, right: 0, top: 0 },
          contentOffset: { x: 0, y: 400 },
          contentSize: { height: 2000, width: 402 },
          layoutMeasurement: { height: 874, width: 402 }
        }
      })
    })

    await waitFor(() => expect(screen.getByText('Jump to latest')).toBeTruthy())

    act(() => {
      // A tool call and a status row are not messages. Counting them announced
      // "4 new" for one `ls`.
      useChatsStore.getState().dispatchEvent('researcher', {
        type: 'tool.start',
        session_id: 'runtime-1',
        payload: { tool_id: 'call_1', name: 'bash', args: { command: 'ls' } }
      })
      useChatsStore.getState().dispatchEvent('researcher', {
        type: 'tool.complete',
        session_id: 'runtime-1',
        payload: { tool_id: 'call_1', name: 'bash', result: { ok: true } }
      })
    })

    // The pill carries the count as a badge beside its own name, so the number
    // is what appears and disappears — and it says it in the label too, for
    // anyone who cannot see a badge.
    expect(screen.queryByLabelText(/Jump to latest, \d+ new/u)).toBeNull()

    act(() => {
      /*
        And a teammate's message is not one either.

        The owner's rule reaches this count as well as the chat list's: a
        scrolled-up reader told "2 new" who scrolls down to two asides between
        two agents has been sent for nothing. The dispatch and the inbound reply
        are both here, because they are two different item kinds and an `if` that
        caught only one of them would still announce the other.
      */
      useChatsStore.getState().dispatchEvent('researcher', {
        type: 'tool.start',
        session_id: 'runtime-1',
        payload: { tool_id: 'call_dm_9', name: 'message_agent', args: { target: '@writer', message: 'ping' } }
      })
      useChatsStore.getState().dispatchEvent('researcher', {
        type: 'tool.complete',
        session_id: 'runtime-1',
        payload: { tool_id: 'call_dm_9', name: 'message_agent', result: { status: 'queued', to: 'writer' } }
      })
      // The inbound half lands as its own item kind rather than through
      // `message.start`: a foreign `message.start` carries no author, so the
      // live path stands up a blank placeholder and only `session.resume` or a
      // hydration tells it who spoke (ADR-0018).
      useChatsStore.getState().update('researcher', state => ({
        ...state,
        items: {
          ...state.items,
          'dm-in-1': {
            id: 'dm-in-1',
            kind: 'bot_dm_in',
            origin: 'live',
            senderHandle: 'writer',
            senderName: 'Writer',
            seq: 9000,
            text: 'on it',
            ts: 1_700_000_100,
            version: 0
          } as never
        },
        order: [...state.order, 'dm-in-1']
      }))
    })

    expect(screen.queryByLabelText(/Jump to latest, \d+ new/u)).toBeNull()

    act(() => {
      useChatsStore.getState().dispatchEvent('researcher', {
        type: 'message.complete',
        session_id: 'runtime-1',
        payload: { text: 'Here it is.', status: 'ok' }
      })
    })

    await waitFor(() => expect(screen.getByLabelText(/Jump to latest, 1 new/u)).toBeTruthy())
    expect(screen.getByText('1')).toBeTruthy()
  })

  it('offers the way out of a refused photo picker, and only for that', async () => {
    attachments.pickAttachment.mockRejectedValueOnce(
      new Error('Hermie needs access to your photo library to attach an image. Allow it in Settings.')
    )
    renderChat()

    // The "+" opens the menu; the photo picker is its own entry.
    fireEvent.press(screen.getByTestId('composer-attach'))
    fireEvent.press(screen.getByTestId('composer-attach-menu-photo'))

    await waitFor(() => expect(screen.getByTestId('chat-open-settings')).toBeTruthy())
    fireEvent.press(screen.getByTestId('chat-open-settings'))
    expect(attachments.openAppSettings).toHaveBeenCalled()

    // Any other failure has no such button: there is nothing in Settings to fix.
    fireEvent.press(screen.getByTestId('chat-error-dismiss'))
    attachments.pickAttachment.mockRejectedValueOnce(new Error('the picker exploded'))
    // The menu closed itself when the picker went away, so this opens it again —
    // which is the behaviour that stops a cancelled picker leaving the menu
    // standing over the composer.
    fireEvent.press(screen.getByTestId('composer-attach'))
    fireEvent.press(screen.getByTestId('composer-attach-menu-photo'))

    await waitFor(() => expect(screen.getByText(/the picker exploded/u)).toBeTruthy())
    expect(screen.queryByTestId('chat-open-settings')).toBeNull()
  })

  /**
   * The `+` menu used to be an ordinary child above the composer row, so opening
   * it added its own height to the composer — and a composer that grows pushes
   * the transcript up. Tapping `+` moved the conversation the reader was
   * looking at, which is the one thing a menu must not do.
   *
   * What a test renderer can see is the structure that decides it: the popover
   * is positioned absolutely off the composer's bottom edge, so it is drawn over
   * the transcript and contributes nothing to the composer's layout, and the
   * row's own style is untouched by it.
   */
  it('floats the attach menu over the transcript instead of growing the composer', () => {
    renderChat()

    const rowStyleClosed = JSON.stringify(screen.getByTestId('composer-row').props.style)
    expect(screen.queryByTestId('composer-attach-backdrop', HIDDEN)).toBeNull()

    fireEvent.press(screen.getByTestId('composer-attach'))

    // The popover's wrapper takes the composer out of the question entirely.
    const floated = screen.getByTestId('composer-attach-layer')
    expect(flatStyle(floated.props.style)).toMatchObject({ bottom: expect.any(Number), position: 'absolute' })
    expect(within(floated, screen.getByTestId('composer-attach-menu'))).toBe(true)

    // And the row it sits over is the same row it was before the tap.
    expect(JSON.stringify(screen.getByTestId('composer-row').props.style)).toBe(rowStyleClosed)
  })

  it('puts the attach menu away on a tap outside it', () => {
    renderChat()

    fireEvent.press(screen.getByTestId('composer-attach'))
    expect(screen.getByTestId('composer-attach-menu')).toBeTruthy()

    // Hidden from VoiceOver on purpose — it is a tap catcher, not a control, and
    // the gesture that dismisses a popover for a screen reader is its own.
    fireEvent.press(screen.getByTestId('composer-attach-backdrop', HIDDEN))

    // The menu itself is still mounted for one exit — it animates out now that it
    // has no tail to say where it came from — but it is inert while it goes and
    // the catcher is gone on the frame.
    expect(screen.getByTestId('composer-attach-appear').props.pointerEvents).toBe('none')
    expect(screen.queryByTestId('composer-attach-backdrop', HIDDEN)).toBeNull()
  })

  it('dismisses a controller error from the banner', async () => {
    mockController.openChat.mockRejectedValueOnce(new Error('gateway not connected'))
    renderChat()

    // A chat that would not open keeps its own sentence, and its Try again.
    await waitFor(() =>
      expect(screen.getByTestId('chat-notice')).toHaveTextContent(
        'This conversation could not be opened: gateway not connected'
      )
    )
    expect(screen.getByText('Try again')).toBeTruthy()

    fireEvent.press(screen.getByTestId('chat-error-dismiss'))

    // "Done" used to clear only the screen's own notice, so a failed open left
    // a banner no button on it could remove.
    await waitForGone(() => screen.queryByText(/gateway not connected/u), 'the text /gateway not connected/u')
  })
})

/** The tap catcher is hidden from accessibility, which is what this opts past. */
const HIDDEN = { includeHiddenElements: true } as const

/** Is `node` anywhere under `root`? The test renderer has no `contains`. */
function within(root: { findAll: (predicate: (node: unknown) => boolean) => unknown[] }, node: unknown): boolean {
  return root.findAll(candidate => candidate === node).length > 0
}

/** One object out of whatever a style prop happens to be: array, nested, or plain. */
function flatStyle(style: unknown): Record<string, unknown> {
  if (Array.isArray(style)) {
    return style.reduce<Record<string, unknown>>((merged, entry) => ({ ...merged, ...flatStyle(entry) }), {})
  }

  return (style ?? {}) as Record<string, unknown>
}

describe('following a DM across chats', () => {
  /** Writer's chat, holding the inbound view of a message researcher sent. */
  function seedWriter(at: number, text: string) {
    useChatsStore.getState().ensure('writer', { storedSessionId: 'stored-writer', resolvedSessionId: 'stored-writer' })
    useChatsStore.getState().update('writer', state => ({
      ...state,
      items: {
        'w:1': {
          id: 'w:1',
          kind: 'bot_dm_in',
          origin: 'history',
          senderHandle: 'researcher',
          senderName: 'Researcher',
          seq: 1000,
          text,
          ts: at,
          version: 0
        }
      },
      order: ['w:1']
    }))
  }

  const dispatchDm = (text: string, ts: number) => {
    const chats = useChatsStore.getState()

    chats.dispatchEvent('researcher', {
      type: 'tool.start',
      session_id: 'runtime-1',
      payload: { tool_id: 'call_dm_1', name: 'message_agent', args: { target: '@writer', message: text } }
    })
    chats.dispatchEvent('researcher', {
      type: 'tool.complete',
      session_id: 'runtime-1',
      payload: {
        tool_id: 'call_dm_1',
        name: 'message_agent',
        result: { status: 'queued', process_id: 'p-1', to: 'writer' }
      }
    })
    chats.dispatchEvent('researcher', {
      type: 'message.complete',
      session_id: 'runtime-1',
      payload: { text: 'Asked the writer.', status: 'ok', ts }
    })
  }

  /**
   * Verbosity `normal`.
   *
   * It is no longer what makes a dispatch an aside — Quiet, the default, draws
   * the same row, which is what the test below pins. It is kept because these two
   * tests press the open LINK inside an opened aside, and a reader who has turned
   * verbosity up is the case they were written for.
   *
   * It used to have to wait for a hydrate first: the screen read the settings
   * store on mount and that read replaced `perChat`. The per-account settings
   * are now read for whichever GATEWAY is live, by the chat runtime, and this
   * suite mounts the screen without one — so there is nothing left to race and
   * the override can simply be set.
   */
  function showDmAsides() {
    act(() => {
      useSettingsStore.getState().setChatView('researcher', { level: 'normal' })
    })
  }

  it('draws a dispatch as an aside at the default verbosity, never as a chip', async () => {
    // The owner's report, exactly: Quiet is the default, and Quiet used to demote
    // a dispatch to a centred chip reading `Message to Writer` while the answer
    // beside it stayed an aside. A direction is not a verbosity.
    act(() => {
      useBotsStore.getState().setBots([BOT, { ...BOT, name: 'writer', displayName: 'Writer' }])
      dispatchDm('Can you draft the announcement?', 1_700_000_000)
    })

    renderScreen(<ChatScreen bot="researcher" />)

    await waitFor(() => expect(screen.getByTestId('bot-dm-aside-t:call_dm_1')).toBeTruthy())
    expect(screen.queryByTestId('bot-dm-out-chip-t:call_dm_1')).toBeNull()
    expect(screen.queryByText('Message to Writer')).toBeNull()
  })

  it('opens the recipient on the matching inbound message', async () => {
    const onOpenBot = jest.fn()

    act(() => {
      useBotsStore.getState().setBots([BOT, { ...BOT, name: 'writer', displayName: 'Writer' }])
      dispatchDm('Can you draft the announcement?', 1_700_000_000)
      seedWriter(1_700_000_020, 'Can you draft the announcement?')
    })

    renderScreen(<ChatScreen bot="researcher" onOpenBot={onOpenBot} />)
    showDmAsides()

    // Tapping the ASIDE expands it in place and navigates nowhere; the explicit
    // link inside is what opens the other chat, and it still lands on the
    // matching inbound row rather than at the bottom.
    await waitFor(() => expect(screen.getByTestId('bot-dm-aside-t:call_dm_1-toggle')).toBeTruthy())
    fireEvent.press(screen.getByTestId('bot-dm-aside-t:call_dm_1-toggle'))
    expect(onOpenBot).not.toHaveBeenCalled()

    fireEvent.press(screen.getByTestId('bot-dm-aside-open-t:call_dm_1'))

    expect(onOpenBot).toHaveBeenCalledWith('writer', { focusItemId: 'w:1' })
  })

  it('still opens the chat when no counterpart can be matched', async () => {
    const onOpenBot = jest.fn()

    act(() => {
      useBotsStore.getState().setBots([BOT, { ...BOT, name: 'writer', displayName: 'Writer' }])
      dispatchDm('Can you draft the announcement?', 1_700_000_000)
    })

    renderScreen(<ChatScreen bot="researcher" onOpenBot={onOpenBot} />)
    showDmAsides()

    // Tapping the ASIDE expands it in place and navigates nowhere; the explicit
    // link inside is what opens the other chat, and it still lands on the
    // matching inbound row rather than at the bottom.
    await waitFor(() => expect(screen.getByTestId('bot-dm-aside-t:call_dm_1-toggle')).toBeTruthy())
    fireEvent.press(screen.getByTestId('bot-dm-aside-t:call_dm_1-toggle'))
    expect(onOpenBot).not.toHaveBeenCalled()

    fireEvent.press(screen.getByTestId('bot-dm-aside-open-t:call_dm_1'))

    // No focus target rather than a wrong one: the chat opens at its bottom.
    expect(onOpenBot).toHaveBeenCalledWith('writer', undefined)
  })
})

describe('a line that starts with a slash', () => {
  it('runs as a command when the gateway has one by that name', async () => {
    mockController.knowsSlashCommand.mockReturnValue(true)
    renderChat()

    fireEvent.changeText(screen.getByTestId('composer-input'), '/model')
    fireEvent.press(screen.getByTestId('composer-send'))

    await waitFor(() => expect(mockController.runSlash).toHaveBeenCalledWith('researcher', '/model'))
    // No turn: `slash.exec` answers with text, and the text lands in the
    // transcript as a notice.
    expect(mockController.send).not.toHaveBeenCalled()
  })

  it('is an ordinary prompt when it is not a command this profile has', async () => {
    mockController.knowsSlashCommand.mockReturnValue(false)
    renderChat()

    fireEvent.changeText(screen.getByTestId('composer-input'), '/usr/local/bin is where it lives')
    fireEvent.press(screen.getByTestId('composer-send'))

    await waitFor(() =>
      expect(mockController.send).toHaveBeenCalledWith('researcher', '/usr/local/bin is where it lives', [])
    )
    expect(mockController.runSlash).not.toHaveBeenCalled()
  })
})

describe('a message sent while the bot is working', () => {
  it('stands over the composer as a strip, with its three actions', async () => {
    renderChat()

    act(() => {
      useChatsStore.getState().beginTurn('researcher', 'go')
      useChatsStore.getState().enqueue('researcher', { id: 'q:1', text: 'and one more thing' })
    })

    await waitFor(() => expect(screen.getByTestId('queued-strip')).toBeTruthy())
    // NOT in the transcript: a parked message has not happened yet, and a
    // bubble is a thing that did.
    expect(screen.queryByTestId('queued-q:1')).toBeNull()
    expect(screen.getByText('and one more thing')).toBeTruthy()

    // Steer: into the turn that is running, now.
    fireEvent.press(screen.getByTestId('queued-steer-q:1'))
    await waitFor(() => expect(mockController.steerQueued).toHaveBeenCalledWith('researcher', 'q:1'))

    // Edit: back into the field it came from.
    fireEvent.press(screen.getByTestId('queued-edit-q:1'))
    await waitFor(() => expect(useChatsStore.getState().chats.researcher?.draft).toBe('and one more thing'))

    fireEvent.press(screen.getByTestId('queued-delete-q:1'))
    expect(mockController.deleteQueued).toHaveBeenCalledWith('researcher', 'q:1')
  })

  it('offers no Edit for one carrying an attachment, which the field cannot take back', async () => {
    renderChat()

    act(() => {
      useChatsStore.getState().beginTurn('researcher', 'go')
      useChatsStore
        .getState()
        .enqueue('researcher', { id: 'q:2', text: 'look at this', attachments: ['@image:shot.png'] })
    })

    await waitFor(() => expect(screen.getByTestId('queued-strip')).toBeTruthy())

    expect(screen.getByTestId('queued-steer-q:2')).toBeTruthy()
    expect(screen.getByTestId('queued-delete-q:2')).toBeTruthy()
    expect(screen.queryByTestId('queued-edit-q:2')).toBeNull()
    // The file travels with the message, so the strip names it beside the text.
    expect(screen.getByText(/look at this · shot\.png/)).toBeTruthy()
  })

  it('can be sent at all while a turn runs, which the round button used to refuse', async () => {
    renderChat()

    act(() => {
      useChatsStore.getState().beginTurn('researcher', 'go')
    })

    await waitFor(() => expect(screen.getByTestId('composer-stop')).toBeTruthy())

    // Typing turns the stop square back into a send arrow: the message is
    // parked behind the turn, and the reply is not thrown away for it.
    fireEvent.changeText(screen.getByTestId('composer-input'), 'and one more thing')

    expect(screen.queryByTestId('composer-stop')).toBeNull()
    fireEvent.press(screen.getByTestId('composer-send'))

    await waitFor(() => expect(mockController.send).toHaveBeenCalledWith('researcher', 'and one more thing', []))
    expect(mockController.stopTurn).not.toHaveBeenCalled()
  })
})

describe('the typing indicator', () => {
  it('shows while the turn has said nothing and stops once a tool is the only thing running', async () => {
    renderChat()

    act(() => {
      useChatsStore.getState().beginTurn('researcher', 'do a thing')
      useChatsStore.getState().dispatchEvent('researcher', {
        type: 'message.start',
        session_id: 'runtime-1',
        payload: {}
      })
    })

    await waitFor(() => expect(screen.getByTestId('typing-indicator')).toBeTruthy())

    act(() => {
      useChatsStore.getState().dispatchEvent('researcher', {
        type: 'message.complete',
        session_id: 'runtime-1',
        payload: { text: 'Done.', status: 'ok' }
      })
      // A child is still running: the chat is BUSY but nothing is about to be
      // said, so the dots must be gone.
      useChatsStore.getState().dispatchEvent('researcher', {
        type: 'subagent.start',
        session_id: 'runtime-1',
        payload: { subagent_id: 'sa-1', goal: 'Audit deps', status: 'running', delegation_id: 'del-1' }
      })
    })

    await waitForGone(() => screen.queryByTestId('typing-indicator'), 'typing-indicator')
  })
})

/**
 * ⌘N: a new conversation in the chat that is open.
 *
 * The assertion that matters is the ARGUMENT. ⌘N reuses `/new` rather than
 * calling `startNewConversation` itself, because `/new` is where the rules
 * about the old conversation live — it retires the session, keeps the chat and
 * writes the notice — and a shortcut with its own path to a new conversation
 * would be a second set of those rules. `ChatController.dispatchSlash`
 * intercepts the name before any round trip, so this reaches the same code the
 * composer does.
 */
describe('⌘N', () => {
  function pressNewConversation() {
    act(() => {
      for (const listener of [...mockShortcutListeners]) {
        listener({ action: 'newConversation', typing: false })
      }
    })
  }

  it('runs the app\u2019s own /new in the open chat', async () => {
    renderChat()
    await waitFor(() => expect(mockController.openChat).toHaveBeenCalled())

    pressNewConversation()

    expect(mockController.runSlash).toHaveBeenCalledWith('researcher', '/new')
  })

  it('does not reach past the slash machinery to start one itself', async () => {
    renderChat()
    await waitFor(() => expect(mockController.openChat).toHaveBeenCalled())

    pressNewConversation()

    // There is no `startNewConversation` on this stand-in at all, which is the
    // point: if the screen ever called it directly this would throw rather than
    // quietly work.
    expect(mockController.send).not.toHaveBeenCalled()
  })
})

/**
 * The Memory row, when the profile sheet is opened from the chat header.
 *
 * There is one profile sheet and two ways in, and only one of them used to
 * carry `onOpenMemory` — so the row a reader found from the roster was simply
 * missing when they opened the same sheet from the conversation they were
 * already in. The sheet renders the row only when the handler is there, which
 * is what made the gap invisible: nothing was broken, a section was absent.
 */
describe('the chat\u2019s own way into memory', () => {
  async function openProfileSheet() {
    renderChat()
    await waitFor(() => expect(mockController.openChat).toHaveBeenCalled())

    fireEvent.press(screen.getByTestId('chat-header-profile'))

    await waitFor(() => expect(screen.getByTestId('bot-profile')).toBeTruthy())
  }

  it('offers the row here too, and not only from the roster', async () => {
    await openProfileSheet()

    expect(screen.getByTestId('bot-profile-memory')).toBeTruthy()
  })

  /**
   * A page, not a second modal. The browser owns a header and an Escape of its
   * own, and leaving the sheet underneath it would put the reader back on a
   * profile form when they press Back.
   */
  it('replaces the conversation with the browser, closing the sheet on the way', async () => {
    await openProfileSheet()

    fireEvent.press(screen.getByTestId('bot-profile-memory'))

    await waitFor(() => expect(screen.getByTestId('memory-bots')).toBeTruthy())
    // The conversation itself is gone, not merely covered.
    expect(screen.queryByTestId('composer-input')).toBeNull()
    expect(screen.queryByTestId('chat-header')).toBeNull()
    expect(screen.queryByTestId('bot-profile')).toBeNull()
  })

  /**
   * By the PROFILE name. The header shows whichever name this reader chose to
   * see, and the plugin's `profile` parameter accepts only the other one \u2014
   * routinely the same word in different case, which is the difference nobody
   * notices until a route answers 400.
   */
  it('opens it on the bot\u2019s profile name', async () => {
    await openProfileSheet()

    fireEvent.press(screen.getByTestId('bot-profile-memory'))

    await waitFor(() => expect(screen.getByTestId('memory-bots')).toBeTruthy())
    expect(screen.getByTestId('memory-bots').props.children).toBe('researcher')
  })

  it('comes back to the conversation when the browser closes', async () => {
    await openProfileSheet()

    fireEvent.press(screen.getByTestId('bot-profile-memory'))
    await waitFor(() => expect(screen.getByTestId('memory-bots')).toBeTruthy())

    fireEvent.press(screen.getByTestId('memory-bots'))

    await waitForGone(() => screen.queryByTestId('memory-bots'), 'memory-bots')
    expect(screen.getByTestId('composer-input')).toBeTruthy()
    // And not back onto the sheet it was opened from.
    expect(screen.queryByTestId('bot-profile')).toBeNull()
  })
})
