/**
 * Hold a card, lift it, drop it on a column.
 *
 * The same gesture the chat list has, and deliberately the same THREE things
 * that make it feel like the platform's own rather than like a view that
 * moves (`features/bots/use-row-drag.ts` argues each of them at length):
 *
 *  - the lift is animated, not applied — `lift` springs 0 → 1 on the grant and
 *    the scale and the shadow are interpolated off it;
 *  - the gesture is CLAIMED, never assumed — a long press arms it and the
 *    first move past a slop takes the responder off the `Pressable`, so an
 *    ordinary tap still opens the card and an ordinary drag still scrolls the
 *    board;
 *  - the drop settles — the card springs back under the finger's release and
 *    the move is sent when that animation finishes, so the board does not
 *    change under a card that is still in the air.
 *
 * All three collapse to zero under Reduce Motion through the same path: the
 * springs become `Animated.timing` at duration 0, so every completion callback
 * — including the one that sends the move — still runs exactly where it did.
 *
 * ## What it does NOT copy from the chat list
 *
 * The neighbour shift and the drop line, because a board has no order to show.
 * `card-drag.ts` says why: there is no rank on the wire, so there is no gap to
 * open and nothing true to draw between two cards. What replaces them is the
 * COLUMN highlight — the band under the finger lights up, and the three
 * columns the dispatcher owns read as non-targets from the moment the card
 * lifts rather than at the moment the reader aims at one.
 *
 * ## The geometry, and where it has to come from
 *
 * A column measures itself with an `onLayout`, which reports `x` relative to
 * the row that holds the columns. A finger reports `moveX` in the WINDOW. The
 * two are in different spaces and neither can be derived from the other —
 * `locationX` is relative to whichever descendant received the touch, not to
 * the responder — so the screen measures the row's left edge in window
 * coordinates (`onRowLeft`) and reports how far the board is scrolled
 * sideways (`onScroll`), and this file adds them back.
 *
 * A measurement is asked for again when a drag ARMS rather than cached from
 * the last layout: a sidebar shown, a window resized or an orientation change
 * all move that edge, and a stale reading is the difference between dropping
 * where the finger is and dropping a column away from it.
 *
 * ## A drop that goes nowhere is still a drop
 *
 * The card always springs home, whatever the resolution. It cannot fly into
 * the column it was dropped on, because where it lands there is not knowable:
 * the server sorts by priority and age and may re-route the status outright
 * (`KanbanController.move`). Flying to a place the card then is not would be a
 * lie told smoothly, so the card returns to the hand it came from and the
 * board redraws with the answer.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Animated, PanResponder, type PanResponderInstance } from 'react-native'

import { haptic } from '../../platform/haptics'
import { NATIVE_DRIVER, spring as springToken } from '../../ui/motion'
import {
  columnAt,
  columnDragState,
  isReportable,
  resolveDrop,
  type ColumnBox,
  type ColumnDragState,
  type ColumnTarget,
  type DropResolution
} from './card-drag'

/** Beyond this, a press has become a drag. Below it, a finger is merely resting. */
const MOVE_SLOP = 6

/** How close to an edge of the board starts it scrolling under the lifted card. */
const EDGE_BAND = 72

/** Points per tick, sixty times a second. Slow enough to aim, fast enough to arrive. */
const EDGE_STEP = 8

const EDGE_INTERVAL_MS = 16

/** How much bigger a lifted card is. Enough to read as "off the page", not enough to crop. */
export const CARD_LIFT_SCALE = 1.04

/** One animation, or none. See `use-row-drag.ts` for why this is not a `setValue`. */
function settle(
  value: Animated.Value | Animated.ValueXY,
  toValue: number | { x: number; y: number },
  reduceMotion: boolean
): Animated.CompositeAnimation {
  if (value instanceof Animated.ValueXY) {
    const to = toValue as { x: number; y: number }

    return reduceMotion
      ? Animated.timing(value, { duration: 0, toValue: to, useNativeDriver: NATIVE_DRIVER })
      : Animated.spring(value, { ...springToken.settle, toValue: to, useNativeDriver: NATIVE_DRIVER })
  }

  const to = toValue as number

  return reduceMotion
    ? Animated.timing(value, { duration: 0, toValue: to, useNativeDriver: NATIVE_DRIVER })
    : Animated.spring(value, { ...springToken.settle, toValue: to, useNativeDriver: NATIVE_DRIVER })
}

export interface CardDragOptions {
  /** Every column on the board, in the server's own order. */
  targets: readonly ColumnTarget[]
  /**
   * Whether this layout drags at all.
   *
   * False on a phone, where the columns are stacked and a card would have to
   * be carried past three screenfuls to reach the next one — and false is not
   * a degradation, because the move menu is on every card on every layout.
   */
  enabled: boolean
  /** Every duration collapses to zero. Read from the theme by the caller. */
  reduceMotion: boolean
  /** The drop, once the card has settled. `outside` and `origin` never reach here. */
  onDrop: (cardId: string, resolution: DropResolution) => void
  /** Take a fresh reading of the column row's left edge, reported via `onRowLeft`. */
  measureRow: () => void
  /** Scroll the board sideways by a delta while the finger sits near an edge. */
  onAutoScroll: (delta: number) => void
}

