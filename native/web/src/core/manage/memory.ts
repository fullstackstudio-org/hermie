/**
 * One bot's memory, as the Hermie plugin's `/api/plugins/hermie/memory/...` routes answer it (the Expo app's
 * `features/memory/model.ts` and `memory-controller.ts`, which this follows, without the graph).
 *
 * Three decisions of the plugin reach into this file:
 *
 *  - **An id is positional.** A memory file is plain text with entries joined by `"\n§\n"`: `memory:3` is "the
 *    fourth entry as it reads now" and stops being true when one above it goes. Every write sends the entry's
 *    TEXT as well, which is what the store matches on, so a stale position cannot overwrite the entry that moved
 *    into its place.
 *  - **There are exactly two targets**, `memory` (MEMORY.md) and `user` (USER.md).
 *  - **`chars` is counted the way the store spends it**, delimiter included, so the usage bar reads it off the
 *    answer instead of summing the entries it drew.
 *
 * Every route names its profile: a plugin handler is handed none and would act on whichever home the dashboard
 * process started with, which on a gateway serving several bots is somebody else's memory. A write is always
 * followed by a read: the positions have all shifted and the usage has moved by the delimiter as well as the
 * text, and only the store knows both.
 *
 * Every string in an answer is the bot's or the gateway's text. It is drawn as characters, never as Markdown.
 */
import type { GatewayHttp } from '@hermie/gateway-client'

import { routeErrorOf } from './route-error'

export const MEMORY_ROUTE = '/api/plugins/hermie/memory'

export const MEMORY_TARGETS = ['memory', 'user'] as const

export type MemoryTarget = (typeof MEMORY_TARGETS)[number]

export interface MemoryEntry {
  /** `memory:3`. Positional. */
  id: string
  target: MemoryTarget
  index: number
  text: string
  chars: number
}

export interface MemorySection {
  target: MemoryTarget
  entries: MemoryEntry[]
  /** What the file costs, delimiter included. */
  chars: number
  /** `0` on a gateway that configured no limit. */
  limit: number
  percent: number
}

/** A memory provider the gateway has; an external one cannot list what it holds. */
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

/** What a write answered: the store's own dict, with nothing added. */
export interface MemoryWriteAnswer {
  success: boolean
  /** The store's sentence about what went wrong (a character limit, an entry that has moved). */
  error: string | null
}

export interface MemoryDocument {
  id: string
  label: string
  content: string
  chars: number
  truncated: boolean
}

export interface MemoryBackendRaw {
  name: string
  label: string
  available: boolean
  note: string | null
  documents: MemoryDocument[]
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const str = (value: unknown): string => (typeof value === 'string' ? value : '')
const num = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0)

const isTarget = (value: unknown): value is MemoryTarget =>
  typeof value === 'string' && (MEMORY_TARGETS as readonly string[]).includes(value)

function entryOf(value: unknown, fallbackTarget: MemoryTarget, fallbackIndex: number): MemoryEntry {
  const row = isObject(value) ? value : {}
  const target = isTarget(row.target) ? row.target : fallbackTarget
  const index = typeof row.index === 'number' && Number.isFinite(row.index) ? row.index : fallbackIndex
  const text = str(row.text)

  return {
    id: str(row.id) || `${target}:${index}`,
    target,
    index,
    text,
    chars: typeof row.chars === 'number' ? num(row.chars) : text.length
  }
}

/** `GET .../list`: both targets, always, in the plugin's order, even when one is empty. */
export function memoryListingOf(value: unknown): MemoryListing {
  const body = isObject(value) ? value : {}
  const byTarget = new Map<MemoryTarget, Record<string, unknown>>()

  for (const row of Array.isArray(body.targets) ? body.targets : []) {
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

/** `GET .../search?q=`: one list across both targets. */
export function memorySearchOf(value: unknown): MemoryEntry[] {
  const body = isObject(value) ? value : {}

  return (Array.isArray(body.results) ? body.results : []).map((row, index) => entryOf(row, 'memory', index))
}

/** `POST .../edit`. */
export function memoryWriteOf(value: unknown): MemoryWriteAnswer {
  const body = isObject(value) ? value : {}

  return { success: body.success === true, error: str(body.error) || null }
}

/** `GET .../raw`: what is stored, as stored. */
export function memoryRawOf(value: unknown): MemoryBackendRaw[] {
  const body = isObject(value) ? value : {}

  return (Array.isArray(body.backends) ? body.backends : []).flatMap(row => {
    if (!isObject(row) || !str(row.name)) {
      return []
    }

    return [
      {
        name: str(row.name),
        label: str(row.label) || str(row.name),
        available: row.available !== false,
        note: str(row.note) || null,
        documents: (Array.isArray(row.documents) ? row.documents : []).flatMap(document => {
          if (!isObject(document)) {
            return []
          }

          const content = str(document.content)

          return [
            {
              id: str(document.id) || str(document.label),
              label: str(document.label) || str(document.id),
              content,
              chars: typeof document.chars === 'number' ? num(document.chars) : content.length,
              truncated: document.truncated === true
            }
          ]
        })
      }
    ]
  })
}

/** The part of the REST client the memory routes use. */
export type MemoryHttp = Pick<GatewayHttp, 'get' | 'post'>

export interface MemoryClient {
  readonly profile: string
  list(): Promise<MemoryListing>
  search(query: string): Promise<MemoryEntry[]>
  raw(): Promise<MemoryBackendRaw[]>
  add(target: MemoryTarget, content: string): Promise<MemoryWriteAnswer>
  /** Replace one entry; matched by its text, with its position as the fall-back. */
  replace(entry: MemoryEntry, content: string): Promise<MemoryWriteAnswer>
  remove(entry: MemoryEntry): Promise<MemoryWriteAnswer>
}

/** The client for one bot's memory. A failed call rejects with a `RouteError`. */
export function createMemoryClient(http: MemoryHttp, profile: string): MemoryClient {
  const named = encodeURIComponent(profile)

  const read = async <T>(path: string, parse: (body: unknown) => T): Promise<T> => {
    try {
      return parse(await http.get(`${MEMORY_ROUTE}/${path}`))
    } catch (failure) {
      throw routeErrorOf(failure)
    }
  }

  const write = async (body: Record<string, unknown>): Promise<MemoryWriteAnswer> => {
    try {
      return memoryWriteOf(await http.post(`${MEMORY_ROUTE}/edit`, { profile, ...body }))
    } catch (failure) {
      const error = routeErrorOf(failure)

      return { success: false, error: error.message }
    }
  }

  return {
    profile,
    list: () => read(`list?profile=${named}`, memoryListingOf),
    search: query => read(`search?profile=${named}&q=${encodeURIComponent(query)}`, memorySearchOf),
    raw: () => read(`raw?profile=${named}`, memoryRawOf),
    add: (target, content) => write({ target, op: 'add', content }),
    replace: (entry, content) =>
      write({ target: entry.target, op: 'replace', content, old_text: entry.text, index: entry.index }),
    remove: entry => write({ target: entry.target, op: 'remove', old_text: entry.text, index: entry.index })
  }
}
