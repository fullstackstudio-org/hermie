import {
  BotsController,
  runningBotsIn,
  sessionOwnerIndex,
  type ChatSessionIds
} from '../src/features/bots/bots-controller'
import { MemoryChatCache } from '../src/platform/chat-cache'
import { namespace } from '../src/gateway/namespace'
import { keyValueStore } from '../src/platform/key-value-store'
import {
  BOT_LAST_OPENED_KEY,
  BOT_LAST_SEEN_KEY,
  BOT_SEEN_COUNTS_KEY,
  botFromProfileRow,
  isOwnUnread,
  isUnread,
  useBotsStore
} from '../src/store/bots'
import { FakeChatGateway } from './support/fake-chat-gateway'

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

/** The second bot, so "one busy session" has somebody else to wrongly light up. */
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

/**
 * One `session.active_list` row, shaped as `server.py::_session_live_item` shapes
 * one: `id` is the RUNTIME session id, `session_key` the stored/lineage one, the
 * title is the same `Bot Chat` on every profile, and there is no profile field
 * anywhere on it.
 */
const activeRow = (over: { id: string; session_key: string; status?: string }) => ({
  current: false,
  last_active: 1_700_000_200,
  message_count: 7,
  model: 'example-provider/example-model',
  preview: 'Working on it.',
  started_at: 1_700_000_000,
  status: 'working',
  title: 'Bot Chat',
  ...over
})

function setup(chats?: Record<string, ChatSessionIds>) {
  const gateway = new FakeChatGateway()
  const cache = new MemoryChatCache()
  const controller = new BotsController({
    gateway,
    store: useBotsStore,
    cache,
    ...(chats ? { chats: { getState: () => ({ chats }) } } : {})
  })

  return { gateway, cache, controller }
}

