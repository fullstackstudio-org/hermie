/**
 * A `confirm` at level `passkey` in the request layer: the text exactly as the
 * frame carried it, the fixed frame around it, the tap guard, Escape, every phase
 * the passkey model reports, and the notices. The model is a handful of spies
 * over its store (`state/passkeys.ts`); its own rules are `core/passkey`'s tests.
 */
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import axe from 'axe-core'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { resetActiveLocale } from '../../i18n/active-locale'
import { setLanguageChoice } from '../../i18n/locale'
import { chatsStore } from '../../state/chats'
import {
  type ConfirmPhase,
  createPasskeysStore,
  type PasskeyConfirmation,
  type PasskeysState
} from '../../state/passkeys'
import { bindRequests, requestsStore } from '../../state/requests'
import { chatWith } from '../../test-support/chat-fixtures'
import { sentence } from '../../test-support/sentence'
import { aBot, resetShellStores, seedRoster } from '../../test-support/shell-stores'
import type { StoreApi } from 'zustand/vanilla'
import { type PasskeyActions, PasskeyRuntimeContext } from './passkey-runtime'
import { RequestLayer } from './RequestLayer'
import { preloadRequestSheets } from './request-sheets'

const DETAIL = 'rm -rf /srv/backups/2024-*\n    keep:  /srv/backups/latest\n\ttabbed'
/** `DETAIL` as the sheet draws it: its space runs and its tab made visible (`verbatim-detail.ts`). */
const DRAWN = 'rm -rf /srv/backups/2024-*\n····keep:··/srv/backups/latest\n→tabbed'

let passkeys: StoreApi<PasskeysState>
let stop: () => void = () => undefined
let actions: { [K in keyof PasskeyActions]: ReturnType<typeof vi.fn> }

const confirmation = (overrides: Partial<PasskeyConfirmation> = {}): PasskeyConfirmation => ({
  id: 'srq-1',
  sessionId: 'rt-1',
  title: 'Delete backups',
  summary: 'Delete 3 old backups.\nThe newest stays.',
  detail: DETAIL,
  baseUrl: 'https://gw.example.test',
  userName: 'Alex',
  expiresAt: 4_102_444_800,
  phase: { kind: 'waiting' },
  answerMayHaveArrived: false,
  version: 1,
  dismissed: false,
  ...overrides
})

let version = 1

// The sheets are a chunk of their own (`request-sheets.ts`), which the page fetches when the session starts;
// once it is in memory a confirmation's sheet is drawn in the same pass.
beforeAll(async () => {
  await preloadRequestSheets()
})

const show = (overrides: Partial<PasskeyConfirmation> = {}): Promise<void> =>
  act(async () => {
    version += 1
    passkeys.setState({ confirmations: [confirmation({ version, ...overrides })] })
  })

const phase = (next: ConfirmPhase, dismissed = false): Promise<void> => show({ phase: next, dismissed })

beforeEach(() => {
  resetShellStores()
  document.documentElement.lang = 'en'
  document.title = 'Hermie'
  requestsStore.getState().reset()
  seedRoster([aBot('researcher', { displayName: 'Dr. Researcher' })])
  chatsStore.getState().hydrate('researcher', chatWith('researcher', [], { runtimeSessionId: 'rt-1' }))
  chatsStore.getState().bindRuntime('researcher', 'rt-1')
  passkeys = createPasskeysStore()
  passkeys.setState({ rpId: 'gw.example.test', supported: true })
  stop = bindRequests(chatsStore, requestsStore, passkeys)
  actions = {
    confirm: vi.fn(async () => undefined),
    decline: vi.fn(async () => undefined),
    dismiss: vi.fn(),
    expire: vi.fn(),
    dismissNotice: vi.fn(),
    refresh: vi.fn(async () => undefined),
    enrol: vi.fn(),
    mintInvite: vi.fn(),
    revoke: vi.fn(),
    forgetPin: vi.fn(),
    startSelfEnrolment: vi.fn(),
    finishSelfEnrolment: vi.fn(),
    cancelSelfEnrolment: vi.fn()
  }
})

