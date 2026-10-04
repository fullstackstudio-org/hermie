/**
 * The list of keyboard shortcuts: a modal dialog named by its heading, drawn from the table the listener answers to
 * (every action, every way to do it, as the person's own keyboard says it), with the focus on Close while it is open,
 * the page behind it inert, Tab kept inside, Escape and the backdrop closing it and the focus going back to the opener.
 * Three languages, and axe.
 */
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import axe from 'axe-core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { resetActiveLocale } from '../../i18n/active-locale'
import { SHORTCUTS } from '../../platform/shortcuts'
import { chordLabel, ShortcutsDialog } from './ShortcutsDialog'

beforeEach(() => {
  document.documentElement.lang = 'en'
})

afterEach(() => {
  cleanup()
  resetActiveLocale()
  document.body.replaceChildren()
  vi.restoreAllMocks()
})

const dialog = (): HTMLElement => screen.getByRole('dialog', { name: 'Keyboard shortcuts' })

describe('what it says', () => {
  it('is a modal dialog named by its heading and described by what it is', () => {
    render(<ShortcutsDialog onClose={() => undefined} />)

    expect(dialog().getAttribute('aria-modal')).toBe('true')
    expect(screen.getByRole('heading', { level: 2, name: 'Keyboard shortcuts' })).toBeTruthy()
    expect(document.getElementById(dialog().getAttribute('aria-describedby') ?? '')?.textContent).toMatch(
      /^Each line lists every way to do it/u
    )
  })

  it('has a row for each action, named for what it does, with every way to do it in a key element', () => {
    render(<ShortcutsDialog onClose={() => undefined} />)

    const rows = within(dialog()).getAllByRole('row').slice(1)

    expect(rows.map(row => within(row).getByRole('rowheader').textContent)).toEqual([
      'Search the chats',
      'New conversation in this chat',
      'Previous chat',
      'Next chat',
      'Go to chat 1 to 9 of the list',
      'Show this list'
    ])
    expect(rows).toHaveLength(SHORTCUTS.length)

    const keysOf = (name: string): string[] =>
      [
        ...(within(rows.find(row => within(row).queryByRole('rowheader', { name }))!)
          .getByRole('cell')
          .querySelectorAll('kbd') ?? [])
      ].map(kbd => kbd.textContent ?? '')

    expect(keysOf('Search the chats')).toEqual(['Ctrl+K'])
    expect(keysOf('New conversation in this chat')).toEqual(['Ctrl+N', 'Ctrl+Alt+N'])
    expect(keysOf('Previous chat')).toEqual(['Ctrl+↑', 'Alt+↑', 'Ctrl+Shift+Tab'])
    expect(keysOf('Next chat')).toEqual(['Ctrl+↓', 'Alt+↓', 'Ctrl+Tab'])
    expect(keysOf('Go to chat 1 to 9 of the list')).toEqual(['Ctrl+1–9'])
    expect(keysOf('Show this list')).toEqual(['?', 'Ctrl+/'])
  })

  it('has a header for each column, and says what a new conversation asks and what a browser keeps', () => {
    render(<ShortcutsDialog onClose={() => undefined} />)

    expect(
      within(dialog())
        .getAllByRole('columnheader')
        .map(cell => cell.textContent)
    ).toEqual(['What it does', 'Keys'])
    expect(within(dialog()).getByText(/A new conversation asks first/u)).toBeTruthy()
    expect(within(dialog()).getByText(/Your browser keeps some shortcuts for itself/u)).toBeTruthy()
  })

  it('says the keys with a Mac’s symbols on a Mac', () => {
    expect(chordLabel({ key: 'k', mod: true }, true)).toBe('⌘K')
    expect(chordLabel({ key: 'n', mod: true, alt: true }, true)).toBe('⌘⌥N')
    expect(chordLabel({ key: 'ArrowUp', mod: true }, true)).toBe('⌘↑')
    expect(chordLabel({ key: 'Tab', ctrl: true, shift: true }, true)).toBe('⌃⇧Tab')
    expect(chordLabel({ key: 'Digit', mod: true }, true)).toBe('⌘1–9')
    expect(chordLabel({ key: '?', shift: 'any' }, true)).toBe('?')
  })

  it('says them with words elsewhere', () => {
    expect(chordLabel({ key: 'k', mod: true }, false)).toBe('Ctrl+K')
    expect(chordLabel({ key: 'ArrowDown', alt: true }, false)).toBe('Alt+↓')
    expect(chordLabel({ key: 'Tab', ctrl: true, shift: true }, false)).toBe('Ctrl+Shift+Tab')
    expect(chordLabel({ key: '/', mod: true }, false)).toBe('Ctrl+/')
  })
})

