/**
 * `/new`, and the reason it could not be forwarded.
 *
 * The report: typing `/new` printed `(^_^)v New session started!` and changed
 * nothing — the bot confirmed, when asked, that its session id was the same one
 * and its system prompt had not been rebuilt. The cause is upstream's
 * architecture rather than a bug: `slash.exec` runs worker commands in a
 * SEPARATE CLI process (`tui_gateway/methods_tools.py::_SlashWorker`), `/new`
 * there rotates that worker's own session (`hermes_cli/cli_session_mixin.py`),
 * and only the commands listed in `_SLASH_MIRRORS` are mirrored back onto the
 * live session. `new` is not one of them. Upstream's desktop app intercepts the
 * command client-side for the same reason.
 *
 * Hermie has to intercept it too, but it cannot do what the desktop does — open
 * another session — because a bot has exactly ONE chat and that chat is
 * identified by its title (ADR-0007). So "start fresh" is: retire the
 * conversation holding the title `Bot Chat`, then mint its successor under it.
 * Every assertion below is about that sequence being safe to interrupt.
 */
import { BotsController } from '../src/features/bots/bots-controller'
import { ChatController } from '../src/features/chats/chat-controller'
import { MemoryChatCache } from '../src/platform/chat-cache'
import { botFromProfileRow, useBotsStore } from '../src/store/bots'
import { useChatsStore } from '../src/store/chats'
import { FakeChatGateway } from './support/fake-chat-gateway'

const OLD_STORED = 'stored-old'
const NEW_STORED = 'stored-new'

const profileRow = (canonicalId: string) => ({
  name: 'researcher',
  path: '/root/.hermes/profiles/researcher',
  display_name: 'Researcher',
  canonical_session: {
    id: canonicalId,
    resolved_id: canonicalId,
    title: 'Bot Chat',
    last_active: 1_700_000_100,
    message_count: 2
  }
})

const RESEARCHER = botFromProfileRow(profileRow(OLD_STORED))

const HISTORY = [
  { role: 'user', text: 'Introduce yourself.', row_id: 1, timestamp: 1_700_000_000 },
  { role: 'assistant', text: 'I am researcher.', row_id: 2, timestamp: 1_700_000_001 }
]

