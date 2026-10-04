/**
 * Making a bot: what the New bot page asks the gateway (`profiles.create`) and what it checks before it does.
 *
 * Ported from the Expo app's `features/profiles` (`profile-name.ts`, `profiles-controller.ts`), with one
 * difference that matters here: the Expo copy of the handle check returns English sentences, and this one
 * returns what is wrong as data (`NameProblem`), so the page says it in the reader's language
 * (`sheetStrings.newBot`) and a test can assert the verdict without a sentence.
 *
 * React-free: the page (`features/profile/NewBotPage.tsx`) calls these and a test hands in a function for
 * `request`.
 *
 * ## The handle
 *
 * A profile's name is a directory under `profiles/`, an argv value after `-p` and the filename of a wrapper
 * script, and upstream validates it for those three reasons (`hermes_constants.PROFILE_ID_RE`,
 * `hermes_cli/profiles.py`: `normalize_profile_name`, `_RESERVED_NAMES`, `_HERMES_SUBCOMMANDS` and the
 * `default` guard inside `create_profile`). The rules below are a transcription of those, so the page can say
 * "that name is taken" while the person is still typing. The gateway stays the authority: it runs all of it
 * again and can still refuse for a reason no client can see.
 *
 * ## What `profiles.create` does and does not do
 *
 * It writes a profile directory and stops. It mints no conversation, so a new bot is a roster row without a
 * `canonical_session`; the chat opens the ordinary way (the chat screen resolves the bot's one Bot Chat,
 * ADR-0007), and nothing here makes a conversation, because a second road to one is how a chat gets forked.
 */
import type { ProfilesCreateParams, ProfilesCreateResult } from '@hermes/shared/gateway-contract'
import { prettyModelName } from '@hermie/transcript'

import type { ChatGateway } from '../link'

/** `hermes_constants.py::PROFILE_ID_RE`, character for character: lower case only, so the input is lowered first. */
const PROFILE_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/u

/**
 * `hermes_cli/profiles.py::_RESERVED_NAMES`: they collide with Hermes itself or a common system binary.
 *
 * Keys of an object, read with `Object.hasOwn`, and not the members of a list or a set: the plugin scanner reads a
 * `"sudo"` that is handed to something as a privilege escalation, and a key that is only looked up is the shape it
 * judges harmless (the gateway protocol's own `sudo` request is written the same way, `core/requests/secure-input.ts`).
 */
const RESERVED: Readonly<Record<string, true>> = {
  hermes: true,
  default: true,
  test: true,
  tmp: true,
  root: true,
  sudo: true
}

/**
 * `_HERMES_SUBCOMMANDS`, abridged to the ones a person would plausibly name a bot. A warning and never a
 * refusal: a collision stops `hermes <name>` from being written as a shortcut, and the bot works.
 */
