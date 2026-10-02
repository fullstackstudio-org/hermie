/**
 * The plugin's memory answers, as this app reads them.
 *
 * Every shape here is read off `memory/browse.py` in the plugin repository and
 * its tests, not guessed from what a browser would find convenient. Three of
 * its decisions reach all the way into this file and are worth stating where
 * somebody will read them before changing a reader:
 *
 *  - **An id is POSITIONAL.** A memory file is plain text with entries joined
 *    by `"\n§\n"` — no ids, no timestamps — so `memory:3` means "the fourth
 *    entry of MEMORY.md as it reads right now" and stops being true the moment
 *    one above it is removed. It is a way of naming a row on screen and nothing
 *    else. Every write therefore sends the entry's TEXT, which is what the
 *    store itself matches on, so an index that went stale between a read and a
 *    write cannot delete the entry that moved into its place.
 *  - **There are exactly two targets.** The store dispatches on a bare
 *    `target === "user"` and the tool layer refuses anything else. A third
 *    would be our invention.
 *  - **`chars` is counted the way the store SPENDS it**, delimiter included.
 *    That is why the usage bar reads `chars` off the answer rather than summing
 *    the entries it drew: a bar that disagreed with the store about how full a
 *    file is would have somebody deleting entries to fix a number that was
 *    never true.
 */

/** The two files a profile has. Named by the plugin, not by us. */
export const MEMORY_TARGETS = ['memory', 'user'] as const

export type MemoryTarget = (typeof MEMORY_TARGETS)[number]

export interface MemoryEntry {
  /** `memory:3`. Positional, and stale the moment an entry above it goes. */
  id: string
  target: MemoryTarget
  index: number
  text: string
  chars: number
  /** The plugin's cheap topics: capitals, `@handles`, `#hashtags`, ISO dates. */
  topics: string[]
}

export interface MemorySection {
  target: MemoryTarget
  entries: MemoryEntry[]
  /** What this file costs, delimiter included — the store's own number. */
  chars: number
  /** `0` on a gateway that configured no limit; the bar is not drawn then. */
  limit: number
  percent: number
}

/**
 * A memory provider the gateway has.
 *
 * `enumerable` is `false` on every external row and that is not a placeholder:
 * `MemoryProvider` offers `prefetch(query)` returning opaque formatted text and
 * no call that returns entries, and mem0's own surface is `search(query,
 * top_k)` with no `get_all`. So a provider's memories cannot be shown even
 * read-only without inventing an API Hermes does not have, and naming the
 * provider while saying it cannot be opened is the honest version of that.
 */
export interface MemoryProvider {
  name: string
  description: string
  available: boolean
  enumerable: boolean
}

export interface MemoryListing {
  profile: string
  sections: MemorySection[]
  providers: MemoryProvider[]
}

export interface MemorySearchAnswer {
  query: string
  count: number
  results: MemoryEntry[]
}

/**
 * What a write answered.
 *
 * The plugin hands back the STORE's own result dict rather than a translation
 * of it, so `error` is Hermes' sentence about what went wrong — a char limit,
 * an entry that has moved — and the screen shows it verbatim. A sentence we
 * invented here would be a second opinion about a file we did not write.
 */
export interface MemoryWriteAnswer {
  success: boolean
  error: string | null
  /**
   * The target as the store re-read it after a stale-index refusal.
   *
   * Present only on that one failure. It is not applied automatically: the
   * screen refetches, because a listing rebuilt from a half-answer would have
   * the usage bar and the entries disagreeing.
   */
  currentEntries: string[] | null
}

/** One stored document of one backend, as it is held rather than as parsed. */
export interface MemoryDocument {
  /** The backend's own name for it — `memory`, `user`, a collection. */
  id: string
  /** What to put on the card: `MEMORY.md`, a collection's title. */
  label: string
  /** The content as stored. Empty is a real answer: the file exists and is bare. */
  content: string
  chars: number
  /** The gateway cut it. Said out loud rather than shown as the whole of it. */
  truncated: boolean
}

/** One memory backend's raw side: what it holds, or why it cannot say. */
export interface MemoryBackendRaw {
  name: string
  label: string
  /** The gateway has this backend at all. `false` is the "not on this gateway" state. */
  available: boolean
  /** The route would take a write for it. Nothing writes raw content yet. */
  editable: boolean
  /** Why there are no documents, when there are none and that is not an error. */
  note: string | null
  documents: MemoryDocument[]
}

export interface MemoryRaw {
  profile: string
  backends: MemoryBackendRaw[]
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)

const str = (value: unknown): string => (typeof value === 'string' ? value : '')
const num = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0)

const isTarget = (value: unknown): value is MemoryTarget =>
  typeof value === 'string' && (MEMORY_TARGETS as readonly string[]).includes(value)

function entryOf(value: unknown, fallbackTarget: MemoryTarget, fallbackIndex: number): MemoryEntry {
  const row = isObject(value) ? value : {}
  const target = isTarget(row.target) ? row.target : fallbackTarget
  const index = num(row.index) || fallbackIndex
  const text = str(row.text)

  return {
    id: str(row.id) || `${target}:${index}`,
    target,
    index,
    text,
    // `chars` off the answer, and the text's own length only when the gateway
    // sent none: the two differ on a file whose entries carry surrogate pairs.
    chars: typeof row.chars === 'number' ? num(row.chars) : text.length,
    topics: Array.isArray(row.topics) ? row.topics.filter((topic): topic is string => typeof topic === 'string') : []
  }
}

