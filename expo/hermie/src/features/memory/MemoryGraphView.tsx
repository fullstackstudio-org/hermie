/**
 * The memory graph, drawn.
 *
 * ## No WebView, and nothing to sandbox
 *
 * The same decision as the Mermaid renderer next door, for the same reasons
 * (ADR-0020): a graph library needs a DOM, a `WebView` only learns its content's
 * height after the page has laid out, and a picture that resizes after layout
 * moves the reader by exactly the correction. So the layout is computed in
 * `graph-layout.ts` and drawn with `react-native-svg`, which is already in the
 * bundle. A label here is characters in a `Text`; there is no script engine and
 * no navigation for a hostile memory entry to reach.
 *
 * ## Pan and zoom, with a keyboard-reachable way to do both
 *
 * `react-native-gesture-handler` is not a dependency of this app, so all of it
 * is one `PanResponder` — the same choice `BottomSheet` documents — which is
 * affordable because a pinch is two subtractions and a ratio. The arithmetic
 * lives in `graph-gestures.ts`, where it can be tested without hand-building
 * React Native's internal `touchHistory`.
 *
 * One finger pans; two pinch; the buttons and, in a browser, the wheel zoom as
 * well. The buttons are not a fallback for the pinch and the pinch is not the
 * real way in: a pinch is unavailable to anybody on a pointer, on a keyboard or
 * using a switch control, and a picture whose only way in is a two-finger
 * gesture is a picture some readers cannot use at all. Both exist because each
 * is somebody's only one.
 *
 * With one finger the responder claims the gesture only after a slop, so a tap
 * still reaches the node under it. With two it claims at once — there is no tap
 * to protect, and a slop would eat the beginning of every zoom.
 *
 * Going from two fingers back to one RE-ANCHORS the pan. `PanResponder` keeps
 * accumulating `dx` from the centroid across the whole gesture, so without that
 * the drawing would leap by however far the centroid moved while the pinch was
 * running.
 *
 * ## Reduce Motion
 *
 * The drawing settles in — a short scale-and-fade, so the graph arrives rather
 * than blinking into place. Under Reduce Motion there is no animation at all:
 * the final frame is the first frame. That is the accessibility preference's
 * own meaning, not a degraded version of the effect.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { Animated, PanResponder, Platform, View } from 'react-native'
import Svg, { Circle, G, Line, Text as SvgText } from 'react-native-svg'

import { Button } from '../../ui/primitives'
import { motion } from '../../ui/motion'
import { useTheme } from '../../ui/theme'
import { claimsGesture, clampScale, type PinchAnchor, pinchSpan, scaleFromPinch, ZOOM_STEP } from './graph-gestures'
import type { MemoryGraph, MemoryGraphNode } from './graph-model'
import { type GraphLayout, layoutMemoryGraph } from './graph-layout'
import { memoryStrings } from './strings'

export interface MemoryGraphViewProps {
  graph: MemoryGraph
  /** The node the detail card is open on, drawn with a ring. */
  selectedId?: string | null
  onSelect: (node: MemoryGraphNode | null) => void
  /** The square the drawing is laid out in; the view scales it to fit. */
  size?: number
  /**
   * Take the whole box rather than a square of the caller's width.
   *
   * The card on the page is square, because a square is what a column of
   * scrolling content can give a picture without guessing how tall the reader's
   * screen is. Full screen there is no such question: the box is the box, and
   * the `viewBox` letterboxes the square drawing inside whatever shape it is.
   */
  fill?: boolean
  testID?: string
}

/** A topic's label is drawn beside it; an entry's excerpt is not — see below. */
const TOPIC_LABEL_MAX = 18

