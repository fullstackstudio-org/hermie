/**
 * The passkeys settings page: what it says about the level on this gateway, the
 * list, enrolling with a code, making a code and removing a passkey, and how a
 * failure reads. The model is spies over its store.
 */
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import axe from 'axe-core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { StoreApi } from 'zustand/vanilla'

import type { PasskeyStatus } from '../../core/passkey/client'
import { PasskeyActionError } from '../../core/passkey/model'
import { resetActiveLocale } from '../../i18n/active-locale'
import { createPasskeysStore, type PasskeysState } from '../../state/passkeys'
import { type PasskeyActions, PasskeyRuntimeContext } from '../requests/passkey-runtime'
import { Passkeys } from './Passkeys'

let store: StoreApi<PasskeysState>
let actions: { [K in keyof PasskeyActions]: ReturnType<typeof vi.fn> }

const status = (overrides: Partial<PasskeyStatus> = {}): PasskeyStatus => ({
  v: 1,
  enabled: true,
  reason: '',
  gateway_id: 'AAECAwQFBgcICQoLDA0ODw',
  user: { id: 'self-hosted:u1', handle: 'aGFuZGxl' },
  rp: { native: ['confirm.hermie.dev'], web: ['gw.example.test'] },
  user_invites: true,
  credentials: [],
  ...overrides
})

const THIS_SITE = { id: 'd2Vi', name: 'Hermie — gw.example.test', rp_id: 'gw.example.test', created_at: 1_790_000_000 }
const THE_APPS = { id: 'bmF0aXZl', name: 'Hermie — a phone', rp_id: 'confirm.hermie.dev' }

beforeEach(() => {
  document.documentElement.lang = 'en'
  document.title = 'Hermie'
  store = createPasskeysStore()
  store.setState({ supported: true, rpId: 'gw.example.test', status: status() })
  actions = {
    confirm: vi.fn(),
    decline: vi.fn(),
    dismiss: vi.fn(),
    dismissNotice: vi.fn(),
    refresh: vi.fn(async () => undefined),
    enrol: vi.fn(async () => THIS_SITE),
    mintInvite: vi.fn(async () => ({ code: 'm67b1pk0qjbtjwrqssb2', expiresAt: 1_790_000_900 })),
    revoke: vi.fn(async () => undefined)
  }
})

afterEach(() => {
  resetActiveLocale()
})

function mount() {
  return render(
    <PasskeyRuntimeContext.Provider value={actions as unknown as PasskeyActions}>
      <main>
        <h1>Settings</h1>
        <Passkeys store={store} />
      </main>
    </PasskeyRuntimeContext.Provider>
  )
}

describe('the passkeys page', () => {
  it('reads the list when it opens and says the level is on', () => {
    mount()

    expect(actions.refresh).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('heading', { name: 'Passkeys' })).toBeTruthy()
    expect(screen.getByText('Passkey confirmations are on for this gateway.')).toBeTruthy()
    expect(screen.getByText('You have no passkey on this gateway yet.')).toBeTruthy()
  })

  it.each([
    [{ supported: false }, 'Passkeys need this page open over HTTPS'],
    [{ status: null, statusError: { kind: 'not_offered' as const, message: 'x' } }, 'This gateway does not offer'],
    [{ status: status({ enabled: false, reason: 'no_base_url' }) }, 'are off on this gateway (no_base_url)'],
    [
      { status: status({ rp: { native: [], web: ['other.example.test'] } }) },
      'does not accept passkeys for gw.example.test'
    ]
  ])('says why the level is not usable here: %#', (state, text) => {
    store.setState(state)
    mount()

    expect(screen.getByText(new RegExp(text.replace(/[()]/gu, '\\$&'), 'u'))).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Add a passkey' })).toHaveProperty('disabled', true)
  })

  it('enrols with a code', async () => {
    mount()

    fireEvent.change(screen.getByLabelText('Enrolment code'), { target: { value: 'M67B1-PK0QJ-BTJWR-QSSB2' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add a passkey' }))

    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('The passkey was added.'))
    expect(actions.enrol).toHaveBeenCalledWith('M67B1-PK0QJ-BTJWR-QSSB2')
    expect((screen.getByLabelText('Enrolment code') as HTMLInputElement).value).toBe('')
  })

  it.each([
    [new PasskeyActionError({ kind: 'invalid_code' }), 'That is not an enrolment code.'],
    [
      new PasskeyActionError({ kind: 'refused', status: 403, error: 'code_invalid', reason: '', message: 'no' }),
      'The gateway did not accept that code.'
    ],
    [new PasskeyActionError({ kind: 'ceremony', problem: { kind: 'cancelled' } }), 'The passkey prompt was closed.'],
    [new PasskeyActionError({ kind: 'ceremony', problem: { kind: 'exists' } }), 'already holds a passkey'],
    [
      new PasskeyActionError({ kind: 'refused', status: 429, error: 'rate_limited', reason: '', message: 'no' }),
      'Too many tries.'
    ]
  ])('says what went wrong: %#', async (error, text) => {
    actions.enrol.mockRejectedValueOnce(error)
    mount()

    fireEvent.change(screen.getByLabelText('Enrolment code'), { target: { value: 'nope' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add a passkey' }))

    await waitFor(() => expect(screen.getByRole('status').textContent).toContain(text))
  })

  it('lists the passkeys, removes one of this site with a step-up, and leaves the apps’ to the apps', async () => {
    store.setState({ credentials: [THIS_SITE, THE_APPS] })
    mount()

    const items = screen.getAllByRole('listitem')

    expect(items.map(item => within(item).getByText(/^Hermie/u).textContent)).toEqual([
      'Hermie — gw.example.test',
      'Hermie — a phone'
    ])
    expect(within(items[1] as HTMLElement).getByText('For confirm.hermie.dev')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Remove Hermie — a phone' }))

    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('The passkey was removed.'))
    expect(actions.revoke).toHaveBeenCalledWith('bmF0aXZl')
  })

  it('cannot remove or invite without a passkey of this site', () => {
    store.setState({ credentials: [THE_APPS] })
    mount()

    expect(screen.getByRole('button', { name: 'Remove Hermie — a phone' })).toHaveProperty('disabled', true)
    expect(screen.queryByRole('button', { name: 'Make a code' })).toBeNull()
  })

  it('makes a code for another device and shows it once', async () => {
    store.setState({ credentials: [THIS_SITE] })
    mount()

    fireEvent.click(screen.getByRole('button', { name: 'Make a code' }))

    await waitFor(() => expect(screen.getByText('M67B1-PK0QJ-BTJWR-QSSB2')).toBeTruthy())
    expect(actions.mintInvite).toHaveBeenCalledTimes(1)
  })

  it('passes axe', async () => {
    store.setState({ credentials: [THIS_SITE, THE_APPS] })
    mount()
    await act(async () => undefined)

    const result = await axe.run(document.documentElement, { rules: { 'color-contrast': { enabled: false } } })

    expect(result.violations.map(violation => violation.id)).toEqual([])
  })
})
