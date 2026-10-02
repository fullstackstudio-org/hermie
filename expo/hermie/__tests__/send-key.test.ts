/**
 * What a Return means, stated as a table.
 *
 * The composer asks this from two places — `onKeyPress`, where the platform may
 * report modifiers, and `onSubmitEditing`, where the modifier is polled from the
 * keyboard seam — and before they shared a function they each held their own
 * copy of the rule. The cases below are the contract both of them now obey.
 *
 * The stuck-Shift report from the Mac is NOT a bug in this table: it was the
 * seam answering `true` for a Shift that had been released while the window was
 * in the background. The native half of that fix is in `HermieMacModule.swift`;
 * what is testable from here is that a `shift` of `true` always means a newline
 * and a `shift` of `false` always sends.
 */
import { shouldSend } from '../src/chat-ui/send-key'

describe('what a key press means for the composer', () => {
  it('ignores every key but Return', () => {
    expect(shouldSend('a', { hardwareKeyboard: true })).toBe('ignore')
    expect(shouldSend('Backspace', { hardwareKeyboard: true })).toBe('ignore')
    expect(shouldSend('', {})).toBe('ignore')
  })

  it('sends a bare Return where a hardware keyboard is certain', () => {
    expect(shouldSend('Enter', { hardwareKeyboard: true })).toBe('send')
  })

  it('breaks the line on a bare Return where there is no hardware keyboard', () => {
    // The software keyboard's Return key. A phone has no other way to write a
    // second line.
    expect(shouldSend('Enter', { hardwareKeyboard: false })).toBe('newline')
    expect(shouldSend('Enter', {})).toBe('newline')
  })

  it('breaks the line on Shift+Return, keyboard or not', () => {
    expect(shouldSend('Enter', { hardwareKeyboard: true, shift: true })).toBe('newline')
    expect(shouldSend('Enter', { hardwareKeyboard: false, shift: true })).toBe('newline')
  })

  it('sends on Command or Control, even over Shift', () => {
    // Only a physical keyboard can produce one, so this is safe on a phone — and
    // ⌘⇧Return is still a send, because the chord a reader typed is the one that
    // names the intention.
    expect(shouldSend('Enter', { meta: true })).toBe('send')
    expect(shouldSend('Enter', { ctrl: true })).toBe('send')
    expect(shouldSend('Enter', { meta: true, shift: true })).toBe('send')
    expect(shouldSend('Enter', { ctrl: true, hardwareKeyboard: false })).toBe('send')
  })

  /**
   * An iPad in a keyboard case, which is the owner's second report: the same
   * build sent on a Mac and did nothing useful there.
   *
   * The table below was never the problem — `hardwareKeyboard: true` has always
   * sent. What was wrong is where that flag came from: the composer defaulted it
   * to `RUNS_ON_MAC`, which is a proxy for "is there a keyboard" that is false on
   * exactly the device the owner was holding. It now defaults to a Mac window OR
   * a keyboard the HID state can actually see, so these two cases are the iPad's.
   */
  describe('an iPad with a keyboard attached', () => {
    const IPAD = { hardwareKeyboard: true }

    it('sends on a bare Return, the same as a Mac window', () => {
      expect(shouldSend('Enter', IPAD)).toBe('send')
    })

    it('still breaks the line on Shift+Return', () => {
      expect(shouldSend('Enter', { ...IPAD, shift: true })).toBe('newline')
    })

    it('leaves the same iPad with NO keyboard on the software Return', () => {
      // Unplug it and the on-screen keyboard's Return must go back to being the
      // only way to write a second line.
      expect(shouldSend('Enter', { hardwareKeyboard: false })).toBe('newline')
    })
  })

  it('never answers anything but the three outcomes', () => {
    const answers = new Set(
      [true, false].flatMap(hardwareKeyboard =>
        [true, false].flatMap(shift =>
          [true, false].flatMap(meta =>
            [true, false].map(ctrl => shouldSend('Enter', { ctrl, hardwareKeyboard, meta, shift }))
          )
        )
      )
    )

    expect([...answers].sort()).toEqual(['newline', 'send'])
  })
})
