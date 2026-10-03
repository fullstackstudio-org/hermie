import { describe, expect, it } from 'vitest'

import { assignChunks, CHUNK_SIZE, type ChunkAssignment, emptyAssignment } from './row-chunks'

const keyOf = (row: string) => row
const rows = (prefix: string, count: number) => Array.from({ length: count }, (_, index) => `${prefix}${index}`)

/** Which chunk each row is in, for comparing two assignments. */
const owners = (assignment: ChunkAssignment<string>) => Object.fromEntries(assignment.owner)

function expectWellFormed(assignment: ChunkAssignment<string>, order: string[]) {
  expect(assignment.chunks.flatMap(chunk => chunk.rows)).toEqual(order)
  const ids = assignment.chunks.map(chunk => chunk.id)
  expect(new Set(ids).size).toBe(ids.length)
  for (const chunk of assignment.chunks) {
    expect(chunk.rows.length).toBeGreaterThan(0)
    expect(chunk.rows.length).toBeLessThanOrEqual(CHUNK_SIZE)
  }
}

describe('row chunks', () => {
  it('groups a new list into full chunks, the remainder at the top', () => {
    const order = rows('r', 120)
    const assignment = assignChunks(emptyAssignment<string>(), order, keyOf)

    expectWellFormed(assignment, order)
    expect(assignment.chunks.map(chunk => chunk.rows.length)).toEqual([20, 50, 50])
    expect(assignment.chunks.map(chunk => chunk.id)).toEqual([0, 1, 2])
  })

  it('keeps every row in its chunk while the tail grows and new rows arrive', () => {
    const order = rows('r', 120)
    const first = assignChunks(emptyAssignment<string>(), order, keyOf)
    const before = owners(first)
    const grown = [...order, ...rows('n', 70)]
    const next = assignChunks(first, grown, keyOf)

    expectWellFormed(next, grown)
    for (const key of order) {
      expect(next.owner.get(key)).toBe(before[key])
    }
    // The last chunk was full, so new rows open new chunks after it.
    expect(next.chunks.map(chunk => chunk.rows.length)).toEqual([20, 50, 50, 50, 20])
  })

  it('fills the tail chunk before opening another', () => {
    const first = assignChunks(emptyAssignment<string>(), rows('r', 10), keyOf)
    const before = owners(first)
    const next = assignChunks(first, [...rows('r', 10), 'n0', 'n1'], keyOf)

    expect(next.chunks).toHaveLength(1)
    expect(next.owner.get('n1')).toBe(before.r0)
  })

  it('puts a page of older rows in new chunks in front, and moves nobody', () => {
    const order = rows('r', 120)
    const first = assignChunks(emptyAssignment<string>(), order, keyOf)
    const before = owners(first)
    const older = [...rows('o', 200), ...order]
    const next = assignChunks(first, older, keyOf)

    expectWellFormed(next, older)
    expect(owners(next)).toMatchObject(before)
    expect(next.chunks.slice(0, 4).map(chunk => chunk.id)).toEqual([-4, -3, -2, -1])

    const again = assignChunks(next, [...rows('p', 30), ...older], keyOf)
    expectWellFormed(again, [...rows('p', 30), ...older])
    expect(again.chunks[0]?.id).toBe(-5)
  })

  it('drops rows that went away, and the chunks they emptied', () => {
    const order = rows('r', 120)
    const first = assignChunks(emptyAssignment<string>(), order, keyOf)
    const fewer = order.filter((_, index) => index < 20 || index >= 70)
    const next = assignChunks(first, fewer, keyOf)

    expectWellFormed(next, fewer)
    expect(next.chunks.map(chunk => chunk.id)).toEqual([0, 2])
    expect(next.owner.size).toBe(fewer.length)
    expect(next.owner.has('r20')).toBe(false)
  })

  it('gives a row that moved out of its run a chunk of its own instead of a duplicate key', () => {
    const order = rows('r', 120)
    const first = assignChunks(emptyAssignment<string>(), order, keyOf)
    const before = owners(first)
    const moved = [...order.slice(1), 'r0']
    const next = assignChunks(first, moved, keyOf)

    expectWellFormed(next, moved)
    expect(next.owner.get('r0')).not.toBe(before.r0)
  })

  it('is empty for no rows', () => {
    expect(assignChunks(emptyAssignment<string>(), [], keyOf).chunks).toEqual([])
  })
})
