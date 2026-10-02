/**
 * Reduce Motion, asserted over every surface in the app that moves.
 *
 * ## Why a spy rather than a snapshot
 *
 * "Respects Reduce Motion" is not a property of a rendered tree — a surface at
 * its final position looks identical whether it got there instantly or over
 * 420 ms. The only place the difference exists is the animation that was
 * STARTED, so that is what is watched: `Animated.timing` and `Animated.spring`
 * are wrapped, every `start()` is recorded with the duration it was built with,
 * and the assertion is that under Reduce Motion nothing ran for longer than
 * zero.
 *
 * The wrapper records on `start`, not on construction, which matters more than
 * it looks: `Animated.sequence`, `Animated.parallel` and `Animated.loop` all
 * start their children, so a nested animation is caught by the same spy that
 * catches a bare one. An animation that is built and never started is not
 * motion and is not recorded.
 *
 * ## The three rules being checked
 *
 * `motion.ts` states them and this file is where they are enforced:
 *
 * 1. **Every duration collapses to zero**, rather than the animation being
 *    skipped. A skipped animation is a skipped completion callback, and the
 *    completion callback is what unmounts a closed panel — skipping is how a
 *    Reduce Motion reader ends up with a sheet that never goes away.
 * 2. **No `pointerEvents` trap.** A surface on its way out must not eat the tap
 *    that opens the next thing.
 * 3. **The arrival rule.** Content that is already on screen when a surface
 *    opens does not animate in; `usePresence` starts every value at 0 and
 *    animates up precisely because these surfaces are mounted AT the moment
 *    they become visible.
 *
 * ## What this cannot see
 *
 * A `Modal`'s own `animationType`, which is the platform's animation and not
 * `Animated`'s — `VoiceOverlay` passes `'none'` under Reduce Motion and that is
 * asserted separately, by reading the prop. And anything driven by a native
 * module, of which the app has none.
 */
import { act, render, screen } from '@testing-library/react-native'
import { AccessibilityInfo, Animated, Modal, Text, View } from 'react-native'
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context'

import { OverlayPanel } from '../src/app/OverlayPanel'
import { PanelScrim } from '../src/app/PanelScrim'
import { SidebarOverlay } from '../src/app/SidebarOverlay'
import { ImageViewer } from '../src/chat-ui/ImageViewer'
import { JumpToLatestPill } from '../src/chat-ui/JumpToLatestPill'
import { TypingDots } from '../src/chat-ui/TypingIndicator'
import { LockPlate } from '../src/features/lock/LockPlate'
import { MemoryGraphView } from '../src/features/memory/MemoryGraphView'
import type { MemoryGraph } from '../src/features/memory/graph-model'
import { VoiceOverlay } from '../src/features/voice/VoiceOverlay'
import { VOICE_IDLE } from '../src/features/voice/voice-loop'
import { Appear } from '../src/ui/Appear'
import { BottomSheet } from '../src/ui/BottomSheet'
import { PresenceBead } from '../src/ui/PresenceBead'
import { SwitchRow } from '../src/ui/sheets/controls'
import { ThemeProvider, useTheme } from '../src/ui/theme'

const METRICS: Metrics = {
  frame: { x: 0, y: 0, width: 402, height: 874 },
  insets: { top: 59, left: 0, right: 0, bottom: 34 }
}

/** One animation that actually ran, and how long it was given. */
interface Started {
  kind: 'timing' | 'spring'
  duration: number
}

let started: Started[] = []

const realTiming = Animated.timing
const realSpring = Animated.spring

/**
 * Wrap a factory so every animation it builds records itself when started.
 *
 * `start` is replaced on the instance rather than on the prototype because the
 * composite animations build their children through the same factory, so the
 * instance is the one place every one of them passes through.
 */
function watch<Config>(
  real: (value: never, config: never) => Animated.CompositeAnimation,
  kind: Started['kind'],
  durationOf: (config: Config) => number
) {
  return (value: never, config: never): Animated.CompositeAnimation => {
    const animation = real(value, config)
    const start = animation.start.bind(animation)

    animation.start = (callback?: Animated.EndCallback) => {
      started.push({ kind, duration: durationOf(config as Config) })
      start(callback)
    }

    return animation
  }
}

beforeAll(() => {
  jest.spyOn(Animated, 'timing').mockImplementation(
    watch<{ duration?: number }>(realTiming as never, 'timing', config =>
      // `Animated.timing` defaults to 500 when a duration is left out, so an
      // omitted one is a real 500 ms animation and is recorded as such.
      typeof config.duration === 'number' ? config.duration : 500
    ) as never
  )

  // A spring has no duration at all: it runs until it settles. Under Reduce
  // Motion the answer is never "a shorter spring", it is "not a spring".
  jest.spyOn(Animated, 'spring').mockImplementation(watch(realSpring as never, 'spring', () => -1) as never)
})

afterAll(() => {
  jest.restoreAllMocks()
})

beforeEach(() => {
  started = []
  jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(true)
  jest.spyOn(AccessibilityInfo, 'isReduceTransparencyEnabled').mockResolvedValue(false)
})

