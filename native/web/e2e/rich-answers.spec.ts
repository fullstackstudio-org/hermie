/**
 * A reply with cards, charts, a callout and links in a real browser: on the built client, under its own document
 * policy, in both colour schemes and at a phone and a desktop width.
 *
 * One reply holds one of each. It is injected into the chat before it is opened, so it arrives with the history and the
 * chunks are fetched the way a reader's first message with a chart fetches them. The spec checks the structure (what a
 * screen reader gets), that nothing leaves the page because of the reply (no request to any origin but the gateway's, no image),
 * that no drawing reaches past its box, that the external-link arrow is the one thing after a link and is not in its
 * name, runs axe over the page (contrast is measured here, not in jsdom) and compares a picture of the block with the
 * one recorded for this browser and platform, as `markdown.spec.ts` does.
 *
 * Set `RICH_WEB_SHOTS` to a directory to also write a picture of the whole reply there for each scheme and width.
 */
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

import { type Locator } from '@playwright/test'

import { type App, type Diagnostics, expect, seriousViolations, test } from './fixtures'

const FENCE = '```'

const CARDS = JSON.stringify(
  {
    title: 'Hoe ik het zou opzetten',
    cards: [
      {
        icon: 'server',
        title: 'Gateway per klant',
        subtitle: 'k3s, eigen Postgres',
        tags: ['k3s', 'Postgres'],
        highlight: true,
        next: 'deployt naar'
      },
      { icon: 'globe', title: 'Website', subtitle: 'Next.js standalone', tags: ['Next.js'], next: 'bereikt' },
      { icon: 'people', title: 'Klanten', subtitle: 'Vinden het via Google' }
    ]
  },
  null,
  2
)

const GRID = JSON.stringify(
  {
    layout: 'grid',
    cards: [
      { icon: 'database', title: 'Postgres', subtitle: 'Eigen database per klant' },
      { icon: 'lock', title: 'Geheimen', subtitle: 'In de kluis', highlight: true },
      { icon: 'mail', title: 'Mail', subtitle: 'Via de eigen mailbox' },
      { icon: 'cloud', title: 'Cloudflare', subtitle: 'HTTPS en DNS' }
    ]
  },
  null,
  2
)

const BAR = JSON.stringify(
  {
    type: 'bar',
    title: 'Sales per quarter',
    unit: 'EUR',
    x: ['Q1', 'Q2', 'Q3', 'Q4'],
    series: [
      { name: '2026', values: [12, 15, 9, 20] },
      { name: '2027', values: [14, 18, 11, 24] }
    ]
  },
  null,
  2
)

const LINE = JSON.stringify(
  {
    type: 'line',
    title: 'Visitors per week',
    x: ['W1', 'W2', 'W3', 'W4', 'W5', 'W6'],
    series: [
      { name: 'Organic', values: [120, 135, 128, 160, 182, 210] },
      { name: 'Direct', values: [60, 58, 71, 69, 80, 77] }
    ]
  },
  null,
  2
)

const PIE = JSON.stringify(
  {
    type: 'pie',
    title: 'Where the time went',
    unit: '%',
    x: ['Reading', 'Writing', 'Waiting'],
    series: [{ name: 'Share', values: [42, 30, 28] }]
  },
  null,
  2
)

const REPLY = [
  'Here is how I would set it up, with the numbers and the caveats.',
  '',
  `${FENCE}hermie-cards`,
  CARDS,
  FENCE,
  '',
  `${FENCE}hermie-cards`,
  GRID,
  FENCE,
  '',
  `${FENCE}hermie-chart`,
  BAR,
  FENCE,
  '',
  `${FENCE}hermie-chart`,
  LINE,
  FENCE,
  '',
  `${FENCE}hermie-chart`,
  PIE,
  FENCE,
  '',
  '> [!WARNING]',
  '> The database is not backed up yet. Do that **before** the first customer goes live.',
  '',
  '> [!TIP]',
  '> Start with one gateway and add the next when the first one is quiet.',
  '',
  'Read the [k3s documentation](https://docs.k3s.io/) or write to [info@example.org](mailto:info@example.org).'
].join('\n')

/** The reply's bubble: the newest assistant bubble that says it is this reply. */
const replyBubble = (app: App): Locator =>
  app.transcript.locator('.hm-bubble[data-kind="assistant"]', { hasText: 'Here is how I would set it up' }).last()

