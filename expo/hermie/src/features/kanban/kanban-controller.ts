/**
 * The Boards page's round trips.
 *
 * Kanban is a PLUGIN, and its data lives behind the plugin's own FastAPI router
 * at `/api/plugins/kanban/*` — `plugins/kanban/dashboard/plugin_api.py`, mounted
 * by `web_server_dashboard.py` only when the plugin is bundled or enabled. There
 * is no socket method for any of it: the gateway's `/kanban` slash command
 * answers human-readable text, and `ui_meta` is a per-profile blob in
 * `profile.yaml` with no list semantics. So this is REST, the same REST the
 * desktop plugin speaks, and a gateway without the plugin answers 404 on every
 * route — which is {@link KanbanUnavailable} rather than an empty board.
 *
 * Four things here are not what a board app would assume, and every one of them
 * is a place a client silently does the wrong thing:
 *
 *  - **Columns are a server-owned constant.** `BOARD_COLUMNS` in
 *    `plugin_api.py` is a fixed list and a card's column IS its `status`. There
 *    is no create-column, no reorder-column, and no column id.
 *  - **There is no card ORDER.** No `position`, no `index`, no rank anywhere in
 *    the schema. The server sorts by `priority DESC, created_at ASC`, so the
 *    only way to move a card within a column is to change its priority.
 *  - **Three columns are not drop targets.** `running` and `review` are claimed
 *    by the dispatcher and `scheduled` needs a wake-up time no client can
 *    attach; upstream refuses `running` outright with a 400. See
 *    {@link LOCKED_COLUMNS}.
 *  - **Create cannot choose a column.** `CreateTaskBody` has no `status`: the
 *    server derives `triage` or `ready`, so landing a card anywhere else is a
 *    second call. See {@link KanbanController.create}.
 */

/** The slice of the gateway's HTTP half this feature needs. Injected so a test can watch it. */
export interface KanbanHttp {
  get<T>(path: string): Promise<T>
  post<T>(path: string, body?: unknown): Promise<T>
  patch<T>(path: string, body?: unknown): Promise<T>
  delete<T>(path: string, body?: unknown): Promise<T>
}

/** Where the plugin's router is mounted. The prefix is the plugin's NAME. */
export const KANBAN_BASE = '/api/plugins/kanban'

/**
 * The board's columns, left to right, exactly as `plugin_api.BOARD_COLUMNS`
 * orders them.
 *
 * `archived` is not here: upstream appends it as a ninth column only when
 * `include_archived=true`, and calls it a filter toggle rather than a column.
 */
export const BOARD_COLUMNS = ['triage', 'todo', 'scheduled', 'ready', 'running', 'blocked', 'review', 'done'] as const

export type BoardColumn = (typeof BOARD_COLUMNS)[number]

/**
 * Columns a card may leave but never be dropped into.
 *
 * The same three the desktop plugin locks, for the reasons upstream gives:
 * `running` and `review` belong to the dispatcher, and `scheduled` needs a
 * wake-up time only an agent or the CLI can attach. `running` is the hard one —
 * `_apply_status` raises before it looks at anything else, so offering it as a
 * target would be offering a 400.
 */
export const LOCKED_COLUMNS: readonly string[] = ['review', 'running', 'scheduled']

/** Can a card be dropped here? Exported because the menu and the drag must agree. */
export const canDropInto = (column: string): boolean => !LOCKED_COLUMNS.includes(column)

/** One board on disk. `slug` is what every other call addresses it by. */
export interface BoardSummary {
  slug: string
  name: string
  description: string | null
  /** The server's own current-board pointer. Read, never written — see {@link boardQuery}. */
  isCurrent: boolean
  /** Cards excluding archived ones, as `list_boards` counts them. */
  total: number
}

/** One card, reduced to what the app draws. The wire row carries far more. */
export interface Card {
  id: string
  title: string
  body: string | null
  /** The column. A card's status IS its column. */
  status: string
  assignee: string | null
  /** Higher sorts first. The only lever over a card's place in its column. */
  priority: number
  /** Epoch SECONDS, as everything on this router is. */
  createdAt: number | null
  latestSummary: string | null
  commentCount: number
}

