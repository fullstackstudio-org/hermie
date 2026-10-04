/**
 * Holds a chunk of the request layer once it has loaded (the request sheets, `request-sheets.ts`; the sheets that reach for
 * the device, `device-sheets-loader.ts`).
 *
 * `React.lazy` would suspend on the first render of each sheet even when the chunk is already in memory, and a question
 * that stops a bot must be on screen the moment it arrives. So the chunk is held here once it has loaded, and a component
 * that reads it through `use` renders the sheet in the same pass from then on. A fetch that fails (offline, a deploy that
 * replaced the chunk) is forgotten, and a layer that has something to show asks again every few seconds.
 */
import { useEffect, useState, useSyncExternalStore } from 'react'

/** How long a layer waits before asking again for a chunk that did not arrive. */
export const CHUNK_RETRY_MS = 3_000

export interface ChunkHolder<T> {
  /** Fetch the chunk with `load`, once; resolves at once when it is in memory. */
  preload(load: () => Promise<T>): Promise<T>
  /**
   * The chunk, or undefined while it is not in memory. `wanted` is whether the caller has something to draw with it: only
   * then is a missing chunk fetched (with `load`, when there is one), and fetched again after a failure.
   */
  use(load: (() => Promise<T>) | undefined, wanted: boolean): T | undefined
}

export function createChunkHolder<T>(): ChunkHolder<T> {
  let loaded: T | undefined
  let pending: Promise<T> | undefined
  const listeners = new Set<() => void>()

  const subscribe = (listener: () => void): (() => void) => {
    listeners.add(listener)

    return () => listeners.delete(listener)
  }
  const snapshot = (): T | undefined => loaded

  const preload = (load: () => Promise<T>): Promise<T> => {
    if (loaded) {
      return Promise.resolve(loaded)
    }

    pending ??= load().then(
      module => {
        loaded = module
        pending = undefined

        for (const listener of listeners) {
          listener()
        }

        return module
      },
      (error: unknown) => {
        pending = undefined
        throw error
      }
    )

    return pending
  }

  const use = (load: (() => Promise<T>) | undefined, wanted: boolean): T | undefined => {
    const held = useSyncExternalStore(subscribe, snapshot, snapshot)
    const [attempt, setAttempt] = useState(0)

    useEffect(() => {
      if (!wanted || held || !load) {
        return
      }

      let timer: ReturnType<typeof setTimeout> | undefined
      let live = true

      preload(load).catch(() => {
        if (live) {
          timer = setTimeout(() => setAttempt(count => count + 1), CHUNK_RETRY_MS)
        }
      })

      return () => {
        live = false
        clearTimeout(timer)
      }
    }, [wanted, held, load, attempt])

    return held
  }

  return { preload, use }
}
