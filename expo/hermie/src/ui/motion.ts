/**
 * Motion: every duration, curve and spring in the app, in one file.
 *
 * The rule that matters more than the numbers, and it has not changed:
 * **animation is reserved for things that need the reader.** The only presence
 * state that animates is "needs input" — a 2s, low-amplitude amber ring pulse.
 * Working is static; a bot being busy is information, not a request. Under
 * Reduce Motion every duration collapses to zero and the pulse resolves to a
 * static ring.
 *
 * What is new is that there is one place to read that rule off. Before this file
 * the numbers were in three: `tokens.motion` held five values of which two were
 * used, `BottomSheet` exported its own `SHEET_ANIMATION_MS = 220`, and
 * `SidebarOverlay` exported its own `SIDEBAR_OVERLAY_MOTION = 200` — and the
 * token actually NAMED `sheet` was 420 and belonged to the iPad overlay panel,
 * which is the kind of thing that is only ever discovered by animating the wrong
 * surface. The names below say which surface each number is for, so the next
 * reader cannot pick the wrong one by reading the right name.
 *
 * ### Why these curves
 *
 * `enter` is a decelerate curve: fast at the start, settling at the end. That is
 * what a thing arriving under its own momentum does, and it is the curve iOS
 * uses for a pushed screen. `exit` is its mirror — a thing leaving accelerates
 * away — and the pair is what keeps an in and an out from feeling like the same
 * animation played backwards, which is the tell of a web transition.
 * `standard` is for a value moving between two states while staying put: a knob,
 * a track, a highlight. `pulse` is the one loop.
 *
 * ### Why a duration is a number and a curve is a function
 *
 * `Easing.bezier` allocates, and an easing built inside a component body builds
 * a new one per render. These are built once, at module scope.
 */
import { Animated, Easing, Platform, type EasingFunction } from 'react-native'
import { useEffect, useRef, useState } from 'react'

/**
 * Durations, in milliseconds, named for the surface that moves.
 *
 * `panel` and `sheet` really are different, and both are deliberate: the iPad
 * overlay panel travels most of a window's width and a bottom sheet travels its
 * own height, so the same duration would read as two different speeds.
 */
export const motion = {
  /** A pressed or hovered state settling. Short enough to read as instant. */
  press: 120,
  /** A chip, a pill or a popover arriving: the jump-to-latest pill, the slash list. */
  chip: 180,
  /** A row appearing or leaving in a list: a queued message, the drop overlay. */
  row: 260,
  /** The switch knob crossing its track. */
  control: 140,
  /** The bottom sheet, in and out. */
  sheet: 220,
  /** The iPad and Mac overlay panel, and the scrim under it. */
  panel: 420,
  /** The sidebar slide-over, below 900pt. */
  sidebar: 200,
  /** One typing dot's rise, and its fall. */
  dot: 340,
  /** The gap between one typing dot and the next. */
  dotStagger: 140,
  /** The "needs input" pulse, the one loop in the app. */
  pulse: 2000
} as const

export type MotionToken = keyof typeof motion

/** The four curves. Built once — see the note above about allocation. */
export const easing: Record<'enter' | 'exit' | 'standard' | 'pulse', EasingFunction> = {
  enter: Easing.bezier(0.22, 0.61, 0.36, 1),
  exit: Easing.bezier(0.55, 0, 0.67, 0.35),
  standard: Easing.bezier(0.4, 0, 0.2, 1),
  pulse: Easing.bezier(0.4, 0, 0.2, 1)
}

/**
 * The one spring: a drag let go of, returning to where it came from.
 *
 * `bounciness: 0` because it is a correction rather than an arrival — a sheet
 * that overshoots back up past its own top edge has just told the reader their
 * drag did something it did not. The legacy spring API is used rather than
 * damping/stiffness because that is what `Animated.spring` takes without a
 * config object per call site, and one spring does not need two vocabularies.
 */
export const spring = { settle: { bounciness: 0 } } as const

