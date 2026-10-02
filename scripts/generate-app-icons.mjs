#!/usr/bin/env node
/**
 * Rasterises design/icon.svg into every icon the app ships.
 *
 *   node scripts/generate-app-icons.mjs
 *   node scripts/generate-app-icons.mjs --check    # fail if anything is stale
 *
 * The renderer itself lives in scripts/lib/svg-raster.mjs, which also draws the
 * Play listing's artwork (scripts/generate-store-assets.mjs); its header explains
 * why this repository carries a rasteriser instead of calling one, and which
 * subset of SVG it understands. design/icon.svg stays the source of truth: the
 * geometry below is only where each icon is placed on its canvas.
 */

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  boundsOf,
  createEmitter,
  encodeIcns,
  encodeIco,
  encodePng,
  readSvg,
  render,
  shapePolygons
} from './lib/svg-raster.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..')
const sourceSvg = resolve(repoRoot, 'design/icon.svg')
const assetsDir = resolve(repoRoot, 'expo/hermie/assets')
/**
 * The browser build's icons.
 *
 * `expo/hermie/public` is copied to the root of the web export verbatim, so
 * these land next to `manifest.webmanifest` — which is the only reason they are
 * not in `assets/` with the rest: nothing bundles them, the manifest names them
 * by URL.
 *
 * The `maskable` icon here is the reason `render` learned to take a transform
 * per SHAPE. A maskable image is cropped to whatever silhouette the launcher
 * likes, so the backdrop has to reach every edge while the mark stays inside a
 * circle of 80% of the canvas — two different mappings of one drawing. Without
 * it Android put the `any` icon on a white circle of its own, which is a Hermie
 * icon inside somebody else's badge.
 */
const webIconsDir = resolve(repoRoot, 'expo/hermie/public/icons')

/**
 * The desktop shell's icons (Tauri, `apps/desktop`).
 *
 * The flat PNGs (`32x32.png`, `128x128.png`, `128x128@2x.png`, `icon.png`)
 * keep the artwork's own rounded corners and alpha, like the web icons above
 * — nothing on Windows or Linux masks a top-level icon the way macOS does.
 * `icon.icns` is the one macOS actually shows in the Dock and Finder, so it
 * gets the opaque, square-cornered treatment `icon.png` above uses, for the
 * same reason: the OS applies its own mask and shadow, and a rounded corner
 * or a hole in the alpha channel underneath that mask is a visible seam.
 */
const desktopIconsDir = resolve(repoRoot, 'apps/desktop/src-tauri/icons')

/**
 * How much of the canvas the mark may fill in an Android adaptive foreground.
 *
 * The outer third of that image is cropped away by whichever mask the launcher
 * picks, which leaves a nominal safe zone of 682 — but that is a square, and a
 * circular mask cuts the corners off it. Measured against the circle rather
 * than the square: at 600 the bubble's top corners land 348 from the centre and
 * the tail tip 364, both outside the 338 the circle allows. 528 puts the
 * corners at 306, inside even the stricter 312 that Android's own guidance
 * uses, and leaves only the taper of the tail near the edge.
 */
const ADAPTIVE_SAFE_BOX = 528

/**
 * The same question for a maskable PWA icon, which draws its own backdrop.
 *
 * The guaranteed area is a circle of 80% of the canvas — radius 409.6 on 1024 —
 * and it is measured rather than assumed: fitted to a box of 1000 the furthest
 * point of the mark (the tail's tip, not a corner) sits 607.5 from the centre,
 * so the radius scales at 0.6075 of the box and 674 is the largest box that
 * fits. 664 is that with six points to spare, which is the difference between
 * a number that fits and a number that fits after somebody nudges the artwork.
 */
const MASKABLE_SAFE_BOX = 664

/** Artwork that fills its canvas edge to edge, at whatever size is asked for. */
function fullBleed(size, squareCorners) {
  return {
    width: size,
    height: size,
    transform: { scale: size / 1024, x: 0, y: 0 },
    squareCornersOf: squareCorners ? 'backdrop' : undefined
  }
}

/** The mark alone, scaled so its bounding box fits a centred box. */
function fitted(size, shapes, box) {
  const bounds = boundsOf(shapes.flatMap(shape => shapePolygons(shape, undefined)))
  const width = bounds.maxX - bounds.minX
  const height = bounds.maxY - bounds.minY
  const scale = ((size / 1024) * box) / Math.max(width, height)
  return {
    width: size,
    height: size,
    transform: {
      scale,
      x: size / 2 - (bounds.minX + width / 2) * scale,
      y: size / 2 - (bounds.minY + height / 2) * scale
    }
  }
}