export interface CardDrag {
  /** The id of the card being dragged, or null. */
  draggingId: string | null
  /**
   * A card is held: armed by a long press, dragging, or both.
   *
   * What the board's scroll views read to switch themselves off. `draggingId`
   * is too late to be that signal — see the note on `holding` below.
   */
  holding: boolean
  /** Where the lifted card is, relative to where it sits in its column. */
  translate: Animated.ValueXY
  /** 0 resting, 1 fully lifted. Scale and shadow read off this. */
  lift: Animated.Value
  /** How this column should be drawn right now. */
  stateFor: (target: ColumnTarget) => ColumnDragState
  /** A column's measured band, in the column row's own coordinates. */
  measureColumn: (name: string, box: ColumnBox) => void
  /** Where the column row's left edge sits in window coordinates. */
  onRowLeft: (x: number) => void
  /** How far the board is scrolled sideways, and how wide its viewport is. */
  onScroll: (offset: number) => void
  onViewportWidth: (width: number) => void
  /** Arm the drag for this card. The card's `onLongPress`. */
  arm: (cardId: string, from: string) => void
  /** Disarm without dragging. The card's `onPressOut`. */
  disarm: () => void
  /** Pan handlers for a card wrapper: claims the gesture once armed. */
  cardHandlers: (cardId: string, from: string) => PanResponderInstance['panHandlers']
}

