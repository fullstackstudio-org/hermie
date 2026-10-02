/**
 * The app's bottom sheet: `Modal` + `Animated` + one `PanResponder`.
 *
 * It slides with `Animated` on the JS driver — `useNativeDriver` is unavailable
 * for layout properties — and it goes three ways: a tap on the backdrop, Escape
 * from a hardware keyboard, and a drag down that follows the finger.
 *
 * ## Why a question can be dismissed now, and ADR-0010 is still intact
 *
 * The sheet used to take a `blocking` flag that switched all three off for an
 * agent's question, because "a swipe that lands on Allow is not consent". That
 * reading was one word too wide. ADR-0010 is about ANSWERING: an answer is an
 * explicit tap on a named choice, and no gesture here produces one. Dismissing
 * is not an answer — the question stays open on the gateway and stays in the
 * transcript as a row with an `Answer` button that brings the sheet back — so
 * the rule that matters is untouched, and the reader is no longer trapped
 * under a panel they wanted to look behind.
 *
 * `PanResponder` rather than `react-native-gesture-handler`: the app does not
 * depend on the latter, and this is one vertical drag with one threshold.
 *
 * This used to be three files. `react-native-macos` had no `RCTModalHostView`,
 * so a `Modal` red-boxed on a Mac and the sheet was split into a shared body
 * plus one presenter per platform. The Mac is the iPad build now (ADR-0011) and
 * has a real `Modal`, so the split is gone.
 */
import { useMemo, useRef, type ReactNode } from 'react'
import {
  Animated,
  KeyboardAvoidingView,
  Modal,
  PanResponder,
  Pressable,
  ScrollView,
  StyleSheet,
  useWindowDimensions,
  View,
  type GestureResponderEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  type PanResponderGestureState,
  type ViewStyle
} from 'react-native'

import { strings } from '../i18n/strings'
import { directTouchPanRef } from '../platform/pointer-drag'
import { useSafeAreaInsets } from '../platform/safe-area'
import { GlassSurface } from './glass'
import { KEYBOARD_AVOID_BEHAVIOR } from './keyboard'
import { Text } from './primitives'
import { motion, spring, usePresence } from './motion'
import { useTheme } from './theme'
import { Icon, ICON_SIZE } from './Icon'
import { REGULAR_LAYOUT_MIN_WIDTH, SCRIM_COLOR, SHEET_MAX_WIDTH, SIDEBAR_WIDTH, TAP_SLOP, WINDOW_GAP } from './tokens'
import { useEscapeKey } from './useEscapeKey'
import { useShortcutScope } from './useShortcut'

export interface BottomSheetProps {
  visible: boolean
  /**
   * The reader asked for this sheet to go: a backdrop tap, Escape, a hardware
   * back press, or a drag past the dismissal threshold.
   *
   * It is never an ANSWER. A sheet carrying an agent's question hands this to
   * the same handler that the `Later` button uses — the question is put aside,
   * not resolved.
   */
  onRequestClose: () => void
  children: ReactNode
  /** Sheet content scrolls by default; a sheet that manages its own scrolling opts out. */
  scrollable?: boolean
  accessibilityLabel?: string
  testID?: string
  contentStyle?: ViewStyle
  /**
   * The slide-out has finished and the sheet is off the screen.
   *
   * `ChatSheetHost` swaps one sheet for another on this, which is the only way
   * to open the next one after the previous one has actually gone rather than
   * on top of it.
   */
  onClosed?: () => void
}

export const SHEET_ANIMATION_MS = motion.sheet

/** Far enough that a settling finger is not a drag; short enough to feel direct. */
const DRAG_SLOP = 6

/** Past a third of the sheet's own height, letting go dismisses it. */
const DRAG_DISMISS_FRACTION = 1 / 3

/**
 * …or a flick: 500 pt/s, which `PanResponder` reports in points per
 * MILLISECOND. A fast, short drag is still a dismissal.
 */
const DRAG_DISMISS_VELOCITY = 0.5

/**
 * Is this gesture a dismissal starting, rather than a scroll or a tap?
 *
 * Downward, past the slop, and more vertical than horizontal. Exported because
 * a test renderer can ask this directly, and cannot drag anything.
 */
