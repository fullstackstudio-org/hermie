/**
 * The item views that are not bubbles, each in every presentation the
 * selectors can hand it: a reply's thought, a failed turn, system lines,
 * bot-to-bot asides and their roll-up, a cron delivery, a fan-out of agents.
 *
 * Every view is pure over an engine item; the roll-up row comes from the same
 * pass the screen runs (`rollupDmRuns`), and a fan-out's children come from the
 * chat store, as on the screen.
 */
import type { Subagent, TranscriptItem, VisibleItem } from '@hermie/transcript'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { chatsStore } from '../../../state/chats'
import {
  assistantItem,
  botDmInItem,
  botDmOutItem,
  chatWith,
  cronDeliveryItem,
  noticeItem,
  subagentGroupItem
} from '../../../test-support/chat-fixtures'
import { aBot, LONG_AGO, resetShellStores, seedRoster } from '../../../test-support/shell-stores'
import { rollupDmRuns } from '../dm-rollup'
import { ChatItem } from './ChatItem'
import { ErrorCard } from './ErrorCard'
import { ItemContext, type ItemContextValue } from './item-context'
import { systemLineText } from './SystemLine'

type Presentation = VisibleItem['presentation']

const CONTEXT: ItemContextValue = {
  botName: 'Researcher',
  gatewayBaseUrl: 'http://gateway.test',
  ownAuthorId: undefined,
  groupChat: false,
  chatKey: 'researcher'
}

function draw(item: TranscriptItem, presentation: Presentation = 'full') {
  return render(
    <ItemContext.Provider value={CONTEXT}>
      <ChatItem row={{ item, presentation }} />
    </ItemContext.Provider>
  )
}

function drawRow(row: VisibleItem) {
  return render(
    <ItemContext.Provider value={CONTEXT}>
      <ChatItem row={row} />
    </ItemContext.Provider>
  )
}

beforeEach(() => {
  resetShellStores()
})

afterEach(() => {
  resetShellStores()
})

describe('a reply’s thought', () => {
  it('is one closed line above the reply that opens to the thought, as characters', () => {
    draw(assistantItem('The answer.', { reasoning: 'First **this**\nthen that', durationS: 3.6 }))

    const line = screen.getByRole('button', { name: 'Thought for 4s' })

    expect(line.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByText(/then that/)).toBeNull()

    fireEvent.click(line)

    const body = document.getElementById(line.getAttribute('aria-controls') ?? '') as HTMLElement

    expect(body.textContent).toBe('First **this**\nthen that')
    expect(body.querySelector('strong')).toBeNull()
    // It is not a bubble: the reply is the only one.
    expect(document.querySelectorAll('.hm-bubble')).toHaveLength(1)
  })

  it('says Thinking while nothing of the reply has arrived, and holds the dots in the reply’s place', () => {
    draw(assistantItem('', { reasoning: 'weighing it', streaming: true }), 'collapsed')

    expect(screen.getByRole('button', { name: 'Thinking' })).toBeTruthy()
    expect(screen.getByRole('img', { name: 'Replying' })).toBeTruthy()
  })

  it('is the whole row when the reply so far is only a thought, and is gone when the settings take it away', () => {
    const thought = draw(assistantItem('', { reasoning: 'only this', durationS: 1 }), 'collapsed')

    expect(screen.getByRole('button', { name: 'Thought for 1s' })).toBeTruthy()
    expect(thought.container.querySelector('.hm-bubble')).toBeNull()
    thought.unmount()

    // `showThinking: false` strips `reasoning` from the item before it reaches the view.
    expect(draw(assistantItem('Reply.')).container.querySelector('.hm-thought')).toBeNull()
  })
})

describe('a failed turn', () => {
  it('keeps the words that arrived and puts the failure under them, cleaned', () => {
    draw(assistantItem('Partial', { error: { message: 'boom‮ reversed', partial: true } }))

    expect(screen.getByText('Partial')).toBeTruthy()
    expect(screen.getByText('Something went wrong')).toBeTruthy()
    expect(document.querySelector('.hm-failure__message')?.textContent).toBe('boom reversed')
  })

  it('offers Retry only when the turn is gone and the screen can retry, never while reconnecting', () => {
    const onRetry = vi.fn()
    const gone = render(<ErrorCard error={{ message: 'lost', partial: false }} onRetry={onRetry} />)

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(onRetry).toHaveBeenCalledTimes(1)
    gone.unmount()

    render(<ErrorCard error={{ message: 'lost', partial: false, recoverable: true }} onRetry={onRetry} />)
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull()
    expect(screen.getByText('Reconnecting…')).toBeTruthy()
  })

  it('is not an alert: a chat opened on an old failure does not shout it', () => {
    const { container } = render(<ErrorCard error={{ message: 'old', partial: false }} />)

    expect(container.querySelector('[role="alert"]')).toBeNull()
    expect(screen.queryByRole('button')).toBeNull()
  })
})

