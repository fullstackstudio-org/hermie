/**
 * Rows grouped into chunks that keep their identity across commits.
 *
 * A transcript of 5,000 rows re-rendered 30 times a second spends its frame in
 * React walking 5,000 children to find the one that changed. Grouping them into
 * chunks of about `CHUNK_SIZE`, each memoised on its rows, turns that into a walk
 * over a hundred chunks and one chunk's rows.
 *
 * The grouping has to be stable, or it costs more than it saves: a chunk is a
 * DOM element, and a row that moves to another chunk is unmounted and mounted
 * again. So a row keeps the chunk it was first put in for as long as it lives:
 *
 *  - rows added after a known row join that row's chunk while it has room, then
 *    open a new chunk (the streaming tail, a new turn);
 *  - rows added before the first known row (older history) are grouped into new
 *    chunks of their own in front of it;
 *  - a row whose chunk is no longer contiguous (a reorder) is treated as new.
 *
 * The previous assignment goes in and the next one comes out. The row-to-chunk
 * map is carried over and updated in place rather than copied, because copying
 * 5,000 entries on every frame of a streaming reply was a measurable share of
 * the frame; the previous assignment must not be used again.
 */

/** Rows per chunk when a chunk is opened; a chunk is never filled past this. */
export const CHUNK_SIZE = 50

export interface Chunk<Row> {
  /** Stable for the chunk's life; the React key of its element. */
  id: number
  rows: Row[]
}

export interface ChunkAssignment<Row> {
  chunks: Chunk<Row>[]
  /** Row key to chunk id. */
  owner: Map<string, number>
  /** The lowest and highest chunk ids handed out so far. */
  lowest: number
  highest: number
}

export const emptyAssignment = <Row>(): ChunkAssignment<Row> => ({
  chunks: [],
  owner: new Map(),
  lowest: 0,
  highest: -1
})

export function assignChunks<Row>(
  previous: ChunkAssignment<Row>,
  rows: readonly Row[],
  keyOf: (row: Row) => string
): ChunkAssignment<Row> {
  const owner = previous.owner
  const chunks: Chunk<Row>[] = []
  const closed = new Set<number>()
  let lowest = previous.lowest
  let highest = previous.highest

  // Rows in front of the first row this list already knows: older history.
  let firstKnown = rows.findIndex(row => owner.has(keyOf(row)))
  if (firstKnown === -1) {
    firstKnown = rows.length
  }

  // Grouped from the known row backwards, so the chunk that touches it is full
  // and a short remainder sits at the very top, where the next page will land.
  const slices: Row[][] = []
  for (let end = firstKnown; end > 0; end -= CHUNK_SIZE) {
    slices.unshift(rows.slice(Math.max(0, end - CHUNK_SIZE), end))
  }
  // A list seen for the first time numbers its chunks upwards from 0; a page of
  // older history gets ids below every id handed out so far.
  const fresh = owner.size === 0
  slices.forEach((slice, index) => {
    const id = fresh ? highest + 1 + index : lowest - slices.length + index
    chunks.push({ id, rows: slice })
    for (const row of slice) {
      owner.set(keyOf(row), id)
    }
  })
  if (fresh) {
    highest += slices.length
  } else {
    lowest -= slices.length
  }

  let current = chunks[chunks.length - 1]
  if (current) {
    closed.add(current.id)
  }

  for (let index = firstKnown; index < rows.length; index += 1) {
    const row = rows[index] as Row
    const key = keyOf(row)
    const known = owner.get(key)

    if (known !== undefined && current?.id === known) {
      current.rows.push(row)
    } else if (known !== undefined && !closed.has(known)) {
      if (current) {
        closed.add(current.id)
      }
      current = { id: known, rows: [row] }
      chunks.push(current)
    } else if (current && current.rows.length < CHUNK_SIZE) {
      current.rows.push(row)
    } else {
      if (current) {
        closed.add(current.id)
      }
      current = { id: (highest += 1), rows: [row] }
      chunks.push(current)
    }

    if (known !== current.id) {
      owner.set(key, current.id)
    }
  }

  // Rows that went away. Only counted on the common path; walked when needed.
  if (owner.size > rows.length) {
    const present = new Set(rows.map(keyOf))
    for (const key of owner.keys()) {
      if (!present.has(key)) {
        owner.delete(key)
      }
    }
  }

  return { chunks, owner, lowest, highest }
}
