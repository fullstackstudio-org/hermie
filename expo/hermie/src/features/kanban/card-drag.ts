/**
 * Where a dragged card would land, and whether the board would take it.
 *
 * All of the arithmetic, none of the animation. The hook next door owns the
 * lift and the settle; this file answers the one question a drop has —
 * *which column is under the finger, and may a card go there* — so that the
 * answer can be tested without a renderer, and so that the highlight the
 * reader watches and the call the screen makes are computed by the same
 * function rather than by two that agree today.
 *
 * ## A drop is a COLUMN and nothing else
 *
 * This is not `features/bots/drag-order.ts` with the axes swapped, and the
 * difference is not geometry. That file resolves a SLOT, because a chat list
 * has an order and the gap under the finger is the answer. A board has no
 * order: `kanban-controller.ts` says it plainly — there is no `position`, no
 * `index` and no rank on the wire, and the server sorts by priority and age.
 * So there is no slot to compute, no neighbour to shift out of the way, and no
 * drop line to draw between two cards. A card is over a column or it is not.
 *
 * That is also why the resolution is decided by **x alone**. A column is a
 * full-height band, and requiring the finger to be inside the cards as well
 * would make a card dragged to a column that is nearly empty — or dragged
 * below a long column's last card — fail for a reason nothing on screen
 * explains. Every pixel of a column's width is that column, from the header to
 * the bottom of the board.
 *
 * ## Three ways a drop does not move a card, and they are not one
 *
 * A caller that collapsed these would either fire a request it knows will 400
 * or say nothing at all when a reader aims at a column the dispatcher owns:
 *
 *  - `outside` — no column under the finger. Nothing happened; say nothing.
 *  - `origin` — the card's own column. Nothing happened; say nothing. A
 *    reader who picks a card up and puts it back has not made a mistake.
 *  - `refused` — a real column the server will not take (`LOCKED_COLUMNS`).
 *    Something happened and the answer is no, so the board says why. This is
 *    refused HERE rather than by the gateway: `_apply_status` raises on
 *    `running` before it looks at anything else, and a 400 the client could
 *    have predicted is a round trip spent to tell the reader what the column
 *    already knew.
 */
import { canDropInto } from './kanban-controller'

/**
 * One column's horizontal band, in the coordinates of the row that holds the
 * columns — not the window's, and not the scroll view's.
 *
 * Measured with an `onLayout` on the column itself, which is a direct child of
 * that row, so `x` is already relative to it. The screen converts the finger's
 * window x into the same space; see `use-card-drag.ts`.
 */
export interface ColumnBox {
  x: number
  width: number
}

/** A column, reduced to the two things a drop cares about. */
export interface ColumnTarget {
  name: string
  /** As the controller computed it, so the menu and the drag cannot disagree. */
  droppable: boolean
}

export type DropResolution =
  | { kind: 'outside' }
  | { kind: 'origin'; column: string }
  | { kind: 'refused'; column: string }
  | { kind: 'move'; column: string }

/**
 * Is this worth telling anybody about?
 *
 * The rule behind "nothing happened; say nothing", in one place rather than
 * as a condition spelled at the two sites that need it. A drop outside the
 * board and a drop back where the card started are both silence: no request,
 * no notice, no flash of a sentence a reader did not ask for. The other two
 * both produce one — a move, or the reason it was refused.
 */
export function isReportable(
  resolution: DropResolution
): resolution is Extract<DropResolution, { kind: 'move' | 'refused' }> {
  return resolution.kind === 'move' || resolution.kind === 'refused'
}

/**
 * How a column should be DRAWN while a drag is in flight.
 *
 * `idle` is also what every column is when nothing is being dragged, so one
 * value covers both states and no caller has to branch on "is there a drag".
 */
export type ColumnDragState = 'idle' | 'target' | 'refused' | 'origin'

/** The column whose band contains this x, or null past both ends. */
export function columnAt(
  targets: readonly ColumnTarget[],
  boxes: Readonly<Record<string, ColumnBox>>,
  x: number
): ColumnTarget | null {
  for (const target of targets) {
    const box = boxes[target.name]

    // A column nothing has measured yet is not a place a card can be dropped.
    // It is missing rather than empty, and guessing a band for it would put a
    // card in whichever column happened to render first.
    if (!box || box.width <= 0) {
      continue
    }

    if (x >= box.x && x < box.x + box.width) {
      return target
    }
  }

  return null
}

/**
 * What letting go here would do.
 *
 * `from` is the card's current column, which is the only state this needs: a
 * card that never leaves its own column is not a move, however far the finger
 * travelled inside it.
 */
export function resolveDrop(
  targets: readonly ColumnTarget[],
  boxes: Readonly<Record<string, ColumnBox>>,
  x: number,
  from: string
): DropResolution {
  const over = columnAt(targets, boxes, x)

  if (!over) {
    return { kind: 'outside' }
  }

  if (over.name === from) {
    return { kind: 'origin', column: over.name }
  }

  // `droppable` is the controller's own answer and `canDropInto` is the rule
  // behind it. Both are consulted: a column the server grows later arrives
  // with `droppable` computed, and a caller that builds targets by hand — a
  // test, the gallery — should not be able to offer `running` by forgetting a
  // field.
  if (!over.droppable || !canDropInto(over.name)) {
    return { kind: 'refused', column: over.name }
  }

  return { kind: 'move', column: over.name }
}

/**
 * How to draw one column, given what is being dragged over the board.
 *
 * Split out from `resolveDrop` because it answers for EVERY column at once and
 * the resolution answers for the one under the finger: a locked column has to
 * read as a non-target from the moment the card lifts, not only once the
 * reader has already aimed at it. That is the whole of "shown as non-targets"
 * — the board says no before the reader tries, the way the move menu does by
 * not listing them.
 */
export function columnDragState(
  target: ColumnTarget,
  dragging: { from: string } | null,
  over: string | null
): ColumnDragState {
  if (!dragging) {
    return 'idle'
  }

  if (target.name === dragging.from) {
    return 'origin'
  }

  if (!target.droppable || !canDropInto(target.name)) {
    return 'refused'
  }

  return target.name === over ? 'target' : 'idle'
}
