/**
 * The Agents bar and its panel: the count and the clock while children run, the tree, Steer and Stop with their
 * answers and refusals, the transcript (a live tail polled every three seconds, then the stored one once the child
 * has finished), the focus that follows each of them, Escape one level at a time, the agent's words drawn as plain
 * text, three languages, and axe.
 */
import type { Subagent } from '@hermie/transcript'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import axe from 'axe-core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { resetActiveLocale } from '../../i18n/active-locale'
import { chatsStore } from '../../state/chats'
import { assistantItem, chatWith, userItem } from '../../test-support/chat-fixtures'
import { resetShellStores } from '../../test-support/shell-stores'
import { AgentsBar } from './AgentsBar'
import { ChatRuntimeContext, type ChatSessionRuntime } from './chat-runtime'

const NOW = 1_800_000_000_000

beforeEach(() => {
  resetShellStores()
  document.documentElement.lang = 'en'
})

afterEach(() => {
  cleanup()
  resetActiveLocale()
  vi.useRealTimers()
})

const child = (id: string, over: Partial<Subagent> = {}): Subagent => ({
  id,
  parentId: null,
  goal: `Goal of ${id}`,
  taskIndex: 0,
  taskCount: 1,
  status: 'running',
  startedAt: NOW - 42_000,
  updatedAt: NOW,
  filesRead: [],
  filesWritten: [],
  stream: [],
  childSessionId: `child-${id}`,
  ...over
})

function seed(children: Subagent[]): void {
  chatsStore
    .getState()
    .hydrate(
      'researcher',
      chatWith('researcher', [], { subagents: Object.fromEntries(children.map(entry => [entry.id, entry])) })
    )
}

/** Replace the children, as an event or a roster read does: the store's own update, so a mounted bar re-reads. */
function update(children: Subagent[]): void {
  act(() => {
    chatsStore.getState().update('researcher', state => ({
      ...state,
      subagents: Object.fromEntries(children.map(entry => [entry.id, entry]))
    }))
  })
}

interface Calls {
  steer: ReturnType<typeof vi.fn>
  interrupt: ReturnType<typeof vi.fn>
  tail: ReturnType<typeof vi.fn>
  stored: ReturnType<typeof vi.fn>
}

function mount(over: Partial<Calls> = {}, withRuntime = true): Calls {
  const calls: Calls = {
    steer: vi.fn(async () => 'queued'),
    interrupt: vi.fn(async () => true),
    tail: vi.fn(async () => 'tail one'),
    stored: vi.fn(async () => [userItem('Look it up'), assistantItem('Found it')]),
    ...over
  }
  const runtime: ChatSessionRuntime = {
    controller: {
      steerSubagent: calls.steer,
      interruptSubagent: calls.interrupt,
      tailSubagent: calls.tail,
      childTranscript: calls.stored
    } as never,
    gatewayBaseUrl: 'http://gw'
  }

  render(
    <ChatRuntimeContext.Provider value={withRuntime ? runtime : null}>
      <AgentsBar chatKey="researcher" />
    </ChatRuntimeContext.Provider>
  )

  return calls
}

/** The row of the child with this goal: its buttons say the goal to assistive technology too, so the line is asked for. */
const rowOf = (goal: string): HTMLElement =>
  [...document.querySelectorAll<HTMLElement>('.hm-agentsbar__goal')]
    .find(element => element.textContent === goal)
    ?.closest('li') as HTMLElement

const toggle = (): HTMLElement => document.querySelector('.hm-agentsbar__head') as HTMLElement
const open = (): void => void fireEvent.click(toggle())

