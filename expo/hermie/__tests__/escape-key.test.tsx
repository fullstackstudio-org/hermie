/**
 * Who gets Escape.
 *
 * Escape arrives as one global event from the keyboard seam — it has to, because
 * it inserts no text and so never reaches a text field's delegate on iOS, and
 * because a `UIKeyCommand` would sit in a responder chain that a presented
 * `Modal` leaves. That leaves the routing to JavaScript, and the rule is the one a
 * reader expects: the thing that opened last closes first.
 *
 * The case worth the most care is a sheet carrying an agent's question. Escape
 * closes it — dismissing is not answering, and ADR-0010 only ever governed the
 * answer — but it must never fall through to whatever is underneath, or it
 * would stop the very turn that is waiting for the question.
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native'
import { useState } from 'react'
import { Pressable, Text } from 'react-native'

import { OverlayPanel } from '../src/app/OverlayPanel'
import { AgentsSheet, type SubagentTranscript } from '../src/chat-ui'
import { subagentTree } from '../src/chat-ui/fixtures'
import { BottomSheet } from '../src/ui/BottomSheet'
import { ChatOptionsSheet } from '../src/ui/sheets'
import { useEscapeKey } from '../src/ui/useEscapeKey'
import { renderScreen, withProviders } from './support/render'

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

function Taker({ label, enabled = true, onEscape }: { label: string; enabled?: boolean; onEscape: () => void }) {
  useEscapeKey(onEscape, enabled)

  return <Text>{label}</Text>
}

describe('useEscapeKey', () => {
  it('holds exactly one native subscription for the whole stack', () => {
    const view = render(
      <>
        <Taker label="one" onEscape={jest.fn()} />
        <Taker label="two" onEscape={jest.fn()} />
      </>
    )

    expect(mockEscapeListeners.size).toBe(1)

    view.unmount()
    expect(mockEscapeListeners.size).toBe(0)
  })

  it('gives the key to whatever registered last', () => {
    const first = jest.fn()
    const second = jest.fn()

    render(
      <>
        <Taker label="one" onEscape={first} />
        <Taker label="two" onEscape={second} />
      </>
    )

    pressEscape()

    expect(second).toHaveBeenCalledTimes(1)
    expect(first).not.toHaveBeenCalled()
  })

  it('hands it back when the top one leaves', () => {
    const first = jest.fn()
    const second = jest.fn()

    const view = render(
      <>
        <Taker label="one" onEscape={first} />
        <Taker enabled label="two" onEscape={second} />
      </>
    )

    view.rerender(
      <>
        <Taker label="one" onEscape={first} />
        <Taker enabled={false} label="two" onEscape={second} />
      </>
    )

    pressEscape()

    expect(first).toHaveBeenCalledTimes(1)
    expect(second).not.toHaveBeenCalled()
  })

  it('does nothing at all when nothing is registered', () => {
    pressEscape()

    expect(mockEscapeListeners.size).toBe(0)
  })

  it('calls the current handler, not the one from the render that registered', () => {
    const stale = jest.fn()
    const fresh = jest.fn()

    const view = render(<Taker label="one" onEscape={stale} />)
    view.rerender(<Taker label="one" onEscape={fresh} />)

    pressEscape()

    expect(fresh).toHaveBeenCalledTimes(1)
    expect(stale).not.toHaveBeenCalled()
  })
})

describe('BottomSheet and Escape', () => {
  it('dismisses an ordinary sheet', () => {
    const onRequestClose = jest.fn()

    renderScreen(
      <BottomSheet onRequestClose={onRequestClose} testID="sheet" visible>
        <Text>Body</Text>
      </BottomSheet>
    )

    pressEscape()

    expect(onRequestClose).toHaveBeenCalledTimes(1)
  })

  /**
   * The load-bearing half of the rule. A sheet takes Escape and STOPS it: if it
   * merely closed and let the key past, the handler underneath would get it too,
   * and underneath an approval sheet is the composer running the turn that asked
   * the question.
   */
  it('stops Escape rather than letting it through to what is underneath', () => {
    const underneath = jest.fn()
    const onRequestClose = jest.fn()

    render(
      withProviders(
        <>
          <Taker label="underneath" onEscape={underneath} />
          <BottomSheet onRequestClose={onRequestClose} testID="sheet" visible>
            <Text>Body</Text>
          </BottomSheet>
        </>
      )
    )

    pressEscape()

    expect(onRequestClose).toHaveBeenCalledTimes(1)
    expect(underneath).not.toHaveBeenCalled()
  })

  it('gives Escape back once the sheet has gone', async () => {
    const underneath = jest.fn()

    const view = render(
      withProviders(
        <>
          <Taker label="underneath" onEscape={underneath} />
          <BottomSheet onRequestClose={jest.fn()} testID="sheet" visible>
            <Text>Body</Text>
          </BottomSheet>
        </>
      )
    )

    view.rerender(
      withProviders(
        <>
          <Taker label="underneath" onEscape={underneath} />
          <BottomSheet onRequestClose={jest.fn()} testID="sheet" visible={false}>
            <Text>Body</Text>
          </BottomSheet>
        </>
      )
    )

    // The sheet keeps the key while it slides out, because it is still on screen.
    expect(screen.getByTestId('sheet')).toBeTruthy()
    pressEscape()
    expect(underneath).not.toHaveBeenCalled()

    await waitFor(() => expect(screen.queryByTestId('sheet')).toBeNull())

    pressEscape()
    expect(underneath).toHaveBeenCalledTimes(1)
  })
})

