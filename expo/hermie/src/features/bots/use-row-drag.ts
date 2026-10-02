/**
 * Hold a chat row, drag it, drop it somewhere else.
 *
 * ## Why PanResponder and not a gesture library
 *
 * ADR-0010 keeps gesture libraries out of the chat surface. The list is not the chat
 * surface, so that decision does not forbid one here — but it does not pay for one
 * either. `react-native-gesture-handler` plus `reanimated` is two native
 * dependencies, a Babel plugin and a worklet runtime for one gesture on one screen,
 * and PanResponder is in React Native already. `Animated` with `useNativeDriver`
 * moves the lifted row off the JavaScript thread, which is the only part of this
 * that has to be smooth.
 *
 * ## The gesture: long press, THEN move
 *
 * A plain drag must keep doing what it did — scroll on a phone, nothing on a Mac
 * (`useDirectTouchPanOnly`) — so the drag has to be claimed rather than assumed.
 * The row's own `onLongPress` arms it and the first MOVE past a slop claims the
 * responder from the `Pressable`, which cancels the press so the chat does not also
 * open.
 *
 * That ordering is also what makes it coexist with the native context menu, which
 * is the other thing a long press does. `UIContextMenuInteraction` cancels itself
 * when the touch moves, and it has a longer delay than this does, so holding still
 * gets the menu and holding then moving gets the drag — the same split as the Files
 * app. Nothing arbitrates that explicitly; the two gestures are simply distinct.
 *
 * Arming is unconditional, on every platform, and that is the round's change. It
 * used to be gated on there being a NATIVE menu, on the argument that a long
 * press elsewhere already belonged to the fallback sheet — which left the phone's
 * own gesture inert: holding a row did nothing until the list had been put into
 * an edit mode first. Where there is no native menu the caller now DEFERS its
 * sheet instead, and `onDragStart` is what tells it the hold became a drag. So
 * the split is the same everywhere: hold still for the menu, hold and move for
 * the drag.
 *
 * ## It drags a ROW, not a bot
 *
 * This hook was keyed by bot name from end to end: `arm('finance-bot')`,
 * `rowHandlers('finance-bot')`, `onCommit(name, target)`, and a lifted key built
 * back up as `` `bot:${name}` `` in two places. `folder-rows.ts` has always
 * described the list in row KEYS — `bot:<name>` and `folder:<id>` — so the one
 * thing the hook could never drag was the one kind of row whose key it did not
 * speak.
 *
 * It now takes and reports keys and nothing else. It does not know what a bot
 * is, it does not know what a folder is, and `onCommit` hands the key back to
 * the caller to make sense of — which is what makes a folder draggable without
 * a second copy of the lift, the neighbour shift and the settle.
 *
 * ## What the caller has to provide
 *
 * The geometry, and it has to come off the right view.
 *
 * This hook knows how far the finger has moved; `drag-order.ts` knows what that
 * means, and it needs every row's box in the LIST's own coordinates. A `FlatList`
 * wraps each item in a cell of its own, so an `onLayout` on the row INSIDE that cell
 * reports `y = 0` for every row in the list — and drop arithmetic fed nothing but
 * zeroes can only ever answer "above the first row" or "past the last one". That was
 * the whole of the defect: the neighbours never opened a gap because the finger was
 * never measured to be over one. The measurement belongs on the CELL, which is a
 * direct child of the content container, and `DragCell` is that cell.
 *
 * The other half of the geometry is where the list starts ON SCREEN, which a floating
 * header or a sidebar inset moves. It is not derivable from a touch — `locationY` is
 * relative to whichever descendant received it, not to the responder — so the caller
 * measures the scroll view in window coordinates and reports it through `onListTop`,
 * and the hook asks for a fresh reading (`measureList`) when a drag arms.
 *
 * A measurement is a ref rather than state, because it is not something the list
 * should re-render for.
 *
 * ## What makes it feel like the platform's own, rather than a row that moves
 *
 * Three things, and none of them is the translation:
 *
 *  - **The lift is animated, not applied.** `lift` springs 0 → 1 on the grant and
 *    back on release, and the scale and the shadow are interpolated off it. A row
 *    that snaps to 1.02 has not been picked up, it has changed size.
 *  - **The other rows move aside** (`offsetFor`), which is what a native list does
 *    instead of drawing a line: the gap under the finger IS the answer to "where
 *    would this land". `rowShift` decides, and only the rows between the lifted
 *    row's own place and that gap ever move.
 *  - **The drop settles.** The lifted row springs from wherever the finger left it
 *    to the middle of the gap it is over, and the commit happens when that
 *    animation finishes — so the arrangement changes under a row that is already
 *    where the new arrangement puts it, and nothing jumps.
 *
 * All three collapse to zero under Reduce Motion, through the same code path: the
 * springs become `Animated.timing` at duration 0, so every completion callback —
 * including the one that commits the drop — still runs exactly where it did.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Animated, PanResponder, type PanResponderInstance } from 'react-native'

import { haptic } from '../../platform/haptics'
import { NATIVE_DRIVER, spring as springToken } from '../../ui/motion'
import { dropSlot, neighbourOffsets, rowShift, type RowBox } from './drag-order'
import { anchorBoxes, type DragAnchor, type DropTarget } from './folder-rows'

/** Beyond this, a press has become a drag. Below it, a finger is merely resting. */
const MOVE_SLOP = 6

