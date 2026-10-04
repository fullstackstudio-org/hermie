/**
 * Settings, Account: who the gateway named, in its own words and as text, and a sign-out that asks first
 * with Cancel holding the focus and hands over to the entry module's sign-out only once confirmed.
 */
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { resetActiveLocale } from '../../i18n/active-locale'
import { aSettingsRuntime } from '../../test-support/settings-runtime'
import { resetShellStores } from '../../test-support/shell-stores'
import { Account } from './Account'
import { SettingsRuntimeContext } from './settings-runtime'

beforeEach(() => {
  resetShellStores()
  document.documentElement.lang = 'en'
})

afterEach(() => {
  cleanup()
  resetActiveLocale()
})

function mount(runtime = aSettingsRuntime()) {
  render(
    <SettingsRuntimeContext.Provider value={runtime}>
      <Account />
    </SettingsRuntimeContext.Provider>
  )

  return runtime
}

const fact = (label: string): string | null | undefined =>
  screen.getByText(label, { selector: 'dt' }).closest('div')?.querySelector('dd')?.textContent

describe('the Account page', () => {
  it('says who is signed in, with the gateway’s own details and which gateway it is', () => {
    mount()

    expect(screen.getByRole('heading', { level: 2, name: 'Account' })).toBeTruthy()
    expect(fact('Signed in as')).toBe('Tess Tester')
    expect(fact('Email')).toBe('tess@example.test')
    expect(fact('User ID')).toBe('u-1')
    expect(fact('Provider')).toBe('password')
    expect(fact('Host')).toBe('gw.example.test')
  })

  it('does not say a thing twice: an email that is the name, an id that is the name, a provider of none', () => {
    mount(
      aSettingsRuntime({
        user: 'tess@example.test',
        identity: { displayName: '', email: 'tess@example.test', userId: 'tess@example.test', provider: 'none' }
      })
    )

    expect(fact('Signed in as')).toBe('tess@example.test')
    expect(screen.queryByText('Email', { selector: 'dt' })).toBeNull()
    expect(screen.queryByText('User ID', { selector: 'dt' })).toBeNull()
    expect(screen.queryByText('Provider', { selector: 'dt' })).toBeNull()
  })

  it('draws a name the gateway gave as text, cleaned to one line', () => {
    mount(aSettingsRuntime({ user: '<img src=x onerror=alert(1)>‮\nTess' }))

    expect(document.querySelector('img')).toBeNull()
    expect(fact('Signed in as')?.includes('<img src=x onerror=alert(1)>')).toBe(true)
    expect(fact('Signed in as')?.includes('‮')).toBe(false)
  })

  it('says only "Signed in" when the gateway named nobody', () => {
    mount(aSettingsRuntime({ user: '', identity: { displayName: '', email: '', userId: '', provider: '' } }))

    expect(fact('Signed in as')).toBe('Signed in')
  })

  it('says what this page does not know without the runtime', () => {
    render(<Account />)

    expect(screen.getByText('This page does not know which gateway it belongs to.')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Sign out' })).toBeNull()
  })
})

describe('signing out', () => {
  it('asks first, with Cancel holding the focus, and signs out nothing yet', () => {
    const runtime = mount()

    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }))

    const group = screen.getByRole('group', { name: 'Sign out' })

    expect(within(group).getByText('Sign out of this gateway in this browser?')).toBeTruthy()
    expect(document.activeElement).toBe(within(group).getByRole('button', { name: 'Cancel' }))
    expect(runtime.signOut).not.toHaveBeenCalled()
  })

  it('says what stays and what goes', () => {
    mount()

    expect(screen.getByText(/removes the transcripts, drafts and chat list arrangement/u)).toBeTruthy()
    expect(screen.getByText(/theme, accent colour, language and text size stay/u)).toBeTruthy()
  })

  it('goes back to the button that asked when it is cancelled', async () => {
    const runtime = mount()

    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await act(async () => undefined)

    expect(screen.queryByRole('group', { name: 'Sign out' })).toBeNull()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Sign out' }))
    expect(runtime.signOut).not.toHaveBeenCalled()
  })

  it('signs out once it is confirmed, once, and says it is doing it', () => {
    const runtime = mount()

    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }))

    const group = screen.getByRole('group', { name: 'Sign out' })
    const confirm = within(group).getByRole('button', { name: 'Sign out' })

    fireEvent.click(confirm)
    fireEvent.click(confirm)

    expect(runtime.signOut).toHaveBeenCalledTimes(1)
    expect(within(group).getByRole('status').textContent).toBe('Signing out…')
  })
})

describe('on a gateway without sign-in', () => {
  const tokenMode = () =>
    aSettingsRuntime({ gated: false, user: '', identity: { displayName: '', email: '', userId: '', provider: '' } })

  it('says nobody is signed in, where the token came from and that it is as open as the dashboard', () => {
    mount(tokenMode())

    expect(screen.getByText(/This gateway has no sign-in, so nobody is signed in here/u)).toBeTruthy()
    expect(screen.getByText(/as open as that dashboard/u)).toBeTruthy()
    expect(screen.queryByText('Signed in as', { selector: 'dt' })).toBeNull()
    expect(fact('Host')).toBe('gw.example.test')
  })

  it('forgets the token, after asking, instead of signing out', () => {
    const runtime = mount(tokenMode())

    expect(screen.queryByRole('button', { name: 'Sign out' })).toBeNull()
    expect(screen.getByText(/The gateway is not told/u)).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Forget the token' }))

    const group = screen.getByRole('group', { name: 'Forget the token' })

    expect(within(group).getByText('Forget the session token in this browser?')).toBeTruthy()
    expect(runtime.signOut).not.toHaveBeenCalled()

    fireEvent.click(within(group).getByRole('button', { name: 'Forget the token' }))

    expect(runtime.signOut).toHaveBeenCalledTimes(1)
  })
})
