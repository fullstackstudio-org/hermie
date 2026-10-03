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
 *  3. The request queue (`state/requests.ts`): a view of the chats' open approvals and questions.
 *  4. The running poll (`session.active_list`) while the page is shown, and once
 *     the moment the connection becomes usable, so a bot that is already working
 *     is not drawn idle for the first ten seconds.
 *
 * `stop()` is the order the sign-out needs: the poll, then the chats, then the
 * client (which closes the socket and empties its stores). It is idempotent.
 */
import type { ConnectChatsOptions, ChatRuntime } from '../../core/chat-controller'
import { connectChats } from '../../core/chat-controller'
import { connectGateway, type ConnectGatewayOptions, type GatewayClient } from '../../core/gateway-client'
import type { ChatCache } from '../../platform/chat-cache'
import type { WebKeyValueStore } from '../../platform/key-value-store'
import { type VisibilityWatcher, visibilityWatcher } from '../../platform/visibility'
import { bindRequests } from '../../state/requests'

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
}

export interface Session {
  readonly client: GatewayClient
  readonly chats: ChatRuntime
  /** Stop the poll, the chats and the client, in that order. Idempotent. */
  stop(): void
}

export function startSession(options: StartSessionOptions): Session {
  const visibility = options.visibility ?? visibilityWatcher

  const client = connectGateway({
    baseUrl: options.baseUrl,
    credentials: options.credentials,
    storage: options.storage,
    cache: options.cache,
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

  /** The request layer's queue is the open requests of the chats just started. */
  const stopRequests = bindRequests(chats.chats)

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
      chats.stop()
      client.stop()
    }
  }
}
