/**
 * Settings › Boards against an in-memory Kanban plugin: a gateway without the plugin (what to install, not an
 * empty board), the boards and one board's columns in the server's order, a move through the menu that refuses the
 * dispatcher's columns and shows the board's own sentence when it still refuses, a card edited with a draft that
 * is saved or put back, a comment, archiving after a question, and a new card.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { resetActiveLocale } from '../../i18n/active-locale'
import { aKanbanPlugin, BASE } from '../../test-support/kanban-plugin'
import { aSettingsRuntime } from '../../test-support/settings-runtime'
import { resetShellStores } from '../../test-support/shell-stores'
import { Boards } from './Boards'
import { SettingsRuntimeContext } from './settings-runtime'

beforeEach(() => {
  resetShellStores()
  document.documentElement.lang = 'en'
})

afterEach(() => {
  cleanup()
  resetActiveLocale()
})

function mount(plugin = aKanbanPlugin()) {
  render(
    <SettingsRuntimeContext.Provider value={aSettingsRuntime({ manage: { transport: plugin.transport } })}>
      <Boards />
    </SettingsRuntimeContext.Provider>
  )

  return plugin
}

const card = (id: string) =>
  screen.findAllByRole('listitem').then(() => document.querySelector(`li[data-card="${id}"]`) as HTMLElement)
const column = (name: string) =>
  screen.getByRole('heading', { level: 3, name: new RegExp(`^${name} \\(`, 'u') }).closest('section') as HTMLElement
const writes = (plugin: ReturnType<typeof aKanbanPlugin>) => plugin.requests.filter(request => request.method !== 'GET')

describe('a gateway without the plugin', () => {
  it('says what to install, and shows no board', async () => {
    mount(aKanbanPlugin({ absent: true }))

    expect(await screen.findByText('This gateway has no Kanban plugin.')).toBeTruthy()
    expect(screen.getByText('hermes plugins install kanban')).toBeTruthy()
    expect(screen.queryByRole('combobox')).toBeNull()
  })

  it('says there are no boards when the plugin has none', async () => {
    mount(aKanbanPlugin({ boards: [] }))

    expect(await screen.findByText('This gateway has no boards yet.')).toBeTruthy()
  })
})

describe('the board', () => {
  it('lists the boards with their card counts, and the first board’s columns in the server’s order', async () => {
    mount()

    const picker = (await screen.findByRole('combobox', { name: 'Board' })) as HTMLSelectElement

    expect(
      within(picker)
        .getAllByRole('option')
        .map(option => option.textContent)
    ).toEqual(['Default - 3 cards', 'Sprint - 0 cards'])
    await card('t_aa')
    expect(screen.getAllByRole('heading', { level: 3 }).map(heading => heading.textContent)).toEqual([
      'Triage (0)',
      'To do (2)',
      'Scheduled (0)',
      'Ready (0)',
      'Running (1)',
      'Blocked (0)',
      'Review (0)',
      'Done (0)'
    ])
    expect(within(column('To do')).getByText('Write the release notes')).toBeTruthy()
    expect(within(column('To do')).getByText('writer · priority 2')).toBeTruthy()
  })

  it('orders a column by priority, which is the only order there is, and says so', async () => {
    mount()

    await card('t_aa')
    expect(
      within(column('To do'))
        .getAllByRole('listitem')
        .map(item => item.getAttribute('data-card'))
    ).toEqual(['t_cc', 't_aa'])
    expect(screen.getByText(/ordered by priority and age/u)).toBeTruthy()
    expect(screen.getByText(/Running, Review and Scheduled are the dispatcher’s/u)).toBeTruthy()
  })

  it('reads another board when it is picked, and shows archived cards only when asked', async () => {
    const plugin = mount(
      aKanbanPlugin({
        boards: [
          {
            slug: 'default',
            name: 'Default',
            tasks: [
              {
                id: 'a',
                title: 'Old news',
                body: null,
                status: 'archived',
                assignee: null,
                priority: 0,
                created_at: 1,
                parents: [],
                comments: []
              }
            ]
          },
          { slug: 'sprint', name: 'Sprint', tasks: [] }
        ]
      })
    )

    await screen.findByRole('combobox', { name: 'Board' })
    expect(await screen.findByText('Nothing on this board yet.')).toBeTruthy()
    expect(screen.queryByText('Old news')).toBeNull()

    fireEvent.click(screen.getByRole('checkbox', { name: 'Show archived' }))
    expect(await screen.findByText('Old news')).toBeTruthy()

    fireEvent.change(screen.getByRole('combobox', { name: 'Board' }), { target: { value: 'sprint' } })
    await waitFor(() => expect(plugin.requests.at(-1)?.path).toContain('board=sprint'))
  })

  it('draws a card’s text as characters, never as markup', async () => {
    mount(
      aKanbanPlugin({
        boards: [
          {
            slug: 'default',
            name: 'Default',
            tasks: [
              {
                id: 'x',
                title: '<img src=x onerror=alert(1)>',
                body: null,
                status: 'todo',
                assignee: null,
                priority: 0,
                created_at: 1,
                parents: [],
                comments: []
              }
            ]
          }
        ]
      })
    )

    const text = await screen.findByText('<img src=x onerror=alert(1)>')

    expect(text.querySelector('img')).toBeNull()
  })
})

describe('moving', () => {
  it('offers only the columns a card can be put in, and not the one it is in', async () => {
    mount()

    const menu = within(await card('t_aa')).getByRole('combobox', { name: 'Move Write the release notes to…' })

    expect(
      within(menu)
        .getAllByRole('option')
        .map(option => option.textContent)
    ).toEqual(['Move to…', 'Triage', 'Ready', 'Blocked', 'Done'])
  })

  it('moves a card, says where it went, and reads the board again with the card in its new column', async () => {
    const plugin = mount()

    fireEvent.change(within(await card('t_aa')).getByRole('combobox', { name: 'Move Write the release notes to…' }), {
      target: { value: 'done' }
    })

    expect(await screen.findByText('Moved to Done.')).toBeTruthy()
    await waitFor(() => expect(within(column('Done')).getByText('Write the release notes')).toBeTruthy())
    expect(writes(plugin)[0]).toMatchObject({
      method: 'PATCH',
      path: `${BASE}/tasks/t_aa?board=default`,
      body: { status: 'done' }
    })
  })

  it('shows the board’s own sentence when it refuses, naming the parent in the way, and leaves the card where it was', async () => {
    mount()

    fireEvent.change(within(await card('t_cc')).getByRole('combobox', { name: 'Move Ship the build to…' }), {
      target: { value: 'ready' }
    })

    expect(
      await screen.findByText(/blocked by parent\(s\) not done — 'Write the release notes' \(t_aa, status=todo\)/u)
    ).toBeTruthy()
    expect(within(column('To do')).getByText('Ship the build')).toBeTruthy()
  })

  it('nudges the dispatcher once after a burst of writes, not after each', async () => {
    const plugin = aKanbanPlugin()

    mount(plugin)
    fireEvent.change(within(await card('t_aa')).getByRole('combobox', { name: 'Move Write the release notes to…' }), {
      target: { value: 'blocked' }
    })
    await screen.findByText('Moved to Blocked.')
    await waitFor(() => expect(plugin.nudges()).toBe(1), { timeout: 2000 })
  })
})

describe('a card', () => {
  const open = async (id: string, title: string) => {
    fireEvent.click(within(await card(id)).getByRole('button', { name: `Open ${title}` }))

    return within(await card(id))
  }

  it('opens in place with its fields, its creation time and its comments', async () => {
    mount()

    const item = await open('t_aa', 'Write the release notes')

    expect((await item.findByLabelText('Title')) as HTMLInputElement).toBeTruthy()
    expect((item.getByLabelText('Notes') as HTMLTextAreaElement).value).toBe('Pull them from the changelog.')
    expect(await item.findByText('Started on this.')).toBeTruthy()
    expect(item.getByRole('button', { name: 'Close Write the release notes' }).getAttribute('aria-expanded')).toBe(
      'true'
    )
  })

  it('saves what was edited, as the fields the board takes, and reads the card and the board again', async () => {
    const plugin = mount()
    const item = await open('t_aa', 'Write the release notes')

    fireEvent.change(await item.findByLabelText('Title'), { target: { value: 'Write the notes' } })
    fireEvent.change(item.getByLabelText('Assignee'), { target: { value: 'dana' } })
    fireEvent.change(item.getByLabelText('Priority'), { target: { value: '5' } })
    fireEvent.click(item.getByRole('button', { name: 'Save' }))

    expect(await screen.findByText('Saved.')).toBeTruthy()
    expect(writes(plugin)[0]?.body).toEqual({
      title: 'Write the notes',
      body: 'Pull them from the changelog.',
      assignee: 'dana',
      priority: 5
    })
    await waitFor(() => expect(within(column('To do')).getByText('dana · priority 5')).toBeTruthy())
  })

  it('puts the fields back as the board has them on Cancel, and writes nothing', async () => {
    const plugin = mount()
    const item = await open('t_aa', 'Write the release notes')
    const title = (await item.findByLabelText('Title')) as HTMLInputElement

    fireEvent.change(title, { target: { value: 'Something else' } })
    fireEvent.click(item.getByRole('button', { name: 'Cancel' }))

    expect(title.value).toBe('Write the release notes')
    expect(writes(plugin)).toEqual([])
    expect((item.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('does not save a card with no title or a priority that is not a whole number', async () => {
    const plugin = mount()
    const item = await open('t_aa', 'Write the release notes')

    fireEvent.change(await item.findByLabelText('Title'), { target: { value: '  ' } })
    fireEvent.click(item.getByRole('button', { name: 'Save' }))
    expect((await item.findByRole('alert')).textContent).toBe('A card needs a title.')

    fireEvent.change(item.getByLabelText('Title'), { target: { value: 'Fine' } })
    fireEvent.change(item.getByLabelText('Priority'), { target: { value: '1.5' } })
    fireEvent.click(item.getByRole('button', { name: 'Save' }))
    expect((await item.findByRole('alert')).textContent).toBe('Priority is a whole number.')
    expect(writes(plugin)).toEqual([])
  })

  it('shows the board’s refusal of a save, and keeps the draft', async () => {
    const plugin = mount()
    const item = await open('t_aa', 'Write the release notes')

    plugin.refuseWrites(409, 'the card was changed by someone else')
    fireEvent.change(await item.findByLabelText('Title'), { target: { value: 'Mine' } })
    fireEvent.click(item.getByRole('button', { name: 'Save' }))

    expect(await item.findByText('Could not save: the card was changed by someone else')).toBeTruthy()
    expect((item.getByLabelText('Title') as HTMLInputElement).value).toBe('Mine')
  })

  it('posts a comment under the page’s own name and shows it', async () => {
    const plugin = mount()
    const item = await open('t_aa', 'Write the release notes')

    fireEvent.change(await item.findByLabelText('Comment on Write the release notes'), {
      target: { value: 'Done by Friday.' }
    })
    fireEvent.click(item.getByRole('button', { name: 'Comment' }))

    expect(await item.findByText('Done by Friday.')).toBeTruthy()
    expect(writes(plugin)[0]).toMatchObject({
      method: 'POST',
      path: `${BASE}/tasks/t_aa/comments?board=default`,
      body: { author: 'hermie', body: 'Done by Friday.' }
    })
    expect((item.getByLabelText('Comment on Write the release notes') as HTMLTextAreaElement).value).toBe('')
  })

  it('archives only after a question, as an archive and not a delete', async () => {
    const plugin = mount()
    const item = await open('t_aa', 'Write the release notes')

    fireEvent.click(await item.findByRole('button', { name: 'Archive Write the release notes' }))
    expect(item.getByText('Archive Write the release notes?')).toBeTruthy()
    expect(item.getByText(/It is not a delete/u)).toBeTruthy()
    expect(document.activeElement).toBe(item.getByRole('button', { name: 'Keep it' }))
    fireEvent.click(item.getByRole('button', { name: 'Keep it' }))
    expect(writes(plugin)).toEqual([])

    fireEvent.click(item.getByRole('button', { name: 'Archive Write the release notes' }))
    fireEvent.click(item.getByRole('button', { name: 'Archive Write the release notes' }))

    expect(await screen.findByText('Archived.')).toBeTruthy()
    expect(writes(plugin)[0]).toMatchObject({ method: 'PATCH', body: { status: 'archived' } })
    expect(writes(plugin).some(request => request.method === 'DELETE')).toBe(false)
    await waitFor(() => expect(screen.queryByText('Write the release notes')).toBeNull())
  })
})

describe('a new card', () => {
  const open = async () => {
    const details = (await screen.findByText('New card')).closest('details') as HTMLDetailsElement

    details.open = true

    return within(details)
  }

  it('makes a card in the column that was picked, with one call where the server already derives it', async () => {
    const plugin = mount()
    const form = await open()

    fireEvent.change(form.getByLabelText('Title'), { target: { value: 'Draft the post' } })
    fireEvent.change(form.getByLabelText('Notes'), { target: { value: 'Two paragraphs.' } })
    fireEvent.change(form.getByLabelText('Priority'), { target: { value: '3' } })
    fireEvent.click(form.getByRole('button', { name: 'Make the card' }))

    expect(await screen.findByText('Draft the post was made.')).toBeTruthy()
    await waitFor(() => expect(within(column('Ready')).getByText('Draft the post')).toBeTruthy())
    expect(writes(plugin).filter(request => request.method === 'POST')[0]?.body).toEqual({
      title: 'Draft the post',
      body: 'Two paragraphs.',
      priority: 3
    })
    expect(writes(plugin).filter(request => request.method === 'PATCH')).toEqual([])
  })

  it('lands a card in another column with a second call, since create has no status', async () => {
    const plugin = mount()
    const form = await open()

    fireEvent.change(form.getByLabelText('Title'), { target: { value: 'Park this' } })
    fireEvent.change(form.getByLabelText('Column'), { target: { value: 'blocked' } })
    fireEvent.click(form.getByRole('button', { name: 'Make the card' }))

    await waitFor(() => expect(within(column('Blocked')).getByText('Park this')).toBeTruthy())
    expect(writes(plugin).map(request => `${request.method} ${request.path.split('?')[0]}`)).toEqual([
      `POST ${BASE}/tasks`,
      expect.stringMatching(/^PATCH /u)
    ])
  })

  it('needs a title and never offers the dispatcher’s columns', async () => {
    const plugin = mount()
    const form = await open()

    fireEvent.click(form.getByRole('button', { name: 'Make the card' }))
    expect((await form.findByRole('alert')).textContent).toBe('A card needs a title.')
    expect(writes(plugin)).toEqual([])
    expect(
      within(form.getByLabelText('Column'))
        .getAllByRole('option')
        .map(option => option.textContent)
    ).toEqual(['Triage', 'To do', 'Ready', 'Blocked', 'Done'])
  })
})
