/**
 * The real generated bundle, unmocked.
 *
 * The other licence suites mock the data so they stay about the screen. This one
 * loads what `npm run licences` actually wrote, because nothing else does: the
 * loader reaches the file through a module reference the type checker never
 * resolves, so a wrong path or a missing file would otherwise surface for the
 * first time on a device.
 */
import { loadLicenceData } from '../src/features/settings/licences-data'

describe('the bundled licence data', () => {
  it('is present, and shaped the way the screen reads it', async () => {
    const data = await loadLicenceData()

    expect(data.generatedBy).toBe('scripts/generate-third-party-licenses.mjs')
    expect(data.packages.length).toBeGreaterThan(100)
    expect(data.excludesWorkspacePackages.length).toBeGreaterThan(0)

    for (const entry of data.packages) {
      expect(typeof entry.name).toBe('string')
      expect(entry.name.length).toBeGreaterThan(0)
      expect(entry.version).toMatch(/^\d+\./)

      // Every entry states something: an identifier, a licence text, or both.
      expect(Boolean(entry.licence) || Boolean(entry.text)).toBe(true)

      if (entry.text) {
        expect(typeof data.texts[entry.text]).toBe('string')
      }
    }
  })

  it('carries a package the app plainly depends on', async () => {
    const data = await loadLicenceData()
    const react = data.packages.find(entry => entry.name === 'react')

    expect(react).toBeDefined()
    expect(react?.licence).toBe('MIT')
    expect(data.texts[react?.text ?? '']).toMatch(/Permission is hereby granted/)
  })

  it('leaves the repository’s own workspace packages out of the list', async () => {
    const data = await loadLicenceData()

    expect(data.packages.some(entry => entry.name.startsWith('@hermie/'))).toBe(false)
    expect(data.excludesWorkspacePackages).toContain('@hermie/transcript')
  })
})
