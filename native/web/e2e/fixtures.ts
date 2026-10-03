/**
 * The fixtures of the black-box suite (`e2e/*.spec.ts`).
 *
 * What a spec gets, and what it can rely on:
 *
 *  - **The real build, once per worker.** `vite build` into a temporary
 *    directory, laid out the way the plugin carries it (`<assets>/app/` holding
 *    `index.html` and `assets/`), then `build.json` is written next to it as
 *    `npm run client:build` does. Nothing here is the development harness and
 *    nothing is read from a stale `dist/`.
 *  - **A gateway of its own per test**, on a free port: the fake gateway in
 *    cookie mode, serving that build through its copy of the dashboard's static
 *    route (`/dashboard-plugins/hermie/app/index.html`, no-store, no SPA
 *    fallback, an allow-list of suffixes). A test therefore starts with no open
 *    request, no draft, no running turn and no leftover cookie, whatever the
 *    one before it did. `test.use({ gatewayOptions })` changes how it is started
 *    (history rows, how slowly a reply streams, a scripted scenario).
 *  - **Its control endpoints**, as the black-box clients use them (HTTP, not
 *    the in-process object): `state`, `raise`, `withdraw`, `dropSockets`,
 *    `expireSessions`, `inject`. A spec that needs to know the gateway has
 *    heard something polls `state()`; none sleeps.
 *  - **An https front, when a spec asks for one** (`test.use({ secureOrigin })`):
 *    the page is then loaded from that origin (`https://gw.example.test`, say),
 *    and every request and WebSocket the browser makes to it is carried to the
 *    fake gateway by Playwright's own routing, so the page is a secure context
 *    on a host name WebAuthn accepts as an RP without a certificate or a
 *    proxy. The session cookie is copied to that host on sign-in. What the
 *    passkey level needs (`e2e/passkey.spec.ts`); everything else is unchanged.
 *  - **Diagnostics on every test** (an automatic fixture): any `console.error`,
 *    any uncaught page error and any `securitypolicyviolation` event fails the
 *    test when it ends, with the message. The one thing a spec may say is
 *    `diagnostics.allow(/pattern/)` for an error it provokes on purpose (a 401
 *    the browser itself logs when a session is taken away), and it should say
 *    it at the point where it provokes it. `diagnostics.allowViolation(/pattern/)`
 *    is the same for a policy violation, and has one use: Playwright's own
 *    screenshot in WebKit appends an empty style element to sync animations,
 *    which the page's policy refuses (`e2e/markdown.spec.ts`, its pictures).
 *
 * The suite is black box: it drives the page through roles and accessible
 * names (the way a reader and a screen reader meet it) and the gateway through
 * its control endpoints. A few selectors name a class or a data attribute where
 * the page offers nothing else (`.hm-bubble[data-kind]`, `[data-row-key]`); each
 * is the page's own hook for exactly that.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { AxeBuilder } from '@axe-core/playwright'
import { type FakeGateway, type FakeGatewayOptions, startFakeGateway } from '@hermie/fake-gateway'
import { type BrowserContext, expect, type Locator, type Page, test as base } from '@playwright/test'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

/** Where the plugin serves the client, relative to the gateway's origin. */
export const APP_PATH = '/dashboard-plugins/hermie/app/index.html'

/** The fixture bot whose chat most specs open. */
export const BOT = 'researcher'

/** The account the fake gateway accepts on its sign-in page. */
const ACCOUNT = { username: 'tester', password: 'hunter2' }

/** One answer the gateway was given to a request it raised. */
export interface FakeAnswer {
  id: string
  method: string
  result?: Record<string, unknown>
  error?: unknown
}

/** What `/__fake/state` reads back. */
export interface FakeState {
  connections: number
  openSockets: number
  ticketsMinted: number
  openServerRequests: string[]
  serverRequestAnswers: FakeAnswer[]
  runningSessions: string[]
  methodLog: unknown[]
}