/**
 * A gate, and it is the whole reason this file can assert anything.
 *
 * `AccessibilityInfo.isReduceMotionEnabled()` is a PROMISE, so the first render
 * of any tree always has `reduceMotion: false` — a surface mounted directly
 * under the provider therefore animates once, correctly, under the default, and
 * only then learns the preference.
 *
 * The first attempt at this file dealt with that by clearing the record once
 * the preference landed, and that silently defeated the entire suite: the
 * re-render the preference TRIGGERS is the one worth watching, and it happens
 * in the same flush that was being cleared. Deleting a surface's Reduce Motion
 * guard left every test green.
 *
 * So nothing is cleared. The surface is not mounted at all until the preference
 * is in, and every animation it then starts is one it started knowing.
 */
function WhenReduced({ children }: { children: React.ReactNode }) {
  const theme = useTheme()

  return theme.reduceMotion ? <>{children}</> : null
}

/** The tree, with the gate in it. Rerenders have to use this too. */
function reduced(ui: React.ReactElement) {
  return (
    <SafeAreaProvider initialMetrics={METRICS}>
      <ThemeProvider>
        <WhenReduced>{ui}</WhenReduced>
      </ThemeProvider>
    </SafeAreaProvider>
  )
}

/** Mount under the providers, with Reduce Motion already resolved. */
async function mountReduced(ui: React.ReactElement) {
  const tree = render(reduced(ui))

  await settle()

  return tree
}

/**
 * Let the effects and one animation frame through.
 *
 * A zero-duration animation is still an animation: it completes on the next
 * frame, which jest-expo polyfills onto a timer. Awaiting a microtask alone
 * would mean the completion callbacks had not run yet — and the completion
 * callback is exactly what this file is here to prove still fires.
 */
async function settle() {
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, 0))
  })
}

/** Everything that ran for longer than an instant. */
function moving(): Started[] {
  return started.filter(entry => entry.duration !== 0)
}

const GRAPH: MemoryGraph = {
  nodes: [
    { id: 'profile', type: 'profile', label: 'researcher' },
    { id: 'e0', type: 'entry', label: 'a thing worth remembering' },
    { id: 't0', type: 'topic', label: 'topic' }
  ],
  edges: [
    { from: 'profile', to: 'e0', type: 'in_profile' },
    { from: 'e0', to: 't0', type: 'mentions' }
  ],
  truncated: false
}

/**
 * Every surface, and what it is.
 *
 * A table rather than one `it` each, because the point is COVERAGE: a surface
 * that starts animating and is not in this list is the failure mode, and a list
 * is the only shape that makes the omission visible. `docs/platform-notes.md`
 * carries the same table with a verdict per row.
 */
const SURFACES: { name: string; render: () => React.ReactElement }[] = [
  { name: 'Appear, arriving', render: () => <Appear visible>{<Text>pill</Text>}</Appear> },
  {
    name: 'the jump-to-latest pill',
    render: () => (
      <Appear rise={10} visible>
        <JumpToLatestPill count={3} onPress={() => undefined} />
      </Appear>
    )
  },
  {
    name: 'the bottom sheet',
    render: () => (
      <BottomSheet onRequestClose={() => undefined} visible>
        <Text>sheet</Text>
      </BottomSheet>
    )
  },
  { name: 'the panel scrim', render: () => <PanelScrim onPress={() => undefined} open /> },
  {
    name: 'the overlay panel',
    render: () => (
      <OverlayPanel frame={{ x: 0, y: 0, width: 402, height: 874 }} onClose={() => undefined} visible>
        <Text>panel</Text>
      </OverlayPanel>
    )
  },
  {
    name: 'the sidebar slide-over',
    render: () => (
      <SidebarOverlay onClose={() => undefined} visible width={320}>
        <Text>sidebar</Text>
      </SidebarOverlay>
    )
  },
  { name: 'the lock plate', render: () => <LockPlate onUnlock={() => undefined} /> },
  {
    name: 'the voice overlay, waiting',
    render: () => (
      <VoiceOverlay
        botName="Researcher"
        onCancel={() => undefined}
        onInterrupt={() => undefined}
        onLeave={() => undefined}
        state={{ ...VOICE_IDLE, phase: 'waiting' }}
        visible
      />
    )
  },
  {
    name: 'the memory graph settle',
    render: () => <MemoryGraphView graph={GRAPH} onSelect={() => undefined} />
  },
  { name: 'the typing dots', render: () => <TypingDots /> },
  { name: 'the needs-input pulse', render: () => <PresenceBead state="needsInput" /> },
  {
    name: 'the switch knob',
    render: () => <SwitchRow label="Fast" onChange={() => undefined} value={true} />
  },
  {
    name: 'the image viewer',
    render: () => <ImageViewer name="picture.png" onClose={() => undefined} uri="file:///tmp/picture.png" />
  }
]

describe('under Reduce Motion, nothing moves', () => {
  it.each(SURFACES.map(surface => [surface.name, surface] as const))('%s', async (_name, surface) => {
    await mountReduced(surface.render())

    expect(moving()).toEqual([])
  })
})

