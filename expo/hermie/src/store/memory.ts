/**
 * One bot's memory, while its page is open.
 *
 * **One bot at a time, deliberately.** A memory file is read in full on every
 * `list` — there is no paging, because the whole of one is a few thousand
 * characters — so caching several profiles here would hold stale copies of
 * files anything on the gateway may have rewritten between two turns. The page
 * asks when it opens and after every write, and `profile` is what says which
 * bot the state in this store belongs to.
 *
 * **Nothing is persisted.** A bot's memory is the gateway's file, not a
 * preference of this device's, and a remembered copy would paint entries that
 * an agent has since edited itself.
 *
 * ## `error` and `notice` are two different failures
 *
 * `error` is the ROUTE failing — no plugin, switched off, no connection — and
 * it replaces the page. `notice` is the STORE refusing a write it understood:
 * a char limit, an entry that has moved. Those keep the page and sit beside the
 * thing that was refused, because the reader still has a list to work with and
 * the sentence is Hermes' own rather than ours.
 */
import { create } from 'zustand'

import type { MemoryGraph } from '../features/memory/graph-model'
import type { MemoryEntry, MemoryListing, MemoryRaw } from '../features/memory/model'

export interface MemoryState {
  /** The bot whose memory this is, or null before a page has opened. */
  profile: string | null
  listing: MemoryListing | null
  loading: boolean
  /** A write is in flight; the composer and the row actions are blocked. */
  busy: boolean
  /** The route failed. The page shows this instead of a list. */
  error: string | null
  /** The store refused or reported something. Shown beside the list. */
  notice: string | null
  /** The advert offers `memory.browse` and not `memory.edit`. */
  readOnly: boolean

  query: string
  searching: boolean
  /** Null means "not searching"; an empty array means "searched, nothing". */
  results: MemoryEntry[] | null

  /**
   * The graph tab's own answer, fetched only once that tab is opened.
   *
   * A separate route and a separate fetch rather than something derived from
   * the listing: the topics, the edges and the paging are the PLUGIN's, and
   * re-deriving them here would mean this app clustering a memory differently
   * from the gateway that owns it.
   */
  graph: MemoryGraph | null
  graphLoading: boolean

  /**
   * The Raw tab's answer: what each backend is actually holding.
   *
   * Fetched only once that tab is opened, for the reason the graph is — it is
   * another read of the same files, and of whatever an external provider will
   * say about itself.
   */
  raw: MemoryRaw | null
  rawLoading: boolean
  /**
   * The gateway's plugin has no `raw` route.
   *
   * A state of its own rather than an error, because it is a CAPABILITY answer:
   * an older plugin is not a failure, it is a plugin with one fewer route, and
   * the tab says that instead of painting a banner over the page.
   */
  rawMissing: boolean

  open: (profile: string, readOnly: boolean) => void
  setListing: (listing: MemoryListing) => void
  setLoading: (loading: boolean) => void
  setBusy: (busy: boolean) => void
  setError: (error: string | null) => void
  setNotice: (notice: string | null) => void
  setQuery: (query: string) => void
  setSearching: (searching: boolean) => void
  setResults: (results: MemoryEntry[] | null) => void
  setGraph: (graph: MemoryGraph | null) => void
  setGraphLoading: (loading: boolean) => void
  setRaw: (raw: MemoryRaw | null) => void
  setRawLoading: (loading: boolean) => void
  setRawMissing: () => void
  reset: () => void
}

const INITIAL = {
  profile: null as string | null,
  listing: null as MemoryListing | null,
  loading: false,
  busy: false,
  error: null as string | null,
  notice: null as string | null,
  readOnly: false,
  query: '',
  searching: false,
  results: null as MemoryEntry[] | null,
  graph: null as MemoryGraph | null,
  graphLoading: false,
  raw: null as MemoryRaw | null,
  rawLoading: false,
  rawMissing: false
}

export const useMemoryStore = create<MemoryState>(set => ({
  ...INITIAL,

  /**
   * Point the store at a bot.
   *
   * Everything else is cleared, including the search: a query typed against one
   * bot's memory has no meaning against another's, and leaving the results up
   * would show entries attributed to the wrong bot.
   */
  open(profile, readOnly) {
    set({ ...INITIAL, profile, readOnly, loading: true })
  },

  setListing(listing) {
    set({ listing, loading: false, error: null })
  },

  setLoading(loading) {
    set({ loading })
  },

  setBusy(busy) {
    set({ busy })
  },

  setError(error) {
    set({ error, loading: false })
  },

  setNotice(notice) {
    set({ notice })
  },

  setQuery(query) {
    // Emptying the field is how a search is left, so the results go with it
    // rather than lingering under a box that no longer says what produced them.
    set(query ? { query } : { query, results: null, searching: false })
  },

  setSearching(searching) {
    set({ searching })
  },

  setResults(results) {
    set({ results, searching: false })
  },

  setGraph(graph) {
    set({ graph, graphLoading: false })
  },

  setGraphLoading(graphLoading) {
    set({ graphLoading })
  },

  setRaw(raw) {
    set({ raw, rawLoading: false, rawMissing: false })
  },

  setRawLoading(rawLoading) {
    set({ rawLoading })
  },

  setRawMissing() {
    set({ raw: null, rawLoading: false, rawMissing: true })
  },

  reset() {
    set(INITIAL)
  }
}))
