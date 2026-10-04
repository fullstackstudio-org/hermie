/**
 * The New bot page: the handle checked as it is typed (in the reader's language), the form's fields and what
 * they send, the model list the gateway offers, the way a create ends (the chat opens, or a bot with no model
 * stays on the page with a sentence), the gateway's own refusal under the form, the offline state, and axe.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import axe from 'axe-core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { resetActiveLocale, setActiveLocale } from '../../i18n/active-locale'
import { createHashRouter } from '../../platform/hash-router'
import { botsStore } from '../../state/bots'
import { connectionStore } from '../../state/connection'
import { aBot, resetShellStores, seedRoster } from '../../test-support/shell-stores'
import { ChatRuntimeContext, type ChatSessionRuntime } from '../chat/chat-runtime'
import { NewBotPage } from './NewBotPage'

beforeEach(() => {
  resetShellStores()
  document.documentElement.lang = 'en'
  connectionStore.getState().setStatus('ready', null)
  seedRoster([aBot('writer'), aBot('researcher')])
})

afterEach(() => {
  cleanup()
  resetActiveLocale()
})

const INVENTORY = {
  providers: [
    { slug: 'prov-a', name: 'Provider A', models: ['model-one', 'model-two'] },
    { slug: 'prov-b', name: 'Provider B', models: ['model-three'] }
  ]
}

interface Mounted {
  request: ReturnType<typeof vi.fn>
  refreshRoster: ReturnType<typeof vi.fn>
  navigate: ReturnType<typeof vi.fn>
}

function mount(
  answers: {
    create?: (params: Record<string, unknown>) => unknown
    models?: unknown
  } = {}
): Mounted {
  const request = vi.fn(async (method: string, params: Record<string, unknown> = {}) => {
    if (method === 'model.options') {
      if (answers.models === 'fail') {
        throw new Error('no inventory')
      }

      return answers.models ?? INVENTORY
    }

    if (method === 'profiles.create') {
      const answer = answers.create ? answers.create(params) : undefined

      if (answer instanceof Error) {
        throw answer
      }

      return (
        answer ?? {
          ok: true,
          name: params.name,
          path: `/p/${String(params.name)}`,
          model_set: false,
          mirrored: { model_inherited: true }
        }
      )
    }

    throw new Error(`unexpected ${method}`)
  })
  const refreshRoster = vi.fn(async () => {
    // What the gateway has now: the roster grows by the bot that was made.
    const made = request.mock.calls.find(call => call[0] === 'profiles.create')?.[1] as { name?: string } | undefined

    if (made?.name && !botsStore.getState().byName[made.name]) {
      seedRoster([...botsStore.getState().bots, aBot(made.name)])
    }
  })
  const router = createHashRouter(null)
  const navigate = vi.fn()

  router.navigate = navigate as never

  const runtime: ChatSessionRuntime = {
    controller: {} as never,
    gatewayBaseUrl: 'http://gw',
    profiles: { gateway: { request: request as never }, refreshRoster }
  }

  render(
    <ChatRuntimeContext.Provider value={runtime}>
      <NewBotPage router={router} />
    </ChatRuntimeContext.Provider>
  )

  return { request, refreshRoster, navigate }
}

const handle = (): HTMLInputElement => screen.getByRole('textbox', { name: 'Handle' }) as HTMLInputElement
const type = (field: HTMLElement, value: string): void => void fireEvent.change(field, { target: { value } })
const createButton = (): HTMLButtonElement =>
  screen.getByRole('button', { name: /^(Create bot|Making the bot…)$/u }) as HTMLButtonElement
const submit = async (): Promise<void> => {
  await act(async () => {
    fireEvent.click(createButton())
  })
}
const created = (m: Mounted): Record<string, unknown> | undefined =>
  m.request.mock.calls.find(call => call[0] === 'profiles.create')?.[1] as Record<string, unknown> | undefined

describe('the form', () => {
  it('has a handle, a description, a model and a bot to clone, each with a label', async () => {
    mount()

    expect(handle()).toBeTruthy()
    expect(screen.getByRole('textbox', { name: 'Description' })).toBeTruthy()
    expect(await screen.findByRole('combobox', { name: 'Model' })).toBeTruthy()
    expect(screen.getByRole('combobox', { name: 'Clone settings from' })).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Cancel' }).getAttribute('href')).toBe('#/')
  })

  it('offers the models grouped by provider, and inheriting first', async () => {
    mount()

    const select = (await screen.findByRole('combobox', { name: 'Model' })) as HTMLSelectElement

    expect([...select.options].map(option => option.value)).toEqual([
      '',
      'prov-a/model-one',
      'prov-a/model-two',
      'prov-b/model-three'
    ])
    expect(select.options[0]?.textContent).toBe('Inherit from the launch bot')
    expect([...select.querySelectorAll('optgroup')].map(group => group.label)).toEqual(['Provider A', 'Provider B'])
  })

  it('leaves the model field out when the gateway cannot say which models it has', async () => {
    const m = mount({ models: 'fail' })

    await waitFor(() => expect(m.request).toHaveBeenCalledWith('model.options', { explicit_only: true }))
    expect(screen.queryByRole('combobox', { name: 'Model' })).toBeNull()
  })

  it('lists the roster to clone from, starting fresh by default', () => {
    mount()

    const select = screen.getByRole('combobox', { name: 'Clone settings from' }) as HTMLSelectElement

    expect([...select.options].map(option => option.value)).toEqual(['', 'writer', 'researcher'])
    expect(select.value).toBe('')
  })

  it('does not offer a clone of nothing on an empty roster', () => {
    resetShellStores()
    connectionStore.getState().setStatus('ready', null)
    mount()

    expect(screen.queryByRole('combobox', { name: 'Clone settings from' })).toBeNull()
  })
})

describe('the handle', () => {
  it('says nothing before anything is typed, then what is wrong while it is typed', () => {
    mount()

    expect(screen.queryByText('A bot needs a handle.')).toBeNull()

    type(handle(), 'My Work')
    expect(screen.getByText(/Use lowercase letters, numbers/u).textContent).toContain('(for example: my-work)')
    expect(handle().getAttribute('aria-invalid')).toBe('true')
    expect(handle().getAttribute('aria-describedby')?.split(' ')).toHaveLength(2)
  })

  it('says a name that is on the roster is taken, and a reserved one is reserved', () => {
    mount()

    type(handle(), 'Writer')
    expect(screen.getByText('“writer” already exists.')).toBeTruthy()

    type(handle(), 'root')
    expect(screen.getByText(/“root” is reserved/u)).toBeTruthy()

    type(handle(), 'default')
    expect(screen.getByText(/built-in bot/u)).toBeTruthy()
  })

  it('warns that a hermes subcommand loses its shortcut, and lets it through', async () => {
    const m = mount()

    type(handle(), 'cron')
    expect(screen.getByText(/shortcut “hermes cron” will not be created/u)).toBeTruthy()
    expect(handle().getAttribute('aria-invalid')).toBeNull()

    await submit()
    expect(created(m)).toEqual({ name: 'cron' })
  })

  it('says the problems in Dutch and German', () => {
    mount()
    type(handle(), 'Writer')

    act(() => setActiveLocale('nl'))
    expect(screen.getByText('“writer” bestaat al.')).toBeTruthy()

    act(() => setActiveLocale('de'))
    expect(screen.getByText('„writer“ gibt es schon.')).toBeTruthy()
  })

  it('sends nothing for a handle that cannot work, and puts the cursor back in the field', async () => {
    const m = mount()

    await submit()
    expect(m.request.mock.calls.some(call => call[0] === 'profiles.create')).toBe(false)
    expect(screen.getByText('A bot needs a handle.')).toBeTruthy()
    expect(document.activeElement).toBe(handle())
  })
})

describe('creating', () => {
  it('sends the handle, the description, the pinned model with its provider and the clone source', async () => {
    const m = mount()

    type(handle(), 'Scout')
    type(screen.getByRole('textbox', { name: 'Description' }), '  Looks things up.  ')
    type(await screen.findByRole('combobox', { name: 'Model' }), 'prov-b/model-three')
    type(screen.getByRole('combobox', { name: 'Clone settings from' }), 'writer')
    await submit()

    expect(created(m)).toEqual({
      name: 'scout',
      description: 'Looks things up.',
      clone_from: 'writer',
      model: 'prov-b/model-three',
      provider: 'prov-b'
    })
  })

  it('reads the roster after the create and then opens the new bot’s chat', async () => {
    const m = mount()

    type(handle(), 'scout')
    await submit()

    await waitFor(() => expect(m.navigate).toHaveBeenCalledWith('#/chat/scout'))
    expect(m.refreshRoster).toHaveBeenCalledTimes(1)
  })

  it('opens the chat of the name the gateway stored, not the one that was typed', async () => {
    const m = mount({
      create: () => ({ ok: true, name: 'scout-2', path: '/p', model_set: true, mirrored: {} })
    })

    type(handle(), 'scout')
    m.refreshRoster.mockImplementation(async () => seedRoster([aBot('writer'), aBot('researcher'), aBot('scout-2')]))
    await submit()

    await waitFor(() => expect(m.navigate).toHaveBeenCalledWith('#/chat/scout-2'))
  })

  it('stays, with a sentence and the way into the chat, when the bot has no model', async () => {
    const m = mount({ create: params => ({ ok: true, name: params.name, path: '/p', model_set: false, mirrored: {} }) })

    type(handle(), 'scout')
    await submit()

    expect(
      await screen.findByText('This bot has no model yet. Pick one in its profile before you write to it.')
    ).toBeTruthy()
    expect(screen.getByText('scout is made.')).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Open the chat with scout' }).getAttribute('href')).toBe('#/chat/scout')
    expect(m.navigate).not.toHaveBeenCalled()
  })

  it('shows the gateway’s refusal under the form, as text, and keeps what was typed', async () => {
    const m = mount({ create: () => new Error('Profile “scout” already exists <b>x</b>') })

    type(handle(), 'scout')
    type(screen.getByRole('textbox', { name: 'Description' }), 'Keep me')
    await submit()

    const alert = await screen.findByRole('alert')

    expect(alert.textContent).toBe('Could not make the bot: Profile “scout” already exists <b>x</b>')
    expect(alert.querySelector('b')).toBeNull()
    expect(handle().value).toBe('scout')
    expect((screen.getByRole('textbox', { name: 'Description' }) as HTMLTextAreaElement).value).toBe('Keep me')
    expect(m.navigate).not.toHaveBeenCalled()
    // The button is usable again for another try.
    expect(createButton().disabled).toBe(false)
  })

  it('says the gateway made a bot it then did not list', async () => {
    const m = mount()

    type(handle(), 'scout')
    m.refreshRoster.mockImplementation(async () => undefined)
    await submit()

    expect((await screen.findByRole('alert')).textContent).toContain('The gateway made scout but did not list it')
    expect(m.navigate).not.toHaveBeenCalled()
  })

  it('is one create at a time: a second press while the first runs sends nothing', async () => {
    let release: () => void = () => undefined
    const hold = new Promise<void>(resolve => (release = resolve))
    const m = mount({
      create: () => hold.then(() => ({ ok: true, name: 'scout', path: '/p', model_set: true, mirrored: {} }))
    })

    type(handle(), 'scout')
    await submit()
    expect(createButton().textContent).toBe('Making the bot…')
    expect(createButton().getAttribute('aria-busy')).toBe('true')
    await submit()

    expect(m.request.mock.calls.filter(call => call[0] === 'profiles.create')).toHaveLength(1)

    seedRoster([aBot('writer'), aBot('researcher'), aBot('scout')])
    await act(async () => release())
    await waitFor(() => expect(m.navigate).toHaveBeenCalledTimes(1))
  })
})

describe('without a connection', () => {
  it('says so and does not offer to create', () => {
    connectionStore.getState().setStatus('disconnected', null)
    mount()

    expect(screen.getByRole('status').textContent).toBe(
      'Not connected to the gateway, so a bot cannot be made right now.'
    )
    expect(createButton().disabled).toBe(true)
  })
})

describe('accessibility', () => {
  it('has no axe violation, with an error showing', async () => {
    mount()
    type(handle(), 'Writer')

    const result = await axe.run(document.documentElement, {
      rules: { 'color-contrast': { enabled: false }, 'document-title': { enabled: false }, region: { enabled: false } }
    })

    expect(result.violations.map(violation => `${violation.id}: ${violation.help}`)).toEqual([])
  })
})
