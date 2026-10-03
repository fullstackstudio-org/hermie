/**
 * The transcript harness: `TranscriptList` on a long chat with a reply
 * streaming into it, driven and measured by `e2e/perf/transcript-stream.spec.ts`.
 *
 * Development only. It is its own page (`transcript-harness.html`), built only
 * by `vite build --mode harness` into `dist-harness/`, and stamps its document
 * with a marker the bundle gate refuses, so none of it can reach the client.
 *
 * What it feeds the list, all through the engine (`@hermie/transcript`):
 *
 *  - a synthetic history (`synthetic-chat.ts`) of persisted rows, projected by
 *    `rowsToItems` and hydrated with `reconcile`;
 *  - a live conversation on top of it, `applyEvent` at a fixed rate of
 *    deltas per second, whose text is the recorded scenarios' own deltas;
 *  - the recorded scenarios themselves (`contract/transcript/streams/*.json`),
 *    replayed step by step at the end of the long chat, with the list's rows
 *    compared against every checkpoint the recording holds.
 *
 * Events change the engine state at once; the list is committed at most once
 * per animation frame, the way the client's ingest path does it (plan W8).
 * Everything is reached through `globalThis.hermieTranscriptHarness`.
 */
import {
  type ChatState,
  createChatState,
  prependHistory,
  snapshotForCache,
  stateFromCache,
  visibleItems,
  type VisibleItem,
  type VisibilityOptions
} from '@hermie/transcript'
import { StrictMode, useCallback, useSyncExternalStore } from 'react'
import { createRoot } from 'react-dom/client'

import { TranscriptList } from '../features/chat/TranscriptList'
import { chatCacheFor } from '../platform/chat-cache'
import {
  afterNextPaint,
  type DriftReport,
  type FrameReport,
  type PinReport,
  startDriftProbe,
  startFrameMeter,
  startLongTaskObserver,
  startPinProbe
} from './probes'
import { replay, type StreamScenario } from './stream-replay'
import { deltaTexts, LiveConversation, SYNTHETIC_BOT, syntheticChat, syntheticItems } from './synthetic-chat'
import '../ui/base.css'
import './transcript-harness.css'

/** The bundle gate refuses any file holding this (`scripts/web/check-bundle.mjs`). */
const DEVELOPMENT_ONLY_MARKER = 'hermie:development-only'

const OPTIONS: VisibilityOptions = { level: 'normal', showBotToBot: true, showThinking: true }
const CACHE_NAMESPACE = 'transcript-harness'

const scenarioModules = import.meta.glob<StreamScenario>('../../../../contract/transcript/streams/*.json', {
  import: 'default'
})

async function loadScenarios(): Promise<StreamScenario[]> {
  const names = Object.keys(scenarioModules).sort()
  return Promise.all(names.map(name => (scenarioModules[name] as () => Promise<StreamScenario>)()))
}

/** The engine state, and the rows last committed to the list. */
class Feed {
  state: ChatState = createChatState(SYNTHETIC_BOT, 'stored-synthetic', 'stored-synthetic')
  /** Bumped to mount a fresh list (opening another chat). */
  chat = 0
  private rows: readonly VisibleItem[] = []
  private committed: ChatState | null = null
  private frame = 0
  private readonly listeners = new Set<() => void>()

  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  snapshot = () => this.rows

  /** Applies engine work now and commits it with the next frame. */
  apply(change: (state: ChatState) => ChatState): void {
    this.state = change(this.state)
    if (!this.frame) {
      this.frame = requestAnimationFrame(() => {
        this.frame = 0
        this.commit()
      })
    }
  }

  /** Commits now: a chat being opened, or a test step that must be on screen. */
  commit(): void {
    if (this.committed !== this.state) {
      this.committed = this.state
      this.rows = visibleItems(this.state, OPTIONS)
      this.listeners.forEach(listener => listener())
    }
  }

  open(state: ChatState): void {
    this.state = state
    this.chat += 1
    this.commit()
  }
}

const feed = new Feed()
const renders = new Map<string, number>()
const listEvents = { stuck: true, reachTop: 0 }

function PlaceholderItem({ row }: { row: VisibleItem }) {
  const item = row.item

  if (row.presentation === 'hidden-placeholder') {
    return null
  }

  switch (item.kind) {
    case 'user':
      return <p className="placeholder-item placeholder-item--user">{item.text}</p>
    case 'assistant':
      return (
        <div className="placeholder-item placeholder-item--assistant">
          {item.reasoning ? <p className="placeholder-item__thought">{item.reasoning}</p> : null}
          <p>{item.text}</p>
        </div>
      )
    case 'tool':
      return <p className="placeholder-item placeholder-item--chip">{item.summary ?? item.context ?? item.name}</p>
    default:
      return <p className="placeholder-item placeholder-item--chip">{item.kind}</p>
  }
}

