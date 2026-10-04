/**
 * The browser client's licence list (`native/web/public/licenses.json`, shown in Settings, About):
 * generated from the client's production dependency tree by
 * `scripts/generate-third-party-licenses.mjs --web`, so it cannot drift from the lockfile
 * unnoticed, and written so the bundle gate takes it (no byte above U+007F).
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const file = join(root, 'native', 'web', 'public', 'licenses.json')

describe('native/web/public/licenses.json', () => {
  it('matches the dependency tree (the generator, in check mode, finds nothing stale)', () => {
    expect(() =>
      execFileSync(process.execPath, ['scripts/generate-third-party-licenses.mjs', '--web', '--check'], {
        cwd: root,
        stdio: 'pipe'
      })
    ).not.toThrow()
  })

  it('is plain ASCII, as the bundle gate requires of a JSON file', () => {
    const bytes = readFileSync(file)

    expect([...bytes].filter(byte => byte > 0x7f)).toEqual([])
  })

  it('lists the client’s own runtime dependencies, each with a licence text, and none of the repository’s own packages', () => {
    const data = JSON.parse(readFileSync(file, 'utf8')) as {
      packages: { name: string; licence: string; text?: string }[]
      texts: Record<string, string>
    }
    const names = data.packages.map(entry => entry.name)

    expect(names).toEqual(expect.arrayContaining(['react', 'react-dom', 'zustand', 'marked', 'highlight.js']))
    expect(names.filter(name => name.startsWith('@hermie/') || name.startsWith('@hermes/'))).toEqual([])

    for (const entry of data.packages) {
      expect(entry.licence, entry.name).not.toBe('')
      expect(entry.text && data.texts[entry.text], entry.name).toBeTruthy()
    }
  })
})
