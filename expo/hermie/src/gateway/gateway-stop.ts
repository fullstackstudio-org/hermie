import type { ConnectionStatus, GatewayError, GatewayErrorKind } from '@hermie/gateway-client'

import { strings } from '../i18n/strings'
import type { StoredGatewayConfig } from './config'
import { describeConnectionError, hostOf } from './errors'

/**
 * When the gateway itself is the problem, and what the screen that says so has
 * to carry.
 *
 * The line this draws is not severity, it is whether waiting helps. A dropped
 * socket, a radio that went away, an address that answered with a proxy's 405:
 * the ladder is climbing, the cached conversations are still worth reading, and
 * `features/chats/connection-notice.ts` puts a word over them without taking
 * the screen. What lands here instead is the set of failures the connection
 * state machine has ALREADY given up on — it sets `running = false` and stops —
 * plus a signed-out session, which is the same shape with a different fix.
 *
 * From there the only ways forward are a fresh dial, a different address, or
 * different credentials, so the screen that announces one carries all three.
 * And it carries the address: the report that produced this module was a fresh
 * TestFlight install that inherited a stored gateway from an earlier one and
 * said only that the endpoint was not what it expected — naming no address,
 * offering nothing to press, leaving reinstalling as the way out.
 */

/** The failure families the stopped screen speaks about, collapsed from kind + close code. */
export type GatewayStopKind = 'auth' | 'config' | 'tls' | 'incompatible' | 'protocol' | 'not_hermes' | 'redirect'

/** What it offers; `useReauth` decides what signing in MEANS for the gateway's auth mode. */
export type GatewayStopAction = 'signIn' | 'recheck' | 'changeGateway' | 'signOut' | 'switchGateway'

export interface GatewayAddressParts {
  /** The address exactly as it is stored, path prefix and all. */
  url: string
  scheme: string
  host: string
  /** The explicit port, or the scheme's default when the address leaves it out. */
  port: string
}

export interface GatewayStop {
  kind: GatewayStopKind
  /**
   * What this gateway is CALLED, when the device knows more than one.
   *
   * Empty on a device with a single gateway, where the card is already
   * unambiguous and a name would be a label with nothing to distinguish it
   * from. The address block below it is unchanged either way: a name is how a
   * reader recognises the machine, and the address is how they check it.
   */
  gatewayName: string
  title: string
  /** One sentence, in the app's voice, about what went wrong. */
  sentence: string
  /** What to change, where that is something the sentence does not already say. */
  hint: string
  address: GatewayAddressParts
  /** The signed-in identity, when the gateway ever reported one. */
  identity: string | null
  actions: GatewayStopAction[]
}

export interface GatewayStopInput {
  status: ConnectionStatus
  error: GatewayError | null | undefined
  config: StoredGatewayConfig | null | undefined
  /** The active entry, when there is a list. Only its name is read. */
  gateway?: { name: string } | null
  /**
   * How many gateways this device has configured.
   *
   * It decides one thing: whether the card can offer stepping across to
   * another machine. With one there is nowhere to step, and an action that
   * leads nowhere is worse than an action that is absent.
   */
  gatewayCount?: number
}

/**
 * Kinds that mean the gateway, not the network.
 *
 * `protocol` is in the list and is nonetheless the one that almost never
 * appears here: a mint that answers like something other than a gateway keeps
 * its ladder — from `PROTOCOL_LADDER_FLOOR`, so it climbs slowly — and stays a
 * reconnect with a sentence on it. It only reaches this screen if the
 * connection has actually stopped, which is the rule below and the reason the
 * ladder's own wording is not taken away from it.
 */
const STOPPING_KINDS: ReadonlySet<GatewayErrorKind> = new Set<GatewayErrorKind>([
  'config',
  'tls',
  'incompatible',
  'protocol',
  'not_hermes',
  'redirect'
])

/**
 * Statuses where the loop has stopped.
 *
 * `reconnecting` and `offline` are deliberately absent: something is still
 * being tried, and taking the screen away from a reader who can still read
 * their conversations would be the app shouting over itself.
 */
const STOPPED_STATUSES: ReadonlySet<ConnectionStatus> = new Set<ConnectionStatus>([
  'disconnected',
  'needs_signin',
  'incompatible'
])

/** The statuses one dial passes through on its way to succeeding or failing again. */
const DIALLING_STATUSES: ReadonlySet<ConnectionStatus> = new Set<ConnectionStatus>([
  'probing',
  'authenticating',
  'connecting'
])

/**
 * The kinds the state machine actually STOPS on — see `handleFailure`.
 *
 * They are what the screen is held up through a dial for. Press Re-check and
 * the status runs `disconnected → authenticating → connecting` before anything
 * is known; without this the card would uncover the app for the length of the
 * dial and bury it again, which reads as a glitch rather than as an answer.
 * `lastError` survives those transitions, so the hold needs no state of its own.
 *
 * Only the terminal kinds, and that is the point of naming them separately: a
 * `protocol` answer from the ticket mint keeps its ladder — slowly, from
 * `PROTOCOL_LADDER_FLOOR` — and every rung of it passes through the same
 * dialling statuses. Holding a full-screen card up through a reconnect that is
 * still trying would take the conversations away from a reader who can still
 * read them.
 */
const STOPS_THE_LOOP: ReadonlySet<GatewayErrorKind> = new Set<GatewayErrorKind>(['config', 'tls', 'auth'])

