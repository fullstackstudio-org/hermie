/**
 * Sending through the Expo Push API, and learning which tokens are dead.
 *
 * Two round trips, not one, and the second is the one that matters. `send`
 * answers with a ticket per message, and a ticket only says the request was
 * accepted; whether Apple or Google actually took it is in a RECEIPT, fetched
 * afterwards by ticket id. A sender that only reads tickets keeps pushing to
 * uninstalled apps for ever, which is how a push integration ends up rate
 * limited.
 *
 * No credential. The Expo Push API is public and the token IS the address —
 * which is exactly why ADR-0017's payload carries a bot name and a type and not
 * what was said.
 */
import type { PushRegistration } from './registrations'

export const EXPO_SEND_URL = 'https://exp.host/--/api/v2/push/send'
export const EXPO_RECEIPTS_URL = 'https://exp.host/--/api/v2/push/getReceipts'

/** Expo's own cap on one request, for both sends and receipt lookups. */
export const EXPO_BATCH_SIZE = 100

/** The error codes that mean this token will never work again. */
const DEAD_TOKEN_ERRORS = new Set(['DeviceNotRegistered', 'InvalidCredentials'])

export interface PushMessage {
  title: string
  body: string
  /**
   * What a tap should open; the app resolves it against the gateway first.
   *
   * Booleans as well as strings, because `cronCertain: false` has to be read
   * back as false rather than as the non-empty string `"false"` — and both
   * transports carry this bag as JSON, so there is nothing to encode around.
   */
  data: Record<string, string | boolean>
  /** Notification category, for the Allow / Deny actions on a request. */
  categoryId?: string
  /**
   * The Android notification channel: the event's type, one channel per type
   * (`contract/push/contract.json`). Expo only; the other transports have no
   * channels.
   */
  channelId?: string
  /**
   * The body this notification has WITHOUT a preview: the event-type phrase.
   *
   * Equal to `body` unless a preview was put in it. It travels beside the body
   * so that a transport which must never carry message text — the relay, see
   * `relay.ts` — can say the safe line without having to trust that the caller
   * partitioned the devices correctly.
   */
  summary?: string
  /**
   * The event this notification is about, as the watcher dedupes it.
   *
   * Not part of the payload a device reads. The relay uses it as the APNs
   * collapse id, so a message the relay already delivered and is then sent
   * again on a retry replaces itself instead of buzzing twice.
   */
  eventId?: string
}

export interface ExpoTicket {
  installationId: string
  token: string
  /** Set when the ticket was accepted; the id a receipt is later read under. */
  id?: string
  /** Set when Expo refused the message outright. */
  error?: string
}

export interface ExpoSendResult {
  tickets: ExpoTicket[]
  /** Installation ids whose token is finished and should be removed. */
  dead: string[]
}

type FetchLike = typeof fetch

const chunk = <T>(items: readonly T[], size: number): T[][] => {
  const out: T[][] = []

  for (let at = 0; at < items.length; at += size) {
    out.push(items.slice(at, at + size))
  }

  return out
}

/**
 * One notification to a set of Expo registrations.
 *
 * A failed batch is not a failed send: the request may have died for the
 * network's reasons, which says nothing about any token in it. So a batch that
 * throws produces tickets carrying that error and NO dead tokens — only Expo
 * saying `DeviceNotRegistered` removes a registration.
 */
