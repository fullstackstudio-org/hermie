/**
 * What the chat controller does only when a page loaded on demand asks for it: uploads, slash commands, the
 * conversations of a bot (the Bot Chat and the reader's own chats, branches, past conversations, `/new`), the chat's
 * options, the Agents bar's calls and the Activity timeline's loads.
 *
 * None of it runs before the reader opens a chat or a page, and all of it is the chat screen's, the Conversations
 * page's, the Activity page's or a sheet's to call, so it is not part of the first load: `ChatController` keeps a
 * method of the same name for each public function here, which hands the call to this module once it has loaded
 * (`onDemandPart` in `on-demand.ts`; at once, in the same tick, when it is already there, so the order of what a call
 * does is the order it always had). The chat screen's chunk imports this module, so it is there before the screen
 * can ask; a page that asks first waits for it.
 *
 * Each function takes the controller as `c` and works on its state as its methods do: the members it reads are the
 * controller's own (`chat-controller.ts`), not part of what a screen is given (`ChatScreenController`). Moved from the
 * class unchanged, apart from `this` being `c`.
 */
import { lastMessageAt, rowsToItems, type TranscriptItem, type TranscriptRow } from '@hermie/transcript'
import type {
  CompleteSlashResult,
  SessionListRow,
  SessionLiveInfo,
  SlashExecResult,
  Usage
} from '@hermes/shared/gateway-contract'
import { parseCommandDispatch, parseSlashCommand } from '@hermes/shared/slash'

import type { Bot, BotCanonicalSession } from '../state/bots'
import {
  CANONICAL_CHAT_TITLE,
  createCanonicalSession,
  PROFILE_SESSION_LIST_LIMIT,
  SESSION_COLUMNS
} from './bots-controller'
import {
  ACTIVITY_TAIL_LIMIT,
  botOn,
  type ChatChoice,
  type ChatController,
  type ChatOptionKey,
  collapse,
  ConversationBusyError,
  DM_DELIVERY_MARKER,
  type ModelChoice,
  NEW_CONVERSATION_COMMANDS,
  provideChatControllerOnDemand,
  REST_HISTORY_LIMIT,
  RESUME_COLS,
  type SetOptionResult,
  type SlashCompletions,
  type SlashFailure,
  slashFailureOf,
  type SlashOutcome,
  STATUS_COMMAND
} from './chat-controller'
import { FileUploadError, uploadFile as upload, type UploadableFile, type UploadedFile } from './chats/file-upload'
import { describeRpcFailure } from './rpc-failures'
import {
  buildConversationList,
  type ConversationList,
  isStampLabel,
  labelFromText,
  newOwnChatTitle,
  OWN_CHAT_LABEL_MAX
} from './sessions/conversation-list'
import {
  botOfConversationKey,
  classifyConversations,
  conversationKey,
  type Conversation,
  type ConversationGroups,
  isOwnChatTitle,
  ownChatLabel,
  ownChatTitle
} from './sessions/session-model'

/**
 * Put a file on the gateway, ready to be named in the next prompt.
 *
 * Everything about WHERE is decided here rather than by the caller, because
 * the answer depends on this session: the upload has to land under the
 * session's own working directory or the `@file:` reference will be refused as
 * outside the allowed workspace. `info.cwd` is that directory, and it arrived
 * with `session.resume`.
 */
export async function uploadFile(
  c: ChatController,
  botName: string,
  file: UploadableFile,
  options: { onProgress?: (fraction: number) => void; signal?: AbortSignal } = {}
): Promise<UploadedFile> {
  const chat = c.chats.getState().chats[botName]

  if (!c.http) {
    throw new FileUploadError('failed', 'There is no gateway connection to upload to.')
  }

  return upload({
    http: c.http,
    file,
    cwd: typeof chat?.info?.cwd === 'string' ? chat.info.cwd : undefined,
    ...(options.onProgress ? { onProgress: options.onProgress } : {}),
    ...(options.signal ? { signal: options.signal } : {})
  })
}

/**
 * Put a file on the gateway at a path the caller chose (an `input.file` request names its directory:
 * `flatUploadPath`), instead of under the session's working directory. The same route, credentials and refusals as
 * `uploadFile`; it needs no `cwd`.
 */
export async function uploadFileTo(
  c: ChatController,
  path: string,
  file: UploadableFile,
  options: { onProgress?: (fraction: number) => void; signal?: AbortSignal } = {}
): Promise<UploadedFile> {
  if (!c.http) {
    throw new FileUploadError('failed', 'There is no gateway connection to upload to.')
  }

  return upload({
    http: c.http,
    file,
    cwd: undefined,
    path,
    ...(options.onProgress ? { onProgress: options.onProgress } : {}),
    ...(options.signal ? { signal: options.signal } : {})
  })
}

// ── subagents ──────────────────────────────────────────────────────────────

export async function steerSubagent(
  c: ChatController,
  botName: string,
  subagentId: string,
  text: string
): Promise<string> {
  const sessionId = c.requireRuntime(botName)
  const result = await c.gateway.request('subagent.steer', {
    session_id: sessionId,
    profile: botName,
    subagent_id: subagentId,
    text
  })

  return result?.status ?? 'queued'
}

export async function interruptSubagent(c: ChatController, botName: string, subagentId: string): Promise<boolean> {
  const sessionId = c.requireRuntime(botName)
  const result = await c.gateway.request('subagent.interrupt', {
    session_id: sessionId,
    profile: botName,
    subagent_id: subagentId
  })

  return result?.found === true
}

export async function tailSubagent(c: ChatController, botName: string, subagentId: string): Promise<string> {
  const sessionId = c.requireRuntime(botName)
  const result = await c.gateway.request('subagent.tail', {
    session_id: sessionId,
    profile: botName,
    subagent_id: subagentId
  })

  return result?.available === false ? '' : (result?.text ?? '')
}

/**
 * The child's OWN transcript, read the same way a chat is.
 *
 * `subagent.tail` is a live stream tail and stops existing the moment the
 * child does. A child that reported a `child_session_id` has a real stored
 * session behind it, and that one can still be read afterwards — which is
 * what makes "Open transcript" worth offering on a finished child at all.
 */
export async function childTranscript(
  c: ChatController,
  botName: string,
  childSessionId: string
): Promise<TranscriptItem[]> {
  const rows = await c.gateway.fetchMessages(childSessionId, { limit: REST_HISTORY_LIMIT, order: 'latest' })

  if (rows?.length) {
    return [...rowsToItems(rows, 'rest')]
  }

  const result = await c.gateway.request('session.history', { session_id: childSessionId, profile: botName })

  return [...rowsToItems((result?.messages ?? []) as TranscriptRow[], 'rpc')]
}

// ── the activity timeline ──────────────────────────────────────────────────

/**
 * Load one bot's recent transcript WITHOUT attaching to its session.
 *
 * The Activity screen is a view over the chat store, so a bot nobody has
 * opened has nothing to show. This fills that gap with the cheapest read that
 * exists — the REST tail under the canonical chat's resolved id — and puts
 * the rows through the same `rowsToItems` every other path uses, so opening
 * the chat afterwards reconciles onto the items rather than duplicating them.
 *
 * A chat that IS live is left alone: it has the truth on the socket already.
 */
export async function prefetchTail(c: ChatController, bot: Bot, limit = ACTIVITY_TAIL_LIMIT): Promise<void> {
  const existing = c.chats.getState().chats[bot.name]

  if (existing && (c.chats.getState().live[bot.name] || existing.turn.active)) {
    return
  }

  let canonical: BotCanonicalSession

  try {
    canonical = await c.botsController.resolveCanonical(bot)
  } catch {
    // A bot whose chat cannot be resolved contributes nothing to the
    // timeline; it must not take the whole screen down.
    return
  }

  c.chats.getState().ensure(bot.name, {
    storedSessionId: canonical.id,
    resolvedSessionId: canonical.resolvedId
  })

  let rows = await c.gateway.fetchMessages(canonical.resolvedId, { limit, order: 'latest' })

  if (rows === null) {
    try {
      const result = await c.gateway.request('session.history', {
        session_id: canonical.id,
        profile: bot.name
      })

      rows = ((result?.messages ?? []) as TranscriptRow[]).slice(-limit)
    } catch {
      return
    }
  }

  if (!rows.length || !c.holdsConversation(bot.name, canonical.id)) {
    return
  }

  c.chats.getState().applyTail(bot.name, rowsToItems(rows, 'rest'))

  const chat = c.chats.getState().chats[bot.name]

  if (chat?.hydration === 'cold') {
    // Not `live`: nothing is attached. `stale` is the honest word for a
    // transcript that was read once and is not being streamed.
    c.chats.getState().setHydration(bot.name, 'stale')
  }
}

