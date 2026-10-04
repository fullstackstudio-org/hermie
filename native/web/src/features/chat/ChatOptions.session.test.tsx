/**
 * The chat's own session options in the chat screen: fast mode, the reasoning effort, the model (with
 * the gateway's expensive-model question), the context meter and the export.
 *
 * The state is the session's own report (`ChatState.info`, written by `session.info`), so the fake
 * controller plays the gateway: it answers a `setOption` and then tells every page what it now holds,
 * the way `ChatController.setOption` does. Nothing here guesses a value from a click.
 */
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import axe from 'axe-core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { resetActiveLocale } from '../../i18n/active-locale'
import { setLanguageChoice } from '../../i18n/locale'
import { chatViewStore } from '../../state/chat-view'
import { chatsStore } from '../../state/chats'
import { connectionStore } from '../../state/connection'
import { assistantItem, chatWith, toolItem, userItem } from '../../test-support/chat-fixtures'
import { aBot, resetShellStores, seedRoster } from '../../test-support/shell-stores'
import { ChatScreen } from './ChatScreen'
import { ChatRuntimeContext, type ChatScreenController } from './chat-runtime'
import type { ModelChoice } from '../../core/chat-controller'

const MODEL = 'example-provider/example-model'

const catalogue: ModelChoice[] = [
  { id: MODEL, label: 'example-model', provider: 'Example Provider' },
  { id: 'example-provider/expensive-model', label: 'expensive-model', provider: 'Example Provider' },
  { id: 'second-provider/reasoner-2', label: 'reasoner-2', provider: 'Second Provider' }
]

const USAGE = {
  context_used: 164_200,
  context_max: 200_000,
  context_percent: 82.1,
  context_source: 'model catalog',
  context_estimated: false
}

/** What the gateway says about the session: the whole info record, as `session.info` carries it. */
const tell = (over: Record<string, unknown>): void => {
  const info = { ...chatsStore.getState().chats.researcher?.info, ...over }

  act(() =>
    chatsStore.getState().dispatchEvent('researcher', { type: 'session.info', session_id: 'rt-1', payload: info })
  )
}

interface Fake {
  setOption: ReturnType<typeof vi.fn>
  refreshOptions: ReturnType<typeof vi.fn>
  refreshUsage: ReturnType<typeof vi.fn>
  modelOptions: ReturnType<typeof vi.fn>
}

function fakeController(over: Partial<Record<keyof ChatScreenController, unknown>> = {}) {
  const controller = {
    openChat: vi.fn(async () => undefined),
    openSession: vi.fn(async () => ({ kind: 'current' as const })),
    openConversation: vi.fn(async () => undefined),
    loadOlder: vi.fn(async () => 'start' as const),
    readKeyFor: vi.fn((bot: string) => bot),
    closeChat: vi.fn(async () => undefined),
    send: vi.fn(async () => undefined),
    runSlash: vi.fn(async () => ({})),
    slashRouteFor: vi.fn(() => null),
    querySlash: vi.fn(async () => ({ items: [] })),
    stopTurn: vi.fn(async () => undefined),
    // The gateway answers; an expensive model asks first, and only a confirmed one is switched.
    setOption: vi.fn(
      async (_bot: string, key: string, value: string, options: { confirmExpensiveModel?: boolean } = {}) => {
        if (key === 'model' && value.includes('expensive') && !options.confirmExpensiveModel) {
          return { confirmRequired: true, confirmMessage: `${value} is an expensive model. Continue?` }
        }

        tell(
          key === 'fast'
            ? { fast: value === 'fast' }
            : key === 'reasoning'
              ? { reasoning_effort: value }
              : key === 'model'
                ? { model: value }
                : {}
        )

        return {}
      }
    ),
    refreshOptions: vi.fn(async () => null),
    refreshUsage: vi.fn(async () => null),
    modelOptions: vi.fn(async () => catalogue),
    ...over
  }

  return controller as typeof controller & ChatScreenController & Fake
}

function mount(controller = fakeController(), bot = 'researcher') {
  render(
    <ChatRuntimeContext.Provider value={{ controller, gatewayBaseUrl: 'http://gateway.test' }}>
      <ChatScreen bot={bot} />
    </ChatRuntimeContext.Provider>
  )

  return controller
}