describe('the bar', () => {
  it('draws nothing while no agent runs', () => {
    seed([])
    mount()

    expect(screen.queryByRole('region', { name: 'Agents' })).toBeNull()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('counts the queued and running children, and not the finished ones', () => {
    seed([child('a'), child('b', { status: 'queued' }), child('c', { status: 'completed' })])
    mount()

    expect(toggle().textContent).toContain('2 agents working')
    expect(toggle().getAttribute('aria-expanded')).toBe('false')
    expect(screen.getByRole('region', { name: 'Agents' })).toBeTruthy()
  })

  it('says one agent in the singular', () => {
    seed([child('a')])
    mount()

    expect(toggle().textContent).toContain('1 agent working')
  })

  it('shows the clock from the earliest start and ticks it every second', () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    seed([child('a', { startedAt: NOW - 42_000 }), child('b', { startedAt: NOW - 5_000 })])
    mount()

    expect(toggle().textContent).toContain('0:42')

    act(() => void vi.advanceTimersByTime(3_000))
    expect(toggle().textContent).toContain('0:45')
  })

  it('keeps the clock out of the accessible name: a name that changes every second is no name', () => {
    seed([child('a')])
    mount()

    expect(toggle().querySelector('.hm-agentsbar__clock')?.getAttribute('aria-hidden')).toBe('true')
  })

  it('says the count in a polite region when it changes', () => {
    seed([child('a')])
    mount()

    const region = (): string => document.querySelector('[role="status"][aria-live="polite"]')?.textContent ?? ''

    expect(region()).toBe('1 agent working')
    update([child('a'), child('b')])
    expect(region()).toBe('2 agents working')
    update([])
    expect(region()).toBe('')
  })

  it('stays, saying no agent runs, while its panel is open and the last child finishes', () => {
    seed([child('a')])
    mount()
    open()
    update([child('a', { status: 'completed', summary: 'All done.' })])

    expect(toggle().textContent).toContain('No agents running')
    expect(screen.getByText('All done.')).toBeTruthy()
  })

  it('goes when the panel is closed and the last child finishes', () => {
    seed([child('a')])
    mount()
    update([child('a', { status: 'completed' })])

    expect(screen.queryByRole('region', { name: 'Agents' })).toBeNull()
  })

  it('opens and closes the panel with its button, which says Show and Hide', () => {
    seed([child('a')])
    mount()

    expect(toggle().textContent).toContain('Show')
    open()
    expect(toggle().getAttribute('aria-expanded')).toBe('true')
    expect(toggle().textContent).toContain('Hide')
    expect(document.getElementById(toggle().getAttribute('aria-controls') ?? '')).toBeTruthy()
    open()
    expect(toggle().getAttribute('aria-expanded')).toBe('false')
  })
})

describe('the tree', () => {
  it('lists each child with its goal, its status in words, its tool and the last lines it wrote', () => {
    seed([
      child('a', {
        goal: 'Audit the dependencies',
        currentTool: 'read_file',
        stream: [1, 2, 3, 4, 5].map(number => ({ text: `line ${number}`, at: number }) as never)
      })
    ])
    mount()
    open()

    const row = rowOf('Audit the dependencies')

    expect(within(row).getByText('Running')).toBeTruthy()
    expect(within(row).getByText('read_file')).toBeTruthy()
    expect(within(row).queryByText('line 1')).toBeNull()
    expect(within(row).getByText('line 5')).toBeTruthy()
    expect(row.querySelectorAll('.hm-agentsbar__stream li')).toHaveLength(4)
  })

  it('nests a child under its parent', () => {
    seed([child('root'), child('leaf', { parentId: 'root', goal: 'Leaf goal' })])
    mount()
    open()

    const leaf = rowOf('Leaf goal')

    expect(leaf.parentElement?.closest('li')?.textContent).toContain('Goal of root')
  })

  it('writes a finished child’s summary and its duration', () => {
    seed([child('a', { status: 'completed', summary: 'Two packages behind.', durationSeconds: 12 }), child('b')])
    mount()
    open()

    expect(screen.getByText('Two packages behind.')).toBeTruthy()
    expect(screen.getByText('12s')).toBeTruthy()
    expect(screen.getByText('Done')).toBeTruthy()
  })

  it('draws what an agent wrote as plain text, cleaned of what could rewrite the line', () => {
    seed([
      child('a', {
        goal: '<img src=x onerror=alert(1)> goal\u202Eevil',
        summary: '**bold** <b>x</b>',
        status: 'completed'
      }),
      child('b')
    ])
    mount()
    open()

    const panel = document.querySelector('.hm-agentsbar__panel') as HTMLElement

    expect(panel.querySelector('img, b, strong')).toBeNull()
    expect(panel.textContent).toContain('<img src=x onerror=alert(1)> goalevil')
    expect(panel.textContent).not.toContain('\u202E')
    expect(panel.textContent).toContain('**bold** <b>x</b>')
  })
})

describe('Steer', () => {
  it('opens a field that takes the focus, and sends the correction as written', async () => {
    seed([child('a')])
    const calls = mount()

    open()
    fireEvent.click(screen.getByRole('button', { name: /^Steer/u }))

    const field = screen.getByRole('textbox', { name: /Send a correction/u })

    expect(document.activeElement).toBe(field)
    fireEvent.change(field, { target: { value: '  Use the lockfile  ' } })
    await act(async () => void fireEvent.submit(field.closest('form') as HTMLFormElement))

    expect(calls.steer).toHaveBeenCalledWith('researcher', 'a', 'Use the lockfile')
    expect(screen.getByText('Steer queued')).toBeTruthy()
    // The field is gone, and the focus is back on the button that opened it.
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: /^Steer/u }))
  })

  it('does not send an empty correction', () => {
    seed([child('a')])
    const calls = mount()

    open()
    fireEvent.click(screen.getByRole('button', { name: /^Steer/u }))
    expect((screen.getByRole('button', { name: 'Steer' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.submit(screen.getByRole('textbox').closest('form') as HTMLFormElement)

    expect(calls.steer).not.toHaveBeenCalled()
  })

  it('says when it came too late, and keeps what was typed when the gateway fails', async () => {
    seed([child('a')])
    const calls = mount({ steer: vi.fn(async () => 'rejected') })

    open()
    fireEvent.click(screen.getByRole('button', { name: /^Steer/u }))
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'x' } })
    await act(async () => void fireEvent.submit(screen.getByRole('textbox').closest('form') as HTMLFormElement))

    expect(screen.getByText(/Too late to steer/u)).toBeTruthy()

    calls.steer.mockRejectedValueOnce(new Error('gateway down'))
    fireEvent.click(screen.getByRole('button', { name: /^Steer/u }))
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'keep me' } })
    await act(async () => void fireEvent.submit(screen.getByRole('textbox').closest('form') as HTMLFormElement))

    expect(screen.getByText('That did not go through: gateway down')).toBeTruthy()
    expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('keep me')
  })

  it('leaves the field with Escape and not the panel', () => {
    seed([child('a')])
    mount()

    open()
    fireEvent.click(screen.getByRole('button', { name: /^Steer/u }))
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Escape' })

    expect(screen.queryByRole('textbox')).toBeNull()
    expect(toggle().getAttribute('aria-expanded')).toBe('true')
    expect(document.activeElement).toBe(screen.getByRole('button', { name: /^Steer/u }))
  })

  it('is offered for a running child only', () => {
    seed([child('a', { status: 'completed' }), child('b', { goal: 'Still going' })])
    mount()
    open()

    expect(within(rowOf('Goal of a')).queryByRole('button', { name: /^(Steer|Stop)/u })).toBeNull()
    expect(within(rowOf('Still going')).getByRole('button', { name: /^Steer/u })).toBeTruthy()
    expect(screen.getAllByRole('button', { name: /^Steer/u })).toHaveLength(1)
    expect(screen.getAllByRole('button', { name: /^Stop/u })).toHaveLength(1)
  })
})