export function beginsSheetDrag(gesture: { dx: number; dy: number }): boolean {
  return gesture.dy > DRAG_SLOP && Math.abs(gesture.dy) > Math.abs(gesture.dx)
}

/**
 * Where a drag of `dy` points puts the slide-in's own 0…1 value.
 *
 * The SAME value the sheet opened on, which is what makes the drag and the
 * animation one motion rather than two things that agree: 1 is fully up, 0 is
 * one sheet-height below the window.
 *
 * Upward is CLAMPED rather than rubber-banded, and that is a deliberate
 * departure from the usual bounce. A sheet is anchored to the window's bottom
 * edge and its lower corners are square against it; lifting it by even a few
 * points opens a strip of window underneath — which is the defect the previous
 * round went and removed. So the sheet's own place is as high as it goes.
 */
export function sheetDragProgress(dy: number, height: number): number {
  if (height <= 0) {
    return 1
  }

  return Math.max(0, Math.min(1, 1 - dy / height))
}

/** Does letting go here dismiss the sheet, or spring it back? */
export function releaseDismissesSheet(gesture: { dy: number; vy: number }, height: number): boolean {
  if (gesture.dy <= 0) {
    return false
  }

  return gesture.dy > height * DRAG_DISMISS_FRACTION || gesture.vy > DRAG_DISMISS_VELOCITY
}

export interface SheetDrag {
  /** The slide-in's own value, which the drag writes to directly. */
  progress: Animated.Value
  /** The sheet's height right now. Read per gesture, not captured. */
  height: () => number
  /** Is the content inside scrolled to its top? */
  atTop: () => boolean
  onRequestClose: () => void
}

/**
 * The whole drag, as the configuration `PanResponder.create` takes.
 *
 * A function rather than inline callbacks so that the behaviour can be exercised
 * without a touch screen: `PanResponder` computes its gesture state from a
 * stream of native touches and there is no honest way to synthesise one, but the
 * four callbacks below are exactly what it would call, and a test can call them
 * with the gesture it means.
 */
export function sheetDragConfig({ progress, height, atTop, onRequestClose }: SheetDrag) {
  const springBack = () => Animated.spring(progress, { ...spring.settle, toValue: 1, useNativeDriver: false }).start()

  return {
    /*
      Two questions, and the difference between them is the whole of "scrollable
      content only drag-dismisses when scrolled to top".

      The CAPTURE phase runs from the root down, so answering yes there takes the
      gesture away from the `ScrollView` inside. That is only allowed while the
      content is already at its top, where there is nothing left to scroll and a
      downward drag can only mean the sheet.

      The bubble phase runs from the touched view up, and is reached only when
      nothing deeper claimed the gesture — which is what makes the grip bar
      (outside the scroll view) a handle without any code of its own.
    */
    onMoveShouldSetPanResponder: (_event: GestureResponderEvent, gesture: PanResponderGestureState) =>
      beginsSheetDrag(gesture),
    onMoveShouldSetPanResponderCapture: (_event: GestureResponderEvent, gesture: PanResponderGestureState) =>
      atTop() && beginsSheetDrag(gesture),

    // The sheet may still be sliding IN when a finger lands on it.
    onPanResponderGrant: () => progress.stopAnimation(),
    onPanResponderMove: (_event: GestureResponderEvent, gesture: PanResponderGestureState) =>
      progress.setValue(sheetDragProgress(gesture.dy, height())),

    onPanResponderRelease: (_event: GestureResponderEvent, gesture: PanResponderGestureState) => {
      if (releaseDismissesSheet(gesture, height())) {
        // Nothing is animated here. `visible` goes false, and the presence
        // effect carries the value the finger left behind the rest of the way
        // down — one motion, from the drag straight into the slide-out.
        onRequestClose()

        return
      }

      springBack()
    },
    onPanResponderTerminate: springBack
  }
}

