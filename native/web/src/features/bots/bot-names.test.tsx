/**
 * A bot's two names and which of them is the large one: the rules (pure), the page's stores read through the hook,
 * and what each combination of the reader's two settings gives. The defaults (display name leads, the handle is
 * hidden for a named bot) are what the page drew before there was a setting.
 */
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { botsStore } from '../../state/bots'
import { layoutStore } from '../../state/layout'
import { settingsStore } from '../../state/settings'
import { aBot, resetShellStores, seedRoster } from '../../test-support/shell-stores'
import { botNames, useBotNames } from './bot-names'

describe('botNames', () => {
  it('shows a named bot by its name alone while its handle is hidden, whatever the order', () => {
    const bot = { name: 'lance-vance', displayName: 'Netwerkbeheerder' }

    expect(botNames(bot, 'display', true)).toEqual({ primary: 'Netwerkbeheerder', secondary: '' })
    expect(botNames(bot, 'profile', true)).toEqual({ primary: 'Netwerkbeheerder', secondary: '' })
  })

  it('shows both, in the reader’s order, once the handle is not hidden', () => {
    const bot = { name: 'lance-vance', displayName: 'Netwerkbeheerder' }

    expect(botNames(bot, 'display', false)).toEqual({ primary: 'Netwerkbeheerder', secondary: 'lance-vance' })
    expect(botNames(bot, 'profile', false)).toEqual({ primary: 'lance-vance', secondary: 'Netwerkbeheerder' })
  })

  it('has one name for a bot with no name of its own, in every combination', () => {
    for (const order of ['display', 'profile'] as const) {
      for (const hide of [true, false]) {
        expect(botNames({ name: 'scout' }, order, hide)).toEqual({ primary: 'scout', secondary: '' })
        expect(botNames({ name: 'scout', displayName: '' }, order, hide)).toEqual({ primary: 'scout', secondary: '' })
        expect(botNames({ name: 'scout', displayName: '  ' }, order, hide)).toEqual({ primary: 'scout', secondary: '' })
      }
    }
  })

  it('has one name for a bot whose name is its handle in another case, written as the name is written', () => {
    for (const order of ['display', 'profile'] as const) {
      for (const hide of [true, false]) {
        expect(botNames({ name: 'researcher', displayName: 'Researcher' }, order, hide)).toEqual({
          primary: 'Researcher',
          secondary: ''
        })
      }
    }
  })

  it('prefers what the reader calls the bot over what it calls itself, and falls back when that is cleared', () => {
    const bot = { name: 'lance-vance', displayName: 'Netwerkbeheerder', label: 'Lance' }

    expect(botNames(bot, 'display', false)).toEqual({ primary: 'Lance', secondary: 'lance-vance' })
    expect(botNames({ ...bot, label: '' }, 'display', false)).toEqual({
      primary: 'Netwerkbeheerder',
      secondary: 'lance-vance'
    })
    expect(botNames({ ...bot, label: '  ' }, 'display', true).primary).toBe('Netwerkbeheerder')
  })

  it('cleans what a bot wrote before it is drawn: no direction override, no zero-width character', () => {
    const names = botNames({ name: 'evil', displayName: '‮Evil⁠ name' }, 'display', false)

    expect(names).toEqual({ primary: 'Evil name', secondary: 'evil' })
  })
})

describe('useBotNames', () => {
  beforeEach(() => {
    resetShellStores()
    seedRoster([aBot('writer', { displayName: 'Scribe' }), aBot('researcher')])
  })

  afterEach(() => {
    cleanup()
    settingsStore.getState().reset()
  })

  it('reads the roster, the reader’s name for the bot and the two settings, and follows each', () => {
    const { result } = renderHook(() => useBotNames('writer'))

    // The defaults: the name alone.
    expect(result.current).toEqual({ primary: 'Scribe', secondary: '' })

    act(() => settingsStore.getState().setHideHandleWhenNamed(false))
    expect(result.current).toEqual({ primary: 'Scribe', secondary: 'writer' })

    act(() => settingsStore.getState().setBotNameOrder('profile'))
    expect(result.current).toEqual({ primary: 'writer', secondary: 'Scribe' })

    act(() => layoutStore.getState().setLabel('writer', 'W'))
    expect(result.current).toEqual({ primary: 'writer', secondary: 'W' })

    act(() => botsStore.getState().setBots([aBot('writer', { displayName: 'Scribe II' })]))
    expect(result.current.secondary).toBe('W')
  })

  it('takes the display name it is handed over the roster’s, so a row draws the one it holds', () => {
    const { result } = renderHook(() => useBotNames('writer', 'Held'))

    expect(result.current.primary).toBe('Held')
  })

  it('names nobody for no bot', () => {
    expect(renderHook(() => useBotNames(undefined)).result.current).toEqual({ primary: '', secondary: '' })
  })

  it('is one name for a bot with only one, however it is set', () => {
    const { result } = renderHook(() => useBotNames('researcher'))

    act(() => settingsStore.getState().setHideHandleWhenNamed(false))
    expect(result.current).toEqual({ primary: 'Researcher', secondary: '' })
  })
})
