/**
 * The shortcut table and its matcher: every chord is the action it says on a Mac and elsewhere, modifiers are exact
 * (Shift+Cmd+K is not Cmd+K), a digit is read by its place and a letter by what it types, Option+letter on a Mac by its
 * place too, and a key that is no shortcut is none.
 */
import { describe, expect, it, vi } from 'vitest'

import { isApplePlatform, isTextTarget, type KeyEventLike, matchShortcut, SHORTCUTS } from './shortcuts'

const key = (init: Partial<KeyEventLike> & { key: string }): KeyEventLike => ({
  code: '',
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...init
})

const actionOf = (event: KeyEventLike, apple: boolean): string | undefined => matchShortcut(event, apple)?.action

describe('search', () => {
  it('is Command+K on a Mac and Control+K elsewhere, in either case of the letter', () => {
    expect(actionOf(key({ key: 'k', metaKey: true }), true)).toBe('search')
    expect(actionOf(key({ key: 'K', metaKey: true }), true)).toBe('search')
    expect(actionOf(key({ key: 'k', ctrlKey: true }), false)).toBe('search')
  })

  it('is not the other platform’s modifier, nor with another modifier beside it', () => {
    expect(actionOf(key({ key: 'k', ctrlKey: true }), true)).toBeUndefined()
    expect(actionOf(key({ key: 'k', metaKey: true }), false)).toBeUndefined()
    expect(actionOf(key({ key: 'k', metaKey: true, shiftKey: true }), true)).toBeUndefined()
    expect(actionOf(key({ key: 'k', metaKey: true, altKey: true }), true)).toBeUndefined()
    expect(actionOf(key({ key: 'k', metaKey: true, ctrlKey: true }), true)).toBeUndefined()
    expect(actionOf(key({ key: 'k' }), true)).toBeUndefined()
  })
})

describe('a new conversation', () => {
  it('is Command or Control+N, and Command or Control+Option or Alt+N, which no browser keeps', () => {
    expect(actionOf(key({ key: 'n', metaKey: true }), true)).toBe('newConversation')
    expect(actionOf(key({ key: 'n', ctrlKey: true }), false)).toBe('newConversation')
    expect(actionOf(key({ key: 'n', ctrlKey: true, altKey: true }), false)).toBe('newConversation')
  })

  it('is read by the key’s place for Command+Option+N on a Mac, where Option+N types a dead key', () => {
    expect(actionOf(key({ key: 'Dead', code: 'KeyN', metaKey: true, altKey: true }), true)).toBe('newConversation')
    expect(actionOf(key({ key: '˜', code: 'KeyN', metaKey: true, altKey: true }), true)).toBe('newConversation')
  })

  it('is not read by place where there is no dead key to explain it, nor without Alt', () => {
    // A Polish AltGr+N types ń on Windows, which reports Control and Alt: it is a letter, not this shortcut.
    expect(actionOf(key({ key: 'ń', code: 'KeyN', ctrlKey: true, altKey: true }), false)).toBeUndefined()
    expect(actionOf(key({ key: 'Dead', code: 'KeyN', metaKey: true }), true)).toBeUndefined()
  })
})

describe('the chats', () => {
  it('goes to the previous and the next with the arrows, with Command or Control and with Alt', () => {
    expect(actionOf(key({ key: 'ArrowUp', metaKey: true }), true)).toBe('previousChat')
    expect(actionOf(key({ key: 'ArrowDown', metaKey: true }), true)).toBe('nextChat')
    expect(actionOf(key({ key: 'ArrowUp', ctrlKey: true }), false)).toBe('previousChat')
    expect(actionOf(key({ key: 'ArrowDown', altKey: true }), false)).toBe('nextChat')
    expect(actionOf(key({ key: 'ArrowUp', altKey: true }), true)).toBe('previousChat')
  })

  it('goes on with Control+Tab and back with Control+Shift+Tab, on every platform', () => {
    for (const apple of [true, false]) {
      expect(actionOf(key({ key: 'Tab', ctrlKey: true }), apple)).toBe('nextChat')
      expect(actionOf(key({ key: 'Tab', ctrlKey: true, shiftKey: true }), apple)).toBe('previousChat')
    }

    expect(actionOf(key({ key: 'Tab' }), false)).toBeUndefined()
    expect(actionOf(key({ key: 'Tab', metaKey: true }), true)).toBeUndefined()
  })

  it('leaves the plain arrows to the page, and Shift or both modifiers with them', () => {
    expect(actionOf(key({ key: 'ArrowUp' }), true)).toBeUndefined()
    expect(actionOf(key({ key: 'ArrowDown', shiftKey: true, metaKey: true }), true)).toBeUndefined()
    expect(actionOf(key({ key: 'ArrowDown', metaKey: true, altKey: true }), true)).toBeUndefined()
  })

  it('reads the digits one to nine by their place, so a keyboard that types punctuation there has them too', () => {
    for (let digit = 1; digit <= 9; digit += 1) {
      expect(matchShortcut(key({ key: String(digit), code: `Digit${digit}`, metaKey: true }), true)).toMatchObject({
        action: 'chat',
        index: digit
      })
    }

    // An AZERTY keyboard types `&` where the 1 is.
    expect(matchShortcut(key({ key: '&', code: 'Digit1', ctrlKey: true }), false)).toMatchObject({
      action: 'chat',
      index: 1
    })
    expect(matchShortcut(key({ key: '3', code: 'Numpad3', ctrlKey: true }), false)).toMatchObject({ index: 3 })
  })

  it('has no chat zero and no tenth, and no chat without the modifier', () => {
    expect(actionOf(key({ key: '0', code: 'Digit0', metaKey: true }), true)).toBeUndefined()
    expect(actionOf(key({ key: '1', code: 'Digit1' }), true)).toBeUndefined()
    expect(actionOf(key({ key: '1', code: 'Digit1', metaKey: true, shiftKey: true }), true)).toBeUndefined()
  })
})

