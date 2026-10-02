/**
 * Per-file setup for the golden recording run (`vitest.golden.config.ts`).
 *
 * Pins the clock, and when the file's tests are done writes what the recorder
 * saw: the corpus file to `$GOLDEN_OUT/transcript/golden/<suite>.json`, and the
 * per-operation counts to `$GOLDEN_STATS/<suite>.json` for the generator to add
 * up.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'

import { afterAll, expect } from 'vitest'

import { prettyJson } from '../../../scripts/golden/canonical-json'
import { noteClockRead, PINNED_NOW, recordedGroups, recordedStats } from './recorder'

const PINNED = Symbol.for('hermie.golden.pinnedDate')

if (!(globalThis.Date as unknown as Record<symbol, boolean>)[PINNED]) {
  const RealDate = globalThis.Date

  // A no-argument `new Date()` and `Date.now()` are the two ways the engine can
  // read the time; both answer the pin and tell the recorder they were asked.
  class PinnedDate extends RealDate {
    constructor(...args: unknown[]) {
      if (args.length === 0) {
        noteClockRead()
        super(PINNED_NOW)
      } else {
        super(...(args as [string | number | Date]))
      }
    }

    static override now(): number {
      noteClockRead()

      return PINNED_NOW
    }
  }

  Object.defineProperty(PinnedDate, PINNED, { value: true })
  globalThis.Date = PinnedDate as DateConstructor
}

afterAll(() => {
  const out = process.env.GOLDEN_OUT
  const statsDir = process.env.GOLDEN_STATS
  const testPath = expect.getState().testPath

  if (!out || !statsDir || !testPath) {
    throw new Error('The golden run needs GOLDEN_OUT and GOLDEN_STATS; use `npm run golden`.')
  }

  const suite = basename(testPath).replace(/\.test\.ts$/u, '')
  const goldenDir = join(out, 'transcript', 'golden')

  mkdirSync(goldenDir, { recursive: true })
  mkdirSync(statsDir, { recursive: true })
  writeFileSync(join(goldenDir, `${suite}.json`), prettyJson(recordedGroups()))
  writeFileSync(join(statsDir, `${suite}.json`), prettyJson(recordedStats()))
})
