/**
 * The manifest that makes the tab installable, and the one icon it was missing.
 *
 * An installed PWA is drawn by the launcher, and the launcher crops. Where a
 * manifest offers no `maskable` icon Android takes the `any` one and puts it on
 * a white circle of its own — a Hermie icon inside somebody else's badge. A
 * maskable image has to reach every edge with its backdrop while keeping the
 * mark inside a circle of 80% of the canvas, which is two mappings of one
 * drawing and is why `scripts/lib/svg-raster.mjs` learned a per-shape
 * transform.
 *
 * Read off disk rather than asserted in prose: the file ships as it is written,
 * and the generator that produces the icons is checked separately by
 * `npm run icons:check`.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'

const PUBLIC = path.join(__dirname, '..', 'public')

const manifest = JSON.parse(readFileSync(path.join(PUBLIC, 'manifest.webmanifest'), 'utf8')) as {
  icons: { src: string; sizes: string; type: string; purpose: string }[]
  start_url: string
  scope: string
  display: string
}

describe('the web app manifest', () => {
  it('offers a maskable icon as well as a plain one', () => {
    const purposes = manifest.icons.map(icon => icon.purpose)

    expect(purposes).toContain('any')
    expect(purposes).toContain('maskable')
  })

  it('names files that are actually there', () => {
    for (const icon of manifest.icons) {
      expect(icon.src.startsWith('/')).toBe(true)
      // `public/` is copied to the root of the export verbatim, so the
      // manifest's URLs are its paths.
      expect(() => readFileSync(path.join(PUBLIC, icon.src.replace(/^\//, '')))).not.toThrow()
    }
  })

  it('is scoped to the whole app, which is what a deep link needs', () => {
    expect(manifest.scope).toBe('/')
    expect(manifest.start_url).toBe('/')
    expect(manifest.display).toBe('standalone')
  })
})
