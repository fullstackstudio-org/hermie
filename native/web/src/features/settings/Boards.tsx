/**
 * Settings › Boards: the Kanban boards the gateway keeps, one board's columns and cards, and one card
 * (`core/manage/kanban.ts`).
 *
 * Kanban is a plugin with a router of its own, so a gateway without it gets what to install, not an empty board.
 * The columns are the server's, in its order; a card's column is its status. Moving a card is a menu on the card
 * (a control that works with a keyboard and a screen reader, and one that can refuse well: the three columns the
 * dispatcher owns are simply not listed), and the board's own sentence is shown when it refuses one anyway (a card
 * whose parents are not done names them). The page says once why cards cannot be dragged within a column: they are
 * ordered by priority and age, and there is no order to save.
 *
 * A card opens in place: its fields are edited with a draft that is saved or put back, a comment is posted under
 * its name, and archiving asks first (it keeps the card and its history; it is not a delete).
 *
 * Everything on a board is its people's text and is drawn as characters.
 */
import { type ReactElement, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'

import {
  type BoardSummary,
  type BoardView,
  canDropInto,
  type Card,
  type CardDetail,
  createKanbanClient,
  type KanbanClient,
  KanbanRefused,
  KanbanUnavailable
} from '../../core/manage/kanban'
import { routeErrorOf } from '../../core/manage/route-error'
import type { ManageTransport } from '../../core/manage/transport'
import { displayText } from '../../core/requests/secure-input'
import { strings } from '../../generated/strings'
import { formatDateTime } from '../../i18n/format'
import { manageStrings } from '../../i18n/manage-strings'
import { useLocale } from '../../i18n/use-locale'
import { Button } from '../../ui/primitives'
import { Checkbox, SettingsPage } from './controls'
import { ConfirmAction, type Outcome, ProblemLine, StatusLine } from './manage-parts'
import { useManageTransport } from './manage-runtime'

const words = manageStrings.boardsPage

/** The column's name in words; a status the server grows later is shown as it is. */
const columnLabel = (name: string): string => (strings.kanban.columns as Record<string, string>)[name] ?? name

/** What a failed call says: the board's own sentence for a refusal. */
const sentence = (failure: unknown): string =>
  failure instanceof KanbanRefused ? failure.detail : routeErrorOf(failure).message

export function Boards(): ReactElement {
  useLocale()

  const transport = useManageTransport()

  return (
    <SettingsPage title={strings.kanban.title} lead={strings.kanban.subtitle}>
      {transport ? (
        <BoardsBody http={transport.http} />
      ) : (
        <p className="hm-manage__text">{manageStrings.manageCommon.noGateway}</p>
      )}
    </SettingsPage>
  )
}

function BoardsBody({ http }: { http: ManageTransport['http'] }): ReactElement {
  const client = useMemo(() => createKanbanClient(http), [http])
  const [boards, setBoards] = useState<BoardSummary[] | null>(null)
  const [absent, setAbsent] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const [picked, setPicked] = useState('')
  const [archived, setArchived] = useState(false)
  const [view, setView] = useState<BoardView | null>(null)
  const [outcome, setOutcome] = useState<Outcome | null>(null)
  const [openId, setOpenId] = useState<string | null>(null)
  const boardReads = useRef(0)
  const listReads = useRef(0)
  const pickerId = useId()

  const slug = boards?.some(board => board.slug === picked) ? picked : (boards?.[0]?.slug ?? '')

  useEffect(() => () => client.dispose(), [client])

  const loadBoards = useCallback(async (): Promise<void> => {
    const mine = ++listReads.current

    try {
      const next = await client.boards()

      if (mine === listReads.current) {
        setBoards(next)
        setProblem(null)
      }
    } catch (failure) {
      if (mine !== listReads.current) {
        return
      }

      if (failure instanceof KanbanUnavailable) {
        setAbsent(true)
      } else {
        setProblem(strings.kanban.failed({ reason: sentence(failure) }))
      }
    }
  }, [client])

  const loadBoard = useCallback(async (): Promise<void> => {
    if (!slug) {
      return
    }

    const mine = ++boardReads.current

    try {
      const next = await client.board(slug, { includeArchived: archived })

      if (mine === boardReads.current) {
        setView(next)
        setProblem(null)
      }
    } catch (failure) {
      if (mine === boardReads.current) {
        setProblem(strings.kanban.failed({ reason: sentence(failure) }))
      }
    }
  }, [client, slug, archived])

  useEffect(() => {
    void loadBoards()

    return () => {
      listReads.current += 1
    }
  }, [loadBoards])

  useEffect(() => {
    setView(null)
    void loadBoard()

    return () => {
      boardReads.current += 1
    }
  }, [loadBoard])

  /** After a change the board and the counts in the picker are read again. */
  const refresh = useCallback(async (): Promise<void> => {
    await Promise.all([loadBoard(), loadBoards()])
  }, [loadBoard, loadBoards])

  if (absent) {
    return (
      <div className="hm-manage__form">
        <p className="hm-manage__confirm-question">{strings.kanban.absent}</p>
        <p className="hm-manage__hint">{strings.kanban.absentHint}</p>
        <code className="hm-manage__code">{strings.kanban.absentCommand}</code>
      </div>
    )
  }

  if (!boards) {
    return problem ? (
      <ProblemLine text={problem} retryLabel={strings.memory.retry} onRetry={() => void loadBoards()} />
    ) : (
      <p className="hm-manage__text">{strings.kanban.loading}</p>
    )
  }

  if (boards.length === 0) {
    return (
      <>
        <p className="hm-manage__text">{strings.kanban.empty}</p>
        <p className="hm-manage__hint">{strings.kanban.emptyHint}</p>
      </>
    )
  }

  const droppable = (view?.columns ?? []).filter(column => column.droppable).map(column => column.name)

  return (
    <>
      <div className="hm-manage__field">
        <label className="hm-manage__label" htmlFor={pickerId}>
          {words.board}
        </label>
        <select
          id={pickerId}
          className="hm-manage__select"
          value={slug}
          onChange={event => {
            setPicked(event.currentTarget.value)
            setOpenId(null)
            setOutcome(null)
          }}
        >
          {boards.map(board => (
            <option key={board.slug} value={board.slug}>
              {`${displayText(board.name, 64)} - ${strings.kanban.boardCards({ count: board.total })}`}
            </option>
          ))}
        </select>
        {boards.find(board => board.slug === slug)?.description ? (
          <p className="hm-manage__hint">{displayText(boards.find(board => board.slug === slug)?.description, 200)}</p>
        ) : null}
      </div>

      <Checkbox label={strings.kanban.board.showArchived} checked={archived} onChange={setArchived} />

      <StatusLine outcome={outcome} />
      {problem ? <ProblemLine text={problem} retryLabel={strings.memory.retry} onRetry={() => void refresh()} /> : null}

      <NewCard
        client={client}
        slug={slug}
        columns={droppable}
        assignees={view?.assignees ?? []}
        onDone={async title => {
          setOutcome({ tone: 'ok', text: words.created({ title: displayText(title, 80) }) })
          await refresh()
        }}
      />

      {!view && !problem ? <p className="hm-manage__text">{strings.kanban.board.loading}</p> : null}

      {view ? (
        <>
          <p className="hm-manage__hint">{strings.kanban.locked}</p>
          <p className="hm-manage__hint">{strings.kanban.noOrder}</p>
          {view.columns.every(column => column.cards.length === 0) ? (
            <p className="hm-manage__text">{strings.kanban.board.empty}</p>
          ) : null}
          <div className="hm-manage__columns">
            {view.columns.map(column => (
              <section key={column.name} aria-labelledby={`${pickerId}-col-${column.name}`}>
                <h3 className="hm-manage__heading" id={`${pickerId}-col-${column.name}`}>
                  {words.columnHeading({ name: columnLabel(column.name), count: column.cards.length })}
                </h3>
                {column.cards.length === 0 ? (
                  <p className="hm-manage__hint">{strings.kanban.board.columnEmpty}</p>
                ) : (
                  <ul className="hm-manage__cards" aria-label={columnLabel(column.name)}>
                    {column.cards.map(card => (
                      <CardItem
                        key={card.id}
                        card={card}
                        client={client}
                        slug={slug}
                        columns={droppable}
                        assignees={view.assignees}
                        open={openId === card.id}
                        onToggle={() => setOpenId(openId === card.id ? null : card.id)}
                        onOutcome={setOutcome}
                        onChanged={refresh}
                      />
                    ))}
                  </ul>
                )}
              </section>
            ))}
          </div>
        </>
      ) : null}
    </>
  )
}

function CardItem({
  card,
  client,
  slug,
  columns,
  assignees,
  open,
  onToggle,
  onOutcome,
  onChanged
}: {
  card: Card
  client: KanbanClient
  slug: string
  columns: readonly string[]
  assignees: readonly string[]
  open: boolean
  onToggle: () => void
  onOutcome: (outcome: Outcome) => void
  onChanged: () => Promise<void>
}): ReactElement {
  const title = displayText(card.title, 120) || card.id

  const move = async (column: string): Promise<void> => {
    if (!column || !canDropInto(column)) {
      return
    }

    try {
      const { applied } = await client.move(slug, card.id, column)

      onOutcome(
        applied === column
          ? { tone: 'ok', text: strings.kanban.moved({ column: columnLabel(column) }) }
          : {
              tone: 'ok',
              text: strings.kanban.movedElsewhere({ asked: columnLabel(column), got: columnLabel(applied) })
            }
      )
      await onChanged()
    } catch (failure) {
      onOutcome({ tone: 'danger', text: strings.kanban.moveRefused({ reason: sentence(failure) }) })
    }
  }

  return (
    <li className="hm-manage__card" data-card={card.id}>
      <div className="hm-manage__item-head">
        <span className="hm-manage__card-title" dir="auto">
          {title}
        </span>
        <span className="hm-manage__meta">
          {words.cardMeta({ assignee: displayText(card.assignee ?? '', 64), priority: card.priority })}
        </span>
      </div>
      {card.latestSummary ? <p className="hm-manage__meta">{displayText(card.latestSummary, 200)}</p> : null}

      <div className="hm-manage__actions">
        <Button
          variant="quiet"
          aria-expanded={open}
          aria-label={open ? words.closeCard({ title }) : words.openCard({ title })}
          onClick={onToggle}
        >
          {open ? words.close : words.open}
        </Button>
        <select
          className="hm-manage__select"
          aria-label={words.moveCard({ title })}
          value=""
          onChange={event => void move(event.currentTarget.value)}
        >
          <option value="">{strings.kanban.move}</option>
          {columns
            .filter(column => column !== card.status)
            .map(column => (
              <option key={column} value={column}>
                {columnLabel(column)}
              </option>
            ))}
        </select>
      </div>

      {open ? (
        <CardPanel
          card={card}
          title={title}
          client={client}
          slug={slug}
          assignees={assignees}
          onOutcome={onOutcome}
          onChanged={onChanged}
        />
      ) : null}
    </li>
  )
}

function CardPanel({
  card,
  title,
  client,
  slug,
  assignees,
  onOutcome,
  onChanged
}: {
  card: Card
  title: string
  client: KanbanClient
  slug: string
  assignees: readonly string[]
  onOutcome: (outcome: Outcome) => void
  onChanged: () => Promise<void>
}): ReactElement {
  const id = useId()
  const [detail, setDetail] = useState<CardDetail | null>(null)
  const [gone, setGone] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const [draft, setDraft] = useState({
    title: card.title,
    body: card.body ?? '',
    assignee: card.assignee ?? '',
    priority: String(card.priority)
  })
  const [saving, setSaving] = useState(false)
  const [comment, setComment] = useState('')
  const [posting, setPosting] = useState(false)
  const [formProblem, setFormProblem] = useState<string | null>(null)
  const reads = useRef(0)

  const load = useCallback(async (): Promise<void> => {
    const mine = ++reads.current

    try {
      const next = await client.card(slug, card.id)

      if (mine === reads.current) {
        setDetail(next)
        setProblem(null)
      }
    } catch (failure) {
      if (mine === reads.current) {
        if (failure instanceof KanbanUnavailable) {
          setGone(true)
        } else {
          setProblem(sentence(failure))
        }
      }
    }
  }, [client, slug, card.id])

  useEffect(() => {
    void load()

    return () => {
      reads.current += 1
    }
  }, [load])

  const current = detail?.card ?? card
  const priority = Number(draft.priority)
  const priorityOk = draft.priority.trim() !== '' && Number.isInteger(priority)
  const unchanged =
    draft.title === current.title &&
    draft.body === (current.body ?? '') &&
    draft.assignee === (current.assignee ?? '') &&
    priority === current.priority

  const save = async (): Promise<void> => {
    if (!draft.title.trim()) {
      setFormProblem(strings.kanban.create.needsTitle)

      return
    }

    if (!priorityOk) {
      setFormProblem(words.priorityInvalid)

      return
    }

    setSaving(true)
    setFormProblem(null)

    try {
      await client.edit(slug, card.id, {
        title: draft.title.trim(),
        body: draft.body.trim() ? draft.body : null,
        assignee: draft.assignee.trim() ? draft.assignee.trim() : null,
        priority
      })
      onOutcome({ tone: 'ok', text: strings.kanban.card.saved })
      await Promise.all([load(), onChanged()])
    } catch (failure) {
      setFormProblem(words.saveFailed({ message: sentence(failure) }))
    } finally {
      setSaving(false)
    }
  }

  const post = async (): Promise<void> => {
    if (!comment.trim()) {
      return
    }

    setPosting(true)

    try {
      await client.comment(slug, card.id, comment.trim())
      setComment('')
      await Promise.all([load(), onChanged()])
    } catch (failure) {
      onOutcome({ tone: 'danger', text: words.commentFailed({ message: sentence(failure) }) })
    } finally {
      setPosting(false)
    }
  }

  const archive = async (): Promise<void> => {
    try {
      await client.archive(slug, card.id)
      onOutcome({ tone: 'ok', text: strings.kanban.card.archived })
      await onChanged()
    } catch (failure) {
      onOutcome({ tone: 'danger', text: words.archiveFailed({ message: sentence(failure) }) })
    }
  }

  if (gone) {
    return <p className="hm-manage__text">{words.cardGone}</p>
  }

  return (
    <div className="hm-manage__form" role="group" aria-label={title}>
      {problem ? <ProblemLine text={problem} onRetry={() => void load()} /> : null}

      <div className="hm-manage__field">
        <label className="hm-manage__label" htmlFor={`${id}-title`}>
          {strings.kanban.card.title}
        </label>
        <input
          id={`${id}-title`}
          className="hm-manage__input"
          value={draft.title}
          onChange={event => setDraft({ ...draft, title: event.currentTarget.value })}
        />
      </div>
      <div className="hm-manage__field">
        <label className="hm-manage__label" htmlFor={`${id}-body`}>
          {strings.kanban.card.body}
        </label>
        <textarea
          id={`${id}-body`}
          className="hm-manage__textarea"
          value={draft.body}
          onChange={event => setDraft({ ...draft, body: event.currentTarget.value })}
        />
      </div>
      <div className="hm-manage__row">
        <div className="hm-manage__field">
          <label className="hm-manage__label" htmlFor={`${id}-assignee`}>
            {strings.kanban.card.assignee}
          </label>
          <input
            id={`${id}-assignee`}
            className="hm-manage__input"
            list={`${id}-people`}
            autoComplete="off"
            value={draft.assignee}
            onChange={event => setDraft({ ...draft, assignee: event.currentTarget.value })}
          />
          <datalist id={`${id}-people`}>
            {assignees.map(person => (
              <option key={person} value={person} />
            ))}
          </datalist>
        </div>
        <div className="hm-manage__field">
          <label className="hm-manage__label" htmlFor={`${id}-priority`}>
            {strings.kanban.card.priority}
          </label>
          <input
            id={`${id}-priority`}
            className="hm-manage__input"
            type="number"
            step={1}
            inputMode="numeric"
            aria-describedby={`${id}-priority-hint`}
            value={draft.priority}
            onChange={event => setDraft({ ...draft, priority: event.currentTarget.value })}
          />
          <p className="hm-manage__hint" id={`${id}-priority-hint`}>
            {words.priorityHint}
          </p>
        </div>
      </div>
      {formProblem ? (
        <p className="hm-manage__problem-text" role="alert">
          {formProblem}
        </p>
      ) : null}
      <div className="hm-manage__actions">
        <Button disabled={saving || unchanged} onClick={() => void save()}>
          {saving ? strings.kanban.card.saving : strings.kanban.card.save}
        </Button>
        <Button
          variant="quiet"
          disabled={unchanged}
          onClick={() => {
            setFormProblem(null)
            setDraft({
              title: current.title,
              body: current.body ?? '',
              assignee: current.assignee ?? '',
              priority: String(current.priority)
            })
          }}
        >
          {strings.memory.edit.cancel}
        </Button>
      </div>

      {current.createdAt !== null ? (
        <p className="hm-manage__meta">
          {strings.kanban.card.created}: {formatDateTime(current.createdAt * 1000)}
        </p>
      ) : null}

      <h4 className="hm-manage__name">{strings.kanban.comments.header}</h4>
      {!detail ? null : detail.comments.length === 0 ? (
        <p className="hm-manage__hint">{strings.kanban.comments.none}</p>
      ) : (
        <ul className="hm-manage__list" aria-label={strings.kanban.comments.header}>
          {detail.comments.map(entry => (
            <li key={entry.id} className="hm-manage__item">
              <p className="hm-manage__body" dir="auto">
                {entry.body}
              </p>
              <span className="hm-manage__meta">
                {words.commentBy({
                  author: displayText(entry.author, 64),
                  date: entry.createdAt === null ? '' : formatDateTime(entry.createdAt * 1000)
                })}
              </span>
            </li>
          ))}
        </ul>
      )}
      <div className="hm-manage__field">
        <label className="hm-manage__label" htmlFor={`${id}-comment`}>
          {words.commentLabel({ title })}
        </label>
        <textarea
          id={`${id}-comment`}
          className="hm-manage__textarea"
          placeholder={strings.kanban.comments.placeholder}
          value={comment}
          onChange={event => setComment(event.currentTarget.value)}
        />
      </div>
      <div className="hm-manage__actions">
        <Button variant="quiet" disabled={posting || !comment.trim()} onClick={() => void post()}>
          {posting ? strings.kanban.comments.adding : strings.kanban.comments.add}
        </Button>
        <ConfirmAction
          label={strings.kanban.card.archive}
          accessibleName={words.archiveName({ title })}
          question={words.archiveQuestion({ title })}
          detail={strings.kanban.card.archiveHint}
          confirmLabel={strings.kanban.card.archive}
          cancelLabel={strings.memory.remove.cancel}
          onConfirm={() => void archive()}
        />
      </div>
    </div>
  )
}

function NewCard({
  client,
  slug,
  columns,
  assignees,
  onDone
}: {
  client: KanbanClient
  slug: string
  columns: readonly string[]
  assignees: readonly string[]
  onDone: (title: string) => Promise<void>
}): ReactElement {
  const id = useId()
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [assignee, setAssignee] = useState('')
  const [priority, setPriority] = useState('0')
  const [column, setColumn] = useState('ready')
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const chosen = columns.includes(column) ? column : (columns[0] ?? 'ready')

  const submit = async (): Promise<void> => {
    if (!title.trim()) {
      setProblem(strings.kanban.create.needsTitle)

      return
    }

    if (priority.trim() === '' || !Number.isInteger(Number(priority))) {
      setProblem(words.priorityInvalid)

      return
    }

    setBusy(true)
    setProblem(null)

    try {
      const made = await client.create(slug, {
        title: title.trim(),
        body: body.trim() ? body : null,
        assignee: assignee.trim() ? assignee.trim() : null,
        priority: Number(priority),
        column: chosen
      })

      setTitle('')
      setBody('')
      setAssignee('')
      setPriority('0')
      await onDone(made.title || title.trim())
    } catch (failure) {
      setProblem(words.createFailed({ message: sentence(failure) }))
    } finally {
      setBusy(false)
    }
  }

  return (
    <details className="hm-manage__disclosure">
      <summary className="hm-manage__summary">{strings.kanban.board.newCard}</summary>
      <form
        className="hm-manage__form"
        onSubmit={event => {
          event.preventDefault()
          void submit()
        }}
      >
        <div className="hm-manage__field">
          <label className="hm-manage__label" htmlFor={`${id}-title`}>
            {strings.kanban.create.titleField}
          </label>
          <input
            id={`${id}-title`}
            className="hm-manage__input"
            autoComplete="off"
            placeholder={strings.kanban.create.titlePlaceholder}
            value={title}
            onChange={event => setTitle(event.currentTarget.value)}
          />
        </div>
        <div className="hm-manage__field">
          <label className="hm-manage__label" htmlFor={`${id}-body`}>
            {strings.kanban.create.bodyField}
          </label>
          <textarea
            id={`${id}-body`}
            className="hm-manage__textarea"
            value={body}
            onChange={event => setBody(event.currentTarget.value)}
          />
        </div>
        <div className="hm-manage__row">
          <div className="hm-manage__field">
            <label className="hm-manage__label" htmlFor={`${id}-column`}>
              {strings.kanban.card.column}
            </label>
            <select
              id={`${id}-column`}
              className="hm-manage__select"
              value={chosen}
              onChange={event => setColumn(event.currentTarget.value)}
            >
              {columns.map(name => (
                <option key={name} value={name}>
                  {columnLabel(name)}
                </option>
              ))}
            </select>
          </div>
          <div className="hm-manage__field">
            <label className="hm-manage__label" htmlFor={`${id}-assignee`}>
              {strings.kanban.card.assignee}
            </label>
            <input
              id={`${id}-assignee`}
              className="hm-manage__input"
              list={`${id}-people`}
              autoComplete="off"
              value={assignee}
              onChange={event => setAssignee(event.currentTarget.value)}
            />
            <datalist id={`${id}-people`}>
              {assignees.map(person => (
                <option key={person} value={person} />
              ))}
            </datalist>
          </div>
          <div className="hm-manage__field">
            <label className="hm-manage__label" htmlFor={`${id}-priority`}>
              {strings.kanban.card.priority}
            </label>
            <input
              id={`${id}-priority`}
              className="hm-manage__input"
              type="number"
              step={1}
              inputMode="numeric"
              value={priority}
              onChange={event => setPriority(event.currentTarget.value)}
            />
          </div>
        </div>
        {problem ? (
          <p className="hm-manage__problem-text" role="alert">
            {problem}
          </p>
        ) : null}
        <div className="hm-manage__actions">
          <Button type="submit" disabled={busy}>
            {busy ? strings.kanban.create.submitting : strings.kanban.create.submit}
          </Button>
        </div>
      </form>
    </details>
  )
}
