/**
 * The Kanban plugin's router in memory, for the Boards page's tests: the routes of
 * `plugins/kanban/dashboard/plugin_api.py` the page uses, in the shapes `packages/fake-gateway` serves.
 *
 * What it holds to, because each is what a client gets wrong: a card's column IS its `status` and the columns are
 * a fixed list; `POST /tasks` has NO `status` (the server derives `triage` or `ready`); `running` is refused with
 * a 400, and a `ready` whose parents are not done is a 409 whose `detail` names them; archiving is
 * `status: 'archived'`; comments are only read through the task.
 */
import { aManageTransport, httpFailure } from './manage-transport'

export const BASE = '/api/plugins/kanban'

const COLUMNS = ['triage', 'todo', 'scheduled', 'ready', 'running', 'blocked', 'review', 'done']

export interface Task {
  id: string
  title: string
  body: string | null
  status: string
  assignee: string | null
  priority: number
  created_at: number
  parents: string[]
  comments: { id: number; author: string; body: string; created_at: number }[]
}

export const aTask = (over: Partial<Task> & { id: string; title: string }): Task => ({
  body: null,
  status: 'todo',
  assignee: null,
  priority: 0,
  created_at: 1_760_000_000,
  parents: [],
  comments: [],
  ...over
})

export function aKanbanPlugin(
  options: {
    boards?: { slug: string; name: string; description?: string; tasks: Task[] }[]
    /** The router is not mounted: every route 404s. */
    absent?: boolean
  } = {}
) {
  const boards = options.boards ?? [
    {
      slug: 'default',
      name: 'Default',
      description: '',
      tasks: [
        aTask({
          id: 't_aa',
          title: 'Write the release notes',
          body: 'Pull them from the changelog.',
          comments: [{ id: 1, author: 'writer', body: 'Started on this.', created_at: 1_760_000_100 }]
        }),
        aTask({ id: 't_cc', title: 'Ship the build', assignee: 'writer', priority: 2, parents: ['t_aa'] }),
        aTask({ id: 't_ee', title: 'Tidy the worktrees', status: 'running', assignee: 'writer' })
      ]
    },
    { slug: 'sprint', name: 'Sprint', description: 'This fortnight', tasks: [] }
  ]
  let nudges = 0
  let refuse: { status: number; detail: string } | null = null

  const boardOf = (query: URLSearchParams) => {
    if (options.absent) {
      throw httpFailure(404)
    }

    const slug = query.get('board') ?? boards[0]?.slug
    const found = boards.find(entry => entry.slug === slug)

    if (!found) {
      throw httpFailure(404)
    }

    return found
  }

  const view = (task: Task) => ({
    id: task.id,
    title: task.title,
    body: task.body,
    status: task.status,
    assignee: task.assignee,
    priority: task.priority,
    created_at: task.created_at,
    comment_count: task.comments.length
  })

  const apply = (board: ReturnType<typeof boardOf>, task: Task, patch: Record<string, unknown>) => {
    if (refuse) {
      throw httpFailure(refuse.status, refuse.detail)
    }

    if (typeof patch.status === 'string') {
      if (patch.status === 'running') {
        throw httpFailure(400, "Cannot move a card to 'running': the dispatcher claims it.")
      }

      if (patch.status === 'ready') {
        const blocking = task.parents
          .map(id => board.tasks.find(entry => entry.id === id))
          .filter((parent): parent is Task => parent !== undefined && parent.status !== 'done')

        if (blocking.length) {
          throw httpFailure(
            409,
            `Cannot move to 'ready': blocked by parent(s) not done — ${blocking.map(parent => `'${parent.title}' (${parent.id}, status=${parent.status})`).join(', ')}`
          )
        }
      }

      task.status = patch.status
    }

    for (const key of ['title', 'body', 'assignee', 'priority'] as const) {
      if (key in patch) {
        ;(task as unknown as Record<string, unknown>)[key] = patch[key]
      }
    }
  }

  const transport = aManageTransport({
    [`GET ${BASE}/boards`]: () => {
      if (options.absent) {
        throw httpFailure(404)
      }

      return {
        boards: boards.map(entry => ({
          slug: entry.slug,
          name: entry.name,
          description: entry.description ?? '',
          is_current: entry.slug === boards[0]?.slug,
          total: entry.tasks.filter(task => task.status !== 'archived').length
        }))
      }
    },
    [`GET ${BASE}/board`]: ({ query }) => {
      const board = boardOf(query)
      const columns = query.get('include_archived') === 'true' ? [...COLUMNS, 'archived'] : COLUMNS

      return {
        columns: columns.map(name => ({
          name,
          tasks: board.tasks
            .filter(task => task.status === name)
            .sort((a, b) => b.priority - a.priority || a.created_at - b.created_at)
            .map(view)
        })),
        assignees: [...new Set(board.tasks.map(task => task.assignee).filter(Boolean))]
      }
    },
    [`GET ${BASE}/tasks/:id`]: ({ query, params }) => {
      const board = boardOf(query)
      const task = board.tasks.find(entry => entry.id === params.id)

      if (!task) {
        throw httpFailure(404)
      }

      return { task: view(task), comments: task.comments }
    },
    [`PATCH ${BASE}/tasks/:id`]: ({ query, params, body }) => {
      const board = boardOf(query)
      const task = board.tasks.find(entry => entry.id === params.id)

      if (!task) {
        throw httpFailure(404)
      }

      apply(board, task, body as Record<string, unknown>)

      return { task: view(task) }
    },
    [`POST ${BASE}/tasks`]: ({ query, body }) => {
      const board = boardOf(query)
      const wire = body as { title?: string; body?: string; assignee?: string; priority?: number; triage?: boolean }

      if (!wire.title?.trim()) {
        throw httpFailure(422, 'title is required')
      }

      const made = aTask({
        id: `t_${board.tasks.length + 100}`,
        title: wire.title,
        body: wire.body ?? null,
        assignee: wire.assignee ?? null,
        priority: wire.priority ?? 0,
        status: wire.triage === true ? 'triage' : 'ready'
      })

      board.tasks.push(made)

      return { task: view(made) }
    },
    [`POST ${BASE}/tasks/:id/comments`]: ({ query, params, body }) => {
      const task = boardOf(query).tasks.find(entry => entry.id === params.id)

      if (!task) {
        throw httpFailure(404)
      }

      const wire = body as { author: string; body: string }

      task.comments.push({
        id: task.comments.length + 1,
        author: wire.author,
        body: wire.body,
        created_at: 1_760_000_900
      })

      return { ok: true }
    },
    [`POST ${BASE}/dispatch`]: () => {
      nudges += 1

      return { spawned: [] }
    }
  })

  return {
    ...transport,
    boards,
    nudges: () => nudges,
    refuseWrites: (status: number, detail: string) => {
      refuse = { status, detail }
    }
  }
}
