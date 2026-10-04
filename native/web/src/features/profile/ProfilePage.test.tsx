/**
 * A bot's profile page against a gateway that keeps a profile the way the real one does: what it reads, the
 * description that waits for Save (and its refusals), the picture (a refusal of the file itself, a write, a
 * removal), the reader's own name and colour (which need no gateway), the capability switches that write at
 * once, the gateway's reload question, and the states without a gateway (offline, read-only, unsupported).
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import axe from 'axe-core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { AvatarError, type PreparedAvatar } from '../../core/bot-profile/avatar'
import { resetActiveLocale } from '../../i18n/active-locale'
import { botsStore } from '../../state/bots'
import { connectionStore } from '../../state/connection'
import { layoutStore } from '../../state/layout'
import { gateway } from '../../test-support/fake-profile-gateway'
import { aBot, resetShellStores, seedRoster } from '../../test-support/shell-stores'
import { ChatRuntimeContext, type ChatSessionRuntime } from '../chat/chat-runtime'
import { SettingsRuntimeContext } from '../settings/settings-runtime'
import { ProfilePage } from './ProfilePage'

const prepare = vi.hoisted(() => vi.fn())

vi.mock('../../core/bot-profile/avatar', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  prepareAvatar: prepare
}))

const denied = (message = 'Read-only account.') => Object.assign(new Error(message), { code: 4030 })

beforeEach(() => {
  resetShellStores()
  document.documentElement.lang = 'en'
  connectionStore.getState().setStatus('ready', null)
  seedRoster([aBot('writer', { model: 'anthropic/claude-sonnet-5-5', provider: 'anthropic' })])
  layoutStore.getState().reconcile(['writer'])
  prepare.mockReset()
})

afterEach(() => {
  cleanup()
  resetActiveLocale()
})

function mount(fake = gateway(), over: { profiles?: boolean } = {}) {
  const refreshRoster = vi.fn(async () => [])
  const runtime: ChatSessionRuntime = {
    controller: {} as never,
    gatewayBaseUrl: 'http://gw',
    ...(over.profiles === false ? {} : { profiles: { gateway: { request: fake.request as never }, refreshRoster } })
  }

  render(
    <SettingsRuntimeContext.Provider value={{ hermesVersion: '0.21.3' } as never}>
      <ChatRuntimeContext.Provider value={runtime}>
        <ProfilePage bot="writer" />
      </ChatRuntimeContext.Provider>
    </SettingsRuntimeContext.Provider>
  )

  return { fake, refreshRoster }
}

/** Mounted and read. */
async function ready(fake = gateway()) {
  const mounted = mount(fake)

  await screen.findByRole('checkbox', { name: 'pdf' })

  return mounted
}

const box = (name: string): HTMLInputElement => screen.getByRole('checkbox', { name }) as HTMLInputElement
const description = (): HTMLTextAreaElement =>
  screen.getByRole('textbox', { name: 'Description' }) as HTMLTextAreaElement
const photoInput = (): HTMLInputElement => screen.getByTestId('profile-photo-input') as HTMLInputElement

const pick = (file = new File(['x'], 'me.png', { type: 'image/png' })) =>
  act(async () => {
    fireEvent.change(photoInput(), { target: { files: [file] } })
  })

