/**
 * Branching a conversation, and the parameter that does not exist.
 *
 * The brief for this round said to read "the exact params: session id, row
 * index/id, title" off `session.branch`. Two of those three are there.
 * `SessionBranchParams` is `{session_id, profile?, name?, count?}` — there is no
 * row index and no row id — so the assertions below pin the reading the app is
 * built on rather than a fact it was handed:
 *
 *   **`count` is how many of the parent's messages the child starts with**, and
 *   `branchCountFor` is what turns a transcript row into that number.
 *
 * That is an assumption. It has not been checked against a running gateway and
 * `docs/platform-notes.md` says so. What these tests genuinely prove is that the
 * app and the fake agree on ONE reading and that the arithmetic has exactly one
 * home — so the day somebody can run a real gateway, one number changes in one
 * place and these tests say whether anything else moved.
 *
 * Everything else here is not an assumption: that a branch is visible, that the
 * canonical chat is untouched, and that the canonical row can never be offered a
 * Delete are all properties this app owns.
 *
 * Ported from the Expo app's `__tests__/session-branch.test.ts` (jest) to vitest. Differences:
 * the vanilla stores (`chatsStore`, `botsStore`, `pluginStore`) for the hooks,
 * and the controller runs on `immediateFrames`, so every write it makes is
 * committed to the store at once and these assertions read the store exactly
 * as the Expo ones did. The frame batching itself is `ingest.test.ts`’s.
 *
 * One more: the block "the two places a branch is asked for" is left out. It
 * tests the message menu and the chat options popover, which are screens this
 * client does not have yet; they come with the chat screen (W-10b) and bring
 * their own tests.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { BotsController } from './bots-controller'
import { ChatController } from './chat-controller'
import { immediateFrames } from './ingest'
import {
  botOfConversationKey,
  branchCountFor,
  branchTitle,
  classifyConversations,
  conversationActions,
  conversationKey,
  isBranchTitle,
  isCanonicalKey,
  isRetiredTitle,
  storedIdOfConversationKey
} from './sessions/session-model'
import { MemoryChatCache } from '../platform/chat-cache'
import { botFromProfileRow, botsStore } from '../state/bots'
import { chatsStore } from '../state/chats'
import { FakeChatGateway } from '../test-support/fake-chat-gateway'

const CANONICAL = 'stored-canonical'
const BRANCH = 'stored-branch'

const RESEARCHER = botFromProfileRow({
  name: 'researcher',
  path: '/root/.hermes/profiles/researcher',
  display_name: 'Researcher',
  canonical_session: {
    id: CANONICAL,
    resolved_id: CANONICAL,
    title: 'Bot Chat',
    last_active: 1_700_000_100,
    message_count: 4
  }
})

const HISTORY = [
  { role: 'user', text: 'Which way should we take this?', row_id: 1, timestamp: 1_700_000_000 },
  { role: 'assistant', text: 'The first way.', row_id: 2, timestamp: 1_700_000_001 },
  { role: 'user', text: 'And the second?', row_id: 3, timestamp: 1_700_000_002 },
  { role: 'assistant', text: 'Also possible.', row_id: 4, timestamp: 1_700_000_003 }
]

const NOW = 1_790_000_000_000

const started: ChatController[] = []

function setup() {
  const gateway = new FakeChatGateway()
  const cache = new MemoryChatCache()
  const botsController = new BotsController({ gateway, store: botsStore, cache })
  const controller = new ChatController({
    frames: immediateFrames,
    gateway,
    chats: chatsStore,
    bots: botsStore,
    botsController,
    cache,
    now: () => NOW
  })

  gateway
    .reply('session.resume', params => ({
      session_id: params.session_id === BRANCH ? 'runtime-branch' : 'runtime-canonical',
      stored_session_id: String(params.session_id),
      message_count: params.session_id === BRANCH ? 2 : HISTORY.length,
      messages: [],
      messages_omitted: true,
      info: { desktop_contract: 7 },
      open_requests: []
    }))
    .reply('session.history', params => ({
      count: params.session_id === 'runtime-branch' ? 2 : HISTORY.length,
      messages: params.session_id === 'runtime-branch' ? HISTORY.slice(0, 2) : HISTORY
    }))
    .reply('session.events.since', {
      events: [],
      latest_seq: 7,
      truncated: false,
      count: 0,
      epoch: 'e1',
      open_requests: []
    })
    .reply('subagent.list', { subagents: [] })
    .reply('profiles.list', { profiles: [] })
    .reply('approval.pending', { approvals: [] })
    .reply('session.branch', params => ({
      session_id: 'runtime-branch',
      stored_session_id: BRANCH,
      title: String(params.name ?? ''),
      parent: CANONICAL,
      message_count: Number(params.count ?? 0),
      messages: [],
      info: { desktop_contract: 7 }
    }))

  botsStore.getState().setBots([RESEARCHER])
  gateway.restMessages = null
  started.push(controller)

  return { gateway, controller }
}

beforeEach(() => {
  chatsStore.getState().reset()
  botsStore.getState().reset()
})

afterEach(() => {
  for (const controller of started.splice(0)) {
    controller.stop()
  }
})

describe('the title a branch is born with', () => {
  it('is `Branch · <first words>` of the row it was taken from', () => {
    expect(branchTitle('Which way should we take this?')).toBe('Branch · Which way should we take this?')
  })

  /**
   * A branch taken from a fenced block would otherwise carry a newline. The
   * six-word cap bites before the blank line does, which is the point: what
   * comes out is one line either way.
   */
  it('collapses whitespace, so a code block does not put a newline in a title', () => {
    expect(branchTitle('const x = 1\n\nconst y = 2')).toBe('Branch · const x = 1 const y')
    expect(branchTitle('one\ttwo')).toBe('Branch · one two')
  })

  it('cuts on a word boundary rather than mid-word', () => {
    const title = branchTitle('antidisestablishmentarianism is a very long word indeed and then some')

    expect(title.endsWith('…')).toBe(false)
    expect(
      title
        .split(' · ')[1]
        ?.split(' ')
        .every(word => word.length > 0)
    ).toBe(true)
    expect(title.length).toBeLessThanOrEqual('Branch · '.length + 48)
  })

  /** A tool card has no words; the bare prefix is still a legal, findable title. */
  it('falls back to the bare prefix for a row with no words at all', () => {
    expect(branchTitle('   ')).toBe('Branch')
    expect(branchTitle('')).toBe('Branch')
  })

  it('recognises its own output, and a retired conversation, and neither the other', () => {
    expect(isBranchTitle(branchTitle('anything'))).toBe(true)
    expect(isBranchTitle('Branch')).toBe(true)
    expect(isBranchTitle('Bot Chat · 2026-09-22 11:04')).toBe(false)
    expect(isRetiredTitle('Bot Chat · 2026-09-22 11:04')).toBe(true)
    expect(isRetiredTitle(branchTitle('anything'))).toBe(false)
  })
})

