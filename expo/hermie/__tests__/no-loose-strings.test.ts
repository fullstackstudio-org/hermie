/**
 * Every name a reader hears comes from a string table.
 *
 * Two did not. `ui/BottomSheet.tsx` called its backdrop `"Dismiss"` and
 * `chat-ui/TypingIndicator.tsx` called itself `"Replying"`, both as literals in
 * the component, both therefore invisible to anything that ever translates this
 * app and invisible to a reviewer reading the tables to see what the app says.
 *
 * A sweep rather than a render, for the same reason the accessibility-state one
 * is: the failure is a literal typed into a component nobody thought to render,
 * and a renderer test only ever covers the components somebody did.
 *
 * Deliberately narrow. It looks for the two props a screen reader SPEAKS, and
 * not for every string in the source: a `testID`, a style token and a
 * developer-only gallery caption are not copy, and a rule that flagged them
 * would be turned off within a week.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'

const SRC = path.join(__dirname, '..', 'src')

/** Props whose value is read out loud, so whose value is copy. */
const SPOKEN = /\b(accessibilityLabel|accessibilityHint)=["']/g

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap(entry => {
    const full = path.join(dir, entry)

    if (statSync(full).isDirectory()) {
      return sourceFiles(full)
    }

    return /\.tsx?$/.test(entry) ? [full] : []
  })
}

describe('the strings a screen reader says', () => {
  it('are never written into a component', () => {
    const offenders = sourceFiles(SRC).flatMap(file => {
      const source = readFileSync(file, 'utf8')
      const hits = source.match(SPOKEN) ?? []

      return hits.map(hit => `${path.relative(SRC, file)}: ${hit}`)
    })

    expect(offenders).toEqual([])
  })
})