/** How close to an edge starts the list scrolling under the dragged row. */
const EDGE_BAND = 72

/** Points per tick, sixty times a second. Slow enough to aim, fast enough to arrive. */
const EDGE_STEP = 6

const EDGE_INTERVAL_MS = 16

/** How much bigger a lifted row is. Enough to read as "off the page", not enough to crop. */
export const LIFT_SCALE = 1.03

/**
 * One animation, or none.
 *
 * Reduce Motion gets a zero-length `timing` rather than a `setValue`, for the
 * reason `motion.ts` gives about `durationFor`: a skipped animation is a skipped
 * completion callback, and one of the callbacks here is what commits the drop.
 */
function settle(value: Animated.Value, toValue: number, reduceMotion: boolean): Animated.CompositeAnimation {
  return reduceMotion
    ? Animated.timing(value, { duration: 0, toValue, useNativeDriver: NATIVE_DRIVER })
    : Animated.spring(value, { ...springToken.settle, toValue, useNativeDriver: NATIVE_DRIVER })
}

export interface RowDragOptions {
  anchors: readonly DragAnchor[]
  /**
   * Where a drop past the last row goes.
   *
   * The end of the TOP LEVEL, never the end of whichever folder happened to be
   * last: dragging a row to the bottom of the list means "out of everything",
   * which is the only reading that gives a reader a way to take a chat out of
   * the last folder by dragging.
   */
  fallbackTarget: DropTarget
  /**
   * Commit: put the row with this KEY at this position, in this container.
   *
   * The key is `bot:<name>` or `folder:<id>`. What that means to the
   * arrangement is the caller's business — a folder may only land at the top
   * level, and this hook has no opinion about that.
   */
  onCommit: (rowKey: string, target: DropTarget) => void
  /**
   * Take a fresh reading of the list's top edge on screen, reported back through
   * `onListTop`. Called when a drag arms, which is one long press before the first
   * move — early enough for an asynchronous measurement to land in time.
   */
  measureList: () => void
  /** Scroll the list by a delta while the finger sits near an edge. */
  onAutoScroll: (delta: number) => void
  /**
   * Narrow a drop slot before it becomes a drop line.
   *
   * Absent is "anywhere is fine", which is what the list did before pinning.
   * `BotsScreen` passes `clampToPinnedBand`, and it is applied HERE rather than
   * at the commit so that the line the reader watches and the arrangement they
   * get are the same answer — a clamp on the commit alone would draw a drop
   * line somewhere the row then refused to go.
   */
  clampSlot?: (rowKey: string, slot: number) => number
  /**
   * The hold became a drag.
   *
   * Reported on the grant — the first move past the slop — rather than on the
   * arm, because the two are different answers and only this one is final: an
   * armed row that never moves is a row whose long press still means "open the
   * menu". The caller uses it to drop the menu it was holding for this press.
   */
  onDragStart?: (rowKey: string) => void
  /** Every duration collapses to zero. Read from the theme by the caller. */
  reduceMotion: boolean
}