describe('what it shows', () => {
  it('reads the profile, and says it is reading until it has', async () => {
    const fake = gateway()

    fake.hold('profiles.describe')
    mount(fake)
    expect(screen.getByRole('status').textContent).toBe('Reading this bot’s configuration…')
    fake.release('profiles.describe')

    await screen.findByRole('checkbox', { name: 'pdf' })
    expect(description().value).toBe('Writes.')
    expect(fake.calls[0]).toEqual({ method: 'profiles.describe', params: { name: 'writer' } })
  })

  it('has a way back to the chat, and the facts: handle, model, provider, session, gateway', async () => {
    await ready()

    expect(screen.getByRole('link', { name: 'Back to chat' }).getAttribute('href')).toBe('#/chat/writer')

    const facts = within(screen.getByRole('region', { name: 'About this bot' }))

    expect(facts.getByText('Model').nextElementSibling?.textContent).not.toBe('—')
    expect(facts.getByText('Provider').nextElementSibling?.textContent).toBe('anthropic')
    expect(facts.getByText('Session').nextElementSibling?.textContent).toBe('stored-writer')
    expect(facts.getByText('Gateway').nextElementSibling?.textContent).toBe('0.21.3')
    expect(screen.getByText('Profile name').nextElementSibling?.textContent).toBe('writer')
  })

  it('lists the toolsets, skills and MCP servers as switches, with the toolsets saying they follow the defaults', async () => {
    await ready()

    expect(['FILES', 'WEB', 'TERMINAL'].map(name => box(name).checked)).toEqual([true, true, false])
    expect(['pdf', 'docx', 'xlsx'].map(name => box(name).checked)).toEqual([true, true, true])
    expect(['github', 'local'].map(name => box(name).checked)).toEqual([true, true])
    expect(screen.getByText(/follows the gateway’s defaults/u)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Use the gateway’s defaults' })).toBeNull()
  })

  it('is as the gateway answers when it holds a pin, with the way back to the defaults', async () => {
    await ready(gateway({ pinned: ['terminal'] }))

    expect(box('TERMINAL').checked).toBe(true)
    expect(screen.getByRole('button', { name: 'Use the gateway’s defaults' })).toBeTruthy()
  })
})

describe('the name and the colour, which are the reader’s own', () => {
  it('names the bot for this reader, on Return, and clears it on an empty field', async () => {
    await ready()

    const field = screen.getByRole('textbox', { name: /Display name/u }) as HTMLInputElement

    expect(field.placeholder).toBe('Writer')
    fireEvent.change(field, { target: { value: '  The Scribe  ' } })
    fireEvent.keyDown(field, { key: 'Enter' })

    expect(layoutStore.getState().labels.writer).toBe('The Scribe')
    expect(field.value).toBe('The Scribe')
    expect(screen.getByRole('status').textContent).toBe('Name saved.')

    fireEvent.change(field, { target: { value: '   ' } })
    fireEvent.blur(field)
    expect(layoutStore.getState().labels.writer).toBeUndefined()
  })

  it('does not write a name that did not change', async () => {
    await ready()

    const setLabel = vi.spyOn(layoutStore.getState(), 'setLabel')
    const field = screen.getByRole('textbox', { name: /Display name/u })

    fireEvent.blur(field)
    expect(setLabel).not.toHaveBeenCalled()
  })

  it('colours the chat at once, through the layout store, and says which is in force', async () => {
    await ready()

    const group = screen.getByRole('group', { name: 'Colour for Writer' })

    expect((within(group).getByRole('radio', { name: 'Default' }) as HTMLInputElement).checked).toBe(true)
    fireEvent.click(within(group).getByRole('radio', { name: 'Teal' }))

    expect(layoutStore.getState().accents.writer).toBe('teal')
    expect((within(group).getByRole('radio', { name: 'Teal' }) as HTMLInputElement).checked).toBe(true)
  })

  it('keeps working with no gateway at all, and says what it cannot do', () => {
    mount(gateway(), { profiles: false })

    expect(screen.getByText(/does not offer profile editing/u)).toBeTruthy()
    expect(screen.getByRole('textbox', { name: /Display name/u })).toBeTruthy()
    fireEvent.click(screen.getByRole('radio', { name: 'Red' }))
    expect(layoutStore.getState().accents.writer).toBe('red')
    expect(screen.queryByRole('textbox', { name: 'Description' })).toBeNull()
    expect(screen.queryByRole('checkbox')).toBeNull()
  })
})

describe('the description', () => {
  it('waits for Save: Save and Revert appear with an edit, and Save writes it trimmed and tells the list', async () => {
    const { fake, refreshRoster } = await ready()

    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull()
    fireEvent.change(description(), { target: { value: '  Writes well.  ' } })
    expect(fake.configures()).toEqual([])

    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(fake.configures()).toEqual([{ name: 'writer', description: 'Writes well.' }]))
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Save' })).toBeNull())
    expect(description().value).toBe('Writes well.')
    expect(refreshRoster).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('status').textContent).toBe('Description saved.')
  })

  it('reverts an edit', async () => {
    await ready()
    fireEvent.change(description(), { target: { value: 'Something else' } })
    fireEvent.click(screen.getByRole('button', { name: 'Revert' }))

    expect(description().value).toBe('Writes.')
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull()
  })

  it('says a refusal under the field in the gateway’s words, keeps the edit, and goes read-only on a denial', async () => {
    const { fake } = await ready()

    fake.fail('profiles.configure', denied('Read-only account.'))
    fireEvent.change(description(), { target: { value: 'New' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    const alert = await screen.findByRole('alert')

    expect(alert.textContent).toContain('The gateway refused the change: Read-only account.')
    expect(description().value).toBe('New')
    // From here the gateway's half is read-only; the name and colour are not.
    expect(description().readOnly).toBe(true)
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull()
    expect(box('pdf').disabled).toBe(true)
    expect(screen.getByText(/may look at this bot and not change it/u)).toBeTruthy()
    expect((screen.getByRole('textbox', { name: /Display name/u }) as HTMLInputElement).readOnly).toBe(false)

    fireEvent.click(within(alert).getByRole('button', { name: 'Dismiss' }))
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('says when the gateway answered and did not apply it', async () => {
    const { fake } = await ready()

    fireEvent.change(description(), { target: { value: 'New' } })
    fake.request.mockImplementationOnce(async () => ({ ok: true, applied: { description: false } }))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    expect((await screen.findByRole('alert')).textContent).toContain('The gateway did not apply that change.')
  })
})

describe('the picture', () => {
  const prepared: PreparedAvatar = { base64: 'QUJD', dataUrl: 'data:image/jpeg;base64,QUJD' }

  it('prepares the file, writes it, shows it and tells the list; and offers to change and remove it then', async () => {
    prepare.mockResolvedValue(prepared)

    const { fake, refreshRoster } = await ready()

    expect(screen.getByRole('button', { name: /Choose a photo/u })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Remove photo/u })).toBeNull()
    await pick()

    await waitFor(() =>
      expect(fake.calls.at(-1)).toEqual({
        method: 'profiles.set_asset',
        params: { name: 'writer', asset: 'avatar', data: 'QUJD' }
      })
    )
    await waitFor(() =>
      expect(document.querySelector('.hm-profile__avatar img')?.getAttribute('src')).toBe(prepared.dataUrl)
    )
    expect(refreshRoster).toHaveBeenCalled()
    expect(screen.getByRole('status').textContent).toBe('Photo changed.')
    expect(screen.getByRole('button', { name: /Change photo/u })).toBeTruthy()
    // So choosing the same file again is a change again.
    expect(photoInput().value).toBe('')
  })

  it('removes it', async () => {
    botsStore.getState().setAvatar('writer', 0, 'data:image/png;base64,AAAA')

    const { fake } = await ready()

    expect(document.querySelector('.hm-profile__avatar img')).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /Remove photo/u }))

    await waitFor(() =>
      expect(fake.calls.at(-1)).toEqual({
        method: 'profiles.set_asset',
        params: { name: 'writer', asset: 'avatar', clear: true }
      })
    )
    await waitFor(() => expect(document.querySelector('.hm-profile__avatar img')).toBeNull())
    expect(screen.getByRole('status').textContent).toBe('Photo removed.')
  })

  it.each([
    ['not_image', 'That file is not a picture.'],
    ['too_large', 'That picture is too large to send.'],
    ['unreadable', 'That photo could not be uploaded.']
  ] as const)('says %s of the file itself, and sends nothing', async (problem, words) => {
    prepare.mockRejectedValue(new AvatarError(problem))

    const { fake } = await ready()

    await pick()

    expect((await screen.findByRole('alert')).textContent).toBe(words)
    expect(fake.calls.filter(call => call.method === 'profiles.set_asset')).toEqual([])
  })

  it('says a refusal of the gateway under the picture and keeps the old one', async () => {
    prepare.mockResolvedValue(prepared)

    const { fake } = await ready()

    fake.fail('profiles.set_asset', new Error('picture too big for this gateway'))
    await pick()

    expect((await screen.findByRole('alert')).textContent).toContain('picture too big for this gateway')
    expect(document.querySelector('.hm-profile__avatar img')).toBeNull()
  })
})

