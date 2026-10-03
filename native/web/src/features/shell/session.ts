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
 *  5. The request queue (`state/requests.ts`): a view of the chats' open approvals
 *     and questions, of the confirmations the passkey model shows and of the
 *     prompts the secure input model holds.
 *  6. The running poll (`session.active_list`) while the page is shown, and once
 *     the moment the connection becomes usable, so a bot that is already working
 *     is not drawn idle for the first ten seconds.
 *
 * `stop()` is the order the sign-out needs: the poll, then the secure prompts
 * (each open one answered `''` while the socket is still there), the passkeys and
 * the chats, then the client (which closes the socket and empties its stores). It
 * is idempotent.
 */
import type { ConnectChatsOptions, ChatRuntime } from '../../core/chat-controller'
import { connectChats } from '../../core/chat-controller'
import { connectGateway, type ConnectGatewayOptions, type GatewayClient } from '../../core/gateway-client'
import { serialiseBaseUrl } from '../../core/passkey/challenge'
import { createPasskeyClient } from '../../core/passkey/client'
import { PasskeyModel } from '../../core/passkey/model'
import { SecureInputModel } from '../../core/requests/secure-input'
import type { ChatCache } from '../../platform/chat-cache'
import type { WebKeyValueStore } from '../../platform/key-value-store'
import { createPasskeyPins } from '../../platform/passkey-pins'
import { createSocketFactoryWithOutbox, ErrorDataOutbox } from '../../platform/socket'
import { type VisibilityWatcher, visibilityWatcher } from '../../platform/visibility'
import { createWebAuthn, type WebAuthnSeam } from '../../platform/webauthn'
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
}

export interface Session {
  readonly client: GatewayClient
  readonly chats: ChatRuntime
  readonly passkeys: PasskeyModel
  readonly secureInput: SecureInputModel
  /** Stop the poll, the secure prompts, the passkeys and the chats, then the client, in that order. Idempotent. */
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

  const client = connectGateway({
    baseUrl: options.baseUrl,
    credentials: options.credentials,
    storage: options.storage,
    cache: options.cache,
    socketFactory: createSocketFactoryWithOutbox(outbox),
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
    gatewayName: hostOf(options.baseUrl)
  })

  secureInput.start()

  /** The request layer's queue is the open requests of the chats just started, the confirmations and the prompts. */
  const stopRequests = bindRequests(chats.chats, undefined, passkeysStore, secureInputStore)

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
    stop() {
      if (stopped) {
        return
      }

      stopped = true
      stopVisibility()
      stopStatus()
      release?.()
      release = undefined
      stopRequests()
      secureInput.stop()
      passkeys.stop()
      chats.stop()
      client.stop()
    }
  }
}