function renderItem(row: VisibleItem) {
  renders.set(row.item.id, (renders.get(row.item.id) ?? 0) + 1)
  return <PlaceholderItem row={row} />
}

function Harness() {
  const rows = useSyncExternalStore(feed.subscribe, feed.snapshot)
  const chat = useSyncExternalStore(feed.subscribe, () => feed.chat)
  const onStickChange = useCallback((stuck: boolean) => {
    listEvents.stuck = stuck
  }, [])
  const onReachTop = useCallback(() => {
    listEvents.reachTop += 1
  }, [])

  return (
    <main className="harness">
      <TranscriptList
        key={chat}
        rows={rows}
        renderItem={renderItem}
        onStickChange={onStickChange}
        onReachTop={onReachTop}
        label="Transcript"
      />
    </main>
  )
}

function scroller(): HTMLElement {
  const element = document.querySelector<HTMLElement>('.transcript-list')
  if (!element) {
    throw new Error('no transcript list on the page')
  }
  return element
}

function renderedKeys(): string[] {
  return [...scroller().querySelectorAll<HTMLElement>('[data-row-key]')].map(row => row.dataset.rowKey ?? '')
}

const unplaced = (id: string) => id.replace(/^([a-z]):\d+$/, '$1:#')

/** Lowest persisted row id in the chat, so a page of older history can go in front of it. */
function lowestRowId(state: ChatState): number {
  let lowest = 0
  for (const id of state.order) {
    const rowId = state.items[id]?.rowId
    if (rowId !== undefined && rowId < lowest) {
      lowest = rowId
    }
  }
  return lowest
}

let streaming: { stop(): void } | null = null
let probes: {
  frames?: ReturnType<typeof startFrameMeter>
  drift?: ReturnType<typeof startDriftProbe>
  pin?: ReturnType<typeof startPinProbe>
  longTasks?: ReturnType<typeof startLongTaskObserver>
} = {}

