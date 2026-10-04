/**
 * Settings › Skills against an in-memory gateway: the installed list with the bot's switches (written whole, in
 * order, and put back when refused), the hub browsed and searched, a row's details, and an install that lands,
 * that the gateway cannot do over the socket, or that fails.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { resetActiveLocale } from '../../i18n/active-locale'
import { aSkillsGateway } from '../../test-support/skills-gateway'
import { aSettingsRuntime } from '../../test-support/settings-runtime'
import { aBot, resetShellStores, seedRoster } from '../../test-support/shell-stores'
import { SettingsRuntimeContext } from './settings-runtime'
import { Skills } from './Skills'

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

function mount(gateway = aSkillsGateway()) {
  render(
    <SettingsRuntimeContext.Provider value={aSettingsRuntime({ manage: { transport: gateway.transport } })}>
      <Skills />
    </SettingsRuntimeContext.Provider>
  )

  return gateway
}

const installedList = () => screen.getByRole('list', { name: 'INSTALLED' })
const hubList = () => screen.findByRole('list', { name: 'CATALOGUE' })

describe('the installed skills', () => {
  it('lists them with the bot’s switches, bundled and added told apart', async () => {
    mount()

    const list = await screen.findByRole('list', { name: 'INSTALLED' })

    expect(
      within(list)
        .getAllByRole('checkbox')
        .map(box => (box as HTMLInputElement).checked)
    ).toEqual([true, true])
    expect(within(list).getByRole('checkbox', { name: 'docx' })).toBeTruthy()
    expect(within(list).getByText('Category: Bundled')).toBeTruthy()
    expect(within(list).getByText('Category: Added')).toBeTruthy()
  })

  it('shows the other bot’s switches when it is picked', async () => {
    mount()

    await screen.findByRole('list', { name: 'INSTALLED' })
    fireEvent.change(screen.getByRole('combobox', { name: 'Bot' }), { target: { value: 'writer' } })

    await waitFor(() => expect(within(installedList()).getAllByRole('checkbox')).toHaveLength(1))
    expect((within(installedList()).getByRole('checkbox', { name: 'pdf' }) as HTMLInputElement).checked).toBe(false)
  })

  it('writes the whole disabled set when a switch is moved, not only the skill that changed', async () => {
    const gateway = mount(
      aSkillsGateway({ installed: { researcher: ['docx', 'pdf', 'xlsx'] }, disabled: { researcher: ['xlsx'] } })
    )

    fireEvent.click(await screen.findByRole('checkbox', { name: 'pdf' }))

    await waitFor(() => expect(gateway.writes).toEqual([['pdf', 'xlsx']]))
    expect((screen.getByRole('checkbox', { name: 'pdf' }) as HTMLInputElement).checked).toBe(false)

    fireEvent.click(screen.getByRole('checkbox', { name: 'xlsx' }))
    await waitFor(() => expect(gateway.writes.at(-1)).toEqual(['pdf']))
  })

  it('writes two quick moves one after the other, each from the state on screen', async () => {
    const gateway = mount(aSkillsGateway({ installed: { researcher: ['docx', 'pdf'] }, disabled: { researcher: [] } }))

    fireEvent.click(await screen.findByRole('checkbox', { name: 'docx' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'pdf' }))

    await waitFor(() => expect(gateway.writes.at(-1)).toEqual(['docx', 'pdf']))
    expect(gateway.writes.length).toBe(2)
  })

  it('puts the switch back and says why when the gateway refuses', async () => {
    const gateway = mount()

    gateway.refuseConfigure('the profile is read only')
    fireEvent.click(await screen.findByRole('checkbox', { name: 'docx' }))

    expect(await screen.findByText('Could not change that: the profile is read only')).toBeTruthy()
    expect((screen.getByRole('checkbox', { name: 'docx' }) as HTMLInputElement).checked).toBe(true)
  })

  it('draws no switch when the gateway cannot say which are on, rather than switches guessed on', async () => {
    mount(aSkillsGateway({ noDescribe: true }))

    await screen.findByText('docx')
    expect(within(installedList()).queryAllByRole('checkbox')).toHaveLength(0)
  })

  it('says there are none, and says a skill cannot be removed from here', async () => {
    mount(aSkillsGateway({ installed: { researcher: [] } }))
    expect(await screen.findByText('No skills installed yet.')).toBeTruthy()

    cleanup()
    mount()
    expect(await screen.findByText(/no way to remove a skill from here/u)).toBeTruthy()
  })
})

describe('the hub', () => {
  it('is browsed first, and a skill the bot has already is marked rather than offered', async () => {
    mount()

    const list = await hubList()

    expect(within(list).getAllByRole('listitem')).toHaveLength(3)
    expect(within(list).getByRole('button', { name: 'Install xlsx' })).toBeTruthy()
    expect(within(list).queryByRole('button', { name: 'Install pdf' })).toBeNull()
    expect(within(within(list).getByText('pdf').closest('li') as HTMLElement).getByText('Installed')).toBeTruthy()
  })

  it('is searched after a pause, and says when nothing matched', async () => {
    const gateway = mount()

    await hubList()
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search the hub' }), { target: { value: 'vid' } })

    await waitFor(() =>
      expect(within(screen.getByRole('list', { name: 'CATALOGUE' })).getAllByRole('listitem')).toHaveLength(1)
    )
    expect(gateway.rpc.at(-1)?.params).toMatchObject({ action: 'search', query: 'vid' })

    fireEvent.change(screen.getByRole('searchbox', { name: 'Search the hub' }), { target: { value: 'zzz' } })
    expect(await screen.findByText('Nothing matched.')).toBeTruthy()
  })

  it('shows more pages of the browse when there are more', async () => {
    mount(aSkillsGateway({ hubPages: 2 }))

    const list = await hubList()

    expect(within(list).getAllByRole('listitem')).toHaveLength(3)
    fireEvent.click(screen.getByRole('button', { name: 'Show more' }))

    await waitFor(() =>
      expect(within(screen.getByRole('list', { name: 'CATALOGUE' })).getAllByRole('listitem')).toHaveLength(6)
    )
    expect(screen.queryByRole('button', { name: 'Show more' })).toBeNull()
  })

  it('opens a row’s details with the hub’s instructions in a box that scrolls, and closes them again', async () => {
    mount()

    await hubList()
    fireEvent.click(screen.getByRole('button', { name: 'Details of xlsx' }))

    await waitFor(() => expect(document.querySelector('pre.hm-manage__scroll')).toBeTruthy())

    const preview = document.querySelector('pre.hm-manage__scroll')

    expect(preview?.getAttribute('aria-label')).toBe('Instructions of xlsx')
    expect(preview?.textContent).toContain('# xlsx')
    expect(preview?.getAttribute('tabindex')).toBe('0')
    expect(screen.getByRole('button', { name: 'Hide the details of xlsx' }).getAttribute('aria-expanded')).toBe('true')

    fireEvent.click(screen.getByRole('button', { name: 'Hide the details of xlsx' }))
    expect(document.querySelector('pre.hm-manage__scroll')).toBeNull()
  })

  it('draws the hub’s text as characters, never as markup', async () => {
    const gateway = aSkillsGateway()
    const original = gateway.transport.gateway.request

    gateway.transport.gateway.request = (async (method: string, params: Record<string, unknown>) => {
      const answer = (await (original as (m: string, p: unknown) => Promise<Record<string, unknown>>)(
        method,
        params
      )) as {
        items?: { description: string }[]
      }

      if (method === 'skills.manage' && params.action === 'browse' && answer.items) {
        answer.items[0]!.description = '<img src=x onerror=alert(1)>'
      }

      return answer
    }) as never
    mount(gateway)

    const text = await screen.findByText('<img src=x onerror=alert(1)>')

    expect(text.querySelector('img')).toBeNull()
  })
})

describe('installing', () => {
  it('installs into the picked bot, says so, and the skill is then in the list and marked in the hub', async () => {
    const gateway = mount()

    fireEvent.click(await screen.findByRole('button', { name: 'Install xlsx' }))

    expect(await screen.findByText('Installed xlsx.')).toBeTruthy()
    expect(gateway.rpc.find(call => (call.params as { action?: string }).action === 'install')?.params).toEqual({
      action: 'install',
      query: 'xlsx',
      profile: 'researcher'
    })
    expect(await within(installedList()).findByRole('checkbox', { name: 'xlsx' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Install xlsx' })).toBeNull()
  })

  it('prints the command to run where the gateway is hosted when it cannot install over the socket', async () => {
    mount(aSkillsGateway({ noInstall: true }))

    fireEvent.click(await screen.findByRole('button', { name: 'Install xlsx' }))

    expect(await screen.findByText(/cannot install skills over its socket/u)).toBeTruthy()
    expect(screen.getByText('hermes --profile researcher skills install xlsx')).toBeTruthy()
  })

  it('says why an install failed', async () => {
    const gateway = mount()
    const request = gateway.transport.gateway.request

    gateway.transport.gateway.request = (async (method: string, params: Record<string, unknown>) => {
      if (params.action === 'install') {
        throw new Error('the hub is down')
      }

      return (request as (m: string, p: unknown) => unknown)(method, params)
    }) as never
    fireEvent.click(await screen.findByRole('button', { name: 'Install xlsx' }))

    expect(await screen.findByText('Could not install: the hub is down')).toBeTruthy()
  })
})
