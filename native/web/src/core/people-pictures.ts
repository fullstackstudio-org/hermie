/**
 * The pictures of the people in a shared chat, as the gateway serves them.
 *
 * A person's picture is `GET /api/auth/picture?id=<provider>:<sub>` behind the
 * gateway's own auth: the gateway fetched it from the identity provider at
 * sign-in and keeps a copy, so this page never contacts the provider and never
 * holds an address it could leak. Bytes go through `fetchAuthenticatedPicture`
 * and come back as a `data:` URI, which is all the page ever sees of them.
 *
 * One page is one gateway, so the cache is one map, in memory, keyed by the same
 * `author.id` a message row carries. What it promises:
 *
 *  - A picture is asked for once, however many rows name its author: requests
 *    for an id already in flight, already answered, or lately refused share the
 *    one answer.
 *  - A person the gateway holds no picture of (404) is not asked about again for
 *    `MISSING_RETRY_MS`; a gateway that failed or could not be reached is not
 *    asked again for `ERROR_RETRY_MS`. A page of rows from somebody with no
 *    picture is one request, not one per row per scroll.
 *  - A picture is kept for the page's life. Who changed theirs shows on the next
 *    load, which is when a sign-in is read again.
 *  - Nothing here is logged: not an id, not a byte.
 */
import { AUTH_PICTURE_PATH, authPicturePath, type PictureFetchOutcome } from '@hermie/gateway-client'
import { createStore, type StoreApi } from 'zustand/vanilla'

/** How long a 404 stands: the gateway holds no picture of this person, and that rarely changes mid-session. */
export const MISSING_RETRY_MS = 15 * 60_000

/** How long a refused or unreachable answer stands: long enough not to storm a struggling gateway. */
export const ERROR_RETRY_MS = 2 * 60_000

/** The largest picture kept, as the `data:` URI's length: a gateway that sends more is not sending an avatar. */
export const MAX_PICTURE_CHARS = 1_500_000

export interface PeoplePicturesState {
  /** `author.id` → the picture as a `data:` URI; absent while loading and for a person with none. */
  pictures: Readonly<Record<string, string>>
}

export interface PeoplePicturesOptions {
  /** `GatewayHttp.fetchAuthenticatedPicture`, bound to this page's gateway. */
  fetchPicture: (path: string) => Promise<PictureFetchOutcome>
  /** The clock, for the retry windows. */
  now?: () => number
}

export interface PeoplePictures {
  readonly store: StoreApi<PeoplePicturesState>
  /**
   * Make sure this person's picture is being fetched or is held. Fire and forget: the result lands in
   * `store`, and a person with no picture simply never appears there. `path` is where the gateway
   * said the picture lives when it said (`/api/auth/me`'s `picture_url`); without it, or with an
   * address that is not the picture route, the id's own path is used.
   */
  request(id: string, path?: string): void
  /** Forget everything held, for a sign-out. */
  clear(): void
}

export function createPeoplePictures(options: PeoplePicturesOptions): PeoplePictures {
  const now = options.now ?? Date.now
  const store = createStore<PeoplePicturesState>(() => ({ pictures: {} }))
  /** Ids asked for and not answered yet. */
  const inFlight = new Set<string>()
  /** Id → when it may be asked for again, after a miss or an error. */
  const retryAt = new Map<string, number>()
  /** Bumped by `clear`, so an answer that arrives after a sign-out is dropped. */
  let epoch = 0

  const file = (id: string, dataUri: string): void => {
    store.setState(state => ({ pictures: { ...state.pictures, [id]: dataUri } }))
  }

  const load = async (id: string, path: string): Promise<void> => {
    const mine = epoch
    let outcome: PictureFetchOutcome

    try {
      outcome = await options.fetchPicture(path)
    } catch {
      outcome = { kind: 'error' }
    }

    inFlight.delete(id)

    if (mine !== epoch) {
      return
    }

    if (outcome.kind === 'ready' && outcome.dataUri.length <= MAX_PICTURE_CHARS) {
      retryAt.delete(id)
      file(id, outcome.dataUri)

      return
    }

    if (outcome.kind === 'missing') {
      retryAt.set(id, now() + MISSING_RETRY_MS)

      return
    }

    retryAt.set(id, now() + ERROR_RETRY_MS)
  }

  return {
    store,

    request(id, path) {
      if (!id || inFlight.has(id) || store.getState().pictures[id] !== undefined) {
        return
      }

      const wait = retryAt.get(id)

      if (wait !== undefined && now() < wait) {
        return
      }

      inFlight.add(id)
      void load(id, path?.startsWith(`${AUTH_PICTURE_PATH}?`) ? path : authPicturePath(id))
    },

    clear() {
      epoch += 1
      inFlight.clear()
      retryAt.clear()
      store.setState({ pictures: {} })
    }
  }
}
