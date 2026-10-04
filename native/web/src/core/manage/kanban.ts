/**
 * The Boards page's round trips (the Expo app's `features/kanban/kanban-controller.ts`, which this follows).
 *
 * Kanban is a PLUGIN, and its data lives behind the plugin's own router at `/api/plugins/kanban/*`, mounted only
 * when the plugin is bundled or enabled. There is no socket method for any of it, so this is REST, the same REST
 * the desktop plugin speaks, and a gateway without the plugin answers 404 on every route, which is
 * `KanbanUnavailable` and not an empty board.
 *
 * Four things here are not what a board app would assume, and each is a place a client silently does the wrong
 * thing:
 *
 *  - **Columns are a server-owned constant.** A card's column IS its `status`; there is no create-column, no
 *    reorder and no column id.
 *  - **There is no card ORDER.** The server sorts by `priority DESC, created_at ASC`, so the only way to move a
 *    card within a column is to change its priority.
 *  - **Three columns are not drop targets.** `running` and `review` are claimed by the dispatcher and `scheduled`
 *    needs a wake-up time no client can attach; upstream refuses `running` outright with a 400.
 *  - **Create cannot choose a column.** `CreateTaskBody` has no `status`: the server derives `triage` or `ready`,
 *    so landing a card anywhere else is a second call.
 *
 * Every board-scoped call carries `?board=<slug>` and the page never switches the server's own current-board
 * pointer, which is shared with the CLI and the desktop: a page that switched it would move the board out from
 * under somebody else's terminal.
 *
 * Every string in an answer is the board's and its people's text, drawn as characters.
 */
import { routeErrorOf } from './route-error'
import type { ManageTransport } from './transport'

/** Where the plugin's router is mounted. The prefix is the plugin's NAME. */
export const KANBAN_BASE = '/api/plugins/kanban'

/** The columns, left to right, as `plugin_api.BOARD_COLUMNS` orders them. `archived` is a filter, not a column. */
export const BOARD_COLUMNS = ['triage', 'todo', 'scheduled', 'ready', 'running', 'blocked', 'review', 'done'] as const

/** Columns a card may leave but never be dropped into; one list for the menu and for any other way of moving. */
export const LOCKED_COLUMNS: readonly string[] = ['review', 'running', 'scheduled']

/** Can a card be put here? */
export const canDropInto = (column: string): boolean => !LOCKED_COLUMNS.includes(column)

export interface BoardSummary {
  /** What every other call addresses the board by. */
  slug: string
  name: string
  description: string | null
  /** Cards excluding archived ones. */
  total: number
}

export interface Card {
  id: string
  title: string
  body: string | null
  /** The column. */
  status: string
  assignee: string | null
  /** Higher sorts first: the only lever over a card's place in its column. */
  priority: number
  /** Epoch SECONDS. */
  createdAt: number | null
  latestSummary: string | null
  commentCount: number
}

export interface BoardColumnView {
  name: string
  /** Whether a card may be put here, so the page never offers a refusal. */
  droppable: boolean
  cards: Card[]
}

export interface BoardView {
  columns: BoardColumnView[]
  /** Who cards can be assigned to, as the board reports them. */
  assignees: string[]
}

export interface Comment {
  id: string
  author: string
  body: string
  createdAt: number | null
}

export interface CardDetail {
  card: Card
  comments: Comment[]
}

/** The gateway has no Kanban plugin mounted, so every route 404s. */
export class KanbanUnavailable extends Error {
  constructor() {
    super('This gateway has no Kanban plugin.')
    this.name = 'KanbanUnavailable'
  }
}

/**
 * A refusal the server explained. A move to `ready` that is blocked answers 409 with a `detail` that NAMES the
 * blocking parents, and a status it will not take answers 400: both are worth showing verbatim, since the page
 * cannot reconstruct which parent is in the way.
 */
