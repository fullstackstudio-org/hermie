/**
 * The approval sheet on its own (PG-3): which choices it draws for every
 * combination of the request's flags, what it says about them, and the box that
 * gives one answer to several of the same bot's approvals. The layer around it
 * (modality, focus, the controller) is `RequestLayer.test.tsx`'s.
 */
import type { ApprovalItem } from '@hermie/transcript'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { resetActiveLocale } from '../../i18n/active-locale'
import { sentence } from '../../test-support/sentence'
import { ApprovalSheet, offeredChoices } from './ApprovalSheet'

const ALL = ['once', 'session', 'always', 'deny']

function approval(over: Partial<ApprovalItem> = {}): ApprovalItem {
  return {
    id: `req:${over.requestId ?? 'srq-1'}`,
    kind: 'approval',
    seq: 1,
    origin: 'live',
    version: 1,
    requestId: 'srq-1',
    approvalId: 'a-1',
    command: 'rm -rf ./build',
    choices: ALL,
    allowSession: true,
    allowPermanent: true,
    state: 'open',
    ...over
  }
}

function sheet(item: ApprovalItem, props: { others?: ApprovalItem[]; tapGuardMs?: number } = {}) {
  const onRespond = vi.fn()
  const result = render(
    <section aria-labelledby="t" aria-describedby="d">
      <ApprovalSheet
        item={item}
        handle="researcher"
        name="Dr. Researcher"
        titleId="t"
        descriptionId="d"
        onRespond={onRespond}
        tapGuardMs={props.tapGuardMs ?? 0}
        {...(props.others ? { others: props.others } : {})}
      />
    </section>
  )

  return { ...result, onRespond }
}

const buttons = (): string[] => screen.getAllByRole('button').map(button => button.textContent ?? '')
const box = (): HTMLInputElement | null => screen.queryByRole('checkbox')

beforeEach(() => resetActiveLocale())
afterEach(() => vi.useRealTimers())

describe('offeredChoices', () => {
  // [allowSession, allowPermanent, smartDenied] → what is drawn from all four.
  const table: [boolean | undefined, boolean | undefined, boolean | undefined, string[]][] = [
    [true, true, undefined, ['once', 'session', 'always', 'deny']],
    [undefined, undefined, undefined, ['once', 'session', 'always', 'deny']],
    [false, true, undefined, ['once', 'always', 'deny']],
    [true, false, undefined, ['once', 'session', 'deny']],
    [false, false, undefined, ['once', 'deny']],
    [true, true, true, ['once', 'deny']],
    [false, true, true, ['once', 'deny']],
    [true, false, true, ['once', 'deny']],
    [false, false, true, ['once', 'deny']],
    [true, true, false, ['once', 'session', 'always', 'deny']]
  ]

  it.each(table)('allow_session %s, allow_permanent %s, smart_denied %s', (session, permanent, denied, expected) => {
    expect(
      offeredChoices({
        choices: ALL,
        ...(session === undefined ? {} : { allowSession: session }),
        ...(permanent === undefined ? {} : { allowPermanent: permanent }),
        ...(denied === undefined ? {} : { smartDenied: denied })
      })
    ).toEqual(expected)
  })

  it('keeps the gateway’s order and a choice it does not know', () => {
    expect(offeredChoices({ choices: ['deny', 'review', 'once'] })).toEqual(['deny', 'review', 'once'])
  })

  it('never offers more than the gateway listed, whatever the flags say', () => {
    expect(offeredChoices({ choices: ['once', 'deny'], allowSession: true, allowPermanent: true })).toEqual([
      'once',
      'deny'
    ])
  })

  it('falls back to once and deny when the flags would leave nothing to press', () => {
    expect(offeredChoices({ choices: ['always'], smartDenied: true })).toEqual(['once', 'deny'])
  })
})

