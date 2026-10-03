/**
 * The transcript list against its budgets (plan W-8, "Test Strategy").
 *
 * On the development-only harness (`src/dev/transcript-harness.tsx`): a
 * 5,000-item chat built by the engine, and a reply streaming into it at 30
 * deltas per second.
 *
 *  - **Chromium, 4x CPU throttling, 60 s of streaming**: no main-thread task
 *    over 50 ms, under 1 % of frames dropped, no row other than the live ones
 *    drawn again, pinned to the bottom for the first third, then reading in the
 *    middle of the chat with no movement at all while the reply grows below and
 *    a page of older history lands above.
 *  - **Every engine** (Chromium, WebKit, Firefox): the same pin and drift
 *    checks unthrottled and shorter, older history asked for at the top, a
 *    cached 200-row chat painted within 300 ms of being opened, and the
 *    recorded stream scenarios drawn exactly as their checkpoints say.
 *
 * `TRANSCRIPT_PERF_SECONDS` shortens the throttled run while working on it;
 * the budgets are only meaningful at the default 60.
 */
import { expect, type Page, test } from '@playwright/test'

import type { TranscriptHarness } from '../../src/dev/transcript-harness'
import { formatReport, mainThreadTasks, startMainThreadTrace, throttleCpu } from './trace-utils'

const HARNESS = '/src/dev/transcript-harness.html'
const SECONDS = Number(process.env.TRANSCRIPT_PERF_SECONDS ?? 60)
const HISTORY = 5_000
const RATE = 30

const BUDGET = {
  longTaskMs: 50,
  longTasks: 0,
  droppedPercent: 1,
  /** "0 px": nothing a screen can show. Half a CSS pixel is the list's own rounding slop. */
  driftPx: 0.5,
  pinGapPx: 0.5,
  cachedOpenMs: 300
}

declare global {
  var hermieTranscriptHarness: TranscriptHarness | undefined
}

async function openHarness(page: Page): Promise<void> {
  await page.goto(HARNESS)
  await page.waitForFunction(() => Boolean(globalThis.hermieTranscriptHarness))
}

