/**
 * `src/dev` is for a person with the dev server open. The production build
 * starts from `index.html` and takes what that imports, so the fixtures stay out
 * of `dist/` as long as nothing it reaches imports them. This is that rule, as a
 * test: no module outside `src/dev` and the tests names a `dev/` module.
 */
import { describe, expect, it } from 'vitest'

const sources = import.meta.glob<string>(['/src/**/*.{ts,tsx}', '!/src/**/*.test.{ts,tsx}', '!/src/dev/**'], {
  eager: true,
  query: '?raw',
  import: 'default'
})

describe('the development fixtures', () => {
  it('are not imported by anything the build can reach', () => {
    const files = Object.keys(sources)

    expect(files.length).toBeGreaterThan(20)

    const offenders = files.filter(file =>
      /from\s+['"][^'"]*\/dev\/|import\(\s*['"][^'"]*\/dev\//.test(sources[file] ?? '')
    )

    expect(offenders).toEqual([])
  })

  it('are not named by the production entry', () => {
    const entry = sources['/src/main.tsx'] ?? ''

    expect(entry).not.toBe('')
    expect(entry).not.toMatch(/markdown-fixtures|markdown-main|\/dev\//)
  })
})
