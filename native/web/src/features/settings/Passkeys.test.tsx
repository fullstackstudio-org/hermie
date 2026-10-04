/**
 * The passkeys settings page: what it says about the level on this gateway, the
 * list, enrolling with a code, making a code and removing a passkey, and how a
 * failure reads. The model is spies over its store.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
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
    expire: vi.fn(),
    dismissNotice: vi.fn(),
    refresh: vi.fn(async () => undefined),
    enrol: vi.fn(async () => THIS_SITE),
    mintInvite: vi.fn(async () => ({ code: 'm67b1pk0qjbtjwrqssb2', expiresAt: 1_790_000_900 })),
    revoke: vi.fn(async () => undefined),
    forgetPin: vi.fn(),
    startSelfEnrolment: vi.fn(async () => undefined),
    finishSelfEnrolment: vi.fn(async () => THIS_SITE),
    cancelSelfEnrolment: vi.fn(),
    expireSelfEnrolment: vi.fn(() => false)
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
    expect(screen.getByRole('button', { name: 'Add with a code' })).toHaveProperty('disabled', true)
  })

  it('enrols with a code', async () => {
    mount()

    fireEvent.change(screen.getByLabelText('Enrolment code'), { target: { value: 'M67B1-PK0QJ-BTJWR-QSSB2' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add with a code' }))

    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('The passkey was added.'))
    expect(actions.enrol).toHaveBeenCalledWith('M67B1-PK0QJ-BTJWR-QSSB2')
    expect((screen.getByLabelText('Enrolment code') as HTMLInputElement).value).toBe('')
  })

  it.each([
    [new PasskeyActionError({ kind: 'invalid_code' }), 'That is not an enrolment code.'],
    [
      new PasskeyActionError({
        kind: 'refused',
        status: 403,
        error: 'code_invalid',
        reason: '',
        message: 'no',
        retryAfter: null
      }),
      'The gateway did not accept that code.'
    ],
    [new PasskeyActionError({ kind: 'ceremony', problem: { kind: 'cancelled' } }), 'The passkey prompt was closed.'],
    [new PasskeyActionError({ kind: 'ceremony', problem: { kind: 'exists' } }), 'already holds a passkey'],
    [
      new PasskeyActionError({
        kind: 'refused',
        status: 429,
        error: 'rate_limited',
        reason: '',
        message: 'no',
        retryAfter: null
      }),
      'Too many tries.'
    ]
  ])('says what went wrong: %#', async (error, text) => {
    actions.enrol.mockRejectedValueOnce(error)
    mount()

    fireEvent.change(screen.getByLabelText('Enrolment code'), { target: { value: 'nope' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add with a code' }))

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

  it('makes a code for another device and shows it once, outside the live region', async () => {
    store.setState({ credentials: [THIS_SITE] })
    mount()

    fireEvent.click(screen.getByRole('button', { name: 'Make a code' }))

    await waitFor(() => expect(screen.getByText('M67B1-PK0QJ-BTJWR-QSSB2')).toBeTruthy())
    expect(actions.mintInvite).toHaveBeenCalledTimes(1)
    // The status line says the code is ready; it does not read the code out.
    expect(screen.getByRole('status').textContent).toBe('Your code is ready below.')
    expect(document.body.textContent?.split('M67B1-PK0QJ-BTJWR-QSSB2')).toHaveLength(2)
  })

  it('copies the code with a button, and says so, or says it could not', async () => {
    const writeText = vi.fn(async () => undefined)

    vi.stubGlobal('navigator', { clipboard: { writeText } })
    store.setState({ credentials: [THIS_SITE] })
    mount()
    fireEvent.click(screen.getByRole('button', { name: 'Make a code' }))
    await screen.findByText('M67B1-PK0QJ-BTJWR-QSSB2')

    fireEvent.click(screen.getByRole('button', { name: 'Copy the code' }))

    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('The code was copied.'))
    expect(writeText).toHaveBeenCalledWith('M67B1-PK0QJ-BTJWR-QSSB2')

    writeText.mockRejectedValueOnce(new Error('denied'))
    fireEvent.click(screen.getByRole('button', { name: 'Copy the code' }))

    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('could not be copied'))
    // Still not in the live region.
    expect(screen.getByRole('status').textContent).not.toContain('M67B1')
    vi.unstubAllGlobals()
  })

  it('says how long to wait when the gateway says so, and keeps the plain sentence when it does not', async () => {
    actions.enrol.mockRejectedValueOnce(
      new PasskeyActionError({
        kind: 'refused',
        status: 429,
        error: 'rate_limited',
        reason: '',
        message: 'later',
        retryAfter: 600
      })
    )
    mount()

    fireEvent.change(screen.getByLabelText('Enrolment code'), { target: { value: 'nope' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add with a code' }))

    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Too many tries. Try again in 10 minutes.'))
  })

  it('shows a write the gateway refused for the page’s address as a state of its own', async () => {
    actions.enrol.mockRejectedValueOnce(
      new PasskeyActionError({
        kind: 'refused',
        status: 403,
        error: 'origin_not_listed',
        reason: '',
        message: 'A browser write needs an Origin that is one of this gateway’s passkey base URLs.',
        retryAfter: null
      })
    )
    mount()

    fireEvent.change(screen.getByLabelText('Enrolment code'), { target: { value: 'nope' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add with a code' }))

    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toBe(
        'The gateway refused this because it does not list gw.example.test as an address for passkeys. Ask whoever runs it to add this address.'
      )
    )
  })

  it('says, and does not offer, what the gateway does not list the page’s address for', () => {
    store.setState({ capability: { verdict: { kind: 'base_url_not_listed' }, accepted: [] } })
    mount()

    expect(screen.getByText(/does not list gw\.example\.test as an address for passkeys/u)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Add with a code' })).toHaveProperty('disabled', true)
  })

  it('forgets the gateway’s pin only after a confirmation, and only when there is one', () => {
    mount()
    expect(screen.queryByRole('button', { name: /Forget this gateway/u })).toBeNull()
    cleanup()

    store.setState({ pinned: true })
    mount()

    fireEvent.click(screen.getByRole('button', { name: 'Forget this gateway’s passkey pin' }))
    expect(actions.forgetPin).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Keep it' }))
    expect(actions.forgetPin).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Forget this gateway’s passkey pin' }))
    fireEvent.click(screen.getByRole('button', { name: 'Yes, forget it' }))

    expect(actions.forgetPin).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('status').textContent).toContain('forgot the gateway’s identity')
  })

  it('passes axe', async () => {
    store.setState({ credentials: [THIS_SITE, THE_APPS] })
    mount()
    await act(async () => undefined)

    const result = await axe.run(document.documentElement, { rules: { 'color-contrast': { enabled: false } } })

    expect(result.violations.map(violation => violation.id)).toEqual([])
  })
})

const refused = (error: string, reason = '', failure = '', status = 403, retryAfter: number | null = null) =>
  new PasskeyActionError({ kind: 'refused', status, error, reason, message: 'no', retryAfter, failure })

const selfStatus = (overrides: Partial<PasskeyStatus> = {}): PasskeyStatus =>
  status({ self_enrol: { available: true, reason: '', cooling_off_s: 0 }, ...overrides })

describe('adding a passkey by signing in again', () => {
  beforeEach(() => {
    store.setState({ selfEnrolSupported: true, status: selfStatus() })
  })

  it('offers it next to the code, with the sentence that says what happens', () => {
    mount()

    expect(screen.getByRole('heading', { name: 'Add a passkey' })).toBeTruthy()
    expect(
      screen.getByText('You will sign in again to prove it is you, then your browser creates the passkey.')
    ).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Add a passkey' })).toHaveProperty('disabled', false)
    expect(screen.getByRole('button', { name: 'Add with a code' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Finish adding your passkey' })).toBeNull()
  })

  it('leaves for the sign-in from the click, and says so', async () => {
    mount()

    fireEvent.click(screen.getByRole('button', { name: 'Add a passkey' }))

    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Taking you to sign in…'))
    expect(actions.startSelfEnrolment).toHaveBeenCalledTimes(1)
    expect(actions.enrol).not.toHaveBeenCalled()
  })

  it.each([
    ['an older gateway (the status says nothing of it)', { self_enrol: undefined }],
    ['the operator switched it off', { self_enrol: { available: false, reason: 'disabled' } }],
    ['the provider cannot ask again', { self_enrol: { available: false, reason: 'provider_no_reauth' } }]
  ])('shows only the code path when %s', (_name, overrides) => {
    store.setState({ status: status(overrides as Partial<PasskeyStatus>) })
    mount()

    expect(screen.queryByRole('heading', { name: 'Add a passkey' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Add a passkey' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Add with a code' })).toBeTruthy()
    expect(screen.getByLabelText('Enrolment code')).toBeTruthy()
  })

  it('shows only the code path when the page cannot come back from a sign-in', () => {
    store.setState({ selfEnrolSupported: false })
    mount()

    expect(screen.queryByRole('button', { name: 'Add a passkey' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Add with a code' })).toBeTruthy()
  })

  it('does not offer it for a site the gateway does not accept', () => {
    store.setState({ status: selfStatus({ rp: { native: [], web: ['other.example.test'] } }) })
    mount()

    expect(screen.queryByRole('button', { name: 'Add a passkey' })).toBeNull()
  })

  it('offers to finish a grant that is waiting, instead of starting another, from a click', async () => {
    store.setState({ selfEnrolment: { expiresAt: 1_790_000_600 } })
    mount()

    expect(screen.getByRole('heading', { name: 'Finish adding your passkey' })).toBeTruthy()
    expect(screen.getByText(/You signed in again\. Your browser can now create the passkey/u)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Add a passkey' })).toBeNull()
    // Not on its own: the ceremony runs from the click.
    expect(actions.finishSelfEnrolment).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Finish adding your passkey' }))

    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('The passkey was added.'))
    expect(actions.finishSelfEnrolment).toHaveBeenCalledTimes(1)
  })

  it('lets go of a waiting grant on Cancel', () => {
    store.setState({ selfEnrolment: { expiresAt: 1_790_000_600 } })
    mount()

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))

    expect(actions.cancelSelfEnrolment).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('status').textContent).toBe('Adding the passkey was cancelled.')
  })

  it('asks the model to drop a waiting grant when its deadline passes, and says so', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_790_000_000_000)
    actions.expireSelfEnrolment.mockReturnValueOnce(true)
    store.setState({ selfEnrolment: { expiresAt: 1_790_000_010 } })
    mount()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_100)
    })

    expect(actions.expireSelfEnrolment).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('status').textContent).toContain('expired')
    vi.useRealTimers()
  })

  // What each reason of `reauth_invalid` says, and that a sign-in that did not count offers "Sign in again".
  it.each([
    [refused('reauth_invalid', 'unknown'), 'expired or was not started in this browser'],
    [refused('reauth_invalid', 'spent'), 'already used for a passkey'],
    [refused('reauth_invalid', 'not_fresh'), 'The sign-in did not complete.'],
    [refused('reauth_invalid', 'failed', 'auth_not_fresh'), 'identity provider reused an earlier sign-in'],
    [refused('reauth_invalid', 'failed', 'auth_time_missing'), 'does not say when you signed in'],
    [refused('reauth_invalid', 'failed', 'user_mismatch'), 'You signed in as someone else.'],
    [refused('reauth_invalid', 'failed', 'provider_mismatch'), 'another sign-in method'],
    [refused('reauth_invalid', 'failed'), 'That sign-in did not count.'],
    [new PasskeyActionError({ kind: 'self_enrol_expired' }), 'expired or was not started in this browser']
  ])('says what went wrong with the sign-in: %#', async (error, text) => {
    actions.finishSelfEnrolment.mockRejectedValueOnce(error)
    store.setState({ selfEnrolment: { expiresAt: 1_790_000_600 } })
    mount()

    fireEvent.click(screen.getByRole('button', { name: 'Finish adding your passkey' }))

    await waitFor(() => expect(screen.getByRole('status').textContent).toContain(text))
    // The model forgot the grant; the way on is a new sign-in.
    act(() => store.setState({ selfEnrolment: null }))
    expect(screen.getByRole('button', { name: 'Sign in again' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Add a passkey' })).toBeNull()
  })

  it('names the gateway’s refusals to start: switched off, provider cannot, https, rate limit, no route', async () => {
    const cases: [PasskeyActionError, string][] = [
      [refused('self_enrol_disabled'), 'is switched off on this gateway. You can still add one with a code.'],
      [refused('provider_no_reauth'), 'provider cannot ask you to sign in again'],
      [refused('insecure_binding'), 'needs this page on HTTPS'],
      [refused('rate_limited', '', '', 429, 600), 'Too many tries. Try again in 10 minutes.'],
      [refused('rate_limited', '', '', 429, null), 'Too many tries. Wait a few minutes and try again.'],
      [
        new PasskeyActionError({ kind: 'self_enrol_unavailable', reason: 'not_offered' }),
        'cannot add a passkey by signing in again'
      ],
      [new PasskeyActionError({ kind: 'self_enrol_stash' }), 'would not keep what is needed to come back']
    ]

    for (const [error, text] of cases) {
      cleanup()
      actions.startSelfEnrolment.mockRejectedValueOnce(error)
      mount()

      fireEvent.click(screen.getByRole('button', { name: 'Add a passkey' }))

      await waitFor(() => expect(screen.getByRole('status').textContent).toContain(text))
    }
  })

  it('keeps Finish for another try after a closed browser sheet', async () => {
    actions.finishSelfEnrolment.mockRejectedValueOnce(
      new PasskeyActionError({ kind: 'ceremony', problem: { kind: 'cancelled' } })
    )
    store.setState({ selfEnrolment: { expiresAt: 1_790_000_600 } })
    mount()

    fireEvent.click(screen.getByRole('button', { name: 'Finish adding your passkey' }))

    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('The passkey prompt was closed.'))
    expect(screen.getByRole('button', { name: 'Finish adding your passkey' })).toHaveProperty('disabled', false)
    expect(screen.queryByRole('button', { name: 'Sign in again' })).toBeNull()
  })

  it('shows when a passkey that is still cooling off becomes usable, and does not count it as one to sign with', () => {
    const future = Date.now() / 1000 + 600

    store.setState({ credentials: [{ ...THIS_SITE, created_via: 'self', usable_from: future }] })
    mount()

    expect(screen.getByText(/^Not usable yet: ready from /u)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Make a code' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Remove Hermie — gw.example.test' })).toHaveProperty('disabled', true)
  })

  it('says nothing of cooling-off once the time has passed or for a passkey without it', () => {
    store.setState({
      credentials: [{ ...THIS_SITE, usable_from: Date.now() / 1000 - 5 }, { ...THE_APPS }]
    })
    mount()

    expect(screen.queryByText(/Not usable yet/u)).toBeNull()
    expect(screen.getByRole('button', { name: 'Make a code' })).toBeTruthy()
  })

  it('passes axe, waiting and not', async () => {
    store.setState({ credentials: [THIS_SITE] })
    mount()
    await act(async () => undefined)

    expect(
      (await axe.run(document.documentElement, { rules: { 'color-contrast': { enabled: false } } })).violations
    ).toEqual([])
    cleanup()

    store.setState({ selfEnrolment: { expiresAt: 1_790_000_600 } })
    mount()
    await act(async () => undefined)

    expect(
      (await axe.run(document.documentElement, { rules: { 'color-contrast': { enabled: false } } })).violations
    ).toEqual([])
  })
})
