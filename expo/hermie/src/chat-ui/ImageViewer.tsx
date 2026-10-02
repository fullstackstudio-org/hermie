/**
 * One image, full screen: pinch to zoom, drag to dismiss, share.
 *
 * ## Why `PanResponder` and not a gesture library
 *
 * `react-native-gesture-handler` is not a dependency and adding one for a
 * single surface is a poor trade, so the two gestures are built from the
 * touches `PanResponder` already reports. That is workable precisely because
 * they do not overlap: the number of fingers decides which gesture is running,
 * so there is no recogniser conflict to arbitrate and no need for the
 * simultaneous-gesture machinery a library exists to provide.
 *
 *  - **Two fingers** is a pinch. The scale is the ratio of the current distance
 *    between the touches to the distance when the second finger landed.
 *  - **One finger** is a dismiss drag, but ONLY while the image is unzoomed. A
 *    zoomed image needs one-finger panning to reach its corners, and a drag
 *    that closed the viewer instead would make a zoomed image unreadable.
 *
 * ## Why the dismiss is vertical distance and not velocity
 *
 * `PanResponder` reports `vy`, and using it means a slow, deliberate drag all
 * the way down does not dismiss while a careless flick does. The distance rule
 * is the one a reader can see happening: the image follows the finger, the
 * backdrop thins as it goes, and past a third of the way it goes.
 *
 * ## Reduce Motion
 *
 * The gestures are direct manipulation — the image is under the finger — so
 * they are not animation and are not suppressed. What Reduce Motion does
 * collapse is the SETTLE: the spring back to centre becomes an assignment.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { Animated, Dimensions, Modal, PanResponder, Pressable, View } from 'react-native'

import { SHARE_FILE_VERB, shareFile } from '../platform/share-file'
import { NATIVE_DRIVER, spring } from '../ui/motion'
import { Text } from '../ui/primitives'
import { useTheme } from '../ui/theme'
import { TAP_SLOP } from '../ui/tokens'
import { chatStrings } from './strings'

export interface ImageViewerProps {
  /** The image to show; `null` closes the viewer. */
  uri: string | null
  /** The filename, for the title and for a download's suggested name. */
  name?: string
  onClose: () => void
  testID?: string
}

/** Past this fraction of the screen's height, letting go closes the viewer. */
export const DISMISS_FRACTION = 1 / 3

/** The pinch is clamped to this range; beyond it the gesture stops tracking. */
export const MIN_SCALE = 1
export const MAX_SCALE = 4

/** Distance between the first two touches, or `0` when there are not two. */
export function pinchDistance(touches: readonly { pageX: number; pageY: number }[]): number {
  const [first, second] = touches

  if (!first || !second) {
    return 0
  }

  return Math.hypot(second.pageX - first.pageX, second.pageY - first.pageY)
}

/** Clamp a pinch ratio into the range the viewer allows. */
export const clampScale = (scale: number): number => Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale))

/**
 * Whether letting go here should close the viewer.
 *
 * A zoomed image never dismisses on a drag: at that point one finger is panning
 * the image, and closing instead would put the corners out of reach.
 */
export function shouldDismiss(translateY: number, height: number, scale: number): boolean {
  return scale <= MIN_SCALE && Math.abs(translateY) > height * DISMISS_FRACTION
}

