/**
 * The one road into the chat store: everything that changes a transcript is
 * applied in the order the wire delivered it, and the store is told once per
 * frame.
 *
 * The Expo app applied every event to its store the moment it arrived: one
 * reducer call, one `set`, one round of every subscriber, thirty times a second
 * while a reply streamed. A browser tab that does that re-renders the transcript
 * per token. Here an event is queued, the queue is drained into the engine when
 * the next frame is due, and the result is committed to the store in ONE
 * `setState`. A screen subscribed to the store sees one change per frame
 * however many tokens the frame carried.
 *
 * The rules, as built:
 *
 *  1. **Arrival order is the only order.** Gateway events go to the back of
 *     one queue as the socket delivers them (`push`). Server requests join the
 *     same queue (`now`); because the channel needs its yes or no while the
 *     request is still in hand, the queue is drained through the request at
 *     once rather than at the next frame, with every event that arrived before
 *     it applied first.
 *  2. **The controller reads its own writes, and they are in wire order too.**
 *     The store's actions are routed through this ingest (`ChatsStore.route`),
 *     and the controller is handed `chats`, a view of the store that reads the
 *     working copy. Every read or write through it first drains whatever is
 *     queued: an RPC result the controller applies after an `await` lands
 *     behind every event that arrived before the answer, which is the order the
 *     wire carried them in, and a check the controller makes ("is a turn
 *     running?") sees every event that has arrived. This is what keeps the
 *     ported controller's behaviour unchanged: it still reads, straight after a
 *     write, exactly what the Expo store would have handed it.
 *  3. **One commit per frame.** Applying is not committing. However often the
 *     queue is drained, the working copy reaches the store in one `setState`
 *     per animation frame, and only when something changed.
 *  4. **A hidden page drains on a timer.** `requestAnimationFrame` does not run
 *     in a hidden tab, and a reply that keeps streaming into a hidden tab must
 *     not pile up until the reader comes back. While the page is hidden
 *     (`platform/visibility.ts`) the frame is a `HIDDEN_DRAIN_MS` (100 ms)
 *     timer instead; a frame requested just before the page hid is re-armed as
 *     that timer, and one requested while hidden goes back to a frame when the
 *     page is shown.
 *  5. **A drain never spans an `await`.** Draining is a synchronous loop over
 *     the queue. A handler that starts asynchronous work (a cache write, a tail
 *     reconcile) starts it and returns; what that work writes later joins the
 *     queue as an RPC result (rule 2). An arrival pushed while a drain runs is
 *     taken by the same drain.
 *  6. **A handler that throws costs that arrival, never the queue.** The rest
 *     of the queue still drains and the error is reported (`onError`, rethrown
 *     on a fresh task by default, so it reaches the console and a test run).
 *
 * New in the web client (the Expo app had no counterpart): the controller
 * that owns it is `core/chat-controller.ts`.
 */
import type { ChatsData, ChatsState, ChatsStore, ChatsWrite, ChatsWritePort } from '../state/chats'
import { chatsDataOf } from '../state/chats'
import type { VisibilityWatcher } from '../platform/visibility'
import { visibilityWatcher } from '../platform/visibility'
import type { StoreApi } from 'zustand/vanilla'

/** How often a hidden page drains (rule 4). */
export const HIDDEN_DRAIN_MS = 100

/** The page's animation frames, as the ingest asks for them; a test hands in its own. */
export interface FrameSource {
  request(callback: () => void): unknown
  cancel(handle: unknown): void
}

/**
 * `requestAnimationFrame`, looked up when called. Where there is none (a test
 * in Node) a 16 ms timer stands in for it.
 */
export const animationFrames: FrameSource = {
  request(callback) {
    const raf = globalThis.requestAnimationFrame

    return typeof raf === 'function'
      ? { frame: raf.call(globalThis, () => callback()) }
      : { timer: setTimeout(callback, 16) }
  },
  cancel(handle) {
    const { frame, timer } = handle as { frame?: number; timer?: ReturnType<typeof setTimeout> }

    if (frame !== undefined) {
      globalThis.cancelAnimationFrame?.(frame)
    }

    if (timer !== undefined) {
      clearTimeout(timer)
    }
  }
}

/**
 * Frames that come at once: every write is committed as soon as it is applied,
 * which is what the Expo store did. For the ported controller tests, whose
 * assertions read the store straight after an action.
 */
export const immediateFrames: FrameSource = {
  request(callback) {
    callback()

    return undefined
  },
  cancel() {}
}

export interface IngestOptions {
  /** The store this ingest routes and commits to. */
  store: ChatsStore
  /** The page's visibility; the page's own unless told otherwise. */
  visibility?: VisibilityWatcher
  /** Frames while visible; `animationFrames` unless told otherwise. */
  frames?: FrameSource
  /** Rule 4's interval; `HIDDEN_DRAIN_MS` unless told otherwise. */
  hiddenDrainMs?: number
  /** Rule 6: where a handler's error goes. Rethrown on a fresh task unless told otherwise. */
  onError?: (error: unknown) => void
}