/**
 * The background load behind the Activity screen: every bot, in parallel.
 *
 * The roster is re-read FIRST. A bot's canonical id is the only key the tail
 * can be fetched under, and a stale one (a gateway restarted under a running
 * app, a chat recreated elsewhere) fails the fetch silently — which reads as
 * "these bots never talked to each other" rather than as the stale key it is.
 */
export async function loadActivity(c: ChatController, limit = ACTIVITY_TAIL_LIMIT): Promise<void> {
  const bots = await c.botsController.refresh().catch(() => c.bots.getState().bots)

  await Promise.all(bots.map(bot => prefetchTail(c, bot, limit).catch(() => undefined)))
}

/** How many sub-agents each bot has running right now (`delegation.status`). */
export async function activeSubagentCount(c: ChatController): Promise<number> {
  const bots = c.bots.getState().bots
  const counts = await Promise.all(
    bots.map(async bot => {
      try {
        const result = await c.gateway.request('delegation.status', { profile: bot.name })

        return (result?.active ?? []).length
      } catch {
        // A gateway without delegation support reports none rather than
        // failing the whole header.
        return 0
      }
    })
  )

  return counts.reduce((sum, count) => sum + count, 0)
}

/**
 * Bot-to-bot deliveries still in flight.
 *
 * `agents.list` reports every background process the gateway is running, of
 * which a DM delivery is one shape: the `bot_mode_dm.py --run-delivery`
 * runner. Anything else in that list is somebody else's work.
 */
export async function inFlightDeliveries(c: ChatController): Promise<number> {
  const bots = c.bots.getState().bots
  const counts = await Promise.all(
    bots.map(async bot => {
      try {
        const result = await c.gateway.request('agents.list', { profile: bot.name })

        return (result?.processes ?? []).filter(row => String(row.command ?? '').includes(DM_DELIVERY_MARKER)).length
      } catch {
        return 0
      }
    })
  )

  return counts.reduce((sum, count) => sum + count, 0)
}

// ── slash commands ─────────────────────────────────────────────────────────

/**
 * Completions for what the user is typing.
 *
 * The catalogue is fetched once per session and kept: it is the list of every
 * command and skill this profile has, and it does not change mid-chat. The
 * per-keystroke work is `complete.slash`, which is what the gateway is built
 * to answer quickly.
 *
 * Two things here are about the difference between a fake gateway and a real
 * one. The catalogue fetch is shared by every keystroke that arrives while it
 * is in the air — typing `/model` is six of them, and against a fake that
 * answers in the same tick the old `has()` check looked like a cache and was
 * really six concurrent catalogue builds on the gateway. And a FAILED fetch is
 * no longer remembered as an empty catalogue: it used to be, which meant one
 * bad answer left `knowsSlashCommand` saying no for the rest of the session,
 * so every `/model` after it went out as a prompt.
 */
export async function querySlash(c: ChatController, botName: string, typed: string): Promise<SlashCompletions> {
  const sessionId = c.requireRuntime(botName)
  let failure: SlashFailure | undefined

  if (!c.slashCatalogs.has(sessionId)) {
    failure = (await fetchSlashCatalog(c, botName, sessionId)) ?? undefined
  }

  try {
    const result = await completeSlash(c, typed, sessionId)

    return {
      items: result?.items ?? [],
      // The COLUMN an accepted item replaces from, which is how the same call
      // completes a command name and then its arguments: the gateway says how
      // much of the line its answer stands for. A real gateway answers 1 for a
      // bare `/mo` — the slash is kept and the item's own `text` carries no
      // slash — and `text.rfind(' ') + 1` once there is an argument.
      ...(typeof result?.replace_from === 'number' ? { replaceFrom: result.replace_from } : {}),
      /*
        A catalogue that would not load is still worth saying even when the
        completions themselves arrived. `complete.slash` answers from the
        session, `commands.catalog` is what `knowsSlashCommand` routes on — so
        a reader whose catalogue is missing gets a list they can pick from and
        a Return that sends the pick as PROSE, which is the confusing half of
        this bug rather than the visible one.
      */
      ...(failure ? { failure } : {})
    }
  } catch (error) {
    const reported = noteRpcFailure(c, 'complete.slash', error)

    // The nearer failure wins: `complete.slash` is the call that was supposed
    // to fill this popover, and naming the catalogue instead would point a
    // reader at the call that did not fail last.
    return { items: [], failure: reported }
  }
}

/**
 * Run a slash command and put its answer in the transcript.
 *
 * There are two kinds of answer and the gateway does not label which one it is
 * about to give: plain worker text in `output`, or one of the six
 * `command.dispatch` DIRECTIVES with a `type` — which `slash.exec` also
 * returns, because upstream reroutes pending-input built-ins and skill bundles
 * into `command.dispatch` itself and hands the directive straight back.
 * `parseCommandDispatch` is the vendored narrowing for exactly that union; it
 * was vendored and then never called, and this method read
 * `output ?? message ?? notice` instead — so `/queue list`, which answers
 * `{type: 'send', message: 'list'}`, put the word `list` in the transcript as
 * though it were the result and never queued anything.
 *
 * `message` is model-facing scaffolding and no surface may render it. A skill
 * bundle's `message` is the whole expanded skill body; `display` is the line
 * the reader is meant to see.
 */
export async function runSlash(c: ChatController, botName: string, command: string): Promise<SlashOutcome> {
  return await dispatchSlash(c, botName, command, 0)
}

/**
 * Put this conversation away and start the next one, in place.
 *
 * Hermie's product model has no session browser: a bot has exactly ONE chat,
 * the hidden session on its profile titled exactly `Bot Chat`, resolved by
 * that title and nothing else (ADR-0007, and upstream's
 * `methods_profiles.py::_canonical_session_row` → `get_session_by_title`).
 * "Start fresh" therefore cannot mean "open another session" the way it does
 * on the desktop. It means: RETIRE the conversation that holds the title, and
 * mint the successor under it.
 *
 * The order is load-bearing and it is retire-then-create. The title is the
 * registry key, so while the old row still wears it a second `Bot Chat` is
 * either refused outright — `hermes_state_titles.py` raises "Title 'Bot Chat'
 * is already in use by session …" — or, on a gateway that let it through,
 * shadows the conversation it was meant to replace. Every step that can fail
 * is rolled back towards "nothing happened", because the one outcome worse
 * than `/new` doing nothing is `/new` leaving a bot with no chat.
 *
 * `arg` names the conversation being PUT AWAY, not the new one: the new one is
 * `Bot Chat`, which is not a name this app is free to change.
 */
export async function startNewConversation(
  c: ChatController,
  botName: string,
  arg = '',
  command = '/new'
): Promise<void> {
  const sessionId = c.requireRuntime(botName)
  const chat = c.chats.getState().chats[botName]
  const storedId = chat?.storedSessionId
  const bot = c.bots.getState().byName[botName]

  if (!chat || !storedId || !bot) {
    throw new Error(`${botName}'s chat is not attached to the gateway yet.`)
  }

  if (chat.turn.active) {
    /*
      A turn in flight is bound to the session it started in, and closing that
      session underneath it would strand the answer somewhere the reader can
      no longer see. Refusing is the honest move, and it is a refusal the
      reader has to SEE — hence a command row rather than a thrown error the
      composer would turn into a transient banner.
    */
    commandRow(
      c,
      botName,
      sessionId,
      command,
      'This bot is still working on the last turn. Let it finish, or stop it, and run this again — a conversation cannot be put away mid-answer.'
    )

    return
  }

  if (c.boundOwnId(botName)) {
    await startAnotherOwnChat(c, bot, sessionId, storedId, arg, command)

    return
  }

  const stamped = `${CANONICAL_CHAT_TITLE} · ${localStamp(c.now())}`
  const asked = arg.trim()
  let retired = asked || stamped
  let refusedName = ''

  await unhideForRetire(c, botName, sessionId)

  try {
    await renameSession(c, botName, sessionId, retired)
  } catch (error) {
    if (!asked) {
      await undoRetire(c, botName, sessionId, false)
      commandRow(c, botName, sessionId, command, retireFailed(messageOf(error)))

      return
    }

    /*
      A refused title is nearly always the ARGUMENT — too long, or already
      worn by another session — and what the owner asked for was a new
      conversation, not that name. So the fallback runs and the notice says
      what happened, rather than the whole command failing over a label.
    */
    refusedName = messageOf(error)
    retired = stamped

    try {
      await renameSession(c, botName, sessionId, retired)
    } catch (second) {
      await undoRetire(c, botName, sessionId, false)
      commandRow(c, botName, sessionId, command, retireFailed(messageOf(second)))

      return
    }
  }

  let created

  try {
    created = await createCanonicalSession(c.gateway, botName, { parentSessionId: storedId })
  } catch (error) {
    // Nothing was created, so the conversation now sitting under the retired
    // name IS still this bot's chat. Its name goes back, or the next open
    // finds no canonical row and mints a third one beside it.
    await undoRetire(c, botName, sessionId, true)
    commandRow(
      c,
      botName,
      sessionId,
      command,
      `The gateway would not start a new conversation (${messageOf(error)}). You are still in the one you were in.`
    )

    return
  }

  /*
    Write the title onto the NEW session at once.

    `session.create` deliberately persists no row for an empty draft
    (`methods_session.py`: eagerly creating one "left an 'Untitled' empty
    session behind for every launch the user never typed into"), so the title
    and the hidden flag ride as `pending_title` / `pending_hidden` until the
    first prompt. `session.title` takes the other road — `_ensure_session_db_row`,
    which applies the queued hidden flag on the way — so the successor is a
    real, findable, hidden `Bot Chat` before anybody has typed into it. Without
    this, a relaunch before the first message would resolve no canonical row at
    all and mint a third chat.

    Best effort: the create landed, so the app is switching either way.
  */
  if (created.runtimeSessionId) {
    try {
      await renameSession(c, botName, created.runtimeSessionId, CANONICAL_CHAT_TITLE)
    } catch (error) {
      noteRpcFailure(c, 'session.title', error)
    }
  }

  // A full conversation boundary, which is what upstream's own `/new` is. Best
  // effort: a session the gateway has already reaped answers 4001, and the
  // transcript is on disk either way.
  try {
    await c.gateway.request('session.close', { session_id: sessionId, profile: botName })
  } catch (error) {
    noteRpcFailure(c, 'session.close', error)
  }

  await switchCanonical(c, bot, created.canonical)

  // In the NEW transcript, and last, so it is the only thing in it.
  commandRow(
    c,
    botName,
    c.chats.getState().chats[botName]?.runtimeSessionId ?? '',
    command,
    newConversationNotice(retired, asked, refusedName)
  )
}