export function ImageViewer({ uri, name, onClose, testID = 'image-viewer' }: ImageViewerProps) {
  const theme = useTheme()
  const [height, setHeight] = useState(() => Dimensions.get('window').height)
  const reduced = theme.reduceMotion

  /**
   * Put a value back where it belongs.
   *
   * A spring under Reduce Motion is an assignment: the value still travels by
   * the same code path, so the end state cannot drift from the animated one.
   */
  const restore = useRef<(value: Animated.Value, to: number) => void>(() => undefined)

  restore.current = (value, to) => {
    if (reduced) {
      value.setValue(to)

      return
    }

    Animated.spring(value, { ...spring.settle, toValue: to, useNativeDriver: NATIVE_DRIVER }).start()
  }

  const scale = useRef(new Animated.Value(1)).current
  const offsetY = useRef(new Animated.Value(0)).current
  // The gesture's own numbers, read synchronously by the responder. An
  // `Animated.Value` cannot be read during a move without a listener, and a
  // listener per move is a subscription churn the gesture does not need.
  const live = useRef({ scale: 1, startDistance: 0, startScale: 1, translateY: 0 })

  useEffect(() => {
    if (uri) {
      // Every open starts from rest, or the second viewing of an image inherits
      // the zoom the first one was closed at.
      live.current = { scale: 1, startDistance: 0, startScale: 1, translateY: 0 }
      scale.setValue(1)
      offsetY.setValue(0)
      setHeight(Dimensions.get('window').height)
    }
  }, [offsetY, scale, uri])

  const responder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: (_event, gesture) =>
          // A tap must stay a tap: the close button and the backdrop are both
          // taps, and claiming the responder on every touch would eat them.
          Math.abs(gesture.dx) > 4 || Math.abs(gesture.dy) > 4,

        onPanResponderGrant: event => {
          const touches = event.nativeEvent.touches

          live.current.startScale = live.current.scale
          live.current.startDistance = pinchDistance(touches)
        },

        onPanResponderMove: (event, gesture) => {
          const touches = event.nativeEvent.touches

          if (touches.length >= 2) {
            const distance = pinchDistance(touches)

            if (!live.current.startDistance) {
              // The second finger landed mid-gesture; take this frame as the
              // pinch's origin rather than scaling by a ratio against zero.
              live.current.startDistance = distance
              live.current.startScale = live.current.scale

              return
            }

            const next = clampScale((live.current.startScale * distance) / live.current.startDistance)

            live.current.scale = next
            scale.setValue(next)

            return
          }

          // One finger. Only an unzoomed image is being dragged away; a zoomed
          // one is being panned, which this viewer does not offer yet, so it
          // simply does not move.
          if (live.current.scale <= MIN_SCALE) {
            live.current.translateY = gesture.dy
            offsetY.setValue(gesture.dy)
          }
        },

        onPanResponderRelease: () => {
          const { scale: current, translateY } = live.current

          live.current.startDistance = 0

          if (shouldDismiss(translateY, height, current)) {
            onClose()

            return
          }

          live.current.translateY = 0
          restore.current(offsetY, 0)

          if (current < MIN_SCALE) {
            live.current.scale = MIN_SCALE
            restore.current(scale, MIN_SCALE)
          }
        },

        onPanResponderTerminate: () => {
          live.current.startDistance = 0
          live.current.translateY = 0
          restore.current(offsetY, 0)
        }
      }),
    [height, offsetY, onClose, scale]
  )

  if (!uri) {
    return null
  }

  return (
    <Modal animationType={reduced ? 'none' : 'fade'} onRequestClose={onClose} statusBarTranslucent transparent visible>
      <View style={{ backgroundColor: '#000000', flex: 1 }} testID={testID}>
        {/* The backdrop takes a tap to close, the way a lightbox does. It is
            BEHIND the image rather than over it, so a tap on the photo itself
            does nothing and only the surrounding black closes. */}
        <Pressable
          accessibilityLabel={chatStrings.viewer.close}
          accessibilityRole="button"
          onPress={onClose}
          style={{ bottom: 0, left: 0, position: 'absolute', right: 0, top: 0 }}
          testID={`${testID}-backdrop`}
        />

        <Animated.View
          style={{
            alignItems: 'center',
            flex: 1,
            justifyContent: 'center',
            // The backdrop thins as the image travels, so the drag reads as
            // taking the image out of a space rather than sliding a card.
            opacity: offsetY.interpolate({
              inputRange: [-height, 0, height],
              outputRange: [0.2, 1, 0.2]
            }),
            transform: [{ translateY: offsetY }, { scale }]
          }}
          testID={`${testID}-stage`}
          {...responder.panHandlers}
        >
          <Animated.Image
            accessibilityIgnoresInvertColors
            accessibilityLabel={name}
            // Contain: a photo cropped to the screen loses the thing it was
            // attached to show, which is the whole reason the viewer exists.
            resizeMode="contain"
            source={{ uri }}
            style={{ height: '100%', width: '100%' }}
            testID={`${testID}-image`}
          />
        </Animated.View>

        <View
          style={{
            flexDirection: 'row',
            gap: theme.space.md,
            justifyContent: 'space-between',
            left: 0,
            padding: theme.space.lg,
            paddingTop: theme.space.xxl,
            position: 'absolute',
            right: 0,
            top: 0
          }}
        >
          <Pressable
            accessibilityLabel={chatStrings.viewer.close}
            accessibilityRole="button"
            hitSlop={TAP_SLOP}
            onPress={onClose}
            testID={`${testID}-close`}
          >
            <Text color="onAccent" style={{ fontSize: 22, lineHeight: 26 }}>
              {'✕'}
            </Text>
          </Pressable>

          {name ? (
            <Text color="onAccent" numberOfLines={1} style={{ flex: 1, textAlign: 'center' }} variant="meta">
              {name}
            </Text>
          ) : null}

          <Pressable
            accessibilityLabel={chatStrings.viewer[SHARE_FILE_VERB]}
            accessibilityRole="button"
            hitSlop={TAP_SLOP}
            onPress={() => void shareFile(uri, name)}
            testID={`${testID}-share`}
          >
            <Text color="onAccent" style={{ fontSize: 20, lineHeight: 26 }}>
              {SHARE_FILE_VERB === 'download' ? '⤓' : '⇧'}
            </Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  )
}
