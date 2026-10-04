/**
 * The roster store. Ported from the store half of the Expo app's
 * `__tests__/bots-roster.test.ts` (projection, unread, the conversation a bot is
 * on, the watermarks); the controller half is `core/bots-controller.test.ts`.
 *
 * Differences from the source: each test has its own store
 * (`createBotsStore`) instead of resetting a module one, and the watermarks
 * persist to a key-value store over an in-test `Storage` rather than to the
 * Expo app's namespaced one, which is also how a relaunch is staged.
 */
import { beforeEach, describe, expect, it } from 'vitest'

import { createKeyValueStore, type StorageLike, type WebKeyValueStore } from '../platform/key-value-store'
import {
  BOT_LAST_OPENED_KEY,
  BOT_LAST_SEEN_KEY,
  BOT_SEEN_COUNTS_KEY,
  botDisplayName,
  botFromProfileRow,
  createBotsStore,
  isOwnUnread,
  isUnread
} from './bots'

const PROFILE_ROW = {
  name: 'researcher',
  path: '/root/.hermes/profiles/researcher',
  display_name: 'Researcher',
  description: 'Finds things out.',
  model: 'example-provider/example-model',
  provider: 'example-provider',
  has_avatar: true,
  ui_meta_revisions: { avatar: 3, soul: 1 },
  canonical_session: {
    id: 'stored-researcher',
    resolved_id: 'tip-researcher',
    title: 'Bot Chat',
    preview: 'Draft is ready.',
    last_active: 1_700_000_100,
    message_count: 12
  }
}

const WRITER_ROW = {
  name: 'writer',
  path: '/root/.hermes/profiles/writer',
  display_name: 'Writer',
  model: 'example-provider/example-model',
  provider: 'example-provider',
  canonical_session: {
    id: 'stored-writer',
    resolved_id: 'tip-writer',
    title: 'Bot Chat',
    preview: 'On it.',
    last_active: 1_700_000_050,
    message_count: 4
  }
}

/** A `Storage` that outlives the key-value store over it, the way `localStorage` outlives a page. */
function memoryStorage(): StorageLike & { entries: Map<string, string> } {
  const entries = new Map<string, string>()

  return {
    entries,
    get length() {
      return entries.size
    },
    key: index => [...entries.keys()][index] ?? null,
    getItem: key => entries.get(key) ?? null,
    setItem: (key, value) => void entries.set(key, String(value)),
    removeItem: key => void entries.delete(key)
  }
}

let store = createBotsStore()

beforeEach(() => {
  store = createBotsStore()
})

describe('projecting a profile row', () => {
  it('keeps the durable id and the lineage tip apart', () => {
    const bot = botFromProfileRow(PROFILE_ROW)

    expect(bot.canonical).toEqual({
      id: 'stored-researcher',
      resolvedId: 'tip-researcher',
      preview: 'Draft is ready.',
      lastActive: 1_700_000_100,
      messageCount: 12
    })
  })

  it('takes the highest ui_meta revision so a changed avatar invalidates its cache', () => {
    expect(botFromProfileRow(PROFILE_ROW).uiMetaRevision).toBe(3)
  })

  it('falls back to the profile name when there is no display name', () => {
    expect(botFromProfileRow({ name: 'writer', path: '/p' }).displayName).toBe('writer')
  })
})

describe('a picture the roster says is gone', () => {
  it('stops being drawn, and one it still has is kept', () => {
    const store = createBotsStore()

    store
      .getState()
      .setBots([
        botFromProfileRow({ name: 'writer', path: '/p', has_avatar: true }),
        botFromProfileRow({ name: 'ops', path: '/p', has_avatar: true })
      ])
    store.getState().setAvatar('writer', 0, 'data:image/png;base64,AAAA')
    store.getState().setAvatar('ops', 0, 'data:image/png;base64,BBBB')

    // The picture was taken away here or on another device.
    store
      .getState()
      .setBots([
        botFromProfileRow({ name: 'writer', path: '/p', has_avatar: false }),
        botFromProfileRow({ name: 'ops', path: '/p', has_avatar: true })
      ])

    expect(store.getState().avatars).toEqual({ ops: 'data:image/png;base64,BBBB' })
  })

  it('is left alone by a roster that does not mention the bot', () => {
    const store = createBotsStore()

    store.getState().setBots([botFromProfileRow({ name: 'writer', path: '/p', has_avatar: true })])
    store.getState().setAvatar('writer', 0, 'data:image/png;base64,AAAA')
    store.getState().setBots([botFromProfileRow({ name: 'ops', path: '/p' })])

    expect(store.getState().avatars.writer).toBe('data:image/png;base64,AAAA')
  })
})