/**
 * Move this bot between the shared Bot Chat and the reader's own.
 *
 * The choice is remembered FIRST, because it is what every other reader of
 * the roster consults — `BotsController.runResolution` among them — and a
 * resolution that ran before it would resolve the chat the reader is leaving.
 * It is put back if the gateway refuses, so a switch that did not happen does
 * not leave a row claiming it did.
 *
 * The move itself is `switchCanonical`, unchanged and unaware: everything
 * keyed by the old session is dropped, the roster is pinned to the new one,
 * and the ordinary open path runs again. A chat that was already the chosen
 * one is a no-op rather than a reload, because tapping the segment you are
 * already on should not throw away the transcript you are reading.
 */
export async function chooseChat(c: ChatController, bot: Bot, choice: ChatChoice): Promise<void> {
  const directory = c.userChats

  if (!directory?.available) {
    // No identity, no private chat, nothing to choose between. Said as a
    // refusal rather than silently, because a caller that drew the switch on
    // a gateway that has none has a bug worth hearing about.
    throw new Error('This gateway has not said who you are, so there is only the shared Bot Chat.')
  }

  const was = directory.chose(bot.name) ? 'mine' : 'shared'

  if (was === choice) {
    return
  }

  if (c.botsController.tracksCurrent) {
    // With sub-chats the switch is one more way to pick a row: the group chat,
    // or the reader's first own chat (found, or minted as the switch always
    // did). No pin: the canonical keeps naming the group chat.
    if (choice === 'shared') {
      await selectConversation(c, bot, null)

      return
    }

    const mine = await directory.resolve(bot)

    await selectConversation(c, bot, {
      id: mine.id,
      resolvedId: mine.resolvedId,
      title: directory.title,
      preview: mine.preview,
      messageCount: mine.messageCount,
      lastActive: mine.lastActive,
      kind: 'mine'
    })

    return
  }

  directory.remember(bot.name, choice)

  let target: BotCanonicalSession

  try {
    target = choice === 'mine' ? await directory.resolve(bot) : await c.botsController.resolveShared(bot)
  } catch (error) {
    directory.remember(bot.name, was)

    throw error
  }

  await switchCanonical(c, bot, target)
}

// ── sub-chats: the conversation each bot is on ─────────────────────────────

/**
 * A bot's conversations as the list draws them: the group chat, then the
 * reader's own chats, most recently used first (on this device), and whether
 * this gateway can offer an own chat at all.
 *
 * One profile listing. The roster's `canonical` is handed in as the group
 * chat's id — it always names the Bot Chat now, `Bot.current` being where the
 * reader is — except where the old two-position switch still pinned it onto
 * an own chat, which the title gives away; the list then finds the group chat
 * by title rather than draw the reader's chat as everybody's.
 */
export async function listBotConversations(c: ChatController, bot: Bot | string): Promise<ConversationList> {
  return (await listProfile(c, typeof bot === 'string' ? bot : bot.name)).list
}

/**
 * Put this bot's key on one of its conversations: an own chat, or the group
 * chat with `null` (or its `canonical` row).
 *
 * The choice is remembered FIRST — it is what every device follows, and what
 * the next open settles on — and put back if the switch fails. Picking the
 * conversation the bot is already on is a no-op rather than a reload.
 *
 * Branches and past conversations are not for this: they open read-only in
 * the viewer.
 */
export async function selectConversation(c: ChatController, bot: Bot, target: Conversation | null): Promise<void> {
  if (target && target.kind !== 'mine' && target.kind !== 'canonical') {
    throw new Error('Only the group chat or one of your own chats can be the conversation a bot is on.')
  }

  const botName = bot.name
  const own = target?.kind === 'mine' ? target : null

  if (own && !c.lead) {
    throw new Error('This gateway has not said who you are, so there is only the group chat.')
  }

  // One open per key at a time: whatever is in the air lands first.
  await c.opening.get(botName)?.catch(() => undefined)

  const wanted = own?.id ?? null
  const source = c.userChats
  const memory = source?.target?.(botName)
  const remembered = wanted === null ? memory === undefined : memory === wanted
  const bound = c.boundOwnId(botName)

  if (bound === wanted && remembered) {
    return
  }

  if (bound !== undefined && bound !== wanted) {
    // Moving a live chat would drop a running reply or the queue: refused
    // before anything, the memory included, has changed.
    c.assertIdle(botName)
  }

  if (!remembered) {
    source?.rememberCurrent?.(botName, wanted)
  }

  if (bound === wanted) {
    // Already on screen; only the memory had to catch up.
    return
  }

  if (own) {
    c.ownTitles.set(own.id, own.title)
  }

  const session: BotCanonicalSession | null = own
    ? {
        id: own.id,
        resolvedId: own.resolvedId || own.id,
        preview: own.preview,
        lastActive: own.lastActive,
        messageCount: own.messageCount
      }
    : null
  const before = c.bots.getState().byName[botName]?.current ?? null
  const run = c.switchTo(bot, session)

  c.opening.set(botName, run)

  try {
    await run
  } catch (error) {
    c.opening.delete(botName)

    // The switch did not happen, so neither did the choice.
    if (!remembered) {
      restoreMemory(c, botName, memory)
    }

    if (error instanceof ConversationBusyError && c.boundOwnId(botName) === bound) {
      // Refused before the key was touched: the chat is where it was.
      throw error
    }

    c.chats.getState().forget(botName)
    c.bots.getState().setCurrent(botName, before)

    // Put the conversation the reader was in back on screen, from its own
    // cache entry (written on the way out), before the refusal is reported.
    const back = c.bots.getState().byName[botName]

    if (back && bound !== undefined) {
      await c.openChat(back).catch(() => undefined)
    }

    throw error
  } finally {
    if (c.opening.get(botName) === run) {
      c.opening.delete(botName)
    }
  }

  c.notifyConversations(botName)
}

/**
 * Start another of the reader's own chats on this bot and open it.
 *
 * Created visible, following the profile's configuration, under the group
 * chat, and titled AT ONCE with `session.title` on the runtime id: upstream
 * persists no row for an empty draft, and the title write is what makes the
 * chat exist on every device before its first message — and what surfaces a
 * clash. A clash is retried once with a seconds-precise stamp. Never through
 * `resolveUserChat`'s lookup-then-create: this is the one place an own chat is
 * minted.
 *
 * `label` names it at birth; without one it carries a local stamp until its
 * first message relabels it.
 */