describe('Stop', () => {
  it('interrupts the child and says it is stopping', async () => {
    seed([child('a')])
    const calls = mount()

    open()
    await act(async () => void fireEvent.click(screen.getByRole('button', { name: /^Stop/u })))

    expect(calls.interrupt).toHaveBeenCalledWith('researcher', 'a')
    expect(screen.getByText('Stopping…')).toBeTruthy()
  })

  it('says it had already finished when the gateway no longer knows it', async () => {
    seed([child('a')])
    mount({ interrupt: vi.fn(async () => false) })

    open()
    await act(async () => void fireEvent.click(screen.getByRole('button', { name: /^Stop/u })))

    expect(screen.getByText('Done')).toBeTruthy()
  })

  it('says why it failed', async () => {
    seed([child('a')])
    mount({ interrupt: vi.fn(async () => Promise.reject(new Error('not connected'))) })

    open()
    await act(async () => void fireEvent.click(screen.getByRole('button', { name: /^Stop/u })))

    expect(screen.getByText('That did not go through: not connected')).toBeTruthy()
  })

  it('moves the focus to the row when the stopped child ends and its button goes', async () => {
    seed([child('a')])
    mount()

    open()
    const stop = screen.getByRole('button', { name: /^Stop/u })

    stop.focus()
    await act(async () => void fireEvent.click(stop))
    update([child('a', { status: 'interrupted' })])

    expect(document.activeElement).toBe(rowOf('Goal of a'))
  })

  it('offers no actions at all without a connection to act through', () => {
    seed([child('a')])
    mount({}, false)
    open()

    expect(screen.queryByRole('button', { name: /^(Steer|Stop|Open transcript)/u })).toBeNull()
  })
})