describe('a dialog’s manners', () => {
  it('puts the focus on Close, and makes everything behind it inert', () => {
    render(
      <div id="app">
        <button id="behind">behind</button>
        <ShortcutsDialog onClose={() => undefined} />
      </div>
    )

    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Done' }))
    expect(document.getElementById('behind')?.closest('[inert]')).not.toBeNull()
    expect(document.getElementById('app')?.hasAttribute('inert')).toBe(false)
  })

  it('closes with its button, Escape and a press on the backdrop, and not on a press inside', () => {
    const onClose = vi.fn()

    render(<ShortcutsDialog onClose={onClose} />)

    fireEvent.click(dialog())
    expect(onClose).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Done' }))
    fireEvent.keyDown(dialog(), { key: 'Escape' })
    fireEvent.click(dialog().parentElement as HTMLElement)
    expect(onClose).toHaveBeenCalledTimes(3)
  })

  it('keeps Tab inside, round from the last control to the first', () => {
    render(<ShortcutsDialog onClose={() => undefined} />)

    const done = screen.getByRole('button', { name: 'Done' })

    // The one control is first and last: Tab and Shift+Tab stay on it.
    const forward = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })

    done.dispatchEvent(forward)
    expect(forward.defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(done)

    const back = new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true })

    done.dispatchEvent(back)
    expect(back.defaultPrevented).toBe(true)
  })

  it('gives the focus back to what asked for it, once it is closed', () => {
    const opener = document.createElement('button')

    document.body.append(opener)

    const { unmount } = render(<ShortcutsDialog onClose={() => undefined} opener={opener} />)

    expect(document.activeElement).not.toBe(opener)
    unmount()
    expect(document.activeElement).toBe(opener)
  })

  it('lets the page go back to normal: nothing stays inert after it closes', () => {
    const { unmount } = render(
      <div id="app">
        <button id="behind">behind</button>
        <ShortcutsDialog onClose={() => undefined} />
      </div>
    )

    unmount()
    expect(document.querySelector('[inert]')).toBeNull()
  })
})

describe('languages and accessibility', () => {
  it('speaks Dutch and German', async () => {
    const { setLanguageChoice } = await import('../../i18n/locale')

    render(<ShortcutsDialog onClose={() => undefined} />)

    await act(() => setLanguageChoice('nl'))
    expect(screen.getByRole('dialog', { name: 'Sneltoetsen' })).toBeTruthy()
    expect(screen.getByRole('rowheader', { name: 'In de chats zoeken' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Klaar' })).toBeTruthy()

    await act(() => setLanguageChoice('de'))
    expect(screen.getByRole('dialog', { name: 'Tastenkürzel' })).toBeTruthy()
    expect(screen.getByRole('rowheader', { name: 'In den Chats suchen' })).toBeTruthy()
  })

  it('has no axe violation', async () => {
    render(<ShortcutsDialog onClose={() => undefined} />)

    const result = await axe.run(document.documentElement, {
      rules: { 'color-contrast': { enabled: false }, 'document-title': { enabled: false }, region: { enabled: false } }
    })

    expect(result.violations.map(violation => `${violation.id}: ${violation.help}`)).toEqual([])
  })
})