describe('the switches', () => {
  it('write at once, the whole list, and show the new state', async () => {
    const { fake } = await ready()

    fireEvent.click(box('docx'))
    await waitFor(() => expect(fake.configures()).toEqual([{ name: 'writer', disabled_skills: ['docx'] }]))
    expect(box('docx').checked).toBe(false)

    fireEvent.click(box('WEB'))
    await waitFor(() => expect(fake.configures().at(-1)).toEqual({ name: 'writer', enabled_toolsets: ['files'] }))
    // Pinned now: the page says so and offers the way back.
    expect(await screen.findByRole('button', { name: 'Use the gateway’s defaults' })).toBeTruthy()
  })

  it('refuse to switch off the last toolset, and say why instead of sending it', async () => {
    const { fake } = await ready(gateway({ pinned: ['files'] }))

    fireEvent.click(box('FILES'))

    expect((await screen.findByRole('alert')).textContent).toContain('One toolset has to stay on')
    expect(fake.configures()).toEqual([])
    expect(box('FILES').checked).toBe(true)
  })

  it('puts a switch back and says so when the gateway refuses it', async () => {
    const { fake } = await ready()

    fake.fail('profiles.configure', new Error('disk full'))
    fireEvent.click(box('pdf'))

    expect((await screen.findByRole('alert')).textContent).toContain('disk full')
    expect(box('pdf').checked).toBe(true)
  })

  it('puts the toolsets back to the gateway’s defaults', async () => {
    const { fake } = await ready(gateway({ pinned: ['terminal'] }))

    fireEvent.click(screen.getByRole('button', { name: 'Use the gateway’s defaults' }))

    await waitFor(() => expect(fake.configures()).toEqual([{ name: 'writer', enabled_toolsets: [] }]))
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Use the gateway’s defaults' })).toBeNull())
    expect(box('FILES').checked).toBe(true)
    expect(box('TERMINAL').checked).toBe(false)
  })

  it('asks the gateway’s question after an MCP change, in the app’s words, and answers it', async () => {
    const { fake } = await ready()

    fireEvent.click(box('github'))

    const prompt = await screen.findByRole('group', { name: 'Apply to running chats?' })

    // The gateway's own sentence is written for its command line and is not shown.
    expect(prompt.textContent).not.toContain('/reload-mcp')
    expect(prompt.textContent).toContain('re-sends its full input')
    expect(document.activeElement).toBe(within(prompt).getByRole('button', { name: 'Reload now' }))

    fireEvent.click(within(prompt).getByRole('button', { name: 'Reload, and stop asking' }))

    await waitFor(() =>
      expect(fake.calls.at(-1)).toEqual({ method: 'reload.mcp', params: { confirm: true, always: true } })
    )
    expect((await screen.findByText('MCP servers reloaded.')).getAttribute('role')).toBe('status')
    expect(screen.queryByRole('group', { name: 'Apply to running chats?' })).toBeNull()
  })

  it('lets the question go unanswered', async () => {
    await ready()
    fireEvent.click(box('github'))
    fireEvent.click(await screen.findByRole('button', { name: 'Not now' }))

    expect(screen.queryByRole('group', { name: 'Apply to running chats?' })).toBeNull()
  })
})