describe('a system line', () => {
  it('is one centred sentence, the first of the body, never a disclosure', () => {
    const { container } = draw(
      noticeItem('Model changed', {
        noticeKind: 'model_switch',
        body: 'Now running acme-large. From this point forward, use this runtime metadata.'
      }),
      'collapsed'
    )

    expect(container.querySelector('.hm-system-line')?.textContent).toBe('Now running acme-large.')
    expect(container.querySelector('button')).toBeNull()
  })

  it('keeps a body with no sentence boundary whole, and falls back to the title', () => {
    expect(systemLineText({ title: 'T', body: 'no full stop here' })).toBe('no full stop here')
    expect(systemLineText({ title: 'Auto-continued', body: '  ' })).toBe('Auto-continued')
    expect(systemLineText({ title: 'x', body: 'v1.2 is out! More later.' })).toBe('v1.2 is out!')
  })

  it('takes every marker family, whichever transport labelled it, and draws nothing for a placeholder', () => {
    for (const noticeKind of ['personality_switch', 'auto_continue', 'system_note'] as const) {
      const { container, unmount } = draw(noticeItem('Said', { noticeKind }), 'full')

      expect(container.querySelector('.hm-system-line')?.textContent, noticeKind).toBe('Said')
      unmount()
    }

    expect(draw(noticeItem('x', { noticeKind: 'model_switch' }), 'hidden-placeholder').container.textContent).toBe('')
  })
})

describe('a bot-to-bot aside', () => {
  it('is one closed line on the left: direction, who, a preview, the time, never a bubble', () => {
    const { container } = draw(botDmInItem('the draft is ready, see notes', { ts: LONG_AGO }), 'collapsed')

    const line = screen.getByRole('button')

    expect(line.getAttribute('aria-expanded')).toBe('false')
    expect(line.querySelector('.hm-dm__header')?.textContent).toBe('From @writer')
    expect(line.querySelector('.hm-dm__preview')?.textContent).toBe('the draft is ready, see notes')
    expect(line.querySelector('time')).not.toBeNull()
    expect(container.querySelector('.hm-bubble, .hm-msg')).toBeNull()
  })

  it('opens to the message as Markdown, and the bot’s HTML stays characters', () => {
    draw(botDmInItem('**done** <img src=x onerror=alert(1)>'), 'collapsed')

    fireEvent.click(screen.getByRole('button'))

    const body = document.querySelector('.hm-dm__body') as HTMLElement

    expect(body.querySelector('strong')?.textContent).toBe('done')
    expect(body.querySelector('img')).toBeNull()
    expect(body.textContent).toContain('<img src=x onerror=alert(1)>')
  })

  it('carries the reply marker on every dispatch: waiting, replied, failed', () => {
    const marker = (item: TranscriptItem) => {
      const { container, unmount } = draw(item, 'collapsed')
      const node = container.querySelector('.hm-dm__marker')
      const result = [node?.getAttribute('data-tone'), node?.textContent]

      unmount()

      return result
    }

    expect(marker(botDmOutItem('please build'))).toEqual(['waiting', 'Delivered · waiting for reply'])
    expect(marker(botDmOutItem('please build', { reply: { text: 'built' } }))).toEqual(['replied', '↩︎ replied'])
    expect(marker(botDmOutItem('please build', { dispatch: { status: 'failed', error: 'no such bot' } }))).toEqual([
      'failed',
      'Failed'
    ])
    expect(marker(botDmOutItem('please build', { reply: { text: '', error: 'timed out' } }))).toEqual([
      'failed',
      'Failed'
    ])
    // An inbound message carries one only when it answers our own dispatch.
    expect(marker(botDmInItem('here you go', { answersOurDispatch: true }))).toEqual(['answered', '↩︎ answered'])
    expect(marker(botDmInItem('hello'))).toEqual([undefined, undefined])
  })

  it('opens a dispatch to how it went and to the reply, and an error is said as one', () => {
    draw(
      botDmOutItem('please build', { dispatch: { status: 'queued' }, reply: { text: 'Built it: **ok**' } }),
      'collapsed'
    )
    fireEvent.click(screen.getByRole('button'))

    const body = document.querySelector('.hm-dm__body') as HTMLElement

    expect(within(body).getByText('Queued · waiting for the current task')).toBeTruthy()
    expect(within(body).getByText('Reply')).toBeTruthy()
    expect(body.querySelector('.hm-dm__reply strong')?.textContent).toBe('ok')
  })

  it('links to the other bot’s chat only when this gateway has that bot, and the row itself never navigates', () => {
    const unknown = draw(botDmInItem('hi'), 'collapsed')

    fireEvent.click(screen.getByRole('button'))
    expect(screen.queryByRole('link')).toBeNull()
    unknown.unmount()

    seedRoster([aBot('writer')])
    draw(botDmInItem('hi'), 'collapsed')
    expect(screen.queryByRole('link')).toBeNull()
    fireEvent.click(screen.getByRole('button'))

    // By its text: jsdom has no layout, so its accessible-name computation spaces out the `<bdi>`.
    const link = screen.getByRole('link')

    expect(link.textContent).toBe('Open @writer’s chat')
    expect(link.getAttribute('href')).toBe('#/chat/writer')
  })

  it('is a chip, still there, when bot-to-bot is hidden', () => {
    const out = draw(botDmOutItem('please build', { target: '@builder', targetHandle: 'builder' }), 'chip')

    expect(out.container.querySelector('.hm-chip')?.textContent).toBe('Message to @builder')
    out.unmount()

    expect(draw(botDmInItem('hi'), 'chip').container.querySelector('.hm-chip')?.textContent).toBe('Message from Writer')
  })

  it('isolates a name that would reorder the words around it, and cleans it', () => {
    const { container } = draw(botDmInItem('x', { senderHandle: 'evil‮eman' }), 'collapsed')
    const bdi = container.querySelector('.hm-dm__header bdi')

    expect(bdi?.textContent).toBe('evileman')
    expect(container.querySelector('.hm-dm__header')?.textContent).toBe('From @evileman')
  })

  it('draws nothing for a placeholder', () => {
    expect(draw(botDmInItem('x'), 'hidden-placeholder').container.textContent).toBe('')
  })
})

