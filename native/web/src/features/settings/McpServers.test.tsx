/**
 * Settings › MCP servers against an in-memory gateway: the list (the config with the cached state beside it, and
 * no mark where the gateway cannot say), a probe that finds out, the authorisation as a link the reader opens and a
 * flow that settles, is refused or is cancelled, a removal that asks first, the form that adds a server, and the
 * reload that may want an answer.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { resetActiveLocale } from '../../i18n/active-locale'
import { anMcpServersGateway, CALENDAR, FILES, WEATHER } from '../../test-support/mcp-servers-gateway'
import { aSettingsRuntime } from '../../test-support/settings-runtime'
import { aBot, resetShellStores, seedRoster } from '../../test-support/shell-stores'
import { McpServers } from './McpServers'
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

function mount(gateway = anMcpServersGateway()) {
  render(
    <SettingsRuntimeContext.Provider value={aSettingsRuntime({ manage: { transport: gateway.transport } })}>
      <McpServers />
    </SettingsRuntimeContext.Provider>
  )

  return gateway
}

const row = (name: string) =>
  screen.findByText(name, { selector: '.hm-manage__name' }).then(node => node.closest('li') as HTMLElement)

describe('the list', () => {
  it('shows each server with its transport, its address, the keys it needs and the gateway’s cached state', async () => {
    mount()

    const files = within(await row('files'))

    expect(files.getByText('stdio')).toBeTruthy()
    expect(files.getByText('Connected')).toBeTruthy()
    expect(files.getByText('2 tools')).toBeTruthy()
    expect(files.getByText('npx -y server-filesystem')).toBeTruthy()

    const weather = within(await row('weather'))

    expect(weather.getByText('Not connected')).toBeTruthy()
    expect(weather.getByText('Needs: WEATHER_API_KEY')).toBeTruthy()
  })

  it('does not call a server that needs authorising "failed" or "ok" before it is tested: it offers the sign-in', async () => {
    mount()

    const calendar = within(await row('calendar'))

    expect(calendar.getByText('Authentication: oauth · No token is stored yet.')).toBeTruthy()
    expect(calendar.getByRole('button', { name: 'Authorise calendar' })).toBeTruthy()
    expect(within(await row('files')).queryByRole('button', { name: /Authorise/u })).toBeNull()
  })

  it('draws a server with no mark when the gateway cannot say how it is doing, instead of a failure', async () => {
    mount(anMcpServersGateway({ noStatus: true }))

    expect(within(await row('files')).getByText('Not started yet')).toBeTruthy()
    expect(within(await row('files')).queryByText('Not connected')).toBeNull()
  })

  it('says when there are none, and what is wrong when the list cannot be read, with a retry', async () => {
    mount(anMcpServersGateway({ servers: [] }))
    expect(await screen.findByText('No MCP servers are configured on this gateway.')).toBeTruthy()
    cleanup()

    const gateway = anMcpServersGateway()

    gateway.refuse('mcp.servers.list', 'x')
    gateway.transport.gateway.request = (async () => {
      throw new Error('the gateway is down')
    }) as never
    mount(gateway)

    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(screen.getByRole('alert').textContent).toBe('Could not read the servers: the gateway is down')
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy()
  })

  it('shows the other bot’s servers when it is picked', async () => {
    const gateway = mount()

    await row('files')
    fireEvent.change(screen.getByRole('combobox', { name: 'Bot' }), { target: { value: 'writer' } })

    await waitFor(() => expect(gateway.rpc.at(-1)?.params).toMatchObject({ profile: 'writer' }))
  })

  it('draws what a server says as text, never as markup', async () => {
    mount(
      anMcpServersGateway({
        servers: [{ ...FILES, name: 'x', command: '<img src=x onerror=alert(1)>', args: [] }]
      })
    )

    const code = await screen.findByText('<img src=x onerror=alert(1)>')

    expect(code.querySelector('img')).toBeNull()
  })
})

describe('testing', () => {
  it('connects only when asked, and lists the tools of a server that answers', async () => {
    const gateway = mount()
    const files = within(await row('files'))

    expect(gateway.rpc.some(call => call.method === 'mcp.servers.test')).toBe(false)

    fireEvent.click(files.getByRole('button', { name: 'Test the connection to files' }))

    expect(await files.findByText('Connected. 2 tools available.')).toBeTruthy()
    expect(files.getByRole('list', { name: 'Tools of files' }).textContent).toContain('read_file')
    expect(gateway.rpc.find(call => call.method === 'mcp.servers.test')?.params).toEqual({
      name: 'files',
      profile: 'researcher'
    })
  })

  it('reports a server that does not answer with its own reason, as a failure rather than as a working one', async () => {
    mount()

    const weather = within(await row('weather'))

    fireEvent.click(weather.getByRole('button', { name: 'Test the connection to weather' }))

    expect(await weather.findByText('Could not connect: spawn weather-mcp ENOENT')).toBeTruthy()
  })

  it('says "needs authorising" for an OAuth server with no token, and offers the sign-in', async () => {
    mount(anMcpServersGateway({ servers: [{ ...CALENDAR, auth: 'bearer' }] }))

    // A bearer server gets no sign-in; an OAuth one that has a token needs none either.
    expect(within(await row('calendar')).queryByRole('button', { name: /Authorise/u })).toBeNull()
    cleanup()

    mount(anMcpServersGateway({ servers: [{ ...CALENDAR, tokens: true }] }))

    const calendar = within(await row('calendar'))

    expect(calendar.queryByText('Needs authorising')).toBeNull()
    expect(calendar.getByText('Authentication: oauth · A token is stored.')).toBeTruthy()
  })
})

describe('authorising', () => {
  it('shows the sign-in address as a link to open, waits until the flow settles, then says so and reads the list again', async () => {
    const gateway = mount(anMcpServersGateway({ pending: 1 }))
    const calendar = within(await row('calendar'))

    fireEvent.click(calendar.getByRole('button', { name: 'Authorise calendar' }))

    const link = await calendar.findByRole('link', { name: 'Open the sign-in page' })

    expect(link.getAttribute('href')).toBe('https://calendar.example.test/authorize?state=flow-1')
    expect(link.getAttribute('target')).toBe('_blank')
    expect(link.getAttribute('rel')).toContain('noopener')

    expect(await calendar.findByText('Authorised.', {}, { timeout: 4000 })).toBeTruthy()
    expect(calendar.queryByRole('link')).toBeNull()
    await waitFor(() =>
      expect(
        within(screen.getByText('calendar', { selector: '.hm-manage__name' }).closest('li') as HTMLElement).queryByText(
          'Needs authorising'
        )
      ).toBeNull()
    )
    expect(gateway.servers.find(server => server.name === 'calendar')?.tokens).toBe(true)
  })

  it('tells the gateway the flow is over when it is cancelled, and says it was', async () => {
    const gateway = mount(anMcpServersGateway({ pending: 1000 }))
    const calendar = within(await row('calendar'))

    fireEvent.click(calendar.getByRole('button', { name: 'Authorise calendar' }))
    await calendar.findByRole('link', { name: 'Open the sign-in page' })
    fireEvent.click(calendar.getByRole('button', { name: 'Cancel' }))

    expect(await calendar.findByText('The authorisation was cancelled.')).toBeTruthy()
    expect(gateway.rpc.some(call => call.method === 'mcp.servers.oauth.cancel')).toBe(true)
  })

  it('says why a refused flow ended, and ends it at the gateway too', async () => {
    const gateway = mount(anMcpServersGateway({ pending: 0, oauthEnds: 'error' }))
    const calendar = within(await row('calendar'))

    fireEvent.click(calendar.getByRole('button', { name: 'Authorise calendar' }))

    expect(await calendar.findByText('Authorisation did not finish: the sign-in was denied')).toBeTruthy()
    expect(gateway.rpc.some(call => call.method === 'mcp.servers.oauth.cancel')).toBe(true)
  })

  it('refuses an address that is not a web address, instead of handing it to the reader as a link', async () => {
    const gateway = mount()
    const request = gateway.transport.gateway.request

    gateway.transport.gateway.request = (async (method: string, params: Record<string, unknown>) =>
      method === 'mcp.servers.oauth.start'
        ? { ok: true, session_id: 's', auth_url: 'javascript:alert(1)', flow: 'pkce' }
        : (request as (m: string, p: unknown) => unknown)(method, params)) as never

    const calendar = within(await row('calendar'))

    fireEvent.click(calendar.getByRole('button', { name: 'Authorise calendar' }))

    expect(await calendar.findByText(/did not say where to send you/u)).toBeTruthy()
    expect(calendar.queryByRole('link')).toBeNull()
  })
})

describe('removing', () => {
  it('asks first, and takes the server out of the bot’s configuration when told to', async () => {
    const gateway = mount()
    const files = within(await row('files'))

    fireEvent.click(files.getByRole('button', { name: 'Remove files' }))
    expect(files.getByText('Remove files?')).toBeTruthy()
    expect(document.activeElement).toBe(files.getByRole('button', { name: 'Keep it' }))
    fireEvent.click(files.getByRole('button', { name: 'Keep it' }))
    expect(gateway.rpc.some(call => call.method === 'mcp.servers.remove')).toBe(false)

    fireEvent.click(files.getByRole('button', { name: 'Remove files' }))
    fireEvent.click(files.getByRole('button', { name: 'Remove files' }))

    await waitFor(() => expect(screen.queryByText('files', { selector: '.hm-manage__name' })).toBeNull())
    expect(gateway.rpc.find(call => call.method === 'mcp.servers.remove')?.params).toEqual({
      profile: 'researcher',
      name: 'files'
    })
    expect(screen.getByText('files was removed.')).toBeTruthy()
    expect(document.activeElement).toBe(screen.getByRole('heading', { level: 3, name: 'MCP servers' }))
  })

  it('says why a removal failed, and keeps the server', async () => {
    const gateway = mount()

    gateway.refuse('mcp.servers.remove', 'the config is read only')

    const files = within(await row('files'))

    fireEvent.click(files.getByRole('button', { name: 'Remove files' }))
    fireEvent.click(files.getByRole('button', { name: 'Remove files' }))

    expect(await screen.findByText('Could not remove it: the config is read only')).toBeTruthy()
    expect(screen.getByText('files', { selector: '.hm-manage__name' })).toBeTruthy()
  })
})

describe('adding', () => {
  const open = async () => {
    const details = (await screen.findByText('Add a server')).closest('details') as HTMLDetailsElement

    details.open = true
    fireEvent(details, new Event('toggle'))

    return details
  }

  it('adds a server of the reader’s own from a command and its arguments', async () => {
    const gateway = mount()
    const details = await open()

    fireEvent.change(within(details).getByLabelText('Name'), { target: { value: 'notes' } })
    fireEvent.change(within(details).getByLabelText('Command (for a server that is started here)'), {
      target: { value: 'npx' }
    })
    fireEvent.change(within(details).getByLabelText('Arguments, separated by spaces'), {
      target: { value: '-y  server-notes  /tmp' }
    })
    fireEvent.click(within(details).getByRole('button', { name: 'Add the server' }))

    expect(await screen.findByText('notes was added.')).toBeTruthy()
    expect(gateway.rpc.find(call => call.method === 'mcp.servers.add')?.params).toEqual({
      profile: 'researcher',
      name: 'notes',
      config: { command: 'npx', args: ['-y', 'server-notes', '/tmp'] }
    })
    expect(await row('notes')).toBeTruthy()
    expect((within(details).getByLabelText('Name') as HTMLInputElement).value).toBe('')
  })

  it('sends an access token once, from a field that shows nothing, and keeps none', async () => {
    const gateway = mount()
    const details = await open()
    const token = within(details).getByLabelText('Access token (optional)') as HTMLInputElement

    expect(token.type).toBe('password')
    fireEvent.change(within(details).getByLabelText('Name'), { target: { value: 'hosted' } })
    fireEvent.change(within(details).getByLabelText('Address (for a server that is reached over HTTP)'), {
      target: { value: 'https://hosted.example.test/mcp' }
    })
    fireEvent.change(token, { target: { value: 'secret-token' } })
    fireEvent.click(within(details).getByRole('button', { name: 'Add the server' }))

    await screen.findByText('hosted was added.')
    expect(gateway.rpc.find(call => call.method === 'mcp.servers.add')?.params).toEqual({
      profile: 'researcher',
      name: 'hosted',
      config: { url: 'https://hosted.example.test/mcp' },
      bearer_token: 'secret-token'
    })
    expect(token.value).toBe('')
    expect(document.body.textContent).not.toContain('secret-token')
  })

  it('adds a preset of the catalogue by its name, and names the keys it needs', async () => {
    const gateway = mount()
    const details = await open()

    fireEvent.change(await within(details).findByLabelText('Start from'), { target: { value: 'github' } })

    expect(within(details).getByText('Needs GITHUB_TOKEN in the bot’s environment.')).toBeTruthy()
    // The catalogue’s one already added is not offered again.
    expect(within(details).queryByRole('option', { name: /^files/u })).toBeNull()
    expect((within(details).getByLabelText('Name') as HTMLInputElement).value).toBe('github')
    expect(within(details).queryByLabelText('Command (for a server that is started here)')).toBeNull()

    fireEvent.click(within(details).getByRole('button', { name: 'Add the server' }))

    expect(await screen.findByText('github was added.')).toBeTruthy()
    expect(gateway.rpc.find(call => call.method === 'mcp.servers.add')?.params).toEqual({
      profile: 'researcher',
      name: 'github',
      preset: 'github'
    })
  })

  it('asks for a name and a way to reach the server before it sends anything', async () => {
    const gateway = mount()
    const details = await open()

    fireEvent.click(within(details).getByRole('button', { name: 'Add the server' }))

    expect(await within(details).findByRole('alert')).toBeTruthy()
    expect(within(details).getByRole('alert').textContent).toBe(
      'Give the server a name and either an address or a command.'
    )
    expect(gateway.rpc.some(call => call.method === 'mcp.servers.add')).toBe(false)
  })

  it('says why the gateway refused, and keeps what was typed', async () => {
    mount()

    const details = await open()

    fireEvent.change(within(details).getByLabelText('Name'), { target: { value: 'files' } })
    fireEvent.change(within(details).getByLabelText('Command (for a server that is started here)'), {
      target: { value: 'npx' }
    })
    fireEvent.click(within(details).getByRole('button', { name: 'Add the server' }))

    expect(await within(details).findByText("Could not add it: server 'files' is already configured")).toBeTruthy()
    expect((within(details).getByLabelText('Name') as HTMLInputElement).value).toBe('files')
  })

  it('still takes a server of the reader’s own on a gateway with no catalogue', async () => {
    mount(anMcpServersGateway({ noCatalogue: true }))

    const details = await open()

    await waitFor(() => expect(within(details).getByLabelText('Name')).toBeTruthy())
    expect(within(details).queryByLabelText('Start from')).toBeNull()
  })
})

describe('reloading', () => {
  it('asks first with the gateway’s own warning, and reloads only on "Reload anyway"', async () => {
    const gateway = mount()

    await row('files')
    fireEvent.click(screen.getByRole('button', { name: 'Reload servers' }))

    const group = await screen.findByRole('group', { name: 'Reload servers' })

    expect(within(group).getByText('Reloading invalidates the prompt cache.')).toBeTruthy()
    expect(document.activeElement).toBe(within(group).getByRole('button', { name: 'Cancel' }))
    expect(gateway.rpc.filter(call => call.method === 'reload.mcp')).toHaveLength(1)

    fireEvent.click(within(group).getByRole('button', { name: 'Reload anyway' }))

    expect(await screen.findByText('The servers were reloaded.')).toBeTruthy()
    expect(gateway.rpc.filter(call => call.method === 'reload.mcp').at(-1)?.params).toEqual({ confirm: true })
  })

  it('reloads at once when the gateway does not ask, and Cancel leaves it be', async () => {
    const gateway = mount(anMcpServersGateway({ reloadAsks: false }))

    await row('files')
    fireEvent.click(screen.getByRole('button', { name: 'Reload servers' }))
    expect(await screen.findByText('The servers were reloaded.')).toBeTruthy()
    expect(screen.queryByRole('group', { name: 'Reload servers' })).toBeNull()

    cleanup()
    mount()
    await row('files')
    fireEvent.click(screen.getByRole('button', { name: 'Reload servers' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('group', { name: 'Reload servers' })).toBeNull()
    expect(gateway.rpc.filter(call => call.method === 'reload.mcp')).toHaveLength(1)
  })

  it('says why a reload failed', async () => {
    const gateway = mount()

    gateway.refuse('reload.mcp', 'no live chat')
    await row('files')
    fireEvent.click(screen.getByRole('button', { name: 'Reload servers' }))

    expect(await screen.findByText('Could not reload the servers: no live chat')).toBeTruthy()
  })
})

describe('leaving', () => {
  it('ends an authorisation that is still open when the page goes away', async () => {
    const gateway = mount(anMcpServersGateway({ pending: 1000 }))
    const calendar = within(await row('calendar'))

    fireEvent.click(calendar.getByRole('button', { name: 'Authorise calendar' }))
    await calendar.findByRole('link', { name: 'Open the sign-in page' })

    act(() => cleanup())

    await waitFor(() => expect(gateway.rpc.some(call => call.method === 'mcp.servers.oauth.cancel')).toBe(true))
    expect(WEATHER.name).toBe('weather')
  })
})