export interface RowDrag {
  /** The KEY of the row being dragged, or null. */
  draggingKey: string | null
  /** Translation for the lifted row. Stable, and driven natively. */
  translateY: Animated.Value
  /**
   * 0 resting, 1 fully lifted. The scale and the shadow read off this, so a row
   * that is being put down is drawn mid-way rather than either/or.
   */
  lift: Animated.Value
  /** How far this row has moved aside, by anchor key. Zero for a row that has not. */
  offsetFor: (key: string) => Animated.Value
  /** The anchor key a drop line should be drawn above, or null. */
  dropKey: string | null
  /**
   * The anchor key of the lifted row, or null.
   *
   * The cell that carries it is the one that has to be drawn above its neighbours,
   * and a cell is the only view that can be: `zIndex` orders siblings, and a row is
   * not a sibling of the other rows — its cell is.
   *
   * The same value as `draggingKey`. It keeps its own name because `DragCell`
   * reads it and a cell has no idea anything is being dragged — it knows only
   * that one of its siblings has to be on top.
   */
  liftedKey: string | null
  /** A cell's measured box, in the list's CONTENT coordinates. See `DragCell`. */
  measure: (key: string, layout: RowBox) => void
  /** Arm the drag for this row key. The row's `onLongPress`. */
  arm: (rowKey: string) => void
  /** Disarm without dragging. The row's `onPressOut`. */
  disarm: () => void
  /** Pan handlers for a row wrapper: claims the gesture once armed. */
  rowHandlers: (rowKey: string) => PanResponderInstance['panHandlers']
  /** Where the list is scrolled and how tall it is, for the edge bands. */
  onListLayout: (height: number) => void
  onListScroll: (offset: number) => void
  /** Where the list's own top edge sits in window coordinates. */
  onListTop: (y: number) => void
}

