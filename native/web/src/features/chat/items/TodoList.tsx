/**
 * The bot's task list (`todo.updated`, and the snapshot a tool result or a
 * resume carries): one strip over the composer, folded to a line by default.
 *
 * Not a row of the transcript. The list is the session's, not a moment's: each
 * snapshot replaces the last (the engine keeps the newest, `ChatState.todo`), and
 * a row would either repeat the whole list at every change or sit where it was
 * written and scroll away while the work goes on. So it lives with the other
 * things about "now" (the queued messages), above the field.
 *
 * **Folded**, the strip says how far the list is and which task is in progress;
 * **open**, every task with its mark, a subtask indented under its parent. The
 * reader's choice holds for as long as the chat is open. A list that is all done
 * goes away once the turn is over: it is a record of the work by then, and the
 * transcript is where the work's record is.
 *
 * Every task's words are the model's: cleaned and bounded like a request's
 * strings (`displayText`), plain text, never Markdown. A task the gateway sent
 * in a shape it does not document is read as far as it can be and never fails
 * the strip: an unknown status is "to do", no words is no row.
 */
import type { TodoSnapshot } from '@hermie/transcript'
import { type ReactElement, useId, useMemo, useState } from 'react'

import { displayText, TEXT_LIMIT } from '../../../core/requests/secure-input'
import { useLocale } from '../../../i18n/use-locale'
import { sheetStrings } from '../../../i18n/sheet-strings'
import { Icon } from '../../../ui/icons'

export type TodoStatus = 'pending' | 'in_progress' | 'completed' | 'cancelled'

export interface TodoEntry {
  /** Unique in the list: the task's id where it has one, its place where it does not. */
  key: string
  content: string
  status: TodoStatus
  /** How deep under its parents, 0 for a top-level task; at most `MAX_DEPTH`. */
  depth: number
}

/** The gateway's own cap on a list (`tools/todo_tool.py`, `MAX_TODO_ITEMS`). */
export const MAX_TODO_ENTRIES = 256

/** How far a subtask is indented; deeper ones stay at this depth. */
const MAX_DEPTH = 3

const STATUSES: readonly TodoStatus[] = ['pending', 'in_progress', 'completed', 'cancelled']

/** The mark beside a task: decoration, its meaning is said in words beside it. */
const MARKS: Readonly<Record<TodoStatus, string>> = {
  pending: '○',
  in_progress: '◐',
  completed: '✓',
  cancelled: '✕'
}

const record = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {}

const idOf = (value: unknown): string =>
  typeof value === 'string' ? value.trim() : typeof value === 'number' ? String(value) : ''

/** The tasks of a snapshot, in its order, as the strip draws them. */
export function todoEntries(todos: readonly unknown[]): TodoEntry[] {
  const raw = todos.slice(0, MAX_TODO_ENTRIES).map(record)
  const parentOf = new Map<string, string>()

  for (const task of raw) {
    const id = idOf(task.id)
    const parent = idOf(task.parent)

    if (id && parent && parent !== id) {
      parentOf.set(id, parent)
    }
  }

  const depthOf = (id: string): number => {
    const seen = new Set<string>([id])
    let depth = 0
    let node = parentOf.get(id)

    // A parent that is not in the list, or a loop, ends the walk where it is.
    while (node !== undefined && !seen.has(node) && depth < MAX_DEPTH) {
      seen.add(node)
      depth += 1
      node = parentOf.get(node)
    }

    return depth
  }

  const used = new Set<string>()
  const entries: TodoEntry[] = []

  raw.forEach((task, index) => {
    const content = displayText(task.content, TEXT_LIMIT)

    if (!content) {
      return
    }

    const id = idOf(task.id)
    const status = typeof task.status === 'string' ? task.status.trim().toLowerCase() : ''
    const key = id && !used.has(id) ? id : `#${index}`

    used.add(key)
    entries.push({
      key,
      content,
      status: (STATUSES as readonly string[]).includes(status) ? (status as TodoStatus) : 'pending',
      depth: id ? depthOf(id) : 0
    })
  })

  return entries
}

const finished = (status: TodoStatus): boolean => status === 'completed' || status === 'cancelled'

export interface TodoListProps {
  /** The chat's newest snapshot; nothing is drawn without one. */
  todo: TodoSnapshot | undefined
  /** The turn runs: a list that is all done stays until it ends. */
  turnActive: boolean
}

export function TodoList({ todo, turnActive }: TodoListProps): ReactElement | null {
  useLocale()

  const [open, setOpen] = useState(false)
  const listId = useId()
  const entries = useMemo(() => (todo ? todoEntries(todo.todos) : []), [todo])

  if (entries.length === 0 || (!turnActive && entries.every(entry => finished(entry.status)))) {
    return null
  }

  const counted = entries.filter(entry => entry.status !== 'cancelled')
  const done = counted.filter(entry => entry.status === 'completed').length
  const current = entries.find(entry => entry.status === 'in_progress')
  const title = sheetStrings.chat.todoTitle

  return (
    <section className="hm-todo" aria-label={title} data-open={open ? 'true' : 'false'}>
      <button
        className="hm-todo__head"
        type="button"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        onClick={() => setOpen(!open)}
      >
        <span className="hm-todo__title">{title}</span>
        <span className="hm-todo__progress">{sheetStrings.chat.todoProgress({ done, total: counted.length })}</span>
        {!open && current ? <span className="hm-todo__current">{current.content}</span> : null}
        <Icon name={open ? 'chevronDown' : 'chevronRight'} size={16} />
      </button>

      {open ? (
        <ol className="hm-todo__list" id={listId}>
          {entries.map(entry => (
            <li className="hm-todo__task" key={entry.key} data-status={entry.status} data-depth={entry.depth}>
              <span className="hm-todo__mark" aria-hidden="true">
                {MARKS[entry.status]}
              </span>
              <span className="hm-sr">{sheetStrings.chat.todoStatus[entry.status]}: </span>
              <span className="hm-todo__text">{entry.content}</span>
            </li>
          ))}
        </ol>
      ) : null}
    </section>
  )
}