export async function startOwnChat(
  c: ChatController,
  bot: Bot,
  options: { label?: string } = {}
): Promise<Conversation> {
  const lead = c.lead

  if (!lead) {
    throw new Error('This gateway has not said who you are, so there is only the group chat.')
  }

  const botName = bot.name

  // The new chat is opened at once, so the chat being left must be one that
  // can be left: refused BEFORE anything is minted.
  await c.opening.get(botName)?.catch(() => undefined)
  c.assertIdle(botName)

  const group = bot.canonical?.id ? bot.canonical : await c.botsController.resolveCanonical(bot)
  const asked = cutLabel(options.label ?? '')
  const first = newOwnChatTitle(lead, asked || localStamp(c.now()))
  const created = await c.gateway.request('session.create', {
    profile: botName,
    title: first,
    // NOT hidden: `hidden` marks the one canonical row, and an own chat is a
    // listed conversation every device of this reader can find.
    hidden: false,
    source: 'hermie',
    cols: SESSION_COLUMNS,
    follow_profile_config: true,
    parent_session_id: group.id
  })
  const storedId = created?.stored_session_id || created?.session_id || ''
  const runtimeId = typeof created?.session_id === 'string' ? created.session_id : ''

  if (!storedId || !runtimeId) {
    throw new Error(`The gateway started a chat for ${botName} without returning its id.`)
  }

  let title: string

  try {
    title = await titleSession(c, botName, runtimeId, first)
  } catch (error) {
    if (!isTitleClash(error)) {
      await closeQuietly(c, botName, runtimeId)

      throw error
    }

    try {
      // The reader's own name is kept, numbered; a stamp gains its seconds.
      const retry = asked ? numbered(asked, 2) : localStamp(c.now(), true)

      title = await titleSession(c, botName, runtimeId, newOwnChatTitle(lead, retry))
    } catch (second) {
      await closeQuietly(c, botName, runtimeId)

      throw second
    }
  }

  const nowSeconds = Math.floor(c.now() / 1000)
  const conversation: Conversation = {
    id: storedId,
    resolvedId: typeof created?.stored_session_id === 'string' ? created.stored_session_id : storedId,
    title,
    preview: '',
    messageCount: 0,
    lastActive: nowSeconds,
    kind: 'mine'
  }

  c.ownTitles.set(storedId, title)
  c.bots.getState().markOpened(storedId, nowSeconds)
  await selectConversation(c, bot, conversation)
  c.notifyConversations(botName)

  return conversation
}

/**
 * Rename one of the reader's own chats. The LABEL only: the lead is what
 * finds the chat on every device and is not the reader's to change here.
 * Refusals — an empty name, one that is too long, one another chat already
 * wears — are thrown for the surface to show beside the field.
 */
export async function renameOwnChat(c: ChatController, bot: Bot, storedId: string, label: string): Promise<string> {
  const lead = c.lead
  const name = collapse(label)

  if (!lead) {
    throw new Error('This gateway has not said who you are, so there is only the group chat.')
  }

  if (isGroupId(c, bot, storedId)) {
    throw new Error('The group chat cannot be renamed.')
  }

  if (!name) {
    throw new Error('A chat needs a name.')
  }

  if (name.length > OWN_CHAT_LABEL_MAX) {
    throw new Error(`A chat name can be at most ${OWN_CHAT_LABEL_MAX} characters.`)
  }

  const settled = await renameConversation(c, bot.name, storedId, ownChatTitle(lead, name))

  c.ownTitles.set(storedId, settled)
  c.notifyConversations(bot.name)

  return settled
}

/**
 * Delete one of the reader's own chats.
 *
 * The bot leaves it FIRST when it is the conversation the key is on, so the
 * gateway is never asked to delete a session this device is holding live; it
 * lands on the group chat. Then the stored id goes, and with it the chat's
 * disk cache and every watermark it left behind.
 */
export async function deleteOwnChat(c: ChatController, bot: Bot, storedId: string): Promise<void> {
  const botName = bot.name

  if (isGroupId(c, bot, storedId)) {
    throw new Error('The group chat cannot be deleted.')
  }

  // An open in the air lands first, so "is it the open chat" is answered
  // about the chat that is actually bound.
  await c.opening.get(botName)?.catch(() => undefined)

  if (c.boundOwnId(botName) === storedId) {
    // Left fully first — its watermark and cache written under its own key,
    // and refused while a reply or the queue would be lost — and only then
    // deleted, so the gateway never loses a session this device holds live.
    await selectConversation(c, bot, null)
  } else {
    if (c.userChats?.target?.(botName) === storedId) {
      c.userChats.rememberCurrent?.(botName, null)
    }

    if (c.bots.getState().byName[botName]?.current?.id === storedId && !c.chats.getState().chats[botName]) {
      c.bots.getState().setCurrent(botName, null)
    }
  }

  await deleteConversation(c, botName, storedId)

  const key = conversationKey(botName, storedId)

  if (c.cache) {
    try {
      await c.cache.forget(key)
    } catch {
      // An orphaned cache entry is never read again: nothing points at it.
    }
  }

  c.bots.getState().forgetConversation(key, storedId)
  c.ownTitles.delete(storedId)
  c.relabelTried.delete(storedId)
  c.openedCounts.delete(key)
  c.listedCounts.delete(storedId)
  c.notifyConversations(botName)
}

/**
 * Where a push tap or a link naming one session of this bot should land.
 *
 * Resolved against the gateway, never taken from the payload: one of the
 * reader's own chats becomes the conversation the bot is on (`current`), the
 * group chat likewise, a branch or a past conversation opens in the read-only
 * viewer, and an id the listing does not hold lands on whatever the bot is on.
 */
export async function openSession(
  c: ChatController,
  bot: Bot,
  storedId: string
): Promise<{ kind: 'current' } | { kind: 'viewer' }> {
  const { rows, list } = await listProfile(c, bot.name)
  const matches = (conversation: { id: string; resolvedId: string }): boolean =>
    conversation.id === storedId || conversation.resolvedId === storedId

  if (list.group && matches(list.group)) {
    await selectConversation(c, bot, null)

    return { kind: 'current' }
  }

  const own = list.own.find(matches)

  if (own) {
    await selectConversation(c, bot, own)

    return { kind: 'current' }
  }

  return rows.some(row => row.id === storedId || row.resolved_id === storedId)
    ? { kind: 'viewer' }
    : { kind: 'current' }
}

// ── the conversations beside the canonical chat ────────────────────────────

/**
 * Fork this chat into a branch, from one row of its transcript.
 *
 * **Read `SessionBranchParams` before changing anything here.** It is
 * `{session_id, profile?, name?, count?}` — there is no row index and no row
 * id, so "branch from THIS message" is not something the method takes
 * literally. `count` is the only parameter that can express a position, and
 * the reading this app is built on is that it is **how many of the parent's
 * messages the child starts with**. `branchCountFor` turns a transcript row
 * into that number, and the fake gateway's handler implements the same
 * reading.
 *
 * That reading is an ASSUMPTION. It has not been checked against a running
 * gateway, because there is none here; `docs/platform-notes.md` says so in as
 * many words. If upstream means "the last `count` messages" instead, this call
 * and that handler are the two places that change.
 *
 * The runtime id, not the stored one: the contract's description is "fork a
 * LIVE session", and every session-scoped method upstream resolves through
 * `_sess_nowait`. A stored id would come back 4001.
 *
 * The branch is an ordinary VISIBLE session of the same profile — nothing in
 * the parameters can ask for a hidden one — so the canonical chat this was
 * taken from is untouched by construction rather than by care.
 */
export async function branchFrom(
  c: ChatController,
  botName: string,
  options: { messageCount: number; title: string }
): Promise<Conversation> {
  const sessionId = c.requireRuntime(botName)
  const result = await c.gateway.request('session.branch', {
    session_id: sessionId,
    profile: botName,
    name: options.title,
    // Never zero: a branch of no messages is a branch of nothing, and a
    // gateway that took it literally would hand back an empty conversation
    // with a name that promised otherwise.
    count: Math.max(1, Math.floor(options.messageCount))
  })

  const storedId = typeof result?.stored_session_id === 'string' ? result.stored_session_id : ''

  if (!storedId) {
    throw new Error(`The gateway branched ${botName}'s chat without returning its id.`)
  }

  return {
    id: storedId,
    resolvedId: storedId,
    // The title the gateway SETTLED on, not the one that was asked for: a name
    // already worn is refused upstream and the branch keeps whatever it ended
    // up with, so a list drawn from the asked-for name would not find it.
    title: typeof result?.title === 'string' && result.title ? result.title : options.title,
    preview: '',
    messageCount: typeof result?.message_count === 'number' ? result.message_count : 0,
    lastActive: Math.floor(c.now() / 1000),
    kind: 'branch'
  }
}

/**
 * Every conversation this profile has, grouped.
 *
 * `include_hidden` is on, and it has to be: the canonical chat is hidden by
 * definition (ADR-0007), so a listing without it is a listing with the one row
 * the reader is actually in missing from it.
 *
 * The roster's canonical id is passed through rather than re-derived from the
 * titles, because an id cannot be typed by hand into the wrong row — see
 * `classifyConversations`.
 */