describe('unread', () => {
  it('is set while the chat moved after the user last looked at it', () => {
    store.getState().setBots([botFromProfileRow(PROFILE_ROW)])

    expect(isUnread(store.getState(), 'researcher')).toBe(true)

    store.getState().markSeen('researcher')

    expect(isUnread(store.getState(), 'researcher')).toBe(false)
  })

  it('never moves the watermark backwards', () => {
    store.getState().setBots([botFromProfileRow(PROFILE_ROW)])
    store.getState().markSeen('researcher', 2_000)
    store.getState().markSeen('researcher', 1_000)

    expect(store.getState().lastSeen.researcher).toBe(2_000)
  })
})

describe('the conversation a bot is on', () => {
  const OWN = { id: 'sess-ideas', resolvedId: 'sess-ideas', preview: 'An idea.', lastActive: 0, messageCount: 3 }

  it('binds the bot to an own chat and leaves the group chat where it was', () => {
    store.getState().setBots([botFromProfileRow(PROFILE_ROW)])
    store.getState().setCurrent('researcher', OWN)

    const bot = store.getState().byName.researcher

    expect(bot?.current).toEqual(OWN)
    expect(bot?.canonical?.id).toBe('stored-researcher')
    // No pin: the canonical still names the Bot Chat, so nothing waits on the
    // roster to agree with anything.
    expect(store.getState().canonicalPins).toEqual({})
    expect(store.getState().bots[0]?.current).toEqual(OWN)
  })

  it('survives the next roster answer, which knows nothing about readers', () => {
    store.getState().setBots([botFromProfileRow(PROFILE_ROW)])
    store.getState().setCurrent('researcher', OWN)
    store.getState().setBots([botFromProfileRow(PROFILE_ROW), botFromProfileRow(WRITER_ROW)])

    expect(store.getState().byName.researcher?.current).toEqual(OWN)
    expect(store.getState().byName.writer?.current).toBeUndefined()
  })

  it('holds a choice made before the roster placed the bot', () => {
    store.getState().setCurrent('researcher', OWN)
    store.getState().setBots([botFromProfileRow(PROFILE_ROW)])

    expect(store.getState().byName.researcher?.current).toEqual(OWN)
  })

  it('goes back to the group chat on null, and stays there across a roster answer', () => {
    store.getState().setBots([botFromProfileRow(PROFILE_ROW)])
    store.getState().setCurrent('researcher', OWN)
    store.getState().setCurrent('researcher', null)

    expect(store.getState().byName.researcher).not.toHaveProperty('current')

    store.getState().setBots([botFromProfileRow(PROFILE_ROW)])

    expect(store.getState().byName.researcher).not.toHaveProperty('current')
  })

  it('keeps the group chat unread rule on the canonical while parked', () => {
    store.getState().setBots([botFromProfileRow(PROFILE_ROW)])
    store.getState().markSeen('researcher')
    store.getState().setCurrent('researcher', { ...OWN, lastActive: 1_800_000_000 })

    // The own chat moving is not the group chat moving.
    expect(isUnread(store.getState(), 'researcher')).toBe(false)
  })
})

describe('a pinned canonical chat', () => {
  const SWITCHED = { id: 'stored-new', resolvedId: 'stored-new', preview: '', lastActive: 0, messageCount: 0 }

  it('holds against a roster answer that still names the old chat, and clears once it agrees', () => {
    store.getState().setBots([botFromProfileRow(PROFILE_ROW)])
    store.getState().setCanonical('researcher', SWITCHED)
    store.getState().setBots([botFromProfileRow(PROFILE_ROW)])

    expect(store.getState().byName.researcher?.canonical?.id).toBe('stored-new')
    expect(store.getState().canonicalPins.researcher).toEqual(SWITCHED)

    store
      .getState()
      .setBots([
        botFromProfileRow({ ...PROFILE_ROW, canonical_session: { ...PROFILE_ROW.canonical_session, id: 'stored-new' } })
      ])

    expect(store.getState().canonicalPins).toEqual({})
  })
})

describe('the display name', () => {
  it('is the roster’s label, the handle itself before the roster knows the bot, and nothing for nobody', () => {
    store.getState().setBots([botFromProfileRow(PROFILE_ROW)])

    expect(botDisplayName(store.getState(), 'researcher')).toBe('Researcher')
    expect(botDisplayName(store.getState(), 'writer')).toBe('writer')
    expect(botDisplayName(store.getState(), undefined)).toBeUndefined()
  })
})