/**
 * A duration under Reduce Motion.
 *
 * Zero rather than "skip the animation", every time. A skipped animation is a
 * skipped completion callback, and the completion callback is what unmounts a
 * closed panel — so skipping is how a Reduce Motion reader ends up with a sheet
 * that never goes away. Collapsing the duration keeps exactly one code path.
 */
export const durationFor = (token: MotionToken, reduceMotion: boolean): number => (reduceMotion ? 0 : motion[token])

/**
 * A LOOP is the one thing this must never be used for.
 *
 * `Animated.loop` restarts its child the moment the child finishes, so a loop
 * built out of zero-duration timings finishes and restarts on the same frame,
 * for ever. The collapse-to-zero rule is right for an animation that has an
 * end; a loop has none, so the only correct Reduce Motion answer for one is not
 * to build it at all and to assign the resting value instead.
 *
 * All three loops in the app do exactly that and say so at the point of the
 * guard: the typing dots, the "needs input" ring, and the voice overlay's
 * pulse. `reduce-motion-audit.test.tsx` holds every one of them still.
 */

/**
 * Whether `Animated` can hand an animation to the platform.
 *
 * The native driver moves a value on the UI thread, which is why every
 * transform and opacity in this app asks for it. There is no such thread in a
 * browser: react-native-web ships no `RCTAnimation`, so `useNativeDriver: true`
 * there is answered with a fallback to the JS driver and a five-line warning
 * about running `pod install` — printed once per animation, which on one load
 * of a transcript was a dozen copies of advice that cannot apply.
 *
 * The behaviour was always the fallback. This only stops asking for something
 * the platform has already said it does not have.
 */
export const NATIVE_DRIVER = Platform.OS !== 'web'

export interface PresenceOptions {
  /** Which duration this surface moves at. */
  token: MotionToken
  reduceMotion: boolean
  /** `true` on a transform or opacity; `false` when the value drives layout. */
  useNativeDriver?: boolean
  /** Called once the exit has finished and the surface is off the screen. */
  onExited?: () => void
}

export interface Presence {
  /**
   * Render at all? Trails `visible` by one exit animation.
   *
   * A surface that unmounts on the first frame of its own exit does not leave,
   * it vanishes — which is the single most common way a native-feeling app stops
   * feeling native.
   */
  present: boolean
  /** 0 fully out, 1 fully in. Interpolate transforms and opacity off this. */
  progress: Animated.Value
}

/**
 * Enter and exit, as one hook.
 *
 * Four surfaces had hand-rolled this — the overlay panel, its scrim, the sidebar
 * slide-over and the bottom sheet — with the same `present` state, the same
 * `start(({ finished }) => …)` and the same cleanup, and the differences between
 * the four copies were all accidents: one had no easing at all, one used the
 * other's duration token. It is one hook now, so a fifth surface arrives correct
 * instead of arriving similar.
 *
 * The value always starts at 0 and is animated up, including on the very first
 * render. Every one of these surfaces is mounted AT THE MOMENT it becomes
 * visible, so a value initialised to `visible ? 1 : 0` stands at 1 before the
 * effect runs and then animates 1 → 1: present, with no arrival. That was a real
 * bug in the sheet and it is structurally impossible here.
 *
 * Enter and exit take different curves, which is the other thing the copies got
 * wrong by omission.
 */
export function usePresence(visible: boolean, options: PresenceOptions): Presence {
  const { onExited, reduceMotion, token, useNativeDriver = NATIVE_DRIVER } = options
  const progress = useRef(new Animated.Value(0)).current
  const [present, setPresent] = useState(visible)
  const exited = useRef(onExited)

  exited.current = onExited

  useEffect(() => {
    if (visible) {
      setPresent(true)
    }

    const animation = Animated.timing(progress, {
      duration: durationFor(token, reduceMotion),
      easing: visible ? easing.enter : easing.exit,
      toValue: visible ? 1 : 0,
      useNativeDriver
    })

    animation.start(({ finished }) => {
      if (finished && !visible) {
        setPresent(false)
        exited.current?.()
      }
    })

    return () => animation.stop()
  }, [progress, reduceMotion, token, useNativeDriver, visible])

  return { present, progress }
}