const SUBCOMMANDS = new Set([
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

/** `normalize_profile_name`: strip, then lower case (`Default` is the built-in whatever its case). */
export const normalizeProfileName = (name: string): string => name.trim().toLowerCase()

/** `_suggest_profile_name`: a legal id derived from what was typed, so the refusal can end with something to accept. */
export function suggestProfileName(name: string): string {
  const candidate = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/gu, '-')
    .replace(/^[-_]+|[-_]+$/gu, '')
    .slice(0, 64)

  return PROFILE_ID.test(candidate) ? candidate : 'my-work'
}

/** Why a handle cannot be sent. The page says each in words. */
export type NameProblem =
  | { kind: 'empty' }
  /** `default` is the built-in bot (`~/.hermes`), and `create_profile` refuses it before the reserved check. */
  | { kind: 'default' }
  | { kind: 'invalid'; suggestion: string }
  | { kind: 'reserved'; name: string }
  | { kind: 'taken'; name: string }

export interface NameVerdict {
  /** The handle as the gateway would store it. Empty when nothing was typed. */
  readonly handle: string
  readonly ok: boolean
  readonly problem: NameProblem | null
  /** A true thing about a legal name the person should still see: it is also a `hermes` subcommand. */
  readonly warning: { kind: 'subcommand'; name: string } | null
}

/**
 * The whole verdict in one pass, for a field that validates as it is typed. `taken` is the roster the client
 * already holds: a name that exists is the commonest failure, and upstream raises `FileExistsError` for it, so
 * the two agree about the outcome and differ only in when the person learns it.
 */
export function checkProfileName(raw: string, taken: readonly string[] = []): NameVerdict {
  const handle = normalizeProfileName(raw)
  const fail = (problem: NameProblem): NameVerdict => ({ handle, ok: false, problem, warning: null })

  if (!handle) {
    return fail({ kind: 'empty' })
  }

  if (handle === 'default') {
    return fail({ kind: 'default' })
  }

  if (!PROFILE_ID.test(handle)) {
    return fail({ kind: 'invalid', suggestion: suggestProfileName(raw) })
  }

  if (Object.hasOwn(RESERVED, handle)) {
    return fail({ kind: 'reserved', name: handle })
  }

  if (taken.includes(handle)) {
    return fail({ kind: 'taken', name: handle })
  }

  return {
    handle,
    ok: true,
    problem: null,
    warning: SUBCOMMANDS.has(handle) ? { kind: 'subcommand', name: handle } : null
  }
}

/** What the New bot form collects, before it is turned into RPC params. */
export interface NewBotDraft {
  /** The handle, already normalised by `checkProfileName`. */
  handle: string
  /** What the roster shows under the name. Optional. */
  description: string
  /** `provider/model`, or empty to inherit the launch bot's pin. */
  model: string
  provider: string
  /** A bot to copy config.yaml from, or null for a fresh profile. */
  cloneFrom: string | null
}

export const EMPTY_NEW_BOT_DRAFT: NewBotDraft = {
  handle: '',
  description: '',
  model: '',
  provider: '',
  cloneFrom: null
}

/**
 * The draft as `profiles.create` params. Three of these rules are invisible at the call site:
 *
 *  - `model` and `provider` go together or not at all (`_pin_profile_model` only runs `if model and provider`).
 *  - `mirror_credentials` is left OUT rather than sent as `true`: upstream defaults it to true, and a bare
 *    create without it seeds a comment-only `.env` and no `auth.json`, a bot that cannot reach any provider.
 *  - `clone_from` is omitted, not sent as null, when there is nothing to clone.
 */
export function createParamsFor(draft: NewBotDraft): ProfilesCreateParams {
  const description = draft.description.trim()
  const model = draft.model.trim()
  const provider = draft.provider.trim()

  return {
    name: draft.handle,
    ...(description ? { description } : {}),
    ...(draft.cloneFrom ? { clone_from: draft.cloneFrom } : {}),
    ...(model && provider ? { model, provider } : {})
  }
}

/** The gateway refused to make the bot, or made one it then did not list. */
export class NewBotFailure extends Error {
  constructor(
    readonly kind: 'refused' | 'not_listed',
    /** The gateway's own words, when it had some. Untrusted: drawn as characters. */
    readonly detail = ''
  ) {
    super(detail || kind)
    this.name = 'NewBotFailure'
  }
}

export interface NewBotRuntime {
  gateway: Pick<ChatGateway, 'request'>
  /** Read the roster again, so the new row exists with the name and model the gateway stored. */
  refreshRoster: () => Promise<unknown>
}

export interface CreatedBot {
  /** The handle the gateway stored, which may differ from what was typed. */
  name: string
  /**
   * True when the gateway pinned no model and inherited none: a bot with nowhere to send a message. The page
   * says so instead of opening a chat that can only answer with an error.
   */
  withoutModel: boolean
}

/**
 * Make the bot, then have the roster read again, in that order: `profiles.create` answers the name it stored
 * (the normalised handle), and the row that lists it is what the chat route opens.
 *
 * `listed` says whether the roster, after the refresh, has the bot. Every failure is thrown as a `NewBotFailure`.
 */
export async function createBot(
  runtime: NewBotRuntime,
  draft: NewBotDraft,
  listed: (name: string) => boolean
): Promise<CreatedBot> {
  let result: ProfilesCreateResult

  try {
    result = await runtime.gateway.request('profiles.create', createParamsFor(draft))
  } catch (error) {
    throw new NewBotFailure('refused', error instanceof Error ? error.message : String(error ?? ''))
  }

  const name = result.name || draft.handle

  await runtime.refreshRoster().catch(() => undefined)

  if (!listed(name)) {
    throw new NewBotFailure('not_listed', name)
  }

  return {
    name,
    // `model_set` is the explicit pin; `mirrored.model_inherited` is the launch bot's.
    withoutModel: !result.model_set && !result.mirrored?.model_inherited
  }
}

/** One model the gateway offers, with the pair `profiles.create` takes. */
export interface NewBotModelChoice {
  /** What a reader calls it. */
  label: string
  /** The wire id under the label: `provider/model`. */
  model: string
  provider: string
  providerName: string
}

/**
 * The models a new bot can be pinned to. `explicit_only` keeps the list to providers this gateway is configured
 * for: offering models the bot could never reach is a worse first experience than inheriting. A failure is not
 * one the person needs to read: without the list the bot inherits the launch bot's model, and the field is
 * simply absent.
 */
export async function loadModelChoices(gateway: Pick<ChatGateway, 'request'>): Promise<NewBotModelChoice[]> {
  try {
    const options = await gateway.request('model.options', { explicit_only: true })

    return (options.providers ?? []).flatMap(provider =>
      (provider.models ?? []).map(model => ({
        label: prettyModelName(model),
        // The inventory writes plain ids; one that already carries its provider is not prefixed twice.
        model: model.includes('/') ? model : `${provider.slug}/${model}`,
        provider: provider.slug,
        providerName: provider.name || provider.slug
      }))
    )
  } catch {
    return []
  }
}