describe('without a working gateway', () => {
  it('says the connection is down, draws the gateway’s half read-only, and keeps what was read', async () => {
    await ready()
    act(() => connectionStore.getState().setStatus('reconnecting', null))

    expect(screen.getByText(/Not connected/u)).toBeTruthy()
    expect(box('pdf').disabled).toBe(true)
    expect(description().readOnly).toBe(true)
    expect(screen.getByRole('button', { name: /Choose a photo/u }).hasAttribute('disabled')).toBe(true)
  })

  it('says a read that failed, in the gateway’s words, and reads again on Try again', async () => {
    const fake = gateway()

    fake.fail('profiles.describe', new Error('boom'))
    mount(fake)

    expect((await screen.findByRole('alert')).textContent).toContain('boom')
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    await screen.findByRole('checkbox', { name: 'pdf' })
  })

  it('says it is not offered on a gateway without the method', async () => {
    const fake = gateway()

    fake.fail('profiles.describe', Object.assign(new Error('Unknown method'), { code: -32601 }))
    mount(fake)

    expect(await screen.findByText(/does not offer profile editing/u)).toBeTruthy()
    expect(screen.queryByRole('textbox', { name: 'Description' })).toBeNull()
    expect(screen.getByRole('textbox', { name: /Display name/u })).toBeTruthy()
  })

  it('reads again when the connection comes back', async () => {
    const fake = gateway()

    act(() => connectionStore.getState().setStatus('reconnecting', null))
    mount(fake)
    expect(fake.calls).toEqual([])

    act(() => connectionStore.getState().setStatus('ready', null))
    await screen.findByRole('checkbox', { name: 'pdf' })
  })
})

describe('in another language and for a screen reader', () => {
  it('has a heading for every section and passes axe, with the sections drawn', async () => {
    await ready()

    expect(screen.getAllByRole('heading', { level: 2 }).map(heading => heading.textContent)).toEqual([
      'Photo',
      'Name',
      'Description',
      'Colour',
      'Capabilities',
      'About this bot'
    ])

    const result = await axe.run(document.documentElement, {
      rules: { 'color-contrast': { enabled: false }, 'document-title': { enabled: false }, region: { enabled: false } }
    })

    expect(
      result.violations.map(
        violation => `${violation.id}: ${violation.nodes.map(node => node.html.slice(0, 120)).join(' | ')}`
      )
    ).toEqual([])
  })

  it('says its sections in German', async () => {
    const { setLanguageChoice } = await import('../../i18n/locale')

    await setLanguageChoice('de')
    mount()
    await screen.findByRole('checkbox', { name: 'pdf' })

    expect(screen.getAllByRole('heading', { level: 2 }).map(heading => heading.textContent)).toContain('Beschreibung')
    expect(screen.getByRole('link', { name: 'Zurück zum Chat' })).toBeTruthy()
  })
})