/** Fixed, so the retired title this run writes is the one it then reads back. */
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
    // Two sessions behind one responder: the old chat resumes as `runtime-old`,
    // the successor as `runtime-new`, and every later assertion about which
    // session a message went to reads one of those two strings.
    .reply('session.resume', params => ({
      session_id: params.session_id === NEW_STORED ? 'runtime-new' : 'runtime-old',
      stored_session_id: String(params.session_id),
      message_count: params.session_id === NEW_STORED ? 0 : HISTORY.length,
      messages: [],
      messages_omitted: true,
      info: { desktop_contract: 7 },
      open_requests: []
    }))
    .reply('session.history', params => ({
      count: params.session_id === 'runtime-new' ? 0 : HISTORY.length,
      messages: params.session_id === 'runtime-new' ? [] : HISTORY
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
    .reply('session.set_hidden', params => ({ hidden: params.hidden === true, session_key: OLD_STORED }))
    .reply('session.title', params => ({ pending: false, title: String(params.title ?? ''), session_key: OLD_STORED }))
    .reply('session.create', {
      session_id: 'runtime-new-draft',
      stored_session_id: NEW_STORED,
      message_count: 0,
      messages: [],
      info: { desktop_contract: 7 }
    })
    .reply('session.close', { closed: true })
    .reply('prompt.submit', { status: 'streaming' })

  useBotsStore.getState().setBots([RESEARCHER])
  gateway.restMessages = null
  started.push(controller)

  return { gateway, cache, controller }
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

const chatOf = () => useChatsStore.getState().chats.researcher!
const notices = () =>
  chatOf()
    .order.map(id => chatOf().items[id])
    .filter(item => item?.kind === 'notice') as { noticeKind: string; title: string; body?: string }[]

/** The order of the calls that carry the switch, ignoring the open path's own. */
const switchOrder = (gateway: FakeChatGateway) =>
  gateway
    .methodOrder()
    .filter(method => ['session.set_hidden', 'session.title', 'session.create', 'session.close'].includes(method))

describe('/new starts a conversation instead of asking the gateway to', () => {
  it('never reaches slash.exec or command.dispatch', async () => {
    const { gateway, controller } = setup()

    await controller.openChat(RESEARCHER)
    await controller.runSlash('researcher', '/new')

    expect(gateway.methodOrder()).not.toContain('slash.exec')
    expect(gateway.methodOrder()).not.toContain('command.dispatch')
  })

  /**
   * Known before the catalogue, which every other command has to wait for.
   *
   * A command the catalogue has not confirmed goes out as an ordinary prompt,
   * and for most commands that is harmless — the gateway understands a leading
   * slash. For `/new` it is the worst outcome available: the model is asked, in
   * prose, to start a new session, and answers as though it had.
   */
  it('is a known command with no catalogue loaded at all, and so are its aliases', async () => {
    const { controller } = setup()

    await controller.openChat(RESEARCHER)

    expect(controller.slashCatalog('researcher')).toBeUndefined()
    expect(controller.knowsSlashCommand('researcher', 'new')).toBe(true)
    expect(controller.knowsSlashCommand('researcher', 'reset')).toBe(true)
    expect(controller.knowsSlashCommand('researcher', 'clear')).toBe(true)
    expect(controller.slashRouteFor('researcher', 'new')).toBe('local')
    expect(controller.knowsSlashCommand('researcher', 'model')).toBe(false)
  })

  /**
   * The order, which is the whole of the correctness argument.
   *
   * `Bot Chat` is the registry key: upstream resolves a bot's chat with
   * `db.get_session_by_title('Bot Chat')`, which answers ONE row. Creating
   * first means two rows want the same name — upstream raises "Title 'Bot Chat'
   * is already in use by session …" — so the successor never gets the title and
   * the lookup keeps finding the conversation that was meant to be retired.
   *
   * The un-hide in front of the rename is the other half:
   * `hermes_state_titles.py::_set_session_title` refuses to move a HIDDEN
   * session off the canonical title at all, and hidden is the discriminator it
   * tests.
   */
  it('un-hides, renames, creates and only then closes — in that order', async () => {
    const { gateway, controller } = setup()

    await controller.openChat(RESEARCHER)
    await controller.runSlash('researcher', '/new')

    // The second `session.title` is the one that lands `Bot Chat` on the
    // successor; see the test below it.
    expect(switchOrder(gateway)).toEqual([
      'session.set_hidden',
      'session.title',
      'session.create',
      'session.title',
      'session.close'
    ])
  })

  it('retires the old conversation under a dated name, on the old session-s runtime id', async () => {
    const { gateway, controller } = setup()

    await controller.openChat(RESEARCHER)
    await controller.runSlash('researcher', '/new')

    const retire = gateway.calls.find(call => call.method === 'session.title')!

    // The RUNTIME id: `session.title` is session-scoped upstream, so a stored id
    // comes back 4001 "session not found".
    expect(retire.params).toMatchObject({ session_id: 'runtime-old', profile: 'researcher' })
    expect(String(retire.params.title)).toMatch(/^Bot Chat · \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/)
  })

  it('mints the successor as a hidden Bot Chat under the old one', async () => {
    const { gateway, controller } = setup()

    await controller.openChat(RESEARCHER)
    await controller.runSlash('researcher', '/new')

    expect(gateway.lastCall('session.create')).toMatchObject({
      profile: 'researcher',
      title: 'Bot Chat',
      hidden: true,
      source: 'hermie',
      follow_profile_config: true,
      parent_session_id: OLD_STORED
    })
  })

  /**
   * The title is written onto the new session straight away.
   *
   * `session.create` persists no row for an empty draft — the title waits as
   * `pending_title` until the first prompt — so without this call a relaunch
   * before the owner typed anything would find no canonical row and mint a
   * THIRD chat beside the two that already exist.
   */
  it('writes Bot Chat onto the new session at once, so the row exists before the first prompt', async () => {
    const { gateway, controller } = setup()

    await controller.openChat(RESEARCHER)
    await controller.runSlash('researcher', '/new')

    expect(gateway.lastCall('session.title')).toMatchObject({
      session_id: 'runtime-new-draft',
      title: 'Bot Chat'
    })
  })

  it('binds the new session and sends the next message to it', async () => {
    const { gateway, controller } = setup()

    controller.start()
    await controller.openChat(RESEARCHER)
    await controller.runSlash('researcher', '/new')

    expect(chatOf().storedSessionId).toBe(NEW_STORED)
    expect(chatOf().runtimeSessionId).toBe('runtime-new')

    await controller.send('researcher', 'hello again')

    expect(gateway.lastCall('prompt.submit')).toMatchObject({ session_id: 'runtime-new', text: 'hello again' })
  })

  it('closes the old runtime session — a conversation boundary, not a detach', async () => {
    const { gateway, controller } = setup()

    await controller.openChat(RESEARCHER)
    await controller.runSlash('researcher', '/new')

    expect(gateway.lastCall('session.close')).toMatchObject({ session_id: 'runtime-old' })
  })

  /**
   * The new chat is EMPTY.
   *
   * The transcript cache is keyed by bot, not by session, so the snapshot on
   * disk is the conversation just put away. Left there, the cold-open path would
   * paint it under the new session's ids and reconcile an empty live transcript
   * into it — the new chat would open holding the old one.
   */
  it('opens the new conversation empty, with the old transcript out of the cache', async () => {
    const { cache, controller } = setup()

    await controller.openChat(RESEARCHER)
    await controller.persistAll()

    expect(await cache.read('researcher')).not.toBeNull()

    await controller.runSlash('researcher', '/new')

    expect(
      chatOf()
        .order.map(id => chatOf().items[id])
        .filter(item => item?.kind === 'user' || item?.kind === 'assistant')
    ).toHaveLength(0)
  })

  it('leaves one command row in the NEW transcript, naming what was put away', async () => {
    const { gateway, controller } = setup()

    await controller.openChat(RESEARCHER)
    await controller.runSlash('researcher', '/new')

    const retired = String(gateway.calls.find(call => call.method === 'session.title')!.params.title)
    const rows = notices()

    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ noticeKind: 'command', title: '/new' })
    expect(rows[0]!.body).toBe(`New conversation started. The previous one is kept as “${retired}”.`)
  })

  it.each([['/reset'], ['/clear']])('%s does exactly what /new does', async command => {
    const { gateway, controller } = setup()

    await controller.openChat(RESEARCHER)
    await controller.runSlash('researcher', command)

    expect(gateway.lastCall('session.create')).toMatchObject({ title: 'Bot Chat' })
    expect(chatOf().storedSessionId).toBe(NEW_STORED)
    expect(notices()[0]).toMatchObject({ title: command })
  })

  it('names the retired conversation after the argument, and says whose name it is', async () => {
    const { gateway, controller } = setup()

    await controller.openChat(RESEARCHER)
    await controller.runSlash('researcher', '/new The pricing rewrite')

    expect(gateway.calls.find(call => call.method === 'session.title')!.params).toMatchObject({
      title: 'The pricing rewrite'
    })
    expect(notices()[0]!.body).toContain('“The pricing rewrite”')
    expect(notices()[0]!.body).toContain('put away')
  })

  it('falls back to the dated name when the gateway refuses the argument, and says so', async () => {
    const { gateway, controller } = setup()

    await controller.openChat(RESEARCHER)

    let first = true

    gateway.reply('session.title', params => {
      if (first) {
        first = false

        throw new Error("Title 'The pricing rewrite' is already in use by session stored-7")
      }

      return { pending: false, title: String(params.title ?? ''), session_key: OLD_STORED }
    })

    await controller.runSlash('researcher', '/new The pricing rewrite')

    const titles = gateway.calls.filter(call => call.method === 'session.title').map(call => String(call.params.title))

    expect(titles[0]).toBe('The pricing rewrite')
    expect(titles[1]).toMatch(/^Bot Chat · /)
    expect(chatOf().storedSessionId).toBe(NEW_STORED)
    expect(notices()[0]!.body).toContain('already in use')
  })
})

describe('/new when it must not go ahead', () => {
  /**
   * A turn in flight is bound to the session it started in, and closing that
   * session underneath it strands the answer where nobody can read it. The
   * refusal is a command row rather than a thrown error because the reader has
   * to SEE it — a transient banner is how a command reads as having done
   * nothing, which is the bug this whole change is about.
   */
  it('refuses while the bot is still working, and touches nothing', async () => {
    const { gateway, controller } = setup()

    await controller.openChat(RESEARCHER)

    useChatsStore.getState().update('researcher', state => ({ ...state, turn: { ...state.turn, active: true } }))

    await controller.runSlash('researcher', '/new')

    expect(switchOrder(gateway)).toEqual([])
    expect(chatOf().storedSessionId).toBe(OLD_STORED)
    expect(notices()[0]).toMatchObject({ noticeKind: 'command', title: '/new' })
    expect(notices()[0]!.body).toContain('still working')
  })

  it('refuses a chat that is not attached to the gateway', async () => {
    const { controller } = setup()

    await expect(controller.runSlash('researcher', '/new')).rejects.toThrow(/not attached/)
  })

  /**
   * A create that failed leaves the conversation under its retired name, and
   * that conversation IS still this bot's chat — the app is still bound to it.
   * Its name has to go back, or the next open resolves no canonical row and
   * mints a second chat beside the one the owner is reading.
   */
  it('puts the old name back and re-hides when the create fails, and stays where it was', async () => {
    const { gateway, controller } = setup()

    await controller.openChat(RESEARCHER)

    gateway.reply('session.create', () => {
      throw new Error('{"code":5007,"message":"state.db is locked"}')
    })

    await controller.runSlash('researcher', '/new')

    const titles = gateway.calls.filter(call => call.method === 'session.title').map(call => String(call.params.title))
    const hides = gateway.calls.filter(call => call.method === 'session.set_hidden').map(call => call.params.hidden)

    expect(titles.at(-1)).toBe('Bot Chat')
    expect(hides).toEqual([false, true])
    expect(chatOf().storedSessionId).toBe(OLD_STORED)
    expect(chatOf().runtimeSessionId).toBe('runtime-old')
    expect(notices().at(-1)!.body).toContain('state.db is locked')
  })

  it('changes nothing when the rename itself is refused', async () => {
    const { gateway, controller } = setup()

    await controller.openChat(RESEARCHER)

    gateway.reply('session.title', () => {
      throw new Error("This is the bot's canonical Bot Chat")
    })

    await controller.runSlash('researcher', '/new')

    expect(gateway.methodOrder()).not.toContain('session.create')
    expect(chatOf().storedSessionId).toBe(OLD_STORED)
    expect(notices().at(-1)!.body).toContain('canonical Bot Chat')
  })
})

describe('the roster and a switch that has just happened', () => {
  /**
   * The poll that would undo it.
   *
   * `profiles.list` resolves a bot's canonical chat by title server-side, and
   * `setBots` overwrites every bot wholesale. A poll that left before the rename
   * — or one that arrives while the new session still has no database row —
   * answers with the OLD id, and putting the chat back on the conversation the
   * owner just put away is indistinguishable from `/new` not having worked.
   */
  it('cannot be reverted by a roster answer naming the old chat', async () => {
    const { controller } = setup()

    await controller.openChat(RESEARCHER)
    await controller.runSlash('researcher', '/new')

    expect(useBotsStore.getState().byName.researcher?.canonical?.id).toBe(NEW_STORED)

    // A poll in flight since before the switch.
    useBotsStore.getState().setBots([botFromProfileRow(profileRow(OLD_STORED))])

    expect(useBotsStore.getState().byName.researcher?.canonical?.id).toBe(NEW_STORED)

    // And one from a gateway that has not persisted the new row yet, so it
    // reports no canonical chat at all.
    useBotsStore.getState().setBots([botFromProfileRow({ name: 'researcher', path: '/p' })])

    expect(useBotsStore.getState().byName.researcher?.canonical?.id).toBe(NEW_STORED)
  })

  it('lets go the moment the gateway agrees, so a later switch elsewhere still lands', async () => {
    const { controller } = setup()

    await controller.openChat(RESEARCHER)
    await controller.runSlash('researcher', '/new')

    useBotsStore.getState().setBots([botFromProfileRow(profileRow(NEW_STORED))])

    expect(useBotsStore.getState().canonicalPins).toEqual({})

    // Another client starts a fresh chat on the same bot; nothing here may hold
    // this app on a conversation the gateway has retired.
    useBotsStore.getState().setBots([botFromProfileRow(profileRow('stored-elsewhere'))])

    expect(useBotsStore.getState().byName.researcher?.canonical?.id).toBe('stored-elsewhere')
  })
})