describe('the choices on screen', () => {
  it('draws all four, says what the session and always choices mean, and no warning', () => {
    sheet(approval())

    expect(buttons()).toEqual(['Allow once', 'Allow for this session', 'Always allow', 'Deny'])
    expect(screen.getByText(/until the session ends/u)).toBeTruthy()
    expect(screen.getByText(/Always allow applies to this exact command/u)).toBeTruthy()
    expect(screen.queryByText(/safety check/u)).toBeNull()
  })

  it('without allow_session: no session choice and no word about it', () => {
    sheet(approval({ allowSession: false }))

    expect(buttons()).toEqual(['Allow once', 'Always allow', 'Deny'])
    expect(screen.queryByText(/until the session ends/u)).toBeNull()
    expect(screen.getByText(/Always allow applies/u)).toBeTruthy()
  })

  it('without allow_permanent: no always choice and no word about it', () => {
    sheet(approval({ allowPermanent: false }))

    expect(buttons()).toEqual(['Allow once', 'Allow for this session', 'Deny'])
    expect(screen.getByText(/until the session ends/u)).toBeTruthy()
    expect(screen.queryByText(/Always allow applies/u)).toBeNull()
  })

  it('with neither: once and deny', () => {
    sheet(approval({ allowSession: false, allowPermanent: false }))

    expect(buttons()).toEqual(['Allow once', 'Deny'])
    expect(screen.queryByText(/until the session ends/u)).toBeNull()
    expect(screen.queryByText(/Always allow applies/u)).toBeNull()
  })

  it('smart-denied: once and deny only, and the refusal is part of the dialog’s description', () => {
    sheet(approval({ smartDenied: true, allowPermanent: false }))

    expect(buttons()).toEqual(['Allow once', 'Deny'])

    const description = document.getElementById('d')

    expect(description?.textContent).toContain('@researcher wants to run one command')
    expect(description?.textContent).toContain('The gateway’s own safety check refused this command.')
    expect(screen.queryByText(/until the session ends/u)).toBeNull()
  })

  it('smart-denied with the engine’s fallback set (no choices sent): still never longer than once', () => {
    sheet(approval({ smartDenied: true, choices: ALL }))

    expect(buttons()).toEqual(['Allow once', 'Deny'])
  })

  it('answers with the choice pressed, and nothing else', () => {
    const { onRespond } = sheet(approval())

    fireEvent.click(screen.getByRole('button', { name: 'Allow for this session' }))
    fireEvent.click(screen.getByRole('button', { name: 'Always allow' }))

    expect(onRespond).toHaveBeenCalledExactlyOnceWith('session', [])
  })
})

