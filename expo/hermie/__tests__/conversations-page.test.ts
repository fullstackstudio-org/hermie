/**
 * The Conversations page's four actions, at the controller.
 *
 * Three of them are one round trip and their whole content is WHICH ID they
 * send: `session.title` is session-scoped upstream and takes a runtime id,
 * `session.delete`'s own doc comment says "the STORED id", and getting that pair
 * the wrong way round is a mistake no green suite would otherwise catch — the
 * fake refuses each with 4001, and so would a real gateway.
 *
 * The fourth, "Make this the Bot Chat", is a SWAP with a rollback, and the
 * refusal path is the reason it is a swap at all: the title is the registry key,
 * so while the outgoing chat still wears `Bot Chat` the incoming one cannot take
 * it, and a gateway that refuses the second rename must not be allowed to leave
 * the bot with no canonical chat at all. That is the one failure here that would
 * cost a reader their conversation, so it is the one tested hardest.
 */
import { BotsController } from '../src/features/bots/bots-controller'
import { ChatController } from '../src/features/chats/chat-controller'
import { conversationActions } from '../src/features/sessions/session-model'
import { MemoryChatCache } from '../src/platform/chat-cache'
import { botFromProfileRow, useBotsStore } from '../src/store/bots'
import { useChatsStore } from '../src/store/chats'
import { FakeChatGateway } from './support/fake-chat-gateway'

const CANONICAL = 'stored-canonical'
const PAST = 'stored-past'

const RESEARCHER = botFromProfileRow({
  name: 'researcher',
  path: '/root/.hermes/profiles/researcher',
  display_name: 'Researcher',
  canonical_session: {
    id: CANONICAL,
    resolved_id: CANONICAL,
    title: 'Bot Chat',
    last_active: 1_700_000_100,
    message_count: 2
  }
})

const NOW = 1_790_000_000_000

const started: ChatController[] = []

function setup() {
  const gateway = new FakeChatGateway()
  const cache = new MemoryChatCache()
  const botsController = new BotsController({ gateway, store: useBotsStore, cache })
  const controller = new ChatController({
    gateway,
    chats: useChatsStore,
    bots: useBotsStore,
    botsController,
    cache,
    now: () => NOW
  })

  gateway
    .reply('session.resume', params => ({
      // Two sessions behind one responder, so every later assertion about which
      // one a call addressed reads one of these two strings.
      session_id: params.session_id === PAST ? 'runtime-past' : 'runtime-canonical',
      stored_session_id: String(params.session_id),
      message_count: 2,
      messages: [],
      messages_omitted: true,
      info: { desktop_contract: 7 },
      open_requests: []
    }))
    .reply('session.history', { count: 0, messages: [] })
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
    .reply('session.list', {
      sessions: [
        { id: CANONICAL, resolved_id: CANONICAL, title: 'Bot Chat', message_count: 2, started_at: 400 },
        { id: 'stored-branch', title: 'Branch · a thought', message_count: 5, started_at: 300 },
        { id: PAST, title: 'Bot Chat · 2026-09-20 11:04', message_count: 9, started_at: 200 }
      ]
    })
    .reply('session.title', params => ({ pending: false, title: String(params.title ?? ''), session_key: PAST }))
    .reply('session.set_hidden', params => ({ hidden: params.hidden === true, session_key: PAST }))
    .reply('session.delete', params => ({ deleted: String(params.session_id) }))

  useBotsStore.getState().setBots([RESEARCHER])
  gateway.restMessages = null
  started.push(controller)

  return { gateway, controller }
}

beforeEach(() => {
  useChatsStore.getState().reset()
  useBotsStore.getState().reset()
})

afterEach(() => {
  for (const controller of started.splice(0)) {
    controller.stop()
  }
})

