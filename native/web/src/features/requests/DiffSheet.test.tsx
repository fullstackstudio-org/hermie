/**
 * The sheet for a `review.diff` request, in the request layer over the real interactive model and a hand-driven
 * connection: every line as it is (markers in a gutter, a tab kept, never a link), where a hunk lands (start, end, whole
 * file, and never the header's line numbers for the end), the overflow indicator for a row wider than the view, a
 * decision per hunk and for all of them, the answer that is sent only when every hunk is decided, and the guard.
 */
import { JsonRpcGatewayError } from '@hermes/shared/json-rpc-channel'
import { act, fireEvent, screen, within } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { REFUSED_CODE } from '../../core/requests/interactive'
import {
  button,
  dialog,
  diffFrame,
  type Harness,
  lastAnswer,
  mount,
  queryButton,
  raise,
  setup,
  teardown
} from '../../test-support/interactive-layer'
import { interactiveStore } from '../../state/interactive'
import { preloadRequestSheets } from './request-sheets'

beforeAll(async () => {
  await preloadRequestSheets()
})

let harness: Harness

beforeEach(() => {
  harness = setup()
})

afterEach(() => {
  vi.restoreAllMocks()
  teardown(harness)
})

const press = async (name: string | RegExp): Promise<void> => {
  await act(async () => {
    fireEvent.click(button(name))
  })
}

const hunkEl = (id: string): HTMLElement => {
  const element = dialog().querySelector<HTMLElement>(`[data-hunk="${id}"]`)

  if (!element) {
    throw new Error(`no hunk ${id}`)
  }

  return element
}

const decide = async (id: string, choice: 'approved' | 'rejected'): Promise<void> => {
  await act(async () => {
    fireEvent.click(hunkEl(id).querySelector<HTMLElement>(`[data-choice="${choice}"]`) as HTMLElement)
  })
}

const sendButton = (): HTMLButtonElement =>
  dialog().querySelector<HTMLButtonElement>('[data-send]') as HTMLButtonElement

describe('the sheet', () => {
  it('names the gateway, the file and what kind of change it is, in the app’s words', () => {
    mount(harness)
    raise(harness, 'srq-1', 'review.diff', diffFrame())

    expect(screen.getByRole('dialog', { name: 'Changes to review' })).toBe(dialog())
    expect(dialog().textContent).toContain('On gateway gw.example.test')
    expect(dialog().querySelector('.hm-review__path')?.textContent).toBe('app/settings.py')
    expect(dialog().querySelector('[data-file-kind]')?.textContent).toBe('Changed file')
    // The bot's own words are quoted as the bot's.
    expect(dialog().textContent).toContain('Changes to settings.py')
    expect(dialog().textContent).toContain('I changed the default currency and the retry limit.')
    expect(dialog().textContent).toContain('The text of the changes stays with the gateway.')
  })

  it('shows a rename as the old path, an arrow and the new one, a new file and a deleted file as what they are', () => {
    mount(harness)
    raise(
      harness,
      'srq-1',
      'review.diff',
      diffFrame({
        kind: 'rename',
        path: 'app/accounts.py',
        old_path: 'app/users.py',
        hunks: [
          {
            id: 'h1',
            header: '@@ -1,3 +1,3 @@',
            lines: [' import db', '-TABLE = "users"', '+TABLE = "accounts"', ' '],
            anchor: 'start'
          }
        ]
      })
    )

    expect(dialog().querySelector('.hm-review__path')?.textContent).toBe('app/users.py → app/accounts.py')
    expect(dialog().querySelector('[data-file-kind]')?.textContent).toBe('Renamed file')
    // Each path is an isolated left-to-right element of its own: neither can reorder the other or the arrow.
    const parts = Array.from(dialog().querySelectorAll('.hm-review__path > bdi'))

    expect(parts.map(part => part.textContent)).toEqual(['app/users.py', 'app/accounts.py'])
    expect(parts.map(part => part.getAttribute('dir'))).toEqual(['ltr', 'ltr'])
    expect(parts[0]).not.toBe(parts[1])
    expect(parts[0]?.contains(parts[1] ?? null)).toBe(false)
  })

  it.each([
    ['new', '@@ -0,0 +1,1 @@', ['+hello'], 'New file'],
    ['delete', '@@ -1,1 +0,0 @@', ['-hello'], 'Delete file']
  ])('says a %s file is one', (kind, header, lines, word) => {
    mount(harness)
    raise(harness, 'srq-1', 'review.diff', diffFrame({ kind, hunks: [{ id: 'h1', header, lines, anchor: 'both' }] }))

    expect(dialog().querySelector('[data-file-kind]')?.textContent).toBe(word)
    expect(hunkEl('h1').querySelector('.hm-review__anchor')?.textContent).toBe('Whole file')
  })

  it('offers no Skip: the person decides every hunk', () => {
    mount(harness)
    raise(harness, 'srq-1', 'review.diff', diffFrame({ optional: true }))

    expect(queryButton('Skip')).toBeNull()
    expect(queryButton('Later')).toBeTruthy()
  })
})

