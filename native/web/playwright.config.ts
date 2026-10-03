import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { defineConfig, devices } from '@playwright/test'

/**
 * End-to-end and performance specs of the web client (`e2e/`).
 *
 * For now there is one suite, `e2e/perf`: the transcript list measured on the
 * development-only harness page, built with `vite build --mode harness` and
 * served by `vite preview --mode harness` on 127.0.0.1:4180. Production React,
 * minified, under the client's own document policy.
 *
 * CI runs Chromium only (`--project=chromium`); WebKit and Firefox run locally
 * (`npm run client:e2e`, all three). One worker: measurements must not share the
 * machine with another browser.
 */
const root = dirname(fileURLToPath(import.meta.url))
const PORT = 4180

export default defineConfig({
  testDir: 'e2e',
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