export async function sendExpo(
  registrations: readonly PushRegistration[],
  message: PushMessage,
  options: { fetchImpl?: FetchLike } = {}
): Promise<ExpoSendResult> {
  const targets = registrations.filter(
    (registration): registration is PushRegistration & { token: string } =>
      registration.transport === 'expo' && Boolean(registration.token)
  )

  if (!targets.length) {
    return { dead: [], tickets: [] }
  }

  const send = options.fetchImpl ?? fetch
  const tickets: ExpoTicket[] = []
  const dead: string[] = []

  for (const batch of chunk(targets, EXPO_BATCH_SIZE)) {
    const body = batch.map(registration => ({
      to: registration.token,
      title: message.title,
      body: message.body,
      data: message.data,
      ...(message.categoryId ? { categoryId: message.categoryId } : {}),
      /*
        One channel per type, named after the type, as the push contract says
        and as the gateway plugin has always sent. The Expo app 0.1.9 created
        only `default` and `needs-input`; on that build expo-notifications
        posts a notification whose channel does not exist on the fallback
        channel instead of dropping it, so it still arrives there. An updated
        app creates the seven type channels.
      */
      ...(message.channelId ? { channelId: message.channelId } : {}),
      // A notification about the same chat replaces the previous one rather
      // than stacking four identical rows on a lock screen.
      ...(message.data.bot ? { collapseId: message.data.bot } : {})
    }))

    let rows: Record<string, unknown>[]

    try {
      const response = await send(EXPO_SEND_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(body)
      })

      const parsed = (await response.json()) as { data?: unknown }

      rows = Array.isArray(parsed?.data) ? (parsed.data as Record<string, unknown>[]) : []
    } catch (error) {
      for (const registration of batch) {
        tickets.push({
          installationId: registration.installationId,
          token: registration.token,
          error: error instanceof Error ? error.message : String(error)
        })
      }

      continue
    }

    batch.forEach((registration, index) => {
      const row = rows[index]
      const status = typeof row?.status === 'string' ? row.status : ''
      const id = typeof row?.id === 'string' ? row.id : ''
      const code = errorCodeOf(row)

      if (status === 'ok' && id) {
        tickets.push({ id, installationId: registration.installationId, token: registration.token })

        return
      }

      tickets.push({
        installationId: registration.installationId,
        token: registration.token,
        error: code || status || 'no ticket'
      })

      if (DEAD_TOKEN_ERRORS.has(code)) {
        dead.push(registration.installationId)
      }
    })
  }

  return { dead, tickets }
}

/**
 * Read the receipts for tickets that were accepted.
 *
 * A receipt that is not there yet is not an answer: Expo keeps them for about a
 * day and returns nothing for an id it has not resolved. Absent means "ask
 * again later", never "delivered", and never "dead".
 */
export async function readExpoReceipts(
  tickets: readonly ExpoTicket[],
  options: { fetchImpl?: FetchLike } = {}
): Promise<{ dead: string[]; pending: ExpoTicket[] }> {
  const accepted = tickets.filter((ticket): ticket is ExpoTicket & { id: string } => Boolean(ticket.id))

  if (!accepted.length) {
    return { dead: [], pending: [] }
  }

  const send = options.fetchImpl ?? fetch
  const dead: string[] = []
  const pending: ExpoTicket[] = []

  for (const batch of chunk(accepted, EXPO_BATCH_SIZE)) {
    let rows: Record<string, unknown>

    try {
      const response = await send(EXPO_RECEIPTS_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ ids: batch.map(ticket => ticket.id) })
      })

      const parsed = (await response.json()) as { data?: unknown }

      rows = (parsed?.data ?? {}) as Record<string, unknown>
    } catch {
      // The lookup failed, so nothing was learned about any ticket in it.
      pending.push(...batch)

      continue
    }

    for (const ticket of batch) {
      const row = rows[ticket.id] as Record<string, unknown> | undefined

      if (!row) {
        pending.push(ticket)

        continue
      }

      const code = errorCodeOf(row)

      if (DEAD_TOKEN_ERRORS.has(code)) {
        dead.push(ticket.installationId)
      }
    }
  }

  return { dead, pending }
}

/** Expo puts the machine-readable code in `details.error`, not in `message`. */
function errorCodeOf(row: Record<string, unknown> | undefined): string {
  const details = (row?.details ?? {}) as Record<string, unknown>

  return typeof details.error === 'string' ? details.error : ''
}
