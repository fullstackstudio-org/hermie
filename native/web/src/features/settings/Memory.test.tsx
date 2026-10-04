/**
 * Settings › Memory against an in-memory plugin: the three states before any page (advert not read, no memory
 * browser, read only), both files with their usage, an entry edited and saved or reverted, removed after a
 * question, added from the field under its file, the store's own refusal, the search, the raw disclosure and the
 * providers that cannot be listed.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { webPluginAdvertOf } from '../../core/advert'
import { resetActiveLocale, setActiveLocale } from '../../i18n/active-locale'
import { loadCatalogue } from '../../i18n/catalogue'
import { pluginStore } from '../../state/plugin'
import { httpFailure } from '../../test-support/manage-transport'
import { aMemoryPlugin } from '../../test-support/memory-plugin'
import { aSettingsRuntime } from '../../test-support/settings-runtime'
import { aBot, resetShellStores, seedRoster } from '../../test-support/shell-stores'
import { Memory } from './Memory'
import { SettingsRuntimeContext } from './settings-runtime'

const advert = (capabilities: string[]) =>
  webPluginAdvertOf({ v: 1, version: '0.5.0', capabilities, modules: {}, limits: {}, updatedAt: 1 })

beforeEach(() => {
  resetShellStores()
  document.documentElement.lang = 'en'
  seedRoster([
    aBot('researcher', { displayName: 'Researcher', isDefault: true }),
    aBot('writer', { displayName: 'Writer' })
  ])
  pluginStore.getState().apply(advert(['memory.browse', 'memory.edit']))
})

afterEach(() => {
  cleanup()
  resetActiveLocale()
})

function mount(plugin = aMemoryPlugin()) {
  render(
    <SettingsRuntimeContext.Provider value={aSettingsRuntime({ manage: { transport: plugin.transport } })}>
      <Memory />
    </SettingsRuntimeContext.Provider>
  )

  return plugin
}

const writesOf = (plugin: ReturnType<typeof aMemoryPlugin>) =>
  plugin.requests.filter(request => request.method === 'POST').map(request => request.body as Record<string, unknown>)

describe('before there is a page', () => {
  it('waits, in a sentence, until the gateway has said what is installed', () => {
    pluginStore.getState().reset()
    mount()

    expect(screen.getByText('Waiting for the gateway to say what is installed…')).toBeTruthy()
    expect(screen.queryByRole('combobox')).toBeNull()
  })

  it('says what to install when the plugin has no memory browser, and reads nothing', () => {
    pluginStore.getState().apply(advert(['push.relay']))

    const plugin = mount()

    expect(screen.getByText('The Hermie plugin has no memory browser')).toBeTruthy()
    expect(screen.getByText('hermes plugins install hermie')).toBeTruthy()
    expect(plugin.requests).toEqual([])
  })

  it('says there are no bots when the roster is empty', () => {
    seedRoster([])
    mount()

    expect(screen.getByText('No bots yet.')).toBeTruthy()
  })
})

describe('the page', () => {
  it('shows both files of the default bot with their entries and how full they are', async () => {
    mount()

    expect(await screen.findByText('Northwind invoices monthly.')).toBeTruthy()
    expect(screen.getByRole('heading', { level: 3, name: 'MEMORY.md' })).toBeTruthy()
    expect(screen.getByRole('heading', { level: 3, name: 'USER.md' })).toBeTruthy()
    expect(screen.getByText('Robin lives in Lisbon.')).toBeTruthy()
    expect(screen.getAllByRole('meter')[0]?.getAttribute('aria-label')).toBe('MEMORY.md is 10% full')
    expect(screen.getAllByText(/of 2200 characters/u)).toHaveLength(2)
  })

  it('names the providers that cannot be listed, once, and not the built-in one', async () => {
    mount()

    expect(await screen.findByText('mem0')).toBeTruthy()
    expect(screen.getByText('Not browsable')).toBeTruthy()
    expect(screen.queryByText('builtin')).toBeNull()
  })

  it('reads the other bot’s memory when it is picked', async () => {
    const plugin = mount()

    await screen.findByText('Northwind invoices monthly.')
    fireEvent.change(screen.getByRole('combobox', { name: 'Bot' }), { target: { value: 'writer' } })

    expect(await screen.findByText('Drafts open with the verb.')).toBeTruthy()
    expect(screen.queryByText('Northwind invoices monthly.')).toBeNull()
    expect(plugin.requests.at(-1)?.path).toContain('profile=writer')
  })

  it('draws an entry as text, never as markup', async () => {
    mount(aMemoryPlugin({ researcher: { memory: ['<img src=x onerror=alert(1)> **bold**'], user: [] } }))

    const text = await screen.findByText('<img src=x onerror=alert(1)> **bold**')

    expect(text.querySelector('img')).toBeNull()
    expect(text.querySelector('strong')).toBeNull()
  })

  it('says the switch is off when the gateway refuses the read', async () => {
    const plugin = aMemoryPlugin()

    plugin.transport.http.get = (async () => {
      throw httpFailure(403)
    }) as never
    mount(plugin)

    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(screen.getByRole('alert').textContent).toContain('switched off')
  })

  it('offers a retry after a failed read, and reads again', async () => {
    const plugin = aMemoryPlugin()
    const get = plugin.transport.http.get

    let fail = true

    plugin.transport.http.get = (async (path: string) => {
      if (fail) {
        fail = false
        throw httpFailure(500)
      }

      return get(path)
    }) as never
    mount(plugin)

    expect(await screen.findByRole('alert')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))

    expect(await screen.findByText('Northwind invoices monthly.')).toBeTruthy()
  })
})

describe('editing', () => {
  it('replaces an entry by its text and its position, and reads the file again', async () => {
    const plugin = mount()

    await screen.findByText('Prefers footnotes.')
    fireEvent.click(screen.getByRole('button', { name: 'Edit entry 2 in MEMORY.md' }))

    const field = screen.getByRole('textbox', { name: 'Text of entry 2 in MEMORY.md' })

    expect((field as HTMLTextAreaElement).value).toBe('Prefers footnotes.')
    fireEvent.change(field, { target: { value: 'Prefers footnotes to parentheses.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Replace' }))

    expect(await screen.findByText('Prefers footnotes to parentheses.')).toBeTruthy()
    expect(writesOf(plugin)).toEqual([
      {
        profile: 'researcher',
        target: 'memory',
        op: 'replace',
        content: 'Prefers footnotes to parentheses.',
        old_text: 'Prefers footnotes.',
        index: 1
      }
    ])
    expect(screen.getByText('Replaced.')).toBeTruthy()
  })

  it('puts the entry back as it was on Cancel, and writes nothing', async () => {
    const plugin = mount()

    await screen.findByText('Prefers footnotes.')
    fireEvent.click(screen.getByRole('button', { name: 'Edit entry 2 in MEMORY.md' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Text of entry 2 in MEMORY.md' }), {
      target: { value: 'Something else' }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))

    expect(screen.getByText('Prefers footnotes.')).toBeTruthy()
    expect(screen.queryByRole('textbox', { name: 'Text of entry 2 in MEMORY.md' })).toBeNull()
    expect(writesOf(plugin)).toEqual([])

    // The reader is back where they were: on the button that opened the editor.
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Edit entry 2 in MEMORY.md' }))
    )

    // And the next edit starts from the gateway's text, not the dropped draft.
    fireEvent.click(screen.getByRole('button', { name: 'Edit entry 2 in MEMORY.md' }))
    expect((screen.getByRole('textbox', { name: 'Text of entry 2 in MEMORY.md' }) as HTMLTextAreaElement).value).toBe(
      'Prefers footnotes.'
    )
  })

  it('does not offer to save an entry that is unchanged or empty', async () => {
    mount()

    await screen.findByText('Prefers footnotes.')
    fireEvent.click(screen.getByRole('button', { name: 'Edit entry 2 in MEMORY.md' }))

    const save = screen.getByRole('button', { name: 'Replace' }) as HTMLButtonElement

    expect(save.disabled).toBe(true)
    fireEvent.change(screen.getByRole('textbox', { name: 'Text of entry 2 in MEMORY.md' }), {
      target: { value: '   ' }
    })
    expect(save.disabled).toBe(true)
  })

  it('shows the store’s own sentence when it refuses, and keeps the draft', async () => {
    const plugin = mount()

    plugin.refuseWith('Memory at 2,190/2,200 chars. Adding this entry would exceed the limit.')
    await screen.findByText('Prefers footnotes.')
    fireEvent.click(screen.getByRole('button', { name: 'Edit entry 2 in MEMORY.md' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Text of entry 2 in MEMORY.md' }), {
      target: { value: 'A much longer entry' }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Replace' }))

    expect(await screen.findByText(/would exceed the limit/u)).toBeTruthy()
    expect((screen.getByRole('textbox', { name: 'Text of entry 2 in MEMORY.md' }) as HTMLTextAreaElement).value).toBe(
      'A much longer entry'
    )
  })

  it('adds an entry to the file it is written under, and clears the field', async () => {
    const plugin = mount()

    await screen.findByText('Robin lives in Lisbon.')

    const field = screen.getByRole('textbox', { name: 'Add to USER.md' }) as HTMLTextAreaElement

    fireEvent.change(field, { target: { value: 'Reads Dutch.' } })
    fireEvent.click(within(field.closest('form') as HTMLElement).getByRole('button', { name: 'Add' }))

    expect(await screen.findByText('Reads Dutch.')).toBeTruthy()
    expect(writesOf(plugin)).toEqual([{ profile: 'researcher', target: 'user', op: 'add', content: 'Reads Dutch.' }])
    await waitFor(() =>
      expect((screen.getByRole('textbox', { name: 'Add to USER.md' }) as HTMLTextAreaElement).value).toBe('')
    )
  })

  it('does not send an empty add', async () => {
    const plugin = mount()

    await screen.findByText('Robin lives in Lisbon.')

    for (const button of screen.getAllByRole('button', { name: 'Add' })) {
      expect((button as HTMLButtonElement).disabled).toBe(true)
    }

    expect(writesOf(plugin)).toEqual([])
  })
})

describe('removing', () => {
  it('asks first, with Cancel under the focus, and removes only when told to', async () => {
    const plugin = mount()

    await screen.findByText('Prefers footnotes.')
    fireEvent.click(screen.getByRole('button', { name: 'Remove entry 2 from MEMORY.md' }))

    expect(screen.getByText('Remove this entry?')).toBeTruthy()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Keep it' }))
    expect(writesOf(plugin)).toEqual([])

    fireEvent.click(screen.getByRole('button', { name: 'Keep it' }))
    expect(screen.queryByText('Remove this entry?')).toBeNull()
    expect(writesOf(plugin)).toEqual([])
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Remove entry 2 from MEMORY.md' }))
    )

    fireEvent.click(screen.getByRole('button', { name: 'Remove entry 2 from MEMORY.md' }))
    fireEvent.click(screen.getByRole('button', { name: 'Remove entry 2 from MEMORY.md' }))

    await waitFor(() => expect(screen.queryByText('Prefers footnotes.')).toBeNull())
    expect(writesOf(plugin)).toEqual([
      { profile: 'researcher', target: 'memory', op: 'remove', old_text: 'Prefers footnotes.', index: 1 }
    ])
    expect(screen.getByText('Removed.')).toBeTruthy()
    // The row is gone: the file's heading holds the focus.
    expect(document.activeElement).toBe(screen.getByRole('heading', { level: 3, name: 'MEMORY.md' }))
  })
})

describe('read only', () => {
  it('shows the entries with no way to change them, and says why', async () => {
    pluginStore.getState().apply(advert(['memory.browse']))
    mount()

    expect(await screen.findByText('Prefers footnotes.')).toBeTruthy()
    expect(screen.getByText(/lets memory be read and not written/u)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Edit entry/u })).toBeNull()
    expect(screen.queryByRole('button', { name: /Remove entry/u })).toBeNull()
    expect(screen.queryByRole('textbox', { name: /Add to/u })).toBeNull()
  })
})

describe('the search', () => {
  it('asks the plugin, shows what matched across both files, and says when nothing did', async () => {
    const plugin = mount()

    await screen.findByText('Prefers footnotes.')
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search this memory' }), {
      target: { value: 'lisbon robin' }
    })

    expect(await screen.findByText('Robin lives in Lisbon.')).toBeTruthy()
    expect(screen.queryByText('Prefers footnotes.')).toBeNull()
    expect(screen.getAllByText('1 entry').length).toBeGreaterThan(0)
    expect(plugin.requests.at(-1)?.path).toContain('q=lisbon%20robin')

    fireEvent.change(screen.getByRole('searchbox', { name: 'Search this memory' }), { target: { value: 'zebra' } })
    expect(await screen.findByText('Nothing matches “zebra”.')).toBeTruthy()

    fireEvent.change(screen.getByRole('searchbox', { name: 'Search this memory' }), { target: { value: '' } })
    expect(await screen.findByText('Prefers footnotes.')).toBeTruthy()
  })
})

describe('the raw disclosure', () => {
  it('is not read until it is opened, then shows each document as stored in a box that scrolls', async () => {
    const plugin = mount()

    await screen.findByText('Prefers footnotes.')
    expect(plugin.requests.some(request => request.path.includes('/raw'))).toBe(false)

    const details = screen.getByText('Raw').closest('details') as HTMLDetailsElement

    details.open = true
    fireEvent(details, new Event('toggle'))

    expect(await screen.findByText('mem0 lists nothing.')).toBeTruthy()

    const box = document.querySelector('pre.hm-manage__scroll')

    expect(box?.textContent).toBe('Northwind invoices monthly.\n§\nPrefers footnotes.')
    expect(box?.getAttribute('tabindex')).toBe('0')
    expect(screen.getByText('This one is empty.')).toBeTruthy()
  })

  it('says the plugin is too old when it has no raw route', async () => {
    const plugin = aMemoryPlugin()

    plugin.rawAnswers(404)
    mount(plugin)
    await screen.findByText('Prefers footnotes.')

    const details = screen.getByText('Raw').closest('details') as HTMLDetailsElement

    details.open = true
    fireEvent(details, new Event('toggle'))

    expect(await screen.findByText(/does not serve raw memory/u)).toBeTruthy()
  })
})

describe('the languages', () => {
  it('reads in Dutch with the catalogue’s words', async () => {
    await loadCatalogue('nl')
    setActiveLocale('nl')
    mount()

    expect(await screen.findByRole('heading', { level: 2, name: 'Geheugen' })).toBeTruthy()
    expect(screen.getByRole('searchbox', { name: 'Zoek in dit geheugen' })).toBeTruthy()
  })
})
