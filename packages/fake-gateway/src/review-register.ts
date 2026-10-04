import { createHash, randomBytes } from 'node:crypto'

/**
 * The approved text of a reviewed draft, kept by the gateway (`review_register.py`).
 *
 * `review.draft` settles with the FINAL text (edited or not). `put` stores it under a `draft_id`
 * (`drf-<12 hex>`) for the conversation; a later `confirm` with `draft_id` builds its detail FROM HERE,
 * never from what the agent says it will send, so a confirmation commits to the text the person approved.
 *
 * Memory only: a conversation key maps to at most 20 entries (the oldest goes first), each valid for an hour;
 * a lookup by another conversation's key finds nothing. Time is passed in (epoch milliseconds), so a test
 * moves the clock by hand.
 */

export const TTL_MS = 3_600_000
export const MAX_PER_KEY = 20
/** Conversations the register keeps entries for at once; beyond it the one idle longest is dropped. */
export const MAX_KEYS = 256

export interface Draft {
  draftId: string
  text: string
  sha256: string
  edited: boolean
  createdAt: number
}

export class ReviewRegister {
  // conversation key → drafts, oldest first; the Map's insertion order is the idle order.
  private readonly drafts = new Map<string, Draft[]>()

  private live(entries: Draft[], now: number): Draft[] {
    return entries.filter(draft => now - draft.createdAt < TTL_MS)
  }

  /** Store `text` for conversation `key`; the entry (with its `draftId` and `sha256`) comes back. */
  put(key: string, text: string, options: { edited?: boolean; now: number }): Draft {
    const entry: Draft = {
      draftId: `drf-${randomBytes(6).toString('hex')}`,
      text,
      sha256: createHash('sha256').update(text, 'utf8').digest('hex'),
      edited: options.edited === true,
      createdAt: options.now
    }
    const entries = this.live(this.drafts.get(key) ?? [], options.now)

    this.drafts.delete(key)
    entries.push(entry)
    this.drafts.set(key, entries.slice(-MAX_PER_KEY))

    while (this.drafts.size > MAX_KEYS) {
      this.drafts.delete(this.drafts.keys().next().value as string)
    }

    return entry
  }

  /** The live draft `draftId` of conversation `key`, or `undefined` (unknown, expired, or another conversation's). */
  get(key: string, draftId: string, now: number): Draft | undefined {
    const entries = this.live(this.drafts.get(key) ?? [], now)

    if (entries.length) {
      this.drafts.set(key, entries)
    } else {
      this.drafts.delete(key)
    }

    return entries.find(draft => draft.draftId === draftId)
  }

  /** Forget every draft of conversation `key` (its session ended). */
  clear(key: string): void {
    this.drafts.delete(key)
  }

  count(key: string, now: number): number {
    return this.live(this.drafts.get(key) ?? [], now).length
  }
}
