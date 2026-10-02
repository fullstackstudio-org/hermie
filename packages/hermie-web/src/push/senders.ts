/**
 * The transports, behind one door.
 *
 * ADR-0017: "Two transports, two failure modes, one code path. Expo handles
 * APNs and FCM and gives receipts; Web Push is VAPID and gives an HTTP status.
 * Both reduce to 'send, then decide whether this registration is still real',
 * which is the only part the watcher knows about."
 *
 * The asymmetry that does not fold away is WHEN the answer arrives. A Web Push
 * status is the answer; an Expo ticket is only "accepted", and whether Apple or
 * Google actually took it lives in a receipt that is not ready yet. So a send
 * parks its tickets in the state file and `pollExpoReceipts` reads them back
 * later — a sender that only read tickets would push to uninstalled apps for
 * ever, which is how a push integration ends up rate limited.
 *
 * The relay (`relay.ts`) is the third transport, for the native Apple apps. Its
 * answer is synchronous like Web Push's: the relay has already asked APNs, and
 * `gone` is final.
 */
import { type ExpoSendResult, readExpoReceipts, sendExpo, type PushMessage } from './expo'
import type { PushRegistration } from './registrations'
import { createRelayBackoff, RELAY_DEFAULT_ORIGIN, sendRelay } from './relay'
import type { PendingTicket, PushState } from './state'
import type { PushSender } from './watcher'
import { sendWebPush, type VapidOptions } from './web-push'

/** How often the receipts of accepted tickets are read back. */
export const RECEIPT_POLL_INTERVAL_MS = 15 * 60 * 1000

/** Expo keeps a receipt for about a day; a ticket older than this will never resolve. */
export const TICKET_TTL_SECONDS = 26 * 60 * 60

/**
 * A ceiling on the parked tickets.
 *
 * Without it, a gateway that can reach Expo but never the receipts endpoint
 * grows this list until the state file is the daemon's whole memory. The oldest
 * go first, which is also the order in which they stop being answerable.
 */
export const MAX_PENDING_TICKETS = 2000

export interface SenderOptions {
  state: PushState
  vapid: VapidOptions
  /**
   * The relay origins a `relay` registration may be sent through. Absent means
   * the project's own relay only; empty means relay rows are never sent.
   */
  relays?: readonly string[]
  fetchImpl?: typeof fetch
  now?: () => number
  log?: (line: string) => void
  /** The pause before a relay retry. Injected by the tests. */
  sleep?: (ms: number) => Promise<void>
}

/** One sender over every transport. A registration carries exactly one address. */
export function createSender(options: SenderOptions): PushSender {
  const now = (): number => options.now?.() ?? Math.floor(Date.now() / 1000)
  // Kept for the life of the sender: a relay that is backing off, or a device
  // it rate-limited, is skipped by every send until the time has passed.
  const relayBackoff = createRelayBackoff()

  return {
    async send(registrations: readonly PushRegistration[], message: PushMessage) {
      const dead: string[] = []
      const expoTargets = registrations.filter(registration => registration.transport === 'expo')
      const webTargets = registrations.filter(registration => registration.transport === 'webpush')
      const relayTargets = registrations.filter(registration => registration.transport === 'relay')

      if (expoTargets.length) {
        const result: ExpoSendResult = await sendExpo(expoTargets, message, {
          ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {})
        })
        dead.push(...result.dead)
        parkTickets(options.state, result.tickets, now())
      }

      if (webTargets.length) {
        const result = await sendWebPush(webTargets, message, {
          vapid: options.vapid,
          ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {})
        })
        dead.push(...result.dead)
      }

      if (relayTargets.length) {
        // `gone` answers come back as dead installations, and the watcher
        // retires them exactly as it retires a `DeviceNotRegistered` token.
        const result = await sendRelay(relayTargets, message, {
          allowList: options.relays ?? [RELAY_DEFAULT_ORIGIN],
          backoff: relayBackoff,
          ...(options.now ? { now: () => now() * 1000 } : {}),
          ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
          ...(options.log ? { log: options.log } : {}),
          ...(options.sleep ? { sleep: options.sleep } : {})
        })
        dead.push(...result.dead)
      }

      return { dead }
    }
  }
}

/** Keep the accepted tickets, bounded and stamped. */
export function parkTickets(
  state: PushState,
  tickets: readonly { id?: string; installationId: string; token: string }[],
  at: number
): void {
  for (const ticket of tickets) {
    if (ticket.id) {
      state.tickets.push({ id: ticket.id, installationId: ticket.installationId, token: ticket.token, at })
    }
  }

  if (state.tickets.length > MAX_PENDING_TICKETS) {
    state.tickets.splice(0, state.tickets.length - MAX_PENDING_TICKETS)
  }
}

export interface ReceiptSweepResult {
  /** Installations whose token is finished. */
  dead: string[]
  /** Tickets that were dropped because they can no longer be answered. */
  expired: number
}

/**
 * Read the receipts for everything parked, and decide what is still worth
 * asking about.
 *
 * A receipt that is not there yet is not an answer: absent means "ask again
 * later", never "delivered" and never "dead". What ends a ticket's life here is
 * either a receipt with a dead-token error, or age — a ticket older than Expo's
 * own retention will never be answered and polling it for ever is the failure
 * this sweep exists to prevent.
 */
export async function pollExpoReceipts(state: PushState, options: SenderOptions): Promise<ReceiptSweepResult> {
  const at = options.now?.() ?? Math.floor(Date.now() / 1000)
  const before = state.tickets.length
  const answerable = state.tickets.filter(ticket => at - ticket.at <= TICKET_TTL_SECONDS)
  const expired = before - answerable.length

  if (!answerable.length) {
    state.tickets = answerable

    return { dead: [], expired }
  }

  const { dead, pending } = await readExpoReceipts(answerable, {
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {})
  })
  const stamps = new Map(answerable.map(ticket => [ticket.id ?? '', ticket.at]))

  state.tickets = pending
    .filter((ticket): ticket is typeof ticket & { id: string } => Boolean(ticket.id))
    .map((ticket): PendingTicket => ({
      id: ticket.id,
      installationId: ticket.installationId,
      token: ticket.token,
      at: stamps.get(ticket.id) ?? at
    }))

  for (const installationId of dead) {
    state.invalid[installationId] = at
  }

  if (dead.length || expired) {
    options.log?.(
      `push: ${String(dead.length)} token(s) retired by receipt, ${String(expired)} ticket(s) too old to answer`
    )
  }

  return { dead, expired }
}