/** The gateway of one test, through its HTTP control endpoints. */
export interface Gateway {
  /** The in-process fake, for what no endpoint offers (publishing a stream event). */
  readonly fake: FakeGateway
  readonly url: string
  /** The client's address, with a route in the fragment. */
  appUrl(hash?: string): string
  state(): Promise<FakeState>
  answers(): Promise<FakeAnswer[]>
  running(): Promise<string[]>
  /** Raise a server-to-client request (`approval`, `clarify`, ...) on a bot's chat. Does not wait for the answer. */
  raise(method: string, params: Record<string, unknown>, profile?: string): Promise<void>
  /** Withdraw every request still open, as the gateway does when it stops waiting. */
  withdraw(reason?: string): Promise<number>
  /** Every live socket goes: abruptly, or with a close code. */
  dropSockets(code?: number): Promise<number>
  /** Every cookie session ends at once. */
  expireSessions(): Promise<number>
  /** Two messages into a bot's chat, as if a turn had been run elsewhere. */
  inject(message: {
    profile?: string
    user: string
    assistant: string
    /**
     * Who wrote the user message, as the fork stamps it (`display_metadata.author`); `via` marks a turn an agent
     * sent for that person (`contract/gateway/mcp.md`).
     */
    author?: { id: string; name?: string; via?: { kind: string; client: string } }
  }): Promise<void>
}

/** Console errors and policy violations of the page under test. */
export interface Diagnostics {
  /** Console errors matching this are expected in this test. Say it where it is provoked. */
  allow(pattern: RegExp): void
  /** Policy violations matching this are expected in this test: the test runner's own doing, never the page's. */
  allowViolation(pattern: RegExp): void
  /** Every `securitypolicyviolation` the page reported so far. */
  readonly violations: readonly string[]
}

/** The page of the test, signed in on request, with the handles every spec uses. */
export interface App {
  readonly page: Page
  /** Sign in as the gateway's own page would: the cookie lands in the browser context. */
  signIn(): Promise<void>
  /** Sign in, then open the client at a route. */
  open(hash?: string): Promise<void>
  readonly transcript: Locator
  readonly field: Locator
  readonly sendButton: Locator
  readonly stopButton: Locator
  readonly dialog: Locator
  /** The chat is attached and the connection ready: what has to be true for Send to be on. */
  ready(): Promise<void>
  /** Type in the field and press Return, as a keyboard reader would. */
  send(text: string): Promise<void>
}

interface Options {
  /** How the gateway of each test is started, on top of cookie mode and the built client. */
  gatewayOptions: Partial<FakeGatewayOptions>
  /** Serve the page from this https origin, carried to the fake gateway by routing (see above). */
  secureOrigin: string | null
}

interface TestFixtures {
  gateway: Gateway
  app: App
  diagnostics: Diagnostics
}

interface WorkerFixtures {
  /** The directory the gateway serves plugin assets from: `app/` in it is the build. */
  builtClient: string
}