export async function listConversations(c: ChatController, botName: string): Promise<ConversationGroups> {
  const result = await c.gateway.request('session.list', {
    profile: botName,
    include_hidden: true,
    limit: PROFILE_SESSION_LIST_LIMIT
  })

  const canonical = c.bots.getState().byName[botName]?.canonical
  const mine = c.userChats?.cached(botName) ?? null
  /*
    The roster's `canonical` is PINNED to the private chat while this bot is
    switched to "My chat" (`BotsController.placeUserChats`), so handing it in
    as the canonical id would name the wrong row — and would leave the real
    `Bot Chat` in `past`, where Delete is offered. When the two are the same
    session, no id is passed and the classifier falls back to the title, which
    is the canonical chat's identity anyway.
  */
  const shared = mine && canonical?.id === mine.id ? null : canonical

  return classifyConversations({
    rows: (result?.sessions ?? []) as SessionListRow[],
    ...(shared?.id ? { canonicalId: shared.id } : {}),
    ...(shared?.resolvedId ? { canonicalResolvedId: shared.resolvedId } : {}),
    ...(mine?.id ? { userChatId: mine.id } : {}),
    ...(c.userChats?.title ? { userChatTitle: c.userChats.title } : {})
  })
}

/**
 * Rename one conversation that is not the canonical chat.
 *
 * There is a round trip here that a reader will wonder about: the STORED id is
 * what a listing hands out, and `session.title` takes a RUNTIME one
 * (`_with_db(session_scoped=True)` over `_sess_nowait`). So a conversation
 * nothing is running has to be resumed before it can be renamed. Resuming is
 * cheap and idempotent — it is what opening the conversation would do anyway —
 * and the alternative is asking the reader to open a conversation before they
 * are allowed to name it.
 *
 * The refusals travel: `_set_session_title` raises on an empty title, on a
 * title another session already holds, and on renaming a hidden `Bot Chat`
 * away from its name. All three are the caller's to show, so nothing is
 * swallowed here.
 */
export async function renameConversation(
  c: ChatController,
  botName: string,
  storedId: string,
  title: string
): Promise<string> {
  const runtimeId = await runtimeIdFor(c, botName, storedId)
  const result = await c.gateway.request('session.title', {
    session_id: runtimeId,
    profile: botName,
    title
  })

  return typeof result?.title === 'string' ? result.title : title
}

/**
 * Delete one conversation.
 *
 * The STORED id, which is what `SessionDeleteParams` documents and the
 * opposite of `session.title` above.
 *
 * **This method does not check whether the conversation is canonical, on
 * purpose.** The guard is a type rather than a check —
 * `features/sessions/session-model.ts`'s `conversationActions` answers an
 * empty action list for the canonical row, so no surface can offer Delete on
 * it. Repeating the check here would make it look as though the surfaces were
 * allowed to be careless.
 */
export async function deleteConversation(c: ChatController, botName: string, storedId: string): Promise<void> {
  await c.gateway.request('session.delete', { session_id: storedId, profile: botName })
}

/**
 * Make one of the past conversations this bot's Bot Chat again.
 *
 * A SWAP, and the order is the same load-bearing one `/new` uses and for the
 * same reason: the title is the registry key, so while the outgoing chat still
 * wears `Bot Chat` the incoming one cannot take it. Upstream refuses a
 * duplicate outright — "Title 'Bot Chat' is already in use by session …".
 *
 * So: retire the current one through the very machinery `/new` retires with
 * (unhide, then rename to `Bot Chat · <date time>`), then rename the incoming
 * one and hide it, then switch. Every step that can fail rolls back towards
 * "nothing happened", because a bot left with no canonical chat is worse than
 * a swap that did not happen — the next open would mint a third one beside the
 * two that are already there.
 *
 * The refusal path is the one worth testing and it is real: a gateway that
 * will not let the incoming conversation be called `Bot Chat` leaves the
 * outgoing one retired and nameless, so the rollback puts its name back.
 */
export async function adoptAsCanonical(c: ChatController, botName: string, storedId: string): Promise<void> {
  const bot = c.bots.getState().byName[botName]

  if (!bot) {
    throw new Error(`${botName} is not on the roster.`)
  }

  /*
    The conversation being put away is the GROUP chat. Under the bot's key
    that is the chat on screen — unless the key is parked in one of the
    reader's own chats, which must never be retired as though it were the
    Bot Chat. Then the group chat is resumed by its own id.
  */
  const parked = c.boundOwnId(botName)
  const current = parked
    ? bot.canonical?.id
      ? await runtimeIdFor(c, botName, bot.canonical.id)
      : undefined
    : c.chats.getState().chats[botName]?.runtimeSessionId
  const incoming = await runtimeIdFor(c, botName, storedId)
  const retired = `${CANONICAL_CHAT_TITLE} · ${localStamp(c.now())}`

  if (current) {
    await unhideForRetire(c, botName, current)

    try {
      await renameSession(c, botName, current, retired)
    } catch (error) {
      // Nothing has moved yet, so putting the hidden flag back is the whole of
      // the undo.
      await undoRetire(c, botName, current, false)

      throw error
    }
  }

  try {
    await renameSession(c, botName, incoming, CANONICAL_CHAT_TITLE)
  } catch (error) {
    // The title did not move. The outgoing chat is sitting under a retired
    // name with nothing holding the canonical title, which is precisely the
    // state that makes the next open mint a third chat — so its name goes
    // back before this throws.
    if (current) {
      await undoRetire(c, botName, current, true)
    }

    throw error
  }

  /*
    Hidden, because that is what makes it canonical to everything that looks
    for one: `_canonical_session_row` resolves by title, and the roster's own
    lookup sends `include_hidden`. Best effort — the title has already moved,
    so the swap has happened either way, and a visible `Bot Chat` still
    resolves.
  */
  try {
    await c.gateway.request('session.set_hidden', {
      session_id: incoming,
      profile: botName,
      hidden: true
    })
  } catch (error) {
    noteRpcFailure(c, 'session.set_hidden', error)
  }

  if (parked) {
    // The reader asked for this conversation to be the group chat, so the
    // group chat is where they are now.
    c.userChats?.rememberCurrent?.(botName, null)
  }

  await switchCanonical(c, bot, {
    id: storedId,
    resolvedId: storedId,
    preview: '',
    lastActive: Math.floor(c.now() / 1000),
    messageCount: 0
  })
}

/**
 * `session.status`: the gateway's report on this chat's live session (model,
 * tokens, what is running), as the plain text the TUI shows for `/status`.
 * Rejects when the chat is not attached or the gateway refuses.
 */
export async function sessionStatus(c: ChatController, botName: string): Promise<string> {
  const sessionId = c.requireRuntime(botName)
  let result: { output?: unknown } | undefined

  try {
    result = (await c.gateway.request('session.status', {
      session_id: sessionId,
      profile: botOfConversationKey(botName)
    })) as { output?: unknown } | undefined
  } catch (error) {
    noteRpcFailure(c, 'session.status', error)

    throw error
  }

  return typeof result?.output === 'string' ? result.output : ''
}

// ── chat options ───────────────────────────────────────────────────────────

/**
 * Set one of the chat's runtime options.
 *
 * All four are `config.set` under the hood, scoped to this session so the
 * toggle never rewrites the gateway's global configuration behind the user's
 * back. The model switch can come back asking for confirmation, which is the
 * gateway's way of saying the model is expensive; that answer is handed to
 * the caller rather than auto-confirmed.
 */
export async function setOption(
  c: ChatController,
  botName: string,
  key: ChatOptionKey,
  value: string,
  options: { confirmExpensiveModel?: boolean } = {}
): Promise<SetOptionResult> {
  const sessionId = c.requireRuntime(botName)
  const result = await c.gateway.request('config.set', {
    key,
    value,
    session_id: sessionId,
    profile: botName,
    ...(key === 'yolo' || key === 'reasoning' ? { scope: 'session' } : {}),
    ...(key === 'model' && options.confirmExpensiveModel ? { confirm_expensive_model: true } : {})
  })

  if (result?.info) {
    c.chats.getState().dispatchEvent(botName, {
      type: 'session.info',
      session_id: sessionId,
      payload: result.info
    })
  } else {
    await refreshOptions(c, botName)
  }

  return {
    ...(result?.confirm_required ? { confirmRequired: true } : {}),
    ...(result?.confirm_message ? { confirmMessage: result.confirm_message } : {}),
    ...(result?.warning ? { warning: result.warning } : {})
  }
}

/**
 * The gateway's model catalogue, flattened to `provider/model` ids.
 *
 * Fetched once per connection and kept: the inventory is a per-gateway fact,
 * not a per-chat one, and it is big enough that re-reading it every time the
 * options sheet opens would be felt. A gateway that cannot answer gets an
 * empty list rather than an error — the picker then shows only the model the
 * chat is already on, which is honest.
 */