/**
 * One image, two mappings: the backdrop edge to edge, the mark in the circle.
 *
 * `squareCornersOf: 'backdrop'` because the artwork's own rounded corners are
 * exactly what a maskable icon must not have — the launcher supplies the shape,
 * and a rounded corner inside its mask is a visible notch of nothing.
 */
function maskable(size, backdropShapes, markShapes) {
  const full = fullBleed(size, true)
  const inner = fitted(size, markShapes, MASKABLE_SAFE_BOX)

  return {
    shapes: [
      ...backdropShapes.map(shape => ({ ...shape, transform: full.transform })),
      ...markShapes.map(shape => ({ ...shape, transform: inner.transform }))
    ],
    options: full
  }
}

const { emit, finish } = createEmitter({ repoRoot, checkOnly: process.argv.includes('--check') })

const allShapes = readSvg(readFileSync(sourceSvg, 'utf8'))
const markShapes = allShapes.filter(shape => shape.group === 'mark')
if (markShapes.length === 0) {
  throw new Error('design/icon.svg has no shapes inside <g id="mark">')
}
if (!allShapes.some(shape => shape.id === 'backdrop')) {
  throw new Error('design/icon.svg has no #backdrop')
}

// The app's own assets.
emit(resolve(assetsDir, 'icon.png'), encodePng(render(allShapes, { ...fullBleed(1024, true), opaque: true })))
emit(resolve(assetsDir, 'adaptive-icon.png'), encodePng(render(markShapes, fitted(1024, markShapes, ADAPTIVE_SAFE_BOX)))) // prettier-ignore
emit(resolve(assetsDir, 'splash-icon.png'), encodePng(render(allShapes, fullBleed(512, false))))
emit(resolve(assetsDir, 'favicon.png'), encodePng(render(allShapes, fullBleed(64, false))))

// The browser build's own. The two manifest icons keep the artwork's rounded
// corners, because a browser draws them as given; the Apple one is square and
// opaque, because iOS masks and composites it itself and a transparent corner
// there comes out black.
emit(resolve(webIconsDir, 'icon-192.png'), encodePng(render(allShapes, fullBleed(192, false))))
emit(resolve(webIconsDir, 'icon-512.png'), encodePng(render(allShapes, fullBleed(512, false))))
emit(resolve(webIconsDir, 'apple-touch-icon.png'), encodePng(render(allShapes, { ...fullBleed(180, true), opaque: true }))) // prettier-ignore

const masked = maskable(
  512,
  allShapes.filter(shape => shape.group !== 'mark'),
  markShapes
)
emit(resolve(webIconsDir, 'icon-maskable-512.png'), encodePng(render(masked.shapes, masked.options)))

// The desktop shell's flat PNGs — shaped artwork, alpha kept, no masking done
// for it.
const flatPng = size => encodePng(render(allShapes, fullBleed(size, false)))
emit(resolve(desktopIconsDir, '32x32.png'), flatPng(32))
emit(resolve(desktopIconsDir, '128x128.png'), flatPng(128))
emit(resolve(desktopIconsDir, '128x128@2x.png'), flatPng(256))
emit(resolve(desktopIconsDir, 'icon.png'), flatPng(1024))

// icon.icns — opaque, square-cornered renders at the sizes macOS actually
// asks for, packed by our own container writer (see encodeIcns).
const squaredPng = size => encodePng(render(allShapes, { ...fullBleed(size, true), opaque: true }))
emit(
  resolve(desktopIconsDir, 'icon.icns'),
  encodeIcns([
    { type: 'ic07', png: squaredPng(128) }, // 128x128
    { type: 'ic08', png: squaredPng(256) }, // 256x256
    { type: 'ic13', png: squaredPng(256) }, // 128x128@2x
    { type: 'ic09', png: squaredPng(512) }, // 512x512
    { type: 'ic14', png: squaredPng(512) }, // 256x256@2x
    { type: 'ic10', png: squaredPng(1024) }, // 512x512@2x / 1024x1024
    { type: 'ic11', png: squaredPng(32) }, // 16x16@2x
    { type: 'ic12', png: squaredPng(64) } // 32x32@2x
  ])
)

// icon.ico — the shaped PNGs Windows will actually show, packed by our own
// container writer (see encodeIco).
emit(resolve(desktopIconsDir, 'icon.ico'), encodeIco([16, 32, 48, 256].map(size => ({ size, png: flatPng(size) }))))

finish({ subject: 'Icons', source: 'design/icon.svg', command: 'node scripts/generate-app-icons.mjs' })
