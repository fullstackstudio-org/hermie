/**
 * Which replies an automatic read has not offered yet.
 *
 * Pure, and separate from the hook, because the two things that can go wrong
 * here are both arithmetic rather than React:
 *
 *  - **Reading the history.** Switching "Read replies aloud" on in a chat with
 *    four hundred messages in it must not start reading at message one. So the
 *    caller SEEDS the set of ids it has already seen at the moment the feature
 *    becomes active, and only what arrives after that is offered.
 *  - **Reading a reply twice.** The effect this feeds re-runs on every change to
 *    the visible list — which during a turn is once per streamed delta — so
 *    "have I offered this one" has to be a fact about ids rather than about how
 *    many times the effect has run.
 *
 * It deliberately takes the ALREADY-FILTERED list. `chat.items` has been through
 * the verbosity filter, the bot-to-bot toggle and the thinking toggle, and a
 * reply this reader has chosen not to see is not a reply they asked to hear.
 * That is the same rule the export serializer follows.
 */

/** The shape this needs off a `VisibleItem`, and nothing more. */
export interface ReadableEntry {
  item: { id: string; kind: string; text?: string }
}

export interface AutoReadCandidate {
  id: string
  /** The markdown, unflattened. The caller decides what to do with it. */
  text: string
}

/**
 * The replies to read, oldest first, given what has already been offered.
 *
 * `turnRunning` is a hard gate rather than a filter on the last row, and that is
 * the whole of "never while streaming": a reply being written is a reply whose
 * text will be different in 200ms, and an engine handed the first sentence would
 * read it, stop, and then be handed the whole thing again.
 *
 * Only `assistant` rows. An inbound bot-to-bot message can be read from the menu
 * — somebody chose it — but arriving traffic between two bots is not what "read
 * replies aloud" means, and a chat whose bots talk to each other would otherwise
 * never stop speaking.
 */
export function autoReadCandidates(
  entries: readonly ReadableEntry[],
  offered: ReadonlySet<string>,
  turnRunning: boolean
): AutoReadCandidate[] {
  if (turnRunning) {
    return []
  }

  const out: AutoReadCandidate[] = []

  for (const entry of entries) {
    const { id, kind, text } = entry.item

    if (kind !== 'assistant' || offered.has(id) || !text?.trim()) {
      continue
    }

    out.push({ id, text })
  }

  return out
}

/** Every id currently in the list, which is what "start from here" means. */
export function seenIds(entries: readonly ReadableEntry[]): Set<string> {
  return new Set(entries.map(entry => entry.item.id))
}
