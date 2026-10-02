/**
 * A drag, as geometry.
 *
 * The gesture cannot be exercised here — a `PanResponder` needs a touch and the
 * boxes it reads come from a real layout pass — but the arithmetic can, and the
 * arithmetic is the only part that can be wrong in a way the eye would not catch
 * immediately.
 *
 * It is now half of the picture on purpose. `drag-order.ts` knows only about
 * boxes on a screen: which gap the finger is over, which way the other rows move
 * and how far. What each gap MEANS — which folder, which index — moved to
 * `features/bots/folder-rows.ts` when the groups became containers, and it is
 * tested in `folders.test.ts`. That split is why nothing in this file mentions
 * a folder.
 */
import { dropSlot, neighbourOffsets, rowShift, type AnchorKey, type RowBox } from '../src/features/bots/drag-order'

/**
 * Six rows a drop line can sit above.
 *
 * Only the keys matter here. In the app they come from `dragAnchors`, which also
 * hangs a drop target off each one; this file is the half that never looks at it.
 */
const anchors: AnchorKey[] = [
  { key: 'bot:alpha' },
  { key: 'bot:beta' },
  { key: 'folder:d1' },
  { key: 'folderIn:d1' },
  { key: 'bot:gamma' },
  { key: 'folderEmpty:d2' }
]

/** Forty points each, stacked, which is close enough to a real row. */
const boxes: Record<string, RowBox> = Object.fromEntries(
  anchors.map((anchor, index) => [anchor.key, { height: 40, y: index * 40 }])
)

describe('which slot the finger is over', () => {
  it('flips at a row’s midpoint, not at its edge', () => {
    // The point at which a reader would say the two rows have swapped.
    expect(dropSlot(anchors, boxes, 0)).toBe(0)
    expect(dropSlot(anchors, boxes, 19)).toBe(0)
    expect(dropSlot(anchors, boxes, 21)).toBe(1)
    expect(dropSlot(anchors, boxes, 59)).toBe(1)
    expect(dropSlot(anchors, boxes, 61)).toBe(2)
  })

  it('reads past the last row as the end of the arrangement', () => {
    expect(dropSlot(anchors, boxes, 10_000)).toBe(anchors.length)
  })

  it('skips a row the list has not measured rather than guessing where it is', () => {
    // A row FlatList has not rendered has no box, and treating it as zero-height
    // would put the line somewhere nothing is drawn.
    const partial = { 'bot:alpha': boxes['bot:alpha'] as RowBox, 'bot:gamma': boxes['bot:gamma'] as RowBox }

    expect(dropSlot(anchors, partial, 10)).toBe(0)
    expect(dropSlot(anchors, partial, 150)).toBe(4)
  })

  it('does not assume a uniform row, which a folder header disproves', () => {
    const ragged: Record<string, RowBox> = {
      'bot:alpha': { height: 72, y: 0 },
      'bot:beta': { height: 72, y: 72 },
      'folder:d1': { height: 44, y: 144 },
      'folderIn:d1': { height: 22, y: 166 },
      'bot:gamma': { height: 72, y: 188 },
      'folderEmpty:d2': { height: 38, y: 260 }
    }

    expect(dropSlot(anchors, ragged, 30)).toBe(0)
    expect(dropSlot(anchors, ragged, 150)).toBe(2)
    // Between the header's own midpoint and the synthetic half-row's: inside.
    expect(dropSlot(anchors, ragged, 170)).toBe(3)
    expect(dropSlot(anchors, ragged, 230)).toBe(5)
  })
})

describe('rowShift', () => {
  it('leaves the lifted row to its own translation', () => {
    expect(rowShift(2, 2, 5)).toBe(0)
  })

  it('shifts nothing while the row is over its own place', () => {
    // A slot equal to `from` or to `from + 1` is both "back where it started".
    expect(rowShift(3, 2, 2)).toBe(0)
    expect(rowShift(3, 2, 3)).toBe(0)
  })

  it('closes the gap behind a row dragged down', () => {
    expect(rowShift(3, 1, 4)).toBe(-1)
    expect(rowShift(5, 1, 4)).toBe(0)
  })

  it('opens a gap in front of a row dragged up', () => {
    expect(rowShift(2, 4, 2)).toBe(1)
    expect(rowShift(1, 4, 2)).toBe(0)
  })

  it('moves exactly one row for a swap with the neighbour', () => {
    const moved = anchors.map((_anchor, index) => rowShift(index, 2, 4)).filter(shift => shift !== 0)

    expect(moved).toEqual([-1])
  })
})

describe('how far the other rows move aside', () => {
  it('opens the gap with the LIFTED row’s height, not with each row’s own', () => {
    // What is opening or closing is the hole the lifted row came out of, so a
    // folder header closing up behind a chat travels the chat's height.
    const ragged: Record<string, RowBox> = {
      ...boxes,
      'bot:alpha': { height: 100, y: 0 },
      'folder:d1': { height: 20, y: 100 }
    }

    expect(neighbourOffsets(anchors, ragged, 0, 3)['folder:d1']).toBe(-100)
  })

  it('moves the rows a chat has passed on its way down, and nothing else', () => {
    const offsets = neighbourOffsets(anchors, boxes, 1, 4)

    expect(offsets['bot:alpha']).toBe(0)
    expect(offsets['folder:d1']).toBe(-40)
    expect(offsets['folderIn:d1']).toBe(-40)
    expect(offsets['bot:gamma']).toBe(0)
  })

  it('moves nothing while the row is over its own place', () => {
    expect(Object.values(neighbourOffsets(anchors, boxes, 2, 2)).every(offset => offset === 0)).toBe(true)
  })

  it('sends every row home when the gesture ends', () => {
    expect(Object.values(neighbourOffsets(anchors, boxes, 2, null)).every(offset => offset === 0)).toBe(true)
  })

  it('shifts nothing at all when the lifted row has not been measured', () => {
    expect(Object.values(neighbourOffsets(anchors, {}, 2, 5)).every(offset => offset === 0)).toBe(true)
  })

  it('never reports a signed nothing, which an animation cannot tell from zero', () => {
    expect(Object.is(neighbourOffsets(anchors, boxes, 2, 2)['bot:alpha'], -0)).toBe(false)
  })
})