/**
 * Escape goes back ONE level.
 *
 * The overlay panel that carries Activity, Crons and Settings on the wide layout
 * holds Escape while it is open. A sub page inside it — a cron's detail, a run
 * transcript, the connection test — registers on top when it opens, so the first
 * Escape returns to the page underneath and only the second closes the panel.
 *
 * Nothing coordinates that. It falls out of mount order, which is exactly what
 * the stack is for, and this is the test that says so.
 */
function SubPage() {
  const [open, setOpen] = useState(false)

  // The shape every sub page in the app uses; see `CronScreen` and
  // `SettingsScreen`.
  useEscapeKey(() => setOpen(false), open)

  return (
    <>
      <Pressable onPress={() => setOpen(true)} testID="open-sub-page">
        <Text>Open</Text>
      </Pressable>
      {open ? <Text testID="sub-page">Sub page</Text> : null}
    </>
  )
}

describe('Escape inside the overlay panel', () => {
  it('closes the panel when nothing is open inside it', async () => {
    const onClose = jest.fn()

    renderScreen(
      <OverlayPanel onClose={onClose} visible>
        <SubPage />
      </OverlayPanel>
    )

    pressEscape()

    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('pops the sub page first and leaves the panel open', () => {
    const onClose = jest.fn()

    renderScreen(
      <OverlayPanel onClose={onClose} visible>
        <SubPage />
      </OverlayPanel>
    )

    fireEvent.press(screen.getByTestId('open-sub-page'))
    expect(screen.getByTestId('sub-page')).toBeTruthy()

    pressEscape()

    expect(screen.queryByTestId('sub-page')).toBeNull()
    expect(onClose).not.toHaveBeenCalled()

    // And only now does the panel get it.
    pressEscape()
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})

/**
 * A sheet with pages inside it.
 *
 * The chat options sheet is the one surface where the "one level" rule is not
 * obvious from the markup: the page is not a separate component that mounts over
 * the sheet, it is the same sheet drawing something else. What makes Escape
 * still go back one level is that the page registers its own handler while it is
 * open, and effects flush child-first — so the `BottomSheet` inside the sheet
 * component registers "close" BEFORE the sheet component registers "pop the
 * page", and the stack hands the key to the page.
 */
describe('Escape inside a sheet that has pages', () => {
  const props = {
    accent: 'default' as const,
    botName: 'Researcher',
    fast: false,
    model: 'sonnet',
    modelOptions: [
      { value: 'sonnet', label: 'Sonnet' },
      { value: 'opus', label: 'Opus' }
    ],
    onChangeAccent: jest.fn(),
    onChangeFast: jest.fn(),
    onChangeModel: jest.fn(),
    onChangeReasoningEffort: jest.fn(),
    onChangeShowBotToBot: jest.fn(),
    onChangeShowThinking: jest.fn(),
    onChangeVerbosity: jest.fn(),
    onChangeYolo: jest.fn(),
    reasoningEffort: 'medium',
    reasoningOptions: [{ value: 'medium', label: 'Medium' }],
    showBotToBot: true,
    showThinking: false,
    verbosity: 'normal' as const,
    yolo: false
  }

  it.each([
    ['model', 'option-model'],
    ['reasoning', 'option-reasoning'],
    ['colour', 'option-colour']
  ])('pops the %s page first, and closes the sheet only on the second Escape', (_name, row) => {
    const onClose = jest.fn()

    renderScreen(<ChatOptionsSheet {...props} onClose={onClose} visible />)

    fireEvent.press(screen.getByTestId(row))
    expect(screen.getByTestId('picker-back')).toBeTruthy()

    pressEscape()

    // The page is gone, the sheet is not.
    expect(screen.queryByTestId('picker-back')).toBeNull()
    expect(screen.getByTestId('option-model')).toBeTruthy()
    expect(onClose).not.toHaveBeenCalled()

    pressEscape()
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('closes on the first Escape when no page is open', () => {
    const onClose = jest.fn()

    renderScreen(<ChatOptionsSheet {...props} onClose={onClose} visible />)

    pressEscape()

    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('goes back one level from the back control too, not straight out', () => {
    const onClose = jest.fn()

    renderScreen(<ChatOptionsSheet {...props} onClose={onClose} visible />)

    fireEvent.press(screen.getByTestId('option-colour'))
    fireEvent.press(screen.getByTestId('picker-back'))

    expect(screen.getByTestId('option-colour')).toBeTruthy()
    expect(onClose).not.toHaveBeenCalled()
  })
})

/**
 * The agents sheet, which has a page of its own.
 *
 * Same arrangement as the options sheet and the same reason it needs saying: a
 * child's transcript is not a second component mounted over the sheet, it is the
 * sheet drawing something else. `AgentsSheet` registers "pop the page" after its
 * own `BottomSheet` has registered "close" — effects flush child-first — so the
 * page holds the key while it is open. Nothing coordinates that, which is exactly
 * why it is worth a test.
 *
 * The page is a controlled PROP here, not internal state, so the harness owns it
 * the way `ChatSheetHost` does.
 */
describe('Escape inside the agents sheet', () => {
  const transcriptFor = (subagentId: string): SubagentTranscript => ({
    goal: 'Check recovery',
    loading: false,
    source: 'stored',
    subagentId,
    text: '> Check recovery\n· read_file(README.md)'
  })

  function Harness({ onClose }: { onClose: () => void }) {
    const [transcript, setTranscript] = useState<SubagentTranscript | null>(null)

    return (
      <AgentsSheet
        onClose={onClose}
        onCloseTranscript={() => setTranscript(null)}
        onOpenTranscript={subagentId => setTranscript(transcriptFor(subagentId))}
        transcript={transcript}
        tree={subagentTree}
        visible
      />
    )
  }

  it('pops the transcript page first and leaves the sheet standing', () => {
    const onClose = jest.fn()

    renderScreen(<Harness onClose={onClose} />)

    // sa-2 is the child with a session behind it, so it is the one that offers a
    // transcript at all.
    fireEvent.press(screen.getByTestId('agent-transcript-sa-2'))
    expect(screen.getByTestId('agent-transcript')).toBeTruthy()
    expect(screen.queryByTestId('agent-row-sa-1')).toBeNull()

    pressEscape()

    // Back to the tree, with the sheet still open.
    expect(screen.queryByTestId('agent-transcript')).toBeNull()
    expect(screen.getByTestId('agent-row-sa-1')).toBeTruthy()
    expect(onClose).not.toHaveBeenCalled()

    // And only now does the sheet get it.
    pressEscape()
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('closes the sheet on the first Escape when no page is open', () => {
    const onClose = jest.fn()

    renderScreen(<Harness onClose={onClose} />)

    pressEscape()

    expect(onClose).toHaveBeenCalledTimes(1)
  })

  /**
   * A host that cannot close the page must not swallow the key.
   *
   * The gallery renders this sheet with a transcript and no `onCloseTranscript`;
   * holding Escape there would leave a sheet nothing could dismiss.
   */
  it('lets the sheet have the key when the page cannot be closed', () => {
    const onClose = jest.fn()

    renderScreen(<AgentsSheet onClose={onClose} transcript={transcriptFor('sa-2')} tree={subagentTree} visible />)

    pressEscape()

    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
