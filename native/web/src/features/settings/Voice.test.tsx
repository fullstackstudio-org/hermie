/**
 * Settings, Voice: each half is there only where the browser has it and says what it is, every choice reaches the
 * store and the browser's own storage, and the page is labelled the way every radio group is. Fake `speechSynthesis`
 * and `SpeechRecognition` on the window.
 */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import axe from 'axe-core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { resetActiveLocale } from '../../i18n/active-locale'
import { resetLocale, setLanguageChoice } from '../../i18n/locale'
import { createKeyValueStore } from '../../platform/key-value-store'
import { settingsStore } from '../../state/settings'
import { VOICE_KEY, voiceSettingsStore } from '../../state/voice-settings'
import { resetShellStores } from '../../test-support/shell-stores'
import { Voice } from './Voice'

const speak = (): void => {
  Object.defineProperty(window, 'SpeechSynthesisUtterance', { configurable: true, value: class {} })
  Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: {} })
}

const listen = (): void => {
  Object.defineProperty(window, 'webkitSpeechRecognition', { configurable: true, value: class {} })
}

beforeEach(() => {
  resetShellStores()
  document.documentElement.lang = 'en'
})

afterEach(() => {
  cleanup()
  for (const name of ['speechSynthesis', 'SpeechSynthesisUtterance', 'webkitSpeechRecognition', 'SpeechRecognition']) {
    Reflect.deleteProperty(window, name)
  }

  voiceSettingsStore.getState().reset()
  settingsStore.getState().reset()
  resetLocale()
  resetActiveLocale()
})

const group = (name: string) => screen.getByRole('group', { name })

describe('the Voice page', () => {
  it('has both halves where the browser has both, under the section’s title', () => {
    speak()
    listen()
    render(<Voice />)

    expect(screen.getByRole('heading', { level: 2, name: 'Voice' })).toBeTruthy()
    expect(group('Reading aloud')).toBeTruthy()
    expect(group('Dictation language')).toBeTruthy()
    expect(screen.getByRole('checkbox', { name: 'Stop when the app closes' })).toBeTruthy()
  })

  it('has no dictation where the browser cannot take it, and says who does the transcribing where it can', () => {
    speak()
    render(<Voice />)

    expect(screen.queryByRole('group', { name: 'Dictation language' })).toBeNull()
    expect(screen.queryByText(/sends the audio to the browser’s maker/u)).toBeNull()
    expect(group('Reading aloud')).toBeTruthy()

    cleanup()
    Reflect.deleteProperty(window, 'speechSynthesis')
    listen()
    render(<Voice />)

    expect(
      screen.getByText(/sends the audio to the browser’s maker \(Google for Chrome, Apple for Safari\)/u)
    ).toBeTruthy()
    expect(screen.queryByRole('group', { name: 'Reading aloud' })).toBeNull()
    expect(screen.queryByRole('checkbox', { name: 'Stop when the app closes' })).toBeNull()
  })

  it('says plainly that there is nothing to set where the browser has neither half', () => {
    render(<Voice />)

    expect(screen.getByText('This browser can neither read aloud nor take dictation.')).toBeTruthy()
    expect(screen.queryByRole('radio')).toBeNull()
  })

  it('offers the five speeds by name, the one in force checked, and changes it', () => {
    speak()
    render(<Voice />)

    const speeds = within(group('Reading aloud')).getAllByRole('radio')

    expect(speeds.map(radio => radio.closest('label')?.textContent)).toEqual([
      'Slowest',
      'Slow',
      'Normal',
      'Fast',
      'Fastest'
    ])
    expect((speeds[2] as HTMLInputElement).checked).toBe(true)

    fireEvent.click(speeds[4] as HTMLInputElement)
    expect(voiceSettingsStore.getState().rate).toBe(1.5)
    expect((within(group('Reading aloud')).getAllByRole('radio')[4] as HTMLInputElement).checked).toBe(true)
  })

  it('switches stopping when the tab goes away', () => {
    speak()
    render(<Voice />)

    const box = screen.getByRole('checkbox', { name: 'Stop when the app closes' }) as HTMLInputElement

    expect(box.checked).toBe(true)
    fireEvent.click(box)
    expect(voiceSettingsStore.getState().stopOnBackground).toBe(false)
  })

  it('lists the browser’s own language and the three Hermie speaks, by their own names, and changes it', () => {
    listen()
    render(<Voice />)

    const languages = within(group('Dictation language')).getAllByRole('radio')

    expect(languages.map(radio => radio.closest('label')?.textContent)).toEqual([
      'Device language',
      'English',
      'Nederlands',
      'Deutsch'
    ])

    fireEvent.click(languages[2] as HTMLInputElement)
    expect(voiceSettingsStore.getState().dictationLanguage).toBe('nl')
  })

  it('keeps a language chosen elsewhere listed, so the group shows what is in force', () => {
    listen()
    voiceSettingsStore.getState().setDictationLanguage('fr-FR')
    render(<Voice />)

    const checked = within(group('Dictation language'))
      .getAllByRole('radio')
      .filter(radio => (radio as HTMLInputElement).checked)

    expect(checked.map(radio => radio.closest('label')?.textContent)).toEqual(['fr-FR'])
  })

  it('reads what this browser kept, and writes a choice back under a key that survives a sign-out', () => {
    speak()

    const data = new Map<string, string>()
    const kv = createKeyValueStore({
      namespace: '/',
      storage: {
        getItem: key => data.get(key) ?? null,
        setItem: (key, value) => void data.set(key, value),
        removeItem: key => void data.delete(key),
        key: index => [...data.keys()][index] ?? null,
        get length() {
          return data.size
        }
      }
    })

    kv.setSync(VOICE_KEY, JSON.stringify({ rate: 0.5 }))
    settingsStore.getState().hydrate(kv)
    render(<Voice />)

    expect((within(group('Reading aloud')).getAllByRole('radio')[0] as HTMLInputElement).checked).toBe(true)

    fireEvent.click(within(group('Reading aloud')).getAllByRole('radio')[3] as HTMLInputElement)
    expect(JSON.parse(data.get(`hermie:/:${VOICE_KEY}`) ?? '{}').rate).toBe(1.25)
  })

  it('does not offer to confirm before sending: that belongs to a hands-free mode this client does not have', () => {
    speak()
    listen()
    render(<Voice />)

    expect(screen.queryByText('Confirm before sending')).toBeNull()
  })

  it.each(['nl', 'de'] as const)('reads in %s', async locale => {
    speak()
    listen()
    await setLanguageChoice(locale)
    render(<Voice />)

    expect(screen.getAllByRole('group').length).toBeGreaterThanOrEqual(2)
    expect(screen.getByRole('heading', { level: 2 }).textContent).not.toBe('Voice')
  })

  it('has no violation, with both halves on screen', async () => {
    document.title = 'Hermie'
    speak()
    listen()
    render(
      <main>
        <h1>Settings</h1>
        <Voice />
      </main>
    )

    const result = await axe.run(document.documentElement, { rules: { 'color-contrast': { enabled: false } } })

    expect(result.violations.map(violation => `${violation.id}: ${violation.help}`)).toEqual([])
  })
})
