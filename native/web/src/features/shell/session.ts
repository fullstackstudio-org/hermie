/**
 * The signed-in page's session: the connection, the chats on it, and the
 * roster's running poll, started together and stopped together.
 *
 * This is where the pieces `core/` provides are wired for the page. React-free
 * and called once, by the entry module, so a component never starts a
 * connection and a re-render never starts a second one:
 *
 *  1. `connectGateway` on the boot's session (`core/gateway-client.ts`): the
 *     cookie session, or on a gateway without sign-in the session token (`gated: false`);
 *     it hands the chat store to the roster controller, so a busy session is
 *     placed on the bot whose chat holds its id.
 *  2. `connectChats` on that client (`core/chat-controller.ts`), with the boot's
 *     own author for the optimistic bubble.
 *  3. The passkey model (`core/passkey/model.ts`) on the same connection: `confirm`
 *     at level `passkey`, what the page advertises for it, and the passkeys of the
 *     signed-in person. The socket it rides attaches a 4040's `data.reason`
 *     (`platform/socket.ts`, `ErrorDataOutbox`).
 *     The MCP model (`core/mcp/model.ts`) is beside it: idle until Settings › MCP is open, then it reads
 *     `GET /api/auth/mcp` and follows `mcp.changed` and the tab's return to the foreground.
 *     The interactive model (`core/requests/interactive.ts`) is tried right after the passkey model:
 *     `input.form`, `input.file` and `review.draft`, answered beside the engine (which is told only
 *     that a question was asked and how it ended), and the list of what the page can show, which
 *     rides in the passkey model's second `client.capabilities` call.
 *  4. The secure input model (`core/requests/secure-input.ts`) on the same
 *     connection: `secret`, `sudo` and the vault prompts, answered beside the
 *     engine so a typed value never reaches a store, and the requests only the
 *     desktop app can answer, declined with a notice on their chat.
 *  5. What the gateway says beside the transcript, from the chat controller's
 *     signals (`onSessionSignal`): its notices (`core/notices.ts`), the connector
 *     authorisations a bot waits on (`core/connections.ts`), and who the reader is,
 *     what the gateway can do and which chats it is still loading
 *     (`core/session-status.ts`). The socket reads every replay answer on the way
 *     in (`platform/socket.ts`, `ReplayGapTap`), and a session whose replay came
 *     back `truncated` is read again in full (`ChatController.noteReplayGap`).
 *  6. The request queue (`state/requests.ts`): a view of the chats' open approvals
 *     and questions, of the confirmations the passkey model shows, of the
 *     prompts the secure input model holds, of the interactive requests and of the connection cards.
 *  7. The running poll (`session.active_list`) while the page is shown, and once
 *     the moment the connection becomes usable, so a bot that is already working
 *     is not drawn idle for the first ten seconds.
 *  8. The `ui_meta` bridge (`core/ui-meta-bridge.ts`, `connectUiMeta`) on the same
 *     connection, under the app-wide key of the person the boot read
 *     (`uiMetaUserIdOf`): the arrangement, the mutes and the text size follow the
 *     person, and the roster is folded into the arrangement. Loaded as a chunk of
 *     its own once the session has started (`uiMeta` is a promise of it).
 *
 * `stop()` is the order the sign-out needs: the poll, the `ui_meta` bridge, then the secure prompts
 * (each open one answered `''` while the socket is still there; the interactive requests fail with `4041 shutting_down`), the notices, the
 * connection cards, the session status, the passkeys and the chats, then the client (which closes the socket and empties its stores). It
 * is idempotent.
 */
import type { AuthIdentity } from '@hermie/gateway-client'

