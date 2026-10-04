/**
 * What the Settings pages are given by the page, and cannot read from a store: where the gateway is,
 * who the gateway says is signed in, which Hermes it runs, where the licence list is, and the two
 * things only the entry module can do (end the session, and clear the transcript cache it holds).
 *
 * A context, like the passkey and MCP models' actions, and optional for the same reason: a screen
 * rendered with none (a test of the shell) draws what the stores hold and acts on nothing.
 */
import { createContext, useContext } from 'react'

/** `/api/auth/me`, as far as Settings shows it. Every field may be empty. */
export interface AccountIdentity {
  displayName: string
  email: string
  userId: string
  provider: string
}

export interface SettingsRuntime {
  /** The gateway's base URL: origin plus prefix, no trailing slash. */
  gatewayBaseUrl: string
  /** The Hermes version the gateway's status route reported at boot; empty when it said none. */
  hermesVersion: string
  /** Who `/api/auth/me` named. */
  identity: AccountIdentity
  /** Who is signed in, for a sentence: the display name, else the email, else the id; empty when nobody was named. */
  user: string
  /** Where the gateway holds the signed-in person's picture; empty when it holds none. */
  pictureUrl: string
  /** Where `licenses.json` is served from, beside the page. */
  licencesUrl: string
  /** Forget every transcript and the roster this browser stored. */
  clearTranscriptCache: () => Promise<void>
  /** Stop the session, end the gateway's, clear this person's stored state and leave (the entry module's sign-out). */
  signOut: () => void
}

export const SettingsRuntimeContext = createContext<SettingsRuntime | null>(null)

export const useSettingsRuntime = (): SettingsRuntime | null => useContext(SettingsRuntimeContext)
