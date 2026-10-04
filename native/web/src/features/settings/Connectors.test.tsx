/**
 * Settings › Connectors against an in-memory gateway: the list per bot (and "switched off" told apart from
 * "none"), a connect that shows the vendor's address as a link and follows the operation until it settles
 * (connected, failed, or already connected), the account switch (Reconnect), the wake when the reader comes back
 * to the tab, and the honest note about the Disconnect that does not exist.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { resetActiveLocale } from '../../i18n/active-locale'
import { aConnectorsGateway, GMAIL } from '../../test-support/connectors-gateway'
import { aSettingsRuntime } from '../../test-support/settings-runtime'
import { aBot, resetShellStores, seedRoster } from '../../test-support/shell-stores'
import { Connectors } from './Connectors'
import { SettingsRuntimeContext } from './settings-runtime'

beforeEach(() => {
  resetShellStores()
  document.documentElement.lang = 'en'
  seedRoster([
    aBot('researcher', { displayName: 'Researcher', isDefault: true }),
    aBot('writer', { displayName: 'Writer' })
  ])
})

afterEach(() => {
  cleanup()
  resetActiveLocale()
})

function mount(gateway = aConnectorsGateway()) {
  render(
    <SettingsRuntimeContext.Provider value={aSettingsRuntime({ manage: { transport: gateway.transport } })}>
      <Connectors />
    </SettingsRuntimeContext.Provider>
  )

  return gateway
}

const row = (slug: string) =>
  screen.findAllByRole('listitem').then(() => document.querySelector(`li[data-connector="${slug}"]`) as HTMLElement)

describe('the list', () => {
  it('names each connector by the vendor’s label or its slug, with its state, status word and reason', async () => {
    mount()

    const gmail = within(await row('gmail'))

    expect(gmail.getByText('Gmail')).toBeTruthy()
    expect(gmail.getByText('Connected')).toBeTruthy()
    expect(gmail.getByText('Status: active')).toBeTruthy()
    expect(gmail.getByText('Read and send mail.')).toBeTruthy()

    const notion = within(await row('notion'))

    expect(notion.getByText('notion')).toBeTruthy()
    expect(notion.getByText('Not connected')).toBeTruthy()

    const slack = within(await row('slack'))

    expect(slack.getByText('Switched off')).toBeTruthy()
    expect(slack.getByText('Reason: the workspace revoked the token')).toBeTruthy()
  })

  it('asks as the account, not as a chat, for the bot that is picked', async () => {
    const gateway = mount()

    await row('gmail')
    expect(gateway.rpc[0]).toEqual({
      method: 'connectors.list',
      params: { profile: 'researcher', owner: { type: 'account' } }
    })

    fireEvent.change(screen.getByRole('combobox', { name: 'Bot' }), { target: { value: 'writer' } })
    await waitFor(() => expect(gateway.rpc.at(-1)?.params).toMatchObject({ profile: 'writer' }))
  })

  it('says "switched off" for a bot whose connections toolset is off, which is not an empty account', async () => {
    mount(aConnectorsGateway({ unavailable: true }))

    expect(await screen.findByText('Connectors are switched off for this bot.')).toBeTruthy()
    expect(screen.queryByText('This gateway offers no connectors.')).toBeNull()
    expect(screen.queryByRole('list', { name: 'Connectors' })).toBeNull()
  })

  it('says there are none when the gateway offers none, and what went wrong when it cannot be read', async () => {
    mount(aConnectorsGateway({ connectors: [] }))
    expect(await screen.findByText('This gateway offers no connectors.')).toBeTruthy()
    cleanup()

    const gateway = aConnectorsGateway()

    gateway.transport.gateway.request = (async () => {
      throw new Error('the gateway is down')
    }) as never
    mount(gateway)

    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(screen.getByRole('alert').textContent).toBe('Could not read the connectors: the gateway is down')
  })

  it('has no Disconnect, and says whose decision that is', async () => {
    mount()

    await row('gmail')
    expect(screen.queryByRole('button', { name: /Disconnect/u })).toBeNull()
    expect(screen.getByText(/Signing out of a connector is done where you manage the account/u)).toBeTruthy()
  })

  it('draws what the vendor says as text, never as markup', async () => {
    mount(aConnectorsGateway({ connectors: [{ ...GMAIL, description: '<img src=x onerror=alert(1)>' }] }))

    const text = await screen.findByText('<img src=x onerror=alert(1)>')

    expect(text.querySelector('img')).toBeNull()
  })
})

describe('connecting', () => {
  it('shows the vendor’s address as a link to open, follows the operation, says it is connected and reads the list again', async () => {
    const gateway = mount()
    const notion = within(await row('notion'))

    fireEvent.click(notion.getByRole('button', { name: 'Connect notion' }))

    const link = await notion.findByRole('link', { name: 'Open the sign-in page' })

    expect(link.getAttribute('href')).toBe('https://vendor.example.test/authorize/notion?op=op-1')
    expect(link.getAttribute('target')).toBe('_blank')
    expect(link.getAttribute('rel')).toContain('noopener')
    expect(notion.getByText('vendor.example.test')).toBeTruthy()

    expect(await screen.findByText('notion is connected.', {}, { timeout: 5000 })).toBeTruthy()
    await waitFor(() =>
      expect(
        within(document.querySelector('li[data-connector="notion"]') as HTMLElement).getByText('Connected')
      ).toBeTruthy()
    )
    expect(gateway.rpc.find(call => call.method === 'connectors.connect')?.params).toEqual({
      profile: 'researcher',
      owner: { type: 'account' },
      connectors: ['notion']
    })
    expect(gateway.rpc.some(call => call.method === 'connectors.operation.status')).toBe(true)
  }, 10_000)

  it('says why a connector failed, in the vendor’s words', async () => {
    mount(aConnectorsGateway({ resolvesTo: { notion: 'failed' }, reads: 1 }))

    fireEvent.click(await screen.findByRole('button', { name: 'Connect notion' }))

    expect(
      await screen.findByText('Could not connect: the workspace refused the grant', {}, { timeout: 5000 })
    ).toBeTruthy()
  }, 10_000)

  it('says it was not completed when the operation settles without the connector, and expired when it expired', async () => {
    mount(aConnectorsGateway({ resolvesTo: { notion: 'expired' }, reads: 1 }))

    fireEvent.click(await screen.findByRole('button', { name: 'Connect notion' }))

    expect(await screen.findByText('The authorisation expired before it finished.', {}, { timeout: 5000 })).toBeTruthy()
  }, 10_000)

  it('offers Reconnect for a connector that is connected, which asks for another account', async () => {
    const gateway = mount()

    fireEvent.click(await screen.findByRole('button', { name: 'Reconnect Gmail' }))

    await waitFor(() => expect(gateway.rpc.some(call => call.method === 'connectors.connect')).toBe(true))
    expect(gateway.rpc.find(call => call.method === 'connectors.connect')?.params).toMatchObject({
      connectors: ['gmail'],
      reconnect: true
    })
    expect(screen.queryByRole('button', { name: 'Connect Gmail' })).toBeNull()
  })

  it('does not wait for a sign-in a connector does not need: it is connected at once, with no link', async () => {
    mount(aConnectorsGateway({ instant: true }))

    fireEvent.click(await screen.findByRole('button', { name: 'Connect notion' }))

    expect(await screen.findByText('notion is connected.')).toBeTruthy()
    expect(screen.queryByRole('link', { name: 'Open the sign-in page' })).toBeNull()
  })

  it('refuses an operation that has no address, saying so, rather than waiting for the deadline', async () => {
    mount(aConnectorsGateway({ connectUrl: null }))

    fireEvent.click(await screen.findByRole('button', { name: 'Connect notion' }))

    expect(await screen.findByText(/did not say where to send you/u)).toBeTruthy()
  })

  it('refuses an address that is not a web address', async () => {
    mount(aConnectorsGateway({ connectUrl: 'javascript:alert(1)' }))

    fireEvent.click(await screen.findByRole('button', { name: 'Connect notion' }))

    expect(await screen.findByText(/did not say where to send you/u)).toBeTruthy()
    expect(screen.queryByRole('link', { name: 'Open the sign-in page' })).toBeNull()
  })

  it('tells the gateway to read the account at once when the reader comes back to the tab', async () => {
    const gateway = mount(aConnectorsGateway({ reads: 1000 }))

    fireEvent.click(await screen.findByRole('button', { name: 'Connect notion' }))
    await screen.findByRole('link', { name: 'Open the sign-in page' })

    // The reader leaves for the vendor's tab and comes back.
    act(() => {
      window.dispatchEvent(new Event('pagehide'))
      window.dispatchEvent(new Event('pageshow'))
    })

    await waitFor(() => expect(gateway.rpc.some(call => call.method === 'connectors.operation.wake')).toBe(true))
    expect(gateway.rpc.find(call => call.method === 'connectors.operation.wake')?.params).toMatchObject({
      owner: { type: 'account' },
      op_id: 'op-1'
    })
  })

  it('stops following when it is cancelled, and says it was not completed', async () => {
    mount(aConnectorsGateway({ reads: 1000 }))

    fireEvent.click(await screen.findByRole('button', { name: 'Connect notion' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }))

    expect(await screen.findByText('The authorisation was not completed.', {}, { timeout: 5000 })).toBeTruthy()
  }, 10_000)
})
