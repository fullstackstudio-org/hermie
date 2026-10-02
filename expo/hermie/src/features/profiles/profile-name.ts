/**
 * What the gateway will accept as a bot's handle, decided before we ask it.
 *
 * A profile's name is not a label — it is a directory under `profiles/`, an
 * argv value after `-p`, and the filename of a wrapper script in `~/.local/bin`.
 * Upstream validates it in three places for those three reasons, and the rules
 * are not guessable from the outside: `default` is simultaneously a legal
 * profile id and the one name `create_profile` refuses.
 *
 * So this file is a transcription, not an interpretation. Every rule below
 * names the upstream line it came from, and the test beside it asserts the same
 * cases upstream's own validator does. The point is a form that says "that name
 * is taken" while the reader is still typing, instead of a round trip that
 * comes back with a Python exception message in a toast.
 *
 * Upstream: `hermes_constants.py::PROFILE_ID_RE`, and in `hermes_cli/profiles.py`
 * `normalize_profile_name`, `validate_profile_name`, `_RESERVED_NAMES`,
 * `_HERMES_SUBCOMMANDS` and the `canon == "default"` guard inside
 * `create_profile`.
 *
 * The gateway stays the authority: `profiles.create` runs all of this again and
 * can still refuse for a reason no client can see (a directory that exists
 * without a profile identity file, an alias collision with a binary on the
 * host's PATH). This is the cheap half, not a replacement.
 */

/**
 * `hermes_constants.py::PROFILE_ID_RE`, character for character.
 *
 * Lower case only — there is no case-insensitive flag upstream either, which is
 * why {@link normalizeProfileName} has to lower the string BEFORE this runs
 * rather than this pattern being relaxed to match.
 */
const PROFILE_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/

/**
 * `hermes_cli/profiles.py::_RESERVED_NAMES`.
 *
 * These collide with the Hermes installation itself or with a common system
 * binary, because a created profile also mints a wrapper script named after it.
 */
const RESERVED_NAMES = new Set(['hermes', 'default', 'test', 'tmp', 'root', 'sudo'])

/**
 * `hermes_cli/profiles.py::_HERMES_SUBCOMMANDS`, abridged to the ones a person
 * would plausibly name a bot.
 *
 * This list is a WARNING and never a refusal, which is the one place this file
 * deliberately differs in kind from upstream's other checks: a subcommand
 * collision does not stop `profiles.create`, it only makes
 * `check_alias_collision` decline to write the `hermes <name>` wrapper. The bot
 * works; the shell shortcut does not. Refusing the name here would invent a
 * rule the gateway does not have.
 */
const HERMES_SUBCOMMANDS = new Set([
  'chat',
  'model',
  'gateway',
  'setup',
  'whatsapp',
  'login',
  'logout',
  'serve',
  'update',
  'profile',
  'skills',
  'tools',
  'cron',
  'plugins',
  'mcp',
  'auth',
  'config'
])

/** `hermes_cli/profiles.py::_PROFILE_NAME_RULE`, quoted so the wording matches the CLI's. */
export const PROFILE_NAME_RULE =
  "Use lowercase letters, numbers, '-' or '_', starting with a letter or number, up to 64 characters"

/**
 * `normalize_profile_name`: strip, then lower case, with `default` matched
 * case-insensitively so `Default` and `DEFAULT` both land on the built-in.
 *
 * Callers normalise before validating. Upstream is explicit that the two are
 * separate on purpose (`validate_profile_name`'s docstring, issue #18498): the
 * validator describes what the on-disk directory must look like, and the
 * ingress point is where a human's title-cased typing is made to fit it.
 */
export const normalizeProfileName = (name: string): string => {
  const stripped = name.trim()

  if (stripped.toLowerCase() === 'default') {
    return 'default'
  }

  return stripped.toLowerCase()
}

/**
 * `_suggest_profile_name`: a best-effort legal id derived from what was typed,
 * so the error can end with something the reader can accept rather than only
 * with what they did wrong. `My Work` becomes `my-work`.
 */
export const suggestProfileName = (name: string): string => {
  const candidate = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^[-_]+|[-_]+$/g, '')
    .slice(0, 64)

  return PROFILE_ID_RE.test(candidate) ? candidate : 'my-work'
}

export interface ProfileNameVerdict {
  /** The name as the gateway would store it. Empty when nothing usable was typed. */
  readonly handle: string
  /** Whether {@link handle} may be sent to `profiles.create`. */
  readonly ok: boolean
  /** Why not, in the gateway's own terms. `null` when {@link ok}. */
  readonly error: string | null
  /**
   * A true statement about a legal name that the reader should still see —
   * currently only the alias collision, which costs the `hermes <name>`
   * shortcut and nothing else.
   */
  readonly warning: string | null
}

/**
 * The whole verdict in one pass, for a field that validates while it is typed.
 *
 * `taken` is the roster the client already holds. Checking it here turns the
 * commonest failure — a name that exists — into an inline message instead of a
 * refusal, and upstream raises `FileExistsError` for exactly this case, so the
 * two agree about the outcome and only differ in when the reader learns it.
 */
export const checkProfileName = (raw: string, taken: readonly string[] = []): ProfileNameVerdict => {
  const handle = normalizeProfileName(raw)
  const fail = (error: string): ProfileNameVerdict => ({ handle, ok: false, error, warning: null })

  if (!handle) {
    return fail('A bot needs a handle.')
  }

  // `create_profile` refuses this one BEFORE the reserved-name check can reach
  // it, and with a different message, because `default` is a legal profile id
  // everywhere else: it is the built-in profile at `~/.hermes`.
  if (handle === 'default') {
    return fail("'default' is the built-in bot and cannot be created again.")
  }

  if (!PROFILE_ID_RE.test(handle)) {
    return fail(`${PROFILE_NAME_RULE} (for example: ${suggestProfileName(raw)}).`)
  }

  if (RESERVED_NAMES.has(handle)) {
    return fail(`'${handle}' is reserved: it collides with Hermes itself or with a common system command.`)
  }

  if (taken.includes(handle)) {
    return fail(`'${handle}' already exists.`)
  }

  return {
    handle,
    ok: true,
    error: null,
    warning: HERMES_SUBCOMMANDS.has(handle)
      ? `'${handle}' is also a hermes subcommand, so the \`hermes ${handle}\` shortcut will not be created. The bot itself is fine.`
      : null
  }
}