describe('watermarks per conversation', () => {
  const KEY = 'researcher#sess-ideas'
  let storage = memoryStorage()
  let kv: WebKeyValueStore = createKeyValueStore({ namespace: '/', storage })

  beforeEach(async () => {
    storage = memoryStorage()
    kv = createKeyValueStore({ namespace: '/', storage })
    await store.getState().hydrateLastSeen(kv)
  })

  /** A reload: memory gone, a new store over the same `Storage`, the same gateway's keys read again. */
  const relaunch = async (): Promise<void> => {
    await new Promise(resolve => setTimeout(resolve, 0))
    store = createBotsStore()
    await store.getState().hydrateLastSeen(createKeyValueStore({ namespace: '/', storage }))
  }

  it('keeps an own chat’s watermark apart from the group chat’s', () => {
    store.getState().setBots([botFromProfileRow(PROFILE_ROW)])
    store.getState().markSeen(KEY, 1_800_000_000)

    expect(store.getState().lastSeen[KEY]).toBe(1_800_000_000)
    expect(isUnread(store.getState(), 'researcher')).toBe(true)
  })

  it('survives a relaunch, all three maps', async () => {
    store.getState().markSeen(KEY, 1_800_000_000)
    store.getState().markSeenCount(KEY, 5)
    store.getState().markOpened('sess-ideas', 1_800_000_100)
    await relaunch()

    expect(store.getState().lastSeen[KEY]).toBe(1_800_000_000)
    expect(store.getState().seenCounts[KEY]).toBe(5)
    expect(store.getState().lastOpened['sess-ideas']).toBe(1_800_000_100)
  })

  it('writes under the page’s namespace, as identity-bound keys a sign-out clears', async () => {
    store.getState().markSeen(KEY, 1_800_000_000)
    store.getState().markSeenCount(KEY, 5)
    store.getState().markOpened('sess-ideas', 1_800_000_100)
    await new Promise(resolve => setTimeout(resolve, 0))

    expect([...storage.entries.keys()].sort()).toEqual(
      [BOT_LAST_OPENED_KEY, BOT_LAST_SEEN_KEY, BOT_SEEN_COUNTS_KEY].map(key => `hermie:/:${key}`).sort()
    )

    kv.clearIdentityBound()

    expect(storage.entries.size).toBe(0)
  })

  it('writes nothing before it knows where to', async () => {
    const fresh = createBotsStore()

    fresh.getState().markSeen(KEY, 1_800_000_000)
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(fresh.getState().lastSeen[KEY]).toBe(1_800_000_000)
    expect(storage.entries.size).toBe(0)
  })

  it('reads a stored map defensively, keeping only finite numbers', async () => {
    storage.setItem(`hermie:/:${BOT_LAST_SEEN_KEY}`, JSON.stringify({ researcher: 5, writer: 'soon', other: null }))
    storage.setItem(`hermie:/:${BOT_SEEN_COUNTS_KEY}`, JSON.stringify([1, 2]))
    await relaunch()

    expect(store.getState().lastSeen).toEqual({ researcher: 5 })
    expect(store.getState().seenCounts).toEqual({})
  })

  it('calls an own chat unread by count, from zero when never read here', () => {
    expect(isOwnUnread(store.getState(), KEY, 0)).toBe(false)
    expect(isOwnUnread(store.getState(), KEY, 2)).toBe(true)

    store.getState().markSeenCount(KEY, 2)

    expect(isOwnUnread(store.getState(), KEY, 2)).toBe(false)
    expect(isOwnUnread(store.getState(), KEY, 3)).toBe(true)
  })

  it('lets a count go down, which a compressed session does', () => {
    store.getState().markSeenCount(KEY, 40)
    store.getState().markSeenCount(KEY, 12)

    expect(isOwnUnread(store.getState(), KEY, 13)).toBe(true)
  })

  it('never moves the last-opened stamp backwards', () => {
    store.getState().markOpened('sess-ideas', 2_000)
    store.getState().markOpened('sess-ideas', 1_000)

    expect(store.getState().lastOpened['sess-ideas']).toBe(2_000)
  })

  it('forgets every watermark of a deleted chat, and only those', async () => {
    store.getState().markSeen('researcher', 1_000)
    store.getState().markSeen(KEY, 1_000)
    store.getState().markSeenCount(KEY, 4)
    store.getState().markOpened('sess-ideas', 1_000)
    store.getState().forgetConversation(KEY, 'sess-ideas')
    await relaunch()

    expect(store.getState().lastSeen).toEqual({ researcher: 1_000 })
    expect(store.getState().seenCounts).toEqual({})
    expect(store.getState().lastOpened).toEqual({})
  })

  it('keeps where it writes across a reset: the gateway those watermarks belong to has not changed', async () => {
    store.getState().reset()
    store.getState().markSeen(KEY, 1_800_000_000)
    await relaunch()

    expect(store.getState().lastSeen[KEY]).toBe(1_800_000_000)
  })
})
