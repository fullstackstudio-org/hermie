/**
 * The app draws the same thing whether its window is in front or behind.
 *
 * ## What this replaces
 *
 * R11a answered a report from the Mac — click another app and Hermie's chrome
 * visibly changes — with a swap: a scene-activation observer in Swift, a seam,
 * a flag on the theme, and a `GlassSurface` that stopped putting a
 * `UIVisualEffectView` on screen while the window was not key, painting its
 * solid rung instead. The reasoning was sound as far as it went (macOS dims a
 * visual effect view in a non-key window, and UIKit offers nothing to opt out),
 * but the cure was the disease: the app changed its own drawing at the moment
 * the reader looked away.
 *
 * The owner rejected it in one sentence — _"I do not want the styling to change
 * when the window is inactive. Same for iOS, Android etc."_ — and that sentence
 * is what this file now holds: nothing in the app may read whether its window is
 * active in order to decide how to draw.
 *
 * ## Why it is a source test
 *
 * There is no window state left to simulate. The seam is gone, the theme has no
 * flag, and a render test could only assert that a surface blurs — which it does
 * for its own reasons and would keep doing if somebody reintroduced the swap
 * behind a different name. What can be asserted is that the app's own sources do
 * not ask the question, which is the invariant the owner's sentence describes.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'

const SOURCE = path.join(__dirname, '..', 'src')

/** Every `.ts`/`.tsx` file under `src`, with its text. */
function sources(directory: string): { file: string; text: string }[] {
  const out: { file: string; text: string }[] = []

  for (const entry of readdirSync(directory)) {
    const full = path.join(directory, entry)

    if (statSync(full).isDirectory()) {
      out.push(...sources(full))
      continue
    }

    if (entry.endsWith('.ts') || entry.endsWith('.tsx')) {
      out.push({ file: path.relative(SOURCE, full), text: readFileSync(full, 'utf8') })
    }
  }

  return out
}

/**
 * The spellings the removed behaviour used, and the ones a reintroduction would
 * reach for. `AppState` is deliberately NOT here: two features watch it for
 * going to the background, which is a different question with a different answer
 * — see `features/lock/store.ts`.
 */
const WINDOW_STATE = [/windowActive/, /isWindowActive/, /onWindowActive/, /keyWindow/, /window-activity/]

describe('the inactive window', () => {
  const files = sources(SOURCE)

  it('is not a question the app asks anywhere', () => {
    const asking = files
      .filter(entry => WINDOW_STATE.some(pattern => pattern.test(entry.text)))
      .map(entry => entry.file)

    // Named rather than counted: a failure here should say which file started
    // deciding how to draw from whether the reader is looking at the window.
    expect(asking).toEqual([])
  })

  /**
   * The seam itself is gone, both halves.
   *
   * A file nothing imports is not harmless here: it is the first half of the
   * behaviour, and the next round that wants "does the window have focus" would
   * find it ready to use.
   */
  it('has no seam left to read it from', () => {
    expect(files.map(entry => entry.file)).not.toContain(path.join('platform', 'window-activity.ts'))
    expect(files.map(entry => entry.file)).not.toContain(path.join('platform', 'window-activity.web.ts'))
  })

  /**
   * And the accessibility flags still reach the theme.
   *
   * The flag that was removed sat between these two, so this is the assertion
   * that says what was taken out was one field rather than the row of them.
   */
  it('keeps the two preferences that DO change how the app draws', () => {
    const theme = readFileSync(path.join(SOURCE, 'ui', 'theme.tsx'), 'utf8')

    expect(theme).toContain('reduceTransparency')
    expect(theme).toContain('reduceMotion')
  })
})
