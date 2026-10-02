/**
 * The Boards feature's calls, and the four places a board app guesses wrong.
 *
 * Columns are a server-owned constant, there is no card ORDER at all, three
 * columns refuse every card, and create cannot pick a column. Each of those is
 * a case here, because each is something that looks like it works right up
 * until a real gateway answers 400 or silently puts the card somewhere else.
 */
import {
  BOARD_COLUMNS,
  KANBAN_BASE,
  KanbanController,
  KanbanRefused,
  KanbanUnavailable,
  LOCKED_COLUMNS,
  boardQuery,
  canDropInto,
  debounceNudge,
  describeCard,
  type KanbanHttp
} from '../src/features/kanban/kanban-controller'

interface Recorded {
  method: string
  path: string
  body?: unknown
}

/** A `KanbanHttp` that records every call and answers per path. */
const door = (answers: Record<string, unknown | (() => unknown)> = {}): KanbanHttp & { calls: Recorded[] } => {
  const calls: Recorded[] = []

  const run = (method: string) => async (path: string, body?: unknown) => {
    calls.push({ method, path, ...(body === undefined ? {} : { body }) })

    const key = Object.keys(answers).find(entry => path.startsWith(entry))
    const answer = key === undefined ? {} : answers[key]

    return (typeof answer === 'function' ? (answer as () => unknown)() : answer) as never
  }

  return { calls, get: run('GET'), post: run('POST'), patch: run('PATCH'), delete: run('DELETE') }
}

/** What the HTTP client throws: a status, and the body's `detail` on `hint`. */
const fails = (status: number, hint?: string): KanbanHttp => {
  const thrower = async () => {
    throw Object.assign(new Error(`HTTP ${status}`), { status, ...(hint === undefined ? {} : { hint }) })
  }

  return { get: thrower, post: thrower, patch: thrower, delete: thrower }
}

describe('the board’s shape, which is upstream’s and not ours', () => {
  it('lists the eight columns in plugin_api’s own order', () => {
    expect([...BOARD_COLUMNS]).toEqual(['triage', 'todo', 'scheduled', 'ready', 'running', 'blocked', 'review', 'done'])
  })

  /**
   * The three the dispatcher owns. `running` is refused outright by
   * `_apply_status` with a 400, so offering it as a target would be offering a
   * refusal; `review` and `scheduled` need state no client can attach.
   */
  it('refuses the three columns a card may leave but never enter', () => {
    expect([...LOCKED_COLUMNS].sort()).toEqual(['review', 'running', 'scheduled'])
    expect(canDropInto('running')).toBe(false)
    expect(canDropInto('review')).toBe(false)
    expect(canDropInto('scheduled')).toBe(false)
    expect(canDropInto('todo')).toBe(true)
    expect(canDropInto('done')).toBe(true)
  })
})

describe('boardQuery', () => {
  /**
   * `?board=` on every call, and never `POST /boards/{slug}/switch`. That route
   * moves the SERVER's current-board pointer, which the CLI and the desktop
   * share — a phone switching it would move the board out from under somebody
   * else's terminal.
   */
  it('scopes a call to one board without touching the server’s pointer', () => {
    expect(boardQuery('sprint')).toBe('?board=sprint')
    expect(boardQuery('sprint', { include_archived: 'true' })).toContain('board=sprint')
    expect(boardQuery('sprint', { include_archived: 'true' })).toContain('include_archived=true')
  })

  it('sends nothing at all for the server’s own current board', () => {
    expect(boardQuery('')).toBe('')
  })
})

describe('describeCard', () => {
  it('keeps the fields the app draws and ignores the thirty it does not', () => {
    const card = describeCard({
      id: 't_ab12cd34',
      title: 'Ship it',
      status: 'ready',
      priority: 3,
      created_at: 1_760_000_000,
      comment_count: 2,
      claim_lock: 'nope',
      goal_mode: true
    })

    expect(card).toEqual({
      id: 't_ab12cd34',
      title: 'Ship it',
      body: null,
      status: 'ready',
      assignee: null,
      priority: 3,
      createdAt: 1_760_000_000,
      latestSummary: null,
      commentCount: 2
    })
  })

  it('defaults a card with no priority or comments rather than dropping it', () => {
    expect(describeCard({ id: 't_1', title: 'x', status: 'todo' })).toMatchObject({ priority: 0, commentCount: 0 })
  })
})