describe('a roll-up of asides', () => {
  const run = (count: number, over: { handle?: string } = {}) =>
    Array.from({ length: count }, (_, index): VisibleItem => {
      const item =
        index % 2 === 0
          ? botDmOutItem(`ask ${index}`, {
              targetHandle: over.handle ?? 'writer',
              ...(index === 0 ? { reply: { text: 'ok' } } : {})
            })
          : botDmInItem(`answer ${index}`, { senderHandle: index === 3 && !over.handle ? 'editor' : 'writer' })

      return { item, presentation: 'collapsed' }
    })

  it('is one line for more than three asides in a row, that opens in place to each of them', () => {
    const rows = rollupDmRuns(run(4, { handle: 'writer' }))

    expect(rows).toHaveLength(1)
    drawRow(rows[0] as VisibleItem)

    const line = screen.getByRole('button')

    expect(line.textContent).toBe('\u21c44 messages with @writer · 1 reply')
    expect(line.getAttribute('aria-expanded')).toBe('false')
    expect(document.querySelectorAll('.hm-dm')).toHaveLength(0)

    fireEvent.click(line)

    expect(line.getAttribute('aria-expanded')).toBe('true')
    expect(line.textContent).toContain('Show less')
    expect(document.querySelectorAll('.hm-dm')).toHaveLength(4)
    // Each aside is still closed until it is opened.
    expect(
      [...document.querySelectorAll('.hm-dm__line')].every(button => button.getAttribute('aria-expanded') === 'false')
    ).toBe(true)
  })

  it('says how many and how many came back when the run involved more than one teammate', () => {
    const rows = rollupDmRuns(run(4))

    drawRow(rows[0] as VisibleItem)
    expect(screen.getByRole('button', { name: '4 messages · 1 reply' })).toBeTruthy()
  })
})