/**
 * Statuses that mean the app is usable again — connected, or in one of the
 * states that keep the cached conversations readable while the loop works.
 */
export const RESOLVED_STATUSES: ReadonlySet<ConnectionStatus> = new Set<ConnectionStatus>([
  'ready',
  'reconnecting',
  'offline',
  'paused'
])

const DEFAULT_PORTS: Record<string, string> = { 'http:': '80', 'https:': '443' }

/**
 * Break a stored address into the parts a reader checks it by.
 *
 * The port is filled in from the scheme when the address leaves it out. "Is it
 * talking to 443 or to the 8443 I set up?" is exactly the question this screen
 * exists to answer, and an empty row answers nothing.
 */
export function describeGatewayAddress(baseUrl: string | null | undefined): GatewayAddressParts {
  const raw = (baseUrl ?? '').trim()
  const unknown = strings.settings.unknown

  if (!raw) {
    return { url: unknown, scheme: unknown, host: unknown, port: unknown }
  }

  try {
    const url = new URL(raw)

    return {
      url: raw,
      scheme: url.protocol.replace(':', ''),
      host: url.hostname || unknown,
      port: url.port || DEFAULT_PORTS[url.protocol] || unknown
    }
  } catch {
    // An address that no longer parses is still the address the app is stuck
    // on, so it is shown as it stands rather than replaced with "Unknown".
    return { url: raw, scheme: unknown, host: raw, port: unknown }
  }
}

function kindOf(status: ConnectionStatus, error: GatewayError | null | undefined): GatewayStopKind | null {
  if (status === 'needs_signin' || (error?.kind === 'auth' && status !== 'disconnected')) {
    return 'auth'
  }

  if (error && STOPPING_KINDS.has(error.kind)) {
    return error.kind as GatewayStopKind
  }

  return status === 'incompatible' ? 'incompatible' : null
}

function titleFor(kind: GatewayStopKind, closeCode: number | undefined): string {
  const titles = strings.signedOut.stopped.titles

  if (closeCode === 4408) {
    return titles.takenOver
  }

  return closeCode === 4404 ? titles.chatOff : titles[kind]
}

/**
 * The second line, and only where there is one worth reading.
 *
 * The gateway client's own `hint` wins: it attaches one that knows something
 * this app cannot work out — which host the address actually led to, or that
 * the gateway may be on a network this device is not on. After that there are
 * exactly two, both about a gateway that is answering and refusing: see
 * `strings.signedOut.stopped.hints` for why the list is that short.
 */
function hintFor(kind: GatewayStopKind, error: GatewayError | null | undefined): string {
  if (error?.hint) {
    return error.hint
  }

  const hints = strings.signedOut.stopped.hints

  if (error?.closeCode === 4408) {
    return hints.takenOver
  }

  // 4404 is chat switched off: a gateway setting with nothing to add to it.
  return kind === 'config' && error?.closeCode !== 4404 ? hints.config : ''
}

/**
 * What the stopped screen should say, or `null` while the app is usable — or
 * usable enough that the cached conversations are worth more than an
 * explanation.
 *
 * A gateway that was never configured returns `null` too: with nothing stored
 * there is nothing to explain, and the wizard already owns the screen.
 */
export function gatewayStop({
  status,
  error,
  config,
  gateway,
  gatewayCount = 1
}: GatewayStopInput): GatewayStop | null {
  const stopped =
    STOPPED_STATUSES.has(status) ||
    (DIALLING_STATUSES.has(status) && error !== null && error !== undefined && STOPS_THE_LOOP.has(error.kind))

  if (!config || !stopped) {
    return null
  }

  const kind = kindOf(status, error)

  if (!kind) {
    return null
  }

  const host = hostOf(config.baseUrl)

  /*
    Stepping across to another configured gateway, where there is one.

    Offered on every stop rather than only on the one that named it, and the
    reason is what the reader is looking at: a card that says this machine
    cannot be used is a card where "use the other one" is the fastest true
    answer, whether the gateway refused the connection, answered like something
    else, or simply signed them out. It goes LAST in the list, after the ways
    of fixing the gateway that is actually broken.
  */
  const canSwitch = gatewayCount > 1

  return {
    kind,
    gatewayName: canSwitch ? (gateway?.name ?? '') : '',
    title: titleFor(kind, error?.closeCode),
    // The signed-out sentence is the one this card already had, and it is
    // better than the connection table's: it names the gateway and says what
    // stops working, rather than restating the close code.
    sentence:
      kind === 'auth'
        ? host
          ? strings.signedOut.body(host)
          : strings.signedOut.bodyNoHost
        : error
          ? describeConnectionError(error, config.baseUrl)
          : strings.errors.unknown,
    hint: hintFor(kind, error),
    address: describeGatewayAddress(config.baseUrl),
    identity: config.userDisplayName?.trim() ? config.userDisplayName : null,
    // Signing out of a session the gateway has already rejected does nothing a
    // reader wants; signing in, or going somewhere else, is the whole choice.
    // Every other stop still holds credentials worth being able to drop.
    actions: [
      ...(kind === 'auth'
        ? (['signIn', 'recheck', 'changeGateway'] as GatewayStopAction[])
        : (['recheck', 'changeGateway', 'signOut'] as GatewayStopAction[])),
      ...(canSwitch ? (['switchGateway'] as GatewayStopAction[]) : [])
    ]
  }
}
