/**
 * Finding the row a search hit is about, inside the chat it names.
 *
 * This exists because the gateway will not say. `GET /api/sessions/search`
 * projects no message id and no message timestamp (see
 * `packages/gateway-client/src/session-search.ts`), so a hit points at a
 * conversation and the row has to be found again on this side — from the same
 * words the reader typed.
 *
 * The rule is FTS5's, near enough to be honest about: a bare term matches a word
 * that starts with it, a quoted term matches that substring, and every term has
 * to land in the same row. Near enough, because the index is built over the
 * JSON-encoded message and this searches the projected item — so a row the
 * gateway matched on its tool arguments will not be found here, and the caller
 * has to cope with not finding one.
 */
import type { TranscriptItem, VisibleItem } from '@hermie/transcript'

export interface SearchTerm {
  needle: string
  phrase: boolean
}

/** The terms a query is made of, lower-cased; a trailing `*` is already implied. */
export function searchTerms(query: string): SearchTerm[] {
  const terms: SearchTerm[] = []

  for (const raw of query.trim().match(/"[^"]*"|\S+/g) ?? []) {
    const phrase = raw.startsWith('"')
    const needle = (phrase ? raw.slice(1, -1) : raw.replace(/\*+$/, '')).trim().toLowerCase()

    if (needle) {
      terms.push({ needle, phrase })
    }
  }

  return terms
}

/** What a reader would consider this row's words. */
export function itemText(item: TranscriptItem): string {
  switch (item.kind) {
    case 'user':
    case 'assistant':
    case 'bot_dm_in':
    case 'status':
      return item.text
    case 'bot_dm_out':
      // The dispatch, the teammate's answer, or both: a reader searching for
      // what was said to @writer means either side of that exchange.
      return `${item.targetHandle} ${item.message}\n${item.reply?.text ?? ''}`
    case 'cron_delivery':
      return `${item.jobName}\n${item.body}`
    case 'notice':
      return `${item.title}\n${item.body ?? ''}`
    default:
      return ''
  }
}

export function textMatches(text: string, terms: readonly SearchTerm[]): boolean {
  if (!terms.length) {
    return false
  }

  const haystack = text.toLowerCase()
  const words = haystack.split(/[^\p{L}\p{N}]+/u).filter(Boolean)

  return terms.every(term =>
    term.phrase ? haystack.includes(term.needle) : words.some(word => word.startsWith(term.needle))
  )
}

/**
 * The id of the newest row that matches, or undefined.
 *
 * Newest rather than oldest: the gateway ranked its hit by relevance and cannot
 * tell us which row it picked, so any choice here is this client's. The newest
 * is the one a reader means by "where did we talk about that" — and it is the
 * one that needs the least history loaded to reach.
 */
export function findMatchingItem(items: readonly VisibleItem[], query: string): string | undefined {
  const terms = searchTerms(query)

  if (!terms.length) {
    return undefined
  }

  for (let index = items.length - 1; index >= 0; index -= 1) {
    const entry = items[index]

    if (entry && textMatches(itemText(entry.item), terms)) {
      return entry.item.id
    }
  }

  return undefined
}
