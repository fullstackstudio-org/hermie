/**
 * Which replies an automatic read has not offered yet (`features/voice/auto-read.ts` in the Expo app, and the
 * automatic read of `ReadAloudModel` in the native apps).
 *
 * Pure, and apart from the hook, because the three things that can go wrong here are arithmetic rather than React:
 *
 *  - **Reading the history.** Switching "Read replies aloud" on in a chat with four hundred messages must not start
 *    at message one. So the caller SEEDS the set of ids it has already seen when the feature becomes active, and
 *    only what arrives after is offered.
 *  - **Reading history that is paged in later.** Older messages arrive above the newest reply seen. They are not
 *    new: only what stands after the newest reply seen (`frontier`) can be.
 *  - **Reading a reply twice.** The effect this feeds re-runs on every change to the visible list, which during a
 *    turn is once per streamed delta, so "have I offered this one" is a fact about ids rather than about how many
 *    times the effect has run.
 *
 * It takes the ALREADY-FILTERED list. The transcript has been through the verbosity filter, the bot-to-bot toggle and
 * the thinking toggle, and a reply the reader has chosen not to see is not a reply they asked to hear.
 */

/** The shape this needs off a visible row, and nothing more. */
export interface ReadableEntry {
  item: { id: string; kind: string; text?: string; interim?: boolean; error?: unknown }
}

export interface AutoReadCandidate {
  id: string
  /** The Markdown, unflattened. The caller decides what to do with it. */
  text: string
}

/** What the automatic read keeps between calls. */
export interface AutoReadMemory {
  /** The first pass for a chat is a seed and nothing else. */
  seeded: boolean
  /** Ids already offered, or seen at the seed. */
  offered: Set<string>
  /** The newest reply seen or offered: what stands before it is history. */
  frontier: string | null
}

export const freshMemory = (): AutoReadMemory => ({ seeded: false, offered: new Set(), frontier: null })

/**
 * The replies to read, oldest first, given what has been offered.
 *
 * `turnRunning` is a hard gate, not a filter on the last row: a reply being written is one whose text will be
 * different in 200 ms, and an engine handed the first sentence would read it, stop, and be handed the whole thing
 * again. Only `assistant` rows that are finished: an interim note is mid-turn commentary, and an inbound bot-to-bot
 * message can be read from the menu (somebody chose it) but arriving traffic between two bots is not what "read
 * replies aloud" means, and a chat whose bots talk to each other would never stop speaking.
 */
export function autoReadCandidates(
  entries: readonly ReadableEntry[],
  memory: AutoReadMemory,
  turnRunning: boolean
): AutoReadCandidate[] {
  if (turnRunning) {
    return []
  }

  const readable: AutoReadCandidate[] = []

  for (const entry of entries) {
    const { error, id, interim, kind, text } = entry.item

    if (kind === 'assistant' && !interim && !error && text?.trim()) {
      readable.push({ id, text })
    }
  }

  const frontierAt = memory.frontier === null ? -1 : readable.findIndex(candidate => candidate.id === memory.frontier)

  // A frontier no longer in the transcript (a new conversation replaced it) is no limit.
  return readable.slice(frontierAt + 1).filter(candidate => !memory.offered.has(candidate.id))
}

/** The ids and the newest reply in the list now, which is what "start from here" means. */
export function seed(entries: readonly ReadableEntry[], memory: AutoReadMemory): void {
  const replies = entries.filter(entry => entry.item.kind === 'assistant' && !entry.item.interim && !entry.item.error)

  memory.seeded = true
  memory.offered = new Set(entries.map(entry => entry.item.id))
  memory.frontier = replies[replies.length - 1]?.item.id ?? null
}
