import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { defineConfig, devices } from '@playwright/test'

/**
 * The transcript list's performance suite (`e2e/perf`), on the development-only
 * harness page: built with `vite build --mode harness` and served by
 * `vite preview --mode harness` on 127.0.0.1:4180 (production React, minified,
 * under the client's own document policy). The black-box suite is
 * `playwright.config.ts`; it has no web server and none of this.
 *
 * CI runs Chromium only (`--project=chromium`, in the `web-client` job, beside
 * the bundle budgets); WebKit and Firefox run locally (`npm run e2e:perf`, all
 * three). One worker: measurements must not share the machine with another
 * browser.
 */
const root = dirname(fileURLToPath(import.meta.url))
const PORT = 4180

export default defineConfig({
  testDir: 'e2e/perf',
  outputDir: 'test-results',
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  timeout: 120_000,
  reporter: process.env.CI ? [['list'], ['github']] : [['list']],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    viewport: { width: 1280, height: 800 },
    trace: 'off',
    video: 'off',
    screenshot: 'off'
  },
  webServer: {
    command: 'npm run harness:build && npm run harness:serve',
    cwd: root,
    url: `http://127.0.0.1:${PORT}/src/dev/transcript-harness.html`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    stdout: 'ignore',
    stderr: 'pipe'
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } } },
    { name: 'webkit', use: { ...devices['Desktop Safari'], viewport: { width: 1280, height: 800 } } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'], viewport: { width: 1280, height: 800 } } }
  ]
})