export interface BoardColumnView {
  name: string
  /** Whether a card may be dropped here, so the UI never offers a refusal. */
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

/** The gateway has no kanban plugin mounted, so every route 404s. */
export class KanbanUnavailable extends Error {
  constructor() {
    super('This gateway has no Kanban plugin.')
    this.name = 'KanbanUnavailable'
  }
}

/**
 * A refusal the server explained.
 *
 * `_patch_status` answers 409 with a `detail` that NAMES the blocking parents —
 * "blocked by parent(s) not done — 'Title' (t_ab12cd34, status=todo)" — and 400
 * for a status verb it will not take. Both are worth showing verbatim: the app
 * cannot reconstruct which parent is in the way, and a generic "could not move
 * the card" would throw away the only sentence that says what to do.
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

/**
 * Reduce one wire task to the card the app draws.
 *
 * Exported for its own test. The row is much wider than this — upstream sends
 * `asdict(Task)` with thirty-odd fields plus three derived ones — and the app
 * types only what it reads, the way the desktop plugin does.
 */
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

/**
 * The query every board-scoped call carries.
 *
 * `?board=<slug>` on EVERY call, and never `POST /boards/{slug}/switch`. That
 * route exists but moves the server's own current-board pointer, which is
 * shared with the CLI and the desktop — upstream says dashboard users pick
 * boards client-side for exactly this reason. A phone that switched the pointer
 * would move the board out from under somebody else's terminal.
 */
export const boardQuery = (slug: string, extra: Record<string, string> = {}): string => {
  const params = new URLSearchParams(extra)

  if (slug) {
    params.set('board', slug)
  }

  const query = params.toString()

  return query ? `?${query}` : ''
}

/** How long a write waits before nudging the dispatcher, matching the desktop's debounce. */
export const NUDGE_DELAY_MS = 400

export class KanbanController {
  constructor(
    private readonly http: KanbanHttp,
    private readonly options: { onNudge?: (slug: string) => void } = {}
  ) {}

  /** Every board on disk, newest-irrelevant: upstream returns them in its own order. */
  async boards(): Promise<BoardSummary[]> {
    const body = await this.call<{ boards?: Record<string, unknown>[] }>(() => this.http.get(`${KANBAN_BASE}/boards`))

    return (body?.boards ?? []).map(row => ({
      slug: String(row.slug ?? ''),
      // `name` is nullable on the wire and the slug is always there, so a board
      // with no display name is drawn under the handle rather than blank.
      name: str(row.name) ?? String(row.slug ?? ''),
      description: str(row.description),
      isCurrent: row.is_current === true,
      total: num(row.total) ?? 0
    }))
  }

  /**
   * One board's columns and cards.
   *
   * The columns come back in the server's order and the app keeps it. It does
   * NOT reorder them or invent one: the order is `BOARD_COLUMNS`, a card's
   * column is its status, and a status upstream grows later should appear
   * rather than be dropped by a client that thought it knew the list.
   */
  async board(slug: string, options: { includeArchived?: boolean } = {}): Promise<BoardView> {
    const query = boardQuery(slug, options.includeArchived ? { include_archived: 'true' } : {})
    const body = await this.call<{ columns?: Record<string, unknown>[]; assignees?: unknown }>(() =>
      this.http.get(`${KANBAN_BASE}/board${query}`)
    )

    return {
      assignees: Array.isArray(body?.assignees) ? body.assignees.map(String) : [],
      columns: (body?.columns ?? []).map(column => {
        const name = String(column.name ?? '')

        return {
          name,
          droppable: canDropInto(name),
          cards: (Array.isArray(column.tasks) ? (column.tasks as Record<string, unknown>[]) : []).map(describeCard)
        }
      })
    }
  }

  /** One card with its comments. Comments are only ever read through the task. */
  async card(slug: string, id: string): Promise<CardDetail> {
    const body = await this.call<{ task?: Record<string, unknown>; comments?: Record<string, unknown>[] }>(() =>
      this.http.get(`${KANBAN_BASE}/tasks/${encodeURIComponent(id)}${boardQuery(slug)}`)
    )

    return {
      card: describeCard(body?.task ?? {}),
      comments: (body?.comments ?? []).map(row => ({
        id: String(row.id ?? ''),
        author: str(row.author) ?? '',
        body: str(row.body) ?? '',
        createdAt: num(row.created_at)
      }))
    }
  }

  /**
   * Move a card to another column.
   *
   * The wire form is `PATCH /tasks/{id}` with `{status}` and nothing else —
   * there is no position to send, because there is no order to change.
   *
   * The returned status is the APPLIED one, which is not always the requested
   * one. `_set_status_direct` consults `_retry_status_for_run` when a card
   * leaves `running`, so a card dragged to `ready` can legitimately land in
   * `review` or `todo`. A client that assumed its request won would draw the
   * card in the wrong column until the next refresh.
   */
  async move(slug: string, id: string, status: string): Promise<{ applied: string }> {
    const task = await this.patch(slug, id, { status })

    return { applied: str(task.status) ?? status }
  }

  /**
   * Make a card, in the column the reader picked.
   *
   * Two calls where the column is not the one the server derives, because
   * `CreateTaskBody` has NO `status` field: `triage: true` lands in `triage`
   * and everything else in `ready`. The desktop does exactly this. The second
   * call is skipped when the derived column is already the wanted one, so the
   * common cases cost one round trip.
   */
  async create(
    slug: string,
    input: { title: string; body?: string | null; assignee?: string | null; priority?: number; column?: string }
  ): Promise<Card> {
    const wanted = input.column ?? 'ready'
    const body = await this.call<{ task?: Record<string, unknown> }>(() =>
      this.http.post(`${KANBAN_BASE}/tasks${boardQuery(slug)}`, {
        title: input.title,
        ...(input.body ? { body: input.body } : {}),
        ...(input.assignee ? { assignee: input.assignee } : {}),
        ...(input.priority === undefined ? {} : { priority: input.priority }),
        // The only lever create has over the landing column.
        ...(wanted === 'triage' ? { triage: true } : {})
      })
    )

    const made = describeCard(body?.task ?? {})

    this.nudge(slug)

    if (!made.id || made.status === wanted) {
      return made
    }

    return describeCard(await this.patch(slug, made.id, { status: wanted }))
  }

