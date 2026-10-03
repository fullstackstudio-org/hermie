/**
 * Each item view on its own: what a row of each kind shows, in every
 * presentation the selectors can hand it. The views are pure over an engine item;
 * all they read besides is the chat's context.
 */
import type { TranscriptItem, VisibleItem } from '@hermie/transcript'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { assistantItem, noticeItem, statusItem, toolItem, userItem } from '../../../test-support/chat-fixtures'
import { LONG_AGO } from '../../../test-support/shell-stores'
import { ChatItem } from './ChatItem'
import { dayLabel } from './DateSeparator'
import { ItemContext } from './item-context'
import { attachmentName } from './UserBubble'
import { argumentLines, errorText, resultText, shortToolName } from './tool-text'

type Presentation = VisibleItem['presentation']

function draw(
  item: TranscriptItem,
  presentation: Presentation = 'full',
  context: Partial<React.ComponentProps<typeof ItemContext.Provider>['value']> = {}
) {
  return render(
    <ItemContext.Provider
      value={{
        botName: 'Dr. Researcher',
        gatewayBaseUrl: 'http://gateway.test',
        ownAuthorId: undefined,
        groupChat: false,
        ...context
      }}
    >
      <ChatItem row={{ item, presentation }} />
    </ItemContext.Provider>
  )
}

describe('a user bubble', () => {
  it('is the reader’s own, on the right, with its words as Markdown and its clock', () => {
    const { container } = draw(userItem('this is **done**', { ts: LONG_AGO }))

    expect(container.querySelector('.hm-msg')?.getAttribute('data-side')).toBe('own')
    expect(container.querySelector('strong')?.textContent).toBe('done')
    expect(container.querySelector('time')?.getAttribute('datetime')).toBe(new Date(LONG_AGO * 1000).toISOString())
  })

  it('says it is sending until the gateway has it, and marks a steer', () => {
    draw(userItem('wait', { pending: true, displayKind: 'steer' }))

    expect(screen.getByText('Sending…')).toBeTruthy()
    expect(screen.getByText('Steered')).toBeTruthy()
  })

  it('names its attachments by file, as text', () => {
    draw(userItem('see these', { attachments: ['@file:/srv/work/report.pdf', '@image:`/tmp/shot one.png`'] }))

    expect(
      within(screen.getByRole('list', { name: 'Attachments' }))
        .getAllByRole('listitem')
        .map(li => li.textContent)
    ).toEqual(['report.pdf', 'shot one.png'])
    expect(attachmentName('@file:C:\\Users\\x\\a.txt')).toBe('a.txt')
  })

  it('draws nothing for a placeholder, and draws a message with no stamp without a clock', () => {
    const hidden = draw(userItem('x'), 'hidden-placeholder')

    expect(hidden.container.textContent).toBe('')
    hidden.unmount()

    const plain = draw(userItem('no clock', { ts: undefined }))

    expect(plain.container.querySelector('time')).toBeNull()
  })

  it('names a message for assistive technology only when it can say who: somebody else, in the group chat', () => {
    const item = userItem('hi', { author: { id: 'p:dana', name: 'Dana' }, ts: LONG_AGO })
    const { container } = draw(item, 'full', { groupChat: true, ownAuthorId: 'p:me' })

    expect(container.querySelector('article')?.getAttribute('aria-label')).toMatch(/^Dana, /)
  })
})

