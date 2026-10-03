#!/usr/bin/env node
// Runs the unit suite (`vitest run`, with whatever arguments follow).
//
// Node 25 ships its own Web Storage (`localStorage`, `sessionStorage`), and in a
// jsdom test its globals shadow jsdom's: the suite then reads a store that is not
// the one the code under test was given. `NODE_OPTIONS=--no-webstorage` turns
// Node's off. Older Node does not know the flag (Node 22 refuses it in
// NODE_OPTIONS and does not start), so the flag is added only when this Node
// accepts it, which is asked of Node itself rather than read off a version number.
//
//   node scripts/run-vitest.mjs [vitest arguments]

import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

import { acceptsNodeOption, withNodeOption } from './node-option.mjs'

const FLAG = '--no-webstorage'

const require = createRequire(import.meta.url)
const vitestPackage = require.resolve('vitest/package.json')
const { bin } = require('vitest/package.json')
const entry = join(dirname(vitestPackage), typeof bin === 'string' ? bin : bin.vitest)

const env = acceptsNodeOption(FLAG) ? { ...process.env, NODE_OPTIONS: withNodeOption(FLAG) } : process.env
const result = spawnSync(process.execPath, [entry, 'run', ...process.argv.slice(2)], { env, stdio: 'inherit' })

if (result.error) {
  throw result.error
}

process.exit(result.status ?? (result.signal ? 1 : 0))