const api = {
  /** Opens a synthetic chat of about `items` items; resolves when it is painted. */
  async load(items: number): Promise<{ rows: number; paintMs: number }> {
    const started = performance.now()
    feed.open(syntheticChat(items))
    const painted = await afterNextPaint()
    return { rows: renderedKeys().length, paintMs: painted - started }
  },

  /**
   * Streams a live conversation at `rate` engine events per second for
   * `seconds`; resolves when done. Events that fall due while the page is busy
   * are applied together, as a socket would deliver them.
   */
  async stream({ rate = 30, seconds = 60, deltasPerTurn = 300 } = {}): Promise<{ events: number; deltas: number }> {
    const scenarios = await loadScenarios()
    const live = new LiveConversation(deltaTexts(scenarios), deltasPerTurn, feed.state)
    const started = performance.now()
    const total = Math.round(rate * seconds)
    let applied = 0

    return new Promise(resolve => {
      const timer = setInterval(() => {
        const due = Math.min(total, Math.floor(((performance.now() - started) * rate) / 1000))
        if (applied < due) {
          feed.apply(state => {
            let next = state
            for (; applied < due; applied += 1) {
              next = live.step(next, Date.now())
            }
            return next
          })
        }
        if (applied >= total) {
          finish()
        }
      }, 1000 / rate)
      const finish = () => {
        clearInterval(timer)
        streaming = null
        resolve({ events: applied, deltas: live.deltas })
      }
      streaming = { stop: finish }
    })
  },

  stopStreaming(): void {
    streaming?.stop()
  },

  /** Puts a page of `count` older rows in front of the chat, through the engine (`prependHistory`). */
  async prependOlder(count: number): Promise<{ rows: number }> {
    const older = syntheticItems(count, 2, lowestRowId(feed.state) - count * 3)
    feed.apply(chat => prependHistory(chat, older))
    await afterNextPaint()
    return { rows: renderedKeys().length }
  },

  /** Scrolls the reader to a fraction of the way down, as a wheel would. */
  async scrollTo(fraction: number): Promise<void> {
    const element = scroller()
    element.scrollTop = (element.scrollHeight - element.clientHeight) * fraction
    await afterNextPaint()
    await afterNextPaint()
  },

  /** The row at a third of the way down the viewport: what a reader in the middle is looking at. */
  readingRow(): string {
    const box = scroller().getBoundingClientRect()
    const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 3)
    const row = hit?.closest<HTMLElement>('[data-row-key]')
    if (!row?.dataset.rowKey) {
      throw new Error('no row in the middle of the viewport')
    }
    return row.dataset.rowKey
  },

  startFrames(): void {
    probes.frames = startFrameMeter()
  },
  stopFrames(): FrameReport | null {
    return probes.frames?.stop() ?? null
  },
  startDrift(key: string): void {
    probes.drift = startDriftProbe(scroller(), key)
  },
  stopDrift(): DriftReport | null {
    return probes.drift?.stop() ?? null
  },
  startPin(): void {
    probes.pin = startPinProbe(scroller())
  },
  stopPin(): PinReport | null {
    return probes.pin?.stop() ?? null
  },
  startLongTasks(): boolean {
    probes.longTasks = startLongTaskObserver()
    return probes.longTasks.supported
  },
  stopLongTasks(): number[] {
    const durations = probes.longTasks?.stop() ?? []
    probes = { ...probes, longTasks: undefined }
    return durations
  },

  resetRenders(): string[] {
    renders.clear()
    return renderedKeys()
  },
  /** How often each of `keys` was drawn since `resetRenders`. */
  rendersOf(keys: string[]): number {
    return keys.reduce((sum, key) => sum + (renders.get(key) ?? 0), 0)
  },

  list(): { rows: number; stuck: boolean; reachTop: number; scrollTop: number; gap: number } {
    const element = scroller()
    return {
      rows: renderedKeys().length,
      stuck: listEvents.stuck,
      reachTop: listEvents.reachTop,
      scrollTop: element.scrollTop,
      gap: element.scrollHeight - element.clientHeight - element.scrollTop
    }
  },

  /** Writes a `items`-item chat to the transcript cache, as the chat controller would. */
  async prepareCache(items = 200): Promise<number> {
    const snapshot = snapshotForCache(syntheticChat(items), Date.now())
    await chatCacheFor(CACHE_NAMESPACE).write({
      bot: SYNTHETIC_BOT,
      itemsJson: JSON.stringify(snapshot),
      lastRowId: snapshot.lastRowId ?? null,
      lastSeq: snapshot.lastSeq,
      epoch: snapshot.epoch ?? null,
      updatedAt: snapshot.updatedAt
    })
    return snapshot.items.length
  },

  /**
   * Opens the cached chat: read from IndexedDB, rebuilt by the engine, drawn.
   * Resolves with the milliseconds from the open to the first painted frame.
   */
  async openCached(): Promise<{ rows: number; ms: number }> {
    feed.open(createChatState(SYNTHETIC_BOT, 'stored-synthetic', 'stored-synthetic'))
    await afterNextPaint()
    const started = performance.now()
    const row = await chatCacheFor(CACHE_NAMESPACE).read(SYNTHETIC_BOT)
    if (!row) {
      throw new Error('nothing cached: call prepareCache first')
    }
    feed.open(
      stateFromCache(
        SYNTHETIC_BOT,
        { storedSessionId: 'stored-synthetic', resolvedSessionId: 'stored-synthetic' },
        JSON.parse(row.itemsJson)
      )
    )
    const painted = await afterNextPaint()
    return { rows: renderedKeys().length, ms: painted - started }
  },

  /**
   * Replays every recorded scenario at the end of a chat of `historyItems`,
   * and compares the rows on the page with each checkpoint's.
   */
  async checkScenarios(historyItems = 5_000): Promise<{ scenario: string; label: string; problem: string | null }[]> {
    const scenarios = await loadScenarios()
    const history = syntheticItems(historyItems)
    const results: { scenario: string; label: string; problem: string | null }[] = []

    for (const scenario of scenarios) {
      const checkpoints = new Map(scenario.checkpoints.map(checkpoint => [checkpoint.after, checkpoint]))
      let step = 0
      for (const state of replay(scenario, { history })) {
        step += 1
        if (step === 1) {
          feed.open(state)
        } else {
          feed.apply(() => state)
        }
        const checkpoint = checkpoints.get(step)
        if (!checkpoint) {
          continue
        }
        feed.commit()
        await afterNextPaint()
        const keys = renderedKeys()
        const expected = (checkpoint.visible.normal ?? []).map(row => unplaced(row.item.id))
        const actual = keys.slice(keys.length - expected.length).map(unplaced)
        const historyShown = keys.length - expected.length
        const problem =
          historyShown !== history.length
            ? `${historyShown} history rows, expected ${history.length}`
            : actual.join(',') !== expected.join(',')
              ? `rows ${actual.join(',')}, expected ${expected.join(',')}`
              : null
        results.push({ scenario: scenario.scenario, label: checkpoint.label, problem })
      }
    }
    return results
  }
}

export type TranscriptHarness = typeof api

declare global {
  var hermieTranscriptHarness: TranscriptHarness | undefined
}

document.body.dataset.build = DEVELOPMENT_ONLY_MARKER
globalThis.hermieTranscriptHarness = api

const root = document.getElementById('root')
if (root) {
  createRoot(root).render(
    <StrictMode>
      <Harness />
    </StrictMode>
  )
}
