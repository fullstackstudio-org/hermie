/**
 * The record in the transcript of a form, a file request or a draft the bot asked for: that it was asked, and how it
 * ended, in words, never what was answered.
 */
import type { RequestItem } from '@hermie/transcript'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { resetActiveLocale, setActiveLocale } from '../../../i18n/active-locale'
import { requestLaterStore } from '../../../state/request-later'
import { interactiveKey } from '../../../state/requests'
import { ChatItem } from './ChatItem'

beforeEach(() => {
  resetActiveLocale()
  requestLaterStore.getState().reset()
})

afterEach(() => {
  cleanup()
  resetActiveLocale()
})

const item = (extra: Partial<RequestItem> = {}): RequestItem =>
  ({
    id: 'req:srq-1',
    kind: 'request',
    requestId: 'srq-1',
    method: 'input.form',
    title: 'Hotel **booking**',
    summary: 'Fill this in.',
    optional: true,
    state: 'open',
    ts: 1,
    ...extra
  }) as RequestItem

const draw = (request: RequestItem): HTMLElement => {
  const view = render(<ChatItem row={{ item: request, presentation: 'full' }} />)

  return view.container.querySelector('[data-kind="request"]') as HTMLElement
}

describe('a request in the transcript', () => {
  it('says what kind it is, with the bot’s heading as plain text, and that it waits', () => {
    const article = draw(item())

    expect(article.querySelector('.hm-aside__eyebrow')?.textContent).toBe('Form')
    expect(article.querySelector('.hm-aside__text')?.textContent).toBe('Hotel **booking**\nWaiting for your answer')
    expect(article.querySelector('strong, a')).toBeNull()
  })

  it.each([
    ['input.form', 'Form'],
    ['input.file', 'File request'],
    ['review.draft', 'Draft to review'],
    ['review.diff', 'Changes to review']
  ])('tells %s apart', (method, eyebrow) => {
    expect(draw(item({ method })).querySelector('.hm-aside__eyebrow')?.textContent).toBe(eyebrow)
  })

  it.each<[Partial<RequestItem>, string]>([
    [{ state: 'answered', answerSummary: { status: 'answered' } }, 'Answered'],
    [{ state: 'answered', answerSummary: { status: 'skipped' } }, 'Skipped'],
    [{ state: 'answered', answerSummary: { status: 'answered', count: 1 } }, '1 file sent'],
    [{ state: 'answered', answerSummary: { status: 'answered', count: 3 } }, '3 files sent'],
    [{ state: 'answered', answerSummary: { decision: 'approved' } }, 'Approved'],
    [{ state: 'answered', answerSummary: { decision: 'approved', edited: true } }, 'Approved with changes'],
    [{ state: 'answered', answerSummary: { decision: 'rejected' } }, 'Rejected'],
    [
      { state: 'answered', answerSummary: { decision: 'approved', approvedHunks: 1, rejectedHunks: 2 } },
      '1 of 3 hunks approved'
    ],
    [
      { state: 'answered', answerSummary: { decision: 'approved', approvedHunks: 1, rejectedHunks: 0 } },
      '1 of 1 hunk approved'
    ],
    [{ state: 'answered', answerSummary: { decision: 'rejected', approvedHunks: 0, rejectedHunks: 2 } }, 'Rejected'],
    [{ state: 'answered' }, 'Answered'],
    [{ state: 'cancelled', cancelReason: 'timeout' }, 'Timed out'],
    [{ state: 'cancelled', cancelReason: 'cannot_show' }, 'Could not be shown here'],
    [{ state: 'cancelled', cancelReason: 'declined' }, 'Not shared'],
    [{ state: 'cancelled', cancelReason: 'withdrawn' }, 'Withdrawn'],
    [{ state: 'cancelled' }, 'Withdrawn']
  ])('says how it ended: %j', (extra, line) => {
    expect(draw(item(extra)).querySelector('.hm-aside__text')?.textContent).toBe(`Hotel **booking**\n${line}`)
  })

  it('is said in the reader’s language', () => {
    setActiveLocale('nl')

    const article = draw(item({ state: 'answered', answerSummary: { status: 'skipped' } }))

    expect(article.querySelector('.hm-aside__eyebrow')?.textContent).toBe('Formulier')
    expect(article.querySelector('.hm-aside__text')?.textContent).toContain('Overgeslagen')
  })

  it('offers Open on a request whose sheet was put away, and brings the sheet back', () => {
    const article = draw(item())

    expect(article.querySelector('button')).toBeNull()

    act(() => requestLaterStore.getState().putAway(interactiveKey('srq-1')))

    expect(article.querySelector('.hm-aside__text')?.textContent).toBe('Hotel **booking**\nPut away for later')

    fireEvent.click(screen.getByRole('button', { name: 'Open Hotel **booking**' }))

    expect(requestLaterStore.getState().away).toEqual([])
    expect(article.querySelector('button')).toBeNull()
  })

  it('offers no Open on a request that ended while its sheet was away', () => {
    requestLaterStore.getState().putAway(interactiveKey('srq-1'))

    expect(draw(item({ state: 'cancelled', cancelReason: 'timeout' })).querySelector('button')).toBeNull()
  })
})