export class KanbanRefused extends Error {
  constructor(
    readonly detail: string,
    readonly status: number
  ) {
    super(detail)
    this.name = 'KanbanRefused'
  }
}

const str = (value: unknown): string | null => (typeof value === 'string' && value ? value : null)
const num = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null)
const record = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {}

/** One wire task as the card the page draws; the row is much wider, and only what is read is typed. */
export const describeCard = (task: Record<string, unknown>): Card => ({
  id: String(task.id ?? ''),
  title: str(task.title) ?? '',
  body: str(task.body),
  status: str(task.status) ?? 'todo',
  assignee: str(task.assignee),
  priority: num(task.priority) ?? 0,
  createdAt: num(task.created_at),
  latestSummary: str(task.latest_summary),
  commentCount: num(task.comment_count) ?? 0
})

/** The query every board-scoped call carries. */
export function boardQuery(slug: string, extra: Record<string, string> = {}): string {
  const params = new URLSearchParams(extra)

  if (slug) {
    params.set('board', slug)
  }

  const query = params.toString()

  return query ? `?${query}` : ''
}

/** How long a write waits before nudging the dispatcher, as the desktop's debounce does. */
export const NUDGE_DELAY_MS = 400

export interface KanbanClient {
  boards(): Promise<BoardSummary[]>
  board(slug: string, options?: { includeArchived?: boolean }): Promise<BoardView>
  card(slug: string, id: string): Promise<CardDetail>
  /** Move a card; resolves with the column the board APPLIED, which is not always the one asked for. */
  move(slug: string, id: string, status: string): Promise<{ applied: string }>
  create(
    slug: string,
    input: { title: string; body?: string | null; assignee?: string | null; priority?: number; column?: string }
  ): Promise<Card>
  /** A card's own fields; never its status, which `move` owns. */
  edit(
    slug: string,
    id: string,
    patch: { title?: string; body?: string | null; assignee?: string | null; priority?: number }
  ): Promise<Card>
  /** Recoverable, unlike a delete. */
  archive(slug: string, id: string): Promise<void>
  comment(slug: string, id: string, body: string): Promise<void>
  /** Stop a pending dispatcher nudge: the page is going away. */
  dispose(): void
}

