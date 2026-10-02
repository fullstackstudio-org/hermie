/**
 * The golden recording run: the package's own tests, unchanged, with every
 * top-level call into the engine written to `contract/transcript/golden/`.
 *
 * Not part of `npm test`. Run through `npm run golden` (which sets GOLDEN_OUT
 * and GOLDEN_STATS); see `contract/README.md`.
 */
import { fileURLToPath } from 'node:url'

import { defineConfig } from 'vitest/config'

import { goldenWrap } from './golden/plugin'

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url))

export default defineConfig({
  root: here('.'),
  plugins: [goldenWrap({ srcDir: here('./src'), recorder: here('./golden/recorder.ts') })],
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    setupFiles: [here('./golden/setup.ts')],
    // One module graph per file, so each file's recorder starts empty.
    isolate: true
  }
})