describe('reading the list', () => {
  /**
   * `include_hidden` is not a convenience on this call. The canonical chat is
   * hidden by definition (ADR-0007), so without it the listing is missing the
   * one row the reader is actually in.
   */
  it('asks for the hidden sessions too, per profile', async () => {
    const { gateway, controller } = setup()

    await controller.listConversations('researcher')

    expect(gateway.lastCall('session.list')).toMatchObject({ profile: 'researcher', include_hidden: true })
  })

  it('groups the answer into the three the page draws', async () => {
    const { controller } = setup()
    const groups = await controller.listConversations('researcher')

    expect(groups.canonical?.id).toBe(CANONICAL)
    expect(groups.branches.map(row => row.title)).toEqual(['Branch · a thought'])
    expect(groups.past.map(row => row.id)).toEqual([PAST])
  })

  /** The whole of the ADR-0007 guard, and it is a type rather than a check. */
  it('offers the current Bot Chat no actions at all', async () => {
    const { controller } = setup()
    const groups = await controller.listConversations('researcher')

    expect(conversationActions(groups.canonical!)).toEqual([])
    expect(conversationActions(groups.past[0]!)).toContain('delete')
  })
})

describe('rename', () => {
  /**
   * `session.title` is `_with_db(session_scoped=True)` over `_sess_nowait`, so a
   * stored id — which is the only id a listing hands out — comes back 4001. The
   * conversation is resumed first to get a runtime one.
   */
  it('resumes the stored conversation and titles the RUNTIME id', async () => {
    const { gateway, controller } = setup()

    await controller.renameConversation('researcher', PAST, 'Last Tuesday')

    expect(gateway.lastCall('session.resume')?.session_id).toBe(PAST)
    expect(gateway.lastCall('session.title')).toMatchObject({
      session_id: 'runtime-past',
      profile: 'researcher',
      title: 'Last Tuesday'
    })
  })

  /** Already running: no second resume, because resuming costs a rebuild. */
  it('uses a runtime id the app already holds rather than resuming again', async () => {
    const { gateway, controller } = setup()

    await controller.openConversation(RESEARCHER, PAST)

    const resumes = gateway.methodOrder().filter(method => method === 'session.resume').length

    await controller.renameConversation('researcher', PAST, 'Last Tuesday')

    expect(gateway.methodOrder().filter(method => method === 'session.resume')).toHaveLength(resumes)
    expect(gateway.lastCall('session.title')?.session_id).toBe('runtime-past')
  })

  /** The gateway's three refusals are the caller's to show; nothing is swallowed. */
  it('lets the gateway’s refusal through', async () => {
    const { gateway, controller } = setup()

    gateway.reply('session.title', () => {
      throw new Error("Title 'Bot Chat' is already in use by session stored-canonical")
    })

    await expect(controller.renameConversation('researcher', PAST, 'Bot Chat')).rejects.toThrow(/already in use/u)
  })

  it('reports the title the gateway settled on', async () => {
    const { controller } = setup()

    expect(await controller.renameConversation('researcher', PAST, 'Last Tuesday')).toBe('Last Tuesday')
  })
})

describe('delete', () => {
  /** The opposite id to rename, and the contract says so in one line. */
  it('sends the STORED id, never a runtime one', async () => {
    const { gateway, controller } = setup()

    await controller.openConversation(RESEARCHER, PAST)
    await controller.deleteConversation('researcher', PAST)

    expect(gateway.lastCall('session.delete')).toMatchObject({ session_id: PAST, profile: 'researcher' })
    expect(gateway.lastCall('session.delete')?.session_id).not.toBe('runtime-past')
  })
})