describe('an assistant bubble', () => {
  it('holds the dots while the turn has said nothing, in the one bubble', () => {
    const { container } = draw(assistantItem('', { streaming: true }))

    expect(screen.getByRole('img', { name: 'Replying' })).toBeTruthy()
    expect(container.querySelectorAll('.hm-bubble')).toHaveLength(1)
  })

  it('draws nothing at all for a reply with nothing in it and nothing coming', () => {
    expect(draw(assistantItem('   ')).container.textContent).toBe('')
  })

  it('says how long it took, what it cost and on what, only when usage was reported', () => {
    const withUsage = draw(
      assistantItem('Done.', {
        durationS: 12.4,
        usage: { input: 1200, output: 34, model: 'acme-large-2-20250929' } as never
      })
    )

    expect(withUsage.container.querySelector('.hm-msg__footer')?.textContent).toMatch(/^12s · 1,200 in · 34 out · /)
    withUsage.unmount()

    const without = draw(assistantItem('Done.', { durationS: 12.4 }))

    expect(without.container.querySelector('.hm-msg__footer')).toBeNull()
  })

  it('labels a reply to a teammate and an interim note, and shows the heading of its text two levels down', () => {
    const reply = draw(assistantItem('# Title', { replyToBotHandle: 'writer', interim: true }))

    expect(screen.getByText('Reply to @writer')).toBeTruthy()
    expect(screen.getByText('Interim note')).toBeTruthy()
    expect(screen.getByRole('heading').tagName).toBe('H3')
    reply.unmount()
  })

  it('keeps the words of a failed turn and says it is waiting on the gateway when it is recoverable', () => {
    draw(assistantItem('Partial', { error: { message: 'connection lost', partial: true, recoverable: true } }))

    expect(screen.getByText('Partial')).toBeTruthy()
    expect(screen.getByText('connection lost')).toBeTruthy()
    expect(screen.getByText('Reconnecting…')).toBeTruthy()
  })

  it('shows only what the images may load from: the gateway’s own origin', () => {
    const { container } = draw(assistantItem('![a](/api/files/x.png) ![b](https://elsewhere.test/y.png)'))

    expect([...container.querySelectorAll('img')].map(image => image.getAttribute('src'))).toEqual([
      'http://gateway.test/api/files/x.png'
    ])
  })
})

describe('a tool row', () => {
  it('is one collapsed line: the name, what it did, how long it took', () => {
    draw(toolItem('web_search', { summary: 'three results', durationS: 1.234 }), 'collapsed')

    const line = screen.getByRole('button')

    expect(line.getAttribute('aria-expanded')).toBe('false')
    expect(line.textContent).toBe('web_searchthree results1.2s')
  })

  it('says it is running, and that it is still being prepared', () => {
    const running = draw(toolItem('shell', { status: 'running', resultKnown: false }), 'collapsed')

    expect(screen.getByRole('button').textContent).toContain('Running…')
    running.unmount()
    draw(toolItem('shell', { status: 'generating', resultKnown: false }), 'collapsed')
    expect(screen.getByRole('button').textContent).toContain('Preparing…')
  })

  it('opens on a click to its arguments and its result, and closes on the next', () => {
    draw(toolItem('read_file', { args: { path: 'notes.md', depth: 2 }, result: { output: 'hello' } }), 'collapsed')

    const line = screen.getByRole('button')

    fireEvent.click(line)

    expect(line.getAttribute('aria-expanded')).toBe('true')
    expect(document.getElementById(line.getAttribute('aria-controls') ?? '')).toBeTruthy()
    expect(screen.getByText('path')).toBeTruthy()
    expect(screen.getByText('notes.md')).toBeTruthy()
    expect(screen.getByText('2')).toBeTruthy()
    expect(screen.getByText('hello')).toBeTruthy()

    fireEvent.click(line)
    expect(line.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByText('hello')).toBeNull()
  })

  it('starts open at the verbose level, where the selectors hand it over as a full row', () => {
    draw(toolItem('read_file', { args: { path: 'a' } }), 'full')

    expect(screen.getByRole('button').getAttribute('aria-expanded')).toBe('true')
  })

  it('shows a failure as one, with its message', () => {
    const { container } = draw(
      toolItem('shell', { status: 'error', isError: true, result: { error: 'permission denied' } }),
      'collapsed'
    )

    expect(container.querySelector('.hm-tool')?.getAttribute('data-failed')).toBe('true')
    expect(screen.getByRole('button').textContent).toContain('Failed')

    fireEvent.click(screen.getByRole('button'))
    expect(screen.getByText('permission denied')).toBeTruthy()
  })

  it('draws nothing for a tool whose interface is elsewhere, until it fails, nor for the quiet placeholder', () => {
    expect(draw(toolItem('todo'), 'collapsed').container.textContent).toBe('')
    expect(draw(toolItem('shell', { status: 'running' }), 'hidden-placeholder').container.textContent).toBe('')
    expect(
      draw(toolItem('todo', { isError: true, status: 'error', summary: 'bad list' }), 'collapsed').container.textContent
    ).toContain('todo')
  })

  it('folds a long value behind "Show more"', () => {
    draw(toolItem('shell', { args: { command: 'x'.repeat(1000) } }), 'full')

    expect(screen.getByRole('button', { name: 'Show more' }).getAttribute('aria-expanded')).toBe('false')
    expect(document.querySelector('.hm-tool__text')?.textContent).toHaveLength(601)

    fireEvent.click(screen.getByRole('button', { name: 'Show more' }))
    expect(document.querySelector('.hm-tool__text')?.textContent).toHaveLength(1000)
  })

  it('warns when the output was flagged, and says what was redacted', () => {
    draw(
      toolItem('fetch', {
        outputRisk: { risk: 'prompt injection', findings: ['asks to ignore rules'], redacted: true }
      }),
      'full'
    )

    expect(screen.getByText('Untrusted output · prompt injection')).toBeTruthy()
    expect(screen.getByText('asks to ignore rules')).toBeTruthy()
    expect(screen.getByText('Redacted before it reached the model')).toBeTruthy()
  })
})