export async function modelOptions(c: ChatController): Promise<ModelChoice[]> {
  if (c.models) {
    return c.models
  }

  if (!c.modelsInFlight) {
    c.modelsInFlight = c.gateway
      .request('model.options', {})
      .then(result => {
        const choices: ModelChoice[] = []

        for (const provider of result?.providers ?? []) {
          const slug = provider.slug || provider.name || ''

          for (const model of provider.models ?? []) {
            // The inventory writes plain ids; a model already carrying its
            // provider must not be prefixed twice.
            const id = model.includes('/') ? model : slug ? `${slug}/${model}` : model

            choices.push({ id, label: model, provider: provider.name || slug })
          }
        }

        c.models = choices

        return choices
      })
      .catch(() => {
        c.models = []

        return []
      })
      .finally(() => {
        c.modelsInFlight = null
      })
  }

  return c.modelsInFlight
}

/**
 * Re-read the four chat options so the sheet reflects what the gateway holds.
 *
 * Deliberately NOT `session.resume`. Resuming is a write: it mints a new
 * runtime session id, rebinds the socket's transport to it and schedules an
 * agent build. Using it to answer "what model is this chat on" rebuilt the
 * session every time the options sheet opened, which invalidated the very
 * event watermark the sheet was opened alongside. `config.get` is the read.
 */
export async function refreshOptions(c: ChatController, botName: string): Promise<SessionLiveInfo | null> {
  const chat = c.chats.getState().chats[botName]
  const sessionId = chat?.runtimeSessionId

  if (!sessionId) {
    return null
  }

  const keys: ChatOptionKey[] = ['model', 'yolo', 'fast', 'reasoning']
  const values = await Promise.all(
    keys.map(async key => {
      try {
        const result = await c.gateway.request('config.get', { key, session_id: sessionId, profile: botName })

        return typeof result?.value === 'string' ? result.value : key === 'model' ? (result?.model ?? '') : ''
      } catch {
        // A gateway that cannot answer one key leaves that row as it was
        // rather than failing the whole sheet.
        return ''
      }
    })
  )

  const [model, yolo, fast, reasoning] = values
  const patch: SessionLiveInfo = {
    ...(model ? { model } : {}),
    ...(yolo ? { yolo: yolo === 'on' || yolo === '1' || yolo === 'true' } : {}),
    ...(fast ? { fast: fast === 'fast' || fast === 'on' || fast === 'true' } : {}),
    ...(reasoning ? { reasoning_effort: reasoning } : {})
  }

  if (!Object.keys(patch).length) {
    return null
  }

  // `session.info` replaces the whole record, so the four keys read here go
  // on top of what the resume reported rather than in place of it.
  const info: SessionLiveInfo = { ...c.chats.getState().chats[botName]?.info, ...patch }

  c.chats.getState().dispatchEvent(botName, {
    type: 'session.info',
    session_id: sessionId,
    payload: info
  })

  return info
}

/**
 * Ask the gateway how full this session's context window is.
 *
 * Nearly always unnecessary, and that is the shape of it: the reducer already
 * folds `session.usage` ticks and the `usage` on `message.complete` into
 * `ChatState.usage`, so a chat that has run a turn since it was opened is
 * already current. This covers the other case — a chat resumed and not yet
 * spoken to, whose `session.resume` answered without `info.usage`.
 *
 * **Capability-gated by the gateway's own refusal**, not by a version test. A
 * gateway that does not know the method answers an error once, that is
 * remembered for the life of the connection, and nothing asks again; the
 * caller sees `null` and the surfaces draw nothing. A missing method is not a
 * fault a reader should be told about, which is why this answers `null` rather
 * than throwing — but it is still recorded in the RPC failure ring, because a
 * swallowed error that nothing anywhere admits to is the defect
 * `rpc-failures.ts` was written for.
 */
export async function refreshUsage(c: ChatController, botName: string): Promise<Usage | null> {
  const chat = c.chats.getState().chats[botName]
  const sessionId = chat?.runtimeSessionId

  if (!sessionId || !c.usageSupported) {
    return null
  }

  let usage: Usage

  try {
    usage = (await c.gateway.request('session.usage', {
      session_id: sessionId,
      profile: botName
    })) as Usage
  } catch (error) {
    c.usageSupported = false
    noteRpcFailure(c, 'session.usage', error)

    return null
  }

  if (!usage || typeof usage !== 'object') {
    return null
  }

  c.chats.getState().dispatchEvent(botName, {
    type: 'session.usage',
    session_id: sessionId,
    payload: { usage } as unknown as Record<string, unknown>
  })

  return usage
}

/** `complete.slash`, with the session named only where the gateway takes it. */
async function completeSlash(c: ChatController, typed: string, sessionId: string): Promise<CompleteSlashResult> {
  const params = c.slashSessionParam ? { text: typed, session_id: sessionId } : { text: typed }

  try {
    return await c.gateway.request('complete.slash', params)
  } catch (error) {
    if (!c.slashSessionParam || !refusesSessionId(error)) {
      throw error
    }

    c.slashSessionParam = false
    noteRpcFailure(c, 'complete.slash', error)

    return await c.gateway.request('complete.slash', { text: typed })
  }
}

/**
 * Fetch the catalogue once, however many keystrokes ask for it.
 *
 * The in-flight promise is the cache until it settles. A refusal leaves
 * NOTHING cached, so the next keystroke tries again — the alternative, which
 * is what shipped, was an empty catalogue pinned to the session for as long as
 * it lived.
 */
async function fetchSlashCatalog(c: ChatController, botName: string, sessionId: string): Promise<SlashFailure | null> {
  const inFlight = c.slashCatalogLoads.get(sessionId)

  if (inFlight) {
    return await inFlight
  }

  const load = c.gateway
    .request('commands.catalog', { session_id: sessionId, profile: botName })
    .then((catalog): SlashFailure | null => {
      c.slashCatalogs.set(sessionId, catalog ?? {})

      return null
    })
    .catch((error: unknown): SlashFailure | null => noteRpcFailure(c, 'commands.catalog', error))
    .finally(() => {
      c.slashCatalogLoads.delete(sessionId)
    })

  c.slashCatalogLoads.set(sessionId, load)

  return await load
}

async function dispatchSlash(
  c: ChatController,
  botName: string,
  command: string,
  depth: number
): Promise<SlashOutcome> {
  const { arg, name } = parseSlashCommand(command)

  // BEFORE the catalogue lookup and before any round trip: a `/new` that
  // reaches the gateway has already failed, whichever method carries it.
  // Checked at every depth, so an alias resolving to one of these lands here
  // too rather than on the worker.
  if (NEW_CONVERSATION_COMMANDS.has(name)) {
    await startNewConversation(c, botName, arg, command)

    return {}
  }

  const sessionId = c.requireRuntime(botName)

  if (name === STATUS_COMMAND && c.slashRouteFor(botName, name) === 'local') {
    slashOutput(c, botName, sessionId, command, await sessionStatus(c, botName))

    return {}
  }
  const result = await callSlash(c, botName, sessionId, command, name, arg)
  const directive = parseCommandDispatch(result)

  if (result?.warning) {
    commandRow(c, botName, sessionId, command, String(result.warning))
  }

  // No `type`: plain worker or plugin text, which is the common case.
  if (!directive) {
    slashOutput(c, botName, sessionId, command, result?.output ?? '')

    return {}
  }

  switch (directive.type) {
    case 'exec':
    case 'plugin':
      slashOutput(c, botName, sessionId, command, directive.output ?? '')

      return {}

    case 'alias': {
      // One hop only. An alias that points at an alias that points back would
      // otherwise pace the socket until something gave out.
      if (depth > 0 || !directive.target.trim()) {
        commandRow(c, botName, sessionId, command, 'That is an alias the gateway could not follow.')

        return {}
      }

      const target = directive.target.startsWith('/') ? directive.target : `/${directive.target}`

      return await dispatchSlash(c, botName, arg ? `${target} ${arg}` : target, depth + 1)
    }

    case 'prefill':
      if (directive.notice) {
        commandRow(c, botName, sessionId, command, directive.notice)
      }

      // The caller owns the composer; the controller does not reach into it.
      return { prefill: directive.message }

    case 'send':
    case 'skill': {
      const message = directive.message ?? ''
      // A skill directive carries no `notice` in the vendored union; a send
      // does. Read it off the raw result so both shapes reach the reader.
      const notice = typeof result?.notice === 'string' ? result.notice.trim() : ''

      if (notice) {
        commandRow(c, botName, sessionId, command, notice)
      }

      if (!message.trim()) {
        commandRow(c, botName, sessionId, command, directive.display ?? 'Nothing to send.')

        return {}
      }

      // The bubble shows the invocation; the gateway is sent the expansion.
      await c.send(botName, message, [], { display: directive.display ?? command })

      return {}
    }
  }
}

/**
 * Point this bot at a different canonical chat and open it.
 *
 * Everything keyed by the OLD session or by the bot is dropped and the normal
 * open path runs again, rather than a second hydration written specially for
 * this: `session.resume` binds the new runtime id, the empty transcript
 * paints, the hydration states move in the order every other open moves them,
 * and whatever was queued or parked on the old session goes with it.
 */
