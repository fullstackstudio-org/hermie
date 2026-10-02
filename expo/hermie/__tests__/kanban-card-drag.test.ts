/**
 * Where a dragged card lands, and the three ways it does not.
 *
 * The drag exists on wide windows only, but what it RESOLVES to is not a
 * layout question and is tested here without a renderer. Two things have to
 * hold, and both are things a board app gets wrong by being helpful:
 *
 *  - a drop is a COLUMN and nothing finer, because there is no rank on the
 *    wire for a finer answer to be about;
 *  - a column the dispatcher owns is refused BEFORE the request, because
 *    upstream raises on `running` ahead of every other check and a 400 the
 *    client could have predicted is a round trip spent saying so.
 */
import {
  columnAt,
  columnDragState,
  resolveDrop,
  type ColumnBox,
  type ColumnTarget
} from '../src/features/kanban/card-drag'
import { BOARD_COLUMNS, LOCKED_COLUMNS, canDropInto } from '../src/features/kanban/kanban-controller'

/** The board as the screen lays it out: eight 260pt columns, 12pt apart. */
const COLUMNS: ColumnTarget[] = BOARD_COLUMNS.map(name => ({ droppable: canDropInto(name), name }))

const WIDTH = 260
const GAP = 12

const BOXES: Record<string, ColumnBox> = Object.fromEntries(
  BOARD_COLUMNS.map((name, index) => [name, { width: WIDTH, x: index * (WIDTH + GAP) }])
)

/** The middle of a column's band, which is where a reader aims. */
const middleOf = (name: string): number => BOXES[name]!.x + WIDTH / 2

describe('which column is under the finger', () => {
  it.each(BOARD_COLUMNS)('answers %s for a point inside its band', name => {
    expect(columnAt(COLUMNS, BOXES, middleOf(name))?.name).toBe(name)
  })

  it('answers nothing before the first column and past the last', () => {
    expect(columnAt(COLUMNS, BOXES, -1)).toBeNull()
    expect(columnAt(COLUMNS, BOXES, 7 * (WIDTH + GAP) + WIDTH + 1)).toBeNull()
  })

  it('answers nothing in the gutter between two columns', () => {
    // The gap belongs to neither, and inventing an owner for it would put a
    // card in whichever column the loop happened to reach first.
    const gutter = BOXES.triage!.x + WIDTH + GAP / 2

    expect(columnAt(COLUMNS, BOXES, gutter)).toBeNull()
  })

  it('takes the leading edge and leaves the trailing one to the gutter', () => {
    expect(columnAt(COLUMNS, BOXES, BOXES.todo!.x)?.name).toBe('todo')
    expect(columnAt(COLUMNS, BOXES, BOXES.todo!.x + WIDTH)).toBeNull()
  })

  it('ignores a column nothing has measured yet', () => {
    // Missing is not the same as empty: a band with no reading is a column
    // that has not laid out, and guessing one for it lands cards at random.
    const partial = { done: BOXES.done! }

    expect(columnAt(COLUMNS, partial, middleOf('triage'))).toBeNull()
    expect(columnAt(COLUMNS, partial, middleOf('done'))?.name).toBe('done')
  })

  it('ignores a column measured at zero width', () => {
    expect(columnAt(COLUMNS, { ...BOXES, todo: { width: 0, x: BOXES.todo!.x } }, middleOf('todo'))).toBeNull()
  })
})

describe('what letting go would do', () => {
  it('moves a card to a column that will take it', () => {
    expect(resolveDrop(COLUMNS, BOXES, middleOf('done'), 'todo')).toEqual({ column: 'done', kind: 'move' })
  })

  it('is silent for a card put back in its own column', () => {
    // Not a move and not an error. A reader who picks a card up and puts it
    // down again has not asked for anything, so nothing is sent and nothing
    // is said.
    expect(resolveDrop(COLUMNS, BOXES, middleOf('todo'), 'todo')).toEqual({ column: 'todo', kind: 'origin' })
  })

  it('is silent for a card let go outside every column', () => {
    expect(resolveDrop(COLUMNS, BOXES, -40, 'todo')).toEqual({ kind: 'outside' })
  })

  it.each(LOCKED_COLUMNS)('refuses %s rather than sending a request that would 400', locked => {
    expect(resolveDrop(COLUMNS, BOXES, middleOf(locked), 'todo')).toEqual({ column: locked, kind: 'refused' })
  })

  it('refuses a column a caller forgot to mark undroppable', () => {
    // `droppable` and `canDropInto` are both consulted on purpose. A hand-built
    // target list — a test, the gallery — must not be able to offer `running`
    // by leaving a field out.
    const sloppy: ColumnTarget[] = [{ droppable: true, name: 'running' }]

    expect(resolveDrop(sloppy, { running: BOXES.running! }, middleOf('running'), 'todo')).toEqual({
      column: 'running',
      kind: 'refused'
    })
  })

  it('refuses a column the server marked undroppable even if the rule has not heard of it', () => {
    // The mirror of the case above: a status upstream grows later arrives with
    // `droppable` computed by the controller, and the client must honour it
    // without a copy of the list.
    const future: ColumnTarget[] = [{ droppable: false, name: 'quarantined' }]

    expect(resolveDrop(future, { quarantined: { width: WIDTH, x: 0 } }, WIDTH / 2, 'todo')).toEqual({
      column: 'quarantined',
      kind: 'refused'
    })
  })

  it('lets a card LEAVE a locked column, which is the half that is allowed', () => {
    // `running` refuses arrivals, not departures — a card leaving it is the
    // ordinary case the server itself re-routes.
    expect(resolveDrop(COLUMNS, BOXES, middleOf('todo'), 'running')).toEqual({ column: 'todo', kind: 'move' })
  })
})

describe('how a column is drawn while a card is in the air', () => {
  const stateOf = (name: string, from: string, over: string | null) =>
    columnDragState(
      COLUMNS.find(column => column.name === name)!,
      { from },
      over
    )

  it('says nothing at all when nothing is being dragged', () => {
    for (const column of COLUMNS) {
      expect(columnDragState(column, null, null)).toBe('idle')
    }
  })

  it.each(LOCKED_COLUMNS)('marks %s a non-target from the moment the card lifts', locked => {
    // Before the reader has aimed anywhere: `over` is null and the column
    // already says no. That is the drag's version of the menu not listing it.
    expect(stateOf(locked, 'todo', null)).toBe('refused')
  })

  it('lights only the column under the finger', () => {
    expect(stateOf('done', 'todo', 'done')).toBe('target')
    expect(stateOf('blocked', 'todo', 'done')).toBe('idle')
  })

  it('never marks the card’s own column a target, even aimed at', () => {
    expect(stateOf('todo', 'todo', 'todo')).toBe('origin')
  })

  it('keeps a locked column refused even while the finger is over it', () => {
    expect(stateOf('running', 'todo', 'running')).toBe('refused')
  })
})