describe('the lines', () => {
  it('are monospaced rows with the marker in a gutter apart from the text, and nothing trimmed', () => {
    mount(harness)
    raise(harness, 'srq-1', 'review.diff', diffFrame())

    const rows = Array.from(hunkEl('h1').querySelectorAll<HTMLElement>('.hm-review__row'))

    expect(rows.map(row => row.dataset.type)).toEqual(['context', 'removed', 'added', 'context', 'context'])
    expect(rows.map(row => row.querySelector('.hm-review__marker')?.textContent)).toEqual([' ', '-', '+', ' ', ' '])
    expect(rows.map(row => row.querySelector('.hm-review__text')?.textContent)).toEqual([
      '    name = "booking"',
      '    currency = "USD"',
      '    currency = "EUR"',
      '    locale = "nl-NL"',
      '    debug = False'
    ])
    // The marker is not part of the text and not read out; a word says what the line is instead of its colour.
    expect(rows[1]?.querySelector('.hm-review__marker')?.getAttribute('aria-hidden')).toBe('true')
    expect(rows[1]?.querySelector('.hm-review__kind-word')?.textContent).toBe('Removed line: ')
    expect(rows[2]?.querySelector('.hm-review__kind-word')?.textContent).toBe('Added line: ')
    expect(rows[0]?.querySelector('.hm-review__kind-word')?.textContent).toBe('Unchanged line: ')
  })

  it('keeps a tab a tab, for the stylesheet to draw as a stop of 8 columns', () => {
    mount(harness)
    raise(
      harness,
      'srq-1',
      'review.diff',
      diffFrame({
        hunks: [
          { id: 'h1', header: '@@ -5,2 +5,3 @@ func main() {', lines: [' func main() {', '+\t\tfmt.Println(i)', ' }'] }
        ]
      })
    )

    const text = Array.from(hunkEl('h1').querySelectorAll('.hm-review__text')).map(element => element.textContent)

    expect(text[1]).toBe('\t\tfmt.Println(i)')
  })

  it('never renders anything in a line: no markup, no link, no formatting', () => {
    mount(harness)
    raise(
      harness,
      'srq-1',
      'review.diff',
      diffFrame({
        hunks: [
          {
            id: 'h1',
            header: '@@ -5,2 +5,3 @@',
            lines: [' x', '+**bold** [a link](https://evil.test) <b>tag</b> https://evil.test', ' y']
          }
        ]
      })
    )

    expect(hunkEl('h1').querySelector('a, b, strong, em')).toBeNull()
    expect(dialog().querySelector('a')).toBeNull()
    expect(hunkEl('h1').textContent).toContain('**bold** [a link](https://evil.test) <b>tag</b> https://evil.test')
  })

  it('draws git’s no-newline note as the note it is, after the line it belongs to', () => {
    mount(harness)
    raise(
      harness,
      'srq-1',
      'review.diff',
      diffFrame({
        kind: 'new',
        hunks: [
          {
            id: 'h1',
            header: '@@ -0,0 +1,2 @@',
            lines: ['+First', '+Second', '\\ No newline at end of file'],
            anchor: 'both'
          }
        ]
      })
    )

    const rows = Array.from(hunkEl('h1').querySelectorAll<HTMLElement>('.hm-review__row'))

    expect(rows.map(row => row.dataset.type)).toEqual(['added', 'added', 'note'])
    expect(rows[2]?.querySelector('.hm-review__text')?.textContent).toBe('\\ No newline at end of file')
  })

  it('takes the keyboard: the box of a hunk’s lines is a named region in the tab order', () => {
    mount(harness)
    raise(harness, 'srq-1', 'review.diff', diffFrame())

    const region = within(hunkEl('h1')).getByRole('region', { name: 'Lines of change 1' })

    expect(region.getAttribute('tabindex')).toBe('0')
    expect(within(hunkEl('h2')).getByRole('region', { name: 'Lines of change 2' })).toBeTruthy()
  })
})

