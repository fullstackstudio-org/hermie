/**
 * One press of ⌘W, reported twice.
 *
 * On a Mac both halves of the shortcut seam are live at once and ⌘W is in both:
 * the menu bar's `UIKeyCommand` and GameController's `keyChangedHandler` each
 * report it. `closeTopmost()` ran twice and closed two levels — a sheet AND the
 * panel under it — from one keystroke.
 *
 * The fix is in the dispatcher rather than in either path, and the reason is the
 * whole point of the decision: suppressing the keyboard path for anything the
 * menu also provides is the obvious move and is wrong, because the menu path is
 * a responder-chain path and a presented `Modal` is not in the responder chain.
 * ⌘W's job is closing that modal. Both paths stay, and exactly one report of a
 * press survives.
 */
import { DOUBLE_FIRE_MS, isDoubleFire } from '../src/platform/desktop-shortcuts'

describe('two reports of one chord', () => {
  const press = (at: number) => ({ action: 'close' as const, at })

  it('lets the first report of a chord through', () => {
    expect(isDoubleFire(null, press(1_000))).toBe(false)
  })

  it('drops the second report of the same chord inside the window', () => {
    expect(isDoubleFire(press(1_000), press(1_000))).toBe(true)
    expect(isDoubleFire(press(1_000), press(1_000 + DOUBLE_FIRE_MS - 1))).toBe(true)
  })

  it('lets a genuine second press through once the window has passed', () => {
    // The two reports of one press are the same run loop turn apart; a person
    // pressing the same chord twice is an order of magnitude slower than this.
    expect(isDoubleFire(press(1_000), press(1_000 + DOUBLE_FIRE_MS))).toBe(false)
    expect(isDoubleFire(press(1_000), press(1_400))).toBe(false)
  })

  it('never collapses two DIFFERENT chords, however close together', () => {
    // ⌘W then ⌘K in the same frame is two intentions, and the seam offers no
    // reason to think either of them is a duplicate of the other.
    expect(isDoubleFire({ action: 'close', at: 1_000 }, { action: 'search', at: 1_001 })).toBe(false)
  })
})