export function createKanbanClient(
  http: ManageTransport['http'],
  options: { onNudge?: (slug: string) => void; nudgeDelayMs?: number } = {}
): KanbanClient {
  let timer: ReturnType<typeof setTimeout> | null = null

  // The dispatcher runs on a 60-second timer, so a card made here would sit idle for up to a minute without a
  // nudge. Fire-and-forget and debounced: the tick is cheap when there is nothing to do, and a failed nudge is a
  // non-event.
  const nudge = (slug: string): void => {
    if (timer) {
      clearTimeout(timer)
    }

    timer = setTimeout(() => {
      timer = null

      if (options.onNudge) {
        options.onNudge(slug)
      } else {
        void http.post(`${KANBAN_BASE}/dispatch${boardQuery(slug)}`, {}).catch(() => undefined)
      }
    }, options.nudgeDelayMs ?? NUDGE_DELAY_MS)
  }

  /** Run one call, turning the refusals this router has into types. */
  const call = async <T>(run: () => Promise<T>): Promise<T> => {
    try {
      return await run()
    } catch (failure) {
      const error = routeErrorOf(failure)

      if (error.status === 404) {
        // A 404 from this prefix means the plugin is not MOUNTED: the router does not exist.
        throw new KanbanUnavailable()
      }

      if (error.status === 409 || error.status === 400) {
        throw new KanbanRefused(error.message, error.status)
      }

      throw error
    }
  }

  const patch = async (slug: string, id: string, body: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const answer = await call(() =>
      http.patch<{ task?: Record<string, unknown> }>(
        `${KANBAN_BASE}/tasks/${encodeURIComponent(id)}${boardQuery(slug)}`,
        body
      )
    )

    nudge(slug)

    return record(record(answer).task)
  }

  return {
    async boards() {
      const answer = record(await call(() => http.get<unknown>(`${KANBAN_BASE}/boards`)))

      return (Array.isArray(answer.boards) ? answer.boards : []).map(entry => {
        const row = record(entry)

        return {
          slug: String(row.slug ?? ''),
          // `name` is nullable on the wire and the slug is always there, so a board with no display name is drawn
          // under its handle rather than blank.
          name: str(row.name) ?? String(row.slug ?? ''),
          description: str(row.description),
          total: num(row.total) ?? 0
        }
      })
    },

    async board(slug, boardOptions = {}) {
      const query = boardQuery(slug, boardOptions.includeArchived ? { include_archived: 'true' } : {})
      const answer = record(await call(() => http.get<unknown>(`${KANBAN_BASE}/board${query}`)))

      // The columns come back in the server's order and the page keeps it: a status upstream grows later should
      // appear rather than be dropped by a client that thought it knew the list.
      return {
        assignees: Array.isArray(answer.assignees) ? answer.assignees.map(String) : [],
        columns: (Array.isArray(answer.columns) ? answer.columns : []).map(column => {
          const row = record(column)
          const name = String(row.name ?? '')

          return {
            name,
            droppable: canDropInto(name),
            cards: (Array.isArray(row.tasks) ? row.tasks : []).map(task => describeCard(record(task)))
          }
        })
      }
    },

    async card(slug, id) {
      const answer = record(
        await call(() => http.get<unknown>(`${KANBAN_BASE}/tasks/${encodeURIComponent(id)}${boardQuery(slug)}`))
      )

      return {
        card: describeCard(record(answer.task)),
        comments: (Array.isArray(answer.comments) ? answer.comments : []).map(comment => {
          const row = record(comment)

          return {
            id: String(row.id ?? ''),
            author: str(row.author) ?? '',
            body: str(row.body) ?? '',
            createdAt: num(row.created_at)
          }
        })
      }
    },

    async move(slug, id, status) {
      const task = await patch(slug, id, { status })

      // `_set_status_direct` consults a retry rule when a card leaves `running`, so a card put in `ready` can
      // land in `review` or `todo`: the applied status is what is drawn, not the one that was asked for.
      return { applied: str(task.status) ?? status }
    },

    async create(slug, input) {
      const wanted = input.column ?? 'ready'
      const answer = record(
        await call(() =>
          http.post<unknown>(`${KANBAN_BASE}/tasks${boardQuery(slug)}`, {
            title: input.title,
            ...(input.body ? { body: input.body } : {}),
            ...(input.assignee ? { assignee: input.assignee } : {}),
            ...(input.priority === undefined ? {} : { priority: input.priority }),
            // The only lever create has over the landing column.
            ...(wanted === 'triage' ? { triage: true } : {})
          })
        )
      )
      const made = describeCard(record(answer.task))

      nudge(slug)

      // The common cases cost one round trip: a second call is only for a column the server did not derive.
      if (!made.id || made.status === wanted) {
        return made
      }

      return describeCard(await patch(slug, made.id, { status: wanted }))
    },

    async edit(slug, id, changes) {
      return describeCard(await patch(slug, id, changes))
    },

    async archive(slug, id) {
      // `status: 'archived'` and NOT a delete: the server routes it to a recoverable archive, while the delete
      // route removes the row and its history for good.
      await patch(slug, id, { status: 'archived' })
    },

    async comment(slug, id, body) {
      // The route answers `{ok: true}` and not the comment it made, so the page re-reads the card. `author` is
      // sent: the server defaults it to "dashboard", which would label this page's comment as the dashboard's.
      await call(() =>
        http.post(`${KANBAN_BASE}/tasks/${encodeURIComponent(id)}/comments${boardQuery(slug)}`, {
          author: 'hermie',
          body
        })
      )
    },

    dispose() {
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
    }
  }
}