describe('KanbanController.board', () => {
  it('marks each column with whether it will take a card', async () => {
    const http = door({
      [`${KANBAN_BASE}/board`]: {
        columns: [
          { name: 'todo', tasks: [{ id: 't_1', title: 'a', status: 'todo' }] },
          { name: 'running', tasks: [] }
        ],
        assignees: ['writer']
      }
    })

    const view = await new KanbanController(http).board('sprint')

    expect(view.columns[0]).toMatchObject({ name: 'todo', droppable: true })
    expect(view.columns[1]).toMatchObject({ name: 'running', droppable: false })
    expect(view.columns[0]?.cards[0]?.id).toBe('t_1')
    expect(view.assignees).toEqual(['writer'])
  })

  /**
   * `archived` is a filter toggle rather than a column, and it only appears
   * when it is asked for.
   */
  it('asks for the archived column only when it was wanted', async () => {
    const http = door({ [`${KANBAN_BASE}/board`]: { columns: [] } })
    const controller = new KanbanController(http)

    await controller.board('sprint')
    await controller.board('sprint', { includeArchived: true })

    expect(http.calls[0]?.path).not.toContain('include_archived')
    expect(http.calls[1]?.path).toContain('include_archived=true')
  })

  /**
   * The column list is the SERVER's. A client that filtered to the eight it
   * knows would drop a status upstream grew later, and the card with it.
   */
  it('keeps a column the app has never heard of', async () => {
    const http = door({ [`${KANBAN_BASE}/board`]: { columns: [{ name: 'quarantine', tasks: [] }] } })

    expect((await new KanbanController(http).board('s')).columns[0]?.name).toBe('quarantine')
  })
})

describe('KanbanController.move', () => {
  it('sends a status and nothing else, because there is no position to send', async () => {
    const http = door({ [`${KANBAN_BASE}/tasks/`]: { task: { id: 't_1', title: 'a', status: 'done' } } })

    await new KanbanController(http).move('sprint', 't_1', 'done')

    expect(http.calls[0]?.method).toBe('PATCH')
    expect(http.calls[0]?.path).toBe(`${KANBAN_BASE}/tasks/t_1?board=sprint`)
    expect(http.calls[0]?.body).toEqual({ status: 'done' })
  })

  /**
   * The answer a client most easily assumes. `_set_status_direct` consults
   * `_retry_status_for_run` when a card leaves `running`, so a card dragged to
   * `ready` can legitimately land in `review` — and a page that echoed the
   * request back would draw it in the wrong column until the next refresh.
   */
  it('reports the APPLIED column, which is not always the one asked for', async () => {
    const http = door({ [`${KANBAN_BASE}/tasks/`]: { task: { id: 't_1', title: 'a', status: 'review' } } })

    expect(await new KanbanController(http).move('sprint', 't_1', 'ready')).toEqual({ applied: 'review' })
  })

  /**
   * The 409's sentence names the blocking cards, and nothing on this side can
   * reconstruct it — so it is carried through verbatim rather than replaced
   * with "could not move the card".
   */
  it('carries the server’s refusal sentence through intact', async () => {
    const detail = "Cannot move to 'ready': blocked by parent(s) not done — 'Spec' (t_99, status=todo)"

    await expect(new KanbanController(fails(409, detail)).move('s', 't_1', 'ready')).rejects.toThrow(detail)

    const caught = await new KanbanController(fails(409, detail)).move('s', 't_1', 'ready').catch(error => error)

    expect(caught).toBeInstanceOf(KanbanRefused)
    expect((caught as KanbanRefused).detail).toBe(detail)
    expect((caught as KanbanRefused).status).toBe(409)
  })

  it('treats a 400 status verb as a refusal too', async () => {
    const message = "Cannot set status to 'running' directly; use the dispatcher/claim path"

    await expect(new KanbanController(fails(400, message)).move('s', 't_1', 'running')).rejects.toBeInstanceOf(
      KanbanRefused
    )
  })
})

describe('KanbanController.create', () => {
  /**
   * `CreateTaskBody` has no `status`: the server derives `ready`, so a card
   * wanted in `ready` costs ONE call. The desktop does the same.
   */
  it('makes a ready card in one call', async () => {
    const http = door({ [`${KANBAN_BASE}/tasks`]: { task: { id: 't_1', title: 'a', status: 'ready' } } })

    await new KanbanController(http).create('sprint', { title: 'a', column: 'ready' })

    expect(http.calls.filter(call => call.method !== 'GET')).toHaveLength(1)
    expect(http.calls[0]?.body).toEqual({ title: 'a' })
  })

  /** `triage: true` is the only lever create has over the landing column. */
  it('uses the triage flag rather than a second call for triage', async () => {
    const http = door({ [`${KANBAN_BASE}/tasks`]: { task: { id: 't_1', title: 'a', status: 'triage' } } })

    await new KanbanController(http).create('sprint', { title: 'a', column: 'triage' })

    expect(http.calls).toHaveLength(1)
    expect(http.calls[0]?.body).toMatchObject({ triage: true })
  })

  /**
   * Anywhere else is two calls, because there is no third spelling. A client
   * that sent `status` on the create would have it ignored and the card would
   * appear in `ready`.
   */
  it('patches the card into a column create cannot reach', async () => {
    let made = false
    const http = door({
      [`${KANBAN_BASE}/tasks`]: () => {
        const status = made ? 'todo' : 'ready'
        made = true

        return { task: { id: 't_1', title: 'a', status } }
      }
    })

    const card = await new KanbanController(http).create('sprint', { title: 'a', column: 'todo' })

    expect(http.calls.map(call => call.method)).toEqual(['POST', 'PATCH'])
    expect(http.calls[1]?.body).toEqual({ status: 'todo' })
    expect(card.status).toBe('todo')
  })
})

