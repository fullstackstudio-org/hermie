/**
 * One shortcut table, and the two Swift files that have to agree with it.
 *
 * There used to be three tables for one set of chords: a `switch` in
 * `HermieMacModule.swift`, a second `switch` in `desktop-shortcuts.web.ts`, and
 * a hand-written list of menu items in `HermieMenuBar.swift`. Three places to
 * change for one shortcut, and the one that drifts is whichever the author did
 * not have open.
 *
 * Two of the three are now DERIVED from `SHORTCUTS`: the browser's matcher walks
 * it and the menu bar's items come from the entries that carry a `menu`. The
 * Swift key table cannot be — GameController hands over a `GCKeyCode` and
 * nothing bridges that to a string on this side — so it stays a transcription,
 * and this file is what stops it drifting in silence. It reads the Swift
 * source, which is a blunt instrument and exactly proportionate: the failure it
 * guards against is a shortcut that works on the web and does nothing on the
 * Mac, which no other test in this repository would notice.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  MENU_CHORDS,
  SHORTCUTS,
  type ShortcutAction,
  type ShortcutChord
} from '../src/platform/desktop-shortcuts.shared'
import { shortcutForKey } from '../src/platform/desktop-shortcuts.web'

const ios = join(__dirname, '..', 'modules', 'hermie-mac', 'ios')
const macModule = readFileSync(join(ios, 'HermieMacModule.swift'), 'utf8')
const menuBar = readFileSync(join(ios, 'HermieMenuBar.swift'), 'utf8')

/** Every `return "action"` inside the Swift chord table. */
function swiftActions(): Set<string> {
  const table = macModule.slice(macModule.indexOf('private func shortcut(for keyCode:'))

  return new Set([...table.matchAll(/return "([a-zA-Z0-9]+)"/gu)].map(match => match[1] as string))
}

/** Every action id the menu bar binds a key equivalent to. */
function menuBarActions(): Set<string> {
  return new Set([...menuBar.matchAll(/id: "([a-zA-Z0-9]+)"/gu)].map(match => match[1] as string))
}

const press = (over: Partial<Parameters<typeof shortcutForKey>[0]>) =>
  shortcutForKey({ key: '', code: '', metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...over })

describe('the table itself', () => {
  it('has no two rows that would match the same keystroke', () => {
    const seen = new Set<string>()

    for (const chord of SHORTCUTS) {
      for (const key of chord.code ? [chord.code] : chord.keys) {
        const signature = `${chord.modifier}|${chord.shift === true}|${key.toLowerCase()}`

        expect(seen.has(signature)).toBe(false)
        seen.add(signature)
      }
    }
  })

  it('never puts a text-inserting key on the table without a modifier', () => {
    // The whole reason the allow-list exists: the native handler sits below the
    // responder chain and sees a password typed into a field. A bare letter with
    // a path to JavaScript through here would be that leak.
    const bare = SHORTCUTS.filter(chord => chord.modifier === 'none')

    for (const chord of bare) {
      expect(['ArrowUp', 'ArrowDown', 'Tab']).toContain(chord.keys[0])
    }
  })

  it('carries ⌘N, which runs the app’s own /new', () => {
    expect(press({ key: 'n', metaKey: true })).toBe('newConversation')
    // Not without Command, and not with Shift — the two ways a key table leaks.
    expect(press({ key: 'n' })).toBeNull()
    expect(press({ key: 'N', metaKey: true, shiftKey: true })).toBeNull()
  })
})

describe('the browser matcher against the table', () => {
  /** The keystroke `chord` describes, as a browser would report it. */
  function keystrokeFor(chord: ShortcutChord) {
    const command = chord.modifier === 'command' || chord.modifier === 'commandOrControl'

    return {
      altKey: false,
      code: chord.code ?? '',
      ctrlKey: chord.modifier === 'control',
      key: chord.keys[0] ?? '',
      metaKey: command,
      shiftKey: chord.shift === true
    }
  }

  it('resolves every row in the table', () => {
    for (const chord of SHORTCUTS) {
      expect(shortcutForKey(keystrokeFor(chord))).toBe(chord.action)
    }
  })

  it('refuses every row when Option is held', () => {
    for (const chord of SHORTCUTS) {
      expect(shortcutForKey({ ...keystrokeFor(chord), altKey: true })).toBeNull()
    }
  })
})

describe('the Swift transcription', () => {
  it('emits exactly the actions the table defines', () => {
    const swift = swiftActions()
    const table = new Set<ShortcutAction>(SHORTCUTS.map(chord => chord.action))

    // Both directions. An action in the table and not in Swift is a shortcut
    // that works on the web and does nothing on the Mac; one in Swift and not in
    // the table is an event JavaScript throws away, which looks identical from a
    // keyboard.
    expect([...swift].sort()).toEqual([...table].sort())
  })

  it('binds the menu bar to the rows that ask for a menu item', () => {
    const inMenuBar = menuBarActions()
    const wanted = new Set(MENU_CHORDS.map(chord => chord.action))

    for (const action of wanted) {
      expect(inMenuBar.has(action)).toBe(true)
    }
  })

  it('gives each menu item the key equivalent the table says', () => {
    for (const chord of MENU_CHORDS) {
      const key = chord.keys[0]?.toLowerCase()
      // The Swift builds `command(title:…, key: "n", id: "newConversation")`;
      // the pair has to be the one the table names, or the menu prints a chord
      // the keyboard does not answer to.
      const bound = new RegExp(`key: "${key}", id: "${chord.action}"`, 'u')

      expect(bound.test(menuBar)).toBe(true)
    }
  })
})