describe('branching sends the only positional parameter the method has', () => {
  /**
   * The assumption, pinned as a number. If upstream turns out to mean "the last
   * `count` messages", this is the assertion that has to change — which is the
   * point of writing it down rather than leaving it in a comment.
   */
  it('sends the message count it was given, unchanged, with the runtime id', async () => {
    const { gateway, controller } = setup()

    await controller.openChat(RESEARCHER)
    await controller.branchFrom('researcher', { messageCount: 2, title: 'Branch · The first way.' })

    expect(gateway.lastCall('session.branch')).toMatchObject({
      session_id: 'runtime-canonical',
      profile: 'researcher',
      name: 'Branch · The first way.',
      count: 2
    })
  })

  /** A branch of nothing is not a branch; zero is floored to one. */
  it('never asks for zero messages', async () => {
    const { gateway, controller } = setup()

    await controller.openChat(RESEARCHER)
    await controller.branchFrom('researcher', { messageCount: 0, title: 'Branch · Which way' })

    expect(gateway.lastCall('session.branch')?.count).toBe(1)
  })

  /**
   * A transcript ITEM is not a gateway MESSAGE — `rowsToItems` projects one
   * persisted row onto several items, and a live item has no row at all — so the
   * count is taken off `rowId`, which the transcript carries straight off the
   * gateway's `row_id`. Counting items instead would count reasoning blocks and
   * DM cards as messages.
   */
  describe('the count a row stands for', () => {
    const items = [
      { id: 'a', rowId: 11 },
      // The same persisted row, projected onto a second item. One message.
      { id: 'a-reasoning', rowId: 11 },
      { id: 'b', rowId: 12 },
      { id: 'c', rowId: 19 },
      // Arrived live in this session; the gateway has not given it a row id yet.
      { id: 'd' }
    ]

    it('counts DISTINCT row ids at or before the row, not items', () => {
      expect(branchCountFor(items, 'a')).toBe(1)
      expect(branchCountFor(items, 'a-reasoning')).toBe(1)
      expect(branchCountFor(items, 'b')).toBe(2)
    })

    /** No assumption that row ids are 1-based or contiguous — only ascending. */
    it('does not assume row ids start at one or run without gaps', () => {
      expect(branchCountFor(items, 'c')).toBe(3)
    })

    it('counts a live row that has no id of its own', () => {
      expect(branchCountFor(items, 'd')).toBe(4)
    })

    /** The safer of the two wrong answers: branch everything, not nothing. */
    it('branches the whole conversation for a row that is not in the list', () => {
      expect(branchCountFor(items, 'nowhere')).toBe(4)
      expect(branchCountFor([], 'nowhere')).toBe(0)
    })
  })

  /**
   * The LIVE id. The contract's own description is "fork a live session", and
   * every session-scoped method upstream resolves through `_sess_nowait`, so a
   * stored id would come back 4001. This is the assertion that would have caught
   * it being sent.
   */
  it('addresses the runtime id and never the stored one', async () => {
    const { gateway, controller } = setup()

    await controller.openChat(RESEARCHER)
    await controller.branchFrom('researcher', { messageCount: 4, title: 'Branch · Also possible.' })

    expect(gateway.lastCall('session.branch')?.session_id).toBe('runtime-canonical')
    expect(gateway.lastCall('session.branch')?.session_id).not.toBe(CANONICAL)
  })

  /**
   * A name already worn is refused upstream and the branch keeps whatever it
   * ended up with. Reporting the asked-for name would send the reader looking
   * for a conversation under a title nothing holds.
   */
  it('reports the title the gateway settled on, not the one that was asked for', async () => {
    const { gateway, controller } = setup()

    gateway.reply('session.branch', {
      session_id: 'runtime-branch',
      stored_session_id: BRANCH,
      title: 'Branch · something else',
      parent: CANONICAL,
      message_count: 2,
      messages: [],
      info: { desktop_contract: 7 }
    })

    await controller.openChat(RESEARCHER)

    const branch = await controller.branchFrom('researcher', { messageCount: 2, title: 'Branch · asked for' })

    expect(branch.title).toBe('Branch · something else')
    expect(branch.id).toBe(BRANCH)
    expect(branch.kind).toBe('branch')
  })

  it('refuses a branch the gateway answered without an id', async () => {
    const { gateway, controller } = setup()

    gateway.reply('session.branch', { session_id: 'runtime-branch', title: 'Branch · x' })
    await controller.openChat(RESEARCHER)

    await expect(controller.branchFrom('researcher', { messageCount: 1, title: 'Branch · x' })).rejects.toThrow(
      /without returning its id/u
    )
  })

  /**
   * The whole of the request, and the part a reader would actually notice going
   * wrong: the chat they were in has to be exactly as they left it.
   */
  it('leaves the canonical chat untouched — same session, same rows, still hidden', async () => {
    const { gateway, controller } = setup()

    await controller.openChat(RESEARCHER)

    const before = chatsStore.getState().chats.researcher!

    await controller.branchFrom('researcher', { messageCount: 2, title: 'Branch · The first way.' })

    const after = chatsStore.getState().chats.researcher!

    expect(after.runtimeSessionId).toBe(before.runtimeSessionId)
    expect(after.storedSessionId).toBe(CANONICAL)
    expect(after.order).toEqual(before.order)
    // Nothing was renamed and nothing was un-hidden: those two are what `/new`
    // does to retire a conversation, and a branch retires nothing.
    expect(gateway.methodOrder()).not.toContain('session.title')
    expect(gateway.methodOrder()).not.toContain('session.set_hidden')
  })
})

