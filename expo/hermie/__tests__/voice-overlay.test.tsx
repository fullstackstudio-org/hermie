/**
 * The voice-mode overlay: what it draws per phase, and the two ways out.
 *
 * It renders a `Modal`, which the test renderer mounts inline — so everything
 * inside is queryable and nothing here needs the phone.
 */
import { fireEvent, screen } from '@testing-library/react-native'
import { AccessibilityInfo } from 'react-native'

import { phaseLabel, RING_GAIN, RING_SIZE, VoiceOverlay } from '../src/features/voice/VoiceOverlay'
import { VOICE_IDLE, type VoiceLoopState } from '../src/features/voice/voice-loop'
import { renderScreen } from './support/render'

const mockEscapeListeners = new Set<() => void>()

jest.mock('../src/platform/keyboard-modifiers', () => ({
  isShiftDown: () => false,
  hasHardwareKeyboard: () => false,
  subscribeToEscape: (handler: () => void) => {
    mockEscapeListeners.add(handler)

    return () => mockEscapeListeners.delete(handler)
  }
}))

const state = (over: Partial<VoiceLoopState> = {}): VoiceLoopState => ({ ...VOICE_IDLE, ...over })

function renderOverlay(props: Partial<React.ComponentProps<typeof VoiceOverlay>> = {}) {
  const handlers = {
    onCancel: jest.fn(),
    onInterrupt: jest.fn(),
    onLeave: jest.fn()
  }

  renderScreen(
    <VoiceOverlay botName="researcher" state={state({ phase: 'listening' })} visible {...handlers} {...props} />
  )

  return handlers
}

beforeEach(() => mockEscapeListeners.clear())

describe('the overlay', () => {
  it('draws nothing while it is not open', () => {
    renderOverlay({ visible: false })

    expect(screen.queryByTestId('voice-overlay')).toBeNull()
  })

  it('names the phase, so a glance is enough', () => {
    expect(phaseLabel('listening')).toBe('Listening')
    expect(phaseLabel('waiting')).toBe('Waiting for a reply')
    expect(phaseLabel('speaking')).toBe('Speaking')
    // Confirming and sending read the same, deliberately: from the reader's
    // side the message is on its way and the only difference is whether there
    // is still a second to stop it, which the Cancel button says.
    expect(phaseLabel('confirming')).toBe(phaseLabel('sending'))
    expect(phaseLabel('idle')).toBe('')
  })

  it('leaves on Escape', () => {
    const handlers = renderOverlay()

    for (const listener of [...mockEscapeListeners]) {
      listener()
    }

    expect(handlers.onLeave).toHaveBeenCalled()
  })

  it('interrupts on a tap, and does NOT leave', () => {
    // The commonest gesture in the mode is "stop talking, let me speak". A tap
    // that also closed the overlay would lose the mode by doing that.
    const handlers = renderOverlay({ state: state({ phase: 'speaking' }) })

    fireEvent.press(screen.getByTestId('voice-overlay-stage'))

    expect(handlers.onInterrupt).toHaveBeenCalled()
    expect(handlers.onLeave).not.toHaveBeenCalled()
  })

  it('shows what it heard, with a way to stop it, only while confirming', () => {
    const handlers = renderOverlay({ state: state({ phase: 'confirming', transcript: 'send the report' }) })

    expect(screen.getByTestId('voice-overlay-transcript')).toBeTruthy()
    expect(screen.getByText('send the report')).toBeTruthy()

    fireEvent.press(screen.getByTestId('voice-overlay-cancel'))

    expect(handlers.onCancel).toHaveBeenCalled()
  })

  it('offers no cancel once the message has gone', () => {
    renderOverlay({ state: state({ phase: 'sending', transcript: 'send the report' }) })

    expect(screen.getByTestId('voice-overlay-transcript')).toBeTruthy()
    expect(screen.queryByTestId('voice-overlay-cancel')).toBeNull()
  })

  it('shows neither while it is listening', () => {
    renderOverlay({ state: state({ phase: 'listening', transcript: 'half a sen' }) })

    // A transcript on screen for the whole of an utterance would turn the
    // overlay into a reading surface, which is what voice mode is for avoiding.
    expect(screen.queryByTestId('voice-overlay-transcript')).toBeNull()
  })

  it('grows the ring with the input level', () => {
    renderOverlay({ state: state({ phase: 'listening', level: 1 }) })

    const style = screen.getByTestId('voice-overlay-ring').props.style

    expect(style.width).toBe(RING_SIZE)
    // A plain number, not an animated node: the level is already React state
    // and a tween between readings would lag behind the voice it is showing.
    expect(style.transform[0].scale).toBeCloseTo(1 + RING_GAIN)
  })
})

describe('under Reduce Motion', () => {
  const original = AccessibilityInfo.isReduceMotionEnabled

  beforeAll(() => {
    // The theme reads this once; a reader who asked for stillness must not get
    // a pulsing circle filling their screen.
    AccessibilityInfo.isReduceMotionEnabled = jest.fn(async () => true)
  })

  afterAll(() => {
    AccessibilityInfo.isReduceMotionEnabled = original
  })

  it('leaves the ring at rest whatever the level says', async () => {
    renderOverlay({ state: state({ phase: 'listening', level: 1 }) })

    await screen.findByTestId('voice-overlay-ring')

    expect(screen.getByTestId('voice-overlay-ring').props.style.transform[0].scale).toBeCloseTo(1)
  })
})