export function useRowDrag({
  anchors,
  clampSlot,
  fallbackTarget,
  measureList,
  onAutoScroll,
  onCommit,
  onDragStart,
  reduceMotion
}: RowDragOptions): RowDrag {
  const [draggingKey, setDraggingKey] = useState<string | null>(null)
  const [dropKey, setDropKey] = useState<string | null>(null)

  const translateY = useRef(new Animated.Value(0)).current
  const lift = useRef(new Animated.Value(0)).current
  const offsets = useRef<Record<string, Animated.Value>>({})
  const boxes = useRef<Record<string, RowBox>>({})
  const rowResponders = useRef<Record<string, PanResponderInstance>>({})

  // Everything the responders read has to be a ref: a PanResponder is built once
  // per row and would otherwise close over the first render's values for good.
  const armed = useRef<string | null>(null)
  const active = useRef<string | null>(null)
  const slot = useRef<number | null>(null)
  /** The lifted row's own anchor index, captured at the grant. */
  const origin = useRef(0)
  const listHeight = useRef(0)
  const listOffset = useRef(0)
  /** The list's top edge in window coordinates; see `onListTop`. */
  const listTop = useRef(0)
  /** Where the list was scrolled at the grant, so an edge scroll can be undone. */
  const scrollAtGrant = useRef(0)
  /** The last move, so an edge tick can re-decide without waiting for a finger. */
  const lastMove = useRef<{ dy: number; moveY: number } | null>(null)
  /** `track`, for the edge timer that `track` itself arms. Assigned below. */
  const trackAgain = useRef<(moveY: number, dy: number) => void>(() => undefined)
  const edgeTimer = useRef<ReturnType<typeof setInterval> | null>(null)

  const latest = useRef({
    anchors,
    clampSlot,
    fallbackTarget,
    measureList,
    onAutoScroll,
    onCommit,
    onDragStart,
    reduceMotion
  })

  latest.current = {
    anchors,
    clampSlot,
    fallbackTarget,
    measureList,
    onAutoScroll,
    onCommit,
    onDragStart,
    reduceMotion
  }

  /**
   * One value per anchor, created on demand and kept for the life of the screen.
   *
   * Kept rather than cleaned up: a chat list is tens of rows, an `Animated.Value`
   * is two numbers, and a map that is pruned while a drag is in flight is a map
   * that can drop the value a running animation is writing to.
   */
  const offsetFor = useCallback((key: string): Animated.Value => {
    const existing = offsets.current[key]

    if (existing) {
      return existing
    }

    const value = new Animated.Value(0)

    offsets.current[key] = value

    return value
  }, [])

  /**
   * Move every row that has to be out of the way, and put back every row that
   * does not.
   *
   * A row's height is its OWN, not an assumed constant: a divider is shorter than
   * a chat row and a compact row is shorter than a regular one, so shifting by a
   * fixed number would leave a gap the wrong size under the finger. The height
   * that opens or closes is the LIFTED row's, because that is what is going into
   * or out of the gap.
   */
  const shiftRows = useCallback(
    (from: number, slot: number | null) => {
      const { anchors: list, reduceMotion: reduce } = latest.current

      for (const [key, offset] of Object.entries(neighbourOffsets(list, boxes.current, from, slot))) {
        settle(offsetFor(key), offset, reduce).start()
      }
    },
    [offsetFor]
  )

  const stopEdgeScroll = useCallback(() => {
    if (edgeTimer.current) {
      clearInterval(edgeTimer.current)
      edgeTimer.current = null
    }
  }, [])

  useEffect(() => stopEdgeScroll, [stopEdgeScroll])

  /**
   * Where the finger is, in the CONTENT's coordinates.
   *
   * `moveY` is in the window and the cells were measured in the content, so both
   * the list's top edge and how far it is scrolled come off it. The top edge is a
   * measurement rather than an assumption precisely because it is not zero: on the
   * iPad the list sits under a floating header and beside a rail, and on a Mac
   * there is a title bar above all of it.
   */
  const pointerContentY = (moveY: number): number => moveY - listTop.current + listOffset.current

  /**
   * Let go.
   *
   * The row does not disappear from under the finger and reappear in its new
   * place: it SPRINGS to the resting offset the gap has already opened for it,
   * and the arrangement changes on that animation's completion. By then the row
   * is drawn exactly where the new arrangement puts it, so the re-render that
   * follows moves nothing — which is the difference between a drop and a jump.
   *
   * `resting` is how far the lifted row has to travel from its ORIGINAL place to
   * the gap, which is one row height per row it passed. It is computed from the
   * same `rowShift` the other rows used, so the two cannot disagree about where
   * the gap is.
   */
  const finish = useCallback(
    (commit: boolean) => {
      const key = active.current
      const target = slot.current
      const from = origin.current
      const { anchors: list, fallbackTarget: fallback, onCommit: commitTo, reduceMotion: reduce } = latest.current

      stopEdgeScroll()
      active.current = null
      armed.current = null
      slot.current = null
      origin.current = 0
      lastMove.current = null

      const done = () => {
        translateY.setValue(0)
        for (const value of Object.values(offsets.current)) {
          value.setValue(0)
        }
        setDraggingKey(null)
        setDropKey(null)

        if (commit && key && target !== null) {
          commitTo(key, list[target]?.target ?? fallback)
        }
      }

      if (!commit || !key || target === null) {
        Animated.parallel([settle(translateY, 0, reduce), settle(lift, 0, reduce)]).start(done)
        shiftRows(from, null)

        return
      }

      const height = boxes.current[list[from]?.key ?? '']?.height ?? 0
      const passed = list.reduce((total, _anchor, index) => total - rowShift(index, from, target), 0)

      Animated.parallel([settle(translateY, passed * height, reduce), settle(lift, 0, reduce)]).start(done)
    },
    [lift, shiftRows, stopEdgeScroll, translateY]
  )

  const begin = useCallback(
    (rowKey: string) => {
      active.current = rowKey
      // The row's own anchor, found by the key it was handed. It used to be
      // rebuilt as `bot:<name>` here, which is the line that made a folder row
      // undraggable: its key is `folder:<id>` and the lookup could only ever
      // miss, so the lift began at anchor 0 and every neighbour moved the wrong
      // way.
      origin.current = Math.max(
        0,
        latest.current.anchors.findIndex(anchor => anchor.key === rowKey)
      )
      scrollAtGrant.current = listOffset.current
      lastMove.current = null
      translateY.setValue(0)
      setDraggingKey(rowKey)
      // Before the lift animates rather than after it: what the caller does with
      // this is take a menu off the screen, and a menu dismissed a spring later
      // has covered the row for the whole of the lift.
      latest.current.onDragStart?.(rowKey)
      settle(lift, 1, latest.current.reduceMotion).start()
    },
    [lift, translateY]
  )

  /**
   * One move, and the two things it decides: where the row is drawn and where it
   * would land. The drop line is React state because it changes a few times per
   * drag; the translation is not, because it changes every frame.
   */
  const track = useCallback(
    (moveY: number, dy: number) => {
      lastMove.current = { dy, moveY }

      // The translation is in the CONTENT's space and the finger is not, so an
      // auto-scroll that moves the content under a still finger has to be added
      // back — otherwise the lifted row slides out from under the finger that is
      // holding it, which is the one thing a drag may never do.
      translateY.setValue(dy + listOffset.current - scrollAtGrant.current)

      // `anchorBoxes` adds the synthetic half-rows: a folder's own header
      // carries a second anchor over its bottom half, which is what makes
      // "drop onto the folder" a gesture rather than a wish.
      // The clamp sits between the geometry and the drop line, which is the one
      // place it can be applied without the two disagreeing: what the reader
      // watches IS what the commit uses.
      const raw = dropSlot(
        latest.current.anchors,
        anchorBoxes(latest.current.anchors, boxes.current),
        pointerContentY(moveY)
      )
      const next = active.current ? (latest.current.clampSlot?.(active.current, raw) ?? raw) : raw

      if (next !== slot.current) {
        const first = slot.current === null

        slot.current = next
        setDropKey(latest.current.anchors[next]?.key ?? null)
        shiftRows(origin.current, next)

        // The list has changed shape under the finger, which is what says the drop
        // would land here. Not on the FIRST slot of a gesture: that one is the row's
        // own place, nothing moves for it, and the lift's tap has just fired.
        if (!first) {
          haptic('choice')
        }
      }

      // The edge bands are measured against the list, not the window, so a sidebar
      // inset does not shift them.
      const withinTop = moveY - listTop.current < EDGE_BAND
      const withinBottom = listTop.current + listHeight.current - moveY < EDGE_BAND

      if (!withinTop && !withinBottom) {
        stopEdgeScroll()

        return
      }

      if (edgeTimer.current) {
        return
      }

      const step = withinTop ? -EDGE_STEP : EDGE_STEP

      // A finger that has stopped at the edge still means "keep going", so each tick
      // re-decides with the same move it decided with last time. The list has
      // scrolled since, so both the translation and the slot change even though
      // nothing moved.
      edgeTimer.current = setInterval(() => {
        latest.current.onAutoScroll(step)

        const last = lastMove.current

        if (last) {
          trackAgain.current(last.moveY, last.dy)
        }
      }, EDGE_INTERVAL_MS)
    },
    [shiftRows, stopEdgeScroll, translateY]
  )

  // `track` arms the edge timer, so the timer cannot close over `track` itself.
  trackAgain.current = track

  const buildResponder = useCallback(
    (rowKey: string): PanResponderInstance => {
      return PanResponder.create({
        // A row waits to be armed, so an ordinary tap still reaches the
        // `Pressable` underneath it and an unarmed drag still scrolls the list.
        onStartShouldSetPanResponder: () => false,
        onStartShouldSetPanResponderCapture: () => false,
        onMoveShouldSetPanResponder: () => armed.current === rowKey,
        onMoveShouldSetPanResponderCapture: (_event, gesture) =>
          armed.current === rowKey && Math.abs(gesture.dy) > MOVE_SLOP,

        onPanResponderGrant: () => begin(rowKey),

        onPanResponderMove: (_event, gesture) => {
          if (active.current !== rowKey) {
            return
          }

          track(gesture.moveY, gesture.dy)
        },

        // While dragging, nothing else may take the gesture — least of all the
        // scroll view, which would leave a lifted row following nothing.
        onPanResponderTerminationRequest: () => active.current !== rowKey,
        onShouldBlockNativeResponder: () => active.current === rowKey,

        onPanResponderRelease: () => finish(true),
        onPanResponderTerminate: () => finish(false)
      })
    },
    [begin, finish, track]
  )

  const rowHandlers = useCallback(
    (rowKey: string) => {
      const existing = rowResponders.current[rowKey]

      if (existing) {
        return existing.panHandlers
      }

      const responder = buildResponder(rowKey)

      rowResponders.current[rowKey] = responder

      return responder.panHandlers
    },
    [buildResponder]
  )

  const measure = useCallback((key: string, layout: RowBox) => {
    boxes.current[key] = { height: layout.height, y: layout.y }
  }, [])

  const arm = useCallback((rowKey: string) => {
    armed.current = rowKey
    // Where the list is can have changed since the last layout — a sidebar shown,
    // a keyboard up, a window resized — and the answer is needed before the first
    // move rather than after it.
    latest.current.measureList()
    // The haptic the gesture needs, at the moment the row becomes movable: a lift
    // that says nothing is a lift nobody trusts they have started. It is the tap
    // the Home Screen gives when an icon starts to wobble, and it belongs to the
    // HOLD rather than to the first move for the same reason — the hold is when
    // the reader has to be told they may now move.
    haptic('choice')
  }, [])

  const disarm = useCallback(() => {
    if (!active.current) {
      armed.current = null
    }
  }, [])

  return useMemo(
    () => ({
      arm,
      disarm,
      draggingKey,
      dropKey,
      lift,
      liftedKey: draggingKey,
      measure,
      offsetFor,
      onListLayout: (height: number) => {
        listHeight.current = height
      },
      onListScroll: (offset: number) => {
        listOffset.current = offset
      },
      onListTop: (y: number) => {
        listTop.current = y
      },
      rowHandlers,
      translateY
    }),
    [arm, disarm, draggingKey, dropKey, lift, measure, offsetFor, rowHandlers, translateY]
  )
}
