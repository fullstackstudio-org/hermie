/**
 * Moving one bot's name across every store that is keyed on it.
 *
 * ## Why this exists at all
 *
 * A bot's name is not a label in this app, it is the PRIMARY KEY. The chat
 * store holds transcripts under it, the roster holds bots and watermarks under
 * it, the arrangement holds entries, folders, archive flags, colours and the
 * name the reader gave the bot under it, and the on-disk transcript cache has a
 * column of it. So the moment core's `PATCH /api/profiles/{name}` really
 * renames a profile — which it does for every profile except `default` —
 * every one of those keys is pointing at a bot that no longer exists, and the
 * next roster read drops the rows rather than moving them. The reader's
 * colours, their folder and their cached conversation would all quietly go.
 *
 * ## Build everything, then apply everything
 *
 * The synchronous half computes each store's next state WITHOUT touching a
 * store, and only then writes them. A migration that wrote as it went and threw
 * in the middle would leave the app with a chat under the new name, an
 * arrangement under the old one and no way back. Building first means the only
 * thing that can fail before the first write is a pure function, and a failure
 * after that is caught and every captured snapshot is put back — which is what
 * "if any part fails, keep the old" has to mean for state that has no
 * transaction around it.
 *
 * ## Nothing here reaches into a store's internals
 *
 * The rekeying is `setState` on the same objects the stores already export,
 * with two exceptions that go through public setters because they persist:
 * `markSeen` carries the unread watermark, and `setAccent` both moves the
 * colour and is what makes the arrangement's own `save()` run. That last one is
 * deliberate and is why the accent is moved last: the arrangement is persisted
 * by a private writer, and calling the one public setter that always saves is
 * how the rekeyed entries, folders, archive flags and mutes reach the disk
 * without a new action on a store three other rounds are editing.
 *
 * ## The cache is separate because it can fail on its own
 *
 * The cache is SQLite on the phones and IndexedDB in a browser, it is async,
 * and it is allowed to be unavailable — `FallbackChatCache` downgrades to
 * memory the first time it throws. So the cached transcript is moved after the
 * in-memory stores and its failure is reported rather than rolled back: the
 * worst case is a cold start that re-fetches one conversation, which is what a
 * cache miss has always cost.
 *
 * There is one cache PER GATEWAY, so the caller says which: two gateways can
 * both have a `researcher`, and a rename on one of them must not go looking
 * through the other one's transcripts.
 */
import type { ChatState } from '@hermie/transcript'

import { chatCacheFor } from '../../platform/chat-cache'
import { useBotsStore, type Bot, type BotCanonicalSession } from '../../store/bots'
import { useChatLayoutStore } from '../../store/chat-layout'
import { useChatsStore, type QueuedMessage } from '../../store/chats'
import type { AccentName } from '../../ui/tokens'

/** What could not be moved. Empty is the whole of success. */
export interface RenameBotResult {
  ok: boolean
  /** `stores` and/or `cache`, in the order they were attempted. */
  failed: ('stores' | 'cache')[]
}

/** Move one key in a plain record, dropping the old one. Absent stays absent. */
function rekey<T>(map: Record<string, T>, from: string, to: string): Record<string, T> {
  if (!(from in map)) {
    return map
  }

  const next = { ...map }
  const value = next[from] as T

  delete next[from]
  next[to] = value

  return next
}

/**
 * Rename a bot everywhere this app holds one.
 *
 * Caller's contract: `from` has already been renamed ON THE GATEWAY. This does
 * not ask and cannot undo that — it is the local half, and the answer says
 * which parts of it landed.
 *
 * A no-op when the two names are equal, which is the `default` profile's case:
 * that one keeps its id and gains a display name, so there is no key to move.
 *
 * `gatewayId` names the cache to move the transcript in. `null` means there is
 * no gateway to have renamed anything on, which leaves the in-memory stores as
 * the whole of the move rather than guessing at a corner of the disk.
 */