afterEach(() => {
  stop()
  vi.useRealTimers()
  resetActiveLocale()
})

function mount(tapGuardMs = 0) {
  return render(
    <PasskeyRuntimeContext.Provider value={actions as unknown as PasskeyActions}>
      <main>
        <button type="button">Behind</button>
      </main>
      <RequestLayer passkeys={passkeys} tapGuardMs={tapGuardMs} />
    </PasskeyRuntimeContext.Provider>
  )
}

const dialog = (): HTMLElement => screen.getByRole('dialog')
const confirmButton = (): HTMLElement => within(dialog()).getByRole('button', { name: 'Confirm with passkey' })
const declineButton = (): HTMLElement => within(dialog()).getByRole('button', { name: 'Decline' })

describe('the confirm sheet', () => {
  it('shows the gateway’s text verbatim inside a fixed frame', async () => {
    mount()
    await show()

    expect(dialog().getAttribute('aria-modal')).toBe('true')
    expect(within(dialog()).getByText(sentence('From Dr. Researcher'))).toBeTruthy()
    expect(within(dialog()).getByRole('heading', { name: 'Delete backups' })).toBeTruthy()
    expect(dialog().getAttribute('aria-describedby')).toBeTruthy()
    expect(document.getElementById(dialog().getAttribute('aria-describedby') as string)?.textContent).toBe(
      'gw.example.test asks you to confirm this with your passkey.'
    )

    const summary = dialog().querySelector('.hm-requests__summary')

    expect(summary?.textContent).toBe('Delete 3 old backups.\nThe newest stays.')

    // Every line break, and every space run and tab drawn visibly, in a preformatted, focusable, labelled region.
    const detail = within(dialog()).getByLabelText('Details')

    expect(detail.tagName).toBe('PRE')
    expect(detail.getAttribute('role')).toBe('region')
    expect(detail.classList.contains('hm-requests__detail')).toBe(true)
    expect(detail.textContent).toBe(DRAWN)
    expect(detail.tabIndex).toBe(0)
    // Its name carries the drawn text, markers included, so a screen reader announces them too.
    expect(within(dialog()).getByRole('region', { name: name => name.includes('····keep:··') })).toBe(detail)
    // Only the drawing: what the model holds (and the challenge commits to) is the frame's text.
    expect(passkeys.getState().confirmations[0]?.detail).toBe(DETAIL)
    expect(within(dialog()).getByText('Your browser will ask for your passkey for gw.example.test.')).toBeTruthy()
  })

  it('never reads the text as Markdown', async () => {
    mount()
    await show({ title: '**Pay** [now](https://evil.example)', summary: '# Heading\n`code`', detail: '<b>bold</b>' })

    expect(within(dialog()).getByRole('heading', { name: '**Pay** [now](https://evil.example)' })).toBeTruthy()
    expect(dialog().querySelector('a, b, code, h1')).toBeNull()
    expect(within(dialog()).getByLabelText('Details').textContent).toBe('<b>bold</b>')
  })

  it('wakes its buttons only after the tap guard', async () => {
    vi.useFakeTimers()
    mount(400)
    await show()

    expect(confirmButton()).toHaveProperty('disabled', true)
    expect(declineButton()).toHaveProperty('disabled', true)
    fireEvent.click(confirmButton())
    expect(actions.confirm).not.toHaveBeenCalled()

    act(() => void vi.advanceTimersByTime(400))

    expect(confirmButton()).toHaveProperty('disabled', false)
    fireEvent.click(confirmButton())
    expect(actions.confirm).toHaveBeenCalledWith('srq-1')
  })

  it('declines through the model', async () => {
    mount()
    await show()

    fireEvent.click(declineButton())

    expect(actions.decline).toHaveBeenCalledWith('srq-1')
  })

  it('is not dismissed by Escape', async () => {
    mount()
    await show()

    fireEvent.keyDown(dialog(), { key: 'Escape' })

    expect(dialog()).toBeTruthy()
    expect(actions.dismiss).not.toHaveBeenCalled()
  })

  it('says where the confirmation stands, and offers only what fits', async () => {
    mount()
    await show()

    await phase({ kind: 'signing' })
    expect(within(dialog()).getByRole('status').textContent).toBe('Waiting for your passkey…')
    expect(confirmButton()).toHaveProperty('disabled', true)

    await phase({ kind: 'sending' })
    expect(within(dialog()).getByRole('status').textContent).toBe('Sending…')

    await phase({ kind: 'refused', reason: 'signature_invalid' })
    expect(within(dialog()).getByRole('status').textContent).toBe(
      'The gateway did not accept this answer (signature_invalid). You can try again.'
    )
    expect(confirmButton()).toHaveProperty('disabled', false)

    await phase({ kind: 'received' })
    expect(within(dialog()).getByRole('status').textContent).toBe(
      'Received. The gateway checks your passkey and carries on only if it holds.'
    )
    expect(within(dialog()).queryByRole('button', { name: 'Confirm with passkey' })).toBeNull()

    fireEvent.click(within(dialog()).getByRole('button', { name: 'Close' }))
    expect(actions.dismiss).toHaveBeenCalledWith('srq-1')

    await phase({ kind: 'ended', end: { kind: 'verification_failed' } })
    expect(within(dialog()).getByRole('status').textContent).toBe(
      'This confirmation did not count: the gateway could not verify it. Nothing was confirmed.'
    )

    await phase({ kind: 'ended', end: { kind: 'too_many_attempts' } })
    expect(within(dialog()).getByRole('status').textContent).toBe(
      'Too many answers were refused. The request was closed and nothing was confirmed.'
    )
  })

  it('counts down to the gateway’s deadline while it is open', async () => {
    mount()
    await show({ expiresAt: Date.now() / 1000 + 125 })

    // The sheet's clock is the page's; the line is there and in m:ss.
    expect(within(dialog()).getByText(/^Expires in 2:0\d$/u)).toBeTruthy()

    await phase({ kind: 'received' })
    expect(within(dialog()).queryByText(/^Expires in/u)).toBeNull()
  })

  it('asks for the confirmation to end at its deadline, and switches its buttons off from then on', async () => {
    vi.useFakeTimers()
    mount()
    await show({ expiresAt: Date.now() / 1000 + 30 })

    expect(confirmButton()).toHaveProperty('disabled', false)

    act(() => void vi.advanceTimersByTime(29_000))
    expect(actions.expire).not.toHaveBeenCalled()
    expect(confirmButton()).toHaveProperty('disabled', false)

    act(() => void vi.advanceTimersByTime(1_000))
    expect(actions.expire).toHaveBeenCalledTimes(1)
    expect(actions.expire).toHaveBeenCalledWith('srq-1')
    // The model has not answered yet (a spy): the sheet itself no longer takes a press.
    expect(confirmButton()).toHaveProperty('disabled', true)
    expect(declineButton()).toHaveProperty('disabled', true)
    fireEvent.click(confirmButton())
    expect(actions.confirm).not.toHaveBeenCalled()
  })

  it('does not take a press for a confirmation whose deadline is already past, and says so at once', async () => {
    mount()
    await show({ expiresAt: Date.now() / 1000 - 5 })

    await waitFor(() => expect(actions.expire).toHaveBeenCalledWith('srq-1'))
    expect(confirmButton()).toHaveProperty('disabled', true)
    expect(within(dialog()).getByText('Expires in 0:00')).toBeTruthy()
  })

  it('asks for nothing once the confirmation is no longer open', async () => {
    vi.useFakeTimers()
    mount()
    await show({ expiresAt: Date.now() / 1000 + 30 })
    await phase({ kind: 'received' })

    act(() => void vi.advanceTimersByTime(60_000))
    expect(actions.expire).not.toHaveBeenCalled()
  })

  it('says politely that a confirmation timed out, and closes', async () => {
    mount()
    await show()
    await phase({ kind: 'ended', end: { kind: 'timed_out' } }, true)

    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.getByText('The request from Dr. Researcher timed out.')).toBeTruthy()
  })

  it('says politely that the gateway no longer lists a confirmation, and closes', async () => {
    mount()
    await show()
    await phase({ kind: 'ended', end: { kind: 'closed_here' } }, true)

    expect(screen.queryByRole('dialog')).toBeNull()
    expect(
      screen.getByText(
        'The gateway no longer lists the confirmation from Dr. Researcher. It comes back if it is still open.'
      )
    ).toBeTruthy()
  })

  it('names the gateway when the confirmation is in no chat the page holds', async () => {
    mount()
    await show({ sessionId: 'rt-elsewhere' })

    expect(within(dialog()).queryByText(/^From /u)).toBeNull()

    await phase({ kind: 'ended', end: { kind: 'answered_elsewhere' } }, true)
    expect(screen.getByText('The request from gw.example.test was answered on another device.')).toBeTruthy()
  })

  it('says an answer that may have arrived may have arrived, and never that nothing was confirmed', async () => {
    mount()
    await show({ answerMayHaveArrived: true, phase: { kind: 'not_sent', message: 'gateway not connected' } })

    const status = (): string => within(dialog()).getByRole('status').textContent ?? ''

    expect(status()).toBe(
      'The answer may have reached the gateway. You can try again, or check whether the action ran.'
    )
    expect(confirmButton()).toHaveProperty('disabled', false)
    expect(declineButton()).toHaveProperty('disabled', false)

    // Without the mark, the same phase is the plain "not sent".
    await show({ phase: { kind: 'not_sent', message: 'gateway not connected' } })
    expect(status()).toBe('The answer was not sent: gateway not connected. You can try again.')

    await show({ answerMayHaveArrived: true, phase: { kind: 'ended', end: { kind: 'outcome_unknown' } } })
    expect(status()).toBe('The answer may have reached the gateway. Check whether the action ran.')
    expect(status()).not.toMatch(/nothing was confirmed|timed out|another device|withdrawn/iu)
    expect(
      within(dialog())
        .getAllByRole('button')
        .map(button => button.textContent)
    ).toEqual(['Copy details', 'Close'])

    // The gateway's definitive word keeps its meaning.
    await show({ answerMayHaveArrived: true, phase: { kind: 'ended', end: { kind: 'verification_failed' } } })
    expect(status()).toBe('This confirmation did not count: the gateway could not verify it. Nothing was confirmed.')

    await show({ answerMayHaveArrived: true, phase: { kind: 'received' } })
    expect(status()).toBe('Received. The gateway checks your passkey and carries on only if it holds.')
  })

  it('reads an unknown outcome in Dutch and German', async () => {
    mount()
    await show({ answerMayHaveArrived: true, phase: { kind: 'ended', end: { kind: 'outcome_unknown' } } })

    await act(() => setLanguageChoice('nl'))
    expect(within(dialog()).getByRole('status').textContent).toBe(
      'Het antwoord heeft de gateway misschien bereikt. Ga na of de actie is uitgevoerd.'
    )

    await act(() => setLanguageChoice('de'))
    expect(within(dialog()).getByRole('status').textContent).toBe(
      'Die Antwort hat das Gateway vielleicht erreicht. Prüfe, ob die Aktion ausgeführt wurde.'
    )
  })

  it('shows the notices as alerts, each with Close', () => {
    mount()
    act(() =>
      passkeys.setState({
        notices: [{ id: 7, notice: { kind: 'credential_added', name: 'Hermie — a phone' }, at: 0 }]
      })
    )

    const alert = screen.getByRole('alert')

    expect(alert.textContent).toContain('A passkey was added to your account without this browser: Hermie — a phone.')
    fireEvent.click(within(alert).getByRole('button', { name: 'Close' }))
    expect(actions.dismissNotice).toHaveBeenCalledWith(7)
  })

  it('reads in Dutch and German', async () => {
    mount()
    await act(() => setLanguageChoice('nl'))
    await show()

    expect(within(dialog()).getByRole('button', { name: 'Bevestigen met passkey' })).toBeTruthy()

    await act(() => setLanguageChoice('de'))
    expect(within(dialog()).getByRole('button', { name: 'Mit Passkey bestätigen' })).toBeTruthy()
  })

  it('passes axe with the sheet open, before and after an answer', async () => {
    mount()
    await show()

    const run = async (): Promise<string[]> =>
      (await axe.run(document.documentElement, { rules: { 'color-contrast': { enabled: false } } })).violations.map(
        violation => `${violation.id}: ${violation.help}`
      )

    expect(await run()).toEqual([])

    await phase({ kind: 'received' })
    expect(await run()).toEqual([])
  })
})