/**
 * `mounted` trails `visible` by one animation, so the sheet can slide out
 * before it stops existing.
 *
 * ## The opening animation, and the one character that had eaten it
 *
 * The value used to start at `visible ? 1 : 0`, and every sheet in this app is
 * mounted AT THE MOMENT it becomes visible — `ChatSheetHost` renders one only
 * when there is one to show. So the first render already had `visible === true`,
 * the value already stood at 1, and the effect then animated 1 → 1: the sheet
 * was simply THERE, fully up, with no slide and no backdrop fade. Closing
 * animated 1 → 0 and looked correct, which is exactly why this survived — the
 * owner's report is "they appear instantly and only animate when closing".
 *
 * It now always starts at 0 and is animated up, on mount and on every
 * `visible` → true. There is no case that wants the old behaviour: a sheet
 * mounted invisible renders nothing at all, so starting from 0 costs it nothing.
 * Both of those are `usePresence`'s guarantees now rather than this file's, and
 * that is the point: three other surfaces were making the same promise in their
 * own words and one of them was not keeping it.
 *
 * `reduceMotion` collapses the duration rather than skipping the animation, so
 * the completion callback — which is what unmounts a closed sheet — still runs
 * on exactly the same path.
 *
 * The sheet gained a CURVE here. It had none: `Animated.timing` with no `easing`
 * is `Easing.inOut(Easing.ease)`, which is symmetric, and a symmetric curve is
 * what makes a panel look like it is being scrubbed rather than arriving. In and
 * out now take the decelerate and accelerate halves respectively.
 *
 * The driver is left on the JavaScript side. `opacity` and `translateY` would
 * both be native-driver eligible, but the closing half has always run this way
 * and looked right, so the driver is not what was wrong here; changing it would
 * be an unverifiable change riding along with a verifiable one.
 */
function useSheetPresence(
  visible: boolean,
  reduceMotion: boolean,
  onClosed?: () => void
): { mounted: boolean; progress: Animated.Value } {
  const { present, progress } = usePresence(visible, {
    onExited: onClosed,
    reduceMotion,
    token: 'sheet',
    useNativeDriver: false
  })

  return { mounted: present, progress }
}

/**
 * Where the sheet sits, and how wide it is allowed to get.
 *
 * On a phone it is the window, edge to edge. On the wide layout a sheet that
 * spanned a 1366pt window would put its buttons a hand's width apart and lay a
 * scrim over the chat list the reader is still using, so it is capped and parked
 * over the CONTENT COLUMN — the panel the sheet belongs to — rather than centred
 * on the window. The left inset is the sidebar's own width plus the gaps around
 * it, which is where that column starts.
 */
function sheetBox(width: number, height: number): { maxHeight: number; maxWidth: number; left: number } {
  const maxHeight = Math.round(height * 0.86)

  if (width < REGULAR_LAYOUT_MIN_WIDTH) {
    return { left: 0, maxHeight, maxWidth: width }
  }

  const column = SIDEBAR_WIDTH + WINDOW_GAP * 2

  return { left: column, maxHeight, maxWidth: Math.min(SHEET_MAX_WIDTH, width - column) }
}

