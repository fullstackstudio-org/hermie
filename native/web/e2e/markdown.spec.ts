/**
 * Markdown version 2 in a real browser: coloured code, typeset mathematics and
 * Mermaid diagrams, on the built client under its own document policy, in both
 * colour schemes.
 *
 * One reply holds one fixture of each kind. It is injected into the chat before
 * it is opened, so it arrives with the history and the chunks are fetched the way
 * a reader's first message with a formula or a diagram fetches them. For each
 * kind the spec checks the structure (a drawing is named by its source, its text
 * stays inside its drawing with the browser's real metrics, "Show source" swaps
 * it), runs axe over the page (contrast is measured here, not in jsdom), and
 * compares a picture of the block with the one recorded for this browser and
 * platform.
 *
 * The pictures are recorded on macOS (`npx playwright test e2e/markdown.spec.ts
 * --update-snapshots`). A run on another platform has no picture to compare with
 * and says so in an annotation instead of failing: text is drawn by each
 * platform's own faces, so a picture from one is not a reference for another.
 * Everything else in the spec runs everywhere.
 */
import { existsSync } from 'node:fs'

import { type Locator } from '@playwright/test'

import { type App, type Diagnostics, expect, seriousViolations, test } from './fixtures'

const FENCE = '```'

const CODE = [
  '// Adds two numbers.',
  'export function add(a: number, b: number): number {',
  '  return a + b',
  '}'
].join('\n')

const FORMULA = String.raw`x = \frac{-b \pm \sqrt{b^2 - 4ac}}{2a}`

const FLOWCHART = [
  'flowchart LR',
  '  A([Request]) --> B{Signed in?}',
  '  B -->|yes| C[Open the chat]',
  '  B -.->|no| D[[Sign in]]'
].join('\n')

const SEQUENCE = [
  'sequenceDiagram',
  '  actor R as Reader',
  '  participant G as Gateway',
  '  R->>+G: prompt',
  '  loop streaming',
  '    G-->>R: delta',
  '  end',
  '  G-->>-R: done'
].join('\n')

const PIE = ['pie title Where the time went', '  "Reading" : 42', '  "Writing" : 30', '  "Waiting" : 28'].join('\n')

const UNSUPPORTED = ['gantt', '  title Not drawn', '  section One', '  Task :a1, 2026-01-01, 3d'].join('\n')

const REPLY = [
  'Here is the code, the formula and the diagrams.',
  '',
  `${FENCE}ts`,
  CODE,
  FENCE,
  '',
  '$$',
  FORMULA,
  '$$',
  '',
  String.raw`So $\alpha_i \le x^2$ holds inline.`,
  '',
  ...[FLOWCHART, SEQUENCE, PIE, UNSUPPORTED].flatMap(source => [`${FENCE}mermaid`, source, FENCE, ''])
].join('\n')

/** An accessible name as the browser computes it: the white space folded. */
const nameOf = (source: string): string => source.replace(/\s+/gu, ' ').trim()

/** The reply's bubble: the newest assistant bubble that says it is this reply. */
const replyBubble = (app: App): Locator =>
  app.transcript.locator('.hm-bubble[data-kind="assistant"]', { hasText: 'Here is the code' }).last()

/** A block of the reply by what it holds (`data-kind` on the code block's box is the page's own hook). */
const block = (app: App, kind: 'code' | 'math' | 'mermaid', index = 0): Locator =>
  replyBubble(app).locator(`.md-code[data-kind="${kind}"]`).nth(index)

/**
 * Every `text` of a drawing that reaches past the drawing's own box. For a
 * formula the widths are the canvas's, so the text ends where the layout said;
 * for a diagram they are the layout's estimate, which keeps every label inside
 * the margin round it. One unit of slack for anti-aliasing.
 */
async function textOverflow(drawing: Locator): Promise<string[]> {
  return drawing.evaluate(svg => {
    const box = (svg as SVGSVGElement).viewBox.baseVal

    return Array.from(svg.querySelectorAll('text'))
      .map(text => ({ text: text.textContent ?? '', bounds: (text as SVGTextElement).getBBox() }))
      .filter(
        ({ bounds }) =>
          bounds.x < -1 ||
          bounds.y < -1 ||
          bounds.x + bounds.width > box.width + 1 ||
          bounds.y + bounds.height > box.height + 1
      )
      .map(
        ({ text, bounds }) => `${text}: ${bounds.x.toFixed(1)}..${(bounds.x + bounds.width).toFixed(1)} of ${box.width}`
      )
  })
}

/**
 * Compares a picture of each block with the one recorded for this browser and
 * platform, where one was recorded (see the top of the file).
 *
 * In WebKit, Playwright's screenshot appends an empty style element to the page
 * to sync animations, and the page's policy refuses it: a violation and a
 * console error that are the test runner's, allowed here and only here.
 */