import type { ConnectChatsOptions, ChatRuntime, SessionSignal } from '../../core/chat-controller'
import { ownAuthorStore } from '../../core/chats/own-author'
import { connectChats } from '../../core/chat-controller'
import { connectGateway, type ConnectGatewayOptions, type GatewayClient } from '../../core/gateway-client'
import { serialiseBaseUrl } from '../../core/passkey/challenge'
import { createMcpClient } from '../../core/mcp/client'
import { McpModel } from '../../core/mcp/model'
import { createPasskeyClient } from '../../core/passkey/client'
import { PasskeyModel, type SelfEnrolmentSeam } from '../../core/passkey/model'
import { ADVERTISE_INTERACTIVE_REQUESTS, InteractiveModel, interactiveAdvert } from '../../core/requests/interactive'
import { ConnectionsModel, respondThrough } from '../../core/connections'
import { NoticesModel } from '../../core/notices'
import { SecureInputModel } from '../../core/requests/secure-input'
import { SessionStatusModel } from '../../core/session-status'
import type { ConnectUiMetaOptions, connectUiMeta, UiMetaRuntime } from '../../core/ui-meta-bridge'
import type { ChatCache } from '../../platform/chat-cache'
import type { WebKeyValueStore } from '../../platform/key-value-store'
import { createPasskeyPins } from '../../platform/passkey-pins'
import { createSocketFactoryWithOutbox, ErrorDataOutbox, ReplayGapTap } from '../../platform/socket'
import { type VisibilityWatcher, visibilityWatcher } from '../../platform/visibility'
import { createWebAuthn, type WebAuthnSeam } from '../../platform/webauthn'
import { connectionsStore } from '../../state/connections'
import { deviceContextStore, OWNER_USER_ID, uiMetaUserIdOf } from '../../state/device-context'
import { uiMetaStatusStore } from '../../state/ui-meta-status'
import { interactiveStore } from '../../state/interactive'
import { passkeysStore } from '../../state/passkeys'
import { bindRequests } from '../../state/requests'
import { secureInputStore } from '../../state/secure-input'

export interface StartSessionOptions {
  /** The gateway's base URL (`ResolvedBasePath.baseUrl`). */
  baseUrl: string
  /** The boot's `signed_in.session.credentials`, or `token_ready.session.credentials`. */
  credentials: ConnectGatewayOptions['credentials']
  /** The boot's `signed_in.author`; undefined on a gateway without sign-in, which stamps nobody. */
  author: ConnectChatsOptions['author']
  /**
   * The boot's `signed_in.identity`: who `/api/auth/me` named. It picks the
   * app-wide `ui_meta` key; absent or nameless is the local-only path. Not read
   * when `gated` is false.
   */
  identity?: { userId?: string; email?: string; displayName?: string }
  /**
   * False on a gateway without sign-in (session-token mode, W-23). There is
   * nobody to name there: `/api/auth/me` is never asked (the gateway answers it
   * 401 whatever the token), the reader is "nobody named" in the sidebar, and
   * the `ui_meta` key is the owner's (`OWNER_USER_ID`), as on the Expo app and
   * the native apps. True unless told otherwise.
   */
  gated?: boolean
  /** This gateway's key-value store (watermarks are read from and written to it). */
  storage: WebKeyValueStore
  /** This gateway's transcript cache. */
  cache: ChatCache
  /** Everything below is for tests: the page's own is used when omitted. The visibility is shared by all three parts. */
  visibility?: VisibilityWatcher
  connect?: Partial<Omit<ConnectGatewayOptions, 'baseUrl' | 'credentials' | 'storage' | 'cache'>>
  chats?: Partial<Omit<ConnectChatsOptions, 'client' | 'cache' | 'author'>>
  /** The browser's passkey ceremonies; the page's own unless a test hands in its own. */
  webauthn?: WebAuthnSeam
  /** How the page leaves for the gateway's sign-in to add a passkey and comes back (`main.tsx`); absent: the code path only. */
  selfEnrolment?: SelfEnrolmentSeam
  uiMeta?: Partial<Omit<ConnectUiMetaOptions, 'gateway' | 'connection' | 'bots' | 'storage' | 'userId'>>
  /** How the `ui_meta` bridge's chunk is loaded; the dynamic import unless a test hands in its own. */
  loadUiMeta?: () => Promise<{ connectUiMeta: typeof connectUiMeta }>
  /** How long to wait before the one retry of a chunk that failed to load. */
  uiMetaRetryMs?: number
}

/** The wait before a failed `ui_meta` chunk is asked for once more. */
export const UI_META_RETRY_MS = 2_000

export interface Session {
  readonly client: GatewayClient
  readonly chats: ChatRuntime
  readonly passkeys: PasskeyModel
  readonly mcp: McpModel
  readonly interactive: InteractiveModel
  readonly secureInput: SecureInputModel
  readonly notices: NoticesModel
  readonly connections: ConnectionsModel
  readonly status: SessionStatusModel
  /** The `ui_meta` bridge, once its chunk has loaded; `null` when the session stopped first or it failed to load. */
  readonly uiMeta: Promise<UiMetaRuntime | null>
  /** Stop the poll, the `ui_meta` bridge, the models beside the engine, the passkeys and the chats, then the client, in that order. Idempotent. */
  stop(): void
}

/** The gateway as a person knows it: the host of its base URL. */
function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).host
  } catch {
    return baseUrl
  }
}

/** What a gateway without sign-in says about who the reader is: nobody. */
const NOBODY: AuthIdentity = {
  userId: '',
  email: '',
  displayName: '',
  orgId: '',
  provider: '',
  expiresAt: 0,
  pictureUrl: ''
}

