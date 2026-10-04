/**
 * The Kanban client: every board-scoped call carries `?board=` and never switches the server's current board, a
 * column is the server's status and three of them are never offered as targets, create has no status (a second
 * call lands a card elsewhere), a move answers the column the board APPLIED, the board's own sentence reaches the
 * page for a 400 or a 409, a 404 is a plugin that is not mounted, and the dispatcher is nudged once per burst.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { aKanbanPlugin, BASE } from '../../test-support/kanban-plugin'
import {
  boardQuery,
  canDropInto,
  createKanbanClient,
  describeCard,
  KanbanRefused,
  KanbanUnavailable,
  LOCKED_COLUMNS,
  NUDGE_DELAY_MS
} from './kanban'

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('the readers', () => {
  it('reduces a wide task to the card, with the defaults a missing field gets', () => {
    expect(
      describeCard({
        id: 't1',
        title: 'A',
        status: 'ready',
        priority: 2,
        created_at: 5,
        comment_count: 3,
        extra: 'ignored'
      })
    ).toEqual({
      id: 't1',
      title: 'A',
      body: null,
      status: 'ready',
      assignee: null,
      priority: 2,
      createdAt: 5,
      latestSummary: null,
      commentCount: 3
    })
    expect(describeCard({})).toMatchObject({ id: '', title: '', status: 'todo', priority: 0, createdAt: null })
  })

  it('builds the board query without ever switching the server’s own board', () => {
    expect(boardQuery('sprint')).toBe('?board=sprint')
    expect(boardQuery('sprint', { include_archived: 'true' })).toBe('?include_archived=true&board=sprint')
    expect(boardQuery('')).toBe('')
  })

  it('never offers the dispatcher’s three columns as a target', () => {
    expect([...LOCKED_COLUMNS].sort()).toEqual(['review', 'running', 'scheduled'])
    expect(['triage', 'todo', 'ready', 'blocked', 'done'].every(canDropInto)).toBe(true)
    expect(['running', 'review', 'scheduled'].some(canDropInto)).toBe(false)
  })
})

describe('the client', () => {
  it('reads the boards and one board’s columns in the order the server sent them, marking the locked ones', async () => {
    const plugin = aKanbanPlugin()
    const client = createKanbanClient(plugin.transport.http)

    expect((await client.boards()).map(board => [board.slug, board.total])).toEqual([
      ['default', 3],
      ['sprint', 0]
    ])

    const board = await client.board('default')

    expect(board.columns.map(entry => entry.name)).toEqual([
      'triage',
      'todo',
      'scheduled',
      'ready',
      'running',
      'blocked',
      'review',
      'done'
    ])
    expect(board.columns.filter(entry => !entry.droppable).map(entry => entry.name)).toEqual([
      'scheduled',
      'running',
      'review'
    ])
    expect(board.assignees).toEqual(['writer'])
    expect((await client.board('default', { includeArchived: true })).columns.at(-1)?.name).toBe('archived')
    client.dispose()
  })

  it('reads a card with its comments through the task, and a board with no display name under its slug', async () => {
    const plugin = aKanbanPlugin()
    const client = createKanbanClient(plugin.transport.http)
    const detail = await client.card('default', 't_aa')

    expect(detail.card.title).toBe('Write the release notes')
    expect(detail.comments).toEqual([{ id: '1', author: 'writer', body: 'Started on this.', createdAt: 1_760_000_100 }])

    plugin.transport.http.get = (async () => ({ boards: [{ slug: 'raw', name: null, total: 2 }] })) as never
    expect((await client.boards())[0]).toMatchObject({ slug: 'raw', name: 'raw' })
    client.dispose()
  })

  it('answers the column the board applied, which may not be the one asked for', async () => {
    const plugin = aKanbanPlugin()
    const client = createKanbanClient(plugin.transport.http)

    expect(await client.move('default', 't_aa', 'done')).toEqual({ applied: 'done' })

    plugin.transport.http.patch = (async () => ({ task: { id: 't_aa', status: 'review' } })) as never
    expect(await client.move('default', 't_aa', 'ready')).toEqual({ applied: 'review' })
    client.dispose()
  })

  it('creates with one call when the server already derives the column, and with a second when it does not', async () => {
    const plugin = aKanbanPlugin()
    const client = createKanbanClient(plugin.transport.http)

    await client.create('default', { title: 'a' })
    await client.create('default', { title: 'b', column: 'triage' })
    expect(plugin.requests.map(request => request.method)).toEqual(['POST', 'POST'])
    expect(plugin.requests[1]?.body).toMatchObject({ triage: true })

    await client.create('default', { title: 'c', column: 'blocked', assignee: 'dana', priority: 4 })
    expect(
      plugin.requests.slice(2).map(request => `${request.method} ${request.body ? JSON.stringify(request.body) : ''}`)
    ).toEqual(['POST {"title":"c","assignee":"dana","priority":4}', 'PATCH {"status":"blocked"}'])
    client.dispose()
  })

  it('archives as a status and comments as the page’s own author', async () => {
    const plugin = aKanbanPlugin()
    const client = createKanbanClient(plugin.transport.http)

    await client.archive('default', 't_aa')
    await client.comment('default', 't_cc', 'hello')

    expect(plugin.requests.map(request => [request.method, request.path.split('?')[0], request.body])).toEqual([
      ['PATCH', `${BASE}/tasks/t_aa`, { status: 'archived' }],
      ['POST', `${BASE}/tasks/t_cc/comments`, { author: 'hermie', body: 'hello' }]
    ])
    client.dispose()
  })
})

describe('refusals', () => {
  it('keeps the board’s own sentence for a 409 and a 400', async () => {
    const plugin = aKanbanPlugin()
    const client = createKanbanClient(plugin.transport.http)

    await expect(client.move('default', 't_cc', 'ready')).rejects.toMatchObject({
      name: 'KanbanRefused',
      status: 409,
      detail: expect.stringContaining("'Write the release notes' (t_aa, status=todo)")
    })
    await expect(client.move('default', 't_aa', 'running')).rejects.toBeInstanceOf(KanbanRefused)
    client.dispose()
  })

  it('takes a 404 for a plugin that is not mounted, and any other failure as it came', async () => {
    const absent = createKanbanClient(aKanbanPlugin({ absent: true }).transport.http)

    await expect(absent.boards()).rejects.toBeInstanceOf(KanbanUnavailable)

    const plugin = aKanbanPlugin()

    plugin.refuseWrites(500, 'boom')

    const client = createKanbanClient(plugin.transport.http)

    await expect(client.archive('default', 't_aa')).rejects.toMatchObject({ status: 500 })
    absent.dispose()
    client.dispose()
  })
})

describe('the dispatcher nudge', () => {
  it('fires once for a burst of writes, after the last one, and not at all once the client is disposed', async () => {
    const plugin = aKanbanPlugin()
    const nudged: string[] = []
    const client = createKanbanClient(plugin.transport.http, { onNudge: slug => nudged.push(slug) })

    await client.move('default', 't_aa', 'blocked')
    await client.move('default', 't_aa', 'done')
    await client.edit('default', 't_aa', { title: 'x' })
    expect(nudged).toEqual([])

    vi.advanceTimersByTime(NUDGE_DELAY_MS - 1)
    expect(nudged).toEqual([])
    vi.advanceTimersByTime(1)
    expect(nudged).toEqual(['default'])

    await client.move('default', 't_aa', 'todo')
    client.dispose()
    vi.advanceTimersByTime(NUDGE_DELAY_MS * 2)
    expect(nudged).toEqual(['default'])
  })

  it('posts to the dispatch route by default, and a failed nudge is a non-event', async () => {
    const plugin = aKanbanPlugin()
    const client = createKanbanClient(plugin.transport.http)

    await client.move('default', 't_aa', 'blocked')
    vi.advanceTimersByTime(NUDGE_DELAY_MS)
    expect(plugin.requests.at(-1)).toMatchObject({ method: 'POST', path: `${BASE}/dispatch?board=default` })

    plugin.transport.http.post = (async () => {
      throw new Error('down')
    }) as never
    await client.move('default', 't_aa', 'done')
    expect(() => vi.advanceTimersByTime(NUDGE_DELAY_MS)).not.toThrow()
    client.dispose()
  })
})