export function useCardDrag({
  enabled,
  measureRow,
  onAutoScroll,
  onDrop,
  reduceMotion,
  targets
}: CardDragOptions): CardDrag {
  const [draggingId, setDraggingId] = useState<string | null>(null)
  const [draggingFrom, setDraggingFrom] = useState<string | null>(null)
  const [over, setOver] = useState<string | null>(null)
  /*
    A card is held, which is EARLIER than a card being dragged.

    `onShouldBlockNativeResponder` is Android-only, so on iOS a
    `UIScrollView`'s own pan recognizer competes with this gesture for the same
    finger — and on a board it wins, because the board scrolls sideways and so
    does the drag. Measured on the iPad Pro 13-inch: a held card produced a
    board scrolled one column to the left and no lift at all.

    `BotsScreen` switches its list off with `scrollEnabled={draggingKey ===
    null}`, and that is enough for a list, where the drag is claimed before the
    native recognizer has decided. It is NOT enough here: by the time a drag is
    granted the scroll has already started. So the scrollers go off one step
    earlier, when the long press ARMS, and come back on when the finger lifts
    without having dragged.
  */
  const [holding, setHolding] = useState(false)

  const translate = useRef(new Animated.ValueXY({ x: 0, y: 0 })).current
  const lift = useRef(new Animated.Value(0)).current
  const boxes = useRef<Record<string, ColumnBox>>({})
  const responders = useRef<Record<string, PanResponderInstance>>({})

  // Everything a responder reads has to be a ref: it is built once per card and
  // would otherwise close over the first render's values for good.
  const armed = useRef<string | null>(null)
  const active = useRef<{ id: string; from: string } | null>(null)
  const landing = useRef<DropResolution>({ kind: 'outside' })
  const rowLeft = useRef(0)
  const scrollX = useRef(0)
  const scrollAtGrant = useRef(0)
  const viewport = useRef(0)
  const lastMove = useRef<{ dx: number; dy: number; moveX: number } | null>(null)
  const trackAgain = useRef<(moveX: number, dx: number, dy: number) => void>(() => undefined)
  const edgeTimer = useRef<ReturnType<typeof setInterval> | null>(null)

  const latest = useRef({ measureRow, onAutoScroll, onDrop, reduceMotion, targets })

  latest.current = { measureRow, onAutoScroll, onDrop, reduceMotion, targets }

  const stopEdgeScroll = useCallback(() => {
    if (edgeTimer.current) {
      clearInterval(edgeTimer.current)
      edgeTimer.current = null
    }
  }, [])

  useEffect(() => stopEdgeScroll, [stopEdgeScroll])

  /** The finger, in the column row's coordinates. */
  const pointerRowX = (moveX: number): number => moveX - rowLeft.current + scrollX.current

  const finish = useCallback(
    (commit: boolean) => {
      const card = active.current
      const resolution = landing.current
      const { onDrop: drop, reduceMotion: reduce } = latest.current

      stopEdgeScroll()
      active.current = null
      armed.current = null
      landing.current = { kind: 'outside' }
      lastMove.current = null
      setHolding(false)

      const done = () => {
        translate.setValue({ x: 0, y: 0 })
        setDraggingId(null)
        setDraggingFrom(null)
        setOver(null)

        // `outside` and `origin` are silence on purpose: a reader who picks a
        // card up and puts it back has not asked for anything.
        if (commit && card && isReportable(resolution)) {
          drop(card.id, resolution)
        }
      }

      Animated.parallel([settle(translate, { x: 0, y: 0 }, reduce), settle(lift, 0, reduce)]).start(done)
    },
    [lift, stopEdgeScroll, translate]
  )

  const track = useCallback(
    (moveX: number, dx: number, dy: number) => {
      lastMove.current = { dx, dy, moveX }

      // The board may have scrolled under a still finger, and a lifted card
      // that slides out from under the finger holding it is the one thing a
      // drag may never do.
      translate.setValue({ x: dx + scrollX.current - scrollAtGrant.current, y: dy })

      const card = active.current

      if (!card) {
        return
      }

      const resolution = resolveDrop(latest.current.targets, boxes.current, pointerRowX(moveX), card.from)

      landing.current = resolution

      const next = columnAt(latest.current.targets, boxes.current, pointerRowX(moveX))?.name ?? null

      if (next !== over) {
        setOver(next)

        // The board has answered where this would land. Not for the card's own
        // column, which is where it started and is not news.
        if (next && next !== card.from) {
          haptic('choice')
        }
      }

      // The edge bands are measured against the board's viewport, not the
      // window, so a sidebar inset does not shift them.
      const withinLeft = moveX - rowLeft.current < EDGE_BAND
      const withinRight = rowLeft.current + viewport.current - moveX < EDGE_BAND

      if (!withinLeft && !withinRight) {
        stopEdgeScroll()

        return
      }

      if (edgeTimer.current) {
        return
      }

      const step = withinLeft ? -EDGE_STEP : EDGE_STEP

      // A finger that has stopped at the edge still means "keep going", so each
      // tick re-decides with the same move it decided with last time.
      edgeTimer.current = setInterval(() => {
        latest.current.onAutoScroll(step)

        const last = lastMove.current

        if (last) {
          trackAgain.current(last.moveX, last.dx, last.dy)
        }
      }, EDGE_INTERVAL_MS)
    },
    [over, stopEdgeScroll, translate]
  )

  trackAgain.current = track

  const cardHandlers = useCallback(
    (cardId: string, from: string) => {
      const existing = responders.current[cardId]

      if (existing) {
        return existing.panHandlers
      }

      const responder = PanResponder.create({
        onStartShouldSetPanResponder: () => false,
        onMoveShouldSetPanResponder: () => armed.current === cardId,
        // Either axis past the slop: a board is dragged sideways far more often
        // than up, and requiring `dy` would make the common gesture the one
        // that does not claim.
        onMoveShouldSetPanResponderCapture: (_event, gesture) =>
          armed.current === cardId && (Math.abs(gesture.dx) > MOVE_SLOP || Math.abs(gesture.dy) > MOVE_SLOP),

        onPanResponderGrant: () => {
          active.current = { from, id: cardId }
          landing.current = { kind: 'origin', column: from }
          scrollAtGrant.current = scrollX.current
          lastMove.current = null
          translate.setValue({ x: 0, y: 0 })
          setDraggingId(cardId)
          setDraggingFrom(from)
          settle(lift, 1, latest.current.reduceMotion).start()
        },

        onPanResponderMove: (_event, gesture) => {
          if (active.current?.id !== cardId) {
            return
          }

          track(gesture.moveX, gesture.dx, gesture.dy)
        },

        // While dragging, nothing else may take the gesture — least of all the
        // board's own scroll view, which would leave a lifted card following
        // nothing.
        onPanResponderTerminationRequest: () => active.current?.id !== cardId,
        onShouldBlockNativeResponder: () => active.current?.id === cardId,

        onPanResponderRelease: () => finish(true),
        onPanResponderTerminate: () => finish(false)
      })

      responders.current[cardId] = responder

      return responder.panHandlers
    },
    [finish, lift, track, translate]
  )

  const arm = useCallback(
    (cardId: string, _from: string) => {
      if (!enabled) {
        return
      }

      armed.current = cardId
      setHolding(true)
      // Where the board is can have changed since the last layout, and the
      // answer is needed before the first move rather than after it.
      latest.current.measureRow()
      haptic('choice')
    },
    [enabled]
  )

  const disarm = useCallback(() => {
    if (!active.current) {
      armed.current = null
      setHolding(false)
    }
  }, [])

  const stateFor = useCallback(
    (target: ColumnTarget): ColumnDragState =>
      columnDragState(target, draggingFrom === null ? null : { from: draggingFrom }, over),
    [draggingFrom, over]
  )

  const measureColumn = useCallback((name: string, box: ColumnBox) => {
    boxes.current[name] = { width: box.width, x: box.x }
  }, [])

  return useMemo(
    () => ({
      arm,
      cardHandlers,
      disarm,
      draggingId,
      holding,
      lift,
      measureColumn,
      onRowLeft: (x: number) => {
        rowLeft.current = x
      },
      onScroll: (offset: number) => {
        scrollX.current = offset
      },
      onViewportWidth: (width: number) => {
        viewport.current = width
      },
      stateFor,
      translate
    }),
    [arm, cardHandlers, disarm, draggingId, holding, lift, measureColumn, stateFor, translate]
  )
}