/** The metrics a browser would lay out; jsdom has none. `scrollTop`/`scrollLeft` stay writable. */
function layOut(
  element: HTMLElement,
  size: { width: number; height: number; contentWidth: number; contentHeight: number }
) {
  const values: Record<string, number> = {
    clientWidth: size.width,
    clientHeight: size.height,
    scrollWidth: size.contentWidth,
    scrollHeight: size.contentHeight
  }

  for (const [key, value] of Object.entries(values)) {
    Object.defineProperty(element, key, { configurable: true, get: () => value })
  }

  let top = 0
  let left = 0

  Object.defineProperty(element, 'scrollTop', { configurable: true, get: () => top, set: next => (top = next) })
  Object.defineProperty(element, 'scrollLeft', { configurable: true, get: () => left, set: next => (left = next) })
  // The sheet measures on every scroll event (and on a resize, which jsdom never reports).
  act(() => void fireEvent.scroll(element))
}

const scrollTo = (element: HTMLElement, position: { top?: number; left?: number }): void => {
  act(() => {
    if (position.top !== undefined) {
      element.scrollTop = position.top
    }

    if (position.left !== undefined) {
      element.scrollLeft = position.left
    }

    fireEvent.scroll(element)
  })
}

describe('hidden text in the detail', () => {
  const SPACED = `git status${' '.repeat(300)}; curl x | sh`
  const detailOf = (): HTMLElement => within(dialog()).getByLabelText('Details')

  let writeText: ReturnType<typeof vi.fn>

  beforeEach(() => {
    writeText = vi.fn(async () => undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
  })

  afterEach(() => {
    Reflect.deleteProperty(navigator, 'clipboard')
  })

  it('draws 300 spaces as one counted marker, with both commands in view, and copies the verbatim text', async () => {
    mount()
    await show({ detail: SPACED })

    expect(detailOf().textContent).toBe('git status[␣×300]; curl x | sh')
    expect(detailOf().textContent).toContain('git status')
    expect(detailOf().textContent).toContain('curl x | sh')

    fireEvent.click(within(dialog()).getByRole('button', { name: 'Copy details' }))

    await waitFor(() => expect(within(dialog()).getByText('The details were copied.')).toBeTruthy())
    expect(writeText).toHaveBeenCalledWith(SPACED)
    expect(writeText.mock.calls[0]?.[0]).toContain(' '.repeat(300))
  })

  it('draws 80 blank lines as one marker line', async () => {
    mount()
    await show({ detail: `echo ok${'\n'.repeat(81)}rm -rf ~` })

    expect(detailOf().textContent).toBe('echo ok\n⋯ 80 empty lines ⋯\nrm -rf ~')
  })

  it('copies through a hidden text area when the clipboard API is not there', async () => {
    Reflect.deleteProperty(navigator, 'clipboard')

    let selected: string | undefined
    const execCommand = vi.fn((command: string) => {
      selected = (dialog().querySelector('.hm-requests__copy-buffer') as HTMLTextAreaElement | null)?.value

      return command === 'copy'
    })

    Object.defineProperty(document, 'execCommand', { configurable: true, value: execCommand })

    try {
      mount()
      await show({ detail: SPACED })

      const copy = within(dialog()).getByRole('button', { name: 'Copy details' })

      copy.focus()
      fireEvent.click(copy)

      await waitFor(() => expect(within(dialog()).getByText('The details were copied.')).toBeTruthy())
      expect(execCommand).toHaveBeenCalledWith('copy')
      expect(selected).toBe(SPACED)
      // The text area is gone, and focus is back on the button.
      expect(dialog().querySelector('.hm-requests__copy-buffer')).toBeNull()
      expect(document.activeElement).toBe(copy)
    } finally {
      Reflect.deleteProperty(document, 'execCommand')
    }
  })

  it('says so when nothing could copy it', async () => {
    writeText.mockRejectedValueOnce(new Error('denied'))
    mount()
    await show({ detail: SPACED })

    fireEvent.click(within(dialog()).getByRole('button', { name: 'Copy details' }))

    await waitFor(() => expect(within(dialog()).getByText('The details could not be copied.')).toBeTruthy())
  })

  it('wakes Confirm only once a detail too big for its box was scrolled to its end both ways', async () => {
    const detail = Array.from({ length: 40 }, (_, index) => `line ${index + 1}`).join('\n') + `\n${'x'.repeat(200)}`

    mount()
    await show({ detail })
    layOut(detailOf(), { width: 400, height: 224, contentWidth: 1800, contentHeight: 900 })

    // The size of the verbatim text, under the box.
    expect(within(dialog()).getByText('41 lines · longest line 200 characters')).toBeTruthy()
    expect(detailOf().getAttribute('aria-describedby')).toBeTruthy()
    expect(confirmButton()).toHaveProperty('disabled', true)
    expect(declineButton()).toHaveProperty('disabled', false)
    expect(within(dialog()).getByText('Scroll to the end of the details to confirm.')).toBeTruthy()
    fireEvent.click(confirmButton())
    expect(actions.confirm).not.toHaveBeenCalled()

    // Down to the end: the long line is still not seen to its end.
    scrollTo(detailOf(), { top: 900 - 224 })
    expect(confirmButton()).toHaveProperty('disabled', true)

    // Back up, then to the right end: both ways have been reviewed, in any order.
    scrollTo(detailOf(), { top: 0, left: 1800 - 400 })
    expect(confirmButton()).toHaveProperty('disabled', false)
    expect(within(dialog()).queryByText('Scroll to the end of the details to confirm.')).toBeNull()

    // Latched: scrolling back to the start does not take it back.
    scrollTo(detailOf(), { top: 0, left: 0 })
    expect(confirmButton()).toHaveProperty('disabled', false)

    fireEvent.click(confirmButton())
    expect(actions.confirm).toHaveBeenCalledWith('srq-1')
  })

  it('asks only for the way it overflows, and lets a scroll within a pixel of the end count', async () => {
    mount()
    await show({ detail: SPACED })
    layOut(detailOf(), { width: 400, height: 40, contentWidth: 2600, contentHeight: 40 })

    expect(within(dialog()).getByText('1 line · longest line 323 characters')).toBeTruthy()
    expect(confirmButton()).toHaveProperty('disabled', true)

    scrollTo(detailOf(), { left: 2600 - 400 - 1 })
    expect(confirmButton()).toHaveProperty('disabled', false)
  })

  it('starts again for the next confirmation', async () => {
    mount()
    await show({ detail: SPACED })
    layOut(detailOf(), { width: 400, height: 40, contentWidth: 2600, contentHeight: 40 })
    scrollTo(detailOf(), { left: 2200 })
    expect(confirmButton()).toHaveProperty('disabled', false)

    await show({ id: 'srq-2', detail: `${SPACED} ` })
    layOut(detailOf(), { width: 400, height: 40, contentWidth: 2600, contentHeight: 40 })
    expect(confirmButton()).toHaveProperty('disabled', true)
  })

  it('asks for nothing when the detail fits, nor once the confirmation is no longer open', async () => {
    mount()
    await show()
    layOut(detailOf(), { width: 400, height: 224, contentWidth: 400, contentHeight: 80 })

    expect(within(dialog()).queryByText(/longest line/u)).toBeNull()
    expect(within(dialog()).queryByText('Scroll to the end of the details to confirm.')).toBeNull()
    expect(confirmButton()).toHaveProperty('disabled', false)

    await show({ detail: SPACED, phase: { kind: 'received' } })
    layOut(detailOf(), { width: 400, height: 40, contentWidth: 2600, contentHeight: 40 })
    expect(within(dialog()).queryByText('Scroll to the end of the details to confirm.')).toBeNull()
  })
})