describe('the list of shortcuts', () => {
  it('is the question mark with whatever Shift the layout needs, and Command or Control+/', () => {
    expect(actionOf(key({ key: '?', shiftKey: true }), true)).toBe('help')
    expect(actionOf(key({ key: '?' }), false)).toBe('help')
    expect(actionOf(key({ key: '/', metaKey: true }), true)).toBe('help')
    expect(actionOf(key({ key: '/', ctrlKey: true }), false)).toBe('help')
    expect(actionOf(key({ key: '/' }), false)).toBeUndefined()
    expect(actionOf(key({ key: '?', ctrlKey: true }), false)).toBeUndefined()
  })
})

describe('the table', () => {
  it('has every action once, each with a chord, and no two actions on one chord', () => {
    const actions = SHORTCUTS.map(shortcut => shortcut.action)

    expect(new Set(actions).size).toBe(actions.length)
    expect(actions).toEqual(['search', 'newConversation', 'previousChat', 'nextChat', 'chat', 'help'])
    expect(SHORTCUTS.every(shortcut => shortcut.chords.length > 0)).toBe(true)
  })

  it('leaves the arrows and the question mark to a text field, and nothing else', () => {
    const left = SHORTCUTS.flatMap(shortcut =>
      shortcut.chords.filter(chord => chord.outsideFields).map(chord => chord.key)
    )

    expect(new Set(left)).toEqual(new Set(['ArrowUp', 'ArrowDown', '?']))
  })

  it('gives every action that a browser may keep a chord it leaves alone', () => {
    // A new conversation and the two walks are what a browser reserves; each has one beside it with Alt.
    for (const action of ['newConversation', 'previousChat', 'nextChat']) {
      const chords = SHORTCUTS.find(shortcut => shortcut.action === action)?.chords ?? []

      expect(chords.some(chord => chord.alt === true)).toBe(true)
    }
  })
})

describe('where a key is typed', () => {
  const element = (tag: string, type?: string): Element => {
    const created = document.createElement(tag)

    if (type !== undefined) {
      created.setAttribute('type', type)
    }

    return created
  }

  it('is a text target in a field, a text area, a select and a place edited in place', () => {
    expect(isTextTarget(element('input', 'text'))).toBe(true)
    expect(isTextTarget(element('input', 'search'))).toBe(true)
    expect(isTextTarget(element('input'))).toBe(true)
    expect(isTextTarget(element('textarea'))).toBe(true)
    expect(isTextTarget(element('select'))).toBe(true)
  })

  it('is not one on a button, a link, a box that is ticked or a radio, which take no text', () => {
    expect(isTextTarget(element('button'))).toBe(false)
    expect(isTextTarget(element('a'))).toBe(false)
    expect(isTextTarget(element('input', 'checkbox'))).toBe(false)
    expect(isTextTarget(element('input', 'radio'))).toBe(false)
    expect(isTextTarget(element('input', 'range'))).toBe(false)
    expect(isTextTarget(element('div'))).toBe(false)
    expect(isTextTarget(null)).toBe(false)
    expect(isTextTarget(document)).toBe(false)
  })
})

describe('the platform', () => {
  const asking = (navigator: unknown, then: () => void): void => {
    vi.stubGlobal('navigator', navigator)

    try {
      then()
    } finally {
      vi.unstubAllGlobals()
    }
  }

  it('is a Mac by the client hints’ own word, which is macOS, and by the older platform string', () => {
    asking({ userAgentData: { platform: 'macOS' }, platform: '' }, () => expect(isApplePlatform()).toBe(true))
    asking({ platform: 'MacIntel' }, () => expect(isApplePlatform()).toBe(true))
    asking({ platform: 'iPhone' }, () => expect(isApplePlatform()).toBe(true))
    asking({ platform: 'iPad' }, () => expect(isApplePlatform()).toBe(true))
  })

  it('is not one on Windows, Linux or Android', () => {
    asking({ platform: 'Win32' }, () => expect(isApplePlatform()).toBe(false))
    asking({ platform: 'Linux x86_64' }, () => expect(isApplePlatform()).toBe(false))
    asking({ userAgentData: { platform: 'Windows' }, platform: 'Win32' }, () => expect(isApplePlatform()).toBe(false))
    asking({ userAgentData: { platform: 'Android' }, platform: 'Linux armv81' }, () =>
      expect(isApplePlatform()).toBe(false)
    )
  })

  it('does not believe a user-agent switcher over the keyboard’s own machine', () => {
    // A Mac with a Windows user agent still has a Command key and no Windows key.
    asking({ userAgentData: { platform: 'Windows' }, platform: 'MacIntel' }, () => expect(isApplePlatform()).toBe(true))
    asking({ userAgentData: { platform: 'iOS' }, platform: '' }, () => expect(isApplePlatform()).toBe(true))
  })

  it('is not one without a navigator at all', () => {
    asking(undefined, () => expect(isApplePlatform()).toBe(false))
  })
})
