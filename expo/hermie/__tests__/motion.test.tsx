/**
 * Motion, as the four claims the app's feel rests on.
 *
 * None of this measures a frame. What it pins is the structure that a frame
 * measurement would otherwise have to be repeated to defend:
 *
 *  1. there is ONE table of durations, and every surface that moves names a
 *     token in it rather than a number of its own — which is how the app ended
 *     up with a token called `sheet` that the sheet did not use;
 *  2. Reduce Motion collapses a duration to zero and never skips an animation,
 *     because the completion callback is what unmounts a closed surface;
 *  3. a surface trails its own `visible` by one exit, so leaving is a movement
 *     rather than a disappearance;
 *  4. and where it deliberately does NOT — the drop overlay, the slash list —
 *     that is a prop with a reason, not an omission.
 */
import { describe, expect, it, jest } from '@jest/globals'
import { act, render, screen } from '@testing-library/react-native'
import { Text, View } from 'react-native'

import { Appear } from '../src/ui/Appear'
import { durationFor, easing, motion, spring } from '../src/ui/motion'
import { ThemeProvider } from '../src/ui/theme'
import { SHEET_ANIMATION_MS } from '../src/ui/BottomSheet'
import { SIDEBAR_OVERLAY_MOTION } from '../src/app/SidebarOverlay'

const mount = (node: React.ReactElement) => render(<ThemeProvider>{node}</ThemeProvider>)

describe('the motion table', () => {
  it('is where the two surfaces that used to carry their own number now read theirs', () => {
    expect(SHEET_ANIMATION_MS).toBe(motion.sheet)
    expect(SIDEBAR_OVERLAY_MOTION).toBe(motion.sidebar)
  })

  it('keeps the sheet and the overlay panel at different speeds', () => {
    // They travel different distances. One duration for both is what made the
    // token named `sheet` belong to the panel.
    expect(motion.sheet).not.toBe(motion.panel)
  })

  it('collapses every duration to zero under Reduce Motion, and none of them to undefined', () => {
    for (const token of Object.keys(motion) as (keyof typeof motion)[]) {
      expect(durationFor(token, false)).toBe(motion[token])
      expect(durationFor(token, true)).toBe(0)
    }
  })

  it('gives enter and exit different curves, so an exit is not an entrance reversed', () => {
    expect(easing.enter).not.toBe(easing.exit)
    // A decelerate curve is ahead of linear at its own midpoint; an accelerate
    // curve is behind it. That is the whole difference, stated as a number.
    expect(easing.enter(0.5)).toBeGreaterThan(0.5)
    expect(easing.exit(0.5)).toBeLessThan(0.5)
  })

  it('does not let the one spring overshoot', () => {
    expect(spring.settle.bounciness).toBe(0)
  })
})

describe('a surface that arrives and leaves', () => {
  it('keeps a leaving surface mounted until its exit has run', () => {
    const { rerender } = mount(
      <Appear testID="thing" visible>
        <Text>hello</Text>
      </Appear>
    )

    expect(screen.getByTestId('thing')).toBeTruthy()

    act(() => {
      rerender(
        <ThemeProvider>
          <Appear testID="thing" visible={false}>
            <Text>hello</Text>
          </Appear>
        </ThemeProvider>
      )
    })

    // Still there, on the frame after it stopped being visible: that is the exit.
    expect(screen.queryByTestId('thing')).toBeTruthy()
  })

  it('stops taking taps the moment it is no longer visible', () => {
    const { rerender } = mount(
      <Appear pointerEvents="box-none" testID="thing" visible>
        <View />
      </Appear>
    )

    expect(screen.getByTestId('thing').props.pointerEvents).toBe('box-none')

    act(() => {
      rerender(
        <ThemeProvider>
          <Appear pointerEvents="box-none" testID="thing" visible={false}>
            <View />
          </Appear>
        </ThemeProvider>
      )
    })

    // A surface already leaving must not eat the tap that opens the next thing.
    expect(screen.getByTestId('thing').props.pointerEvents).toBe('none')
  })

  it('leaves on the frame when it is told to cut', () => {
    const { rerender } = mount(
      <Appear exit="cut" testID="thing" visible>
        <Text>hello</Text>
      </Appear>
    )

    expect(screen.getByTestId('thing')).toBeTruthy()

    act(() => {
      rerender(
        <ThemeProvider>
          <Appear exit="cut" testID="thing" visible={false}>
            <Text>hello</Text>
          </Appear>
        </ThemeProvider>
      )
    })

    expect(screen.queryByTestId('thing')).toBeNull()
  })

  it('renders nothing at all before it is ever visible', () => {
    mount(
      <Appear testID="thing" visible={false}>
        <Text>hello</Text>
      </Appear>
    )

    expect(screen.queryByTestId('thing')).toBeNull()
  })
})

describe('haptics', () => {
  it('fires nothing in a Mac window', () => {
    jest.resetModules()
    jest.doMock('../src/platform/runs-on-mac', () => ({ RUNS_ON_MAC: true }))

    const impact = jest.fn(async () => undefined)
    const selection = jest.fn(async () => undefined)
    const notification = jest.fn(async () => undefined)

    jest.doMock('expo-haptics', () => ({
      ImpactFeedbackStyle: { Light: 'light' },
      NotificationFeedbackType: { Success: 'success' },
      impactAsync: impact,
      notificationAsync: notification,
      selectionAsync: selection
    }))

    const { haptic } = jest.requireActual<{ haptic: (moment: 'send' | 'choice' | 'complete') => void }>(
      '../src/platform/haptics'
    )

    haptic('send')
    haptic('choice')
    haptic('complete')

    expect(impact).not.toHaveBeenCalled()
    expect(selection).not.toHaveBeenCalled()
    expect(notification).not.toHaveBeenCalled()

    jest.dontMock('../src/platform/runs-on-mac')
    jest.dontMock('expo-haptics')
    jest.resetModules()
  })

  it('fires the expected one everywhere else', () => {
    jest.resetModules()
    jest.doMock('../src/platform/runs-on-mac', () => ({ RUNS_ON_MAC: false }))

    const impact = jest.fn(async () => undefined)
    const selection = jest.fn(async () => undefined)
    const notification = jest.fn(async () => undefined)

    jest.doMock('expo-haptics', () => ({
      ImpactFeedbackStyle: { Light: 'light' },
      NotificationFeedbackType: { Success: 'success' },
      impactAsync: impact,
      notificationAsync: notification,
      selectionAsync: selection
    }))

    const { haptic } = jest.requireActual<{ haptic: (moment: 'send' | 'choice' | 'complete') => void }>(
      '../src/platform/haptics'
    )

    haptic('send')
    haptic('choice')
    haptic('complete')

    expect(impact).toHaveBeenCalledWith('light')
    expect(selection).toHaveBeenCalled()
    expect(notification).toHaveBeenCalledWith('success')

    jest.dontMock('../src/platform/runs-on-mac')
    jest.dontMock('expo-haptics')
    jest.resetModules()
  })
})
