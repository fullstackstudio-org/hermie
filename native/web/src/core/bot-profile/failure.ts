/**
 * Why a bot profile call did not do what the page asked, sorted by what the page should do about it (the
 * native app's `BotSettingsFailure`).
 *
 *  - `forbidden`: this account may look at the bot and not change it. The page goes read-only.
 *  - `unsupported`: the gateway has no such method (-32601). The section is hidden, not shown dead.
 *  - `offline`: no connection to ask over, or none in time. Nothing was changed; try again.
 *  - `not_found`: the gateway has no such profile.
 *  - `not_applied`: the gateway answered, and said it did not write the section.
 *  - `refused`: the gateway said no, in its own words. Those words are untrusted text.
 *  - `last_toolset`: nothing was sent. The gateway reads an EMPTY pin as "no pin, use the defaults", so a bot
 *    with every toolset off cannot be written; the last one stays on instead of the page reporting a state
 *    the gateway would undo. The way back to the defaults is its own request.
 *
 * The gateway has no profile-level permission code of its own yet (`profiles.configure` answers any caller),
 * so `forbidden` is read from what a gateway in front of it, or a later build, would say: the access-denied
 * range of codes and explicit words for it. An operating-system error (a read-only file system, a permission
 * error on the file) is a refusal, never a denial.
 */
export type BotProfileFailureKind =
  'forbidden' | 'unsupported' | 'offline' | 'not_found' | 'not_applied' | 'refused' | 'last_toolset'

export class BotProfileFailure extends Error {
  constructor(
    readonly kind: BotProfileFailureKind,
    /** The gateway's own words, when it had some. Untrusted: drawn as characters. */
    readonly detail = ''
  ) {
    super(detail || kind)
    this.name = 'BotProfileFailure'
  }
}

/** JSON-RPC "method not found". */
const METHOD_NOT_FOUND = -32601
/** The codes a gateway answers an account that may not do this with. */
const FORBIDDEN_CODES: ReadonlySet<number> = new Set([4030, 4031, 4032, 4033, 4403, 403])
/** The gateway's "profile not found" for the `profiles.*` methods. */
const NOT_FOUND_CODES: ReadonlySet<number> = new Set([4064, 5063])

const FORBIDDEN_WORDS = [
  'forbidden',
  'unauthorized',
  'not authorized',
  'access denied',
  'do not have permission',
  'does not have permission',
  'insufficient permission'
]

/**
 * The explicit words an access denial uses. Deliberately not the bare words of an operating-system error that
 * a write can also fail with ("Read-only file system", "Permission denied"): those say the gateway's disk
 * would not take the file, not that this account may not edit the bot.
 */
export const looksForbidden = (message: string): boolean => {
  const lower = message.toLowerCase()

  return FORBIDDEN_WORDS.some(word => lower.includes(word))
}

const OFFLINE_WORDS = ['not connected', 'timed out', 'timeout', 'closed', 'network', 'socket']

/** Sort anything a gateway call can throw. */
export function classifyFailure(error: unknown): BotProfileFailure {
  if (error instanceof BotProfileFailure) {
    return error
  }

  const message = error instanceof Error ? error.message : String(error ?? '')
  const code = (error as { code?: unknown } | null)?.code

  if (typeof code === 'number') {
    if (code === METHOD_NOT_FOUND) {
      return new BotProfileFailure('unsupported', message)
    }

    if (FORBIDDEN_CODES.has(code) || looksForbidden(message)) {
      return new BotProfileFailure('forbidden', message)
    }

    if (NOT_FOUND_CODES.has(code)) {
      return new BotProfileFailure('not_found', message)
    }

    return new BotProfileFailure('refused', message)
  }

  if (looksForbidden(message)) {
    return new BotProfileFailure('forbidden', message)
  }

  const lower = message.toLowerCase()

  return OFFLINE_WORDS.some(word => lower.includes(word))
    ? new BotProfileFailure('offline', message)
    : new BotProfileFailure('refused', message)
}
