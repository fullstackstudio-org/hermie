/**
 * The heavy renderers (highlighting, mathematics, Mermaid) are chunks of their
 * own, fetched the first time a message needs one.
 *
 * Not `React.lazy`: a lazy component suspends on every first render, even when
 * its module arrived long ago, and a suspended block of a transcript would show
 * its fallback for a frame and then change height. Here a module, once loaded,
 * is held in a plain variable, so every block rendered after that draws the real
 * thing on its first render. Until then the block shows what it would show for
 * source it cannot draw (the source, in a code block), which is a correct page,
 * not a placeholder.
 *
 * A chunk that fails to load (the network went, a new build replaced the files)
 * leaves the source on the page and is asked for again by the next block that
 * mounts.
 */
import { useEffect, useSyncExternalStore } from 'react'

export interface LazyModule<T> {
  /** The module, once it has loaded. */
  current(): T | undefined
  /** Starts the fetch (once) and resolves with the module. */
  load(): Promise<T>
  subscribe(listener: () => void): () => void
}

export function lazyModule<T>(importer: () => Promise<T>): LazyModule<T> {
  let module: T | undefined
  let pending: Promise<T> | undefined
  const listeners = new Set<() => void>()

  return {
    current: () => module,
    load() {
      if (module !== undefined) {
        return Promise.resolve(module)
      }

      pending ??= importer().then(
        loaded => {
          module = loaded
          listeners.forEach(listener => listener())

          return loaded
        },
        (error: unknown) => {
          // The next caller tries again.
          pending = undefined
          throw error
        }
      )

      return pending
    },
    subscribe(listener) {
      listeners.add(listener)

      return () => listeners.delete(listener)
    }
  }
}

/** The module when it is there; asks for it (once per mount) when it is not. */
export function useLazyModule<T>(lazy: LazyModule<T>): T | undefined {
  const module = useSyncExternalStore(lazy.subscribe, lazy.current, lazy.current)

  useEffect(() => {
    if (lazy.current() === undefined) {
      // A failure keeps the fallback on the page; there is nothing to report.
      lazy.load().catch(() => undefined)
    }
  }, [lazy])

  return module
}

/** Syntax highlighting: highlight.js core and the fifteen grammars of `@hermie/markdown`. */
export const highlightRenderer = lazyModule(() => import('./Highlight'))

/** Typeset mathematics, block and inline. */
export const mathRenderer = lazyModule(() => import('./Math'))