export async function renameBot(from: string, to: string, gatewayId: string | null): Promise<RenameBotResult> {
  if (!from || !to || from === to) {
    return { ok: true, failed: [] }
  }

  const failed: RenameBotResult['failed'] = []
  const bots = useBotsStore.getState()
  const chats = useChatsStore.getState()
  const layout = useChatLayoutStore.getState()

  /* Everything that has to be put back if the writes below throw. */
  const before = {
    bots: { bots: bots.bots, byName: bots.byName, avatars: bots.avatars, running: bots.running },
    chats: { chats: chats.chats, queues: chats.queues, runtimeToBot: chats.runtimeToBot, live: chats.live },
    layout: {
      entries: layout.entries,
      folders: layout.folders,
      archived: layout.archived,
      labels: layout.labels,
      mutes: layout.mutes
    }
  }

  try {
    // -- the roster ---------------------------------------------------------
    const renamedBot: Bot | undefined = bots.byName[from] ? { ...(bots.byName[from] as Bot), name: to } : undefined

    if (renamedBot) {
      useBotsStore.setState({
        bots: bots.bots.map(entry => (entry.name === from ? renamedBot : entry)),
        byName: { ...rekey(bots.byName, from, to), [to]: renamedBot },
        avatars: rekey(bots.avatars, from, to),
        running: rekey(bots.running, from, to),
        // `avatarsFetched` is keyed `name:revision` and is a record of ATTEMPTS
        // rather than of data. Moving it would claim the new name's avatar has
        // already been fetched; leaving it makes the loader ask once more,
        // which is exactly what a renamed profile deserves.
        canonicalPins: rekey(bots.canonicalPins, from, to) as Record<string, BotCanonicalSession>
      })
    }

    // -- the open chats -----------------------------------------------------
    const chat = chats.chats[from]
    const movedChats: Record<string, ChatState> = rekey(chats.chats, from, to)

    if (chat) {
      // The chat carries the name inside itself as well as in the key, and the
      // reducers read it back out — a transcript whose `botName` still said the
      // old handle would address every new turn to a profile that is gone.
      movedChats[to] = { ...chat, botName: to }
    }

    const runtimeToBot: Record<string, string> = {}

    for (const [runtimeId, name] of Object.entries(chats.runtimeToBot)) {
      runtimeToBot[runtimeId] = name === from ? to : name
    }

    useChatsStore.setState({
      chats: movedChats,
      queues: rekey(chats.queues, from, to) as Record<string, QueuedMessage[]>,
      runtimeToBot,
      live: rekey(chats.live, from, to) as Record<string, true>
    })

    // -- the arrangement ----------------------------------------------------
    useChatLayoutStore.setState({
      entries: layout.entries.map(entry =>
        entry.kind === 'chat' && entry.name === from ? { ...entry, name: to } : entry
      ),
      folders: layout.folders.map(folder =>
        folder.bots.includes(from) ? { ...folder, bots: folder.bots.map(name => (name === from ? to : name)) } : folder
      ),
      archived: rekey(layout.archived, from, to) as Record<string, true>,
      // The reader's own name for the bot, which is keyed on the handle like
      // everything else here — and is the one key whose loss would look like the
      // rename having undone the rename.
      labels: rekey(layout.labels, from, to) as Record<string, string>,
      mutes: rekey(layout.mutes, from, to)
    })
  } catch {
    useBotsStore.setState(before.bots)
    useChatsStore.setState(before.chats)
    useChatLayoutStore.setState(before.layout)

    return { ok: false, failed: ['stores'] }
  }

  /*
    The colour, last and through the public setter, because `setAccent` is what
    persists the whole arrangement — see the header. Two calls: the new name
    takes the colour, and the old name's entry is dropped by writing `default`,
    which the store stores as an absence.
  */
  const accent: AccentName = layout.accents[from] ?? 'default'

  if (accent !== 'default') {
    useChatLayoutStore.getState().setAccent(to, accent)
  }

  useChatLayoutStore.getState().setAccent(from, 'default')

  /* The unread watermark, which has its own queued write to disk. */
  const watermark = bots.lastSeen[from]

  if (watermark !== undefined) {
    useBotsStore.getState().markSeen(to, watermark)
  }

  // -- the cached transcript ------------------------------------------------
  if (gatewayId) {
    const cache = chatCacheFor(gatewayId)

    try {
      const cached = await cache.read(from)

      if (cached) {
        await cache.write({ ...cached, bot: to })
        await cache.forget(from)
      }
    } catch {
      failed.push('cache')
    }
  }

  return { ok: failed.length === 0, failed }
}
