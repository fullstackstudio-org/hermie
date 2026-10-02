/**
 * No platform file may import a value from itself.
 *
 * A bundler that picks `x.web.ts` over `x.ts` for the `web` platform picks the
 * same way for a relative import written INSIDE `x.web.ts`: `./x` read from
 * there resolves to `x.web.ts`. So `export { thing } from './x'` written in the
 * web half does not reach the native half at all — it re-exports the name from
 * itself, and Metro compiles that to a getter whose body reads the same getter.
 * Nothing warns. TypeScript resolves `./x` to `x.ts` and typechecks it happily,
 * ESLint sees an ordinary re-export, and the native and test builds are
 * untouched because they never pick the `.web` file. Only the browser bundle
 * has the cycle, and it only shows up when the name is READ: the property
 * access recurses until the stack ends.
 *
 * It shipped twice. `probeFromWebConfig` ended the browser build's sign-in step
 * with "Maximum call stack size exceeded" on every visit — including the one
 * straight after "Forget gateway", which is where it was reported from — and
 * `normaliseDroppedFiles` would have done the same to the first file anybody
 * dropped on the window.
 *
 * Neither could be caught by running the code here: jest resolves for `ios`, so
 * `./x` lands on the native half and the cycle does not exist. The check is
 * therefore on the SOURCE, at the layer the defect lives at — one that holds for
 * every platform file in the app rather than for the two that have been found.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, extname, join, resolve } from 'node:path'

const SOURCE_ROOT = resolve(__dirname, '../src')

/** The suffixes a bundler resolves before the bare name. */
const PLATFORMS = ['web', 'ios', 'android', 'native'] as const

const PLATFORM_FILE = /\.(web|ios|android|native)\.tsx?$/u

function sourceFiles(directory: string): string[] {
  const found: string[] = []

  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry)

    if (statSync(path).isDirectory()) {
      found.push(...sourceFiles(path))
    } else if (extname(path) === '.ts' || extname(path) === '.tsx') {
      found.push(path)
    }
  }

  return found
}

/** Every `import`/`export … from '…'` in a file, with its specifier. */
const STATEMENTS = /^[^\S\n]*(?:import|export)\s+([^;\n]*?)\s*from\s*['"]([^'"]+)['"]/gmu

/**
 * Whether a statement survives compilation.
 *
 * `import type`, `export type` and a clause whose every named binding carries
 * its own `type` are erased, so they can name the twin without a cycle — and
 * they should, because that is how the types stay written down once.
 */
function isTypeOnly(clause: string): boolean {
  const trimmed = clause.trim()

  if (trimmed.startsWith('type ') || trimmed === 'type') {
    return true
  }

  const braces = /^\{([^}]*)\}$/u.exec(trimmed)

  if (!braces) {
    return false
  }

  const names = (braces[1] ?? '')
    .split(',')
    .map(name => name.trim())
    .filter(Boolean)

  return names.length > 0 && names.every(name => name.startsWith('type '))
}

describe('platform files', () => {
  const files = sourceFiles(SOURCE_ROOT).filter(path => PLATFORM_FILE.test(path))

  it('there are platform files to check', () => {
    // A scan that silently matched nothing would pass for ever.
    expect(files.length).toBeGreaterThan(5)
  })

  it.each(files.map(path => [path.slice(SOURCE_ROOT.length + 1), path]))(
    '%s imports no value from itself',
    (_label, path) => {
      const suffix = PLATFORM_FILE.exec(path)?.[1] ?? ''
      const own = basename(path).replace(PLATFORM_FILE, '')
      const source = readFileSync(path, 'utf8')
      const offenders: string[] = []

      for (const match of source.matchAll(STATEMENTS)) {
        const clause = match[1] ?? ''
        const specifier = match[2] ?? ''

        if (!specifier.startsWith('.') || isTypeOnly(clause)) {
          continue
        }

        // What the bundler tries first for this platform, and therefore what
        // this specifier actually names when read from this file.
        if (PLATFORMS.includes(suffix as (typeof PLATFORMS)[number]) && basename(specifier) === own) {
          offenders.push(`${match[0].trim()} — resolves to ${own}.${suffix}, which is this file`)
        }
      }

      expect(offenders).toEqual([])
    }
  )
})