async function switchCanonical(c: ChatController, bot: Bot, canonical: BotCanonicalSession): Promise<void> {
  const botName = bot.name
  const previous = c.chats.getState().chats[botName]?.runtimeSessionId

  if (c.boundOwnId(botName)) {
    // Parked in one of the reader's own chats (an adopt from there): that chat
    // is left properly, its watermark and cache written under its OWN key,
    // before `current` is cleared and the key forgets it.
    c.markLeft(botName)
    await c.persist(botName)
  }

  // The roster is the one thing that would undo this, so it is told first —
  // and told in a way a poll already in the air cannot reverse. See
  // `canonicalPins` in the bots store.
  c.bots.getState().setCanonical(botName, canonical)
  // And the key goes onto that canonical chat, not onto an own chat it may
  // have been parked on.
  c.bots.getState().setCurrent(botName, null)

  if (previous) {
    c.slashCatalogs.delete(previous)
    c.parked.delete(previous)
  }

  c.windows.delete(botName)
  c.loadingOlder.delete(botName)

  /*
    The transcript cache is keyed by BOT, not by session, so what is on disk is
    the conversation just put away. Left there, `paintFromCache` would paint it
    under the new session's ids and the history reconcile would merge an empty
    live transcript into it — the new chat would open holding the old one.
  */
  if (c.cache) {
    try {
      await c.cache.forget(botName)
    } catch {
      // A cache that cannot be cleared is one more reason not to read it.
    }
  }

  c.chats.getState().forget(botName)

  await c.openChat(botOn({ ...bot, canonical }, null))
}

/** One profile listing, and the list built from it. */
async function listProfile(
  c: ChatController,
  botName: string
): Promise<{ rows: SessionListRow[]; list: ConversationList }> {
  const result = await c.gateway.request('session.list', {
    profile: botName,
    include_hidden: true,
    limit: PROFILE_SESSION_LIST_LIMIT
  })
  const rows = (result?.sessions ?? []) as SessionListRow[]
  const lead = c.lead
  const canonical = c.bots.getState().byName[botName]?.canonical
  const pinnedOnOwn =
    Boolean(canonical?.id) &&
    rows.some(row => (row.id === canonical?.id || row.resolved_id === canonical?.id) && isOwnChatTitle(row.title, lead))
  const list = buildConversationList({
    rows,
    lead,
    ...(canonical?.id && !pinnedOnOwn ? { canonicalId: canonical.id } : {}),
    ...(canonical?.resolvedId && !pinnedOnOwn ? { canonicalResolvedId: canonical.resolvedId } : {}),
    lastOpenedAt: c.bots.getState().lastOpened
  })

  const bots = c.bots.getState()
  const bound = c.boundOwnId(botName)
  const live = c.chats.getState().chats[botName]

  for (const conversation of list.own) {
    c.ownTitles.set(conversation.id, conversation.title)
    c.listedCounts.set(conversation.id, conversation.messageCount)

    const key = conversationKey(botName, conversation.id)

    /*
      The own chat live here, read to its newest message and not mid-reply:
      whatever the gateway counts in it, the reader has seen, so its count is
      the gateway's own. A chat just read is never listed as unread.
    */
    if (
      bound === conversation.id &&
      live &&
      !live.turn.active &&
      (bots.lastSeen[key] ?? 0) >= lastMessageAt(live) &&
      conversation.messageCount > (bots.seenCounts[key] ?? 0)
    ) {
      bots.markSeenCount(key, conversation.messageCount)
    }
  }

  return { rows, list }
}

/** Put the reader's memory back as it was, for a switch that did not happen. */
function restoreMemory(c: ChatController, botName: string, memory: string | null | undefined): void {
  const source = c.userChats

  if (!source?.rememberCurrent) {
    return
  }

  // A dated choice, not a chore: other devices may already have followed the
  // switch that did not happen, and must follow it back.
  source.rememberCurrent(botName, memory ?? null)

  if (memory === null) {
    // A legacy entry: the bare-lead chat nobody resolved yet.
    source.remember(botName, 'mine')
  }
}

/**
 * `/new` inside one of the reader's own chats: another own chat beside it.
 *
 * The one being left is kept exactly as it is — it is still in the reader's
 * list — and the group chat is never touched: retiring and re-minting the
 * `Bot Chat` is a shared action, and it stays `/new`'s meaning in the group
 * chat only. A name given to the command names the NEW chat.
 */
async function startAnotherOwnChat(
  c: ChatController,
  bot: Bot,
  sessionId: string,
  storedId: string,
  arg: string,
  command: string
): Promise<void> {
  const botName = bot.name
  const lead = c.lead
  const leaving = c.ownTitles.get(storedId)
  let created: Conversation

  try {
    created = await startOwnChat(c, bot, { label: arg })
  } catch (error) {
    commandRow(
      c,
      botName,
      sessionId,
      command,
      `The gateway would not start a new chat (${messageOf(error)}). You are still in the one you were in.`
    )

    return
  }

  const kept = leaving ? ownChatLabel(leaving, lead) || 'My chat' : ''

  commandRow(
    c,
    botName,
    c.chats.getState().chats[botName]?.runtimeSessionId ?? '',
    command,
    kept
      ? `New chat started: “${ownChatLabel(created.title, lead)}”. The one you were in is still in your chats as “${kept}”.`
      : `New chat started: “${ownChatLabel(created.title, lead)}”. The one you were in is still in your chats.`
  )
}

/** Is this stored id the bot's group chat, as far as the roster knows? */
function isGroupId(c: ChatController, bot: Bot, storedId: string): boolean {
  const canonical = c.bots.getState().byName[bot.name]?.canonical ?? bot.canonical

  return Boolean(canonical && (canonical.id === storedId || canonical.resolvedId === storedId))
}

/**
 * An own chat's first message names it, while it still wears the stamp it was
 * born with. Best effort, once per chat: a refusal is recorded and the stamp
 * stays, which is a name, only a dull one.
 */
async function relabelFromFirstMessage(
  c: ChatController,
  botName: string,
  storedId: string,
  runtimeId: string,
  text: string
): Promise<void> {
  const lead = c.lead
  const title = c.ownTitles.get(storedId)

  if (!lead || !title || c.relabelTried.has(storedId) || !isStampLabel(ownChatLabel(title, lead))) {
    return
  }

  const label = labelFromText(text)

  if (!label) {
    return
  }

  c.relabelTried.add(storedId)

  try {
    c.ownTitles.set(storedId, await titleSession(c, botName, runtimeId, ownChatTitle(lead, label)))
    c.notifyConversations(botName)
  } catch (error) {
    noteRpcFailure(c, 'session.title', error)
  }
}

/** `session.title` on a RUNTIME id, answering the title the gateway settled on. */
async function titleSession(c: ChatController, botName: string, runtimeId: string, title: string): Promise<string> {
  const result = await c.gateway.request('session.title', { session_id: runtimeId, profile: botName, title })

  return typeof result?.title === 'string' && result.title ? result.title : title
}

/** Close a session this controller started and could not finish setting up. */
async function closeQuietly(c: ChatController, botName: string, runtimeId: string): Promise<void> {
  try {
    await c.gateway.request('session.close', { session_id: runtimeId, profile: botName })
  } catch (error) {
    noteRpcFailure(c, 'session.close', error)
  }
}

/**
 * Take the canonical chat out of hiding, so that its title can change at all.
 *
 * Upstream refuses to rename a HIDDEN session titled `Bot Chat` away from that
 * title — `hermes_state_titles.py::_set_session_title` raises "This is the
 * bot's canonical Bot Chat — its name is its identity, and renaming it would
 * orphan the conversation." Hidden is the discriminator the guard tests, and
 * upstream's own comment beside it says what that means: "a visible session
 * merely named 'Bot Chat' stays renameable". So lifting the flag is the
 * documented way past the guard rather than a trick played on it — and the
 * retired conversation becoming an ordinary visible session is where a reader
 * would go looking for it anyway.
 *
 * Best effort. A gateway without the guard does not need this, and one that
 * refuses the call will refuse the rename next with a message worth reading.
 */
async function unhideForRetire(c: ChatController, botName: string, sessionId: string): Promise<void> {
  try {
    await c.gateway.request('session.set_hidden', { session_id: sessionId, profile: botName, hidden: false })
  } catch (error) {
    noteRpcFailure(c, 'session.set_hidden', error)
  }
}

/**
 * Rename the session a RUNTIME id names.
 *
 * The runtime id, not the durable one: `session.title` is session-scoped
 * upstream (`_with_db(session_scoped=True)` over `_sess_nowait`), so it is
 * looked up in the live `_sessions` map and a stored id comes back 4001
 * "session not found". What it renames is that session's `session_key`, which
 * IS the durable row.
 */
