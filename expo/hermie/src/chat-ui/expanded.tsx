/**
 * Per-item expanded state, held ABOVE the list.
 *
 * Every disclosure in the transcript — a folded long reply, a tool card, a cron
 * card, a bot-to-bot exchange, a roll-up — used to keep its own `useState`. In a
 * virtualised list that is a bug with a delay on it: scroll a expanded card out of
 * the window, `FlatList` unmounts the row, and scrolling back re-mounts it
 * collapsed. The reader did not collapse anything.
 *
 * So the state lives in one map, keyed by item id, owned by `TranscriptList` and
 * read through this context. It also means the list itself can decide that
 * expanding something must not move the viewport, which a row has no way to
 * arrange from the inside.
 *
 * A map of explicit CHOICES rather than a set of open ids, because not every row
 * starts closed: a slash command's answer opens itself, and a set cannot tell
 * "the reader has not touched this" from "the reader closed it". With a map, an
 * absent key means untouched — so the row's own `defaultOpen` decides — and a
 * present key is what the reader last did, which is the state virtualisation has
 * to carry across an unmount.
 */
import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react'

export interface ExpandedApi {
  /** `defaultOpen` applies only while the reader has made no choice for this id. */
  isExpanded: (id: string, defaultOpen?: boolean) => boolean
  /**
   * Open or close one disclosure.
   *
   * `growth` is how many points the row is about to change height by, where the
   * caller knows — a `Fold` does, because it measures its own unclipped body.
   * It is passed straight through to `onToggle` below; a caller that hands over
   * nothing is saying "I cannot tell you", not "nothing will move".
   *
   * `defaultOpen` is what the row shows when nothing has been chosen yet, so the
   * first tap on a row that opened itself CLOSES it rather than doing nothing.
   */
  toggle: (id: string, growth?: number, defaultOpen?: boolean) => void
  /** Used by a card that opens itself once and then follows the reader. */
  setExpanded: (id: string, expanded: boolean) => void
}

/**
 * The fallback for a component rendered outside a list — the gallery, a test, a
 * sheet. It keeps nothing, which is honest: there is no list to be virtualised
 * out of.
 */
const NOOP: ExpandedApi = {
  isExpanded: (_id, defaultOpen = false) => defaultOpen,
  setExpanded: () => {},
  toggle: () => {}
}

const ExpandedContext = createContext<ExpandedApi>(NOOP)

export interface ExpandedProviderProps {
  children: ReactNode
  /**
   * Called just BEFORE a reader-driven toggle changes the set.
   *
   * This is the hook the header above promises: the list decides where the
   * viewport must be after something opens, and it cannot decide that from
   * inside a row. `TranscriptList` passes the function that works out where the
   * list should end up — which is NOT simply where it is now, on an inverted
   * list: see `holdCorrection`. It fires on `toggle` only — a card that opens
   * ITSELF through `setExpanded` is not a finger on a `Show more` and has no
   * place to hold.
   */
  onToggle?: (id: string, growth: number) => void
}

export function ExpandedProvider({ children, onToggle }: ExpandedProviderProps) {
  const [choices, setChoices] = useState<ReadonlyMap<string, boolean>>(() => new Map())
  const before = useRef(onToggle)

  before.current = onToggle

  const toggle = useCallback((id: string, growth = 0, defaultOpen = false) => {
    before.current?.(id, growth)

    setChoices(current => {
      const next = new Map(current)

      next.set(id, !(current.get(id) ?? defaultOpen))

      return next
    })
  }, [])

  const setExpanded = useCallback((id: string, expanded: boolean) => {
    setChoices(current => {
      if (current.get(id) === expanded) {
        return current
      }

      const next = new Map(current)

      next.set(id, expanded)

      return next
    })
  }, [])

  const api = useMemo<ExpandedApi>(
    () => ({ isExpanded: (id, defaultOpen = false) => choices.get(id) ?? defaultOpen, setExpanded, toggle }),
    [choices, setExpanded, toggle]
  )

  return <ExpandedContext.Provider value={api}>{children}</ExpandedContext.Provider>
}

export interface UseExpandedOptions {
  /** What this row shows before the reader has opened or closed it. */
  defaultOpen?: boolean
}

/**
 * One item's disclosure state.
 *
 * Returns a tuple rather than the whole API so a row cannot accidentally read or
 * write another row's state, which is how the memo key stays honest.
 *
 * `defaultOpen` is the row's OWN default and nothing more: the moment the reader
 * taps, their choice is recorded against the id and the default stops applying,
 * including across the unmount virtualisation puts the row through. It belongs
 * here rather than inside a row because the state it overrides lives here — a
 * row that opened itself by branching on its own props would re-open every time
 * it scrolled back into the window.
 */
export function useExpanded(id: string, options: UseExpandedOptions = {}): [boolean, (growth?: number) => void] {
  const api = useContext(ExpandedContext)
  const defaultOpen = options.defaultOpen === true

  return [
    api.isExpanded(id, defaultOpen),
    useCallback((growth?: number) => api.toggle(id, growth, defaultOpen), [api, id, defaultOpen])
  ]
}

/** For a component that needs the whole API — a group card toggling its children. */
export function useExpandedApi(): ExpandedApi {
  return useContext(ExpandedContext)
}
