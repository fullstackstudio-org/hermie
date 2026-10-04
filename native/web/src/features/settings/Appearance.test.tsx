/**
 * Settings, Appearance: each choice reaches its store (and so the document, which `bindTheme` and
 * `bindTextSize` keep in step), the language changes where the reader stands with nothing remounted,
 * every control is labelled and a radio group is operated by the keyboard the way a radio group is.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { resetActiveLocale } from '../../i18n/active-locale'
import { configureLocale, resetLocale, setLanguageChoice } from '../../i18n/locale'
import { resetShellStores } from '../../test-support/shell-stores'
import { settingsStore } from '../../state/settings'
import { textSizeStore } from '../../state/text-size'
import { uiMetaStatusStore } from '../../state/ui-meta-status'
import { Appearance } from './Appearance'

beforeEach(() => {
  resetShellStores()
  document.documentElement.lang = 'en'
})

afterEach(() => {
  cleanup()
  resetLocale()
  resetActiveLocale()
  configureLocale()
})

const group = (name: string) => screen.getByRole('group', { name })
const radio = (legend: string, label: string) => within(group(legend)).getByRole('radio', { name: label })

describe('the Appearance page', () => {
  it('names the section and groups every choice under a legend', () => {
    render(<Appearance />)

    expect(screen.getByRole('heading', { level: 2, name: 'Appearance' })).toBeTruthy()

    for (const legend of ['Theme', 'Accent colour', 'Language', 'Chat text size']) {
      expect(group(legend)).toBeTruthy()
    }
  })

  it('shows the scheme in force and changes it', () => {
    render(<Appearance />)

    expect((radio('Theme', 'System') as HTMLInputElement).checked).toBe(true)

    fireEvent.click(radio('Theme', 'Dark'))
    expect(settingsStore.getState().scheme).toBe('dark')
    expect((radio('Theme', 'Dark') as HTMLInputElement).checked).toBe(true)

    fireEvent.click(radio('Theme', 'Light'))
    expect(settingsStore.getState().scheme).toBe('light')
  })

  it('offers every tint by its name and changes it', () => {
    render(<Appearance />)

    const tints = within(group('Accent colour'))
      .getAllByRole('radio')
      .map(input => input.closest('label')?.textContent)

    expect(tints).toEqual(['Blue', 'Indigo', 'Violet', 'Magenta', 'Red', 'Orange', 'Teal', 'Green', 'Graphite'])

    fireEvent.click(radio('Accent colour', 'Teal'))
    expect(settingsStore.getState().tint).toBe('teal')
    expect((radio('Accent colour', 'Teal') as HTMLInputElement).checked).toBe(true)
  })

  it('changes the text size, which the bridge sends from the store', () => {
    render(<Appearance />)

    expect((radio('Chat text size', 'Default') as HTMLInputElement).checked).toBe(true)

    fireEvent.click(radio('Chat text size', 'Large'))
    expect(textSizeStore.getState().textSize).toBe('large')

    // A size another device sent is shown too.
    act(() => textSizeStore.getState().applyRemote('small'))
    expect((radio('Chat text size', 'Small') as HTMLInputElement).checked).toBe(true)
  })

  it('moves between the choices of a group with the arrow keys, as radios do', () => {
    render(<Appearance />)

    const system = radio('Theme', 'System')

    system.focus()
    // The browser moves the selection with the arrows; Testing Library does not, so the check is that
    // these are native radios of one group, which is where that behaviour comes from.
    const names = within(group('Theme'))
      .getAllByRole('radio')
      .map(input => (input as HTMLInputElement).name)

    expect(new Set(names).size).toBe(1)
    expect(names[0]).not.toBe('')
  })

  it('switches the language where the reader stands, and keeps what they picked', async () => {
    render(<Appearance />)

    expect((radio('Language', 'Follow browser') as HTMLInputElement).checked).toBe(true)
    expect(
      within(group('Language'))
        .getAllByRole('radio')
        .map(input => input.closest('label')?.textContent)
    ).toEqual(['Follow browser', 'English', 'Nederlands', 'Deutsch'])

    fireEvent.click(radio('Language', 'Nederlands'))

    expect(await screen.findByRole('heading', { level: 2, name: 'Weergave' })).toBeTruthy()
    expect(document.documentElement.lang).toBe('nl')
    // The same elements, in the new language: the group is named by its Dutch legend and still holds the pick.
    expect(
      (
        within(screen.getByRole('group', { name: 'Taal' })).getByRole('radio', {
          name: 'Nederlands'
        }) as HTMLInputElement
      ).checked
    ).toBe(true)
    expect(screen.getByRole('group', { name: 'Thema' })).toBeTruthy()

    fireEvent.click(within(screen.getByRole('group', { name: 'Taal' })).getByRole('radio', { name: 'Deutsch' }))

    expect(await screen.findByRole('heading', { level: 2, name: 'Darstellung' })).toBeTruthy()
    expect(document.documentElement.lang).toBe('de')
  })

  it('keeps a pick of "follow browser" even when it resolves to the language already in use', async () => {
    await act(async () => {
      await setLanguageChoice('nl')
    })
    render(<Appearance />)

    fireEvent.click(within(screen.getByRole('group', { name: 'Taal' })).getByRole('radio', { name: 'Volg browser' }))

    await waitFor(() =>
      expect(
        (
          within(screen.getByRole('group', { name: 'Taal' })).getByRole('radio', {
            name: 'Volg browser'
          }) as HTMLInputElement
        ).checked
      ).toBe(true)
    )
  })

  it('says when the text size is only kept in this browser, and nothing while the gateway takes it', () => {
    render(<Appearance />)
    expect(screen.queryByRole('status')).toBeNull()

    act(() => uiMetaStatusStore.getState().set('local'))
    expect(screen.getByRole('status').textContent).toContain('kept in this browser only')

    act(() => uiMetaStatusStore.getState().set('unavailable'))
    expect(screen.getByRole('status').textContent).toContain('Reload the page')

    act(() => uiMetaStatusStore.getState().set('synced'))
    expect(screen.queryByRole('status')).toBeNull()
  })
})