/**
 * `GET …/memory/list`.
 *
 * Both targets are always named, in the plugin's own order, even when one is
 * empty — an absent section would read as "this gateway has no USER.md", which
 * is a different thing from one that has nothing in it yet.
 */
export function memoryListingOf(value: unknown): MemoryListing {
  const body = isObject(value) ? value : {}
  const sent = Array.isArray(body.targets) ? body.targets : []
  const byTarget = new Map<MemoryTarget, Record<string, unknown>>()

  for (const row of sent) {
    if (isObject(row) && isTarget(row.target)) {
      byTarget.set(row.target, row)
    }
  }

  return {
    profile: str(body.profile),
    sections: MEMORY_TARGETS.map(target => {
      const row = byTarget.get(target) ?? {}
      const entries = Array.isArray(row.entries) ? row.entries : []

      return {
        target,
        entries: entries.map((entry, index) => entryOf(entry, target, index)),
        chars: num(row.chars),
        limit: num(row.limit),
        percent: num(row.percent)
      }
    }),
    providers: (Array.isArray(body.providers) ? body.providers : []).flatMap(row =>
      isObject(row) && str(row.name)
        ? [
            {
              name: str(row.name),
              description: str(row.description),
              available: row.available !== false,
              enumerable: row.enumerable === true
            }
          ]
        : []
    )
  }
}

/** `GET …/memory/search?q=…`. One list, across both targets, ids kept. */
export function memorySearchOf(value: unknown): MemorySearchAnswer {
  const body = isObject(value) ? value : {}
  const results = (Array.isArray(body.results) ? body.results : []).map((row, index) => entryOf(row, 'memory', index))

  return {
    query: str(body.query),
    // The plugin sends a count; trusting the array is what keeps the header and
    // the rows from disagreeing when one row was unreadable.
    count: results.length,
    results
  }
}

/** `POST …/memory/edit`. The store's own dict, with nothing added to it. */
export function memoryWriteOf(value: unknown): MemoryWriteAnswer {
  const body = isObject(value) ? value : {}
  const entries = body.current_entries

  return {
    success: body.success === true,
    error: str(body.error) || null,
    currentEntries: Array.isArray(entries)
      ? entries.filter((entry): entry is string => typeof entry === 'string')
      : null
  }
}

/**
 * `GET …/memory/raw`.
 *
 * The route this reads is NOT on the plugin at the pin this app was built
 * against: the four that exist are `list`, `search`, `graph` and `edit`, and
 * none of them hands back a backend's stored content as such. `list` comes
 * close for the built-in one — every entry's full text is in it — but an entry
 * list is the parsed view, and the owner asked to see what is in the memory
 * ITSELF, delimiters and headings and all, plus what a provider like mem0 is
 * holding. Neither is reconstructable from a parse.
 *
 * So the shape is specified rather than discovered, the fake gateway serves it,
 * and a plugin that does not have the route yet gets the "this gateway cannot
 * show this" state instead of a blank tab. The exact contract is in
 * `memory-controller.ts` beside the call.
 *
 * `available: false` and an empty `documents` are different answers on purpose.
 * A provider that is configured but cannot be listed — which is every external
 * one today, because `MemoryProvider` offers only `prefetch(query)` — is
 * available with no documents and a `note` saying why. A backend the gateway
 * does not have at all is not available, and the tab says THAT instead.
 */
export function memoryRawOf(value: unknown): MemoryRaw {
  const body = isObject(value) ? value : {}
  const sent = Array.isArray(body.backends) ? body.backends : []

  return {
    profile: str(body.profile),
    backends: sent.flatMap(row => {
      if (!isObject(row) || !str(row.name)) {
        return []
      }

      const documents = Array.isArray(row.documents) ? row.documents : []

      return [
        {
          name: str(row.name),
          label: str(row.label) || str(row.name),
          available: row.available !== false,
          editable: row.editable === true,
          note: str(row.note) || null,
          documents: documents.flatMap(document => {
            if (!isObject(document)) {
              return []
            }

            const content = str(document.content)

            return [
              {
                id: str(document.id) || str(document.label),
                label: str(document.label) || str(document.id),
                content,
                // The gateway's own count where it sent one: a file of
                // surrogate pairs costs the store more than this string's
                // `length` says it does.
                chars: typeof document.chars === 'number' ? num(document.chars) : content.length,
                truncated: document.truncated === true
              }
            ]
          })
        }
      ]
    })
  }
}

/** Every entry the listing holds, in the order the screen draws them. */
export function entriesOf(listing: MemoryListing | null): MemoryEntry[] {
  return (listing?.sections ?? []).flatMap(section => section.entries)
}

/** The external providers, which are the rows that say they cannot be opened. */
export function externalProviders(listing: MemoryListing | null): MemoryProvider[] {
  return (listing?.providers ?? []).filter(provider => !provider.enumerable)
}
