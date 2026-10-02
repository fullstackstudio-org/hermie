/**
 * Wires the chat layer to the app's one gateway connection.
 *
 * The controllers below are plain objects with no React in them; this component
 * exists only to give them a lifetime, hand them the live connection, and follow
 * the app between foreground and background. Everything a screen needs is read
 * from the stores, so nothing re-renders because a controller did something.
 */
import { ownAuthorOf } from '@hermie/gateway-client'
import type { MessageAuthor } from '@hermie/transcript'
import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { AppState } from 'react-native'

import { requestOpenChat } from '../../app/open-chat-bus'
import { gatewayForKey, useGateway } from '../../gateway'
import { chatGatewayFor, type ChatGateway } from '../../gateway/link'
import { loadHermieWebConfig, type HermieWebConfig } from '../../gateway/web-config'
import { useConnectionStore } from '../../gateway/store'
import { namespace } from '../../gateway/namespace'
import { chatCacheFor } from '../../platform/chat-cache'
import { RUNS_IN_DESKTOP_SHELL } from '../../platform/desktop-shell'
import { intentQueue } from '../../platform/intent-queue'
import { RUNS_ON_MAC } from '../../platform/runs-on-mac'
import { shareInbox } from '../../platform/share-inbox'
import { useAppStampStore } from '../../store/app-stamp'
import { useBotsStore } from '../../store/bots'
import { currentTargetOf, useChatLayoutStore } from '../../store/chat-layout'
import { useChatsStore } from '../../store/chats'
import { OWNER_USER_ID, useDeviceContextStore } from '../../store/device-context'
import { usePeoplePicturesStore } from '../people/people-pictures'
import { useVoiceSettingsStore } from '../voice/voice-settings'
import { useMcpProbeStore } from '../mcp'
import { usePluginStore } from '../../store/plugin'
import { usePushStore } from '../../store/push'
import { useSettingsStore } from '../../store/settings'
import { useShareStore } from '../../store/share'
import { UiMetaBridge } from '../../store/ui-meta-bridge'
import { isThemePresetName } from '../../ui/themes'
import { BotsController } from '../bots/bots-controller'
import { pushPlatform } from '../push/platform'
import { PushSync } from '../push/push-sync'
import { setPushRetire } from '../push/runtime'
import { startReplyWatch } from '../intents/await-reply'
import { onIntentRequest } from '../intents/intent-bus'
import { IntentRunner } from '../intents/intent-runner'
import { pushProjectId, pushVapidUrl } from '../push/where'
// Reached by module rather than through `../share`'s barrel: that barrel also
// exports the picker's own sheet, and a barrel imported from the module it
// renders is how an import cycle starts.
import { onShareRequest } from '../share/share-bus'
import { ShareDelivery } from '../share/share-delivery'
import { ShareTargetHost } from '../share/ShareTargetHost'
import { applyBranding, featureOn } from '../branding'
import { UserChatDirectory, userChatSwitch, type UserChatSwitch } from '../user-chats'
import { WidgetSync } from '../widgets'
import { resizeToBase64 } from './attachments'
import { ChatController } from './chat-controller'
import { ownAuthorOn, useOwnAuthorStore } from './own-author'

export interface ChatRuntimeValue {
  controller: ChatController
  bots: BotsController
  /** ADR-0016's settings sync. Local-only until a gateway takes a write. */
  uiMeta: UiMetaBridge
  /**
   * ADR-0007, amended: the shared Bot Chat or the reader's own, per bot.
   *
   * On the value rather than reached through the controller, because the two
   * surfaces that draw the switch need `available` to decide whether to draw it
   * at all — and a control that asked the controller whether it should exist
   * would be a control that exists.
   */
  userChats: UserChatSwitch
  /** Writes the file the home-screen widgets read. No-op where there is none. */
  widgets: WidgetSync
  /** ADR-0017: the registration, the heartbeat, and what a tap is allowed to do. */
  push: PushSync
  /** The share sheet's outbox, drained into real messages. No-op where there is none. */
  share: ShareDelivery
  /** What a Shortcut asked for, run and answered. No-op where there are none. */
  intents: IntentRunner
  /** The connection, as the slice everything in here is written against. */
  gateway: ChatGateway
}