describe('the transcript', () => {
  it('opens in the panel’s place, tails a running child and says it is live', async () => {
    seed([child('a')])
    const calls = mount()

    open()
    await act(async () => void fireEvent.click(screen.getByRole('button', { name: /^Open transcript/u })))

    expect(await screen.findByText('tail one')).toBeTruthy()
    expect(calls.tail).toHaveBeenCalledWith('researcher', 'a')
    expect(screen.getByText('Live tail · refreshing every few seconds')).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Transcript · Goal of a' })).toBeTruthy()
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Transcript · Goal of a' }))
    expect(screen.queryByRole('button', { name: /^Steer/u })).toBeNull()
  })

  it('polls the tail every three seconds while the child runs', async () => {
    vi.useFakeTimers()
    seed([child('a')])
    const calls = mount()

    open()
    await act(async () => void fireEvent.click(screen.getByRole('button', { name: /^Open transcript/u })))
    expect(calls.tail).toHaveBeenCalledTimes(1)

    calls.tail.mockResolvedValue('tail two')
    await act(async () => void vi.advanceTimersByTimeAsync(3_000))
    expect(calls.tail).toHaveBeenCalledTimes(2)
    expect(screen.getByText('tail two')).toBeTruthy()

    await act(async () => void vi.advanceTimersByTimeAsync(6_000))
    expect(calls.tail).toHaveBeenCalledTimes(4)
  })

  it('does not ask again while the last read is still on its way', async () => {
    vi.useFakeTimers()
    seed([child('a')])
    let release: (text: string) => void = () => undefined
    const calls = mount({ tail: vi.fn(() => new Promise<string>(resolve => (release = resolve))) })

    open()
    await act(async () => void fireEvent.click(screen.getByRole('button', { name: /^Open transcript/u })))
    await act(async () => void vi.advanceTimersByTimeAsync(9_000))
    expect(calls.tail).toHaveBeenCalledTimes(1)

    await act(async () => release('late'))
    expect(screen.getByText('late')).toBeTruthy()
  })

  it('reads the stored transcript of a finished child once, and says so', async () => {
    vi.useFakeTimers()
    seed([child('a', { status: 'completed' }), child('b', { childSessionId: undefined })])
    const calls = mount()

    open()
    await act(async () => void fireEvent.click(screen.getByRole('button', { name: /^Open transcript/u })))

    expect(calls.stored).toHaveBeenCalledWith('researcher', 'child-a')
    expect(calls.tail).not.toHaveBeenCalled()
    expect(screen.getByText('The child’s own transcript, read-only.')).toBeTruthy()
    expect(document.querySelector('.hm-agentsbar__text pre')?.textContent).toBe('> Look it up\nFound it')

    await act(async () => void vi.advanceTimersByTimeAsync(9_000))
    expect(calls.stored).toHaveBeenCalledTimes(1)
  })

  it('moves from the live tail to the stored transcript when the child finishes, keeping the text meanwhile', async () => {
    vi.useFakeTimers()
    seed([child('a')])

    let release: (items: never[]) => void = () => undefined
    const calls = mount({ stored: vi.fn(() => new Promise<never[]>(resolve => (release = resolve))) })

    open()
    await act(async () => void fireEvent.click(screen.getByRole('button', { name: /^Open transcript/u })))
    expect(screen.getByText('tail one')).toBeTruthy()

    update([child('a', { status: 'completed' })])
    await act(async () => void vi.advanceTimersByTimeAsync(0))

    // The stored one is on its way: the live text stays, and the source says what it is now.
    expect(calls.stored).toHaveBeenCalledTimes(1)
    expect(screen.getByText('tail one')).toBeTruthy()
    expect(screen.getByText('The child’s own transcript, read-only.')).toBeTruthy()

    await act(async () => release([userItem('Stored line') as never]))
    expect(document.querySelector('.hm-agentsbar__text pre')?.textContent).toBe('> Stored line')
  })

  it('says a read failed, keeps the text and tries again on the next poll', async () => {
    vi.useFakeTimers()
    seed([child('a')])
    const calls = mount()

    open()
    await act(async () => void fireEvent.click(screen.getByRole('button', { name: /^Open transcript/u })))
    calls.tail.mockRejectedValueOnce(new Error('timed out'))
    await act(async () => void vi.advanceTimersByTimeAsync(3_000))

    expect(screen.getByRole('alert').textContent).toBe('Could not read the transcript: timed out')
    expect(screen.getByText('tail one')).toBeTruthy()

    calls.tail.mockResolvedValue('tail three')
    await act(async () => void vi.advanceTimersByTimeAsync(3_000))
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByText('tail three')).toBeTruthy()
  })

  it('says an empty transcript is empty', async () => {
    seed([child('a')])
    mount({ tail: vi.fn(async () => '') })

    open()
    await act(async () => void fireEvent.click(screen.getByRole('button', { name: /^Open transcript/u })))

    expect(await screen.findByText('This agent has not written anything readable yet.')).toBeTruthy()
  })

  it('goes back with its button, Escape, and puts the focus where the reader came from', async () => {
    seed([child('a')])
    mount()

    open()
    const opener = screen.getByRole('button', { name: /^Open transcript/u })

    await act(async () => void fireEvent.click(opener))
    await act(async () => void fireEvent.click(screen.getByRole('button', { name: 'Back to the agents' })))
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: /^Open transcript/u })))

    await act(async () => void fireEvent.click(screen.getByRole('button', { name: /^Open transcript/u })))
    fireEvent.keyDown(screen.getByRole('heading', { name: /^Transcript/u }), { key: 'Escape' })

    expect(screen.queryByRole('heading', { name: /^Transcript/u })).toBeNull()
    expect(toggle().getAttribute('aria-expanded')).toBe('true')
  })

  it('draws the transcript as plain text in a region that a keyboard can scroll', async () => {
    seed([child('a')])
    mount({ tail: vi.fn(async () => '<script>x</script>\n**no markdown**') })

    open()
    await act(async () => void fireEvent.click(screen.getByRole('button', { name: /^Open transcript/u })))

    const text = (await screen.findByRole('region', { name: 'Transcript · Goal of a' })) as HTMLElement

    expect(text.tabIndex).toBe(0)
    expect(text.querySelector('script, strong')).toBeNull()
    expect(text.textContent).toBe('<script>x</script>\n**no markdown**')
  })

  it('offers no transcript for a child that has no session of its own', () => {
    seed([child('a', { childSessionId: undefined })])
    mount()
    open()

    expect(screen.queryByRole('button', { name: /^Open transcript/u })).toBeNull()
  })
})

