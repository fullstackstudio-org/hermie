/**
 * The three browser defaults the app has to argue with, and the keyboard
 * question a browser can answer but a phone cannot.
 *
 * Every one of these is a *web* behaviour, so they are driven against the
 * `.web.ts` modules directly rather than through a renderer: the shared file a
 * component imports resolves to the native no-ops in Jest, and a test that
 * exercised those would prove the opposite of what it claims.
 *
 * `../src/platform/keyboard-modifiers.web` is imported for the one decision it
 * actually makes — whether a bare Return sends — which `chat-ui/send-key.ts`
 * then turns into an answer. The table itself is pinned in
 * `chat-ui/composer.test.tsx`; what is new here is which row of it the web
 * lands on.
 */
import { shouldSend } from '../src/chat-ui/send-key'
import { hasHardwareKeyboard, isShiftDown, subscribeToEscape } from '../src/platform/keyboard-modifiers.web'
import {
  growToContent,
  HAS_USER_AGENT_FOCUS_RING,
  INVALID_FIELD,
  NO_USER_AGENT_FOCUS_RING,
  ONE_ROW
} from '../src/platform/text-field-web.web'

describe('what a browser does that a phone does not', () => {
  it('asks the textarea for one row, because the browser default is two', () => {
    // The whole of the "composer is too tall on the web" report: a `<textarea>`
    // with no `rows` is two lines high whatever is in it.
    expect(ONE_ROW).toEqual({ rows: 1 })
  })

  it('suppresses the user agent focus ring by removing the STYLE, not the width', () => {
    // A user agent's ring is `outline-style: auto`, and with `auto` the browser
    // picks the width itself and ignores `outline-width`. `outlineWidth: 0`
    // would type-check and do nothing.
    expect(HAS_USER_AGENT_FOCUS_RING).toBe(true)
    expect(NO_USER_AGENT_FOCUS_RING).toEqual({ outlineStyle: 'none' })
  })

  it('says a rejected field is invalid, rather than only colouring it', () => {
    // The hairline turning red is the whole of the old message, and it is not a
    // message at all for a reader who cannot see the colour.
    expect(INVALID_FIELD).toEqual({ 'aria-invalid': true })
  })

  describe('growing a textarea to its content', () => {
    const field = (scrollHeight: number) => {
      const heights: string[] = []

      return {
        node: {
          scrollHeight,
          style: {
            set height(value: string) {
              heights.push(value)
            },
            get height() {
              return heights[heights.length - 1] ?? ''
            }
          }
        },
        heights
      }
    }

    it('zeroes the height first, so scrollHeight reports the CONTENT', () => {
      // A box already tall enough for its text reports its own height, not the
      // text's — which is what makes this shrink as well as grow.
      const { node, heights } = field(70)

      growToContent(node, 132)

      expect(heights).toEqual(['0px', '70px'])
    })

    it('stops at the cap rather than growing without limit', () => {
      const { node, heights } = field(400)

      growToContent(node, 132)

      expect(heights[1]).toBe('132px')
    })

    it('does nothing to a node that is not one', () => {
      expect(() => growToContent(null, 132)).not.toThrow()
      expect(() => growToContent({}, 132)).not.toThrow()
    })
  })
})

describe('what a bare Return does in a browser', () => {
  const withPointer = (value: string) => {
    const matchMedia = (query: string) => ({ matches: query === value }) as MediaQueryList

    Object.defineProperty(window, 'matchMedia', { configurable: true, value: matchMedia, writable: true })
  }

  it('sends on a machine with a fine pointer, which is a machine with keys', () => {
    withPointer('(pointer: fine)')

    expect(hasHardwareKeyboard()).toBe(true)
    expect(shouldSend('Enter', { hardwareKeyboard: hasHardwareKeyboard() })).toBe('send')
  })

  it('breaks the line on a touch device, exactly as the phone build does', () => {
    // Taking Return away on a software keyboard leaves a reader with no way to
    // write a second line at all.
    withPointer('(pointer: coarse)')

    expect(hasHardwareKeyboard()).toBe(false)
    expect(shouldSend('Enter', { hardwareKeyboard: hasHardwareKeyboard() })).toBe('newline')
  })

  it('leaves Shift+Return a newline on every pointer', () => {
    withPointer('(pointer: fine)')

    expect(shouldSend('Enter', { hardwareKeyboard: hasHardwareKeyboard(), shift: true })).toBe('newline')
  })

  it('never claims Shift is down: the key event carries that itself here', () => {
    expect(isShiftDown()).toBe(false)
  })

  it('answers the softer way when matchMedia throws', () => {
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: () => {
        throw new Error('no matchMedia')
      },
      writable: true
    })

    expect(hasHardwareKeyboard()).toBe(false)
  })
})

describe('Escape, in a browser', () => {
  /*
    React Native's Jest environment provides a `window` with no event target on
    it, so the listener is captured rather than dispatched to. What is being
    pinned is the registration — window, capture phase, and a teardown that
    removes the same listener — which is the part that is a decision; the
    browser's own dispatch is not ours to re-test.
  */
  it('listens on the window in the capture phase, and unsubscribes', () => {
    const added: [string, (event: KeyboardEvent) => void, boolean][] = []
    const removed: unknown[] = []

    Object.assign(window, {
      addEventListener: (type: string, listener: (event: KeyboardEvent) => void, capture: boolean) =>
        added.push([type, listener, capture]),
      removeEventListener: (_type: string, listener: unknown) => removed.push(listener)
    })

    const seen: string[] = []
    const stop = subscribeToEscape(() => seen.push('escape'))

    expect(added).toHaveLength(1)
    expect(added[0]?.[0]).toBe('keydown')
    // Capture, so a sheet's own handler is not what decides.
    expect(added[0]?.[2]).toBe(true)

    const listener = added[0]![1]

    listener({ key: 'a' } as KeyboardEvent)

    expect(seen).toEqual([])

    listener({ key: 'Escape' } as KeyboardEvent)

    expect(seen).toEqual(['escape'])

    stop()

    // The SAME listener is removed; a fresh closure would leak one per mount.
    expect(removed).toEqual([listener])
  })
})