/**
 * The identity this device's chats and `ui_meta` profile are read under.
 *
 * `/api/auth/me` is the only thing that knows, and it is asked once per ready
 * edge rather than held in the stored config: a config written by an older
 * build has no user id in it, and a display name changes at the provider
 * without the app being told. A refusal is not an error — it leaves the
 * identity empty, which is exactly the state in which nothing is written.
 *
 * All three identity fields are handed over SEPARATELY, and the address is not
 * folded into the name on the way. `display_name` and `email` are both optional
 * on the far side — an OIDC gateway answered with neither, only a subject — so
 * which of them ends up being shown is a question with one answer, and it lives
 * in `effectiveDisplayName` rather than being decided twice.
 *
 * `author` is the same answer read a second way: the reader's own id as the
 * gateway stamps it on a message row (`"<provider>:<user_id>"`, HERM-83), for
 * `useOwnAuthorStore`. It is NOT `userId` — that one keys `ui_meta` and falls
 * back to the email, and a stamp is never an email — and it is absent on a
 * session-token gateway, which stamps nobody.
 */
async function readIdentity(
  config: { baseUrl: string; authMode: string } | null,
  http: {
    authMe: () => Promise<{ userId: string; email: string; displayName: string; provider: string }>
  } | null
): Promise<{
  baseUrl: string
  gated: boolean
  userId: string
  displayName: string
  email: string
  author?: MessageAuthor
}> {
  const baseUrl = config?.baseUrl ?? ''
  const gated = config?.authMode !== 'session_token'

  if (!gated) {
    return { baseUrl, gated: false, userId: OWNER_USER_ID, displayName: '', email: '' }
  }

  if (!http) {
    // Gated, and no REST half to ask. Empty rather than the owner id: writing
    // to a profile under a name the gateway never agreed to is worse than
    // writing to none.
    return { baseUrl, gated: true, userId: '', displayName: '', email: '' }
  }

  const identity = await http.authMe()
  const author = ownAuthorOf(identity)

  return {
    baseUrl,
    gated: true,
    userId: identity.userId || identity.email,
    displayName: identity.displayName,
    email: identity.email,
    ...(author ? { author } : {})
  }
}

const ChatRuntimeContext = createContext<ChatRuntimeValue | null>(null)

