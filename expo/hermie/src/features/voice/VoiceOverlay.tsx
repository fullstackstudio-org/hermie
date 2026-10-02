/**
 * Voice mode, on screen: one ring, one line of state, and two ways out.
 *
 * It is deliberately almost empty. A reader in voice mode is not looking at the
 * phone — that is the whole point of the mode — so everything here is for the
 * glance that checks whether it is still listening, and the tap that stops it
 * talking. A transcript, a history or a set of controls would be a screen
 * competing with the conversation it exists to keep you out of.
 *
 * ## The ring
 *
 * One circle, scaled by the recognizer's own input level while listening, and a
 * slow pulse while it is speaking or waiting. It is the only animated thing in
 * the app besides the "needs input" pulse, and it earns that for the same
 * reason: it is the one signal that says a microphone is open.
 *
 * **Under Reduce Motion it does not move at all** — not "moves less". The ring
 * becomes a static outline and the phase line carries the state instead. That is
 * `src/ui/motion.ts`'s rule applied to a surface whose whole content is motion:
 * the alternative is a reader who asked for stillness and got a pulsing circle
 * filling their screen.
 *
 * ## Two ways out, and a third that is not one
 *
 * Swipe down, or Escape on a keyboard. **A tap does not leave** — it interrupts
 * the reply being read, which is the gesture a conversation needs most often —
 * so the two are never confused. The drag is `PanResponder` rather than a
 * gesture library, exactly as `ImageViewer` is and for the reason ADR-0010
 * gives.
 */
import { useEffect, useMemo, useRef } from 'react'
import { Animated, Dimensions, Modal, PanResponder, Pressable, View } from 'react-native'

import { chatStrings } from '../../chat-ui/strings'
import { GlassSurface } from '../../ui/glass'
import { Text } from '../../ui/primitives'
import { durationFor, easing, motion, NATIVE_DRIVER } from '../../ui/motion'
import { useTheme } from '../../ui/theme'
import { useEscapeKey } from '../../ui/useEscapeKey'
import { SCRIM_COLOR, TAP_SLOP } from '../../ui/tokens'
import type { VoiceLoopState, VoicePhase } from './voice-loop'

/** How far down the overlay has to be dragged before letting go leaves. */
export const DISMISS_DISTANCE = 120

/** The ring at rest, in points. Big enough to be the only thing on the screen. */
export const RING_SIZE = 168

/** How much the ring grows at full input level. */
export const RING_GAIN = 0.35

export interface VoiceOverlayProps {
  visible: boolean
  state: VoiceLoopState
  /** Which bot is being spoken to, for the line above the ring. */
  botName: string
  /** A tap: cut the reply being read. Does nothing in any other phase. */
  onInterrupt: () => void
  /** Do not send what is on screen. Only drawn while confirming. */
  onCancel: () => void
  onLeave: () => void
  testID?: string
}

/** What the line under the ring says, per phase. */
export function phaseLabel(phase: VoicePhase): string {
  switch (phase) {
    case 'listening':
      return chatStrings.voice.modeListening

    case 'confirming':
    case 'sending':
      return chatStrings.voice.modeSending

    case 'waiting':
      return chatStrings.voice.modeThinking

    case 'speaking':
      return chatStrings.voice.modeSpeaking

    default:
      return ''
  }
}