beforeEach(() => {
  useBotsStore.getState().reset()
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

describe('the roster', () => {
  it('loads profiles and caches them for the next cold start', async () => {
    const { gateway, cache, controller } = setup()

    gateway.reply('profiles.list', { profiles: [PROFILE_ROW] })
    gateway.reply('profiles.get_asset', { found: true, data: 'data:image/png;base64,AAA' })

    await controller.refresh()

    expect(gateway.lastCall('profiles.list')).toEqual({ include_sessions: true })
    expect(useBotsStore.getState().bots).toHaveLength(1)
    await expect(cache.readBots()).resolves.toHaveLength(1)
  })

  it('fetches an avatar once per revision', async () => {
    const { gateway, controller } = setup()

    gateway.reply('profiles.list', { profiles: [PROFILE_ROW] })
    gateway.reply('profiles.get_asset', { found: true, data: 'data:image/png;base64,AAA' })

    await controller.refresh()
    await controller.loadAvatars(useBotsStore.getState().bots)

    expect(gateway.calls.filter(call => call.method === 'profiles.get_asset')).toHaveLength(1)
    expect(gateway.lastCall('profiles.get_asset')).toEqual({ name: 'researcher', asset: 'avatar' })
    expect(useBotsStore.getState().avatars.researcher).toBe('data:image/png;base64,AAA')
  })

  it('paints the cached roster before the gateway answers', async () => {
    const { cache, controller } = setup()

    await cache.writeBots([
      {
        name: 'writer',
        json: JSON.stringify(botFromProfileRow({ name: 'writer', path: '/p' })),
        avatarRev: 0,
        updatedAt: 1
      }
    ])

    await controller.paintFromCache()

    expect(useBotsStore.getState().bots.map(bot => bot.name)).toEqual(['writer'])
    // A cache paint is not a refresh: nothing has been read from the gateway.
    expect(useBotsStore.getState().refreshedAt).toBeNull()
  })

  it('marks a bot as running while its profile has a busy session', async () => {
    const { gateway, controller } = setup()

    gateway.reply('profiles.list', { profiles: [PROFILE_ROW] })
    gateway.reply('profiles.get_asset', { found: false })
    gateway.reply('session.active_list', {
      sessions: [activeRow({ id: 'runtime-researcher', session_key: 'stored-researcher' })]
    })

    await controller.refresh()
    await controller.refreshRunning()

    expect(useBotsStore.getState().running).toEqual({ researcher: true })
  })

  it('treats a bot whose active list fails as idle rather than as an error', async () => {
    const { gateway, controller } = setup()

    gateway.reply('profiles.list', { profiles: [PROFILE_ROW] })
    gateway.reply('profiles.get_asset', { found: false })
    gateway.reply('session.active_list', () => {
      throw new Error('backend restarting')
    })

    await controller.refresh()
    await controller.refreshRunning()

    expect(useBotsStore.getState().running).toEqual({})
    expect(useBotsStore.getState().error).toBeNull()
  })
})

/**
 * The bug the owner reported: he asked ONE bot something and every row in the
 * chat list grew the working bead.
 *
 * `session.active_list` is not profile-scoped. Upstream it is a plain method
 * over every live session in the gateway PROCESS and it never reads the
 * `profile` it accepts (`tui_gateway/methods_session.py`), so the old code —
 * one call per bot, busy if any row came back — could only ever answer the same
 * thing for every bot at once. The fake gateway used to filter on `profile` and
 * so agreed with it; `packages/fake-gateway/src/upstream-shapes.test.ts` now
 * holds the real behaviour still.
 *
 * Every row below is therefore the WHOLE process's answer, handed to each test
 * unfiltered, exactly as a real gateway hands it over.
 */
describe('attributing a busy session to one bot', () => {
  const rosterOf = (gateway: FakeChatGateway, sessions: unknown[]) => {
    gateway.reply('profiles.list', { profiles: [PROFILE_ROW, WRITER_ROW] })
    gateway.reply('profiles.get_asset', { found: false })
    gateway.reply('session.active_list', { sessions })
  }

  it('lights up only the bot whose session is busy, not every bot in the roster', async () => {
    const { gateway, controller } = setup()

    rosterOf(gateway, [activeRow({ id: 'runtime-researcher', session_key: 'stored-researcher' })])

    await controller.refresh()
    await controller.refreshRunning()

    expect(useBotsStore.getState().running).toEqual({ researcher: true })
  })

  it('asks once per poll, not once per bot', async () => {
    const { gateway, controller } = setup()

    rosterOf(gateway, [activeRow({ id: 'runtime-writer', session_key: 'stored-writer' })])

    await controller.refresh()
    await controller.refreshRunning()

    expect(gateway.calls.filter(call => call.method === 'session.active_list')).toHaveLength(1)
    expect(useBotsStore.getState().running).toEqual({ writer: true })
  })

  it('sends no profile, because the call does not scope on one', async () => {
    const { gateway, controller } = setup()

    rosterOf(gateway, [])

    await controller.refresh()
    await controller.refreshRunning()

    expect(gateway.lastCall('session.active_list')).not.toHaveProperty('profile')
  })

  /**
   * The gateway hosts sessions this app never opened — another client's TUI, a
   * cron run, a sub-agent. None of them is a bot's forever-chat, and guessing
   * one onto a bot is the bug over again in the other direction.
   */
  it('lights up nobody for a busy session it cannot place', async () => {
    const { gateway, controller } = setup()

    rosterOf(gateway, [
      activeRow({ id: 'cron_job-digest_1700000000', session_key: 'cron_job-digest_1700000000' }),
      activeRow({ id: 'runtime-somebody-elses-tui', session_key: 'stored-unknown' })
    ])

    await controller.refresh()
    await controller.refreshRunning()

    expect(useBotsStore.getState().running).toEqual({})
  })

  /** `title` is `Bot Chat` on every profile, so it can never be the discriminator. */
  it('does not attribute on the title every bot shares', async () => {
    const { gateway, controller } = setup()

    rosterOf(gateway, [activeRow({ id: 'runtime-unknown', session_key: 'stored-unknown', status: 'working' })])

    await controller.refresh()
    await controller.refreshRunning()

    expect(useBotsStore.getState().running).toEqual({})
  })

  it('places a session by the runtime id the open chat is bound to', async () => {
    const { gateway, controller } = setup({
      writer: { storedSessionId: 'rebuilt-writer', resolvedSessionId: 'rebuilt-writer', runtimeSessionId: 'runtime-42' }
    })

    // Neither id is on the roster row: the gateway rebuilt the session, so only
    // the open chat knows what it is called now.
    rosterOf(gateway, [activeRow({ id: 'runtime-42', session_key: 'rebuilt-writer' })])

    await controller.refresh()
    await controller.refreshRunning()

    expect(useBotsStore.getState().running).toEqual({ writer: true })
  })

  it('counts two busy bots as two, and leaves a third idle', async () => {
    const { gateway, controller } = setup()

    rosterOf(gateway, [
      activeRow({ id: 'runtime-researcher', session_key: 'stored-researcher' }),
      activeRow({ id: 'runtime-writer', session_key: 'tip-writer' })
    ])

    await controller.refresh()
    await controller.refreshRunning()

    expect(useBotsStore.getState().running).toEqual({ researcher: true, writer: true })
  })

  it('ignores a row the gateway calls idle', async () => {
    const { gateway, controller } = setup()

    rosterOf(gateway, [activeRow({ id: 'runtime-researcher', session_key: 'stored-researcher', status: 'idle' })])

    await controller.refresh()
    await controller.refreshRunning()

    expect(useBotsStore.getState().running).toEqual({})
  })

  /** A bot parked on an approval is working; showing it idle is how a question waits an hour. */
  it('treats waiting as busy, the way the status set says', async () => {
    const { gateway, controller } = setup()

    rosterOf(gateway, [activeRow({ id: 'runtime-researcher', session_key: 'stored-researcher', status: 'waiting' })])

    await controller.refresh()
    await controller.refreshRunning()

    expect(useBotsStore.getState().running).toEqual({ researcher: true })
  })
})

describe('the session owner index', () => {
  const bots = [botFromProfileRow(PROFILE_ROW), botFromProfileRow(WRITER_ROW)]

  it('claims the stored id and the lineage tip from the roster alone', () => {
    const owners = sessionOwnerIndex(bots)

    expect(owners.get('stored-researcher')).toBe('researcher')
    expect(owners.get('tip-researcher')).toBe('researcher')
    expect(owners.get('stored-writer')).toBe('writer')
    expect(owners.get('tip-writer')).toBe('writer')
  })

  it('adds the runtime id the open chat is bound to', () => {
    const owners = sessionOwnerIndex(bots, { writer: { runtimeSessionId: 'runtime-7' } })

    expect(owners.get('runtime-7')).toBe('writer')
  })

  /** A stale id must not steal a row from the bot that actually holds it. */
  it('keeps the first claim on an id it sees twice', () => {
    const owners = sessionOwnerIndex(bots, { writer: { storedSessionId: 'stored-researcher' } })

    expect(owners.get('stored-researcher')).toBe('researcher')
  })

  it('reports nothing for an empty roster', () => {
    expect(runningBotsIn([activeRow({ id: 'a', session_key: 'b' })] as never, sessionOwnerIndex([]))).toEqual([])
  })
})

describe('unread', () => {
  it('is set while the chat moved after the user last looked at it', () => {
    useBotsStore.getState().setBots([botFromProfileRow(PROFILE_ROW)])

    expect(isUnread(useBotsStore.getState(), 'researcher')).toBe(true)

    useBotsStore.getState().markSeen('researcher')

    expect(isUnread(useBotsStore.getState(), 'researcher')).toBe(false)
  })

  it('never moves the watermark backwards', () => {
    useBotsStore.getState().setBots([botFromProfileRow(PROFILE_ROW)])
    useBotsStore.getState().markSeen('researcher', 2_000)
    useBotsStore.getState().markSeen('researcher', 1_000)

    expect(useBotsStore.getState().lastSeen.researcher).toBe(2_000)
  })
})

describe('the conversation a bot is on', () => {
  const OWN = { id: 'sess-ideas', resolvedId: 'sess-ideas', preview: 'An idea.', lastActive: 0, messageCount: 3 }

  it('binds the bot to an own chat and leaves the group chat where it was', () => {
    useBotsStore.getState().setBots([botFromProfileRow(PROFILE_ROW)])
    useBotsStore.getState().setCurrent('researcher', OWN)

    const bot = useBotsStore.getState().byName.researcher

    expect(bot?.current).toEqual(OWN)
    expect(bot?.canonical?.id).toBe('stored-researcher')
    // No pin: the canonical still names the Bot Chat, so nothing waits on the
    // roster to agree with anything.
    expect(useBotsStore.getState().canonicalPins).toEqual({})
    expect(useBotsStore.getState().bots[0]?.current).toEqual(OWN)
  })

  it('survives the next roster answer, which knows nothing about readers', () => {
    useBotsStore.getState().setBots([botFromProfileRow(PROFILE_ROW)])
    useBotsStore.getState().setCurrent('researcher', OWN)
    useBotsStore.getState().setBots([botFromProfileRow(PROFILE_ROW), botFromProfileRow(WRITER_ROW)])

    expect(useBotsStore.getState().byName.researcher?.current).toEqual(OWN)
    expect(useBotsStore.getState().byName.writer?.current).toBeUndefined()
  })

  it('holds a choice made before the roster placed the bot', () => {
    useBotsStore.getState().setCurrent('researcher', OWN)
    useBotsStore.getState().setBots([botFromProfileRow(PROFILE_ROW)])

    expect(useBotsStore.getState().byName.researcher?.current).toEqual(OWN)
  })

  it('goes back to the group chat on null, and stays there across a roster answer', () => {
    useBotsStore.getState().setBots([botFromProfileRow(PROFILE_ROW)])
    useBotsStore.getState().setCurrent('researcher', OWN)
    useBotsStore.getState().setCurrent('researcher', null)

    expect(useBotsStore.getState().byName.researcher).not.toHaveProperty('current')

    useBotsStore.getState().setBots([botFromProfileRow(PROFILE_ROW)])

    expect(useBotsStore.getState().byName.researcher).not.toHaveProperty('current')
  })

  it('keeps the group chat unread rule on the canonical while parked', () => {
    useBotsStore.getState().setBots([botFromProfileRow(PROFILE_ROW)])
    useBotsStore.getState().markSeen('researcher')
    useBotsStore.getState().setCurrent('researcher', { ...OWN, lastActive: 1_800_000_000 })

    // The own chat moving is not the group chat moving.
    expect(isUnread(useBotsStore.getState(), 'researcher')).toBe(false)
  })
})

describe('watermarks per conversation', () => {
  const NS = namespace('gwatermarks00000')
  const KEY = 'researcher#sess-ideas'

  beforeEach(async () => {
    for (const key of [BOT_LAST_SEEN_KEY, BOT_SEEN_COUNTS_KEY, BOT_LAST_OPENED_KEY]) {
      await keyValueStore.delete(NS.key(key))
    }

    await useBotsStore.getState().hydrateLastSeen(NS)
  })

  /** A relaunch: memory gone, the same gateway's disk read again. */
  const relaunch = async (): Promise<void> => {
    await new Promise(resolve => setTimeout(resolve, 0))
    useBotsStore.setState({ lastSeen: {}, seenCounts: {}, lastOpened: {} })
    await useBotsStore.getState().hydrateLastSeen(NS)
  }

  it('keeps an own chat’s watermark apart from the group chat’s', () => {
    useBotsStore.getState().setBots([botFromProfileRow(PROFILE_ROW)])
    useBotsStore.getState().markSeen(KEY, 1_800_000_000)

    expect(useBotsStore.getState().lastSeen[KEY]).toBe(1_800_000_000)
    expect(isUnread(useBotsStore.getState(), 'researcher')).toBe(true)
  })

  it('survives a relaunch, all three maps', async () => {
    useBotsStore.getState().markSeen(KEY, 1_800_000_000)
    useBotsStore.getState().markSeenCount(KEY, 5)
    useBotsStore.getState().markOpened('sess-ideas', 1_800_000_100)
    await relaunch()

    expect(useBotsStore.getState().lastSeen[KEY]).toBe(1_800_000_000)
    expect(useBotsStore.getState().seenCounts[KEY]).toBe(5)
    expect(useBotsStore.getState().lastOpened['sess-ideas']).toBe(1_800_000_100)
  })

  it('calls an own chat unread by count, from zero when never read here', () => {
    expect(isOwnUnread(useBotsStore.getState(), KEY, 0)).toBe(false)
    expect(isOwnUnread(useBotsStore.getState(), KEY, 2)).toBe(true)

    useBotsStore.getState().markSeenCount(KEY, 2)

    expect(isOwnUnread(useBotsStore.getState(), KEY, 2)).toBe(false)
    expect(isOwnUnread(useBotsStore.getState(), KEY, 3)).toBe(true)
  })

  it('lets a count go down, which a compressed session does', () => {
    useBotsStore.getState().markSeenCount(KEY, 40)
    useBotsStore.getState().markSeenCount(KEY, 12)

    expect(isOwnUnread(useBotsStore.getState(), KEY, 13)).toBe(true)
  })

  it('never moves the last-opened stamp backwards', () => {
    useBotsStore.getState().markOpened('sess-ideas', 2_000)
    useBotsStore.getState().markOpened('sess-ideas', 1_000)

    expect(useBotsStore.getState().lastOpened['sess-ideas']).toBe(2_000)
  })

  it('forgets every watermark of a deleted chat, and only those', async () => {
    useBotsStore.getState().markSeen('researcher', 1_000)
    useBotsStore.getState().markSeen(KEY, 1_000)
    useBotsStore.getState().markSeenCount(KEY, 4)
    useBotsStore.getState().markOpened('sess-ideas', 1_000)
    useBotsStore.getState().forgetConversation(KEY, 'sess-ideas')
    await relaunch()

    expect(useBotsStore.getState().lastSeen).toEqual({ researcher: 1_000 })
    expect(useBotsStore.getState().seenCounts).toEqual({})
    expect(useBotsStore.getState().lastOpened).toEqual({})
  })
})

describe('canonical chat resolution', () => {
  it('uses the roster row when the gateway already resolved it', async () => {
    const { gateway, controller } = setup()

    const canonical = await controller.resolveCanonical(botFromProfileRow(PROFILE_ROW))

    expect(canonical.id).toBe('stored-researcher')
    expect(gateway.calls).toHaveLength(0)
  })

  it('looks the chat up by exact title, including hidden sessions', async () => {
    const { gateway, controller } = setup()

    gateway.reply('session.list', {
      sessions: [{ id: 'stored-x', resolved_id: 'tip-x', title: 'Bot Chat', message_count: 4 }]
    })

    const canonical = await controller.resolveCanonical(botFromProfileRow({ name: 'writer', path: '/p' }))

    expect(gateway.lastCall('session.list')).toMatchObject({
      profile: 'writer',
      title: 'Bot Chat',
      include_hidden: true
    })
    expect(canonical).toMatchObject({ id: 'stored-x', resolvedId: 'tip-x' })
    expect(gateway.methodOrder()).not.toContain('session.create')
  })

  it('re-runs the lookup before minting, so a chat created meanwhile is adopted', async () => {
    const { gateway, controller } = setup()
    let attempt = 0

    gateway.reply('session.list', () => {
      attempt += 1

      return attempt === 1 ? { sessions: [] } : { sessions: [{ id: 'stored-late', title: 'Bot Chat' }] }
    })

    const canonical = await controller.resolveCanonical(botFromProfileRow({ name: 'writer', path: '/p' }))

    expect(canonical.id).toBe('stored-late')
    expect(gateway.methodOrder()).toEqual(['session.list', 'session.list'])
  })

  it('creates the chat hidden, titled and following the profile config', async () => {
    const { gateway, controller } = setup()

    gateway.reply('session.list', { sessions: [] })
    gateway.reply('session.create', { session_id: 'runtime-new', stored_session_id: 'stored-new' })

    const canonical = await controller.resolveCanonical(botFromProfileRow({ name: 'writer', path: '/p' }))

    expect(canonical.id).toBe('stored-new')
    expect(gateway.lastCall('session.create')).toMatchObject({
      profile: 'writer',
      title: 'Bot Chat',
      hidden: true,
      source: 'hermie',
      cols: 96,
      follow_profile_config: true
    })
  })

  it('fails closed when the registry lookup errors instead of minting a second chat', async () => {
    const { gateway, controller } = setup()

    gateway.reply('session.list', () => {
      throw new Error('backend restarting')
    })

    await expect(controller.resolveCanonical(botFromProfileRow({ name: 'writer', path: '/p' }))).rejects.toThrow(
      /not starting a new chat/
    )
    expect(gateway.methodOrder()).not.toContain('session.create')
  })

  it('resolves a bot once even when two taps land together', async () => {
    const { gateway, controller } = setup()

    gateway.reply('session.list', { sessions: [] })
    gateway.reply('session.create', { stored_session_id: 'stored-once' })

    const bot = botFromProfileRow({ name: 'writer', path: '/p' })
    const [first, second] = await Promise.all([controller.resolveCanonical(bot), controller.resolveCanonical(bot)])

    expect(first).toEqual(second)
    expect(gateway.calls.filter(call => call.method === 'session.create')).toHaveLength(1)
  })
})