describe('a cron delivery', () => {
  it('is a card, not a bubble, open at the levels that hand it over in full, with the report as Markdown', () => {
    const { container } = draw(cronDeliveryItem('All **quiet**.', { ts: LONG_AGO }), 'full')

    const line = screen.getByRole('button')

    expect(container.querySelector('.hm-msg, .hm-bubble')).toBeNull()
    expect(line.getAttribute('aria-expanded')).toBe('true')
    expect(line.querySelector('.hm-cron__eyebrow')?.textContent).toBe('CRON')
    expect(line.querySelector('.hm-cron__name')?.textContent).toBe('Source scan')
    expect(line.querySelector('.hm-cron__meta')?.textContent).toMatch(/^ran .+ · delivered to this chat$/)
    expect(container.querySelector('.hm-cron__body strong')?.textContent).toBe('quiet')

    fireEvent.click(line)
    expect(line.getAttribute('aria-expanded')).toBe('false')
    expect(container.querySelector('.hm-cron__body')).toBeNull()
  })

  it('is folded at quiet, and opens on a click', () => {
    draw(cronDeliveryItem('report'), 'collapsed')

    const line = screen.getByRole('button')

    expect(line.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(line)
    expect(screen.getByText('report')).toBeTruthy()
  })

  it('never titles itself with a redacted name, and says when the job delivered nothing', () => {
    const { container } = draw(cronDeliveryItem('', { jobName: '[REDACTED]', nameRedacted: true, ts: undefined }))

    expect(container.querySelector('.hm-cron__name')?.textContent).toBe('Scheduled job')
    expect(container.querySelector('.hm-cron__meta')?.textContent).toBe('delivered to this chat')
    expect(screen.getByText('The job delivered nothing to show.')).toBeTruthy()
  })

  it('is a chip if it is ever handed over as one, and nothing for a placeholder', () => {
    expect(draw(cronDeliveryItem('x'), 'chip').container.querySelector('.hm-chip')?.textContent).toBe(
      'CRON · Source scan'
    )
    expect(draw(cronDeliveryItem('x'), 'hidden-placeholder').container.textContent).toBe('')
  })
})

describe('a fan-out of agents', () => {
  const child = (id: string, status: Subagent['status'], over: Partial<Subagent> = {}): Subagent => ({
    id,
    parentId: null,
    goal: id,
    taskIndex: 0,
    taskCount: 2,
    status,
    startedAt: 1,
    updatedAt: 2,
    filesRead: [],
    filesWritten: [],
    stream: [],
    ...over
  })

  it('is a chip at quiet or with bot-to-bot hidden: what, how it stands, how many goals', () => {
    const { container } = draw(subagentGroupItem(['look', 'read'], { status: 'running' }), 'chip')

    expect(container.querySelector('.hm-chip')?.textContent).toBe('Agents · Running · 2 goals')
  })

  it('is a card of goals, one line each when collapsed and written out in full, with the summary', () => {
    const collapsed = draw(
      subagentGroupItem(['look things up', 'read them'], { status: 'done', completion: 'Both done.' }),
      'collapsed'
    )
    const card = collapsed.container.querySelector('.hm-agents') as HTMLElement

    expect(card.getAttribute('data-detailed')).toBe('false')
    expect(card.getAttribute('aria-label')).toBe('Agents · Done')
    expect([...card.querySelectorAll('.hm-agents__text')].map(node => node.textContent)).toEqual([
      'look things up',
      'read them'
    ])
    expect(within(card).getByText('Both done.')).toBeTruthy()
    collapsed.unmount()

    const full = draw(subagentGroupItem(['look'], { status: 'running' }), 'full')

    expect(full.container.querySelector('.hm-agents')?.getAttribute('data-detailed')).toBe('true')
  })

  it('shows each child’s own status against its goal, as a word for assistive technology too', () => {
    chatsStore.getState().hydrate(
      'researcher',
      chatWith('researcher', [], {
        subagents: {
          a: child('a', 'completed', { durationSeconds: 12 }),
          b: child('b', 'failed')
        }
      })
    )
    const { container } = draw(subagentGroupItem(['one', 'two', 'three'], { rootIds: ['a', 'b'] }), 'full')
    const goals = [...container.querySelectorAll('.hm-agents__goal')]

    expect(goals.map(goal => goal.getAttribute('data-status'))).toEqual(['completed', 'failed', 'running'])
    expect(goals.map(goal => goal.querySelector('.hm-sr')?.textContent)).toEqual(['Done: ', 'Failed: ', 'Running: '])
    expect(goals[0]?.querySelector('.hm-agents__duration')?.textContent).toBe('12s')
  })

  it('draws nothing for a placeholder', () => {
    expect(draw(subagentGroupItem(['x']), 'hidden-placeholder').container.textContent).toBe('')
  })
})