  /** Edit a card's own fields. Never its status — {@link move} owns that. */
  async edit(
    slug: string,
    id: string,
    patch: { title?: string; body?: string | null; assignee?: string | null; priority?: number }
  ): Promise<Card> {
    return describeCard(await this.patch(slug, id, patch))
  }

  /**
   * Archive a card.
   *
   * `status: 'archived'` and NOT `DELETE /tasks/{id}`. Upstream routes the
   * archived status past the verb table to `archive_task`, which is
   * recoverable; the delete route removes the row and its history for good. The
   * brief asked for archive, and these are not the same act.
   */
  async archive(slug: string, id: string): Promise<void> {
    await this.patch(slug, id, { status: 'archived' })
  }

  /**
   * Add a comment.
   *
   * The route answers `{ok: true}` and NOT the comment it made, so the caller
   * has to re-read the task to see it. `author` is sent explicitly: the server
   * defaults it to `"dashboard"`, which would label a phone's comment as the
   * web dashboard's.
   */
  async comment(slug: string, id: string, body: string): Promise<void> {
    await this.call(() =>
      this.http.post(`${KANBAN_BASE}/tasks/${encodeURIComponent(id)}/comments${boardQuery(slug)}`, {
        author: 'hermie',
        body
      })
    )
  }

  /**
   * One PATCH, with the refusals kept intact.
   *
   * Every write goes through here so that the dispatcher nudge and the 409's
   * sentence are handled in one place rather than at each call site.
   */
  private async patch(slug: string, id: string, patch: Record<string, unknown>): Promise<Record<string, unknown>> {
    const body = await this.call<{ task?: Record<string, unknown> }>(() =>
      this.http.patch(`${KANBAN_BASE}/tasks/${encodeURIComponent(id)}${boardQuery(slug)}`, patch)
    )

    this.nudge(slug)

    return body?.task ?? {}
  }

  /**
   * Ask the dispatcher to look now rather than on its next tick.
   *
   * Upstream's dispatcher runs on a 60-second timer, so a card made on a phone
   * would sit idle for up to a minute without this. It is fire-and-forget and
   * debounced by the caller: the tick is lock-guarded and ~1ms when there is
   * nothing to do, so over-nudging is free and a failed nudge is a non-event.
   */
  private nudge(slug: string): void {
    this.options.onNudge?.(slug)
  }

  /** Run one call, translating the two refusals this router has into types. */
  private async call<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run()
    } catch (cause) {
      const status = (cause as { status?: unknown } | null | undefined)?.status

      if (status === 404 && refusalDetail(cause) === null) {
        /*
          A 404 from this prefix means the plugin is not MOUNTED — the router
          does not exist, which `web_server_dashboard.py` arranges for a plugin
          that is absent or disabled. A 404 carrying a `detail` is the router
          itself answering about one missing task, which is an ordinary failure
          and must not be reported as "this gateway has no Kanban".
        */
        throw new KanbanUnavailable()
      }

      if (status === 409 || status === 400) {
        throw new KanbanRefused(refusalText(cause), status)
      }

      throw cause
    }
  }
}

/**
 * The `detail` FastAPI put in the error body, if there was one.
 *
 * It reaches here as `hint` on the thrown `GatewayError`: the HTTP client
 * parses a JSON error body's `detail` onto that field, because the
 * classification alone ("HTTP 409") is not something a reader can act on.
 */
const refusalDetail = (cause: unknown): string | null => {
  const hint = (cause as { hint?: unknown } | null | undefined)?.hint

  return typeof hint === 'string' && hint.trim() ? hint : null
}

/**
 * The sentence the server sent, or a last resort.
 *
 * `_patch_status` puts the whole actionable message in `detail` — "Cannot move
 * to 'ready': blocked by parent(s) not done — 'Title' (t_ab12cd34,
 * status=todo)" — and the app shows it verbatim, because nothing on this side
 * can reconstruct which parent is in the way.
 */
const refusalText = (cause: unknown): string =>
  refusalDetail(cause) ?? (cause instanceof Error && cause.message ? cause.message : 'The board refused that change.')

/** Nudge the dispatcher at most once per burst, the way the desktop's `autoNudge` does. */
export const debounceNudge = (
  run: (slug: string) => void,
  delay = NUDGE_DELAY_MS
): ((slug: string) => void) & { cancel: () => void } => {
  let timer: ReturnType<typeof setTimeout> | null = null

  const nudge = (slug: string): void => {
    if (timer) {
      clearTimeout(timer)
    }

    timer = setTimeout(() => {
      timer = null
      run(slug)
    }, delay)
  }

  nudge.cancel = (): void => {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
  }

  return nudge
}
