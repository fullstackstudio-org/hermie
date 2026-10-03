/**
 * Who the gateway says this page's reader is.
 *
 * Until HERM-119 the Expo app's store of this name also held a `context`
 * section (a person's name, device, time zone, locale and free text) that the
 * gateway-side plugin rendered into a bot's system prompt. That is gone: the
 * gateway binds the signed-in person to every message itself. The section is
 * RETIRED, and `core/ui-meta-bridge.ts` drops a `context` field it finds in the
 * app-wide section the next time it writes that section.
 *
 * What is left is narrower but load-bearing: this identity is how
 * `core/ui-meta-bridge.ts` picks the app-wide `ui_meta` key
 * (`hermie-app:<user id>`, see `uiMetaUserIdOf`), and how a screen says who is
 * signed in (`effectiveDisplayName`).
 *
 * Ported from the Expo app's `src/store/device-context.ts`. Deliberate
 * differences:
 *
 *  - **No `baseUrl`.** A page has one gateway, its own origin.
 *  - **No `hydrate`.** The Expo one only deleted what a build before HERM-119
 *    left on disk; this client never wrote that key. The identity itself is read
 *    by the boot (`/api/auth/me`) before anything renders, so there is nothing
 *    to persist either.
 *  - **`uiMetaUserIdOf` is new**: the Expo app's `ChatRuntime` derived the key's
 *    user id inline (`identity.userId || identity.email`); it is named here so
 *    the page and the tests derive it the same way, and so the key is the same
 *    string every other client of this person builds.
 *  - A vanilla zustand store (`deviceContextStore`, and
 *    `createDeviceContextStore` for tests).
 */
import { createStore, type StoreApi } from 'zustand/vanilla'

/**
 * The user id used where the gateway cannot name anybody.
 *
 * A session-token gateway has no identity to ask for. A fixed id is what makes
 * the `ui_meta` key a hit rather than a coin toss, and `owner` is what the
 * gateway's own documentation calls whoever runs it. This client runs on the
 * cookie session only, so it is used for the session-token mode W-23 adds.
 */
export const OWNER_USER_ID = 'owner'

/** A cap for the stored address. RFC 5321's longest path; nothing rides on the exact number. */
const EMAIL_LIMIT = 320
const DISPLAY_NAME_LIMIT = 80
const USER_ID_LIMIT = 128

const clean = (value: unknown, limit: number): string =>
  typeof value === 'string' ? value.split(/\s+/u).filter(Boolean).join(' ').slice(0, limit) : ''

export interface DeviceIdentity {
  /** True where the gateway has accounts. */
  gated: boolean
  /** Who the gateway says this is. Empty means nobody. */
  userId: string
  displayName: string
  email: string
}

export interface DeviceContextState extends DeviceIdentity {
  /** Who this page's reader is. Empty `userId` means nobody. */
  setIdentity: (identity: DeviceIdentity) => void
  /** Forget the identity: a sign-out. */
  retire: () => void
  reset: () => void
}

const EMPTY: DeviceIdentity = { gated: false, userId: '', displayName: '', email: '' }

export function createDeviceContextStore(): StoreApi<DeviceContextState> {
  return createStore<DeviceContextState>((set, get) => ({
    ...EMPTY,

    setIdentity({ gated, userId, displayName, email }) {
      const id = clean(userId, USER_ID_LIMIT)
      const name = clean(displayName, DISPLAY_NAME_LIMIT)
      const address = clean(email, EMAIL_LIMIT)
      const current = get()

      if (
        current.userId === id &&
        current.displayName === name &&
        current.email === address &&
        current.gated === gated
      ) {
        return
      }

      set({ gated, userId: id, displayName: name, email: address })
    },

    retire() {
      set(EMPTY)
    },

    reset() {
      set(EMPTY)
    }
  }))
}

/** The page's store. */
export const deviceContextStore: StoreApi<DeviceContextState> = createDeviceContextStore()

/**
 * The id the app-wide `ui_meta` key is built from (`hermie-app:<id>`), from what
 * `/api/auth/me` answered.
 *
 * The gateway's user id, else the address it signed the person in with, else
 * nothing (and nothing is the local-only path, never a guessed name). Exactly the
 * Expo app's derivation (`ChatRuntime.readIdentity`), raw rather than cleaned:
 * the key has to be the same string on every client this person uses, and the
 * other clients do not clean it.
 */
export function uiMetaUserIdOf(identity: { userId?: string; email?: string } | null | undefined): string {
  return identity?.userId || identity?.email || ''
}

/** `sebas@example.invalid` → `sebas`. Nothing at all for something that is not one. */
const EMAIL_LOCAL_PART = /^([^@\s]+)@[^@\s]+$/u

/**
 * `authentik:7f3a…` → `7f3a…`, and `https://issuer/…` left alone.
 *
 * The gateway addresses a person as `<provider>:<subject>`, and the provider is
 * the half that says nothing about WHO. The negative lookahead is why this is a
 * regular expression rather than a `split(':')`: an issuer URL used as a subject
 * also has a colon in it.
 */
const PROVIDER_PREFIX = /^[A-Za-z][A-Za-z0-9._-]*:(?!\/\/)(.+)$/u

/**
 * The name this page shows for the signed-in reader, which is rarely the one
 * the gateway sends: the gateway's own display name, else the local part of the
 * address, else the user id with the provider prefix taken off (an opaque
 * subject is not prettified: a guessed name would be a wrong one).
 */
export function effectiveDisplayName(state: Pick<DeviceIdentity, 'displayName' | 'email' | 'userId'>): string {
  const given = clean(state.displayName, DISPLAY_NAME_LIMIT)

  if (given) {
    return given
  }

  const local = EMAIL_LOCAL_PART.exec(clean(state.email, EMAIL_LIMIT))?.[1]

  if (local) {
    return clean(local, DISPLAY_NAME_LIMIT)
  }

  const id = clean(state.userId, USER_ID_LIMIT)

  return clean(PROVIDER_PREFIX.exec(id)?.[1] ?? id, DISPLAY_NAME_LIMIT)
}