describe('one answer for several', () => {
  const second = approval({ requestId: 'srq-2', approvalId: 'a-2', command: 'ls -la' })
  const third = approval({ requestId: 'srq-3', approvalId: 'a-3', command: 'cat notes.txt' })

  it('has no box when the bot has nothing else waiting', () => {
    sheet(approval(), { others: [] })

    expect(box()).toBeNull()
  })

  it('offers the box, off, naming how many and the bot in its own isolated span', () => {
    sheet(approval(), { others: [second, third] })

    expect(box()?.checked).toBe(false)
    expect(
      screen.getByText(sentence('Give the same answer to the 2 other approvals waiting from Dr. Researcher'))
    ).toBeTruthy()
    expect(document.querySelector('bdi')?.textContent).toBe('Dr. Researcher')
    // Off: the other commands are not listed, and a press answers this request alone.
    expect(screen.queryByText('ls -la')).toBeNull()
  })

  it('says one in the singular', () => {
    sheet(approval(), { others: [second] })

    expect(
      screen.getByText(sentence('Give the same answer to the other approval waiting from Dr. Researcher'))
    ).toBeTruthy()
  })

  it('answers this one alone while the box is off', () => {
    const { onRespond } = sheet(approval(), { others: [second, third] })

    fireEvent.click(screen.getByRole('button', { name: 'Allow once' }))

    expect(onRespond).toHaveBeenCalledExactlyOnceWith('once', [])
  })

  it('lists every command it covers while ticked, and answers exactly those', () => {
    const { onRespond } = sheet(approval(), { others: [second, third] })

    fireEvent.click(box()!)

    expect(screen.getByText('That answer also goes to:')).toBeTruthy()
    expect(screen.getByText('ls -la')).toBeTruthy()
    expect(screen.getByText('cat notes.txt')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Deny' }))

    expect(onRespond).toHaveBeenCalledExactlyOnceWith('deny', ['srq-2', 'srq-3'])
  })

  it('leaves out a smart-denied request: not counted, not listed, not answered', () => {
    const denied = approval({ requestId: 'srq-4', command: 'curl evil', smartDenied: true })
    const { onRespond } = sheet(approval(), { others: [second, denied] })

    expect(
      screen.getByText(sentence('Give the same answer to the other approval waiting from Dr. Researcher'))
    ).toBeTruthy()
    fireEvent.click(box()!)
    expect(screen.queryByText('curl evil')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Allow once' }))

    expect(onRespond).toHaveBeenCalledExactlyOnceWith('once', ['srq-2'])
  })

  it('has no box at all when this request is smart-denied', () => {
    sheet(approval({ smartDenied: true }), { others: [second, third] })

    expect(box()).toBeNull()
  })

  it('does not give a choice to a request that does not offer it', () => {
    const noAlways = approval({ requestId: 'srq-5', command: 'make deploy', allowPermanent: false })
    const { onRespond } = sheet(approval(), { others: [second, noAlways] })

    fireEvent.click(box()!)
    fireEvent.click(screen.getByRole('button', { name: 'Always allow' }))

    expect(onRespond).toHaveBeenCalledExactlyOnceWith('always', ['srq-2'])
  })

  it('puts the buttons back to sleep when the list it covers changes while ticked', () => {
    vi.useFakeTimers()

    const { onRespond, rerender } = sheet(approval(), { others: [second], tapGuardMs: 400 })

    act(() => vi.advanceTimersByTime(400))
    fireEvent.click(box()!)
    act(() => vi.advanceTimersByTime(400))
    expect(screen.getByRole('button', { name: 'Allow once' })).toHaveProperty('disabled', false)

    rerender(
      <section aria-labelledby="t" aria-describedby="d">
        <ApprovalSheet
          item={approval()}
          handle="researcher"
          name="Dr. Researcher"
          titleId="t"
          descriptionId="d"
          onRespond={onRespond}
          tapGuardMs={400}
          others={[second, third]}
        />
      </section>
    )

    // A command just joined the list: a press already on its way must not cover it.
    expect(screen.getByRole('button', { name: 'Allow once' })).toHaveProperty('disabled', true)
    // The box itself stays in reach, so the reader can take it back.
    expect(box()?.disabled).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Allow once' }))
    expect(onRespond).not.toHaveBeenCalled()

    act(() => vi.advanceTimersByTime(400))
    fireEvent.click(screen.getByRole('button', { name: 'Allow once' }))
    expect(onRespond).toHaveBeenCalledExactlyOnceWith('once', ['srq-2', 'srq-3'])
  })

  it('keeps the box asleep behind the first guard, like the buttons', () => {
    vi.useFakeTimers()
    sheet(approval(), { others: [second], tapGuardMs: 400 })

    expect(box()?.disabled).toBe(true)
    act(() => vi.advanceTimersByTime(400))
    expect(box()?.disabled).toBe(false)
  })

  it('shows the other commands as characters, never as Markdown', () => {
    const fancy = approval({ requestId: 'srq-6', command: 'echo **bold** [x](javascript:alert(1))' })

    sheet(approval(), { others: [fancy] })
    fireEvent.click(box()!)

    expect(screen.getByText('echo **bold** [x](javascript:alert(1))')).toBeTruthy()
    expect(document.querySelector('a, strong')).toBeNull()
  })
})