describe('KanbanController.archive', () => {
  /**
   * Archive is a STATUS, not a delete. `plugin_api` routes `archived` past the
   * verb table to `archive_task`, which is recoverable; `DELETE /tasks/{id}`
   * removes the row and its history for good.
   */
  it('sets the archived status and never calls DELETE', async () => {
    const http = door({ [`${KANBAN_BASE}/tasks/`]: { task: { id: 't_1', title: 'a', status: 'archived' } } })

    await new KanbanController(http).archive('sprint', 't_1')

    expect(http.calls.map(call => call.method)).toEqual(['PATCH'])
    expect(http.calls[0]?.body).toEqual({ status: 'archived' })
  })
})

describe('KanbanController.comment', () => {
  /** The server defaults the author to "dashboard", which a phone is not. */
  it('names itself as the author rather than letting the server guess', async () => {
    const http = door({ [`${KANBAN_BASE}/tasks/`]: { ok: true } })

    await new KanbanController(http).comment('sprint', 't_1', 'looks good')

    expect(http.calls[0]?.path).toBe(`${KANBAN_BASE}/tasks/t_1/comments?board=sprint`)
    expect(http.calls[0]?.body).toEqual({ author: 'hermie', body: 'looks good' })
  })

  it('reads comments through the task, which is the only route that has them', async () => {
    const http = door({
      [`${KANBAN_BASE}/tasks/`]: {
        task: { id: 't_1', title: 'a', status: 'todo' },
        comments: [{ id: 7, author: 'writer', body: 'hi', created_at: 1_760_000_000 }]
      }
    })

    const detail = await new KanbanController(http).card('sprint', 't_1')

    expect(detail.comments).toEqual([{ id: '7', author: 'writer', body: 'hi', createdAt: 1_760_000_000 }])
  })
})

describe('the two failures that are not the same', () => {
  /**
   * A 404 with no body is the PREFIX not existing — the plugin is absent or
   * switched off, and every route 404s. There is nothing to degrade to.
   */
  it('reads a bare 404 as the plugin not being installed', async () => {
    await expect(new KanbanController(fails(404)).boards()).rejects.toBeInstanceOf(KanbanUnavailable)
  })

  /**
   * A 404 that carries a sentence is the router itself, answering about one
   * missing card. Reporting that as "this gateway has no Kanban" would send
   * somebody to install a plugin they already have.
   */
  it('reads a 404 with a detail as an ordinary missing card', async () => {
    await expect(new KanbanController(fails(404, 'task not found')).card('s', 't_9')).rejects.not.toBeInstanceOf(
      KanbanUnavailable
    )
  })

  it('lets everything else through as itself', async () => {
    await expect(new KanbanController(fails(500)).boards()).rejects.toThrow('HTTP 500')
  })
})

describe('debounceNudge', () => {
  beforeEach(() => jest.useFakeTimers())
  afterEach(() => jest.useRealTimers())

  /**
   * The dispatcher's own tick is 60 seconds, so a card made on a phone would
   * sit idle without a nudge — but a burst of edits should cost one, not one
   * each.
   */
  it('collapses a burst of writes into a single nudge', () => {
    const seen: string[] = []
    const nudge = debounceNudge(slug => seen.push(slug))

    nudge('sprint')
    nudge('sprint')
    nudge('sprint')

    expect(seen).toEqual([])

    jest.runAllTimers()

    expect(seen).toEqual(['sprint'])
  })

  it('can be called off, so a screen that closed does not nudge', () => {
    const seen: string[] = []
    const nudge = debounceNudge(slug => seen.push(slug))

    nudge('sprint')
    nudge.cancel()
    jest.runAllTimers()

    expect(seen).toEqual([])
  })
})
