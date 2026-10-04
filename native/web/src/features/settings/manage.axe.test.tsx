/**
 * The gateway-management Settings pages through axe, in the light and the dark scheme and in every language,
 * with the states that put the most on screen (a list loaded, an entry in its editor, a question open): no
 * violation. jsdom does not load the stylesheets, so colour contrast is measured elsewhere (the theme's
 * contrast test, and `e2e/manage.spec.ts` in a real browser); this checks names, roles, labels and headings.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import axe from 'axe-core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { webPluginAdvertOf } from '../../core/advert'
import { loadCatalogue } from '../../i18n/catalogue'
import { resetActiveLocale, setActiveLocale } from '../../i18n/active-locale'
import { applyTheme } from '../../platform/theme-target'
import { pluginStore } from '../../state/plugin'
import { aSettingsRuntime } from '../../test-support/settings-runtime'
import { aBot, resetShellStores, seedRoster } from '../../test-support/shell-stores'
import { aMemoryPlugin } from '../../test-support/memory-plugin'
import { aKanbanPlugin } from '../../test-support/kanban-plugin'
import { aConnectorsGateway } from '../../test-support/connectors-gateway'
import { anMcpServersGateway } from '../../test-support/mcp-servers-gateway'
import { aSkillsGateway } from '../../test-support/skills-gateway'
import type { ManageTransport } from './manage-runtime'
import { Memory } from './Memory'
import { Boards } from './Boards'
import { Connectors } from './Connectors'
import { McpServers } from './McpServers'
import { Skills } from './Skills'
import { SettingsRuntimeContext } from './settings-runtime'

beforeEach(() => {
  resetShellStores()
  document.documentElement.lang = 'en'
  document.title = 'Hermie'
  seedRoster([aBot('researcher', { isDefault: true }), aBot('writer')])
  pluginStore.getState().apply(
    webPluginAdvertOf({
      v: 1,
      version: '0.5.0',
      capabilities: ['memory.browse', 'memory.edit'],
      modules: {},
      limits: {},
      updatedAt: 1
    })
  )
})

afterEach(() => {
  cleanup()
  applyTheme({ scheme: 'system', tint: 'blue' })
  resetActiveLocale()
})

async function violations(): Promise<string[]> {
  const result = await axe.run(document.documentElement, { rules: { 'color-contrast': { enabled: false } } })

  return result.violations.map(
    violation => `${violation.id}: ${violation.help} (${violation.nodes.map(node => node.target.join(' ')).join(', ')})`
  )
}

function mount(transport: ManageTransport, page: React.ReactElement) {
  return render(
    <SettingsRuntimeContext.Provider value={aSettingsRuntime({ manage: { transport } })}>
      <main>
        <h1>Settings</h1>
        {page}
      </main>
    </SettingsRuntimeContext.Provider>
  )
}

describe.each(['light', 'dark'] as const)('the management pages in the %s scheme', scheme => {
  beforeEach(() => {
    applyTheme({ scheme, tint: 'teal' })
  })

  it('has no violation on Memory, loaded', async () => {
    mount(aMemoryPlugin().transport, <Memory />)
    await screen.findByText('Prefers footnotes.')

    expect(await violations()).toEqual([])
  })

  it('has no violation on Memory with an entry in its editor and a removal asked about', async () => {
    mount(aMemoryPlugin().transport, <Memory />)
    await screen.findByText('Prefers footnotes.')

    fireEvent.click(screen.getByRole('button', { name: 'Edit entry 1 in MEMORY.md' }))
    fireEvent.click(screen.getByRole('button', { name: 'Remove entry 2 from MEMORY.md' }))

    expect(await violations()).toEqual([])
  })

  it('has no violation on Skills, loaded, with a hub row’s details open', async () => {
    mount(aSkillsGateway().transport, <Skills />)
    await screen.findByRole('list', { name: 'CATALOGUE' })

    fireEvent.click(screen.getByRole('button', { name: 'Details of xlsx' }))
    await waitFor(() => expect(document.querySelector('pre.hm-manage__scroll')).toBeTruthy())

    expect(await violations()).toEqual([])
  })

  it('has no violation on MCP servers, loaded, with a probe answered, a question and the add form open', async () => {
    mount(anMcpServersGateway().transport, <McpServers />)
    await screen.findByText('files', { selector: '.hm-manage__name' })

    fireEvent.click(screen.getByRole('button', { name: 'Test the connection to files' }))
    await screen.findByText('Connected. 2 tools available.')
    fireEvent.click(screen.getByRole('button', { name: 'Remove weather' }))

    const details = screen.getByText('Add a server').closest('details') as HTMLDetailsElement

    details.open = true
    fireEvent(details, new Event('toggle'))
    await screen.findByLabelText('Start from')

    expect(await violations()).toEqual([])
  })

  it('has no violation on Connectors, loaded, with a sign-in under way', async () => {
    mount(aConnectorsGateway({ reads: 1000 }).transport, <Connectors />)
    fireEvent.click(await screen.findByRole('button', { name: 'Connect notion' }))
    await screen.findByRole('link', { name: 'Open the sign-in page' })

    expect(await violations()).toEqual([])
  })

  it('has no violation on Connectors for a bot whose connections are switched off', async () => {
    mount(aConnectorsGateway({ unavailable: true }).transport, <Connectors />)
    await screen.findByText('Connectors are switched off for this bot.')

    expect(await violations()).toEqual([])
  })

  it('has no violation on Boards, with a card open and the new card form open', async () => {
    mount(aKanbanPlugin().transport, <Boards />)
    fireEvent.click(await screen.findByRole('button', { name: 'Open Write the release notes' }))
    await screen.findAllByLabelText('Title')

    const details = screen.getByText('New card').closest('details') as HTMLDetailsElement

    details.open = true

    expect(await violations()).toEqual([])
  })

  it('has no violation on Boards without the plugin', async () => {
    mount(aKanbanPlugin({ absent: true }).transport, <Boards />)
    await screen.findByText('This gateway has no Kanban plugin.')

    expect(await violations()).toEqual([])
  })
})

describe.each(['nl', 'de'] as const)('the management pages in %s', locale => {
  it('has no violation on Memory', async () => {
    await loadCatalogue(locale)
    act(() => setActiveLocale(locale))
    mount(aMemoryPlugin().transport, <Memory />)
    await screen.findByText('Prefers footnotes.')

    expect(await violations()).toEqual([])
  })

  it('has no violation on Skills', async () => {
    await loadCatalogue(locale)
    act(() => setActiveLocale(locale))
    mount(aSkillsGateway().transport, <Skills />)
    await screen.findAllByRole('checkbox')
    await screen.findAllByRole('listitem')

    expect(await violations()).toEqual([])
  })

  it('has no violation on MCP servers, with the add form open', async () => {
    await loadCatalogue(locale)
    act(() => setActiveLocale(locale))
    mount(anMcpServersGateway().transport, <McpServers />)
    await screen.findAllByRole('listitem')

    const details = document.querySelector('details') as HTMLDetailsElement

    details.open = true
    fireEvent(details, new Event('toggle'))
    await waitFor(() => expect(details.querySelector('select')).toBeTruthy())

    expect(await violations()).toEqual([])
  })

  it('has no violation on Connectors', async () => {
    await loadCatalogue(locale)
    act(() => setActiveLocale(locale))
    mount(aConnectorsGateway().transport, <Connectors />)
    await screen.findAllByRole('listitem')

    expect(await violations()).toEqual([])
  })

  it('has no violation on Boards', async () => {
    await loadCatalogue(locale)
    act(() => setActiveLocale(locale))
    mount(aKanbanPlugin().transport, <Boards />)
    await screen.findAllByRole('listitem')

    expect(await violations()).toEqual([])
  })
})