describe('the helpers of a tool row', () => {
  it('names an MCP tool by its server, and cuts a long name', () => {
    expect(shortToolName('mcp__terminal__run_in_terminal')).toBe('terminal')
    expect(shortToolName('bash')).toBe('bash')
    expect(shortToolName('a_really_long_tool_name_indeed')).toBe('a_really_long_too…')
    expect(shortToolName('  ')).toBe('')
  })

  it('reads a result as text: its own text field, else the value', () => {
    expect(resultText(toolItem('x', { resultText: 'raw' }))).toBe('raw')
    expect(resultText(toolItem('x', { result: { stdout: 'out', other: 1 } }))).toBe('out')
    expect(resultText(toolItem('x', { result: { a: 1 } }))).toBe('{\n  "a": 1\n}')
    expect(resultText(toolItem('x', { result: undefined }))).toBe('')
  })

  it('finds the message of a failure wherever the tool put it', () => {
    expect(errorText(toolItem('x', { result: { error: 'nope' } }))).toBe('nope')
    expect(errorText(toolItem('x', { result: { error: { message: 'deep' } } }))).toBe('deep')
    expect(errorText(toolItem('x', { summary: 'summary only' }))).toBe('summary only')
  })

  it('lists the arguments in the order they were written', () => {
    expect(argumentLines({ b: 1, a: 'two', c: { d: 3 } }).map(line => line.name)).toEqual(['b', 'a', 'c'])
    expect(argumentLines(undefined)).toEqual([])
  })
})