export function ChatRuntimeProvider({ children }: { children: ReactNode }) {
  const { config, connection, gatewayId, http, registry, status, switchGateway } = useGateway()
  const [value, setValue] = useState<ChatRuntimeValue | null>(null)
  /** The service's bootstrap, for the feature flags. `null` off the web. */
  const [webConfig, setWebConfig] = useState<HermieWebConfig | null>(null)
  const webConfigRef = useRef<HermieWebConfig | null>(null)
  webConfigRef.current = webConfig
  const valueRef = useRef<ChatRuntimeValue | null>(null)
  /*
    The list, through a ref.

    The push ports below are built once per connection and captured by closures
    that outlive a render, so reading the list through the value this render saw
    would answer the list as it was when the socket came up. A gateway added
    since then would be one a notification could not resolve.
  */
  const registryRef = useRef(registry)
  registryRef.current = registry
  /*
    Every per-gateway disk read, as one promise the reconcile waits on.

    ADR-0016's app-wide section holds ONE PERSON's settings, shared by all their
    devices, and reconciling it means deciding whose copy is newer. A disk read
    still in flight while that decision is taken makes this device's answer a
    matter of timing: the gateway's theme went into the stores, the disk's landed
    on top of it a moment later, the bridge read that as a local change and sent
    it — so opening a second device did not merely show the wrong theme, it
    replaced the chosen one for every device. That is the report this ref is for.

    It is a ref rather than state because nothing renders on it, and it is
    resolved for good after the first read: a reconnect to the same gateway finds
    a promise that has already settled and waits for nothing.
  */
  const hydrated = useRef<Promise<unknown>>(Promise.resolve())

  /*
    Everything that is stored PER GATEWAY is read here, keyed by the active
    gateway's id, and read again when that id changes.

    Before the registry these were read once at startup, because there was one
    gateway and therefore one answer. There are now two things they could mean
    and only one of them is right: the settings, the read watermarks and the
    push registration all belong to the gateway that is live.

    The reader's own context switches are the exception and stay at startup:
    they are decisions about what this person is willing to tell a bot, and they
    do not change because a different machine answered.
  */
  useEffect(() => {
    if (!gatewayId) {
      return
    }

    const ns = namespace(gatewayId)

    /*
      Out with the previous gateway's roster and open chats FIRST.

      A switch replaces the connection rather than removing it, so the
      `!connection` branch below — which is what normally empties these — never
      runs, and the list would paint the machine the reader has just stepped
      away from until the new roster arrived. These stores are module-level and
      outlive every provider, so nothing else clears them.
    */
    useChatsStore.getState().reset()
    useBotsStore.getState().reset()
    usePluginStore.getState().reset()
    // And what the MCP pages learned by testing. Those results are keyed by
    // gateway, so the next one cannot READ them; this is about not keeping the
    // previous account's server names in this process.
    useMcpProbeStore.getState().reset()
    // Pictures are already keyed per gateway (HERM-120), so this is not for
    // correctness — it is so a sign-out-then-back-in on the SAME gateway picks
    // up a picture that changed at the provider, the other half of "refetch on
    // the next app start or sign-in" alongside this cache simply not surviving
    // a relaunch.
    usePeoplePicturesStore.getState().reset()

    hydrated.current = Promise.all([
      useSettingsStore.getState().hydrate(ns),
      // The date on the app-wide section, beside the settings it dates. It has
      // to be in memory before the first projection or an offline change would
      // travel undated and lose to the copy it was meant to replace.
      useAppStampStore.getState().hydrate(ns),
      useBotsStore.getState().hydrateLastSeen(ns),
      usePushStore.getState().hydrate(ns),
      // The list's arrangement, on the same key. "Change gateway" now edits an
      // entry rather than replacing the one gateway, so an arrangement follows
      // an address correction instead of being dropped by it (ADR-0012, amended).
      useChatLayoutStore.getState().load(gatewayId),
      // HERM-83 polish: the reader's own author, last seen on THIS gateway —
      // read before the connection effect below has a chance to run, so the
      // cached first paint already knows a colleague's row from the reader's
      // own instead of guessing "everything is mine" for a stretch. See
      // `own-author.ts` for why this is a guess to be corrected, not a trust.
      useOwnAuthorStore.getState().hydrate(ns)
    ]).catch(() => undefined)
  }, [gatewayId])

  /**
   * The team's own look, once, before anything has painted (ADR-0025, part 2).
   *
   * `loadHermieWebConfig` is cached and answers `null` off the web, so this is
   * one fetch in a browser and nothing at all anywhere else. It runs after the
   * settings store has been read from disk, because "has this reader chosen a
   * theme" is a question about what is stored and not about what the store was
   * seeded with — asking too early would find the app's default for everybody
   * and paint the brand over a choice on every launch.
   */
  useEffect(() => {
    let cancelled = false

    void (async () => {
      const config = await loadHermieWebConfig().catch(() => null)

      if (cancelled || !config) {
        return
      }

      setWebConfig(config)
      await useSettingsStore
        .getState()
        .hydrateAppearance()
        .catch(() => undefined)

      applyBranding(config, {
        chosenTheme: useSettingsStore.getState().themeChoice.kind !== 'preset',
        setTheme: preset => {
          if (isThemePresetName(preset)) {
            useSettingsStore.getState().setThemeChoice({ kind: 'preset', name: preset })
          }
        }
      })
    })()

    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    // One-time cleanup of what a build before HERM-119 left on disk; see
    // `store/device-context.ts`.
    void useDeviceContextStore.getState().hydrate()
    // Before the first chat is drawn, because "read replies aloud" is armed by
    // a transcript effect: a chat opened against an unhydrated store would take
    // the default (off) for one pass and then start reading on the next, which
    // reads to the owner as a reply that was skipped.
    void useVoiceSettingsStore.getState().hydrate()
  }, [])

  useEffect(() => {
    if (!connection) {
      useChatsStore.getState().reset()
      useBotsStore.getState().reset()
      // The advert belongs to a gateway; the next one is not this one.
      usePluginStore.getState().reset()
      useMcpProbeStore.getState().reset()
      /*
        And neither are the neighbours.

        The rows belonging to other devices and other people are carried
        through every write of the `hermie-app` key, so they have to survive a
        sign-out long enough for the LAST write to that gateway to carry them —
        `setPushRetire` flushes while the socket is still up, and a store that
        had already forgotten them would write a section with nobody in it and
        unregister every other phone. The moment there is no connection is the
        first moment they are safe to drop, and dropping them then is what stops
        one gateway's rows from being offered to the next.
      */
      usePushStore.getState().applyRemote({ others: {}, seen: {} })
      // No gateway, so nobody is "the reader" by id: every row draws as their own.
      useOwnAuthorStore.getState().bind(null)
      setValue(null)
      valueRef.current = null

      return
    }

    const gateway = chatGatewayFor(connection)
    /*
      HERM-83 polish: who the reader is on THIS connection is unconfirmed until
      its own `/api/auth/me` answers (the ready effect below) — a new connection
      can be a new sign-in on the same gateway. It used to be FORGOTTEN here,
      which read as "everything is mine" for the whole stretch until the answer
      landed and drew a cached transcript's colleagues on the right, receipt and
      all, only to jump left a moment later. What is bound below is the gateway
      the id is read FOR; the id itself is whatever `hydrate` most recently found
      on disk, or whatever `set` last confirmed — a guess either way, and the
      ready effect is what turns it into an answer.
    */
    useOwnAuthorStore.getState().bind(gatewayId)
    // One cache per gateway. Two gateways can both have a `researcher`, and a
    // cache that could not tell them apart would paint one machine's
    // conversation under the other's name.
    const chatCache = gatewayId ? chatCacheFor(gatewayId) : null
    // The chat store is handed over read-only: `session.active_list` answers for
    // the whole gateway process and carries no profile, so the roster attributes
    // a busy session to a bot through the ids its chat is known under.
    /*
      ADR-0007, amended: where the reader's own chats live.

      Built before the roster because the roster consults it on every
      resolution, and given the identity through a FUNCTION rather than a value:
      `/api/auth/me` is asked once per ready edge, so at the moment this is
      constructed the store usually still says nobody. Reading it late is what
      makes the first roster after a sign-in resolve the right chats.
    */
    const userChats = new UserChatDirectory({
      gateway,
      identity: () => {
        // An operator can turn the whole feature off for this deployment
        // (`/admin`), and the honest way to express that is to have no identity
        // to write a title from — which is the same state a gateway that named
        // nobody is in, and the one every other reader here already handles.
        if (!featureOn(webConfigRef.current, 'userChats')) {
          return null
        }

        const context = useDeviceContextStore.getState()

        return context.userId ? { userId: context.userId, displayName: context.displayName } : null
      },
      choice: name => (useChatLayoutStore.getState().myChats[name] ? 'mine' : 'shared'),
      // Sub-chats: which conversation the reader's memory puts each bot on — a
      // stored id, a legacy entry (`null`), or the group chat (`undefined`).
      target: name => currentTargetOf(useChatLayoutStore.getState(), name)
    })
    const userChatsSwitch = userChatSwitch({
      available: () => userChats.available,
      title: () => userChats.title,
      chose: name => userChats.chose(name),
      cached: name => userChats.cached(name),
      resolve: bot => userChats.resolve(bot),
      remember: (name, choice) => useChatLayoutStore.getState().setMyChat(name, choice === 'mine'),
      target: name => userChats.target(name),
      resolveTarget: bot => userChats.resolveTarget(bot),
      rememberCurrent: (name, storedId, options) => useChatLayoutStore.getState().setCurrent(name, storedId, options)
    })
    const bots = new BotsController({
      gateway,
      store: useBotsStore,
      cache: chatCache,
      chats: useChatsStore,
      userChats: userChatsSwitch
    })
    // ADR-0016. It is built here rather than in a store because it needs the
    // live connection and has to die with it: a sync holding a socket that has
    // been replaced would write this gateway's arrangement to the next one.
    const uiMeta = new UiMetaBridge({
      // `ChatGateway.request` is typed against the generated contract, which is
      // stricter than the two methods `UiMetaSync` names by string. The cast is
      // at the seam rather than inside the sync, so the sync stays testable with
      // two hand-written functions.
      gateway: { request: (method, params) => gateway.request(method as 'profiles.list', params) },
      // Nothing is watched or compared until this gateway's own disk reads have
      // landed; see `hydrated` above and `UiMetaBridgeOptions.ready`.
      ready: () => hydrated.current
    })
    const stopWatching = uiMeta.start()
    /*
      Another device picked a conversation (or this one did, or a legacy entry
      resolved): place it on the roster for every bot whose chat is NOT bound
      here. A bound one is left where it is and follows on its next open
      (Owner Decision 4) — `placeCurrentChats` skips it.
    */
    const stopFollowingCurrent = useChatLayoutStore.subscribe((state, previous) => {
      if (state.current !== previous.current || state.myChats !== previous.myChats) {
        void bots.placeCurrentChats().catch(() => undefined)
      }
    })
    // Built with the connection for the same reason the bridge above is: the
    // roster and the open chats are emptied when a connection goes, and a sync
    // that outlived one would keep writing the previous gateway's bots onto the
    // home screen. It reads stores rather than the socket, so it needs no
    // gateway of its own — only to be told when that socket is usable.
    const widgets = new WidgetSync()
    const stopWidgets = widgets.start()

    const controller = new ChatController({
      gateway,
      chats: useChatsStore,
      bots: useBotsStore,
      botsController: bots,
      // The REST half, for file uploads. It is built with the connection and
      // replaced with it, which is why it is not a dependency of its own.
      http,
      cache: chatCache,
      userChats: userChatsSwitch,
      // The reader's own author for an optimistic bubble, read at send time
      // under the gateway this controller was built for (HERM-83, D2).
      ownAuthor: () => ownAuthorOn(gatewayId),
      // Every gateway refusal the controller absorbs goes here, and the debug
      // screen reads it. The alternative is what shipped: `catch {}`.
      onRpcFailure: failure => useConnectionStore.getState().noteRpcFailure(failure)
    })

    /*
      ADR-0017's three ports, all of them resolved against the gateway rather
      than against anything the notification said. `showChat` deliberately does
      BOTH halves: the controller resumes the session — which is what gives
      `approval.pending` a `session_id` to ask about — and the bus tells
      whichever shell is mounted to navigate. A bot the roster does not have is
      not an error; the navigation still happens and the shell says what it
      finds.
    */
    const push = new PushSync({
      platform: pushPlatform,
      namespace: gatewayId ? namespace(gatewayId) : null,
      projectId: pushProjectId(),
      vapidUrl: pushVapidUrl(),
      // A registration that never happened lands in the same ring the
      // controller's absorbed gateway refusals do, so it outlives the settings
      // screen and the debug screen can read it.
      onFailure: failure => useConnectionStore.getState().noteRpcFailure(failure),
      ports: {
        showChat: async name => {
          requestOpenChat(name)

          const bot = useBotsStore.getState().byName[name]

          if (bot) {
            await controller.openChat(bot).catch(() => undefined)
          }
        },
        /*
          A branch, or a conversation `/new` put away. R4b's viewer is read-only
          and resumes the stored id itself, so there is nothing to open on the
          controller — the bus is the whole of it, and the shell that is mounted
          decides whether that is a pushed screen or a panel.
        */
        showConversation: async (name, sessionId) => {
          requestOpenChat(name, sessionId)
        },
        /*
          Both ids, because they are different strings for the same
          conversation: a listing hands out the STORED id and a live session is
          stamped with the RESOLVED one, and a notifier may carry either. An
          empty answer is the honest one on a cold start from a notification,
          where the roster has not been read yet — `pushDestinationOf` opens the
          chat rather than guessing when it has nothing to compare against.
        */
        canonicalSessionIds: name => {
          const canonical = useBotsStore.getState().byName[name]?.canonical

          return canonical ? [...new Set([canonical.id, canonical.resolvedId].filter(Boolean))] : []
        },
        openApprovals: name => controller.openApprovals(name),
        respondApproval: (name, requestId, choice) => controller.respondApproval(name, requestId, choice),
        /*
          A notification from another configured gateway.

          It goes through the BUS rather than through `controller.openChat`,
          because the switch tears this controller down: by the time the dial
          to the other gateway has finished, the object this closure captured
          is stopped and the chat the reader wants belongs to a controller that
          did not exist when the notification was tapped. The bus is read by
          whichever shell is mounted, which by then is the new one.
        */
        switchToGateway: async (key, bot, sessionId) => {
          const target = gatewayForKey(registryRef.current, key)

          if (!target || target.id === gatewayId) {
            return false
          }

          await switchGateway(target.id)
          // The conversation only where the NOTIFIER classified it as one. An
          // id it did not classify cannot be placed without the other
          // gateway's roster, and this side has never read it.
          requestOpenChat(bot, sessionId || undefined)

          return true
        }
      }
    })
    const stopPush = push.start()

    /*
      What another app gave Hermie through the system's share sheet.

      Built with the connection for the same reason the widget sync is, and
      torn down with it — but the QUEUE is not: it lives in the shared container
      and survives the app, let alone a reconnect. So nothing is lost by
      building this late and disposing of it early, and a share that arrived
      while the reader was signed out is delivered the moment they are back.

      Every port resolves against the controller rather than against anything
      the manifest said. `open` is deliberately both halves — resume AND
      navigate — because the upload needs the working directory the resume
      reports, and because a share that lands in a chat the reader cannot see is
      not what tapping "Send" in a share sheet promised.
    */
    const share = new ShareDelivery({
      inbox: shareInbox,
      ready: () => useConnectionStore.getState().status === 'ready',
      open: async name => {
        const bot = useBotsStore.getState().byName[name]

        if (!bot) {
          // The picker's fallback: a manifest naming a bot this gateway does
          // not have cannot be delivered, and guessing at a near match would
          // send somebody's file to the wrong agent.
          throw new Error(`${name} is not a bot on this gateway.`)
        }

        await controller.openChat(bot)
        requestOpenChat(name)
      },
      upload: (name, file) => controller.uploadFile(name, file),
      // The same resize the composer's own picker performs. A share of a 12 MB
      // screenshot would otherwise go over the socket at full resolution, which
      // is the one thing `attachments.ts` exists to prevent.
      readImage: (uri, filename) => resizeToBase64(uri, filename),
      // The painted id is the Shortcuts runner's business, not a share's: a share
      // does not wait for the reply, so there is nothing to measure one against.
      send: async (name, text, attachments) => {
        await controller.send(name, text, attachments)
      },
      onChange: waiting => useShareStore.getState().setWaiting(waiting)
    })

    /*
      What a Shortcut asked for.

      The ports are the share flow's, minus the files and plus the wait: `open`
      is the same both-halves resume-and-navigate, because a Shortcut that
      launched the app has already taken over the phone and landing somewhere
      else while a message goes out is disorienting.

      `startReplyWatch` is handed the chat STORE rather than the controller, and
      subscribes the moment it is called — which the runner does after the chat
      is open and before the prompt is sent. See `intents/await-reply.ts` for why
      both halves of that ordering are load bearing.
    */
    const intents = new IntentRunner({
      queue: intentQueue,
      ready: () => useConnectionStore.getState().status === 'ready',
      open: async name => {
        const bot = useBotsStore.getState().byName[name]

        if (!bot) {
          throw new Error(`${name} is not a bot on this gateway.`)
        }

        await controller.openChat(bot)
        requestOpenChat(name)
      },
      send: (name, text) => controller.send(name, text),
      startReplyWatch: (name, budgetMs) =>
        startReplyWatch({ chats: useChatsStore, botName: name, timeoutMs: budgetMs }),
      now: () => Date.now()
    })

    /*
      The one thing that has to happen BEFORE this connection goes away. See
      `features/push/runtime.ts`: `GatewayProvider` tears the socket down first
      and this component is unmounted by the same change, so the removal is
      registered as a callback the provider can await rather than run from here.
    */
    setPushRetire(async () => {
      await push.retire()
      // The identity belongs to the gateway that is going away.
      useDeviceContextStore.getState().retire()
      await uiMeta.sync.flush()
    })

    controller.start()
    // Only the cache here. The roster itself is read once the connection is
    // READY; see below.
    void bots.paintFromCache()

    // A link that arrived at whichever shell is mounted, rather than a
    // foreground. It only ever makes the pump EARLIER; see `share-bus.ts`.
    const stopShareBus = onShareRequest(() => void share.pump())
    // The latency-critical twin: somebody is watching a Shortcut spin.
    const stopIntentBus = onIntentRequest(() => void intents.run())

    const next = { controller, bots, uiMeta, userChats: userChatsSwitch, widgets, push, share, intents, gateway }
    valueRef.current = next
    setValue(next)

    return () => {
      useOwnAuthorStore.getState().bind(null)
      controller.stop()
      bots.dispose()
      stopWatching()
      stopFollowingCurrent()
      stopWidgets()
      stopPush()
      stopShareBus()
      stopIntentBus()
      // The entries stay on disk; only the badge goes. See `useShareStore.reset`.
      useShareStore.getState().reset()
      setPushRetire(null)
      valueRef.current = null
    }
    // `http` is built with the connection and handed out as a ref, like the
    // connection itself, so listing it costs no extra rebuild — and leaving it
    // out would hand the controller a stale one if that ever changed.
    // `switchGateway` and the list are read through a ref and a stable callback
    // respectively, so neither rebuilds the runtime; see `registryRef`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connection, gatewayId, http])

  /**
   * Read the roster when the connection becomes usable, and again after every
   * reconnect.
   *
   * A `GatewayConnection` exists from the moment a gateway is configured, long
   * before its socket is up, and `profiles.list` on one that is still dialling
   * fails with "gateway not connected". That failure was the whole story: it
   * happened once, right after onboarding, nothing asked again, and the chat
   * list sat on an error while the header two lines above it said Connected.
   */
  const wasReady = useRef(false)

  useEffect(() => {
    if (!value || status !== 'ready') {
      wasReady.current = false

      return
    }

    if (wasReady.current) {
      return
    }

    wasReady.current = true
    void value.bots.refresh().catch(() => undefined)
    /*
      Who the gateway thinks this is.

      Read here rather than taken from the stored config, for two reasons: a
      setup saved by an older build has no user id in it at all, and a display
      name is the gateway's to change. A session-token gateway has nobody to ask
      about — there are no accounts — so it answers with the fixed owner id
      that makes "my chats" and the `ui_meta` profile a hit rather than a coin
      toss.
    */
    void (async () => {
      const identity = await readIdentity(config, http).catch(() => null)

      /*
        HERM-83 polish: the reader's own author id, from the same answer. Filed
        under the gateway that gave it, so an answer that lands after a gateway
        switch is never read as the next gateway's. `identity` is only ever
        `null` on a REFUSAL (the `.catch` above) — no answer, not a "no" — and a
        refusal must not overwrite the last one this gateway gave; that is the
        one this whole file exists to keep showing while the retry is pending.
        `identity.author` itself is `undefined` for the two cases that ARE an
        answer of "no": a session-token gateway (no accounts to be a provider
        for) and a gateway that named no provider at all. Both clear it, same as
        before `author` existed — nothing is "own" by id, so every row draws as
        the reader's own.
      */
      if (gatewayId && identity) {
        useOwnAuthorStore.getState().set(gatewayId, identity.author)
      }

      if (identity) {
        useDeviceContextStore.getState().setIdentity(identity)
      }

      /*
        AWAITED, and the settings reconcile is what waits for it.

        The app-wide `ui_meta` key now carries this person's name, so a reconcile
        that ran before the identity was known would look under no key at all,
        hand the stores nothing, and only afterwards learn whose arrangement it
        should have read — which on a second device is an empty list where an
        arrangement was. A refusal leaves the id empty, and an empty id is the
        local-only path rather than a write under a name nobody agreed to.
      */
      value.uiMeta.setUser(identity?.userId ?? '')

      // And deliberately AFTER the roster: the key lives on the default profile,
      // and which profile that is comes out of `profiles.list`.
      await value.uiMeta.reconcile().catch(() => undefined)
      /*
        Only NOW can the roster know which chats are this reader's own.

        The refresh above ran before either half was in: the identity is read a
        line ago and the per-bot choice arrives with the reconcile. So the rows
        are re-pointed here rather than by a second `profiles.list`, which would
        re-read a roster that has not changed to learn something that is not on
        it (ADR-0007, amended).
      */
      await value.bots.placeCurrentChats().catch(() => undefined)
    })()
  }, [config, gatewayId, http, status, value])

  /**
   * Tell the widget sync whether the socket is usable.
   *
   * Its own effect rather than a line in the one above, because that one fires
   * on the RISING edge only — it guards on `wasReady` so a reconnect does not
   * re-read the roster twice — and a widget has to hear about the falling edge
   * as well. `presenceOf` turns an unusable gateway into `offline` for every
   * bot, and four green dots for a gateway the phone cannot reach is the one
   * lie a surface nobody can tap through is not allowed to tell.
   */
  useEffect(() => {
    value?.widgets.setGatewayReady(status === 'ready')
  }, [status, value])

  /**
   * And which gateway the rows it writes belong to.
   *
   * Its own effect, beside the one above, because the two move independently: a
   * socket goes up and down all day on one gateway, and the gateway itself
   * changes only when somebody switches.
   */
  useEffect(() => {
    value?.widgets.setGatewayAddress(config?.baseUrl ?? '')
  }, [config?.baseUrl, value])

  /**
   * Drain the share outbox whenever there is a gateway to drain it into.
   *
   * On EVERY value of `status`, not only `ready`, because the first pump is
   * also what reads the directory at all: an entry that arrived while the app
   * was closed has to reach the badge before it can reach a chat, and a phone
   * with no route to the gateway is exactly the case where the badge is the
   * only thing the feature can offer. `pump` itself declines to send anything
   * while the socket is down.
   */
  useEffect(() => {
    void value?.share.pump()
  }, [status, value])

  /**
   * And the Shortcuts queue, on the same edge and for a sharper reason.
   *
   * A request arrives with the launch it caused, which on a cold start is
   * before there is any socket to send on — so the link's own run finds the
   * gateway unready and leaves the request pending, and THIS is what picks it
   * up a second later. `IntentRunner` answers everything it cannot run, so the
   * only request left waiting here is one still inside its budget.
   */
  useEffect(() => {
    void value?.intents.run()
  }, [status, value])

  /**
   * Reconcile again when the gateway says a profile changed.
   *
   * `ui_meta` is on the profile row, so another client writing its own section
   * is a profile change and nothing else — there is no event that means "the
   * settings moved". Reading the roster again is cheap and it is the only signal
   * there is.
   */
  useEffect(() => {
    if (!value) {
      return
    }

    return value.gateway.on('sessions.changed', () => {
      void value.uiMeta.reconcile().catch(() => undefined)
    })
  }, [value])

  /**
   * The chat side of the app lifecycle, and the one place a desktop window
   * differs from a phone.
   *
   * `onBackground()` clears `foregrounded`, which stops the approval and
   * subagent polls — right on a phone, where a backgrounded app has no socket
   * either (see `attachLifecycle`). A Mac window keeps its socket, so stopping
   * the polls would leave an agent's question unanswered while the window sat
   * one Cmd+Tab away. The native macOS target ignored AppState outright for
   * this; `foregrounded` starts `true`, so simply not calling it keeps a Mac in
   * the state that target was always in.
   *
   * The desktop shell (`apps/desktop`) is the same window in a different
   * wrapper: `attachLifecycle` keeps its socket for the same reason, and it must
   * keep its polls for the same reason. It gets there by a different route
   * though — this is the browser build, and React Native Web reports
   * `background` on `document.hidden`, so the window being merely covered is
   * enough to arrive here. A browser TAB is not covered by this and still stops
   * its polls, which is right: a background tab may be throttled to a halt.
   *
   * `persistAll()` runs either way. Writing the cache when the window is hidden
   * costs nothing and is the one moment worth writing at.
   */
  useEffect(() => {
    const subscription = AppState.addEventListener('change', state => {
      const runtime = valueRef.current

      if (!runtime) {
        return
      }

      if (state === 'active') {
        void runtime.controller.onForeground()
        // The reader has just come back from the home screen they were looking
        // at, so the next thing worth doing is making what they saw there true.
        runtime.widgets.resume()
        // The other things that can have changed while the app was away: the
        // share sheet is a different process and can have written an entry
        // without this one running at all, and a Shortcut can have queued a
        // request that the link for it did not deliver.
        void runtime.share.pump()
        void runtime.intents.run()
        // ADR-0017's freshness pass, and the heartbeat's other half: a token
        // that changed while the app was away is re-read here, and `seen` only
        // means anything while somebody is actually looking.
        runtime.push.setForeground(true)
        void runtime.push.refresh().catch(() => undefined)
        /*
          And the mutes that lapsed while the phone was in a drawer.

          Housekeeping, not correctness: every reader of a mute compares its
          deadline against the clock, so one that has run out has already
          stopped working whether or not anybody swept it. This is what stops
          the section collecting deadlines from last spring, and it is a no-op
          when nothing expired — otherwise every foreground would send the
          whole arrangement again.
        */
        useChatLayoutStore.getState().dropExpiredMutes(Math.floor(Date.now() / 1000))
      } else if (state === 'background') {
        // FIRST in this branch, before anything that could tear a socket down:
        // this writes the widget file while the gateway is still the
        // foreground's, and then stops writing. See `WidgetSync.pause` for the
        // four grey beads that cost.
        runtime.widgets.pause()

        if (!RUNS_ON_MAC && !RUNS_IN_DESKTOP_SHELL) {
          runtime.controller.onBackground()
        }

        // Unconditionally, Mac included: `seen` says "somebody is reading this
        // right now", and a window behind another window is not that.
        runtime.push.setForeground(false)

        void runtime.controller.persistAll()
      }
    })

    return () => subscription.remove()
  }, [])

  const memo = useMemo(() => value, [value])

  return (
    <ChatRuntimeContext.Provider value={memo}>
      {children}
      {/*
        The share picker, mounted once and above both shells.

        Here rather than in a shell because there are two of them and only one
        is on screen: the same sheet in both would be two `Modal`s racing to ask
        the same question. It renders nothing at all until an entry arrives with
        no chat on it, which on iOS is never — the share extension asks there,
        where it can read the roster without launching anything.
      */}
      {memo ? <ShareTargetHost share={memo.share} /> : null}
    </ChatRuntimeContext.Provider>
  )
}

/** The chat runtime, or `null` before the gateway connection exists. */
export function useChatRuntime(): ChatRuntimeValue | null {
  return useContext(ChatRuntimeContext)
}
