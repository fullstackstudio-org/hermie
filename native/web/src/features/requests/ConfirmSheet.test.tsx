/**
 * A `confirm` at level `passkey` in the request layer: the text exactly as the
 * frame carried it, the fixed frame around it, the tap guard, Escape, every phase
 * the passkey model reports, and the notices. The model is a handful of spies
 * over its store (`state/passkeys.ts`); its own rules are `core/passkey`'s tests.
 */
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import axe from 'axe-core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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
import { aBot, resetShellStores, seedRoster } from '../../test-support/shell-stores'
import type { StoreApi } from 'zustand/vanilla'
import { type PasskeyActions, PasskeyRuntimeContext } from './passkey-runtime'
import { RequestLayer } from './RequestLayer'

const DETAIL = 'rm -rf /srv/backups/2024-*\n    keep:  /srv/backups/latest\n\ttabbed'

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
  expiresAt: null,
  phase: { kind: 'waiting' },
  version: 1,
  dismissed: false,
  ...overrides
})

let version = 1

const show = (overrides: Partial<PasskeyConfirmation> = {}): void =>
  void act(() => {
    version += 1
    passkeys.setState({ confirmations: [confirmation({ version, ...overrides })] })
  })

const phase = (next: ConfirmPhase, dismissed = false): void => show({ phase: next, dismissed })

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
    dismissNotice: vi.fn(),
    refresh: vi.fn(async () => undefined),
    enrol: vi.fn(),
    mintInvite: vi.fn(),
    revoke: vi.fn()
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
  it('shows the gateway’s text verbatim inside a fixed frame', () => {
    mount()
    show()

    expect(dialog().getAttribute('aria-modal')).toBe('true')
    expect(within(dialog()).getByText('From Dr. Researcher')).toBeTruthy()
    expect(within(dialog()).getByRole('heading', { name: 'Delete backups' })).toBeTruthy()
    expect(dialog().getAttribute('aria-describedby')).toBeTruthy()
    expect(document.getElementById(dialog().getAttribute('aria-describedby') as string)?.textContent).toBe(
      'gw.example.test asks you to confirm this with your passkey.'
    )

    const summary = dialog().querySelector('.hm-requests__summary')

    expect(summary?.textContent).toBe('Delete 3 old backups.\nThe newest stays.')

    // Every space, tab and line break, in a preformatted, focusable, labelled box.
    const detail = within(dialog()).getByLabelText('Details')

    expect(detail.tagName).toBe('PRE')
    expect(detail.classList.contains('hm-requests__detail')).toBe(true)
    expect(detail.textContent).toBe(DETAIL)
    expect(detail.tabIndex).toBe(0)
    expect(within(dialog()).getByText('Your browser will ask for your passkey for gw.example.test.')).toBeTruthy()
  })

  it('never reads the text as Markdown', () => {
    mount()
    show({ title: '**Pay** [now](https://evil.example)', summary: '# Heading\n`code`', detail: '<b>bold</b>' })

    expect(within(dialog()).getByRole('heading', { name: '**Pay** [now](https://evil.example)' })).toBeTruthy()
    expect(dialog().querySelector('a, b, code, h1')).toBeNull()
    expect(within(dialog()).getByLabelText('Details').textContent).toBe('<b>bold</b>')
  })

  it('wakes its buttons only after the tap guard', () => {
    vi.useFakeTimers()
    mount(400)
    show()

    expect(confirmButton()).toHaveProperty('disabled', true)
    expect(declineButton()).toHaveProperty('disabled', true)
    fireEvent.click(confirmButton())
    expect(actions.confirm).not.toHaveBeenCalled()

    act(() => void vi.advanceTimersByTime(400))

    expect(confirmButton()).toHaveProperty('disabled', false)
    fireEvent.click(confirmButton())
    expect(actions.confirm).toHaveBeenCalledWith('srq-1')
  })

  it('declines through the model', () => {
    mount()
    show()

    fireEvent.click(declineButton())

    expect(actions.decline).toHaveBeenCalledWith('srq-1')
  })

  it('is not dismissed by Escape', () => {
    mount()
    show()

    fireEvent.keyDown(dialog(), { key: 'Escape' })

    expect(dialog()).toBeTruthy()
    expect(actions.dismiss).not.toHaveBeenCalled()
  })

  it('says where the confirmation stands, and offers only what fits', () => {
    mount()
    show()

    phase({ kind: 'signing' })
    expect(within(dialog()).getByRole('status').textContent).toBe('Waiting for your passkey…')
    expect(confirmButton()).toHaveProperty('disabled', true)

    phase({ kind: 'sending' })
    expect(within(dialog()).getByRole('status').textContent).toBe('Sending…')

    phase({ kind: 'refused', reason: 'signature_invalid' })
    expect(within(dialog()).getByRole('status').textContent).toBe(
      'The gateway did not accept this answer (signature_invalid). You can try again.'
    )
    expect(confirmButton()).toHaveProperty('disabled', false)

    phase({ kind: 'received' })
    expect(within(dialog()).getByRole('status').textContent).toBe(
      'Received. The gateway checks your passkey and carries on only if it holds.'
    )
    expect(within(dialog()).queryByRole('button', { name: 'Confirm with passkey' })).toBeNull()

    fireEvent.click(within(dialog()).getByRole('button', { name: 'Close' }))
    expect(actions.dismiss).toHaveBeenCalledWith('srq-1')

    phase({ kind: 'ended', end: { kind: 'verification_failed' } })
    expect(within(dialog()).getByRole('status').textContent).toBe(
      'This confirmation did not count: the gateway could not verify it. Nothing was confirmed.'
    )

    phase({ kind: 'ended', end: { kind: 'too_many_attempts' } })
    expect(within(dialog()).getByRole('status').textContent).toBe(
      'Too many answers were refused. The request was closed and nothing was confirmed.'
    )
  })

  it('counts down to the gateway’s deadline while it is open', () => {
    mount()
    show({ expiresAt: 1_000_125 })

    // The sheet's clock is the page's; the line is there and in m:ss.
    expect(within(dialog()).getByText(/^Expires in \d+:\d\d$/u)).toBeTruthy()

    phase({ kind: 'received' })
    expect(within(dialog()).queryByText(/^Expires in/u)).toBeNull()
  })

  it('says politely that a confirmation timed out, and closes', () => {
    mount()
    show()
    phase({ kind: 'ended', end: { kind: 'timed_out' } }, true)

    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.getByText('The request from Dr. Researcher timed out.')).toBeTruthy()
  })

  it('names the gateway when the confirmation is in no chat the page holds', () => {
    mount()
    show({ sessionId: 'rt-elsewhere' })

    expect(within(dialog()).queryByText(/^From /u)).toBeNull()

    phase({ kind: 'ended', end: { kind: 'answered_elsewhere' } }, true)
    expect(screen.getByText('The request from gw.example.test was answered on another device.')).toBeTruthy()
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
    show()

    expect(within(dialog()).getByRole('button', { name: 'Bevestigen met passkey' })).toBeTruthy()

    await act(() => setLanguageChoice('de'))
    expect(within(dialog()).getByRole('button', { name: 'Mit Passkey bestätigen' })).toBeTruthy()
  })

  it('passes axe with the sheet open, before and after an answer', async () => {
    mount()
    show()

    const run = async (): Promise<string[]> =>
      (await axe.run(document.documentElement, { rules: { 'color-contrast': { enabled: false } } })).violations.map(
        violation => `${violation.id}: ${violation.help}`
      )

    expect(await run()).toEqual([])

    phase({ kind: 'received' })
    expect(await run()).toEqual([])
  })
})