describe('where a hunk lands', () => {
  const frame = (hunks: unknown[]): Record<string, unknown> => diffFrame({ hunks })

  it('shows the header as it is for a hunk that is not pinned, with no label', () => {
    mount(harness)
    raise(harness, 'srq-1', 'review.diff', diffFrame())

    expect(hunkEl('h1').querySelector('.hm-review__header')?.textContent).toBe('@@ -3,4 +3,4 @@ class Settings:')
    expect(hunkEl('h1').querySelector('.hm-review__anchor')).toBeNull()
  })

  it('says "Start of the file" next to the header of a hunk at the top', () => {
    mount(harness)
    raise(
      harness,
      'srq-1',
      'review.diff',
      frame([{ id: 'h1', header: '@@ -1,3 +1,3 @@ import', lines: [' import db', '-a', '+b', ' c'], anchor: 'start' }])
    )

    expect(hunkEl('h1').querySelector('.hm-review__anchor')?.textContent).toBe('Start of the file')
    expect(hunkEl('h1').querySelector('.hm-review__header')?.textContent).toBe('@@ -1,3 +1,3 @@ import')
  })

  it('says "End of the file" for a hunk at the bottom, and does NOT draw the header’s line numbers as where it lands', () => {
    mount(harness)
    raise(
      harness,
      'srq-1',
      'review.diff',
      frame([
        { id: 'h1', header: '@@ -3,1 +3,2 @@ def tail():', lines: [' Second line', '+Third line'], anchor: 'end' }
      ])
    )

    expect(hunkEl('h1').querySelector('.hm-review__anchor')?.textContent).toBe('End of the file')
    // The section text stays (the function it is in); the numbers of a header that does not say where it goes do not.
    expect(hunkEl('h1').querySelector('.hm-review__header')?.textContent).toBe('def tail():')
    expect(hunkEl('h1').textContent).not.toMatch(/@@|-3,1|\+3,2/u)
  })

  it('says "End of the file" even when the gateway did not pin it: the lines say where it goes', () => {
    mount(harness)
    raise(
      harness,
      'srq-1',
      'review.diff',
      frame([{ id: 'h1', header: '@@ -3,1 +3,2 @@', lines: [' Second line', '+Third line'] }])
    )

    expect(hunkEl('h1').querySelector('.hm-review__anchor')?.textContent).toBe('End of the file')
    expect(hunkEl('h1').querySelector('.hm-review__header')).toBeNull()
  })

  it('says "Whole file" for a hunk that is the whole file', () => {
    mount(harness)
    raise(
      harness,
      'srq-1',
      'review.diff',
      frame([{ id: 'h1', header: '@@ -1,2 +1,2 @@', lines: ['-a', '-b', '+c', '+d'], anchor: 'both' }])
    )

    expect(hunkEl('h1').querySelector('.hm-review__anchor')?.textContent).toBe('Whole file')
  })
})

