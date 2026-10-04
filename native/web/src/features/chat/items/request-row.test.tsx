/**
 * The record in the transcript of a form, a file request or a draft the bot asked for: that it was asked, and how it
 * ended, in words, never what was answered.
 */
import type { RequestItem } from '@hermie/transcript'
import { cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { resetActiveLocale, setActiveLocale } from '../../../i18n/active-locale'
import { ChatItem } from './ChatItem'

beforeEach(() => resetActiveLocale())

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
    ['review.draft', 'Draft to review']
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
    [{ state: 'answered' }, 'Answered'],
    [{ state: 'cancelled', cancelReason: 'timeout' }, 'Timed out'],
    [{ state: 'cancelled', cancelReason: 'cannot_show' }, 'Could not be shown here'],
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
})