describe('a branch opens as a chat of its own', () => {
  it('is held under a key that cannot collide with the canonical chat', async () => {
    const { controller } = setup()

    await controller.openChat(RESEARCHER)
    await controller.openConversation(RESEARCHER, BRANCH)

    const chats = chatsStore.getState().chats
    const key = conversationKey('researcher', BRANCH)

    expect(key).toBe(`researcher#${BRANCH}`)
    expect(chats[key]?.storedSessionId).toBe(BRANCH)
    expect(chats[key]?.runtimeSessionId).toBe('runtime-branch')
    // And the canonical chat is still its own transcript under its own key.
    expect(chats.researcher?.storedSessionId).toBe(CANONICAL)
    expect(chats.researcher?.runtimeSessionId).toBe('runtime-canonical')
  })

  it('resumes the stored id it was handed, and replays into its own transcript', async () => {
    const { gateway, controller } = setup()

    await controller.openConversation(RESEARCHER, BRANCH)

    expect(gateway.lastCall('session.resume')?.session_id).toBe(BRANCH)

    const chat = chatsStore.getState().chats[conversationKey('researcher', BRANCH)]!

    expect(chat.hydration).toBe('live')
    expect(chat.order.length).toBe(2)
  })

  /**
   * The unread badge is about the Bot Chat. Reading a branch is not reading what
   * arrived in the chat the badge counts, so `markSeen` is the one step of the
   * open path a branch deliberately skips.
   */
  it('does not clear the bot’s unread watermark', async () => {
    const { controller } = setup()

    const seenBefore = botsStore.getState().lastSeen.researcher

    await controller.openConversation(RESEARCHER, BRANCH)

    expect(botsStore.getState().lastSeen.researcher).toBe(seenBefore)
  })

  it('reads a key back to the bot and the stored id it names', () => {
    const key = conversationKey('researcher', BRANCH)

    expect(botOfConversationKey(key)).toBe('researcher')
    expect(storedIdOfConversationKey(key)).toBe(BRANCH)
    expect(isCanonicalKey(key)).toBe(false)

    expect(botOfConversationKey('researcher')).toBe('researcher')
    expect(storedIdOfConversationKey('researcher')).toBeNull()
    expect(isCanonicalKey('researcher')).toBe(true)
  })
})