export function VoiceOverlay({
  botName,
  onCancel,
  onInterrupt,
  onLeave,
  state,
  testID = 'voice-overlay',
  visible
}: VoiceOverlayProps) {
  const theme = useTheme()
  const reduced = theme.reduceMotion
  const height = Dimensions.get('window').height
  const offsetY = useRef(new Animated.Value(0)).current
  /** The ring's own scale: driven by level while listening, by a loop otherwise. */
  const ring = useRef(new Animated.Value(1)).current

  useEscapeKey(onLeave, visible)

  const listening = state.phase === 'listening'

  /**
   * The level, as a PLAIN number rather than an animated one.
   *
   * No tween between readings: the recognizer reports several times a second
   * and a 200ms curve between each pair would lag behind the voice it is
   * supposed to be showing — the indicator would be smooth and wrong. The level
   * is already React state (it rides on `VoiceLoopState`), so this re-renders
   * exactly as often as it changes and not once more.
   *
   * Under Reduce Motion it is pinned at rest. That is the rule `src/ui/motion.ts`
   * states, applied to a surface whose whole content is motion: a reader who
   * asked for stillness must not get a pulsing circle filling their screen.
   */
  const levelScale = listening && !reduced ? 1 + state.level * RING_GAIN : null

  /*
    Waiting and speaking have no level to show, so the ring breathes instead —
    the same 2s loop the "needs input" bead uses, for the same reason: it is the
    app's one shape for "something is happening that you do not have to do
    anything about".
  */
  const pulsing = state.phase === 'waiting' || state.phase === 'speaking'

  useEffect(() => {
    if (!pulsing || reduced) {
      // Reduce Motion, or nothing to pulse about: a still ring at its own size.
      ring.setValue(1)

      return
    }

    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(ring, {
          duration: durationFor('pulse', reduced) / 2,
          easing: easing.pulse,
          toValue: 1.08,
          useNativeDriver: NATIVE_DRIVER
        }),
        Animated.timing(ring, {
          duration: durationFor('pulse', reduced) / 2,
          easing: easing.pulse,
          toValue: 1,
          useNativeDriver: NATIVE_DRIVER
        })
      ])
    )

    loop.start()

    return () => loop.stop()
  }, [pulsing, reduced, ring])

  useEffect(() => {
    if (visible) {
      offsetY.setValue(0)
    }
  }, [offsetY, visible])

  const responder = useMemo(
    () =>
      PanResponder.create({
        // Downward only, and only past the slop: an upward drag and a tap both
        // belong to the interrupt underneath.
        onMoveShouldSetPanResponder: (_event, gesture) => gesture.dy > 8 && gesture.dy > Math.abs(gesture.dx),
        onPanResponderMove: (_event, gesture) => {
          offsetY.setValue(Math.max(0, gesture.dy))
        },
        onPanResponderRelease: (_event, gesture) => {
          if (gesture.dy > DISMISS_DISTANCE) {
            onLeave()

            return
          }

          Animated.timing(offsetY, {
            duration: durationFor('sheet', reduced),
            easing: easing.exit,
            toValue: 0,
            useNativeDriver: NATIVE_DRIVER
          }).start()
        }
      }),
    [offsetY, onLeave, reduced]
  )

  if (!visible) {
    return null
  }

  const confirming = state.phase === 'confirming'

  return (
    <Modal animationType={reduced ? 'none' : 'fade'} onRequestClose={onLeave} statusBarTranslucent transparent visible>
      <Animated.View
        style={{
          // The same scrim a bottom sheet lays down, so voice mode reads as
          // another surface of this app rather than as a second application.
          backgroundColor: SCRIM_COLOR,
          flex: 1,
          // The whole surface travels with the drag, so letting go halfway
          // reads as a sheet that came back rather than as a flicker.
          opacity: offsetY.interpolate({ inputRange: [0, height], outputRange: [1, 0.2] }),
          transform: [{ translateY: offsetY }]
        }}
        testID={testID}
        {...responder.panHandlers}
      >
        {/*
          The tap target is the whole screen, and it INTERRUPTS.

          Leaving is the swipe and the Escape key. A reader who taps to stop the
          reply talking and found themselves back in the chat would have lost
          the mode by doing the commonest thing in it.
        */}
        <Pressable
          accessibilityLabel={chatStrings.voice.modeInterrupt}
          accessibilityRole="button"
          onPress={onInterrupt}
          style={{ alignItems: 'center', flex: 1, justifyContent: 'center', padding: theme.space.xl }}
          testID={`${testID}-stage`}
        >
          <Text color="textMuted" variant="meta">
            {botName}
          </Text>

          <View style={{ alignItems: 'center', height: RING_SIZE, justifyContent: 'center', width: RING_SIZE }}>
            <Animated.View
              style={{
                borderColor: theme.accent().fill,
                borderRadius: RING_SIZE / 2,
                // Filled while listening, an outline otherwise: the one state
                // where a microphone is open is the one that looks different
                // from across a room.
                backgroundColor: listening ? theme.accent().bubble : 'transparent',
                borderWidth: 3,
                height: RING_SIZE,
                // One of the two, never both: the level while a microphone is
                // open, the breathing loop while something else is happening.
                transform: [{ scale: levelScale ?? ring }],
                width: RING_SIZE
              }}
              testID={`${testID}-ring`}
            />
          </View>

          <Text style={{ marginTop: theme.space.lg }} variant="sheetTitle">
            {phaseLabel(state.phase)}
          </Text>

          {/*
            What it heard, while it is deciding whether to send it.

            The one place a transcript is shown, and only for the second it can
            still be stopped. Showing it for longer would turn the overlay into a
            reading surface, which is what voice mode is for avoiding.
          */}
          {confirming || state.phase === 'sending' ? (
            <GlassSurface
              contentStyle={{ paddingHorizontal: theme.space.lg, paddingVertical: theme.space.md }}
              radius={theme.radii.card}
              style={{ marginTop: theme.space.lg, maxWidth: 420 }}
              testID={`${testID}-transcript`}
              variant="float"
            >
              <Text>{state.transcript}</Text>
            </GlassSurface>
          ) : null}

          {confirming ? (
            <Pressable
              accessibilityRole="button"
              hitSlop={TAP_SLOP}
              onPress={onCancel}
              style={{ marginTop: theme.space.md, padding: theme.space.sm }}
              testID={`${testID}-cancel`}
            >
              <Text color="dangerText">{chatStrings.voice.modeCancel}</Text>
            </Pressable>
          ) : null}

          {state.phase === 'error' ? (
            <Text color="dangerText" style={{ marginTop: theme.space.lg }} variant="meta">
              {chatStrings.voice.failed}
            </Text>
          ) : null}

          <Text color="textFaint" style={{ marginTop: theme.space.xl }} variant="micro">
            {chatStrings.voice.modeDismiss}
          </Text>
        </Pressable>
      </Animated.View>
    </Modal>
  )
}

/** Exported for the suite: the token the pulse is timed against. */
export const PULSE_MS = motion.pulse
