/**
 * The signed-in page's session: the connection, the chats on it, and the
 * roster's running poll, started together and stopped together.
 *
 * This is where the pieces `core/` provides are wired for the page. React-free
 * and called once, by the entry module, so a component never starts a
 * connection and a re-render never starts a second one:
 *
 *  1. `connectGateway` on the boot's cookie session (`core/gateway-client.ts`);
 *     it hands the chat store to the roster controller, so a busy session is
 *     placed on the bot whose chat holds its id.
 *  2. `connectChats` on that client (`core/chat-controller.ts`), with the boot's
 *     own author for the optimistic bubble.
 *  3. The passkey model (`core/passkey/model.ts`) on the same connection: `confirm`
 *     at level `passkey`, what the page advertises for it, and the passkeys of the
 *     signed-in person. The socket it rides attaches a 4040's `data.reason`
 *     (`platform/socket.ts`, `ErrorDataOutbox`).
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
 *     prompts the secure input model holds and of the connection cards.
 *  7. The running poll (`session.active_list`) while the page is shown, and once
 *     the moment the connection becomes usable, so a bot that is already working
 *     is not drawn idle for the first ten seconds.
 *  8. The `ui_meta` bridge (`core/ui-meta-bridge.ts`, `connectUiMeta`) on the same
 *     connection, under the app-wide key of the person the boot read
 *     (`uiMetaUserIdOf`): the arrangement, the mutes and the text size follow the
 *     person, and the roster is folded into the arrangement.
 *
 * `stop()` is the order the sign-out needs: the poll, the `ui_meta` bridge, then the secure prompts
 * (each open one answered `''` while the socket is still there), the notices, the
 * connection cards, the session status, the passkeys and the chats, then the client (which closes the socket and empties its stores). It
 * is idempotent.
 */
import type { ConnectChatsOptions, ChatRuntime, SessionSignal } from '../../core/chat-controller'
import { ownAuthorStore } from '../../core/chats/own-author'
import { connectChats } from '../../core/chat-controller'
import { connectGateway, type ConnectGatewayOptions, type GatewayClient } from '../../core/gateway-client'
import { serialiseBaseUrl } from '../../core/passkey/challenge'
import { createPasskeyClient } from '../../core/passkey/client'
import { PasskeyModel } from '../../core/passkey/model'
import { ConnectionsModel, respondThrough } from '../../core/connections'
import { NoticesModel } from '../../core/notices'
import { SecureInputModel } from '../../core/requests/secure-input'
import { SessionStatusModel } from '../../core/session-status'
import { connectUiMeta, type ConnectUiMetaOptions, type UiMetaRuntime } from '../../core/ui-meta-bridge'
import type { ChatCache } from '../../platform/chat-cache'
import type { WebKeyValueStore } from '../../platform/key-value-store'
import { createPasskeyPins } from '../../platform/passkey-pins'
import { createSocketFactoryWithOutbox, ErrorDataOutbox, ReplayGapTap } from '../../platform/socket'
import { type VisibilityWatcher, visibilityWatcher } from '../../platform/visibility'
import { createWebAuthn, type WebAuthnSeam } from '../../platform/webauthn'
import { connectionsStore } from '../../state/connections'
import { deviceContextStore, uiMetaUserIdOf } from '../../state/device-context'
import { passkeysStore } from '../../state/passkeys'
import { bindRequests } from '../../state/requests'
import { secureInputStore } from '../../state/secure-input'

export interface StartSessionOptions {
  /** The gateway's base URL (`ResolvedBasePath.baseUrl`). */
  baseUrl: string
  /** The boot's `signed_in.session.credentials`. */
  credentials: ConnectGatewayOptions['credentials']
  /** The boot's `signed_in.author`. */
  author: ConnectChatsOptions['author']
  /**
   * The boot's `signed_in.identity`: who `/api/auth/me` named. It picks the
   * app-wide `ui_meta` key; absent or nameless is the local-only path.
   */
  identity?: { userId?: string; email?: string; displayName?: string }
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
  uiMeta?: Partial<Omit<ConnectUiMetaOptions, 'gateway' | 'connection' | 'bots' | 'storage' | 'userId'>>
}

export interface Session {
  readonly client: GatewayClient
  readonly chats: ChatRuntime
  readonly passkeys: PasskeyModel
  readonly secureInput: SecureInputModel
  readonly notices: NoticesModel
  readonly connections: ConnectionsModel
  readonly status: SessionStatusModel
  readonly uiMeta: UiMetaRuntime
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

export function startSession(options: StartSessionOptions): Session {
  const visibility = options.visibility ?? visibilityWatcher
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

  const passkeys = new PasskeyModel({
    gateway: client.gateway,
    client: createPasskeyClient(options.baseUrl),
    webauthn: options.webauthn ?? createWebAuthn(),
    baseUrl: options.baseUrl,
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
    failWithData: (request, code, message, data) =>
      outbox.with(request.id, code, data, () => request.fail(code, message))
  })

  passkeys.start()

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
    readIdentity: () => client.http.authMe(),
    initialAuthor: options.author,
    ownAuthor: options.chats?.ownAuthor ?? ownAuthorStore,
    watchSignals,
    chats: chats.chats
  })

  notices.start()
  connections.start()
  status.start()

  /*
    Who the boot read, and their `ui_meta`: a gated gateway always, since this
    client runs on the cookie session only.
  */
  deviceContextStore.getState().setIdentity({
    gated: true,
    userId: options.identity?.userId ?? '',
    displayName: options.identity?.displayName ?? '',
    email: options.identity?.email ?? ''
  })

  const uiMeta = connectUiMeta({
    gateway: client.gateway,
    connection: client.stores.connection,
    bots: client.stores.bots,
    storage: options.storage,
    userId: uiMetaUserIdOf(options.identity),
    ...(options.visibility ? { visibility: options.visibility } : {}),
    ...options.uiMeta
  })

  /** The request layer's queue is the open requests of the chats just started, the confirmations and the prompts. */
  const stopRequests = bindRequests(chats.chats, undefined, passkeysStore, secureInputStore, connectionsStore)

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
      uiMeta.stop()
      deviceContextStore.getState().retire()
      stopRequests()
      secureInput.stop()
      stopReplayGaps()
      notices.stop()
      connections.stop()
      status.stop()
      passkeys.stop()
      chats.stop()
      client.stop()
    }
  }
}
