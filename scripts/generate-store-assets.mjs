#!/usr/bin/env node
/**
 * Rasterises the two images a Google Play listing needs that the app itself does
 * not ship: the 1024 x 500 feature graphic, and the 512 x 512 icon.
 *
 *   node scripts/generate-store-assets.mjs
 *   node scripts/generate-store-assets.mjs --check    # fail if anything is stale
 *
 * `npm run icons` and `npm run icons:check` run this after the app's icons, so
 * the listing's artwork drifts from the sources no more freely than the app's
 * does. The renderer is the icons' own (scripts/lib/svg-raster.mjs).
 *
 * Both files are written with NO alpha channel — three bytes per pixel, PNG
 * colour type 2. Play rejects a feature graphic that has one, and an icon that
 * carries transparency it will not use is a way to ship a surprise: whatever
 * shows through is the store's background, not ours.
 */

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createEmitter, encodePng, readSvg, render } from './lib/svg-raster.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..')
const iconSvg = resolve(repoRoot, 'design/icon.svg')
const featureSvg = resolve(repoRoot, 'design/store/feature-graphic.svg')
const storeDir = resolve(repoRoot, 'design/store')

const { emit, finish } = createEmitter({ repoRoot, checkOnly: process.argv.includes('--check') })

/**
 * The feature graphic. Its own file is already 1024 x 500, so the transform is
 * the identity: the whole numbers in it are pixel boundaries, which is what the
 * drawing relies on to keep its joins seamless.
 */
const featureShapes = readSvg(readFileSync(featureSvg, 'utf8'))
if (!featureShapes.some(shape => shape.group === 'wordmark')) {
  throw new Error('design/store/feature-graphic.svg has no shapes inside <g id="wordmark">')
}
emit(
  resolve(storeDir, 'feature-graphic.png'),
  encodePng(
    render(featureShapes, {
      width: 1024,
      height: 500,
      transform: { scale: 1, x: 0, y: 0 },
      opaque: true
    })
  )
)

/**
 * The listing icon: the app icon at the one size Play takes, with the corners
 * left square. Play rounds and masks the icon itself, exactly as iOS and Android
 * do with expo/hermie/assets/icon.png, so rounding it here would show a second
 * radius inside the store's own.
 */
const iconShapes = readSvg(readFileSync(iconSvg, 'utf8'))
if (!iconShapes.some(shape => shape.id === 'backdrop')) {
  throw new Error('design/icon.svg has no #backdrop')
}
emit(
  resolve(storeDir, 'play-icon-512.png'),
  encodePng(
    render(iconShapes, {
      width: 512,
      height: 512,
      transform: { scale: 512 / 1024, x: 0, y: 0 },
      squareCornersOf: 'backdrop',
      opaque: true
    })
  )
)

finish({
  subject: 'Store assets',
  source: 'design/icon.svg and design/store/feature-graphic.svg',
  command: 'node scripts/generate-store-assets.mjs'
})