async function control(url: string, path: string, body: unknown = {}): Promise<unknown> {
  const response = await fetch(`${url}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  })

  expect(response.ok, `${path} answered ${response.status}`).toBe(true)

  return response.json()
}

function controlsOf(fake: FakeGateway, secureOrigin: string | null): Gateway {
  const url = fake.url
  const state = async (): Promise<FakeState> => (await (await fetch(`${url}/__fake/state`)).json()) as FakeState

  return {
    fake,
    url,
    appUrl: (hash = '') => `${secureOrigin ?? url}${APP_PATH}${hash}`,
    state,
    answers: async () => (await state()).serverRequestAnswers,
    running: async () => (await state()).runningSessions,
    async raise(method, params, profile = BOT) {
      await control(url, '/__fake/request', { profile, method, params })
    },
    async withdraw(reason = 'cancelled') {
      return ((await control(url, '/__fake/withdraw-requests', { reason })) as { withdrawn: number }).withdrawn
    },
    async dropSockets(code) {
      return ((await control(url, '/__fake/drop-sockets', code === undefined ? {} : { code })) as { dropped: number })
        .dropped
    },
    async expireSessions() {
      return ((await control(url, '/__fake/expire-sessions')) as { expired: number }).expired
    },
    async inject(message) {
      await control(url, '/__fake/inject', { profile: BOT, ...message })
    }
  }
}

/** Close codes a routed WebSocket may be closed with; anything else becomes a normal closure. */
const closeCode = (code: number | undefined): number =>
  code === 1000 || (code !== undefined && code >= 3000 && code <= 4999) ? code : 1000

/**
 * Carry every request and WebSocket of `origin` to the fake gateway at `target`
 * (see "An https front" above). The browser sees `origin` and nothing else.
 */
async function routeSecureOrigin(context: BrowserContext, origin: string, target: string): Promise<void> {
  await context.route(
    url => url.origin === origin,
    async route => {
      const request = route.request()
      const response = await route.fetch({
        url: target + request.url().slice(origin.length),
        headers: await request.allHeaders()
      })

      await route.fulfill({ response })
    }
  )

  const wsOrigin = origin.replace(/^https:/u, 'wss:')

  await context.routeWebSocket(
    url => url.href.startsWith(`${wsOrigin}/`),
    ws => {
      const upstream = new WebSocket(target.replace(/^http/u, 'ws') + ws.url().slice(wsOrigin.length), ws.protocols())
      const waiting: (string | Buffer)[] = []

      upstream.binaryType = 'arraybuffer'
      upstream.onopen = () => {
        for (const message of waiting.splice(0)) {
          upstream.send(message)
        }
      }
      upstream.onmessage = event =>
        ws.send(typeof event.data === 'string' ? event.data : Buffer.from(event.data as ArrayBuffer))
      upstream.onclose = event => ws.close({ code: closeCode(event.code), reason: event.reason })
      ws.onMessage(message => (upstream.readyState === WebSocket.OPEN ? upstream.send(message) : waiting.push(message)))
      ws.onClose((code, reason) => upstream.close(closeCode(code), reason))
    }
  )
}

export const test = base.extend<TestFixtures & Options, WorkerFixtures>({
  gatewayOptions: [{}, { option: true }],
  secureOrigin: [null, { option: true }],

  builtClient: [
    // eslint-disable-next-line no-empty-pattern -- Playwright reads the dependencies from the destructuring
    async ({}, use) => {
      const dir = mkdtempSync(join(tmpdir(), 'hermie-e2e-'))
      const app = join(dir, 'assets', 'app')

      execFileSync('npx', ['vite', 'build', '--outDir', app, '--emptyOutDir'], { cwd: root, stdio: 'pipe' })
      execFileSync(process.execPath, ['scripts/write-build-manifest.mjs', app], { cwd: root, stdio: 'pipe' })

      await use(join(dir, 'assets'))
      rmSync(dir, { recursive: true, force: true })
    },
    { scope: 'worker', timeout: 180_000 }
  ],

  gateway: async ({ builtClient, gatewayOptions, secureOrigin }, use) => {
    const fake = await startFakeGateway({ auth: 'cookie', pluginAssets: builtClient, ...gatewayOptions })

    await use(controlsOf(fake, secureOrigin))
    await fake.close()
  },

  // The gateway is set up before the browser context and so torn down after it: a server cannot close while
  // the browser still holds its keep-alive connections, and the context is what closes them.
  context: async ({ gateway, context, secureOrigin }, use) => {
    if (secureOrigin) {
      await routeSecureOrigin(context, secureOrigin, gateway.url)
    }

    await use(context)
  },

  diagnostics: [
    async ({ page }, use) => {
      const errors: string[] = []
      const violations: string[] = []
      const allowed: RegExp[] = []

      page.on('console', message => {
        if (message.type() === 'error') {
          errors.push(message.text())
        }
      })
      page.on('pageerror', error => errors.push(`uncaught: ${error.message}`))

      // The page reports a policy violation to the test; nothing else crosses.
      await page.exposeFunction('hermieReportViolation', (text: string) => violations.push(text))
      await page.addInitScript(() => {
        document.addEventListener('securitypolicyviolation', event => {
          const report = (globalThis as unknown as { hermieReportViolation?: (text: string) => void })
            .hermieReportViolation

          report?.(
            `${event.violatedDirective} blocked ${event.blockedURI || 'inline'}` +
              ` at ${event.sourceFile || event.documentURI}:${event.lineNumber} ${event.sample}`
          )
        })
      })

      const allowedViolations: RegExp[] = []

      await use({
        allow: pattern => allowed.push(pattern),
        allowViolation: pattern => allowedViolations.push(pattern),
        violations
      })

      expect
        .soft(
          errors.filter(text => !allowed.some(pattern => pattern.test(text))),
          'the page logged console errors'
        )
        .toEqual([])
      expect
        .soft(
          violations.filter(text => !allowedViolations.some(pattern => pattern.test(text))),
          'the page reported content security policy violations'
        )
        .toEqual([])
    },
    { auto: true }
  ],

  app: async ({ page, gateway, secureOrigin }, use) => {
    const field = page.getByRole('textbox', { name: /^Message / })
    const sendButton = page.getByRole('button', { name: 'Send', exact: true })

    const app: App = {
      page,
      async signIn() {
        const login = await page.request.post(`${gateway.url}/auth/password-login`, {
          data: { ...ACCOUNT, next: '/' }
        })

        expect(login.ok()).toBe(true)

        // Behind an https front the browser asks that host, so the session goes there too.
        if (secureOrigin) {
          const host = new URL(secureOrigin).hostname
          const cookies = await page.context().cookies(gateway.url)

          await page.context().addCookies(cookies.map(cookie => ({ ...cookie, domain: host, path: '/', secure: true })))
        }
      },
      async open(hash = `#/chat/${BOT}`) {
        await app.signIn()
        await page.goto(gateway.appUrl(hash))
      },
      transcript: page.getByRole('log'),
      field,
      sendButton,
      stopButton: page.getByRole('button', { name: 'Stop', exact: true }),
      dialog: page.getByRole('dialog'),
      async ready() {
        await field.fill('x')
        await expect(sendButton).toBeEnabled({ timeout: 15_000 })
        await field.fill('')
      },
      async send(text) {
        await field.fill(text)
        await expect(sendButton).toBeEnabled()
        await field.press('Enter')
      }
    }

    await use(app)
  }
})