export function startSession(options: StartSessionOptions): Session {
  const visibility = options.visibility ?? visibilityWatcher
  const gated = options.gated ?? true
  const identity = gated ? options.identity : { userId: OWNER_USER_ID, email: '', displayName: '' }
  const outbox = new ErrorDataOutbox()
  const replayGaps = new ReplayGapTap()

  const client = connectGateway({
    baseUrl: options.baseUrl,
    credentials: options.credentials,
    storage: options.storage,
    cache: options.cache,
    socketFactory: createSocketFactoryWithOutbox(outbox, replayGaps),
    ...(options.visibility ? { visibility: options.visibility } : {}),
    ...options.connect
  })
  const chats = connectChats({
    client,
    cache: options.cache,
    author: options.author,
    ...(options.visibility ? { visibility: options.visibility } : {}),
    ...options.chats
  })

  /** An error answer that carries `data` (a 4040's reason, a 4041's), attached on the way out of the socket. */
  const failWithData = (
    request: { id: string; fail: (code: number, message: string) => void },
    code: number,
    message: string,
    data: Record<string, unknown>
  ): void => outbox.with(request.id, code, data, () => request.fail(code, message))

  /*
    Built before the passkey model, which carries its list of methods in the second `client.capabilities` call,
    and started after it: the connection tries its handlers in the order they started, and the passkey model's
    `confirm` comes first.
  */
  const interactive = new InteractiveModel({
    gateway: client.gateway,
    store: interactiveStore,
    chatFor: sessionId => chats.chats.getState().runtimeToBot[sessionId],
    watchChats: listener => chats.chats.subscribe(() => listener()),
    watchReplays: listener => chats.controller.onReplaySignal(listener),
    engine: {
      asked: (bot, request) =>
        chats.chats.getState().dispatchServerRequest(bot, {
          id: request.id,
          method: request.method,
          // The three envelope keys and nothing else: a request's fields and a draft's text stay out of the engine.
          params: { title: request.title, summary: request.summary, optional: request.optional },
          ...(request.replayed ? { replayed: true } : {})
        }),
      answered: (bot, id, summary) => chats.chats.getState().answer(bot, id, summary),
      ended: (bot, id, reason) =>
        chats.chats.getState().dispatchEvent(bot, { type: 'request.cancel', payload: { id, reason } }),
      holds: (bot, id) => {
        const chat = chats.chats.getState().chats[bot]
        const itemId = chat?.byRequestId[id]
        const item = itemId ? chat?.items[itemId] : undefined

        return item?.kind === 'request' && item.state === 'open'
      }
    },
    failWithData,
    gatewayName: hostOf(options.baseUrl)
  })

  const passkeys = new PasskeyModel({
    gateway: client.gateway,
    client: createPasskeyClient(options.baseUrl),
    webauthn: options.webauthn ?? createWebAuthn(),
    baseUrl: options.baseUrl,
    ...(options.selfEnrolment ? { selfEnrolment: options.selfEnrolment } : {}),
    pins: createPasskeyPins({ store: options.storage, baseUrl: serialiseBaseUrl(options.baseUrl) ?? options.baseUrl }),
    openSessions: () =>
      Object.values(chats.chats.getState().chats).flatMap(chat =>
        chat.runtimeSessionId
          ? [
              {
                sessionId: chat.runtimeSessionId,
                lastSeen: chat.lastSeqSessionId === chat.runtimeSessionId ? chat.lastSeq : 0
              }
            ]
          : []
      ),
    watchSessions: listener => chats.chats.subscribe(() => listener()),
    failWithData,
    requests: interactiveAdvert(interactive, { enabled: ADVERTISE_INTERACTIVE_REQUESTS })
  })

  passkeys.start()
  interactive.start()

  const mcp = new McpModel({
    gateway: client.gateway,
    client: createMcpClient(options.baseUrl),
    host: hostOf(options.baseUrl),
    visibility
  })

  mcp.start()

  const secureInput = new SecureInputModel({
    gateway: client.gateway,
    chatFor: sessionId => chats.chats.getState().runtimeToBot[sessionId],
    watchChats: listener => chats.chats.subscribe(() => listener()),
    watchReplays: listener => chats.controller.onReplaySignal(listener),
    gatewayName: hostOf(options.baseUrl)
  })

  secureInput.start()

  const stopReplayGaps = replayGaps.onGap(sessionId => chats.controller.noteReplayGap(sessionId))
  const watchSignals = (listener: (signal: SessionSignal) => void): (() => void) =>
    chats.controller.onSessionSignal(listener)
  const notices = new NoticesModel({ watchSignals })
  const connections = new ConnectionsModel({
    respond: respondThrough(client.gateway),
    watchSignals,
    chats: chats.chats
  })
  const status = new SessionStatusModel({
    gateway: client.gateway,
    readIdentity: gated ? () => client.http.authMe() : () => Promise.resolve(NOBODY),
    initialAuthor: options.author,
    ownAuthor: options.chats?.ownAuthor ?? ownAuthorStore,
    watchSignals,
    chats: chats.chats
  })

  notices.start()
  connections.start()
  status.start()

  /*
    Who the boot read, and their `ui_meta`: the person the cookie session names,
    or on a gateway without sign-in the owner, which is all that gateway knows.
  */
  deviceContextStore.getState().setIdentity({
    gated,
    userId: identity?.userId ?? '',
    displayName: identity?.displayName ?? '',
    email: identity?.email ?? ''
  })

  /*
    The bridge is a chunk of its own: nothing on the first screen waits for it,
    and the stores it fills are filled the moment it lands (it reconciles at once
    on a connection that is already usable). A chunk that fails to load (a
    deploy that replaced the build under an open page, a network blip) is asked
    for once more; failing again, it is said in the console and published as
    `unavailable` (`state/ui-meta-status.ts`), so a screen can say the settings
    are not synced rather than the page failing quietly.
  */
  const syncStatus = options.uiMeta?.status ?? uiMetaStatusStore
  const load = options.loadUiMeta ?? (() => import('../../core/ui-meta-bridge'))
  let uiMetaRuntime: UiMetaRuntime | null = null
  let uiMetaStopped = false

  syncStatus.getState().set('starting')

  const loadWithRetry = async (): Promise<Awaited<ReturnType<typeof load>> | null> => {
    try {
      return await load()
    } catch (first) {
      console.warn('[hermie] the settings sync did not load; trying once more.', first)
    }

    await new Promise(resolve => setTimeout(resolve, options.uiMetaRetryMs ?? UI_META_RETRY_MS))

    if (uiMetaStopped) {
      return null
    }

    try {
      return await load()
    } catch (second) {
      console.error('[hermie] the settings sync could not be loaded; settings stay on this device.', second)
      syncStatus.getState().set('unavailable')

      return null
    }
  }

  const uiMeta: Promise<UiMetaRuntime | null> = loadWithRetry()
    .then(loaded => {
      if (!loaded || uiMetaStopped) {
        return null
      }

      const { connectUiMeta } = loaded

      uiMetaRuntime = connectUiMeta({
        gateway: client.gateway,
        connection: client.stores.connection,
        bots: client.stores.bots,
        storage: options.storage,
        userId: uiMetaUserIdOf(identity),
        ...(options.visibility ? { visibility: options.visibility } : {}),
        ...options.uiMeta
      })

      return uiMetaRuntime
    })
    .catch((error: unknown) => {
      console.error('[hermie] the settings sync failed to start; settings stay on this device.', error)
      syncStatus.getState().set('unavailable')

      return null
    })

  /** The request layer's queue is the open requests of the chats just started, the confirmations and the prompts. */
  const stopRequests = bindRequests(
    chats.chats,
    undefined,
    passkeysStore,
    secureInputStore,
    connectionsStore,
    interactiveStore
  )

  /** While the page is shown: the roster's running poll (reference counted; one is enough). */
  let release: (() => void) | undefined

  const follow = (state: 'visible' | 'hidden'): void => {
    if (state === 'visible') {
      release ??= client.bots.watchRunning()
    } else {
      release?.()
      release = undefined
    }
  }

  follow(visibility.current())

  const stopVisibility = visibility.subscribe(follow)
  let ready = client.stores.connection.getState().status === 'ready'
  const stopStatus = client.stores.connection.subscribe(state => {
    const now = state.status === 'ready'

    // The poll's own first read ran before the socket was up and came back empty.
    if (now && !ready) {
      void client.bots.refreshRunning()
    }

    ready = now
  })

  let stopped = false

  return {
    client,
    chats,
    passkeys,
    mcp,
    interactive,
    secureInput,
    notices,
    connections,
    status,
    uiMeta,
    stop() {
      if (stopped) {
        return
      }

      stopped = true
      stopVisibility()
      stopStatus()
      release?.()
      release = undefined
      uiMetaStopped = true
      uiMetaRuntime?.stop()
      syncStatus.getState().reset()
      deviceContextStore.getState().retire()
      stopRequests()
      interactive.stop()
      secureInput.stop()
      stopReplayGaps()
      notices.stop()
      connections.stop()
      status.stop()
      mcp.stop()
      passkeys.stop()
      chats.stop()
      client.stop()
    }
  }
}
