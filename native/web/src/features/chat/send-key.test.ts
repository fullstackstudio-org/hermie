/**
 * What a Return means, stated as a table. The rows are the native apps'
 * (`expo/hermie/__tests__/send-key.test.ts`) plus the one a browser adds: a
 * Return that belongs to an input method.
 */
import { describe, expect, it } from 'vitest'

import { decideKey } from './send-key'

describe('what a key press means for the composer', () => {
  it('ignores every key but Return', () => {
    expect(decideKey({ key: 'a' })).toBe('ignore')
    expect(decideKey({ key: 'Backspace' })).toBe('ignore')
    expect(decideKey({ key: '' })).toBe('ignore')
    expect(decideKey({ key: 'Tab', shiftKey: true })).toBe('ignore')
  })

  it('sends a bare Return where a keyboard is likely', () => {
    expect(decideKey({ key: 'Enter' })).toBe('send')
    expect(decideKey({ key: 'Enter' }, true)).toBe('send')
  })

  it('breaks the line on a bare Return on a touch device, where the key on the screen is the only way to', () => {
    expect(decideKey({ key: 'Enter' }, false)).toBe('newline')
  })

  it('breaks the line on Shift+Return, keyboard or not', () => {
    expect(decideKey({ key: 'Enter', shiftKey: true }, true)).toBe('newline')
    expect(decideKey({ key: 'Enter', shiftKey: true }, false)).toBe('newline')
  })

  it('sends on Command or Control, even over Shift and even on a touch device', () => {
    expect(decideKey({ key: 'Enter', metaKey: true })).toBe('send')
    expect(decideKey({ key: 'Enter', ctrlKey: true })).toBe('send')
    expect(decideKey({ key: 'Enter', metaKey: true, shiftKey: true })).toBe('send')
    expect(decideKey({ key: 'Enter', ctrlKey: true }, false)).toBe('send')
  })

  describe('an input method', () => {
    it('never sends the Return that confirms a composition', () => {
      expect(decideKey({ key: 'Enter', isComposing: true })).toBe('ignore')
      expect(decideKey({ key: 'Enter', isComposing: true, metaKey: true })).toBe('ignore')
      expect(decideKey({ key: 'Enter', isComposing: true, shiftKey: true })).toBe('ignore')
    })

    it('reads the legacy key code some engines give the Return that ends a composition', () => {
      expect(decideKey({ key: 'Enter', keyCode: 229 })).toBe('ignore')
    })

    it('sends a Return that merely follows a finished composition', () => {
      expect(decideKey({ key: 'Enter', isComposing: false, keyCode: 13 })).toBe('send')
    })
  })

  it('never answers anything but the three outcomes', () => {
    const answers = new Set<string>()

    for (const key of ['Enter', 'a', 'Tab'])
      for (const shiftKey of [true, false])
        for (const metaKey of [true, false])
          for (const ctrlKey of [true, false])
            for (const isComposing of [true, false])
              for (const keyboardLikely of [true, false]) {
                answers.add(decideKey({ key, shiftKey, metaKey, ctrlKey, isComposing }, keyboardLikely))
              }

    expect([...answers].sort()).toEqual(['ignore', 'newline', 'send'])
  })
})