/** An attached chat of the reader's own, its session reporting what `info` says. */
const attach = (info: Record<string, unknown> = {}, over: Parameters<typeof chatWith>[2] = {}): void => {
  act(() =>
    chatsStore.getState().hydrate(
      'researcher',
      chatWith('researcher', [userItem('What changed?'), assistantItem('Mostly fixes.')], {
        runtimeSessionId: 'rt-1',
        info: { model: MODEL, reasoning_effort: 'medium', fast: false, yolo: false, usage: USAGE, ...info },
        ...over
      })
    )
  )
}

const openOptions = async (): Promise<HTMLElement> => {
  fireEvent.click(screen.getByRole('button', { name: 'Chat options' }))

  return screen.findByRole('group', { name: 'This conversation' })
}

beforeEach(() => {
  resetShellStores()
  resetActiveLocale()
  connectionStore.getState().setStatus('ready', null)
  seedRoster([aBot('researcher', { displayName: 'Dr. Researcher' })])
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('fast mode', () => {
  it('shows what the session reports, switches it with the gateway’s own words, and follows the session', async () => {
    attach({ fast: false })

    const controller = mount()
    const row = await openOptions()
    const box = within(row).getByRole('checkbox', { name: 'Fast mode' }) as HTMLInputElement

    expect(box.checked).toBe(false)
    expect(document.getElementById(box.getAttribute('aria-describedby') ?? '')?.textContent).toBe(
      'Prioritize response speed'
    )

    fireEvent.click(box)
    expect(controller.setOption).toHaveBeenCalledWith('researcher', 'fast', 'fast', {})
    await waitFor(() => expect(box.checked).toBe(true))

    fireEvent.click(box)
    expect(controller.setOption).toHaveBeenLastCalledWith('researcher', 'fast', 'normal', {})
    await waitFor(() => expect(box.checked).toBe(false))
  })

  it('shows another device’s change, not the last click', async () => {
    attach({ fast: false })
    mount()

    const row = await openOptions()

    tell({ fast: true })
    expect((within(row).getByRole('checkbox', { name: 'Fast mode' }) as HTMLInputElement).checked).toBe(true)
  })
})

describe('reasoning effort', () => {
  it('is a labelled select of the efforts the gateway takes, on the one the session reports', async () => {
    attach({ reasoning_effort: 'medium' })

    const controller = mount()
    const row = await openOptions()
    const select = within(row).getByRole('combobox', { name: 'Reasoning effort' }) as HTMLSelectElement

    expect(Array.from(select.options).map(option => [option.value, option.text])).toEqual([
      ['none', 'Off'],
      ['minimal', 'Minimal'],
      ['low', 'Low'],
      ['medium', 'Medium'],
      ['high', 'High'],
      ['xhigh', 'Extra high'],
      ['max', 'Max'],
      ['ultra', 'Ultra']
    ])
    expect(select.value).toBe('medium')

    fireEvent.change(select, { target: { value: 'high' } })
    expect(controller.setOption).toHaveBeenCalledWith('researcher', 'reasoning', 'high', {})
    await waitFor(() => expect(select.value).toBe('high'))
  })

  it('keeps an effort this client has no name for, and says so when the session reports none', async () => {
    attach({ reasoning_effort: 'turbo' })
    mount()

    const row = await openOptions()
    const select = within(row).getByRole('combobox', { name: 'Reasoning effort' }) as HTMLSelectElement

    expect(select.value).toBe('turbo')
    expect(within(select).getByRole('option', { name: 'turbo' })).toBeTruthy()

    tell({ reasoning_effort: undefined })
    expect(within(select).getByRole('option', { name: 'Not reported' })).toBeTruthy()
  })
})

describe('the model', () => {
  it('is a select cut into providers, on the model the session reports, and switches it', async () => {
    attach()

    const controller = mount()
    const row = await openOptions()
    const select = (await within(row).findByRole('combobox', { name: 'Model' })) as HTMLSelectElement

    await waitFor(() => expect(controller.modelOptions).toHaveBeenCalled())
    await waitFor(() => expect(within(select).getAllByRole('group').length).toBe(2))
    expect(within(select).getByRole('group', { name: 'Example Provider' })).toBeTruthy()
    expect(within(select).getByRole('group', { name: 'Second Provider' })).toBeTruthy()
    expect(select.value).toBe(MODEL)

    fireEvent.change(select, { target: { value: 'second-provider/reasoner-2' } })
    expect(controller.setOption).toHaveBeenCalledWith('researcher', 'model', 'second-provider/reasoner-2', {})
    await waitFor(() => expect(select.value).toBe('second-provider/reasoner-2'))
  })

  it('lists the chat’s own model even when the gateway’s inventory is empty', async () => {
    attach()
    mount(fakeController({ modelOptions: vi.fn(async () => []) }))

    const row = await openOptions()
    const select = (await within(row).findByRole('combobox', { name: 'Model' })) as HTMLSelectElement

    expect(select.options).toHaveLength(1)
    expect(select.value).toBe(MODEL)
  })

  it('offers a search from eight models, which narrows the list and never removes the chat’s own', async () => {
    attach()

    const many: ModelChoice[] = Array.from({ length: 9 }, (_, index) => ({
      id: `local-runner/model-${index}`,
      label: `model-${index}`,
      provider: 'Local Runner'
    }))

    mount(fakeController({ modelOptions: vi.fn(async () => [...catalogue, ...many]) }))

    const row = await openOptions()
    const search = await within(row).findByRole('searchbox', { name: 'Search models' })
    const select = within(row).getByRole('combobox', { name: 'Model' }) as HTMLSelectElement

    fireEvent.change(search, { target: { value: 'reasoner' } })
    expect(Array.from(select.options).map(option => option.value)).toEqual([MODEL, 'second-provider/reasoner-2'])

    fireEvent.change(search, { target: { value: 'no such model' } })
    expect(Array.from(select.options).map(option => option.value)).toEqual([MODEL])
    expect(within(row).getByText('No other model matches.')).toBeTruthy()
  })

  it('has no search for a short list', async () => {
    attach()
    mount()

    const row = await openOptions()

    await within(row).findByRole('combobox', { name: 'Model' })
    expect(within(row).queryByRole('searchbox')).toBeNull()
  })
})

describe('an expensive model', () => {
  it('asks first, in the gateway’s words, and the picker stays on the model the chat is on', async () => {
    attach()

    const controller = mount()
    const row = await openOptions()
    const select = (await within(row).findByRole('combobox', { name: 'Model' })) as HTMLSelectElement

    await waitFor(() => expect(select.options.length).toBeGreaterThan(1))
    fireEvent.change(select, { target: { value: 'example-provider/expensive-model' } })

    const question = await within(row).findByRole('group', { name: 'This model costs more' })

    expect(controller.setOption).toHaveBeenCalledTimes(1)
    expect(controller.setOption).toHaveBeenCalledWith('researcher', 'model', 'example-provider/expensive-model', {})
    expect(within(question).getByText('example-provider/expensive-model is an expensive model. Continue?')).toBeTruthy()
    // Never switched on the reader's behalf: the picker still shows the real model, and focus is on the safe answer.
    expect(select.value).toBe(MODEL)
    expect(document.activeElement).toBe(within(question).getByRole('button', { name: 'Cancel' }))
  })

  it('says it in its own words when the gateway gave none', async () => {
    attach()

    const controller = mount()

    controller.setOption.mockResolvedValueOnce({ confirmRequired: true })

    const row = await openOptions()
    const select = (await within(row).findByRole('combobox', { name: 'Model' })) as HTMLSelectElement

    await waitFor(() => expect(select.options.length).toBeGreaterThan(1))
    fireEvent.change(select, { target: { value: 'second-provider/reasoner-2' } })
    expect(await within(row).findByText('This model costs more than the current one.')).toBeTruthy()
  })

  it('is withdrawn by Cancel or Escape, which send nothing and keep the panel open', async () => {
    attach()

    const controller = mount()
    const row = await openOptions()
    const select = (await within(row).findByRole('combobox', { name: 'Model' })) as HTMLSelectElement

    await waitFor(() => expect(select.options.length).toBeGreaterThan(1))
    fireEvent.change(select, { target: { value: 'example-provider/expensive-model' } })
    fireEvent.click(await within(row).findByRole('button', { name: 'Cancel' }))
    expect(within(row).queryByRole('button', { name: 'Use it anyway' })).toBeNull()
    expect(document.activeElement).toBe(select)

    fireEvent.change(select, { target: { value: 'example-provider/expensive-model' } })
    fireEvent.keyDown(await within(row).findByRole('button', { name: 'Cancel' }), { key: 'Escape' })
    expect(within(row).queryByRole('button', { name: 'Use it anyway' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Chat options' }).getAttribute('aria-expanded')).toBe('true')

    // Both questions were asked; neither was answered yes.
    expect(controller.setOption).toHaveBeenCalledTimes(2)
    expect(controller.setOption.mock.calls.every(call => call[3]?.confirmExpensiveModel !== true)).toBe(true)
    expect(select.value).toBe(MODEL)
  })

  it('switches only after the answer yes, which is the second call and carries the confirmation', async () => {
    attach()

    const controller = mount()
    const row = await openOptions()
    const select = (await within(row).findByRole('combobox', { name: 'Model' })) as HTMLSelectElement

    await waitFor(() => expect(select.options.length).toBeGreaterThan(1))
    fireEvent.change(select, { target: { value: 'example-provider/expensive-model' } })
    fireEvent.click(await within(row).findByRole('button', { name: 'Use it anyway' }))

    expect(controller.setOption).toHaveBeenLastCalledWith('researcher', 'model', 'example-provider/expensive-model', {
      confirmExpensiveModel: true
    })
    await waitFor(() => expect(select.value).toBe('example-provider/expensive-model'))
    expect(within(row).queryByRole('group', { name: 'This model costs more' })).toBeNull()
  })
})

describe('a refusal from the gateway', () => {
  it('is drawn as an alert in the error style, and the controls still show what the session holds', async () => {
    attach({ fast: false })

    const controller = mount(
      fakeController({
        setOption: vi.fn(async () => {
          throw new Error('unknown fast mode: sideways')
        })
      })
    )
    const row = await openOptions()
    const box = within(row).getByRole('checkbox', { name: 'Fast mode' }) as HTMLInputElement

    fireEvent.click(box)

    // In the options' own error style, next to the control that was refused.
    const alert = await within(row).findByRole('alert')

    expect(alert.textContent).toContain('Setting not changed: unknown fast mode: sideways')
    expect(alert.classList.contains('hm-chat-options__alert')).toBe(true)
    expect(box.checked).toBe(false)
    // What the gateway holds now is read again, whichever way it went.
    await waitFor(() => expect(controller.refreshOptions).toHaveBeenCalledWith('researcher'))

    fireEvent.click(within(alert).getByRole('button', { name: 'Dismiss' }))
    expect(within(row).queryByRole('alert')).toBeNull()
  })
})

describe('the context meter', () => {
  it('shows how full the window is, from the session, and asks the gateway once more when it opens', async () => {
    attach()

    const controller = mount()
    const row = await openOptions()
    const meter = within(row).getByRole('meter', { name: 'Context used' }) as HTMLMeterElement

    expect(meter.value).toBe(164_200)
    expect(meter.max).toBe(200_000)
    expect(within(row).getByText('82% · 164k / 200k')).toBeTruthy()
    // What it is, for a screen reader: the numbers and the explanation.
    const description = (meter.getAttribute('aria-describedby') ?? '')
      .split(' ')
      .map(id => document.getElementById(id)?.textContent)
      .join(' ')

    expect(description).toContain('82% · 164k / 200k')
    expect(description).toContain('How much of this session’s context window the conversation fills.')
    expect(controller.refreshUsage).toHaveBeenCalledWith('researcher')
  })

  it('follows the session as the conversation grows, and says when the count is an estimate', async () => {
    attach()
    mount()

    const row = await openOptions()

    tell({ usage: { ...USAGE, context_used: 100_000, context_estimated: true } })
    expect(within(row).getByText('50% · 100k / 200k (estimated)')).toBeTruthy()
    expect((within(row).getByRole('meter') as HTMLMeterElement).value).toBe(100_000)
  })

  it('is not drawn when the gateway does not say how big the window is', async () => {
    attach({ usage: { context_used: 5000 } })
    mount()

    const row = await openOptions()

    expect(within(row).queryByRole('meter')).toBeNull()
    expect(within(row).getByRole('checkbox', { name: 'Fast mode' })).toBeTruthy()
  })
})

describe('when the chat cannot be switched', () => {
  it('has none of the session’s options for a chat that is not attached, nor on a connection that is down', async () => {
    attach({}, { runtimeSessionId: undefined })

    const controller = mount()

    fireEvent.click(screen.getByRole('button', { name: 'Chat options' }))
    await screen.findByRole('group', { name: 'What this conversation shows' })
    expect(screen.queryByRole('checkbox', { name: 'Fast mode' })).toBeNull()
    expect(screen.queryByRole('combobox', { name: 'Model' })).toBeNull()
    expect(screen.queryByRole('combobox', { name: 'Reasoning effort' })).toBeNull()
    expect(screen.queryByRole('meter')).toBeNull()
    // Nothing asked the gateway for anything either.
    expect(controller.modelOptions).not.toHaveBeenCalled()
    expect(controller.refreshUsage).not.toHaveBeenCalled()

    attach()
    expect(await screen.findByRole('checkbox', { name: 'Fast mode' })).toBeTruthy()

    act(() => connectionStore.getState().setStatus('reconnecting', null))
    expect(screen.queryByRole('checkbox', { name: 'Fast mode' })).toBeNull()
    expect(screen.queryByRole('combobox', { name: 'Model' })).toBeNull()
  })
})

describe('the export', () => {
  const stubDownload = () => {
    const blobs: Blob[] = []
    const names: string[] = []

    vi.stubGlobal(
      'URL',
      Object.assign(URL, {
        createObjectURL: (blob: Blob) => {
          blobs.push(blob)

          return 'blob:hermie'
        },
        revokeObjectURL: () => undefined
      })
    )
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      names.push(this.download)
    })

    const textOf = (blob: Blob | undefined): Promise<string> =>
      new Promise((resolve, reject) => {
        const reader = new FileReader()

        reader.onload = () => resolve(String(reader.result))
        reader.onerror = () => reject(reader.error)
        reader.readAsText(blob as Blob)
      })

    return { blobs, names, textOf }
  }

  it('downloads the conversation on screen as Markdown and as plain text', async () => {
    attach()

    const { blobs, names, textOf } = stubDownload()

    mount()

    const row = await openOptions()
    const group = within(row).getByRole('group', { name: 'Export' })

    expect(within(group).getByText(/^The conversation as it is on screen/u)).toBeTruthy()

    fireEvent.click(within(group).getByRole('button', { name: 'Download as Markdown' }))
    await waitFor(() => expect(blobs).toHaveLength(1))
    expect(names[0]).toMatch(/^Dr-Researcher-\d{4}-\d{2}-\d{2}\.md$/u)

    const markdown = await textOf(blobs[0])

    expect(markdown).toContain('**You**')
    expect(markdown).toContain('What changed?')
    expect(markdown).toContain('Mostly fixes.')

    fireEvent.click(within(group).getByRole('button', { name: 'Download as plain text' }))
    await waitFor(() => expect(blobs).toHaveLength(2))
    expect(names[1]).toMatch(/\.txt$/u)
    expect(await textOf(blobs[1])).not.toContain('**You**')
  })

  it('leaves out what the chat’s view hides, as the screen does', async () => {
    act(() =>
      chatsStore
        .getState()
        .hydrate(
          'researcher',
          chatWith(
            'researcher',
            [userItem('What changed?'), toolItem('web_search', { summary: 'three results' }), assistantItem('Done.')],
            { runtimeSessionId: 'rt-1', info: { model: MODEL } }
          )
        )
    )

    const { blobs, textOf } = stubDownload()

    mount()
    act(() => chatViewStore.getState().setChatView('researcher', { level: 'verbose' }))

    const row = await openOptions()

    fireEvent.click(within(row).getByRole('button', { name: 'Download as plain text' }))
    await waitFor(() => expect(blobs).toHaveLength(1))
    expect(await textOf(blobs[0])).toContain('web_search')

    // Quiet: the tool row is not on screen, so it is not in the file.
    act(() => chatViewStore.getState().setChatView('researcher', { level: 'quiet' }))
    fireEvent.click(within(row).getByRole('button', { name: 'Download as plain text' }))
    await waitFor(() => expect(blobs).toHaveLength(2))

    const quiet = await textOf(blobs[1])

    expect(quiet).not.toContain('web_search')
    expect(quiet).toContain('Done.')
    expect(quiet).toContain('What changed?')
  })

  it('is offered with no session behind it, because the file is the page’s own', async () => {
    attach({}, { runtimeSessionId: undefined })
    mount()

    fireEvent.click(screen.getByRole('button', { name: 'Chat options' }))

    const row = await screen.findByRole('group', { name: 'This conversation' })

    expect(within(row).getByRole('button', { name: 'Download as Markdown' })).toBeTruthy()
    expect(within(row).queryByRole('checkbox', { name: 'Fast mode' })).toBeNull()
  })

  it('is not offered for a chat with nothing on screen', async () => {
    act(() =>
      chatsStore
        .getState()
        .hydrate('researcher', chatWith('researcher', [], { runtimeSessionId: undefined, info: { model: MODEL } }))
    )
    mount()

    fireEvent.click(screen.getByRole('button', { name: 'Chat options' }))
    await screen.findByRole('group', { name: 'What this conversation shows' })
    expect(screen.queryByRole('button', { name: 'Download as Markdown' })).toBeNull()
  })

  it('says so in the error style when the browser cannot make the file', async () => {
    attach()
    vi.stubGlobal(
      'URL',
      Object.assign(URL, {
        createObjectURL: () => {
          throw new Error('no blobs here')
        },
        revokeObjectURL: () => undefined
      })
    )
    mount()

    const row = await openOptions()

    fireEvent.click(within(row).getByRole('button', { name: 'Download as Markdown' }))

    const alert = await screen.findByRole('alert')

    expect(alert.textContent).toContain('The conversation could not be exported.')
    fireEvent.click(within(alert).getByRole('button', { name: 'Dismiss' }))
    expect(screen.queryByRole('alert')).toBeNull()
  })
})

describe('in Dutch and German', () => {
  it('reads the options, the efforts and the export in the reader’s language', async () => {
    attach()
    await act(async () => setLanguageChoice('nl'))

    mount()
    fireEvent.click(screen.getByRole('button', { name: /opties/iu }))

    const row = await screen.findByRole('group', { name: 'Dit gesprek' })

    expect(within(row).getByRole('checkbox', { name: 'Snelle modus' })).toBeTruthy()

    const effort = within(row).getByRole('combobox', { name: 'Redeneerniveau' })

    expect(within(effort).getByRole('option', { name: 'Hoog' })).toBeTruthy()
    expect(within(row).getByRole('combobox', { name: 'Model' })).toBeTruthy()
    expect(within(row).getByRole('meter')).toBeTruthy()
    expect(within(row).getByRole('button', { name: /Markdown/u })).toBeTruthy()

    await act(async () => setLanguageChoice('de'))
    expect(
      within(await screen.findByRole('group', { name: 'Diese Unterhaltung' })).getByRole('option', { name: 'Hoch' })
    ).toBeTruthy()
  })
})

describe('through axe', () => {
  const violations = async (): Promise<string[]> => {
    // The screen alone, not the app: no landmarks or title of the page are in this render.
    const result = await axe.run(document.documentElement, {
      rules: { 'color-contrast': { enabled: false }, region: { enabled: false }, 'document-title': { enabled: false } }
    })

    return result.violations.map(
      violation =>
        `${violation.id}: ${violation.help} (${violation.nodes.map(node => node.target.join(' ')).join(', ')})`
    )
  }

  it.each(['en', 'nl', 'de'] as const)(
    'has no violation with every control and the expensive-model question open, in %s',
    async language => {
      attach()
      await act(async () => setLanguageChoice(language))

      const controller = mount()

      fireEvent.click(screen.getByRole('button', { name: /^(Chat options|Chatopties|Chat-Optionen)$/u }))

      const row = (await screen.findAllByRole('group')).find(group =>
        group.classList.contains('hm-chat-options__conversation')
      )
      const select = (await within(row as HTMLElement).findAllByRole('combobox')).at(-1) as HTMLSelectElement

      await waitFor(() => expect(select.options.length).toBeGreaterThan(1))
      fireEvent.change(select, { target: { value: 'example-provider/expensive-model' } })
      await waitFor(() => expect(controller.setOption).toHaveBeenCalled())
      await waitFor(() => expect((row as HTMLElement).querySelector('.hm-chat-options__confirm')).not.toBeNull())

      expect(await violations()).toEqual([])
    }
  )
})
