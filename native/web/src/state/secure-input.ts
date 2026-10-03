/**
 * The one-string prompts a bot is waiting on (`secret`, `sudo`,
 * `vault.unlock_prompt`, `vault.code`, `vault.save_login`), and the notices a chat
 * shows about a prompt that ended without the reader's answer or a request this
 * page cannot show.
 *
 * **What was asked, never what is answered.** Nothing in this store, or anywhere
 * else the page keeps state, ever holds a value a person typed into one of these
 * sheets: the sheet reads its own field when Send is pressed and hands the text
 * straight to `SecureInputModel.answer`, which puts it into the JSON-RPC reply and
 * forgets it (`core/requests/secure-input.ts`). The texts held here are the
 * request's own words, cleaned and bounded for display (`displayText`).
 *
 * Written by the secure input model and nothing else; read by the request queue
 * (`state/requests.ts`), the request layer (the five sheets) and the chat screen
 * (the notice). The kinds and notices are the native apps'
 * (`HermieCore/SecureInput`), so both clients say the same thing.
 */
import { createStore, type StoreApi } from 'zustand/vanilla'

/** What one prompt asks for, as the sheet shows it. */
export type SecureAsk =
  /** A value for an environment variable, stored on the gateway for the bot's profile; the bot never sees it. */
  | { kind: 'secret'; envVar: string; prompt: string }
  /** The administrator password for a command the bot runs on the gateway's host (already redacted; may be empty). */
  | { kind: 'sudo'; command: string }
  /** The master password of a password manager, named as the gateway names it. */
  | { kind: 'vault_unlock'; name: string }
  /** A one-time code a site asked for. */
  | { kind: 'vault_code'; site: string; hint: string }
  /** A login to save for a site the bot is about to sign in to. */
  | { kind: 'vault_save_login'; site: string; origin: string }

/** One open prompt, on a chat the page holds. */
export interface SecurePrompt {
  /** The server request's id (`srq-...`). */
  id: string
  /** The JSON-RPC method, as it came. */
  method: string
  ask: SecureAsk
  /** The chat it belongs to: the key of the chat whose runtime session asked. */
  bot: string
  /** The runtime session the request names. */
  sessionId: string
  /**
   * When the gateway stops waiting, in epoch milliseconds on this page's clock, for the countdown; `null`
   * when this page cannot know (it first saw the request re-delivered, so it may have waited a while).
   */
  deadline: number | null
  /** The gateway asks again because an answer sent from here never reached it: the sheet says so. */
  earlierAnswerLost: boolean
  /** The order prompts were first seen in, across chats. */
  seq: number
}

/** Why a chat shows a line about a prompt. */
export type SecureNoticeKind =
  /** The gateway's deadline passed (its own `request.cancel timeout`, or this page's clock): nothing was sent. */
  | { kind: 'expired' }
  /** The bot stopped asking (`request.cancel`, or the chat let go of the session): nothing was sent. */
  | { kind: 'withdrawn' }
  /** The bot asked for something only the desktop app can do (`method`, cleaned): it was declined. */
  | { kind: 'unsupported'; method: string }

export interface SecureNotice {
  /** A serial: the same notice twice is shown twice. */
  id: number
  /** The request it is about. */
  requestId: string
  notice: SecureNoticeKind
}

export interface SecureInputState {
  /** The gateway as a person knows it (its host), for the sheet's chrome. */
  gateway: string
  /** Every open prompt on a chat the page holds, oldest first. */
  prompts: readonly SecurePrompt[]
  /** The last notice per chat key. */
  notices: Readonly<Record<string, SecureNotice>>
  reset(): void
}

const INITIAL = {
  gateway: '',
  prompts: [] as readonly SecurePrompt[],
  notices: {} as Readonly<Record<string, SecureNotice>>
}

export function createSecureInputStore(): StoreApi<SecureInputState> {
  return createStore<SecureInputState>(set => ({
    ...INITIAL,
    reset: () => set({ ...INITIAL })
  }))
}

/** The page's store. */
export const secureInputStore: StoreApi<SecureInputState> = createSecureInputStore()
