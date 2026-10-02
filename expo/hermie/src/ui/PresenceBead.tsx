/**
 * One bead, four states, three sizes.
 *
 * Colour never carries the meaning alone: the SHAPE differs per state — filled,
 * filled with a still inner dot, filled with a notch, a hollow ring — and the
 * row and the chat header both repeat the state in words. That is what makes the
 * bead readable to someone who cannot tell green from amber.
 *
 * **"Needs input" is the only thing in this app that animates.** A slow,
 * low-amplitude ring pulse, because that state is a request aimed at the reader.
 * Working is deliberately static: a bot being busy is information, not a
 * request, and a permanently spinning indicator teaches people to ignore it.
 * Under Reduce Motion the pulse resolves to the static ring it pulses from.
 */
import { useEffect, useRef } from 'react'
import { Animated, View } from 'react-native'

import type { PresenceState } from '../features/bots/presence'
import { easing, motion, NATIVE_DRIVER } from './motion'
import { useTheme } from './theme'
import { BEAD_SIZE } from './tokens'

export type PresenceBeadProps = {
  state: PresenceState
  size?: number
  /**
   * The colour the bead is punched out of — the surface behind it. A bead on an
   * avatar needs a ring in the panel's colour so it reads as a hole rather than
   * as a sticker; a bead inline in a line of text needs none.
   */
  ringColor?: string
  testID?: string
}

export function PresenceBead({ state, size = BEAD_SIZE.avatar, ringColor, testID }: PresenceBeadProps) {
  const theme = useTheme()
  const color = theme.presence[state]

  // The punch-out ring sits OUTSIDE the bead, the way the mockup's box-shadow
  // does, so `size` always means the coloured part. React Native draws a border
  // inwards, so the box grows by the ring on both sides instead.
  const ring = ringColor ? Math.max(1.5, Math.round(size * 0.18)) : 0
  const total = size + ring * 2

  return (
    <View
      style={{
        alignItems: 'center',
        backgroundColor: state === 'offline' ? 'transparent' : color,
        borderColor: ringColor ?? 'transparent',
        borderRadius: total / 2,
        borderWidth: ring,
        height: total,
        justifyContent: 'center',
        width: total
      }}
      testID={testID}
    >
      {/* Offline is a hollow ring: the state's colour as an outline, nothing in it. */}
      {state === 'offline' ? (
        <View
          style={{
            borderColor: color,
            borderRadius: size / 2,
            borderWidth: Math.max(1.5, Math.round(size * 0.16)),
            height: size,
            width: size
          }}
        />
      ) : null}

      {state === 'working' ? (
        <View
          style={{
            backgroundColor: 'rgba(255,255,255,0.95)',
            borderRadius: size * 0.18,
            height: size * 0.36,
            width: size * 0.36
          }}
        />
      ) : null}

      {state === 'needsInput' ? (
        <View
          style={{
            backgroundColor: 'rgba(255,255,255,0.95)',
            borderRadius: 1,
            height: size * 0.42,
            width: 2
          }}
        />
      ) : null}

      {state === 'needsInput' ? (
        // Positioned from the parent's padding box, which is inside the ring, so
        // the offset has to clear the ring as well as the gap.
        <Pulse box={total + 8} color={color} enabled={!theme.reduceMotion} offset={-(ring + 4)} />
      ) : null}
    </View>
  )
}

/**
 * The amber ring, expanding and fading on a two-second loop.
 *
 * `useNativeDriver` is on: `transform` and `opacity` are both native-driver
 * eligible, and this is the one animation in the app that runs forever — on the
 * JavaScript thread it would be the first thing a scrolling list stutters.
 */
function Pulse({ box, color, enabled, offset }: { box: number; color: string; enabled: boolean; offset: number }) {
  const theme = useTheme()
  const progress = useRef(new Animated.Value(0)).current

  useEffect(() => {
    if (!enabled) {
      return
    }

    const loop = Animated.loop(
      Animated.timing(progress, {
        duration: motion.pulse,
        easing: easing.pulse,
        toValue: 1,
        useNativeDriver: NATIVE_DRIVER
      })
    )

    loop.start()

    return () => loop.stop()
  }, [enabled, progress, theme.motion.pulse])

  return (
    <Animated.View
      pointerEvents="none"
      style={{
        borderColor: color,
        borderRadius: box / 2,
        borderWidth: 2,
        height: box,
        left: offset,
        opacity: enabled ? progress.interpolate({ inputRange: [0, 0.55, 1], outputRange: [0.6, 0, 0] }) : 0.45,
        position: 'absolute',
        top: offset,
        transform: enabled
          ? [{ scale: progress.interpolate({ inputRange: [0, 0.55, 1], outputRange: [0.92, 1.2, 1.2] }) }]
          : [],
        width: box
      }}
    />
  )
}