export { expect }

/** A reply of `count` frames, each of which says whose it is: "Alpha part 1. ", "Alpha part 2. ", ... */
export const parts = (name: string, count = 24): string[] =>
  Array.from({ length: count }, (_, index) => `${name} part ${index + 1}. `)

/** The newest reply that says it is `name`'s. */
export const replyOf = (app: App, name: string): Locator =>
  app.transcript.locator('.hm-bubble[data-kind="assistant"]', { hasText: `${name} part 1.` }).last()

/** How many rows the transcript holds right now. */
export const rowCount = (app: App): Promise<number> =>
  app.transcript.evaluate(log => log.querySelectorAll('[data-row-key]').length)

/**
 * Wait until the page has painted `frames` frames in a row in which `read()` gave
 * the same answer. A condition on the page rather than on the clock: a loaded
 * machine takes longer and still gets it right.
 */
export async function settled<T>(page: Page, read: () => Promise<T>, frames = 20): Promise<void> {
  let last: T | undefined
  let stable = 0

  await expect
    .poll(
      async () => {
        await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())))

        const now = await read()

        stable = last !== undefined && JSON.stringify(now) === JSON.stringify(last) ? stable + 1 : 0
        last = now

        return stable
      },
      { timeout: 30_000, intervals: [0] }
    )
    .toBeGreaterThanOrEqual(frames)
}

/** Move to another route without reloading: the chats the page holds stay attached. */
export const goTo = (page: Page, hash: string): Promise<void> =>
  page.evaluate(next => {
    location.hash = next
  }, hash)

/**
 * axe on the page as it is, with its own colours and fonts (contrast needs a
 * layout, which is the point of running it in a browser). Returns the serious and
 * critical violations, one line each, and attaches every violation to the report.
 */
export async function seriousViolations(page: Page, label: string): Promise<string[]> {
  const result = await new AxeBuilder({ page }).analyze()

  if (result.violations.length > 0) {
    await test.info().attach(`axe-${label}.json`, {
      body: JSON.stringify(result.violations, null, 2),
      contentType: 'application/json'
    })
  }

  return result.violations
    .filter(violation => violation.impact === 'serious' || violation.impact === 'critical')
    .map(
      violation =>
        `[${violation.impact}] ${violation.id}: ${violation.help} (${violation.nodes.map(node => node.target.join(' ')).join(', ')})`
    )
}