async function renameSession(c: ChatController, botName: string, sessionId: string, title: string): Promise<void> {
  await c.gateway.request('session.title', { session_id: sessionId, profile: botName, title })
}

/** Undo a retire that could not be followed through; best effort throughout. */
async function undoRetire(c: ChatController, botName: string, sessionId: string, renamed: boolean): Promise<void> {
  if (renamed) {
    try {
      await renameSession(c, botName, sessionId, CANONICAL_CHAT_TITLE)
    } catch (error) {
      noteRpcFailure(c, 'session.title', error)
    }
  }

  try {
    await c.gateway.request('session.set_hidden', { session_id: sessionId, profile: botName, hidden: true })
  } catch (error) {
    noteRpcFailure(c, 'session.set_hidden', error)
  }
}

/**
 * A runtime id for a stored one, resuming the session if nothing is running.
 *
 * The live id is preferred where the app already holds one — resuming a
 * session that is already up mints nothing new but does cost a round trip and
 * a rebuild of its runtime state.
 */
async function runtimeIdFor(c: ChatController, botName: string, storedId: string): Promise<string> {
  const key = conversationKey(botName, storedId)
  const open = c.chats.getState().chats[key]?.runtimeSessionId
  const canonicalChat = c.chats.getState().chats[botName]

  if (open) {
    return open
  }

  if (canonicalChat?.storedSessionId === storedId && canonicalChat.runtimeSessionId) {
    return canonicalChat.runtimeSessionId
  }

  const resume = await c.gateway.request('session.resume', {
    session_id: storedId,
    profile: botName,
    omit_messages: true,
    source: 'hermie',
    cols: RESUME_COLS
  })

  const runtimeId = typeof resume?.session_id === 'string' ? resume.session_id : ''

  if (!runtimeId) {
    throw new Error(`The gateway resumed a conversation of ${botName}'s without a session id.`)
  }

  return runtimeId
}

/**
 * Put the command on the gateway, down whichever road takes it.
 *
 * The catalogue decides first, and the gateway's own refusal is the backstop:
 * a bundle is not in `skills`, and upstream answers it with the same
 * "use command.dispatch" 4018 that it answers a skill with. Reading that
 * refusal and retrying is cheaper than keeping a second copy of upstream's
 * rules here and hoping it stays true.
 */
async function callSlash(
  c: ChatController,
  botName: string,
  sessionId: string,
  command: string,
  name: string,
  arg: string
): Promise<SlashExecResult> {
  const dispatch = async (): Promise<SlashExecResult> =>
    await c.gateway.request('command.dispatch', {
      name,
      arg,
      session_id: sessionId,
      profile: botName
    })

  if (c.slashRouteFor(botName, name) === 'dispatch') {
    return await dispatch()
  }

  try {
    return await c.gateway.request('slash.exec', { session_id: sessionId, command, profile: botName })
  } catch (error) {
    if (!WANTS_DISPATCH_RE.test(error instanceof Error ? error.message : String(error))) {
      throw error
    }

    noteRpcFailure(c, 'slash.exec', error)

    return await dispatch()
  }
}

/** One command's output, as the row kind a reader cannot miss. */
function slashOutput(c: ChatController, botName: string, sessionId: string, command: string, output: string): void {
  commandRow(c, botName, sessionId, command, output.trim() || 'Ran, with no output.')
}

/**
 * A slash command's answer, in the ONE shape every command's answer has.
 *
 * Title is the line the owner typed and body is the whole answer — a warning,
 * a refusal, five kilobytes of `/help` ASCII table, or a single word. It used
 * to depend on the length: one line went into the TITLE and nothing into the
 * body, so `NoticePill` drew it with no disclosure at all, while a longer one
 * was titled `/help — 214 lines`. Two shapes meant the reader had to work out
 * which one they had before they could read it, and the short one could not be
 * folded at all.
 *
 * `noticeKind: 'command'` is what keeps the row on screen at `quiet` — the
 * default view, where every other notice is dropped — and what opens it
 * without a tap. The reducer accepts that kind from this event and no other
 * (`reducer.ts`, `case 'notice'`), so it is this client saying "the owner
 * asked for this", never the gateway promoting its own narration.
 */
function commandRow(c: ChatController, botName: string, sessionId: string, command: string, body: string): void {
  c.chats.getState().dispatchEvent(botName, {
    type: 'notice',
    session_id: sessionId,
    payload: { message: command.trim() || '/', detail: body, noticeKind: 'command' }
  })
}

/**
 * Remember a swallowed gateway refusal so the debug screen can show it, and
 * hand the caller the same failure in the shape a SURFACE can draw.
 *
 * The ring was the only reader for a long time, and that is exactly how the
 * composer's empty popover stayed invisible: a call failed, the developer
 * screen recorded it, and the reader saw nothing at all. A method that
 * absorbs a refusal now gets the words back and can decide to show them.
 */
function noteRpcFailure(c: ChatController, method: string, error: unknown): SlashFailure {
  const failure = describeRpcFailure(method, error, c.now())

  c.onRpcFailure?.(failure)

  return slashFailureOf(failure)
}

/**
 * The gateway's way of saying "right command, wrong method".
 *
 * Upstream's `slash.exec` answers a skill or a bundle with
 * `4018 skill command: use command.dispatch for /<name>` rather than running
 * it. Matched on the method name because that is the part of the sentence that
 * is a protocol fact; the rest of it is prose upstream is free to reword.
 */
const WANTS_DISPATCH_RE = /command\.dispatch/u

/**
 * The refusal an older gateway gives `complete.slash` for a `session_id` it does
 * not know: pydantic's "Extra inputs are not permitted", naming the field.
 */
function refusesSessionId(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)

  return /session_id/u.test(message) && /Extra inputs are not permitted/u.test(message)
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/**
 * `2026-09-21 23:16`, in the reader's own zone — a retired chat is filed by when
 * they left it, a new own chat by when it was started. `seconds` adds `:ss`, for
 * the one retry after a title clash within the same minute.
 */
function localStamp(now: number, seconds = false): string {
  const at = new Date(now)
  const pad = (value: number): string => String(value).padStart(2, '0')
  const minute = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`

  return seconds ? `${minute}:${pad(at.getSeconds())}` : minute
}

/** `Ideas (2)`: a label with a number after it, still within the label limit. */
function numbered(label: string, count: number): string {
  const suffix = ` (${count})`

  return `${label.slice(0, OWN_CHAT_LABEL_MAX - suffix.length).trim()}${suffix}`
}

/** A label the reader gave, cut to what an own chat's name may carry. */
function cutLabel(label: string): string {
  const clean = collapse(label)

  return clean.length > OWN_CHAT_LABEL_MAX ? clean.slice(0, OWN_CHAT_LABEL_MAX).trim() : clean
}

/**
 * The gateway's "that title is taken" (`hermes_state_titles.py`, 4022).
 *
 * Read off the error's own code where the channel kept it, and off the
 * serialized JSON-RPC error otherwise — the same two shapes
 * `describeRpcFailure` reads.
 */
const TITLE_CLASH_CODE = 4022

function isTitleClash(error: unknown): boolean {
  if (error && typeof error === 'object' && (error as { code?: unknown }).code === TITLE_CLASH_CODE) {
    return true
  }

  return describeRpcFailure('session.title', error, 0).code === TITLE_CLASH_CODE
}

const retireFailed = (reason: string): string =>
  `The gateway would not put this conversation away (${reason}), so nothing was changed.`

/** What `/new` says once it has worked; the retired name is the whole point of it. */
function newConversationNotice(retired: string, asked: string, refusedName: string): string {
  const kept = `New conversation started. The previous one is kept as “${retired}”.`

  if (refusedName) {
    return `${kept} The gateway would not take “${asked}” (${refusedName}), so it was filed under its own name instead.`
  }

  if (asked) {
    return `${kept} A name given to this command goes on the conversation being put away, not on the new one — a bot's chat is always called “${CANONICAL_CHAT_TITLE}”.`
  }

  return kept
}

/** What `ChatController` hands its calls to (`onDemandPart`): every public function above, and the relabel a send starts. */
const part = {
  uploadFile,
  uploadFileTo,
  steerSubagent,
  interruptSubagent,
  tailSubagent,
  childTranscript,
  prefetchTail,
  loadActivity,
  activeSubagentCount,
  inFlightDeliveries,
  querySlash,
  runSlash,
  startNewConversation,
  chooseChat,
  listBotConversations,
  selectConversation,
  startOwnChat,
  renameOwnChat,
  deleteOwnChat,
  openSession,
  branchFrom,
  listConversations,
  renameConversation,
  deleteConversation,
  adoptAsCanonical,
  sessionStatus,
  setOption,
  modelOptions,
  refreshOptions,
  refreshUsage,
  relabelFromFirstMessage
}

export type ChatControllerOnDemand = typeof part

provideChatControllerOnDemand(part)