export function MemoryGraphView({
  graph,
  selectedId,
  onSelect,
  size,
  fill = false,
  testID = 'memory-graph'
}: MemoryGraphViewProps) {
  const theme = useTheme()
  const layout: GraphLayout = useMemo(() => layoutMemoryGraph(graph, size ? { size } : {}), [graph, size])

  const [scale, setScale] = useState(1)
  const [offset, setOffset] = useState({ x: 0, y: 0 })
  const origin = useRef({ x: 0, y: 0 })
  /** Set while two fingers are down, cleared the moment they are not. */
  const pinch = useRef<PinchAnchor | null>(null)
  /** The `dx`/`dy` the pan is measured FROM, moved when a pinch ends. */
  const panBase = useRef({ dx: 0, dy: 0 })

  /* The settle. One value for the whole group, not one per node. */
  const settle = useRef(new Animated.Value(theme.reduceMotion ? 1 : 0)).current

  useEffect(() => {
    if (theme.reduceMotion) {
      settle.setValue(1)

      return
    }

    settle.setValue(0)
    Animated.timing(settle, {
      // `motion.panel`, not `durationFor('panel', theme.reduceMotion)`: the
      // guard above is this surface's Reduce Motion path, and a `durationFor`
      // here would read as though the guard were belt and braces rather than
      // the thing doing the work.
      duration: motion.panel,
      toValue: 1,
      useNativeDriver: true
    }).start()
  }, [graph, settle, theme.reduceMotion])

  const responder = useMemo(
    () =>
      PanResponder.create({
        // Never on the press itself: a tap has to reach the node under it.
        onStartShouldSetPanResponder: () => false,
        onMoveShouldSetPanResponder: (event, gesture) =>
          claimsGesture(event.nativeEvent.touches.length, gesture.dx, gesture.dy),
        onPanResponderGrant: () => {
          origin.current = offset
          panBase.current = { dx: 0, dy: 0 }
          pinch.current = null
        },
        onPanResponderMove: (event, gesture) => {
          const span = pinchSpan(event.nativeEvent.touches)

          if (span !== null) {
            // The first frame of a pinch only records where it started from —
            // the scale it is measured against is whatever the buttons, the
            // wheel or an earlier pinch left behind.
            pinch.current ??= { span, scale }
            setScale(scaleFromPinch(pinch.current, span))

            return
          }

          if (pinch.current) {
            pinch.current = null
            origin.current = offset
            panBase.current = { dx: gesture.dx, dy: gesture.dy }
          }

          setOffset({
            x: origin.current.x + gesture.dx - panBase.current.dx,
            y: origin.current.y + gesture.dy - panBase.current.dy
          })
        }
        /*
          Deliberately NO handler on a touch ending. `onPanResponderEnd` fires
          when ANY finger lifts, including the second one of a pinch — clearing
          the anchor there would take the re-anchor above out of the one path
          that needs it and the drawing would jump on every pinch that ends with
          one finger still down. `onPanResponderGrant` resets all three refs, so
          nothing survives into the next gesture anyway.
        */
      }),
    [offset, scale]
  )

  const zoomBy = (factor: number): void => setScale(current => clampScale(current * factor))

  /*
    A browser gets the wheel as well, because that is how a mouse zooms a map
    and a reader will try it before they find the buttons. `onWheel` is passed
    through to the DOM node by react-native-web; on a native platform the prop
    is simply not set.
  */
  const wheel =
    Platform.OS === 'web'
      ? {
          onWheel: (event: { deltaY: number; preventDefault?: () => void }) => {
            event.preventDefault?.()
            zoomBy(event.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP)
          }
        }
      : {}

  const ink: Record<MemoryGraphNode['type'], string> = {
    profile: theme.accent().bubble,
    topic: theme.colors.textMuted,
    entry: theme.colors.accentText
  }

  return (
    <View
      accessibilityLabel={memoryStrings.graph.label}
      style={
        fill ? { flex: 1, overflow: 'hidden', width: '100%' } : { aspectRatio: 1, overflow: 'hidden', width: '100%' }
      }
      testID={testID}
      {...responder.panHandlers}
      {...(wheel as object)}
    >
      <Animated.View
        style={{
          flex: 1,
          opacity: settle,
          transform: [{ scale: settle.interpolate({ inputRange: [0, 1], outputRange: [0.92, 1] }) }]
        }}
      >
        <Svg height="100%" viewBox={`0 0 ${layout.width} ${layout.height}`} width="100%">
          <G
            transform={`translate(${offset.x} ${offset.y}) translate(${layout.width / 2} ${layout.height / 2}) scale(${scale}) translate(${-layout.width / 2} ${-layout.height / 2})`}
          >
            {layout.edges.map((edge, position) => (
              <Line
                key={`${edge.from}-${edge.to}-${edge.type}-${position}`}
                stroke={edge.type === 'shares_topic' ? theme.colors.accentText : theme.hairline}
                strokeDasharray={edge.type === 'mentions' ? '3 3' : undefined}
                strokeOpacity={edge.type === 'in_profile' ? 0.5 : 0.8}
                strokeWidth={edge.type === 'shares_topic' ? 1.4 : 1}
                x1={edge.x1}
                x2={edge.x2}
                y1={edge.y1}
                y2={edge.y2}
              />
            ))}

            {layout.nodes.map(node => (
              <G key={node.id}>
                <Circle
                  cx={node.x}
                  cy={node.y}
                  fill={ink[node.type]}
                  onPress={() => onSelect(node.id === selectedId ? null : node)}
                  r={node.radius}
                  stroke={node.id === selectedId ? theme.colors.text : 'transparent'}
                  strokeWidth={node.id === selectedId ? 2.5 : 0}
                  testID={`${testID}-node-${node.id}`}
                />
                {/*
                  Only the hub and the topics are labelled. An entry's label is
                  an excerpt of up to 120 characters, and a hundred of those
                  drawn at once is a grey field rather than a graph — the text
                  is one tap away in the detail card, which is what the card is
                  for.
                */}
                {node.type === 'entry' ? null : (
                  <SvgText
                    fill={theme.colors.text}
                    fontSize={node.type === 'profile' ? 13 : 10}
                    textAnchor="middle"
                    x={node.x}
                    y={node.y + node.radius + 12}
                  >
                    {node.type === 'profile' ? node.label : node.label.slice(0, TOPIC_LABEL_MAX)}
                  </SvgText>
                )}
              </G>
            ))}
          </G>
        </Svg>
      </Animated.View>

      {/*
        Worded buttons rather than `+` and `−` marks. The app has no minus icon
        and `ui/Icon.tsx` is emphatic about why a typed glyph is not one: it is
        centred by its line box rather than by its ink. Words also read the same
        to a screen reader as they do on screen, which two symbols do not.
      */}
      <View style={{ bottom: theme.space.md, gap: theme.space.sm, position: 'absolute', right: theme.space.md }}>
        <Button
          onPress={() => zoomBy(ZOOM_STEP)}
          testID={`${testID}-zoom-in`}
          title={memoryStrings.graph.zoomIn}
          variant="secondary"
        />
        <Button
          onPress={() => zoomBy(1 / ZOOM_STEP)}
          testID={`${testID}-zoom-out`}
          title={memoryStrings.graph.zoomOut}
          variant="secondary"
        />
        <Button
          onPress={() => {
            setScale(1)
            setOffset({ x: 0, y: 0 })
          }}
          testID={`${testID}-reset`}
          title={memoryStrings.graph.reset}
          variant="secondary"
        />
      </View>
    </View>
  )
}