describe('a row wider than the view', () => {
  const wide = (): void => {
    vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockReturnValue(900)
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(300)
  }

  it('is said to be: a line of words, the box described by it, and the edge that has more marked', () => {
    wide()
    mount(harness)
    raise(harness, 'srq-1', 'review.diff', diffFrame())

    const note = hunkEl('h1').querySelector<HTMLElement>('[data-wide]')

    expect(note?.textContent).toBe('Some lines are wider than the view. Scroll sideways to read all of them.')

    const region = hunkEl('h1').querySelector<HTMLElement>('.hm-review__lines') as HTMLElement

    expect(region.getAttribute('aria-describedby')).toBe(note?.id)
    expect(region.dataset.overflow).toBe('true')
    // At the start of the scroll there is more to the end, none before.
    expect(hunkEl('h1').querySelector('.hm-review__frame')?.hasAttribute('data-more-end')).toBe(true)
    expect(hunkEl('h1').querySelector('.hm-review__frame')?.hasAttribute('data-more-start')).toBe(false)
  })

  it('marks the edge before it once the box is scrolled, and the end when it is at the end', () => {
    wide()
    mount(harness)
    raise(harness, 'srq-1', 'review.diff', diffFrame())

    const region = hunkEl('h1').querySelector<HTMLElement>('.hm-review__lines') as HTMLElement
    const frame = hunkEl('h1').querySelector('.hm-review__frame') as HTMLElement

    region.scrollLeft = 200
    fireEvent.scroll(region)

    expect(frame.hasAttribute('data-more-start')).toBe(true)
    expect(frame.hasAttribute('data-more-end')).toBe(true)

    region.scrollLeft = 600
    fireEvent.scroll(region)

    expect(frame.hasAttribute('data-more-start')).toBe(true)
    expect(frame.hasAttribute('data-more-end')).toBe(false)
  })

  it('says nothing when every row fits', () => {
    mount(harness)
    raise(harness, 'srq-1', 'review.diff', diffFrame())

    expect(dialog().querySelector('[data-wide]')).toBeNull()
    expect(hunkEl('h1').querySelector('.hm-review__lines')?.hasAttribute('data-overflow')).toBe(false)
  })

  it('never cuts a long row: the whole text is in the page, for the box to scroll', () => {
    const long = `${'x'.repeat(480)}END`

    mount(harness)
    raise(
      harness,
      'srq-1',
      'review.diff',
      diffFrame({ hunks: [{ id: 'h1', header: '@@ -5,2 +5,3 @@', lines: [' a', `+${long}`, ' b'] }] })
    )

    expect(hunkEl('h1').textContent).toContain(long)
  })
})

