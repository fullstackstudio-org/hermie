/**
 * Where the request layer gets its sheets (`sheets.ts`, a chunk of its own).
 *
 * `React.lazy` would suspend on the first render of each sheet even when the
 * chunk is already in memory, and a question that stops a bot must be on screen
 * the moment it arrives. So the chunk is held here once it has loaded, and a
 * component that reads it through `useRequestSheets` renders the sheet in the
 * same pass from then on. The entry module calls `preloadRequestSheets` right
 * after the session starts, which is long before the first request can arrive;
 * should one arrive first anyway, the dialog is drawn with nothing in it until
 * the chunk is there.
 *
 * A fetch that fails (offline, a deploy that replaced the chunk) is forgotten,
 * and a layer that has a request to show asks again every few seconds.
 */
import { useEffect, useState, useSyncExternalStore } from 'react'

import type * as Sheets from './sheets'

export type RequestSheets = typeof Sheets

/** How long a layer waits before asking again for a chunk that did not arrive. */
export const SHEETS_RETRY_MS = 3_000

let loaded: RequestSheets | undefined
let pending: Promise<RequestSheets> | undefined
const listeners = new Set<() => void>()

function subscribe(listener: () => void): () => void {
  listeners.add(listener)

  return () => listeners.delete(listener)
}

const snapshot = (): RequestSheets | undefined => loaded

/** Fetch the sheets' chunk, once; resolves at once when it is in memory. */
export function preloadRequestSheets(): Promise<RequestSheets> {
  if (loaded) {
    return Promise.resolve(loaded)
  }

  pending ??= import('./sheets').then(
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

/**
 * The sheets, or undefined while their chunk is not in memory. `wanted` is
 * whether the caller has something to draw with them: only then is a missing
 * chunk fetched, and fetched again after a failure.
 */
export function useRequestSheets(wanted: boolean): RequestSheets | undefined {
  const sheets = useSyncExternalStore(subscribe, snapshot, snapshot)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    if (!wanted || sheets) {
      return
    }

    let timer: ReturnType<typeof setTimeout> | undefined
    let live = true

    preloadRequestSheets().catch(() => {
      if (live) {
        timer = setTimeout(() => setAttempt(count => count + 1), SHEETS_RETRY_MS)
      }
    })

    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [wanted, sheets, attempt])

  return sheets
}
