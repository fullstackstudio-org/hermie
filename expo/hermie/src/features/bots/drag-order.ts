/**
 * Where a dragged row lands, as arithmetic — the half that is only geometry.
 *
 * A drag happens in the space of RENDERED ROWS and has to commit in the space of
 * the arrangement, and that translation is the only hard part of dragging a row.
 * It is now split in two, because folders made one half of it stop being
 * arithmetic at all:
 *
 *  - `features/bots/folder-rows.ts` knows what the rows ARE and what position
 *    each one stands for. With folders a position is a container and an index
 *    inside it, which is a question about the arrangement.
 *  - this file knows only about boxes on a screen: which gap the finger is over,
 *    which way the other rows move, and how far. It never asks what an anchor
 *    means, which is why it needs nothing from the store.
 *
 * Two ideas survive from the divider version:
 *
 *  - an **anchor** is a visible row that stands for a position;
 *  - a **slot** is the gap between two anchors, which is what a drop line draws.
 *
 * Pure, so it is tested rather than watched.
 */

/** One row's box, as the list measured it, in content coordinates. */
export interface RowBox {
  y: number
  height: number
}

/**
 * All this file needs of an anchor: something to look its box up by.
 *
 * Structural on purpose. `folder-rows.ts` hangs a drop target off the same
 * object, and keeping that out of the type here is what stops the geometry
 * knowing anything about folders.
 */
export interface AnchorKey {
  key: string
}

/**
 * Which slot the pointer is over: the index into `anchors` the line draws above.
 *
 * The comparison is against each row's MIDPOINT rather than its top edge, so the
 * line flips when the dragged row is more than halfway past its neighbour — which
 * is the point at which a reader would say the two have swapped.
 *
 * An unmeasured row is skipped rather than treated as zero-height: a row that has
 * not laid out yet is one FlatList has not rendered, and guessing its position
 * would put the line somewhere nothing is drawn.
 */
export function dropSlot(
  anchors: readonly AnchorKey[],
  boxes: Readonly<Record<string, RowBox>>,
  pointerY: number
): number {
  for (let index = 0; index < anchors.length; index += 1) {
    const anchor = anchors[index]
    const box = anchor ? boxes[anchor.key] : undefined

    if (!box) {
      continue
    }

    if (pointerY < box.y + box.height / 2) {
      return index
    }
  }

  return anchors.length
}

/**
 * How far a row that is NOT being dragged has to move out of the way.
 *
 * `-1` is one row's height up, `1` is one down, `0` is stay put. It is the whole
 * of "the other rows animate aside", and it is arithmetic rather than animation:
 * a row between where the lifted row came FROM and the gap it is over has to
 * close up behind it or open up in front of it, and everything outside that span
 * is untouched.
 *
 * `from` is the lifted row's own anchor index; `slot` is the gap the drop line
 * would sit at, which is an index BETWEEN anchors — so a slot equal to `from` or
 * to `from + 1` both mean "back where it started" and shift nothing.
 *
 * Pure, because the alternative is discovering at 60 frames a second that a row
 * moved the wrong way.
 */
export function rowShift(anchor: number, from: number, slot: number): -1 | 0 | 1 {
  if (anchor === from) {
    return 0
  }

  // Dragging DOWN: everything it has passed comes up one.
  if (slot > from + 1 && anchor > from && anchor < slot) {
    return -1
  }

  // Dragging UP: everything it has passed goes down one.
  if (slot <= from - 1 && anchor >= slot && anchor < from) {
    return 1
  }

  return 0
}

/**
 * How far every visible row has moved aside, in points, by anchor key.
 *
 * `rowShift` says which way a row goes; this says how far, and the two are separate
 * because the distance is not a row's own height — it is the LIFTED row's. What is
 * opening or closing is the hole that row came out of, so a divider closing up
 * behind a chat travels the chat's height and not its own. Shifting by each row's
 * own height would leave a gap of the wrong size under the finger, which is exactly
 * the gap a reader is aiming at.
 *
 * `slot === null` is the end of a gesture: every row goes home.
 */
export function neighbourOffsets(
  anchors: readonly AnchorKey[],
  boxes: Readonly<Record<string, RowBox>>,
  from: number,
  slot: number | null
): Record<string, number> {
  const height = boxes[anchors[from]?.key ?? '']?.height ?? 0
  const offsets: Record<string, number> = {}

  anchors.forEach((anchor, index) => {
    const offset = (slot === null ? 0 : rowShift(index, from, slot)) * height

    // `-1 * 0` is negative zero, which an animation cannot tell from zero and a
    // test can. Nothing here has a signed nothing to express.
    offsets[anchor.key] = offset === 0 ? 0 : offset
  })

  return offsets
}