describe('the canonical chat is a type, not a check', () => {
  const rows = [
    { id: CANONICAL, resolved_id: CANONICAL, title: 'Bot Chat', message_count: 4, started_at: 100 },
    { id: BRANCH, resolved_id: BRANCH, title: 'Branch · The first way.', message_count: 2, started_at: 200 },
    { id: 'stored-retired', title: 'Bot Chat · 2026-09-20 11:04', message_count: 9, started_at: 50 }
  ]

  it('sorts a listing into the three groups the page draws', () => {
    const groups = classifyConversations({ rows, canonicalId: CANONICAL })

    expect(groups.canonical?.id).toBe(CANONICAL)
    expect(groups.branches.map(row => row.id)).toEqual([BRANCH])
    expect(groups.past.map(row => row.id)).toEqual(['stored-retired'])
  })

  /**
   * The id wins over the title, because a title can be typed by hand. A reader
   * who names a past conversation `Bot Chat` while it is visible must not thereby
   * move the one row that may never be deleted.
   */
  it('finds the canonical row by id even when another row wears its name', () => {
    const groups = classifyConversations({
      rows: [...rows, { id: 'stored-impostor', title: 'Bot Chat', message_count: 1, started_at: 300 }],
      canonicalId: CANONICAL
    })

    expect(groups.canonical?.id).toBe(CANONICAL)
    expect(groups.past.map(row => row.id)).toContain('stored-impostor')
  })

  it('falls back to the title where the roster has resolved no canonical id yet', () => {
    expect(classifyConversations({ rows }).canonical?.id).toBe(CANONICAL)
  })

  it('offers the canonical row NOTHING, and every other row the four actions', () => {
    const groups = classifyConversations({ rows, canonicalId: CANONICAL })

    expect(conversationActions(groups.canonical!)).toEqual([])
    expect(conversationActions(groups.branches[0]!)).toEqual(['open', 'rename', 'delete', 'adopt'])
    expect(conversationActions(groups.past[0]!)).toEqual(['open', 'rename', 'delete', 'adopt'])
  })

  it('sorts each group newest first, with the title as a total tie-break', () => {
    const groups = classifyConversations({
      rows: [
        { id: 'b', title: 'Branch · b', started_at: 0 },
        { id: 'a', title: 'Branch · a', started_at: 0 },
        { id: 'c', title: 'Branch · c', started_at: 500 }
      ],
      canonicalId: CANONICAL
    })

    expect(groups.branches.map(row => row.id)).toEqual(['c', 'a', 'b'])
  })

  it('drops a row with no id, and names a row the gateway never titled', () => {
    const groups = classifyConversations({
      rows: [{ id: '', title: 'Branch · nowhere' }, { id: 'stored-untitled' }],
      canonicalId: CANONICAL
    })

    expect(groups.branches).toEqual([])
    expect(groups.past.map(row => row.title)).toEqual(['stored-untitled'])
  })
})