export interface Ingest {
  /**
   * The chat store as the controller sees it: `getState()` drains the queue
   * and answers the working copy, ahead of the commit (rule 2). Pass this to
   * `ChatController` rather than the store.
   */
  readonly chats: StoreApi<ChatsState>
  /** Queue one arrival (a gateway event's handler). It runs at the next drain. */
  push(arrival: () => void): void
  /**
   * Queue one arrival that needs its answer now (a server request's handler):
   * everything queued before it is applied, then it runs, and its result is
   * returned (rule 1).
   */
  now<T>(arrival: () => T): T
  /** Apply everything queued, in order, without committing. */
  drain(): void
  /** Apply everything queued and commit now: for a page about to hide or unload, and for tests. */
  flush(): void
  /** Arrivals waiting for the next drain. */
  readonly pending: number
  /** Whether the working copy holds something the store has not been told yet. */
  readonly dirty: boolean
  /** Commits so far: one `setState` each. */
  readonly commits: number
  /** Whether `dispose` has run: writes then go straight to the store. */
  readonly disposed: boolean
  /** Flush, stop following the page's visibility, and hand the store's actions back to it. */
  dispose(): void
}

type Scheduled = { kind: 'frame'; handle: unknown } | { kind: 'timer'; handle: ReturnType<typeof setTimeout> }

export function createIngest(options: IngestOptions): Ingest {
  const store = options.store
  const visibility = options.visibility ?? visibilityWatcher
  const frames = options.frames ?? animationFrames
  const hiddenDrainMs = options.hiddenDrainMs ?? HIDDEN_DRAIN_MS
  const onError =
    options.onError ??
    ((error: unknown) => {
      setTimeout(() => {
        throw error
      }, 0)
    })

  const queue: (() => void)[] = []
  /** The state ahead of the store: `null` when the store is up to date. */
  let working: ChatsState | null = null
  let draining = false
  let scheduled: Scheduled | null = null
  let commits = 0
  let disposed = false

  const current = (): ChatsState => working ?? store.getState()

  /** Rule 5: synchronous, and re-entrant only in that a nested call is a no-op. */
  const drain = (): void => {
    if (draining) {
      return
    }

    draining = true

    try {
      while (queue.length) {
        const arrival = queue.shift() as () => void

        try {
          arrival()
        } catch (error) {
          onError(error)
        }
      }
    } finally {
      draining = false
    }
  }

  const commit = (): void => {
    if (!working) {
      return
    }

    const next = chatsDataOf(working)
    const committed = store.getState()

    working = null

    if (
      next.chats === committed.chats &&
      next.queues === committed.queues &&
      next.runtimeToBot === committed.runtimeToBot &&
      next.live === committed.live
    ) {
      return
    }

    commits += 1
    store.setState(next)
  }

  const cancelScheduled = (): void => {
    if (!scheduled) {
      return
    }

    if (scheduled.kind === 'frame') {
      frames.cancel(scheduled.handle)
    } else {
      clearTimeout(scheduled.handle)
    }

    scheduled = null
  }

  const onFrame = (): void => {
    scheduled = null
    drain()
    commit()
  }

  /** Ask for the next frame (or the hidden timer), once. */
  const schedule = (): void => {
    if (scheduled || disposed) {
      return
    }

    if (visibility.current() === 'hidden') {
      scheduled = { kind: 'timer', handle: setTimeout(onFrame, hiddenDrainMs) }

      return
    }

    // Recorded before the request: a frame source that answers at once runs
    // `onFrame`, which clears it again.
    const pending: Scheduled = { kind: 'frame', handle: undefined }

    scheduled = pending
    const handle = frames.request(onFrame)

    if (scheduled === pending) {
      pending.handle = handle
    }
  }

  // Rule 4: a frame asked for while visible never comes once the page hides,
  // and a timer asked for while hidden is slower than the frame that is now due.
  const stopVisibility = visibility.subscribe(next => {
    if (!scheduled) {
      return
    }

    if ((next === 'hidden') === (scheduled.kind === 'timer')) {
      return
    }

    cancelScheduled()
    schedule()
  })

  const write = (change: ChatsWrite): void => {
    if (!draining) {
      drain()
    }

    const base = current()
    const patch = typeof change === 'function' ? change(base) : change

    if (patch === base) {
      return
    }

    if (disposed) {
      // A late answer to a controller that has been stopped: nothing commits
      // for it any more, so it goes to the store as the Expo store took it.
      store.setState(patch as Partial<ChatsData>)

      return
    }

    working = { ...base, ...(patch as Partial<ChatsData>) }
    schedule()
  }

  const read = (): ChatsState => {
    if (!draining) {
      drain()
    }

    return current()
  }

  const port: ChatsWritePort = { get: read, set: write }

  store.route(port)

  const chats: StoreApi<ChatsState> = {
    getState: read,
    getInitialState: () => store.getInitialState(),
    setState: (partial, replace) => {
      if (replace) {
        throw new Error('The ingest does not replace the chat store; write through its actions.')
      }

      write(partial as ChatsWrite)
    },
    subscribe: listener => store.subscribe(listener)
  }

  return {
    chats,
    push(arrival) {
      queue.push(arrival)
      schedule()
    },
    now<T>(arrival: () => T): T {
      if (draining) {
        return arrival()
      }

      drain()
      draining = true

      try {
        return arrival()
      } finally {
        draining = false

        if (queue.length) {
          schedule()
        }
      }
    },
    drain,
    flush() {
      // Drained first: applying can ask for a frame, which this commit makes moot.
      drain()
      cancelScheduled()
      commit()
    },
    get pending() {
      return queue.length
    },
    get dirty() {
      return working !== null
    },
    get commits() {
      return commits
    },
    get disposed() {
      return disposed
    },
    dispose() {
      if (disposed) {
        return
      }

      // Drained first: applying can ask for a frame, which this commit makes moot.
      drain()
      cancelScheduled()
      commit()
      disposed = true
      stopVisibility()

      if (store.routedTo === port) {
        store.route(null)
      }
    }
  }
}