export function BottomSheet({
  visible,
  onClosed,
  onRequestClose,
  children,
  scrollable = true,
  accessibilityLabel,
  testID,
  contentStyle
}: BottomSheetProps) {
  const theme = useTheme()
  const insets = useSafeAreaInsets()
  const window = useWindowDimensions()
  const { mounted, progress } = useSheetPresence(visible, theme.reduceMotion, onClosed)

  /**
   * Escape closes the sheet — the topmost one, and only that one.
   *
   * `useEscapeKey` is a stack, so the key never falls through to what is under
   * the sheet: the composer will not stop a turn because someone closed a panel
   * over it. That was the whole reason a question used to register a handler
   * that did nothing, and a handler that closes swallows the key just as well.
   */
  useEscapeKey(onRequestClose, mounted)

  /**
   * And while it is up, a shortcut that would switch SURFACE does nothing.
   *
   * Escape's stack answers "who closes"; this answers "is the chat list even
   * reachable from here". ⌘K under an open sheet used to put the caret in a
   * search field behind it — the reader then typed into something they could not
   * see. ⌘W is not affected: leaving is what it is for.
   */
  useShortcutScope(mounted)

  const { left, maxHeight, maxWidth } = sheetBox(window.width, window.height)

  /**
   * What the drag needs to know, read from inside a responder that was built
   * once: how tall the sheet is, whether its scroll view is at the top, and
   * where to send a dismissal.
   */
  const height = useRef(maxHeight)
  const atTop = useRef(true)
  const close = useRef(onRequestClose)

  height.current = maxHeight
  close.current = onRequestClose

  const pan = useMemo(
    () =>
      PanResponder.create(
        sheetDragConfig({
          atTop: () => atTop.current,
          height: () => height.current,
          onRequestClose: () => close.current(),
          progress
        })
      ),
    [progress]
  )

  const onScroll = useMemo(
    () => (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      atTop.current = event.nativeEvent.contentOffset.y <= 0
    },
    []
  )

  if (!mounted) {
    return null
  }

  const body = (
    <View
      style={{
        gap: theme.space.md,
        paddingBottom: insets.bottom + theme.space.lg,
        paddingHorizontal: theme.space.xl,
        paddingTop: theme.space.xs
      }}
    >
      {children}
    </View>
  )

  /*
    The grip bar, OUTSIDE the scroll view.

    That placement is what makes it a handle. A drag is offered to the deepest
    view first, and a `ScrollView` takes every vertical one; up here nothing
    claims the gesture, so it reaches the panel's responder whatever the content
    below is doing. The bar stays silent to VoiceOver — it is a target for a
    gesture, and the labelled way out is the backdrop's `Dismiss`.
  */
  const grip = (
    <View
      accessibilityElementsHidden
      // `aria-hidden` is the web's spelling of the two props around it; react-native-web
      // honours neither of those. See `ui/Icon.tsx`.
      aria-hidden
      importantForAccessibility="no-hide-descendants"
      style={{ alignItems: 'center', paddingBottom: theme.space.xs, paddingTop: theme.space.md }}
      testID="sheet-grip"
    >
      <View style={{ backgroundColor: theme.hairline, borderRadius: 3, height: 5, width: 40 }} testID="sheet-grabber" />
    </View>
  )

  return (
    <Modal
      animationType="none"
      // Android draws the sheet's own backdrop behind the system bars rather
      // than leaving two opaque strips above and below a dimmed screen. The
      // navigation-bar flag is only honoured together with the status-bar one.
      navigationBarTranslucent
      onRequestClose={onRequestClose}
      statusBarTranslucent
      transparent
      visible={mounted}
    >
      {/* `flex: 1` and `justifyContent: 'flex-end'` are what park the panel at
          the bottom of the modal's root. */}
      <View style={{ flex: 1, justifyContent: 'flex-end' }} testID={testID}>
        {/*
          The scrim is the WHOLE modal, underneath everything.

          It used to be a `flex: 1` sibling ABOVE the column in this column
          layout, which made it exactly the space the panel did not take — so it
          covered the gap over the sheet and nothing else. On a phone that is the
          whole of the backdrop and the defect is invisible. On the wide layout
          the panel is capped at `SHEET_MAX_WIDTH` and parked over the content
          column, so most of what a reader sees as "outside the sheet" is BESIDE
          it, and a tap there landed on the column below — a plain transparent
          `View`, which absorbs a touch as readily as an opaque one. The owner's
          report is the whole of that: on a Mac and on an iPad the backdrop does
          not close the sheet.

          `absoluteFill` under the flow children is the fix, and it is also the
          simpler tree: one layer that means "anywhere but the panel" rather than
          a layer whose meaning depends on how tall the panel happens to be.
        */}
        <Animated.View style={[StyleSheet.absoluteFill, { opacity: progress }]}>
          <Pressable
            accessibilityLabel={strings.common.dismiss}
            accessibilityRole="button"
            onPress={onRequestClose}
            style={[StyleSheet.absoluteFill, { backgroundColor: SCRIM_COLOR }]}
            testID={testID ? `${testID}-backdrop` : 'sheet-backdrop'}
          />
        </Animated.View>

        <KeyboardAvoidingView
          behavior={KEYBOARD_AVOID_BEHAVIOR}
          /*
            `box-none`: the column lays the panel out and takes no touch of its
            own.

            It spans the window's full width so that the panel can be centred in
            the content column, which means the strip to either side of a capped
            sheet is this view and not the scrim. `auto` there is a transparent
            view swallowing the tap the reader aimed at the backdrop; `box-none`
            lets it through to the scrim below while the panel — a child — keeps
            receiving everything aimed at it.
          */
          pointerEvents="box-none"
          // The column inset lives here rather than on the root so it travels with
          // the sheet when the keyboard pushes it up.
          // `paddingBottom: 0` is explicit rather than assumed: this is a
          // `KeyboardAvoidingView`, whose whole job is to add one, and the card
          // below it has to reach the window's edge when it is not doing that.
          style={{ alignItems: 'center', paddingBottom: 0, paddingLeft: left }}
          testID={testID ? `${testID}-column` : 'sheet-column'}
        >
          <Animated.View
            accessibilityLabel={accessibilityLabel}
            accessibilityViewIsModal
            {...pan.panHandlers}
            style={{
              maxHeight,
              maxWidth,
              transform: [
                {
                  translateY: progress.interpolate({ inputRange: [0, 1], outputRange: [maxHeight, 0] })
                }
              ],
              width: '100%'
            }}
            testID={testID ? `${testID}-panel` : 'sheet-panel'}
          >
            {/*
              `opaque`: a sheet carries body text and often a command, so its
              contrast has to be a fixed number rather than a function of the
              wallpaper it happens to be over.

              `radiusBottom={0}`: the sheet sits ON the window's bottom edge, so
              its lower corners are square and there is nothing under it. That
              used to be said by overriding four style keys on two of the
              surface's views, which left the third — the native material — still
              rounded; a material is not clipped by a parent's corner mask the way
              a plain layer is, and the owner's report is a rounded lower edge with
              a strip of window showing beneath it. One number now reaches every
              layer. The safe-area inset is padding INSIDE the card (see `body`),
              never a margin under it.
            */}
            <GlassSurface
              contentStyle={[{ maxHeight }, contentStyle]}
              opaque
              radius={theme.radii.sheet}
              radiusBottom={0}
              variant="sheet"
            >
              {grip}
              {scrollable ? (
                <ScrollView
                  keyboardShouldPersistTaps="handled"
                  onScroll={onScroll}
                  ref={directTouchPanRef}
                  // The drag has to know whether the content is at its top, and
                  // 16ms is the interval that makes the answer true for the
                  // frame the gesture starts on.
                  scrollEventThrottle={16}
                  showsVerticalScrollIndicator={false}
                >
                  {body}
                </ScrollView>
              ) : (
                body
              )}
            </GlassSurface>
          </Animated.View>
        </KeyboardAvoidingView>
      </View>
    </Modal>
  )
}

