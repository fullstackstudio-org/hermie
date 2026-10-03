/**
 * The bot's task list (`todo.updated`): how a snapshot is read, whatever shape a
 * task arrives in, and what the strip over the composer shows of it.
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'

import { resetActiveLocale } from '../../../i18n/active-locale'
import { setLanguageChoice } from '../../../i18n/locale'
import { MAX_TODO_ENTRIES, TodoList, todoEntries } from './TodoList'

const LIST = [
  { id: '1', content: 'Read the brief', status: 'completed' },
  { id: '2', content: 'Write the parser', status: 'in_progress' },
  { id: '2a', content: 'Handle the edge cases', status: 'pending', parent: '2' },
  { id: '3', content: 'Drop the old path', status: 'cancelled' },
  { id: '4', content: 'Ship it', status: 'pending' }
]

const head = (): HTMLElement => screen.getByRole('button', { name: /^Tasks/u })

beforeEach(() => resetActiveLocale())

describe('todoEntries', () => {
  it('reads every task in its order, with its status and how deep it is', () => {
    expect(todoEntries(LIST)).toEqual([
      { key: '1', content: 'Read the brief', status: 'completed', depth: 0 },
      { key: '2', content: 'Write the parser', status: 'in_progress', depth: 0 },
      { key: '2a', content: 'Handle the edge cases', status: 'pending', depth: 1 },
      { key: '3', content: 'Drop the old path', status: 'cancelled', depth: 0 },
      { key: '4', content: 'Ship it', status: 'pending', depth: 0 }
    ])
  })

  it('reads an unknown or missing status as to do, and a status in capitals as itself', () => {
    expect(
      todoEntries([
        { id: 'a', content: 'one', status: 'blocked' },
        { id: 'b', content: 'two' },
        { id: 'c', content: 'three', status: ' Completed ' }
      ]).map(entry => entry.status)
    ).toEqual(['pending', 'pending', 'completed'])
  })

  it('drops a task with no words and anything that is not a task', () => {
    expect(
      todoEntries([null, 'text', 7, ['x'], { id: 'a' }, { id: 'b', content: '   ' }, { id: 'c', content: 'kept' }])
    ).toEqual([{ key: 'c', content: 'kept', status: 'pending', depth: 0 }])
  })

  it('keeps every key unique: a repeated or missing id falls back to the task’s place', () => {
    expect(
      todoEntries([{ id: 'x', content: 'first' }, { id: 'x', content: 'second' }, { content: 'third' }]).map(
        entry => entry.key
      )
    ).toEqual(['x', '#1', '#2'])
  })

  it('stops at a parent that is not in the list, at a loop, and at three levels', () => {
    const entries = todoEntries([
      { id: 'orphan', content: 'orphan', parent: 'gone' },
      { id: 'a', content: 'a', parent: 'b' },
      { id: 'b', content: 'b', parent: 'a' },
      { id: 'l0', content: 'l0' },
      { id: 'l1', content: 'l1', parent: 'l0' },
      { id: 'l2', content: 'l2', parent: 'l1' },
      { id: 'l3', content: 'l3', parent: 'l2' },
      { id: 'l4', content: 'l4', parent: 'l3' },
      { id: 'self', content: 'self', parent: 'self' }
    ])

    expect(Object.fromEntries(entries.map(entry => [entry.key, entry.depth]))).toEqual({
      orphan: 1,
      a: 1,
      b: 1,
      l0: 0,
      l1: 1,
      l2: 2,
      l3: 3,
      l4: 3,
      self: 0
    })
  })

  it('cleans and bounds a task’s words like a request’s, and reads no more tasks than the gateway keeps', () => {
    const [entry] = todoEntries([{ id: 'a', content: `line‮ one\n\n\ntwo\u0007 ${'x'.repeat(2_000)}` }])

    expect(entry?.content.startsWith('line one\ntwo x')).toBe(true)
    expect(entry?.content.endsWith('…')).toBe(true)
    // `TEXT_LIMIT` characters and the ellipsis that says the rest was cut.
    expect([...(entry?.content ?? '')].length).toBe(601)

    const many = Array.from({ length: MAX_TODO_ENTRIES + 10 }, (_, index) => ({ id: `${index}`, content: `t${index}` }))

    expect(todoEntries(many)).toHaveLength(MAX_TODO_ENTRIES)
  })
})

describe('the strip', () => {
  it('draws nothing without a snapshot, or with an empty one', () => {
    const { container, rerender } = render(<TodoList todo={undefined} turnActive />)

    expect(container.innerHTML).toBe('')

    rerender(<TodoList todo={{ todos: [], revision: 3 }} turnActive />)
    expect(container.innerHTML).toBe('')
  })

  it('is folded at first: how far the list is, and the task in progress', () => {
    render(<TodoList todo={{ todos: LIST, revision: 4 }} turnActive />)

    expect(screen.getByRole('region', { name: 'Tasks' })).toBeTruthy()
    expect(head().getAttribute('aria-expanded')).toBe('false')
    // Cancelled tasks are not counted: one of the four that remain is done.
    expect(head().textContent).toContain('1 of 4 done')
    expect(head().textContent).toContain('Write the parser')
    expect(screen.queryByRole('list')).toBeNull()
  })

  it('opens to every task with its mark, said in words, and a subtask indented', () => {
    render(<TodoList todo={{ todos: LIST, revision: 4 }} turnActive />)

    fireEvent.click(head())

    const list = screen.getByRole('list')
    const tasks = screen.getAllByRole('listitem')

    expect(head().getAttribute('aria-expanded')).toBe('true')
    expect(head().getAttribute('aria-controls')).toBe(list.id)
    expect(tasks.map(task => task.textContent)).toEqual([
      '✓Done: Read the brief',
      '◐In progress: Write the parser',
      '○To do: Handle the edge cases',
      '✕Cancelled: Drop the old path',
      '○To do: Ship it'
    ])
    expect(tasks.map(task => task.getAttribute('data-depth'))).toEqual(['0', '0', '1', '0', '0'])
    expect(tasks[0]?.querySelector('[aria-hidden="true"]')?.textContent).toBe('✓')
    // Open, the line does not repeat the task in progress.
    expect(head().textContent).not.toContain('Write the parser')
  })

  it('keeps the reader’s choice across a new snapshot', () => {
    const { rerender } = render(<TodoList todo={{ todos: LIST, revision: 4 }} turnActive />)

    fireEvent.click(head())
    rerender(
      <TodoList
        todo={{ todos: [...LIST, { id: '5', content: 'Tell the team', status: 'pending' }], revision: 5 }}
        turnActive
      />
    )

    expect(screen.getAllByRole('listitem')).toHaveLength(6)
  })

  it('stays while the turn runs once everything is done, and goes when it ends', () => {
    const done = { todos: [{ id: '1', content: 'All of it', status: 'completed' }], revision: 9 }
    const { container, rerender } = render(<TodoList todo={done} turnActive />)

    expect(head().textContent).toContain('1 of 1 done')

    rerender(<TodoList todo={done} turnActive={false} />)
    expect(container.innerHTML).toBe('')
  })

  it('stays after the turn while something is left to do', () => {
    render(<TodoList todo={{ todos: LIST, revision: 4 }} turnActive={false} />)

    expect(head()).toBeTruthy()
  })

  it('shows a task’s words as characters, never as Markdown', () => {
    render(
      <TodoList
        todo={{
          todos: [{ id: '1', content: '**bold** [link](javascript:alert(1)) <b>x</b>', status: 'pending' }],
          revision: 1
        }}
        turnActive
      />
    )

    fireEvent.click(head())

    expect(screen.getByText('**bold** [link](javascript:alert(1)) <b>x</b>')).toBeTruthy()
    expect(document.querySelector('a, strong, b')).toBeNull()
  })

  it('says it in the reader’s language', async () => {
    await setLanguageChoice('nl')
    render(<TodoList todo={{ todos: LIST, revision: 4 }} turnActive />)

    fireEvent.click(screen.getByRole('button', { name: /^Taken/u }))

    expect(screen.getByRole('region', { name: 'Taken' })).toBeTruthy()
    expect(screen.getByText(/1 van 4 klaar/u)).toBeTruthy()
    expect(screen.getAllByRole('listitem')[1]?.textContent).toBe('◐Bezig: Write the parser')
  })
})
