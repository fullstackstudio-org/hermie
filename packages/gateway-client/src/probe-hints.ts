/**
 * What a failed probe means BESIDES its kind, and what can be done about it.
 *
 * `GatewayErrorKind` says what went wrong at the transport. It does not say the
 * two things a person setting up a gateway most often needs told:
 *
 *  - that the address they typed is one only a particular network can reach, so
 *    the problem is which network this device is on rather than the address; and
 *  - that there is a next move — a host the answer actually came from, or a
 *    front door to fill in — as opposed to only a sentence.
 *
 * Both are decided here rather than in the app, because both are facts about
 * the failure and neither is a matter of wording. The app owns the sentences;
 * this owns which sentence and which buttons.
 *
 * **Nothing here resolves a name.** The same rule `host-privacy.ts` states: a
 * suffix is read as the intent it declares, and a host that lies about itself
 * buys a friendlier sentence and no access at all.
 */
import { classifyHost, type HostPrivacy } from './host-privacy'
import { isGatewayError } from './types'

/**
 * What kind of link the device says it is on.
 *
 * `unknown` is not a failure state — it is the browser's honest answer, and the
 * answer on any platform that has not been asked yet. Every rule below treats
 * it as "no information", never as "not cellular".
 */
export type NetworkKind = 'wifi' | 'cellular' | 'other' | 'unknown'

/**
 * The extra sentence, by code.
 *
 * A code rather than the sentence itself: this package has no string table and
 * the app does, and a library that shipped copy would mean two places to change
 * a word and one of them invisible to whoever is reading the app's voice.
 */
export type ProbeHintCode =
  /**
   * The address is one only a particular network can reach, and this device
   * does not look like it is on it.
   */
  'private_network' | 'none'

/**
 * Something the reader can press.
 *
 * Offered, never performed. The address that was typed is correct as far as the
 * reader knows, and an app that quietly followed a redirect is exactly the
 * behaviour the cached 301 in `probe.ts` produced.
 */
export type ProbeAction =
  /**
   * A redirect landed on this host. Point the wizard at it.
   *
   * `host` names it; `origin`, when the redirect's target was readable, is
   * where to GO — scheme and port included, IPv6 in brackets. A bare host
   * loses the port (a redirect to `other.example:8443` would be probed on 443)
   * and cannot carry an IPv6 literal at all, so a wizard taking the offer uses
   * `origin` when it is there.
   */
  | { kind: 'use_host'; host: string; origin?: string }
  /** An access proxy answered before the gateway did. Open the Advanced preset. */
  | { kind: 'front_door' }

export interface ProbeVerdict {
  hint: ProbeHintCode
  /**
   * The answer looked like a web page where JSON was expected.
   *
   * Reported separately from the hint because it is a different fact with a
   * different sentence: WHAT came back, as against WHERE the address points. An
   * earlier version of this joined them, and a landing page on a public host
   * was told to check its VPN — a guess dressed as a diagnosis.
   */
  landingPage: boolean
  actions: ProbeAction[]
}

export interface ProbeVerdictOptions {
  /** The address that was probed, as typed or as normalized; either parses. */
  address: string
  /** What the device reports. Omitted is `unknown`, which decides nothing. */
  network?: NetworkKind
}

/**
 * Privacy classes that mean "one network can reach this, and it is not the
 * public internet".
 *
 * Loopback is excluded, and it is the interesting exclusion: the device IS that
 * network, so "check you are connected to it" is advice nobody can act on. A
 * gateway that should be on `localhost` and is not is a process that is not
 * running.
 */
const REACHABLE_ON_ONE_NETWORK: readonly HostPrivacy[] = ['private', 'cgnat', 'tailnet', 'local_name', 'link_local']

function onlyOnOneNetwork(address: string): boolean {
  return REACHABLE_ON_ONE_NETWORK.includes(classifyHost(address).privacy)
}

/**
 * Read a failed probe: which extra sentence it earns, and what to offer.
 *
 * The two `private_network` triggers are separate facts, and both are things
 * this package actually knows rather than infers:
 *
 * 1. **A web page came back from a host only one network can reach.** Something
 *    answered — a reverse proxy's default host, a captive portal, a router's own
 *    admin page — and it was not the gateway. On a `10.x` or a `.ts.net` name
 *    that is the shape of being on the wrong network, or of a name resolving
 *    somewhere it should not.
 * 2. **Nothing answered at all, and the device says it is on cellular.** A
 *    tailnet name with the tunnel down fails to resolve, and a phone on mobile
 *    data is as far from the LAN as it gets. Cellular is required because it is
 *    the only reading strong enough to be worth a sentence: the same failure on
 *    Wi-Fi is equally likely to be a gateway that is switched off.
 *
 * What neither covers, and it is worth naming: a Headscale operator's own
 * domain looks public to `classifyHost`, so a gateway at `hermes.example.org`
 * that only resolves inside their tunnel gets the ordinary "could not reach"
 * sentence. Reading it as private would mean guessing about every public name
 * on the internet, and the sentence it would produce — check your VPN — is the
 * one that most reliably wastes somebody's time when it is wrong.
 */
export function classifyProbeFailure(error: unknown, options: ProbeVerdictOptions): ProbeVerdict {
  const empty: ProbeVerdict = { hint: 'none', landingPage: false, actions: [] }

  if (!isGatewayError(error)) {
    return empty
  }

  if (error.kind === 'redirect') {
    // Where the answer came from decides what all of it means, so this comes
    // before anything about the address that was typed.
    if (!error.redirectedTo) {
      return empty
    }

    return {
      ...empty,
      actions: [
        {
          kind: 'use_host',
          host: error.redirectedTo,
          ...(error.redirectedOrigin ? { origin: error.redirectedOrigin } : {})
        }
      ]
    }
  }

  if (error.kind === 'auth' && (error.status === 401 || error.status === 403)) {
    // A proxy refused before the gateway was reached. The one thing the app can
    // offer is the place to put that proxy's credential.
    return { ...empty, actions: [{ kind: 'front_door' }] }
  }

  const network = options.network ?? 'unknown'

  if (error.kind === 'not_hermes') {
    const landingPage = error.sawLandingPage === true

    return {
      landingPage,
      hint: landingPage && onlyOnOneNetwork(options.address) ? 'private_network' : 'none',
      actions: []
    }
  }

  if (error.kind === 'network' && network === 'cellular' && onlyOnOneNetwork(options.address)) {
    return { ...empty, hint: 'private_network' }
  }

  return empty
}
