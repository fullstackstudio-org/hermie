import { defineConfig, devices } from '@playwright/test'

/**
 * The black-box suite of the web client (`e2e/*.spec.ts`, not `e2e/perf`).
 *
 * Every test gets a fake gateway of its own, in cookie mode, serving the real
 * production build through its copy of the dashboard's static route, so there
 * is no web server to start here: `e2e/fixtures.ts` builds the client once per
 * worker and starts and stops the gateways. The transcript list's performance
 * budgets are a different suite with its own server and its own configuration
 * (`playwright.perf.config.ts`).
 *
 * Chromium, WebKit and Firefox all run it (CI runs each in a job of its own).
 * Tests do not share a gateway, so they could run side by side, but a machine
 * that is busy with several browsers makes the frame-by-frame scroll checks
 * slower for nothing: one worker, and a failure keeps its trace for the report.
 */
export default defineConfig({
  testDir: 'e2e',
  testIgnore: 'perf/**',
  outputDir: 'test-results',
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  timeout: 90_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI ? [['list'], ['github']] : [['list']],
  use: {
    viewport: { width: 1280, height: 800 },
    trace: 'retain-on-failure',
    video: 'off',
    // The trace has a snapshot of every step; a screenshot would also put a style element into a page whose
    // policy refuses them, and that shows up as a violation in the test that failed for another reason.
    screenshot: 'off'
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } } },
    { name: 'webkit', use: { ...devices['Desktop Safari'], viewport: { width: 1280, height: 800 } } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'], viewport: { width: 1280, height: 800 } } }
  ]
})
