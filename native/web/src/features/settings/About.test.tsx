/**
 * Settings, About: the build's own version and commit, and the licence list read from the file the build
 * carries beside the page: loading, a failure with Try again, an empty list, and each package's text.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { clientVersion, sourceCommit } from '../../build-info'
import { resetActiveLocale } from '../../i18n/active-locale'
import { aSettingsRuntime } from '../../test-support/settings-runtime'
import { resetShellStores } from '../../test-support/shell-stores'
import { About } from './About'
import { SettingsRuntimeContext } from './settings-runtime'

const FILE = {
  packages: [
    { name: 'react', version: '19.1.0', licence: 'MIT', repository: 'https://example.test/react', text: 'aaa' },
    { name: 'no-text', version: '1.0.0', licence: 'ISC' },
    { name: 'undeclared', version: '2.0.0', text: 'bbb' }
  ],
  texts: { aaa: 'MIT License\n\nCopyright (c) Somebody', bbb: 'A bespoke licence' }
}

const answer = (body: unknown, ok = true, status = 200) =>
  vi.fn(async () => ({ ok, status, json: async () => body }) as unknown as Response)

beforeEach(() => {
  resetShellStores()
  document.documentElement.lang = 'en'
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  resetActiveLocale()
})

function mount() {
  return render(
    <SettingsRuntimeContext.Provider value={aSettingsRuntime()}>
      <About />
    </SettingsRuntimeContext.Provider>
  )
}

const fact = (label: string): string | null | undefined =>
  screen.getByText(label, { selector: 'dt' }).closest('div')?.querySelector('dd')?.textContent

describe('the About page', () => {
  it('names the version and the commit of this build', async () => {
    vi.stubGlobal('fetch', answer(FILE))
    mount()

    expect(screen.getByRole('heading', { level: 2, name: 'About' })).toBeTruthy()
    expect(fact('Version')).toBe(clientVersion)
    expect(fact('Commit')).toBe(sourceCommit)
    await screen.findByRole('list', { name: 'Licences' })
  })

  it('reads the licence list from beside the page, and says it is loading until it arrives', async () => {
    const fetchImpl = answer(FILE)

    vi.stubGlobal('fetch', fetchImpl)
    mount()

    expect(screen.getByRole('status').textContent).toBe('Loading the licences…')

    await screen.findByRole('list', { name: 'Licences' })
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://gw.example.test/dashboard-plugins/hermie/app/licenses.json',
      expect.objectContaining({ signal: expect.anything() })
    )
  })

  it('lists each package with the licence it declares, and its text behind a disclosure', async () => {
    vi.stubGlobal('fetch', answer(FILE))
    mount()

    const list = await screen.findByRole('list', { name: 'Licences' })
    const items = within(list).getAllByRole('listitem')

    expect(items).toHaveLength(3)
    expect(screen.getByText('3 packages ship inside the web client. Open one to read its licence.')).toBeTruthy()
    expect(items[0]?.textContent).toContain('react 19.1.0')
    expect(items[0]?.textContent).toContain('MIT')
    expect(items[0]?.textContent).toContain('Source: https://example.test/react')
    expect(items[0]?.querySelector('pre')?.textContent).toBe('MIT License\n\nCopyright (c) Somebody')
    expect(items[1]?.textContent).toContain('This package ships no licence file.')
    expect(items[2]?.textContent).toContain('no licence declared')
  })

  it('draws a licence text as text, whatever it holds', async () => {
    vi.stubGlobal(
      'fetch',
      answer({
        packages: [{ name: 'x', version: '1', licence: 'MIT', text: 'h' }],
        texts: { h: '<img src=x onerror=alert(1)>' }
      })
    )
    mount()

    await screen.findByRole('list', { name: 'Licences' })
    expect(document.querySelector('img')).toBeNull()
    expect(document.querySelector('pre')?.textContent).toBe('<img src=x onerror=alert(1)>')
  })

  it('says a failure, and reads again when asked', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 404, json: async () => ({}) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => FILE })

    vi.stubGlobal('fetch', fetchImpl)
    mount()

    expect((await screen.findByRole('alert')).textContent).toBe('The licence list could not be loaded: HTTP 404')

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))

    await screen.findByRole('list', { name: 'Licences' })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('says a file that is not a list is not one, and a network failure by its message', async () => {
    vi.stubGlobal('fetch', answer({ nope: true }))
    mount()

    expect((await screen.findByRole('alert')).textContent).toBe(
      'The licence list could not be loaded: not a licence list'
    )
    cleanup()

    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')))
    mount()

    expect((await screen.findByRole('alert')).textContent).toContain('Failed to fetch')
  })

  it('says a build with no packages lists none', async () => {
    vi.stubGlobal('fetch', answer({ packages: [], texts: {} }))
    mount()

    expect(await screen.findByText('This build lists no packages.')).toBeTruthy()
  })

  it('does not report on a read it has stopped waiting for', async () => {
    let finish: (value: Response) => void = () => undefined

    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise<Response>(resolve => (finish = resolve)))
    )

    const view = mount()

    view.unmount()
    await act(async () => finish({ ok: true, status: 200, json: async () => FILE } as unknown as Response))

    await waitFor(() => expect(document.body.textContent).toBe(''))
  })
})
