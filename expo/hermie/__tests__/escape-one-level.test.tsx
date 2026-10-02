/**
 * Escape goes back ONE level, on the two surfaces where it did not.
 *
 * `escape-key.test.tsx` pins the rule and the surfaces that already obeyed it —
 * the overlay panel, the options sheet, the agents sheet. This file is the
 * audit of everything else that registers on the Escape stack, and it holds the
 * two places the audit found. Both are the same mistake, which is the one worth
 * naming: **a level that does not MOUNT is a level nobody notices.**
 *
 *  - **Settings → Appearance → Theme → edit.** Deleting a theme asks first, and
 *    the question is two rows drawn in place rather than a sheet. Nothing
 *    mounted, so nothing registered, so the first Escape closed the whole
 *    screen with a destructive question still on it — and the reader's next
 *    Escape-reflex would have been aimed at the question.
 *  - **The memory map.** A tapped node opens a detail card with a close control
 *    of its own, which is what makes it a level; it too is drawn in place. The
 *    first Escape left the memory screen entirely and took the card with it.
 *
 * Nothing coordinates the fix. Both register a second handler while their own
 * level is up, hook order is effect order, and the stack hands the key to
 * whatever was pushed last — exactly as it does for a sheet that mounts.
 */
import { PLUGIN_CAPABILITIES } from '@hermie/gateway-client/plugin'
import { act, fireEvent, screen, waitFor } from '@testing-library/react-native'

import { MemoryScreen } from '../src/features/memory'
import { ThemeEditScreen } from '../src/features/settings/ThemeEditScreen'
import { useMemoryStore } from '../src/store/memory'
import { usePluginStore } from '../src/store/plugin'
import { useSettingsStore } from '../src/store/settings'
import { renderScreen } from './support/render'

const mockEscapeListeners = new Set<() => void>()

jest.mock('../src/platform/keyboard-modifiers', () => ({
  isShiftDown: jest.fn(() => false),
  hasHardwareKeyboard: jest.fn(() => false),
  subscribeToEscape: (handler: () => void) => {
    mockEscapeListeners.add(handler)

    return () => mockEscapeListeners.delete(handler)
  }
}))

/** Press Escape, the way the native module would deliver it. */
function pressEscape() {
  act(() => {
    for (const listener of [...mockEscapeListeners]) {
      listener()
    }
  })
}

beforeEach(() => mockEscapeListeners.clear())

describe('Escape in the theme editor', () => {
  beforeEach(() => {
    useSettingsStore.getState().reset()
  })

  /** A user theme, and the screen editing it, which is what makes Delete reachable. */
  function openWithATheme(onPress: () => void) {
    const id = useSettingsStore.getState().createUserTheme('blue', 'Blue')

    renderScreen(<ThemeEditScreen back={{ label: 'Theme', onPress }} id={id} />)

    return screen.getByTestId('theme-delete')
  }

  it('closes the screen when nothing is open inside it', () => {
    const onClose = jest.fn()
    const id = useSettingsStore.getState().createUserTheme('blue', 'Blue')

    renderScreen(<ThemeEditScreen back={{ label: 'Theme', onPress: onClose }} id={id} />)

    pressEscape()

    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('cancels the delete question first, and leaves the screen standing', () => {
    const onClose = jest.fn()

    fireEvent.press(openWithATheme(onClose))
    expect(screen.getByTestId('theme-delete-confirm')).toBeTruthy()

    pressEscape()

    expect(screen.queryByTestId('theme-delete-confirm')).toBeNull()
    expect(onClose).not.toHaveBeenCalled()

    // And only now does the screen get it.
    pressEscape()
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  /** Cancelling must not also delete. The question is the level, not the answer. */
  it('keeps the theme it was asking about', () => {
    fireEvent.press(openWithATheme(jest.fn()))
    pressEscape()

    expect(useSettingsStore.getState().userThemes).toHaveLength(1)
  })
})

describe('Escape on the memory map', () => {
  const graph = {
    nodes: [
      { id: 'profile:researcher', type: 'profile', label: 'researcher' },
      { id: 'memory:0', type: 'entry', target: 'memory', label: 'Max signs off on invoices.', chars: 26 },
      { id: 'topic:Max', type: 'topic', label: 'Max' }
    ],
    edges: [
      { from: 'memory:0', to: 'profile:researcher', type: 'in_profile' },
      { from: 'memory:0', to: 'topic:Max', type: 'mentions' }
    ],
    page: { offset: 0, limit: 100, returned: 1, total: 1, hasMore: false },
    truncated: false
  }

  const listing = {
    profile: 'researcher',
    targets: [
      {
        target: 'memory',
        entries: [
          { id: 'memory:0', target: 'memory', index: 0, text: 'Max signs off on invoices.', chars: 26, topics: ['Max'] }
        ],
        chars: 26,
        limit: 2200,
        percent: 1
      },
      { target: 'user', entries: [], chars: 0, limit: 1375, percent: 0 }
    ],
    providers: []
  }

  const http = {
    get: jest.fn(async (path: string) => (path.includes('/graph') ? graph : listing)),
    post: jest.fn()
  }

  beforeEach(() => {
    useMemoryStore.getState().reset()
    usePluginStore.getState().reset()
    ;(jest.requireMock('../src/gateway') as { __setHttp: (value: unknown) => void }).__setHttp(http)
    usePluginStore.getState().apply({
      version: '0.5.0',
      capabilities: [PLUGIN_CAPABILITIES.memoryBrowse, PLUGIN_CAPABILITIES.memoryEdit],
      modules: { memory: 'on' },
      limits: {},
      updatedAt: 1
    })
  })

  async function openCard(onClose: () => void) {
    renderScreen(<MemoryScreen onClose={onClose} profile="researcher" title="Researcher" />)
    await act(async () => undefined)
    await waitFor(() => expect(screen.getByTestId('memory-tab-graph')).toBeTruthy())

    fireEvent.press(screen.getByTestId('memory-tab-graph'))
    await waitFor(() => expect(screen.getByTestId('memory-graph-node-memory:0')).toBeTruthy())

    fireEvent.press(screen.getByTestId('memory-graph-node-memory:0'))
    await waitFor(() => expect(screen.getByTestId('memory-graph-card')).toBeTruthy())
  }

  it('closes the card first and leaves the screen open', async () => {
    const onClose = jest.fn()

    await openCard(onClose)

    pressEscape()

    expect(screen.queryByTestId('memory-graph-card')).toBeNull()
    expect(onClose).not.toHaveBeenCalled()
    // The map is still there, so this really was one level rather than a repaint.
    expect(screen.getByTestId('memory-graph')).toBeTruthy()

    pressEscape()
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('closes the screen on the first Escape when no card is open', async () => {
    const onClose = jest.fn()

    renderScreen(<MemoryScreen onClose={onClose} profile="researcher" title="Researcher" />)
    await act(async () => undefined)

    pressEscape()

    expect(onClose).toHaveBeenCalledTimes(1)
  })
})

jest.mock('../src/gateway', () => {
  const frozen = { http: null as unknown }

  return { useGateway: () => frozen, __setHttp: (value: unknown) => (frozen.http = value) }
})
