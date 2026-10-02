#!/usr/bin/env node
/**
 * Export the browser build into the Hermie Web package.
 *
 * A script rather than one line in `package.json` for two reasons, both of
 * which have bitten a plain `expo export`:
 *
 *  - The output directory has to be EMPTIED first. Expo writes hashed bundle
 *    names, so a second export leaves the previous bundle behind for ever and
 *    the release zip grows one dead megabyte at a time.
 *  - The path is relative to this workspace, and the thing that consumes it is
 *    two directories up. Resolving it here means `npm run web:build` behaves the
 *    same whatever directory it was started from.
 */
import { spawnSync } from 'node:child_process'
import { rmSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outputDir = path.resolve(appRoot, '..', '..', 'packages', 'hermie-web', 'dist', 'web')

rmSync(outputDir, { recursive: true, force: true })

const result = spawnSync('npx', ['expo', 'export', '--platform', 'web', '--output-dir', outputDir], {
  cwd: appRoot,
  stdio: 'inherit'
})

if (result.error) {
  console.error(`export-web: ${result.error.message}`)
  process.exit(1)
}

process.exit(result.status ?? 1)