describe('making a past conversation the Bot Chat', () => {
  /**
   * Retire-then-adopt, and the order is load-bearing: the title is the registry
   * key, so a second `Bot Chat` while the first still wears the name is refused
   * outright upstream.
   */
  it('retires the current chat before the incoming one takes the title', async () => {
    const { gateway, controller } = setup()

    await controller.openChat(RESEARCHER)
    await controller.adoptAsCanonical('researcher', PAST)

    const titles = gateway.callsOf('session.title').map(call => ({ id: call.session_id, title: call.title }))

    expect(titles[0]?.id).toBe('runtime-canonical')
    expect(String(titles[0]?.title)).toMatch(/^Bot Chat · /u)
    expect(titles[1]).toEqual({ id: 'runtime-past', title: 'Bot Chat' })
  })

  /**
   * Unhidden first, because upstream refuses to rename a HIDDEN `Bot Chat` away
   * from its name — the guard `/new` already has to get past.
   */
  it('takes the outgoing chat out of hiding before renaming it', async () => {
    const { gateway, controller } = setup()

    await controller.openChat(RESEARCHER)
    await controller.adoptAsCanonical('researcher', PAST)

    const order = gateway.methodOrder().filter(method => ['session.set_hidden', 'session.title'].includes(method))

    expect(order[0]).toBe('session.set_hidden')
    expect(gateway.callsOf('session.set_hidden')[0]).toMatchObject({
      session_id: 'runtime-canonical',
      hidden: false
    })
  })

  /** Hidden at the end, because hidden plus the title is what "canonical" means. */
  it('hides the incoming conversation once it holds the title', async () => {
    const { gateway, controller } = setup()

    await controller.openChat(RESEARCHER)
    await controller.adoptAsCanonical('researcher', PAST)

    const hides = gateway.callsOf('session.set_hidden')

    expect(hides[hides.length - 1]).toMatchObject({ session_id: 'runtime-past', hidden: true })
  })

  it('points the roster at the adopted conversation', async () => {
    const { controller } = setup()

    await controller.openChat(RESEARCHER)
    await controller.adoptAsCanonical('researcher', PAST)

    expect(useBotsStore.getState().byName.researcher?.canonical?.id).toBe(PAST)
  })

  /**
   * **The failure worth the most.**
   *
   * If the incoming rename is refused, the outgoing chat is already sitting
   * under a retired name with NOTHING holding the canonical title — which is
   * exactly the state that makes the next open mint a third chat beside the two
   * that exist. So its name has to go back before the error is allowed out.
   */
  it('puts the old name back when the gateway refuses the second rename', async () => {
    const { gateway, controller } = setup()

    await controller.openChat(RESEARCHER)

    let call = 0

    gateway.reply('session.title', params => {
      call += 1

      // The retire lands; the adopt is refused, the way a duplicate title is.
      if (call === 2) {
        throw new Error("Title 'Bot Chat' is already in use by session stored-elsewhere")
      }

      return { pending: false, title: String(params.title ?? ''), session_key: PAST }
    })

    await expect(controller.adoptAsCanonical('researcher', PAST)).rejects.toThrow(/already in use/u)

    const titles = gateway.callsOf('session.title')

    // Three calls: retire, the refused adopt, and the rollback that puts the
    // canonical title back on the chat the reader is still in.
    expect(titles).toHaveLength(3)
    expect(titles[2]).toMatchObject({ session_id: 'runtime-canonical', title: 'Bot Chat' })

    // And it is hidden again, which is the other half of being canonical.
    const hides = gateway.callsOf('session.set_hidden')

    expect(hides[hides.length - 1]).toMatchObject({ session_id: 'runtime-canonical', hidden: true })

    // Nothing moved on the roster.
    expect(useBotsStore.getState().byName.researcher?.canonical?.id).toBe(CANONICAL)
  })

  /**
   * And the earlier refusal: if the RETIRE is refused, nothing has moved at all
   * and the only undo needed is putting the hidden flag back.
   */
  it('restores the hidden flag when the retire itself is refused', async () => {
    const { gateway, controller } = setup()

    await controller.openChat(RESEARCHER)
    gateway.reply('session.title', () => {
      throw new Error('This is the bot’s canonical Bot Chat')
    })

    await expect(controller.adoptAsCanonical('researcher', PAST)).rejects.toThrow(/canonical Bot Chat/u)

    const hides = gateway.callsOf('session.set_hidden')

    expect(hides[hides.length - 1]).toMatchObject({ session_id: 'runtime-canonical', hidden: true })
    expect(useBotsStore.getState().byName.researcher?.canonical?.id).toBe(CANONICAL)
  })
})