describe('a notice', () => {
  it('is a centred line, never a bubble, and a disclosure when it has something to open', () => {
    const plain = draw(noticeItem('Switched model', { noticeKind: 'model_switch' }), 'collapsed')

    expect(plain.container.querySelector('.hm-msg')).toBeNull()
    expect(plain.container.querySelector('.hm-note-line')?.textContent).toBe('Switched model')
    plain.unmount()

    draw(noticeItem('Job finished', { noticeKind: 'process_complete', body: 'exit 0' }), 'collapsed')

    const line = screen.getByRole('button', { name: 'Job finished' })

    expect(line.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(line)
    expect(screen.getByText('exit 0')).toBeTruthy()
  })

  it('opens the answer to a command by itself, and keeps an error in the danger colour', () => {
    const command = draw(noticeItem('/help', { noticeKind: 'command', body: 'Commands: …' }), 'full')

    expect(screen.getByText('Commands: …')).toBeTruthy()
    command.unmount()

    const error = draw(noticeItem('It broke', { noticeKind: 'error', body: 'trace' }), 'full')

    expect(error.container.querySelector('.hm-notice')?.getAttribute('data-tone')).toBe('danger')
    expect(screen.getByText('trace')).toBeTruthy()
  })

  it('is a chip at the level that folds it, unless it is an error or a command', () => {
    const chip = draw(noticeItem('Compacted', { noticeKind: 'notice', body: 'details' }), 'chip')

    expect(chip.container.querySelector('.hm-chip')?.textContent).toBe('Compacted')
    chip.unmount()

    draw(noticeItem('/model', { noticeKind: 'command', body: 'gpt' }), 'chip')
    expect(screen.getByText('gpt')).toBeTruthy()
  })
})

describe('a status line', () => {
  it('is a chip, or at the verbose level a line with its kind above it', () => {
    const chip = draw(statusItem('compacting', { statusKind: 'context.compaction' }), 'chip')

    expect(chip.container.querySelector('.hm-chip')?.textContent).toBe('compacting')
    chip.unmount()

    draw(statusItem('compacting', { statusKind: 'context.compaction' }), 'full')
    expect(screen.getByText('context compaction')).toBeTruthy()
    expect(screen.getByText('compacting')).toBeTruthy()
  })
})

describe('the date separator', () => {
  const now = new Date(2026, 9, 3, 15, 0)

  it('says today and yesterday, a weekday within the week, then the date, with the year when it is not this one', () => {
    expect(dayLabel(20261003, now)).toBe('Today')
    expect(dayLabel(20261002, now)).toBe('Yesterday')
    expect(dayLabel(20260930, now)).toMatch(/Wed/)
    expect(dayLabel(20260930, now)).toMatch(/30/)
    expect(dayLabel(20260512, now)).toMatch(/12/)
    expect(dayLabel(20260512, now)).not.toMatch(/2026/)
    expect(dayLabel(20250512, now)).toMatch(/2025/)
  })
})

describe('the kinds that have no view of their own yet', () => {
  const text = (item: TranscriptItem, presentation: Presentation = 'full') =>
    draw(item, presentation).container.textContent ?? ''
  const common = { id: 'x', seq: 1, origin: 'history' as const, version: 1 }

  it('are a line of text saying what they are, so no row of a conversation is missing', () => {
    expect(
      text({ ...common, kind: 'bot_dm_in', senderName: 'Writer', senderHandle: 'writer', text: 'the draft is ready' })
    ).toBe('From @writerthe draft is ready')
    expect(
      text({
        ...common,
        kind: 'bot_dm_out',
        toolId: 't',
        target: '@builder',
        targetHandle: 'builder',
        message: 'please build',
        dispatch: { status: 'queued' }
      })
    ).toContain('To @builderplease build')
    expect(
      text({ ...common, kind: 'cron_delivery', jobName: 'Morning', body: 'all quiet', shape: 'header' as never })
    ).toBe('CRON · Morningall quiet')
    expect(
      text({ ...common, kind: 'subagent_group', goals: ['look', 'read'], rootIds: [], status: 'running' })
    ).toContain('look')
    expect(
      text({
        ...common,
        kind: 'approval',
        requestId: 'r',
        approvalId: 'a',
        command: 'rm -rf build',
        choices: [],
        state: 'open'
      })
    ).toBe('Allow this command?rm -rf build')
    expect(
      text({
        ...common,
        kind: 'clarify',
        requestId: 'r',
        questions: [{ qid: '1', question: 'Which one?', multiSelect: false }],
        answers: {},
        locked: [],
        state: 'open'
      })
    ).toBe('The bot has a questionWhich one?')
  })

  it('shows what the bot said, as characters', () => {
    const { container } = draw(
      { ...common, kind: 'bot_dm_in', senderName: 'W', text: '<img src=x onerror=alert(1)>' },
      'full'
    )

    expect(container.querySelector('img')).toBeNull()
    expect(container.textContent).toContain('<img src=x onerror=alert(1)>')
  })
})
