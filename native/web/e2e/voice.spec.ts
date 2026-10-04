/**
 * Voice in a real browser, against the fake gateway serving the built client: the controls are there where the
 * browser can do the thing behind them, and not where it cannot.
 *
 *  - **Where it has a recogniser and a synthesiser** (installed before the page loads, as a browser has them): the
 *    composer has a microphone, what the recogniser hears goes into the field, a reply's menu has "Read aloud" and
 *    saying it reaches the synthesiser, and Settings lists Voice.
 *  - **Where it has neither** (Firefox has no recogniser; here both are taken away, so the answer is the same in
 *    every engine): no microphone, no "Read aloud", and no Voice in Settings, and nothing in the console about it.
 *
 * The recogniser and the synthesiser are fakes: the suite never opens a microphone or makes a sound.
 */
import type { Page } from '@playwright/test'

import { expect, test } from './fixtures'

declare global {
  interface Window {
    /** What the fake synthesiser was asked to say, for the test to read. */
    __spoken?: string[]
    /** The fake recogniser's sessions, for the test to speak into. */
    __sessions?: { hear: (transcript: string, final?: boolean) => void }[]
  }
}

test.use({ gatewayOptions: { scenario: { replies: [{ deltas: ['Autumn **moonlight**. '] }] } } })

/** Give the page a recogniser and a synthesiser before any of its own code runs. */
async function withVoice(page: Page): Promise<void> {
  await page.addInitScript(() => {
    window.__spoken = []
    window.__sessions = []

    class Recognition {
      lang = ''
      continuous = false
      interimResults = false
      onresult: ((event: { resultIndex: number; results: unknown[] }) => void) | null = null
      onerror: ((event: { error: string }) => void) | null = null
      onend: (() => void) | null = null

      constructor() {
        window.__sessions?.push(this)
      }

      start(): void {
        return undefined
      }

      stop(): void {
        this.onend?.()
      }

      abort(): void {
        return undefined
      }

      hear(transcript: string, final = false): void {
        this.onresult?.({ resultIndex: 0, results: [Object.assign([{ transcript }], { isFinal: final })] })
      }
    }

    class Utterance {
      lang = ''
      rate = 1
      onend: (() => void) | null = null
      onerror: (() => void) | null = null

      constructor(readonly text: string) {}
    }

    Object.defineProperty(window, 'webkitSpeechRecognition', { configurable: true, value: Recognition })
    Object.defineProperty(window, 'SpeechRecognition', { configurable: true, value: Recognition })
    Object.defineProperty(window, 'SpeechSynthesisUtterance', { configurable: true, value: Utterance })
    Object.defineProperty(window, 'speechSynthesis', {
      configurable: true,
      value: {
        speak: (utterance: Utterance) => void window.__spoken?.push(utterance.text),
        cancel: () => undefined
      }
    })
  })
}

/** Take away whatever this browser has, so the page sees what a browser with no voice at all shows it. */
async function withoutVoice(page: Page): Promise<void> {
  await page.addInitScript(() => {
    for (const name of [
      'webkitSpeechRecognition',
      'SpeechRecognition',
      'SpeechSynthesisUtterance',
      'speechSynthesis'
    ]) {
      Object.defineProperty(window, name, { configurable: true, value: undefined })
    }
  })
}

test.describe('in a browser that can listen and speak', () => {
  test.beforeEach(async ({ page }) => {
    await withVoice(page)
  })

  test('puts what is heard into the field, and nothing is sent until the reader sends it', async ({
    app,
    gateway,
    page
  }) => {
    await app.open()
    await app.ready()

    await app.field.fill('Remind me to')
    await page.getByRole('button', { name: 'Dictate' }).click()
    await expect(page.getByRole('button', { name: 'Stop dictating' })).toHaveAttribute('aria-pressed', 'true')
    await expect(page.getByText('Listening…')).toBeVisible()

    await page.evaluate(() => {
      const session = window.__sessions?.[0] as unknown as { hear: (text: string, final?: boolean) => void }

      session.hear('call')
      session.hear('call the plumber')
    })

    await expect(app.field).toHaveValue('Remind me to call the plumber')
    expect((await gateway.state()).methodLog.filter(entry => entry === 'prompt.submit')).toHaveLength(0)

    // A press again stops it; the words stay, and the button is the plain one again.
    await page.getByRole('button', { name: 'Stop dictating' }).click()
    await expect(page.getByRole('button', { name: 'Dictate' })).toBeVisible()
    await expect(app.field).toHaveValue('Remind me to call the plumber')
  })

  test('offers Read aloud on a reply, and saying it reaches the synthesiser flattened for the ear', async ({
    app,
    page
  }) => {
    await app.open()
    await app.ready()
    await app.send('say something')

    const reply = page.getByRole('log').locator('.hm-bubble[data-kind="assistant"]', { hasText: 'Autumn' }).last()

    await expect(reply).toBeVisible()
    await expect(app.transcript).not.toHaveAttribute('aria-busy', 'true')
    await reply.click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Read aloud' }).click()

    await expect.poll(() => page.evaluate(() => window.__spoken)).toEqual(['Autumn moonlight.'])

    // The same row now says how to stop.
    await reply.click({ button: 'right' })
    await expect(page.getByRole('menuitem', { name: 'Stop reading' })).toBeVisible()
  })

  test('lists Voice in Settings, with the speed and the language, and says who does the transcribing', async ({
    app,
    page
  }) => {
    await app.open('#/settings')

    await page.getByRole('link', { name: 'Voice' }).click()
    await expect(page.getByRole('heading', { level: 2, name: 'Voice' })).toBeVisible()
    await expect(page.getByRole('group', { name: 'Reading aloud' })).toBeVisible()
    await expect(page.getByRole('group', { name: 'Dictation language' })).toBeVisible()
    await expect(page.getByText(/sends the audio to the browser’s maker/u)).toBeVisible()

    await page.getByRole('radio', { name: 'Fast', exact: true }).check()
    // The choice is this browser's own: it is still there after the page is loaded again.
    await page.reload()
    await expect(page.getByRole('radio', { name: 'Fast', exact: true })).toBeChecked()
  })
})

test.describe('in a browser that has neither', () => {
  test.beforeEach(async ({ page }) => {
    await withoutVoice(page)
  })

  test('draws no microphone, no Read aloud and no Voice section, and says nothing about it', async ({ app, page }) => {
    await app.open()
    await app.ready()
    await app.send('say something')

    await expect(app.field).toBeVisible()
    await expect(page.getByRole('button', { name: 'Dictate' })).toHaveCount(0)

    const reply = page.getByRole('log').locator('.hm-bubble[data-kind="assistant"]', { hasText: 'Autumn' }).last()

    await expect(reply).toBeVisible()
    await expect(app.transcript).not.toHaveAttribute('aria-busy', 'true')
    await reply.click({ button: 'right' })
    await expect(page.getByRole('menuitem', { name: 'Copy text' })).toBeVisible()
    await expect(page.getByRole('menuitem', { name: 'Read aloud' })).toHaveCount(0)
    await page.keyboard.press('Escape')

    await page.getByRole('button', { name: 'Chat options' }).click()
    await expect(page.getByRole('group', { name: 'What this conversation shows' })).toBeVisible()
    await expect(page.getByRole('checkbox', { name: 'Read replies aloud' })).toHaveCount(0)

    await app.open('#/settings')
    await expect(page.getByRole('link', { name: 'Appearance' })).toBeVisible()
    await expect(page.getByRole('link', { name: 'Voice' })).toHaveCount(0)
  })
})