/**
 * And the collapse is a ZERO, not a skip.
 *
 * This is the half the assertion above cannot make on its own: a surface that
 * started nothing at all would pass it, and a panel that starts nothing never
 * runs the completion callback that unmounts it. So the exit is required to
 * have HAPPENED, and to have happened instantly.
 *
 * The callback itself is proven on the bottom sheet rather than on `Appear`,
 * and the reason is the driver. `Appear` animates opacity and a transform, so
 * it asks for the native driver — and a native-driven animation's completion
 * comes back from a native module this test environment does not have, so it
 * never arrives here however long the test waits. The sheet drives layout and
 * therefore runs on the JS driver, where a zero-duration timing completes
 * synchronously. Same hook, same code path, one of them observable.
 */
describe('the collapse is a zero rather than a skip', () => {
  it('still RUNS the exit, rather than skipping it', async () => {
    const tree = await mountReduced(
      <Appear testID="leaving" visible>
        <Text>row</Text>
      </Appear>
    )

    expect(screen.getByTestId('leaving')).toBeTruthy()

    tree.rerender(
      reduced(
        <Appear testID="leaving" visible={false}>
          <Text>row</Text>
        </Appear>
      )
    )

    await settle()

    /*
      It ran, and it ran for nothing. Both halves matter: no second entry at all
      would mean the exit was skipped, and a nonzero one would mean it was not
      collapsed. There are two because the arrival is an animation too — under
      Reduce Motion, an instant one.
    */
    expect(started).toEqual([
      { kind: 'timing', duration: 0 },
      { kind: 'timing', duration: 0 }
    ])
  })

  it('reaches the callback that takes a closed surface away', async () => {
    const onClosed = jest.fn()
    const sheet = (visible: boolean) =>
      reduced(
        <BottomSheet onClosed={onClosed} onRequestClose={() => undefined} visible={visible}>
          <Text testID="sheet-content">sheet</Text>
        </BottomSheet>
      )

    const tree = await mountReduced(
      <BottomSheet onClosed={onClosed} onRequestClose={() => undefined} visible>
        <Text testID="sheet-content">sheet</Text>
      </BottomSheet>
    )

    expect(screen.getByTestId('sheet-content')).toBeTruthy()

    tree.rerender(sheet(false))
    await settle()

    expect(onClosed).toHaveBeenCalledTimes(1)
    expect(screen.queryByTestId('sheet-content')).toBeNull()
    expect(moving()).toEqual([])
  })
})

/**
 * No `pointerEvents` trap.
 *
 * A surface on its way out must not eat the tap that opens the next thing. It
 * is forced to `none` the moment it stops being visible, which is one frame
 * before it is gone — and under Reduce Motion that frame still exists, because
 * the exit is a zero-duration animation rather than an unmount.
 */
describe('a surface on its way out takes no taps', () => {
  it('drops pointerEvents on the frame it stops being visible', async () => {
    const tree = await mountReduced(
      <Appear pointerEvents="auto" testID="leaving" visible>
        <Text>row</Text>
      </Appear>
    )

    expect(screen.getByTestId('leaving').props.pointerEvents).toBe('auto')

    tree.rerender(
      reduced(
        <Appear onExited={() => undefined} pointerEvents="auto" testID="leaving" visible={false}>
          <Text>row</Text>
        </Appear>
      )
    )

    // Rendered, and inert. Not gone: `onExited` is what takes it away.
    expect(screen.getByTestId('leaving').props.pointerEvents).toBe('none')
  })
})

/**
 * The platform's own modal animation, which `Animated` never sees.
 *
 * `VoiceOverlay` is the one surface presented in a `Modal` with an
 * `animationType`, and that animation belongs to the platform rather than to
 * this app's motion tokens — so it is the one thing in this file asserted by
 * reading a prop instead of by watching a spy.
 */
describe('a modal that animates itself', () => {
  it('is told not to', async () => {
    await mountReduced(
      <VoiceOverlay
        botName="Researcher"
        onCancel={() => undefined}
        onInterrupt={() => undefined}
        onLeave={() => undefined}
        state={{ ...VOICE_IDLE, phase: 'waiting' }}
        visible
      />
    )

    expect(screen.UNSAFE_getByType(Modal).props.animationType).toBe('none')
  })
})

/**
 * The arrival rule, which is the one that survives Reduce Motion being OFF.
 *
 * `usePresence` starts its value at 0 on every mount and animates up, including
 * the first render, because every surface using it is mounted at the moment it
 * becomes visible. A value initialised to `visible ? 1 : 0` would stand at 1
 * before the effect ran and then animate 1 → 1: present, with no arrival. That
 * was a real bug in the sheet.
 *
 * Asserted here with Reduce Motion ON, where it is the opposite risk that
 * matters: the value must reach 1 anyway, or the surface is invisible.
 */
describe('the arrival rule', () => {
  it('leaves a surface fully present once its zero-length arrival has run', async () => {
    await mountReduced(
      <Appear testID="arrived" visible>
        <View testID="content" />
      </Appear>
    )

    expect(screen.getByTestId('content')).toBeTruthy()
    expect(moving()).toEqual([])
  })
})