describe('Escape and the focus', () => {
  it('closes the panel and puts the focus back on the bar’s button', () => {
    seed([child('a')])
    mount()

    open()
    fireEvent.keyDown(screen.getByRole('button', { name: /^Steer/u }), { key: 'Escape' })

    expect(toggle().getAttribute('aria-expanded')).toBe('false')
    expect(document.activeElement).toBe(toggle())
  })
})

describe('languages and accessibility', () => {
  it('speaks Dutch and German in the bar, the rows and the transcript', async () => {
    const { setLanguageChoice } = await import('../../i18n/locale')

    seed([child('a')])
    mount()
    open()

    await act(() => setLanguageChoice('nl'))
    expect(toggle().textContent).toContain('1 agent bezig')
    expect(toggle().textContent).toContain('Verbergen')
    expect(screen.getByText('Bezig')).toBeTruthy()
    expect(screen.getByRole('button', { name: /^Bijsturen/u })).toBeTruthy()

    await act(() => setLanguageChoice('de'))
    expect(toggle().textContent).toContain('1 Agent arbeitet')
    expect(toggle().textContent).toContain('Ausblenden')
    expect(screen.getByRole('button', { name: /^Stopp/u })).toBeTruthy()
  })

  it('has no axe violation with the tree, the steer field and a transcript open', async () => {
    seed([
      child('root', { currentTool: 'read_file', stream: [{ text: 'hello', at: 1 } as never] }),
      child('leaf', { parentId: 'root', status: 'completed', summary: 'Done.' })
    ])
    mount()
    open()
    fireEvent.click(screen.getAllByRole('button', { name: /^Steer/u })[0] as HTMLElement)

    const rules = {
      'color-contrast': { enabled: false },
      'document-title': { enabled: false },
      region: { enabled: false }
    }
    const tree = await axe.run(document.documentElement, { rules })

    expect(tree.violations.map(violation => `${violation.id}: ${violation.help}`)).toEqual([])

    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Escape' })
    await act(
      async () => void fireEvent.click(screen.getAllByRole('button', { name: /^Open transcript/u })[0] as HTMLElement)
    )
    await screen.findByText('tail one')

    const transcript = await axe.run(document.documentElement, { rules })

    expect(transcript.violations.map(violation => `${violation.id}: ${violation.help}`)).toEqual([])
  })
})
