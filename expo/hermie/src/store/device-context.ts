/**
 * Who the gateway says this device's reader is.
 *
 * Until HERM-119 this store also held a `context` section — a person's name,
 * device, timezone, locale and their own free text — that the gateway-side
 * plugin rendered into a bot's system prompt. That is gone: since the Hermes
 * fork this app runs against, the gateway itself binds the signed-in person to
 * every message, and Hermes puts the time zone in the session
 * (`HERMES_TIMEZONE`) on its own, so the app no longer has anything to add
 * there. What is genuinely lost is the device (phone or Mac) and the app's own
 * language, which a bot is simply no longer told.
 *
 * What is left is narrower but still load-bearing: this identity is also how
 * `UserChatDirectory` (`features/chats/ChatRuntime.tsx`) tells "my chats" from
 * "the shared ones" apart, how `SidebarIdentity` shows who is signed in, and
 * how `UiMetaBridge.setUser` picks which profile's `ui_meta` to read and
 * write. None of that is specific to the removed feature, so it stays.
 */
import { create } from 'zustand'

import { keyValueStore } from '../platform/key-value-store'

/**
 * The key the removed `context` section used to persist under.
 *
 * Kept only so `hydrate` can clear out whatever an installed build still has
 * on disk from before HERM-119 — nothing here reads it any more.
 */
const STALE_CONTEXT_KEY = 'hermie.context'

/**
 * The user id used where the gateway cannot name anybody.
 *
 * A session-token gateway has no identity to ask for — `/api/auth/me` answers
 * for a person and there is no person. A fixed id is what makes "my chats"
 * and the `ui_meta` profile a hit rather than a coin toss, and `owner` is what
 * the gateway's own documentation calls whoever runs it.
 */
export const OWNER_USER_ID = 'owner'

/** A cap for the stored address. RFC 5321's longest path; nothing rides on the exact number. */
const EMAIL_LIMIT = 320
const DISPLAY_NAME_LIMIT = 80
const USER_ID_LIMIT = 128

const clean = (value: unknown, limit: number): string =>
  typeof value === 'string' ? value.split(/\s+/u).filter(Boolean).join(' ').slice(0, limit) : ''

export interface DeviceContextState {
  /** The gateway this identity belongs to. Empty before one is configured. */
  baseUrl: string
  /** True where the gateway has accounts. */
  gated: boolean
  /** Who the gateway says this is. Empty until an identity has been read. */
  userId: string
  /** The gateway's own display name for them. Often empty; see `effectiveDisplayName`. */
  displayName: string
  /** The address the gateway signed them in with, if it named one. */
  email: string
  loaded: boolean

  hydrate: () => Promise<void>
  /** Who this device is on which gateway. Empty `userId` means nobody. */
  setIdentity: (identity: {
    baseUrl: string
    gated: boolean
    userId: string
    displayName: string
    email: string
  }) => void
  /** Forget the identity: a sign-out, or another gateway. */
  retire: () => void
  reset: () => void
}

export const useDeviceContextStore = create<DeviceContextState>((set, get) => ({
  baseUrl: '',
  gated: false,
  userId: '',
  displayName: '',
  email: '',
  loaded: false,

  async hydrate() {
    if (get().loaded) {
      return
    }

    // One-time cleanup: a build before HERM-119 may have left the reader's
    // sharing switches and free text sitting under this key. Nothing reads it
    // any more, so it is dropped rather than carried for ever.
    await keyValueStore.delete(STALE_CONTEXT_KEY).catch(() => undefined)

    set({ loaded: true })
  },

  setIdentity({ baseUrl, gated, userId, displayName, email }) {
    const id = clean(userId, USER_ID_LIMIT)
    const name = clean(displayName, DISPLAY_NAME_LIMIT)
    const address = clean(email, EMAIL_LIMIT)
    const current = get()

    if (
      current.userId === id &&
      current.displayName === name &&
      current.email === address &&
      current.baseUrl === baseUrl &&
      current.gated === gated
    ) {
      return
    }

    set({ baseUrl, gated, userId: id, displayName: name, email: address })
  },

  retire() {
    set({ baseUrl: '', gated: false, userId: '', displayName: '', email: '' })
  },

  reset() {
    set({ baseUrl: '', gated: false, userId: '', displayName: '', email: '', loaded: false })
  }
}))

/** `sebas@example.invalid` → `sebas`. Nothing at all for something that is not one. */
const EMAIL_LOCAL_PART = /^([^@\s]+)@[^@\s]+$/u

/**
 * `authentik:7f3a…` → `7f3a…`, and `https://issuer/…` left alone.
 *
 * The gateway addresses a person as `<provider>:<subject>`, and the provider is
 * the half that says nothing about WHO: two people on the same gateway share
 * it. The negative lookahead is the whole reason this is a regular expression
 * rather than a `split(':')` — an issuer URL used as a subject also has a colon
 * in it, and cutting at that one turns `https://issuer/x` into `//issuer/x`.
 */
const PROVIDER_PREFIX = /^[A-Za-z][A-Za-z0-9._-]*:(?!\/\/)(.+)$/u

/**
 * The name this device shows for the signed-in reader, which is rarely the one
 * the gateway sends.
 *
 * Measured on a real gateway with OIDC: `/api/auth/me` answered with a user id
 * and NOTHING else — no `display_name`, no `email`. The rungs, in order, are
 * the gateway's own display name, the local part of the address it signed them
 * in with, and last the user id with the provider prefix taken off. The last
 * rung is deliberately not prettified: an OIDC subject is an opaque string and
 * guessing a person's name out of it would show a wrong name, which is worse
 * than an ugly right one. On a gateway with no accounts the id is `owner`, and
 * `owner` is what it says.
 */
export function effectiveDisplayName(state: Pick<DeviceContextState, 'displayName' | 'email' | 'userId'>): string {
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