describe('deciding', () => {
  it('starts with nothing decided, and will not send until every hunk is', async () => {
    mount(harness)
    raise(harness, 'srq-1', 'review.diff', diffFrame())

    expect(sendButton().disabled).toBe(true)
    expect(sendButton().textContent).toBe('Send decision')
    expect(dialog().querySelector('[data-progress]')?.textContent).toBe('0 approved, 0 rejected, 2 undecided')
    expect(within(dialog()).getByText('Approve or reject every change before you send (2 left).')).toBeTruthy()
    expect(sendButton().getAttribute('aria-describedby')).toBeTruthy()

    await decide('h1', 'approved')

    expect(sendButton().disabled).toBe(true)
    expect(dialog().querySelector('[data-progress]')?.textContent).toBe('1 approved, 0 rejected, 1 undecided')
    expect(harness.gw.calls).toEqual([])
  })

  it('takes a decision per hunk as a toggle: pressed says which, and it can be changed', async () => {
    mount(harness)
    raise(harness, 'srq-1', 'review.diff', diffFrame())

    const approve = (id: string): HTMLElement => hunkEl(id).querySelector('[data-choice="approved"]') as HTMLElement
    const reject = (id: string): HTMLElement => hunkEl(id).querySelector('[data-choice="rejected"]') as HTMLElement

    expect(approve('h1').getAttribute('aria-pressed')).toBe('false')
    expect(reject('h1').getAttribute('aria-pressed')).toBe('false')
    // The names start with the visible word and say which hunk.
    expect(approve('h1').getAttribute('aria-label')).toBe('Approve change 1 of 2')
    expect(reject('h2').getAttribute('aria-label')).toBe('Reject change 2 of 2')

    await decide('h1', 'approved')

    expect(approve('h1').getAttribute('aria-pressed')).toBe('true')
    expect(reject('h1').getAttribute('aria-pressed')).toBe('false')
    expect(hunkEl('h1').dataset.decision).toBe('approved')

    await decide('h1', 'rejected')

    expect(approve('h1').getAttribute('aria-pressed')).toBe('false')
    expect(reject('h1').getAttribute('aria-pressed')).toBe('true')
    expect(hunkEl('h2').dataset.decision).toBeUndefined()
  })

  it('sends one hunk approved and one rejected: approved, with an entry for each', async () => {
    mount(harness)
    raise(harness, 'srq-1', 'review.diff', diffFrame())
    await decide('h1', 'approved')
    await decide('h2', 'rejected')

    expect(sendButton().disabled).toBe(false)
    expect(sendButton().textContent).toBe('Apply 1 of 2 changes')

    await press('Apply 1 of 2 changes')

    expect(lastAnswer(harness)).toEqual({ decision: 'approved', hunks: { h1: 'approved', h2: 'rejected' } })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('sends the other way round just as well', async () => {
    mount(harness)
    raise(harness, 'srq-1', 'review.diff', diffFrame())
    await decide('h2', 'approved')
    await decide('h1', 'rejected')
    await press(/^Apply 1 of 2/u)

    expect(lastAnswer(harness)).toEqual({ decision: 'approved', hunks: { h1: 'rejected', h2: 'approved' } })
  })

  it('approves all, and sends every hunk approved', async () => {
    mount(harness)
    raise(harness, 'srq-1', 'review.diff', diffFrame())
    await press('Approve all')

    expect(dialog().querySelector('[data-progress]')?.textContent).toBe('2 approved, 0 rejected, 0 undecided')
    expect(sendButton().textContent).toBe('Apply 2 of 2 changes')

    await press('Apply 2 of 2 changes')

    expect(lastAnswer(harness)).toEqual({ decision: 'approved', hunks: { h1: 'approved', h2: 'approved' } })
  })

  it('rejects all, and sends the rejection of every hunk', async () => {
    mount(harness)
    raise(harness, 'srq-1', 'review.diff', diffFrame())
    await press('Reject all')

    expect(sendButton().textContent).toBe('Reject everything and send')

    await press('Reject everything and send')

    expect(lastAnswer(harness)).toEqual({ decision: 'rejected', hunks: { h1: 'rejected', h2: 'rejected' } })
  })

  it('lets a bulk decision be corrected hunk by hunk', async () => {
    mount(harness)
    raise(harness, 'srq-1', 'review.diff', diffFrame())
    await press('Approve all')
    await decide('h2', 'rejected')
    await press('Apply 1 of 2 changes')

    expect(lastAnswer(harness)).toEqual({ decision: 'approved', hunks: { h1: 'approved', h2: 'rejected' } })
  })

  it('answers with a key for every hunk of a diff of many', async () => {
    const hunks = Array.from({ length: 12 }, (_, index) => ({
      id: `h${index + 1}`,
      header: `@@ -${index * 10 + 5},3 +${index * 10 + 5},3 @@`,
      lines: [' before', '-old', '+new', ' after']
    }))

    mount(harness)
    raise(harness, 'srq-1', 'review.diff', diffFrame({ hunks }))

    for (let index = 1; index <= 12; index += 1) {
      await decide(`h${index}`, index % 3 === 0 ? 'rejected' : 'approved')
    }

    await press(/^Apply 8 of 12/u)

    const answer = lastAnswer(harness) as { decision: string; hunks: Record<string, string> }

    expect(answer.decision).toBe('approved')
    expect(Object.keys(answer.hunks)).toEqual(hunks.map(entry => entry.id))
    expect(Object.values(answer.hunks).filter(value => value === 'rejected')).toHaveLength(4)
  })

  it('sends nothing but the decision and the hunks: no text, no path, no line', async () => {
    mount(harness)
    raise(harness, 'srq-1', 'review.diff', diffFrame())
    await press('Approve all')
    await press('Apply 2 of 2 changes')

    const answer = lastAnswer(harness) ?? {}

    expect(Object.keys(answer).sort()).toEqual(['decision', 'hunks'])
    expect(JSON.stringify(answer)).not.toContain('settings')
    expect(JSON.stringify(answer)).not.toContain('currency')
  })
})

describe('the gateway’s refusal', () => {
  it('is shown as the gateway gave it, keeps what was decided, and lets the person try again', async () => {
    mount(harness)
    raise(harness, 'srq-1', 'review.diff', diffFrame())
    await press('Approve all')
    harness.gw.onCall.handler = () => {
      throw new JsonRpcGatewayError('refused', { code: REFUSED_CODE, data: { reason: 'bad_shape' } })
    }
    await press('Apply 2 of 2 changes')

    expect(within(dialog()).getByRole('alert').textContent).toBe('The gateway did not accept this answer (bad_shape).')
    expect(dialog().querySelector('[data-progress]')?.textContent).toBe('2 approved, 0 rejected, 0 undecided')

    harness.gw.onCall.handler = () => ({ status: 'ok' })
    await press('Apply 2 of 2 changes')

    expect(screen.queryByRole('dialog')).toBeNull()
  })
})

describe('the guard and the connection', () => {
  it('takes nothing for a moment after it appears', async () => {
    mount(harness, { tapGuardMs: 40 })
    raise(harness, 'srq-1', 'review.diff', diffFrame())

    for (const element of dialog().querySelectorAll<HTMLButtonElement>('[data-choice], [data-bulk]')) {
      expect(element.disabled).toBe(true)
    }

    await act(async () => {
      await new Promise<void>(resolve => setTimeout(resolve, 100))
    })

    for (const element of dialog().querySelectorAll<HTMLButtonElement>('[data-choice], [data-bulk]')) {
      expect(element.disabled).toBe(false)
    }
  })

  it('says so and keeps the decisions when the connection is down', async () => {
    mount(harness)
    raise(harness, 'srq-1', 'review.diff', diffFrame())
    await press('Approve all')
    act(() => harness.gw.status('connecting'))
    await press('Apply 2 of 2 changes')

    expect(within(dialog()).getByText(/Not connected to the gateway/u)).toBeTruthy()
    expect(harness.gw.calls).toEqual([])
    expect(dialog().querySelector('[data-progress]')?.textContent).toBe('2 approved, 0 rejected, 0 undecided')
  })

  it('puts the sheet away on Escape without answering: the request waits', () => {
    mount(harness)
    raise(harness, 'srq-1', 'review.diff', diffFrame())
    fireEvent.keyDown(dialog(), { key: 'Escape' })

    expect(screen.queryByRole('dialog')).toBeNull()
    expect(harness.gw.calls).toEqual([])
    expect(interactiveStore.getState().requests).toHaveLength(1)
  })

  it('answers once however often it is sent, and keeps its buttons off while the answer is on its way', async () => {
    mount(harness)
    raise(harness, 'srq-1', 'review.diff', diffFrame())
    await press('Approve all')

    let release: (value: unknown) => void = () => undefined

    harness.gw.onCall.handler = () => new Promise(resolve => (release = resolve))

    await act(async () => {
      fireEvent.click(sendButton())
      fireEvent.click(sendButton())
    })

    expect(harness.gw.calls).toHaveLength(1)
    expect(sendButton().disabled).toBe(true)
    expect((hunkEl('h1').querySelector('[data-choice]') as HTMLButtonElement).disabled).toBe(true)

    await act(async () => release({ status: 'ok' }))

    expect(screen.queryByRole('dialog')).toBeNull()
  })
})

describe('what is not a diff it can show', () => {
  it('declines a frame whose hunk says one thing and does another, and shows nothing of it', () => {
    mount(harness)
    raise(
      harness,
      'srq-1',
      'review.diff',
      diffFrame({
        hunks: [{ id: 'h1', header: '@@ -3,4 +3,4 @@', lines: [' a', '-b', '+c', ' d'], anchor: 'end' }]
      })
    )

    expect(screen.queryByRole('dialog')).toBeNull()
    expect(harness.gw.declined).toEqual([
      { id: 'srq-1', code: 4041, message: 'cannot_show', reason: 'not_supported_on_device' }
    ])
  })
})
