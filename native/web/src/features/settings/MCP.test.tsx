/**
 * The MCP settings page: what it shows of the gateway's answer (as plain text), the copy buttons, the
 * revoke with its confirmation, and each state it can be in: no MCP, no person, a failed read. The
 * model is spies over its store.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import axe from 'axe-core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { StoreApi } from 'zustand/vanilla'

import { type McpGrant, McpRouteError, type McpStatus } from '../../core/mcp/client'
import { resetActiveLocale, setActiveLocale } from '../../i18n/active-locale'
import { createMcpStore, type McpState } from '../../state/mcp'
import { Mcp, revokeFailure } from './MCP'
import { type McpActions, McpRuntimeContext } from './mcp-runtime'

let store: StoreApi<McpState>
let actions: Omit<{ [K in keyof McpActions]: ReturnType<typeof vi.fn> }, 'host'> & { host: string }
let unwatch: ReturnType<typeof vi.fn>

const NOW = 1_790_000_000

const grant = (overrides: Partial<McpGrant> = {}): McpGrant => ({
  id: 'mcg_1',
  clientName: 'Claude Code',
  clientId: 'client-1',
  scopes: ['mcp'],
  createdAt: NOW,
  createdIp: '192.0.2.10',
  createdUserAgent: 'Test Browser',
  lastUsedAt: null,
  lastUsedIp: null,
  expiresAt: NOW + 90 * 86_400,
  ...overrides
})

const status = (overrides: Partial<McpStatus> = {}): McpStatus => ({
  endpointUrl: 'https://gw.example.test/mcp',
  issuer: 'https://gw.example.test/mcp',
  label: 'hermie-gw',
  command: 'claude mcp add --transport http hermie-gw https://gw.example.test/mcp',
  configJson: '{\n  "mcpServers": {\n    "hermie-gw": { "type": "http", "url": "https://gw.example.test/mcp" }\n  }\n}',
  instructions: 'Run the command.\nThen allow the client here.',
  grants: [grant()],
  ...overrides
})

beforeEach(() => {
  document.documentElement.lang = 'en'
  document.title = 'Hermie'
  store = createMcpStore()
  store.setState({ status: status(), loaded: true })
  unwatch = vi.fn()
  actions = {
    host: 'gw.example.test',
    watch: vi.fn(() => unwatch as unknown as () => void),
    refresh: vi.fn(async () => undefined),
    revoke: vi.fn(async () => 'revoked' as const)
  }
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  resetActiveLocale()
})

function mount() {
  return render(
    <McpRuntimeContext.Provider value={actions as unknown as McpActions}>
      <main>
        <h1>Settings</h1>
        <Mcp store={store} />
      </main>
    </McpRuntimeContext.Provider>
  )
}

describe('the MCP page', () => {
  it('reads when it opens, and lets go when it closes', () => {
    const view = mount()

    expect(actions.watch).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('heading', { name: 'MCP' })).toBeTruthy()

    view.unmount()
    expect(unwatch).toHaveBeenCalledTimes(1)
  })

  it('says MCP is on and shows the gateway’s endpoint, command, config and instructions as text', () => {
    mount()

    expect(screen.getByText('MCP is on for this gateway.')).toBeTruthy()
    expect(document.querySelector('[data-mcp="endpoint"]')?.textContent).toBe('https://gw.example.test/mcp')
    expect(document.querySelector('[data-mcp="command"]')?.textContent).toBe(status().command)
    expect(document.querySelector('[data-mcp="config"]')?.textContent).toBe(status().configJson)
    expect(screen.getByText(/Run the command\./u).textContent).toBe('Run the command.\nThen allow the client here.')
  })

  it('draws everything the gateway said as plain text, never as markup', () => {
    store.setState({
      status: status({
        command: '<img src=x onerror=alert(1)> claude mcp add',
        instructions: '**bold** <b>x</b>',
        grants: [grant({ clientName: '<b>Agent</b> [x](https://example.test)', createdIp: '<i>203.0.113.7</i>' })]
      })
    })
    mount()

    expect(document.querySelector('img')).toBeNull()
    expect(document.querySelector('b')).toBeNull()
    expect(document.querySelector('i')).toBeNull()
    expect(document.querySelector('a')).toBeNull()
    expect(screen.getByText('**bold** <b>x</b>')).toBeTruthy()
    expect(screen.getByText('<b>Agent</b> [x](https://example.test)')).toBeTruthy()
  })

  it('lists each client with when it was allowed, from where, when it was last used, and when it ends', () => {
    store.setState({
      status: status({
        grants: [
          grant({ id: 'a', clientName: 'Used Agent', lastUsedAt: NOW + 3600, lastUsedIp: '198.51.100.4' }),
          grant({ id: 'b', clientName: 'Fresh Agent', createdIp: null }),
          grant({ id: 'c', clientName: 'Quiet Agent', lastUsedAt: NOW + 7200, expiresAt: null })
        ]
      })
    })
    mount()

    const items = screen.getAllByRole('listitem')

    expect(items).toHaveLength(3)

    const used = within(items[0] as HTMLElement)

    expect(used.getByText('Used Agent')).toBeTruthy()
    expect(used.getByText(/^Allowed .* from 192\.0\.2\.10$/u)).toBeTruthy()
    expect(used.getByText(/^Last used .* from 198\.51\.100\.4$/u)).toBeTruthy()
    expect(used.getByText(/^Allowed until /u)).toBeTruthy()

    const fresh = within(items[1] as HTMLElement)

    expect(fresh.getByText(/^Allowed (?!until )[^f]*$/u)).toBeTruthy()
    expect(fresh.getByText('Never used')).toBeTruthy()

    const quiet = within(items[2] as HTMLElement)

    expect(quiet.getByText(/^Last used [^f]*$/u)).toBeTruthy()
    expect(quiet.queryByText(/^Allowed until /u)).toBeNull()
  })

  it('says there is no client yet, and names a client that came with no name', () => {
    store.setState({ status: status({ grants: [] }) })
    const view = mount()

    expect(screen.getByText('No client is connected yet.')).toBeTruthy()
    view.unmount()

    store.setState({ status: status({ grants: [grant({ clientName: '‮​' })] }) })
    mount()
    expect(screen.getByText('Unnamed client')).toBeTruthy()
  })

  it('copies the endpoint, the command and the config exactly, and says so, or says it could not', async () => {
    const writeText = vi.fn(async () => undefined)

    vi.stubGlobal('navigator', { clipboard: { writeText } })
    mount()

    for (const [name, text] of [
      ['Copy the endpoint address', status().endpointUrl],
      ['Copy the add command', status().command],
      ['Copy the JSON config', status().configJson]
    ] as const) {
      fireEvent.click(screen.getByRole('button', { name }))
      await waitFor(() => expect(writeText).toHaveBeenLastCalledWith(text))
      await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Copied.'))
    }

    writeText.mockRejectedValueOnce(new Error('denied'))
    fireEvent.click(screen.getByRole('button', { name: 'Copy the add command' }))
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('did not allow copying'))
  })

  it('asks before it revokes, and Cancel leaves everything as it was, with the focus back on Revoke', () => {
    mount()

    fireEvent.click(screen.getByRole('button', { name: 'Revoke Claude Code' }))

    const group = screen.getByRole('group', { name: 'Revoke Claude Code' })

    expect(within(group).getByText(/stops working at once/u)).toBeTruthy()
    expect(actions.revoke).not.toHaveBeenCalled()
    // Cancel has the focus: one stray Enter does not revoke.
    expect(document.activeElement).toBe(within(group).getByRole('button', { name: 'Cancel' }))

    fireEvent.click(within(group).getByRole('button', { name: 'Cancel' }))

    expect(screen.queryByRole('group')).toBeNull()
    expect(actions.revoke).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Revoke Claude Code' }))
  })

  it('revokes the confirmed client and says so', async () => {
    store.setState({ status: status({ grants: [grant(), grant({ id: 'mcg_2', clientName: 'Other Agent' })] }) })
    mount()

    fireEvent.click(screen.getByRole('button', { name: 'Revoke Other Agent' }))
    fireEvent.click(within(screen.getByRole('group')).getByRole('button', { name: 'Revoke Other Agent' }))

    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Other Agent was revoked.'))
    expect(actions.revoke).toHaveBeenCalledWith('mcg_2')
    expect(actions.revoke).toHaveBeenCalledTimes(1)
  })

  it('says a client that was already gone is gone, and a refusal in words', async () => {
    mount()

    actions.revoke.mockResolvedValueOnce('gone')
    fireEvent.click(screen.getByRole('button', { name: 'Revoke Claude Code' }))
    fireEvent.click(within(screen.getByRole('group')).getByRole('button', { name: 'Revoke Claude Code' }))
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('already gone'))

    actions.revoke.mockRejectedValueOnce(new McpRouteError('refused', 'HTTP 500', 500))
    fireEvent.click(screen.getByRole('button', { name: 'Revoke Claude Code' }))
    fireEvent.click(within(screen.getByRole('group')).getByRole('button', { name: 'Revoke Claude Code' }))
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Could not revoke: HTTP 500'))
  })

  it('says what a change made elsewhere was, but not one that was there before the page opened', () => {
    store.setState({ change: { id: 1, change: 'revoked', clientName: 'Old Agent' } })
    mount()

    expect(screen.getByRole('status').textContent).toBe('')

    act(() => store.setState({ change: { id: 2, change: 'granted', clientName: 'New Agent' } }))
    expect(screen.getByRole('status').textContent).toBe('New Agent was allowed.')

    act(() => store.setState({ change: { id: 3, change: 'revoked', clientName: 'New Agent' } }))
    expect(screen.getByRole('status').textContent).toBe('New Agent was revoked.')

    act(() => store.setState({ change: { id: 4, change: 'renamed', clientName: '' } }))
    expect(screen.getByRole('status').textContent).toBe('The list of clients changed.')
  })

  it('says only that this gateway does not offer MCP when it has none', () => {
    store.setState({ status: null, problem: { kind: 'not_offered' }, loaded: true })
    mount()

    expect(screen.getByText('This gateway does not offer MCP.')).toBeTruthy()
    expect(screen.queryByText(/MCP lets an AI agent/u)).toBeNull()
    expect(screen.queryByRole('button')).toBeNull()
    expect(screen.queryByText('Connected clients')).toBeNull()
  })

  it('says to sign in when the session has no person, and shows nothing of an earlier read', () => {
    store.setState({ problem: { kind: 'sign_in' } })
    mount()

    expect(screen.getByText(/Sign in with your account/u)).toBeTruthy()
    expect(screen.queryByText('MCP is on for this gateway.')).toBeNull()
    expect(screen.queryByRole('list')).toBeNull()
  })

  it('says a read failed with the gateway’s words, offers to try again, and keeps the list it had', () => {
    store.setState({ problem: { kind: 'failed', message: 'HTTP 502' } })
    mount()

    expect(screen.getByText('MCP access could not be read: HTTP 502')).toBeTruthy()
    expect(screen.getByRole('listitem')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(actions.refresh).toHaveBeenCalledTimes(1)
  })

  it('says it is reading until the first read has finished', () => {
    store.setState({ status: null, loaded: false })
    mount()

    expect(screen.getByText('Reading MCP access…')).toBeTruthy()
  })

  it('speaks Dutch and German', () => {
    setActiveLocale('nl')
    const view = mount()

    expect(screen.getByRole('button', { name: 'Claude Code intrekken' })).toBeTruthy()
    view.unmount()

    setActiveLocale('de')
    mount()
    expect(screen.getByRole('button', { name: 'Claude Code widerrufen' })).toBeTruthy()
  })

  it('passes axe', async () => {
    mount()
    fireEvent.click(screen.getByRole('button', { name: 'Revoke Claude Code' }))
    await act(async () => undefined)

    const result = await axe.run(document.documentElement, { rules: { 'color-contrast': { enabled: false } } })

    expect(result.violations.map(violation => violation.id)).toEqual([])
  })
})

describe('what a failed revoke says', () => {
  it('names the address the gateway does not list, asks to sign in, or gives the gateway’s own words, cleaned', () => {
    expect(revokeFailure(new McpRouteError('refused', 'x', 403, 'origin_not_listed'), 'gw.example.test')).toContain(
      'gw.example.test'
    )
    expect(revokeFailure(new McpRouteError('no_identity', 'x', 403, 'no_identity'), 'h')).toContain('Sign in')
    expect(revokeFailure(new McpRouteError('not_offered', 'x', 404), 'h')).toBe('This gateway does not offer MCP.')
    expect(revokeFailure(new Error('boom‮\nnow'), 'h')).toBe('Could not revoke: boom\nnow')
  })
})