async function matchesPictures(
  diagnostics: Diagnostics,
  browserName: string,
  pictures: readonly [target: Locator, name: string][]
): Promise<void> {
  const info = test.info()

  if (browserName === 'webkit') {
    diagnostics.allow(/^Refused to apply a stylesheet because its hash, its nonce, or 'unsafe-inline'/u)
    diagnostics.allowViolation(/^style-src-elem blocked inline at \S+\/index\.html:\d+ $/u)
  }

  for (const [target, name] of pictures) {
    if (!existsSync(info.snapshotPath(name, { kind: 'screenshot' })) && process.platform !== 'darwin') {
      info.annotations.push({ type: 'picture', description: `${name}: no picture recorded for ${process.platform}` })

      continue
    }

    // `animations` and `caret` as they are: their defaults put a style element into the page as well.
    await expect(target).toHaveScreenshot(name, { animations: 'allow', caret: 'initial', maxDiffPixelRatio: 0.01 })
  }
}

/** "Show source" puts the source in the drawing's place, and back. */
async function togglesSource(box: Locator, drawing: Locator, source: string): Promise<void> {
  const toggle = box.getByRole('button', { name: 'Show source' })

  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-pressed', 'true')
  await expect(box.locator('pre')).toHaveText(source)
  await expect(drawing).toHaveCount(0)
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-pressed', 'false')
  await expect(drawing).toBeVisible()
}

for (const scheme of ['light', 'dark'] as const) {
  test.describe(`in the ${scheme} scheme`, () => {
    test.beforeEach(async ({ page, gateway }) => {
      await page.emulateMedia({ colorScheme: scheme })
      await gateway.inject({ user: 'Show me everything.', assistant: REPLY })
    })

    test('colours code, draws mathematics and diagrams, accessibly, as recorded', async ({
      app,
      page,
      browserName,
      diagnostics
    }) => {
      await app.open()

      const code = block(app, 'code')
      const math = block(app, 'math')
      const formula = math.getByRole('img', { name: FORMULA })
      const diagrams = [
        { box: block(app, 'mermaid', 0), source: FLOWCHART, kind: 'flowchart' },
        { box: block(app, 'mermaid', 1), source: SEQUENCE, kind: 'sequence' },
        { box: block(app, 'mermaid', 2), source: PIE, kind: 'pie' }
      ] as const

      // The chunks arrive and the blocks already on the page are drawn.
      await expect(code.locator('.md-hl-keyword').first()).toHaveText('export')
      await expect(code.locator('pre code')).toHaveText(CODE)
      await expect(formula).toBeVisible()
      await expect(replyBubble(app).getByRole('math', { name: String.raw`\alpha_i \le x^2` })).toHaveText('αᵢ ≤ x²')

      for (const { box, source, kind } of diagrams) {
        const drawing = box.getByRole('img', { name: nameOf(source) })

        await expect(drawing).toBeVisible()
        await expect(drawing).toHaveAttribute('aria-label', source)
        await expect(drawing).toHaveClass(new RegExp(`md-diagram-${kind}`, 'u'))
        expect(await textOverflow(drawing), kind).toEqual([])

        // It fits its box: scaled down where it is wider, never wider than the bubble.
        const [outer, inner] = await Promise.all([box.boundingBox(), drawing.boundingBox()])

        expect(inner?.width ?? 0, kind).toBeLessThanOrEqual(outer?.width ?? 0)
        expect(inner?.height ?? 0, kind).toBeGreaterThan(40)
      }

      // A kind no parser draws is its source, with no toggle.
      const unsupported = block(app, 'mermaid', 3)

      await expect(unsupported.locator('pre')).toHaveText(UNSUPPORTED)
      await expect(unsupported.getByRole('button', { name: 'Show source' })).toHaveCount(0)

      expect(await textOverflow(formula)).toEqual([])
      // A drawing of a few lines of text is not a sliver and not a poster.
      const size = await formula.boundingBox()

      expect(size?.width).toBeGreaterThan(100)
      expect(size?.height).toBeGreaterThan(30)

      expect(await seriousViolations(page, `markdown-${scheme}`)).toEqual([])

      // Before anything is pressed, so no button is drawn hovered.
      await matchesPictures(diagnostics, browserName, [
        [code, `code-${scheme}.png`],
        [math, `math-${scheme}.png`],
        ...diagrams.map(({ box, kind }) => [box, `${kind}-${scheme}.png`] as [Locator, string])
      ])

      await togglesSource(math, formula, FORMULA)
      await togglesSource(diagrams[0].box, diagrams[0].box.getByRole('img'), FLOWCHART)
    })
  })
}