/** Every drawing and card that reaches past the edge of the reply's text column. */
async function overflowing(bubble: Locator): Promise<string[]> {
  return bubble.evaluate(root => {
    const column = root.getBoundingClientRect()

    return Array.from(root.querySelectorAll('.md-code, .md-alert, .md-chart-svg, .md-card'))
      .filter(element => {
        const box = element.getBoundingClientRect()

        return box.right > column.right + 1 || box.left < column.left - 1
      })
      .map(
        element =>
          `${element.className} ${Math.round(element.getBoundingClientRect().right)} > ${Math.round(column.right)}`
      )
  })
}

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

    await expect(target).toHaveScreenshot(name, { animations: 'allow', caret: 'initial', maxDiffPixelRatio: 0.01 })
  }
}

/** Tall, so the whole reply is on the screen at once (and in the picture of it). */
const WIDTHS = [
  { name: 'phone', width: 360, height: 3000 },
  { name: 'desktop', width: 1024, height: 2400 }
] as const

for (const scheme of ['light', 'dark'] as const) {
  for (const size of WIDTHS) {
    test.describe(`in the ${scheme} scheme at ${size.width} px`, () => {
      test.beforeEach(async ({ page, gateway }) => {
        await page.setViewportSize({ width: size.width, height: size.height })
        await page.emulateMedia({ colorScheme: scheme })
        await gateway.inject({ user: 'How would you set this up?', assistant: REPLY })
      })

      test('draws cards, charts, a callout and links, accessibly, as recorded', async ({
        app,
        page,
        browserName,
        diagnostics
      }) => {
        // Every origin the page talks to: the gateway's, and no other.
        const origins = new Set<string>()

        page.on('request', request => {
          const url = new URL(request.url())

          if (url.protocol.startsWith('http')) {
            origins.add(url.origin)
          }
        })

        await app.open()
        await page.getByRole('button', { name: 'Chat options' }).click()
        await page.getByRole('radio', { name: 'Normal' }).check()
        await page.keyboard.press('Escape')

        const bubble = replyBubble(app)

        // The chunks arrive and the blocks already on the page are drawn.
        const stack = bubble.getByRole('list', { name: 'Hoe ik het zou opzetten' })

        await expect(stack).toBeVisible()
        await expect(stack.getByRole('listitem')).toHaveCount(3)
        await expect(stack.getByRole('listitem').first()).toContainText(
          'Card 1 of 3, Gateway per klant, k3s, eigen Postgres, highlighted, tags k3s, Postgres, then: deployt naar'
        )
        await expect(bubble.getByRole('list', { name: 'Cards' }).getByRole('listitem')).toHaveCount(4)

        const bar = bubble.getByRole('img', { name: /^Bar chart, Sales per quarter\. In EUR\./u })

        await expect(bar).toBeVisible()
        await expect(bar).toHaveAttribute('aria-label', /2027: Q1 14, Q2 18, Q3 11, Q4 24\.$/u)
        await expect(
          bubble.getByRole('img', { name: /^Line chart, Visitors per week\. Organic: W1 120/u })
        ).toBeVisible()
        await expect(bubble.getByRole('img', { name: /^Pie chart, Where the time went\. In %\./u })).toBeVisible()

        // A chart is drawn at the width its box has, and a bar of every value is there.
        await expect(bubble.locator('rect.md-chart-bar')).toHaveCount(8)
        await expect(bubble.locator('.md-chart-pie .md-chart-slice, .md-chart-slice')).toHaveCount(3)

        // The callouts: named by their kind, the marker line is gone.
        const warning = bubble.getByRole('note', { name: 'Warning' })

        await expect(warning).toBeVisible()
        await expect(warning).toContainText('The database is not backed up yet.')
        await expect(warning).not.toContainText('[!WARNING]')
        await expect(bubble.getByRole('note', { name: 'Tip' })).toBeVisible()
        await expect(bubble.locator('blockquote')).toHaveCount(0)

        // The links: the arrow is after a web link, after nothing else, and is not in the name or the text.
        const web = bubble.getByRole('link', { name: 'k3s documentation', exact: true })
        const mail = bubble.getByRole('link', { name: 'info@example.org', exact: true })

        await expect(web).toHaveAttribute('href', 'https://docs.k3s.io/')
        await expect(web).toHaveAttribute('rel', /noopener/u)
        expect(await web.evaluate(link => getComputedStyle(link).textDecorationLine)).toBe('underline')
        expect(await web.evaluate(link => getComputedStyle(link).textDecorationStyle)).toBe('dotted')
        expect(await web.evaluate(link => getComputedStyle(link, '::after').content)).toContain('↗')
        expect(await mail.evaluate(link => getComputedStyle(link, '::after').content)).toMatch(/^(none|normal)$/u)
        expect(await web.textContent()).toBe('k3s documentation')

        // Nothing reached past its box, and nothing left the page because of the reply.
        expect(await overflowing(bubble)).toEqual([])
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
        expect([...origins]).toHaveLength(1)
        await expect(bubble.locator('img')).toHaveCount(0)

        expect(await seriousViolations(page, `rich-${scheme}-${size.width}`)).toEqual([])

        await matchesPictures(diagnostics, browserName, [
          [bubble.locator('.md-block[data-kind="cards"]').first(), `cards-${scheme}-${size.width}.png`],
          [bubble.locator('.md-block[data-kind="chart"]').first(), `chart-${scheme}-${size.width}.png`],
          [warning, `alert-${scheme}-${size.width}.png`]
        ])

        const shots = process.env.RICH_WEB_SHOTS

        if (shots) {
          mkdirSync(shots, { recursive: true })
          await bubble.screenshot({ path: join(shots, `reply-${scheme}-${size.name}-${browserName}.png`) })
        }

        // No header bar over a drawn block: its options are one "..." button in the corner, quiet until the pointer is
        // over the block or focus is in it.
        const box = bubble.locator('.md-block[data-kind="chart"]').first()
        const more = box.getByRole('button', { name: 'More options' })
        const opacity = (): Promise<string> => more.evaluate(button => getComputedStyle(button).opacity)

        await expect(bubble.locator('.md-code-bar')).toHaveCount(0)
        await expect(bubble.getByRole('button', { name: 'Copy code' })).toHaveCount(0)
        await page.mouse.move(0, 0)
        expect(await opacity()).toBe('0')
        await box.hover()
        expect(await opacity()).toBe('1')

        const corner = await Promise.all([box.boundingBox(), more.boundingBox()])

        expect((corner[1]?.x ?? 0) + (corner[1]?.width ?? 0)).toBeGreaterThan(
          (corner[0]?.x ?? 0) + (corner[0]?.width ?? 0) - 12
        )
        expect(corner[1]?.y ?? 0).toBeLessThan((corner[0]?.y ?? 0) + 12)

        // Keyboard: focus shows it, Enter opens the panel, Escape closes it and keeps focus on the button.
        await page.mouse.move(0, 0)
        await more.focus()
        expect(await opacity()).toBe('1')
        await page.keyboard.press('Enter')
        await expect(more).toHaveAttribute('aria-expanded', 'true')
        await expect(box.getByRole('button', { name: 'Copy source' })).toBeVisible()
        await page.keyboard.press('Escape')
        await expect(more).toHaveAttribute('aria-expanded', 'false')
        await expect(more).toBeFocused()

        // "Show source" puts the JSON where the chart was, and back.
        await more.click()
        await box.getByRole('button', { name: 'Show source' }).click()
        await expect(box.locator('pre')).toContainText('"type": "bar"')
        await expect(bar).toHaveCount(0)
        await more.click()
        await expect(box.getByRole('button', { name: 'Show source' })).toHaveAttribute('aria-pressed', 'true')
        await box.getByRole('button', { name: 'Show source' }).click()
        await expect(bar).toBeVisible()
      })
    })
  }
}

test.describe('a block that is not valid', () => {
  test.beforeEach(async ({ gateway }) => {
    await gateway.inject({
      user: 'Show me.',
      assistant: [
        'Here is a broken chart and some cards that are too few.',
        '',
        `${FENCE}hermie-chart`,
        '{"type": "bar", "x": ["a", "b"], "series": [{"name": "s", "values": [1]}]}',
        FENCE,
        '',
        `${FENCE}hermie-cards`,
        '{"cards": [{"title": "Alone"}]}',
        FENCE
      ].join('\n')
    })
  })

  test('stays the code it was written as, with its language', async ({ app, page }) => {
    await app.open()

    const bubble = app.transcript
      .locator('.hm-bubble[data-kind="assistant"]', { hasText: 'Here is a broken chart' })
      .last()

    await expect(bubble.locator('.md-code-lang', { hasText: 'hermie-chart' })).toBeVisible()
    await expect(bubble.locator('.md-code-lang', { hasText: 'hermie-cards' })).toBeVisible()
    await expect(bubble.locator('pre')).toHaveCount(2)
    await expect(bubble.locator('svg')).toHaveCount(0)
    expect(await seriousViolations(page, 'rich-invalid')).toEqual([])
  })
})
