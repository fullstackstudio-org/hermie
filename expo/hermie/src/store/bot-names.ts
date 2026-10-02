/**
 * What a bot is CALLED, resolved into the two lines every surface draws.
 *
 * A Hermes profile carries two names and the app used to show one of them. The
 * handle (`profiles.list`'s `name` — `lance-vance`) is the bot's identity: it
 * is what `@`-addressing uses, what a cron names, what a DM line says, what the
 * gateway's own logs say, and the only one of the two that is unique. The
 * display name (`display_name` — "Netwerkbeheerder") is a label somebody typed,
 * and it is optional, mutable and free to collide.
 *
 * The app showed the display name everywhere and the handle almost nowhere, so
 * a reader looking at a chat list could not tell which bot an `@mention`
 * elsewhere in the app referred to. Both names are now drawn, as a primary line
 * and a secondary one under it, and **which of them is primary is one global
 * setting** rather than a decision each surface makes for itself.
 *
 * ## Whose display name it is
 *
 * There is a third name and it is the one a reader can actually change. No call
 * a client has writes a profile's `display_name`: `profiles.configure` has no
 * such field, `profiles.create` has none, and `PATCH /api/profiles/{name}`
 * RENAMES the profile on everything but `default`. So the app keeps the reader's
 * own name for a bot beside their folders and colours (`chat-layout`'s `labels`)
 * and prefers it here. The roster's `display_name` is the fallback under it, and
 * the handle is the fallback under that.
 *
 * ## Why a module and not a hook
 *
 * `botNames` is pure, which is what lets the same rule answer for a React row,
 * for the widget snapshot's projection, and for a test — three callers that do
 * not share a render tree. `useBotNames` is the thin hook over it for the ones
 * that do.
 *
 * ## The one-line case is not a special case
 *
 * A profile with no display name, or one whose display name IS its handle in
 * different case, has one name and not two. Drawing "lance-vance" over
 * "Lance-Vance" would be a second line that adds nothing and invites the reader
 * to look for a difference that is not there, so `secondary` is empty and every
 * surface already has to handle that: a bot that has never been given a display
 * name is the common case on a fresh gateway.
 */
import { useBotsStore } from './bots'
import { useBotLabel } from './chat-layout'
import { useSettingsStore } from './settings'

/**
 * Which of the two names is the large one.
 *
 * `display` is the default, and that is the owner's call — the second one they
 * have made about it. The handle led at first because it is the name the rest of
 * the app addresses a bot by, and using the app said the opposite: somebody who
 * has given their bots names thinks of them by those names, and a list of
 * handles reads like a directory of processes rather than a list of people to
 * talk to. Nothing is hidden by the swap — the handle is still on the row, one
 * line down, which is where a reader looks when they have to match a chat
 * against an `@mention`, a cron or a line in a log.
 *
 * `profile` puts it back, for a reader who wants the identity first.
 */
export type NameOrder = 'profile' | 'display'

export const NAME_ORDERS: readonly NameOrder[] = ['profile', 'display']

export const DEFAULT_NAME_ORDER: NameOrder = 'display'

/** Read a stored order defensively: it arrives from disk AND from a gateway. */
export const asNameOrder = (value: unknown): NameOrder | undefined =>
  typeof value === 'string' && (NAME_ORDERS as readonly string[]).includes(value) ? (value as NameOrder) : undefined

/** The two lines, already in the order this reader asked for. */
export interface BotNames {
  primary: string
  /** Empty when the bot has only one name worth showing. */
  secondary: string
}

/**
 * The third thing that decides which name wins (HERM-110).
 *
 * `hideHandle` is Settings → Chats & messages' "Hide profile name". On, a bot
 * that HAS a display name shows it alone — `order` stops mattering, because
 * the point of the setting is to stop showing the handle next to it at all,
 * and an order that still surfaced it one way round would be the setting lying
 * about what it does. A bot with no display name is untouched: it has one
 * name, and this setting is about which of two names shows, not about
 * inventing a second one.
 */
export interface BotNamesOptions {
  hideHandle?: boolean
}

/**
 * Just enough of a bot to name it.
 *
 * Deliberately structural rather than `Bot`: the widget snapshot's projection
 * and a test fixture both have these two fields and neither is a roster row.
 */
export interface NameableBot {
  name: string
  displayName: string
  /**
   * The name THIS READER gave the bot, when they have given it one.
   *
   * It wins over `displayName`, and that is the whole of the rule. A gateway
   * offers a client no way to write a profile's `display_name` — the one route
   * that touches it renames the profile instead, which is what made renaming a
   * bot in this app move its handle — so the editable name is the app's own and
   * the roster's is the fallback under it. See `chat-layout`'s `labels`.
   *
   * Optional because most callers have no opinion: a fixture, a widget
   * projection and a test all pass two names and mean the roster's.
   */
  label?: string
}

/**
 * The two lines for one bot.
 *
 * `bots.ts` already falls back — `displayName: str(row.display_name) || name` —
 * so an absent display name arrives here as a copy of the handle rather than as
 * an empty string. Both shapes are treated the same, because a store is not the
 * only thing that builds one of these.
 *
 * The comparison is case-insensitive and trimmed. `researcher` and `Researcher`
 * are the same name differently capitalised, and that pair is the single most
 * common thing on a real gateway — see the note `useBotDisplayName` has carried
 * since the roster was written.
 */
export function botNames(bot: NameableBot, order: NameOrder, options?: BotNamesOptions): BotNames {
  const handle = bot.name
  // The reader's own name first, the roster's second. An empty one is not a
  // name, which is what makes clearing the field fall back rather than blank the
  // row.
  const display = (bot.label ?? '').trim() || bot.displayName.trim()
  const same = display === '' || display.toLowerCase() === handle.trim().toLowerCase()

  if (same) {
    return { primary: handle, secondary: '' }
  }

  // The owner's call (2026-09-22): with the setting on, a bot that has a real
  // display name is ALWAYS led with it — `order` only decides which name is
  // primary when this is off.
  if (options?.hideHandle) {
    return { primary: display, secondary: '' }
  }

  return order === 'display' ? { primary: display, secondary: handle } : { primary: handle, secondary: display }
}

/** The order this reader chose, for a surface that resolves its own names. */
export function useNameOrder(): NameOrder {
  return useSettingsStore(state => state.botNameOrder)
}

/** Whether a named bot's handle is hidden everywhere (Settings → Chats & messages). */
export function useHideHandleWhenNamed(): boolean {
  return useSettingsStore(state => state.hideHandleWhenNamed)
}

/**
 * The two lines for one bot, by handle.
 *
 * Selecting the resolved strings rather than the whole roster map keeps a
 * caller from re-rendering when an unrelated bot's presence moves — the same
 * reason `useBotDisplayName` selects a string.
 */
export function useBotNames(name: string | undefined): BotNames {
  const order = useNameOrder()
  const hideHandle = useHideHandleWhenNamed()
  const displayName = useBotsStore(state => (name === undefined ? '' : (state.byName[name]?.displayName ?? name)))
  const label = useBotLabel(name)

  return botNames({ name: name ?? '', displayName, label }, order, { hideHandle })
}

/**
 * One line, for somewhere that has room for exactly one.
 *
 * A browser tab title, a menu-bar item, a live region announcing a drag. The
 * secondary name is dropped rather than appended: these are places where the
 * text is already competing with something else for a few characters.
 */
export function botLabel(bot: NameableBot, order: NameOrder, options?: BotNamesOptions): string {
  return botNames(bot, order, options).primary
}