/**
 * The small capitalised line the design board puts above a sheet's title.
 *
 * It is the `micro` token — §3's uppercase label — rather than three numbers
 * written out beside it, which is how it had drifted to a heavier weight and
 * nearly twice the tracking the scale asks for.
 */
export function SheetEyebrow({ children }: { children: string }) {
  return (
    <Text color="textFaint" variant="micro">
      {children.toUpperCase()}
    </Text>
  )
}

/**
 * A PAGE inside a sheet: a back control, a title, and a body.
 *
 * Shared rather than written per sheet, because the affordance has to be in the
 * same place with the same glyph wherever a sheet goes one level deeper — that
 * is the visible half of "Escape goes back one level", and a page whose back
 * control moved would make the key feel like a different key. The caller owns
 * the Escape registration itself: the handler has to be installed by whoever
 * sits ABOVE the `BottomSheet` in the tree, so that it registers last and wins
 * the key (see `useEscapeKey`).
 */
export function SheetPage({
  children,
  onBack,
  title,
  backLabel = 'Back',
  testID = 'sheet-page-back'
}: {
  children: ReactNode
  onBack: () => void
  title: string
  backLabel?: string
  testID?: string
}) {
  const theme = useTheme()

  return (
    <View style={{ gap: theme.space.md }}>
      <View style={{ alignItems: 'center', flexDirection: 'row', gap: theme.space.sm }}>
        <Pressable
          accessibilityLabel={backLabel}
          accessibilityRole="button"
          hitSlop={TAP_SLOP}
          onPress={onBack}
          style={{ alignItems: 'center', justifyContent: 'center', minHeight: 32, minWidth: 24 }}
          testID={testID}
        >
          {/* The theme's accent, for the reason `ChatHeader` gives. */}
          <Icon color={theme.accent().text} name="chevronLeft" size={ICON_SIZE.control} />
        </Pressable>
        <Text style={{ flex: 1 }} variant="sheetTitle">
          {title}
        </Text>
      </View>

      {children}
    </View>
  )
}