test.describe('transcript list', () => {
  test('streams for a minute on a 5,000-item chat at 4x CPU throttling within budget', async ({
    page,
    browser,
    browserName
  }, testInfo) => {
    test.skip(browserName !== 'chromium', 'CPU throttling and main-thread traces are Chromium-only')
    test.setTimeout((SECONDS + 180) * 1000)

    await openHarness(page)
    const loaded = await page.evaluate(items => globalThis.hermieTranscriptHarness!.load(items), HISTORY)
    expect(loaded.rows).toBeGreaterThanOrEqual(HISTORY)
    const historyKeys = await page.evaluate(() => globalThis.hermieTranscriptHarness!.resetRenders())

    const unthrottle = await throttleCpu(page, 4)
    await startMainThreadTrace(browser, page)
    await page.evaluate(() => {
      const h = globalThis.hermieTranscriptHarness!
      h.startFrames()
      h.startLongTasks()
      h.startPin()
    })

    const streamed = page.evaluate(
      seconds => globalThis.hermieTranscriptHarness!.stream({ rate: 30, seconds }),
      SECONDS
    )

    // First third: at the bottom, following the reply.
    await page.waitForTimeout((SECONDS * 1000) / 3)
    const pin = await page.evaluate(() => globalThis.hermieTranscriptHarness!.stopPin())
    const stuckWhilePinned = (await page.evaluate(() => globalThis.hermieTranscriptHarness!.list())).stuck

    // Then the reader scrolls up into the middle of the chat and reads.
    await page.evaluate(() => globalThis.hermieTranscriptHarness!.scrollTo(0.5))
    const reading = await page.evaluate(() => globalThis.hermieTranscriptHarness!.readingRow())
    await page.evaluate(key => globalThis.hermieTranscriptHarness!.startDrift(key), reading)
    await page.waitForTimeout((SECONDS * 1000) / 6)
    const prepended = await page.evaluate(() => globalThis.hermieTranscriptHarness!.prependOlder(200))

    const done = await streamed
    const drift = await page.evaluate(() => globalThis.hermieTranscriptHarness!.stopDrift())
    const frames = await page.evaluate(() => globalThis.hermieTranscriptHarness!.stopFrames())
    const pageLongTasks = await page.evaluate(() => globalThis.hermieTranscriptHarness!.stopLongTasks())
    const trace = await browser.stopTracing()
    await unthrottle()

    const list = await page.evaluate(() => globalThis.hermieTranscriptHarness!.list())
    const historyRenders = await page.evaluate(keys => globalThis.hermieTranscriptHarness!.rendersOf(keys), historyKeys)
    const tasks = mainThreadTasks(trace, BUDGET.longTaskMs)

    const report = {
      history: loaded.rows,
      firstPaintOf5000Ms: loaded.paintMs,
      events: done.events,
      deltas: done.deltas,
      seconds: frames?.seconds,
      frames: frames?.frames,
      droppedFrames: frames?.dropped,
      droppedPercent: frames?.droppedPercent,
      frameIntervalMs: frames?.interval,
      longestFrameMs: frames?.longestFrame,
      hitchMsPerSecond: frames?.hitchMsPerSecond,
      mainThreadTasks: tasks.tasks,
      longTasksOver50Ms: tasks.long,
      longestTaskMs: tasks.longestMs,
      mainThreadBusyPercent: tasks.seconds ? (100 * tasks.busyMs) / (tasks.seconds * 1000) : 0,
      pageLongTasks,
      pinMaxGapPx: pin?.maxGap,
      driftMaxPx: drift?.maxDrift,
      driftSamples: drift?.samples,
      rowsAfterPrepend: prepended.rows,
      historyRowsDrawnAgain: historyRenders
    }
    console.log(formatReport(`transcript stream, ${browserName}, 4x CPU, ${SECONDS} s`, report))
    await testInfo.attach('transcript-stream.json', {
      body: JSON.stringify(report, null, 2),
      contentType: 'application/json'
    })

    expect(done.deltas).toBeGreaterThan(RATE * SECONDS * 0.9)
    expect(stuckWhilePinned).toBe(true)
    expect(pin?.maxGap).toBeLessThanOrEqual(BUDGET.pinGapPx)
    expect(list.stuck).toBe(false)
    expect(drift?.maxDrift).toBeLessThanOrEqual(BUDGET.driftPx)
    expect(prepended.rows).toBeGreaterThan(loaded.rows)
    expect(historyRenders).toBe(0)
    expect(tasks.tasks).toBeGreaterThan(0)
    expect(tasks.long).toHaveLength(BUDGET.longTasks)
    expect(frames?.droppedPercent).toBeLessThan(BUDGET.droppedPercent)
  })

  test('follows the bottom, holds the reader mid-list and across a prepend, and asks for older rows', async ({
    page,
    browserName
  }, testInfo) => {
    test.setTimeout(120_000)
    await openHarness(page)
    await page.evaluate(items => globalThis.hermieTranscriptHarness!.load(items), HISTORY)

    await page.evaluate(() => globalThis.hermieTranscriptHarness!.startPin())
    await page.evaluate(() => globalThis.hermieTranscriptHarness!.stream({ rate: 30, seconds: 8, deltasPerTurn: 80 }))
    const pin = await page.evaluate(() => globalThis.hermieTranscriptHarness!.stopPin())
    const pinned = await page.evaluate(() => globalThis.hermieTranscriptHarness!.list())

    await page.evaluate(() => globalThis.hermieTranscriptHarness!.scrollTo(0.5))
    const reading = await page.evaluate(() => globalThis.hermieTranscriptHarness!.readingRow())
    await page.evaluate(key => globalThis.hermieTranscriptHarness!.startDrift(key), reading)
    const streamed = page.evaluate(() =>
      globalThis.hermieTranscriptHarness!.stream({ rate: 30, seconds: 8, deltasPerTurn: 80 })
    )
    await page.waitForTimeout(3_000)
    const before = (await page.evaluate(() => globalThis.hermieTranscriptHarness!.list())).rows
    const prepended = await page.evaluate(() => globalThis.hermieTranscriptHarness!.prependOlder(200))
    await streamed
    const drift = await page.evaluate(() => globalThis.hermieTranscriptHarness!.stopDrift())
    const away = await page.evaluate(() => globalThis.hermieTranscriptHarness!.list())

    await page.evaluate(() => globalThis.hermieTranscriptHarness!.scrollTo(0))
    const top = await page.evaluate(() => globalThis.hermieTranscriptHarness!.list())
    await page.evaluate(() => globalThis.hermieTranscriptHarness!.scrollTo(1))
    const back = await page.evaluate(() => globalThis.hermieTranscriptHarness!.list())

    const report = {
      pinSamples: pin?.samples,
      pinMaxGapPx: pin?.maxGap,
      driftSamples: drift?.samples,
      driftMaxPx: drift?.maxDrift,
      prependedRows: prepended.rows - before,
      reachTopCalls: top.reachTop
    }
    console.log(formatReport(`transcript anchoring, ${browserName}`, report))
    await testInfo.attach('transcript-anchoring.json', {
      body: JSON.stringify(report, null, 2),
      contentType: 'application/json'
    })

    expect(pinned.stuck).toBe(true)
    expect(pin?.samples).toBeGreaterThan(60)
    expect(pin?.maxGap).toBeLessThanOrEqual(BUDGET.pinGapPx)
    expect(away.stuck).toBe(false)
    expect(prepended.rows - before).toBeGreaterThanOrEqual(200)
    // One sample per change the list handled: the prepend at least, and every new turn below.
    expect(drift?.samples).toBeGreaterThan(0)
    expect(drift?.maxDrift).toBeLessThanOrEqual(BUDGET.driftPx)
    expect(top.reachTop).toBeGreaterThanOrEqual(1)
    expect(back.stuck).toBe(true)
  })

  test('paints a cached 200-row chat within 300 ms of opening it', async ({ page, browserName }, testInfo) => {
    await openHarness(page)
    const cached = await page.evaluate(items => globalThis.hermieTranscriptHarness!.prepareCache(items), 200)
    // The first open warms the code paths a running client has warm already.
    await page.evaluate(() => globalThis.hermieTranscriptHarness!.openCached())
    const opens: number[] = []
    for (let run = 0; run < 5; run += 1) {
      opens.push((await page.evaluate(() => globalThis.hermieTranscriptHarness!.openCached())).ms)
    }
    const rows = (await page.evaluate(() => globalThis.hermieTranscriptHarness!.list())).rows
    const sorted = [...opens].sort((a, b) => a - b)

    const report = { cachedItems: cached, rows, openMs: opens, medianMs: sorted[2], worstMs: sorted[4] }
    console.log(formatReport(`cached chat open, ${browserName}`, report))
    await testInfo.attach('cached-open.json', {
      body: JSON.stringify(report, null, 2),
      contentType: 'application/json'
    })

    expect(cached).toBe(200)
    expect(rows).toBe(200)
    expect(sorted[4]).toBeLessThanOrEqual(BUDGET.cachedOpenMs)
  })

  test('draws every recorded stream scenario as its checkpoints say, at the end of a long chat', async ({ page }) => {
    test.setTimeout(120_000)
    await openHarness(page)
    const results = await page.evaluate(items => globalThis.hermieTranscriptHarness!.checkScenarios(items), HISTORY)

    expect(results.length).toBeGreaterThanOrEqual(12)
    expect(results.filter(result => result.problem)).toEqual([])
  })
})
